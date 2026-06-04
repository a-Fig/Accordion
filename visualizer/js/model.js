/*
 * model.js — the accordion state machine over a parsed session.
 *
 * A *section* is one turn: a user message plus the assistant/tool messages that
 * follow it, up to the next user message. Sections fold, unfold, pin, and group.
 * Nothing is destroyed — folding only swaps a section's full content for a digest
 * in the "live" view, exactly like the real Accordion.
 */
(function (App) {
	"use strict";

	const estTokens = (s) => Math.ceil((s ? s.length : 0) / 4);
	const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");

	function blockText(b) {
		if (b.type === "text" || b.type === "thinking" || b.type === "note") return b.text || "";
		if (b.type === "tool_call") return (b.name || "") + " " + JSON.stringify(b.args || {});
		if (b.type === "tool_result") return b.text || "";
		return "";
	}
	const messageText = (m) => m.blocks.map(blockText).join("\n");
	const messageTokens = (m) => m.blocks.reduce((n, b) => n + estTokens(blockText(b)), 0) + 4;

	// ---- build sections (group messages into turns) -------------------------
	function buildSections(parsed) {
		const sections = [];
		let cur = null;
		const flush = () => {
			if (cur) {
				cur.tokens = cur.messages.reduce((n, m) => n + messageTokens(m), 0);
				sections.push(cur);
				cur = null;
			}
		};
		const newSection = (title) => ({
			id: "s" + sections.length,
			index: 0,
			title,
			messages: [],
			tokens: 0,
			state: "full", // 'full' | 'folded'
			pinned: false,
			by: null, // who last folded/unfolded: 'you' | 'agent' | 'conductor'
			groupId: null,
		});

		for (const m of parsed.messages) {
			if (m.role === "user") {
				flush();
				cur = newSection(clip(messageText(m).replace(/\s+/g, " ").trim() || "(empty prompt)", 90));
				cur.messages.push(m);
			} else if (!cur) {
				// preamble before the first user message
				cur = newSection("Session start");
				cur.messages.push(m);
			} else {
				cur.messages.push(m);
			}
		}
		flush();
		sections.forEach((s, i) => (s.index = i + 1));
		return sections;
	}

	function sectionDigest(s) {
		const firstUser = s.messages.find((m) => m.role === "user");
		const ask = firstUser ? clip(messageText(firstUser).replace(/\s+/g, " ").trim(), 160) : s.title;
		const tools = [];
		let texts = 0, results = 0, errors = 0;
		for (const m of s.messages) {
			for (const b of m.blocks) {
				if (b.type === "tool_call") tools.push(b.name);
				else if (b.type === "tool_result") { results++; if (b.isError) errors++; }
				else if (b.type === "text" && m.role === "assistant" && b.text.trim()) texts++;
			}
		}
		const uniqTools = [...new Set(tools)];
		const parts = [];
		if (ask) parts.push("“" + ask + "”");
		const did = [];
		if (uniqTools.length) did.push(uniqTools.length + " tool" + (uniqTools.length > 1 ? "s" : "") + " (" + clip(uniqTools.join(", "), 60) + ")");
		if (results) did.push(results + " result" + (results > 1 ? "s" : "") + (errors ? `, ${errors} error${errors > 1 ? "s" : ""}` : ""));
		if (texts) did.push(texts + " reply block" + (texts > 1 ? "s" : ""));
		if (did.length) parts.push(did.join(" · "));
		return parts.join("  —  ");
	}
	const digestTokens = (s) => estTokens(sectionDigest(s)) + 6;

	// ---- the store ----------------------------------------------------------
	function Store(parsed) {
		this.format = parsed.format;
		this.title = parsed.title || "Untitled session";
		this.cwd = parsed.cwd || "";
		this.sections = buildSections(parsed);
		this.groups = new Map(); // id -> { id, sectionIds, collapsed, by }
		this.events = []; // activity feed
		this.windowBudget = 200000; // tokens the model can hold at once
		this.revealUpTo = Infinity; // for replay: only sections up to here "exist"
		this._gid = 0;
		this.onChange = null;
	}

	Store.prototype.get = function (id) { return this.sections.find((s) => s.id === id); };
	Store.prototype.groupOf = function (s) { return s.groupId ? this.groups.get(s.groupId) : null; };
	Store.prototype.visible = function () { return this.sections.filter((s) => s.index <= this.revealUpTo); };

	Store.prototype.totalTokens = function () {
		return this.visible().reduce((n, s) => n + s.tokens, 0);
	};

	// tokens currently presented to the model
	Store.prototype.liveTokens = function () {
		let live = 0;
		const counted = new Set();
		for (const s of this.visible()) {
			const g = this.groupOf(s);
			if (g && g.collapsed) {
				if (!counted.has(g.id)) { live += this.groupDigestTokens(g); counted.add(g.id); }
				continue;
			}
			live += s.state === "folded" && !s.pinned ? digestTokens(s) : s.tokens;
		}
		return live;
	};

	Store.prototype.groupDigestTokens = function (g) {
		return g.sectionIds.reduce((n, id) => n + digestTokens(this.get(id)), 0);
	};

	Store.prototype.log = function (who, action, detail) {
		this.events.unshift({ who, action, detail, n: this.events.length });
		if (this.events.length > 60) this.events.pop();
	};

	Store.prototype._emit = function () { if (this.onChange) this.onChange(); };

	// Detach a section from its group (a section that's being made full or pinned
	// can't stay inside a collapsed group). Dissolves the group if it drops < 2.
	Store.prototype._removeFromGroup = function (s) {
		const g = this.groupOf(s);
		if (!g) return;
		g.sectionIds = g.sectionIds.filter((id) => id !== s.id);
		s.groupId = null;
		if (g.sectionIds.length < 2) {
			g.sectionIds.forEach((id) => { const m = this.get(id); if (m) m.groupId = null; });
			this.groups.delete(g.id);
		}
	};

	// ---- actions ------------------------------------------------------------
	Store.prototype.fold = function (id, by) {
		const s = this.get(id);
		if (!s || s.pinned || s.state === "folded") return;
		s.state = "folded"; s.by = by || "you";
		this.log(s.by, "folded", "#" + s.index);
		this._emit();
	};
	Store.prototype.unfold = function (id, by) {
		const s = this.get(id);
		if (!s || (s.state === "full" && !s.groupId)) return;
		this._removeFromGroup(s);
		s.state = "full"; s.by = by || "you";
		this.log(s.by, "unfolded", "#" + s.index);
		this._emit();
	};
	Store.prototype.toggleFold = function (id, by) {
		const s = this.get(id);
		if (!s) return;
		s.state === "folded" ? this.unfold(id, by) : this.fold(id, by);
	};
	Store.prototype.pin = function (id) {
		const s = this.get(id);
		if (!s) return;
		this._removeFromGroup(s);
		s.pinned = true; s.state = "full"; s.by = "you";
		this.log("you", "pinned", "#" + s.index);
		this._emit();
	};
	Store.prototype.unpin = function (id) {
		const s = this.get(id);
		if (!s) return;
		s.pinned = false;
		this.log("you", "unpinned", "#" + s.index);
		this._emit();
	};

	// The Conductor: fold oldest cold sections until the live view fits the
	// budget, keeping the most recent turns and anything pinned untouched.
	Store.prototype.runConductor = function (opts) {
		opts = opts || {};
		const ceiling = this.windowBudget;
		const keepRecent = Math.max(1, opts.keepRecent != null ? opts.keepRecent : 3);
		const vis = this.visible();
		if (!vis.length) return 0;
		const lastIdx = vis[vis.length - 1].index;
		const lastId = vis[vis.length - 1].id;
		const eligible = (s) => !s.pinned && !s.groupId && s.index <= lastIdx - keepRecent && s.id !== lastId;
		let folded = 0, unfolded = 0;

		// 1) Over the window → fold the OLDEST cold sections until it fits.
		for (const s of vis) {
			if (this.liveTokens() <= ceiling) break;
			if (s.state === "folded" || !eligible(s)) continue;
			s.state = "folded"; s.by = "conductor"; folded++;
		}
		// 2) Spare room → unfold the MOST-RECENT conductor folds at the boundary,
		//    contiguously (stop at the first that won't fit) so the folded run stays
		//    a clean leading block and the whole thing settles in one pass.
		const ownFolds = vis.filter((s) => s.state === "folded" && s.by === "conductor" && !s.groupId);
		for (let i = ownFolds.length - 1; i >= 0; i--) {
			const s = ownFolds[i];
			if (this.liveTokens() + (s.tokens - digestTokens(s)) <= ceiling) { s.state = "full"; s.by = "conductor"; unfolded++; }
			else break;
		}
		if (folded) this.log("conductor", "auto-folded", folded + " cold section" + (folded > 1 ? "s" : ""));
		if (unfolded) this.log("conductor", "unfolded", unfolded + " section" + (unfolded > 1 ? "s" : "") + " (room freed)");
		this._emit();
		return folded || unfolded;
	};

	// Hierarchical folding: bundle the leading run of folded, ungrouped sections
	// into a single collapsible group ("fold the folds").
	Store.prototype.groupColdHistory = function (by) {
		const run = [];
		for (const s of this.visible()) {
			if (s.state === "folded" && !s.pinned && !s.groupId) run.push(s);
			else if (run.length) break; // only the leading contiguous run
		}
		if (run.length < 2) return null;
		const id = "g" + this._gid++;
		const g = { id, sectionIds: run.map((s) => s.id), collapsed: true, by: by || "you" };
		run.forEach((s) => (s.groupId = id));
		this.groups.set(id, g);
		this.log(g.by, "grouped", run.length + " folded sections");
		this._emit();
		return g;
	};
	Store.prototype.toggleGroup = function (gid) {
		const g = this.groups.get(gid);
		if (!g) return;
		g.collapsed = !g.collapsed;
		this.log("you", g.collapsed ? "collapsed group" : "expanded group", g.sectionIds.length + " sections");
		this._emit();
	};
	Store.prototype.ungroup = function (gid) {
		const g = this.groups.get(gid);
		if (!g) return;
		g.sectionIds.forEach((id) => { const s = this.get(id); if (s) s.groupId = null; });
		this.groups.delete(gid);
		this._emit();
	};

	Store.prototype.expandAll = function () {
		this.sections.forEach((s) => { s.state = "full"; s.groupId = null; });
		this.groups.clear();
		this.log("you", "expanded all", "");
		this._emit();
	};
	Store.prototype.foldAllCold = function () {
		const vis = this.visible();
		const lastIdx = vis.length ? vis[vis.length - 1].index : 0;
		vis.forEach((s) => { if (!s.pinned && s.index <= lastIdx - 3) s.state = "folded"; });
		this.log("you", "folded all cold", "");
		this._emit();
	};

	// ---- additive helpers for the "paper" view (timeline, segmented budget,
	//      keep-N conductor, replay). These don't change existing behavior. -----

	// tokens shown at FULL detail (the raised cards) — budget bar's bright segment
	Store.prototype.fullTokens = function () {
		let sum = 0;
		for (const s of this.visible()) {
			const g = this.groupOf(s);
			if (g && g.collapsed) continue;                 // inside a collapsed group → not full
			if (!(s.state === "folded" && !s.pinned)) sum += s.tokens;
		}
		return sum;
	};
	// what the context WOULD cost with nothing folded (every visible turn full)
	Store.prototype.wouldBeTokens = function () { return this.totalTokens(); };

	// ordered visible turns with their EFFECTIVE folded state — drives the timeline
	Store.prototype.leafStates = function () {
		const out = [];
		for (const s of this.visible()) {
			const g = this.groupOf(s);
			const folded = (g && g.collapsed) || (s.state === "folded" && !s.pinned);
			out.push({ id: s.id, index: s.index, by: s.by, pinned: !!s.pinned, folded });
		}
		return out;
	};

	// full serializable state — for replay history (no logging/side effects)
	Store.prototype.snapshot = function () {
		return {
			sections: this.sections.map((s) => ({ id: s.id, state: s.state, pinned: s.pinned, by: s.by, groupId: s.groupId })),
			groups: [...this.groups.values()].map((g) => ({ id: g.id, sectionIds: g.sectionIds.slice(), collapsed: g.collapsed, by: g.by })),
			revealUpTo: this.revealUpTo,
			gid: this._gid,
		};
	};
	Store.prototype.restore = function (snap) {
		const byId = new Map(snap.sections.map((x) => [x.id, x]));
		for (const s of this.sections) {
			const x = byId.get(s.id);
			if (x) { s.state = x.state; s.pinned = x.pinned; s.by = x.by; s.groupId = x.groupId; }
		}
		this.groups = new Map(snap.groups.map((g) => [g.id, { id: g.id, sectionIds: g.sectionIds.slice(), collapsed: g.collapsed, by: g.by }]));
		this.revealUpTo = snap.revealUpTo;
		this._gid = snap.gid;
	};

	// One Conductor move toward "keep the last N turns hot": first group a run of
	// >=3 consecutive cold folds (fold the folds), else fold the oldest full turn
	// beyond the recent window. Returns an attributed event, or null when settled.
	Store.prototype.conductorKeepPass = function (keep) {
		keep = Math.max(1, keep || 4);
		const vis = this.visible();
		if (!vis.length) return null;
		const top = vis.filter((s) => !s.groupId);          // top-level (ungrouped) turns
		const lastId = vis[vis.length - 1].id;

		// 1) group the first run of >=3 consecutive folded, ungrouped, non-pinned turns
		let run = [], found = null;
		for (const s of top) {
			if (s.state === "folded" && !s.pinned) run.push(s);
			else { if (run.length >= 3) { found = run.slice(); break; } run = []; }
		}
		if (!found && run.length >= 3) found = run.slice();
		if (found) {
			const id = "g" + this._gid++;
			this.groups.set(id, { id, sectionIds: found.map((s) => s.id), collapsed: true, by: "conductor" });
			found.forEach((s) => (s.groupId = id));
			const a = found[0].index, b = found[found.length - 1].index;
			this.log("conductor", "grouped", `turns ${a}–${b}`);
			this._emit();
			return { by: "conductor", action: "group", label: `Conductor grouped turns ${a}–${b} into one fold` };
		}

		// 2) fold the oldest full turn beyond the keep window
		const keepIds = new Set(top.slice(-keep).map((s) => s.id));
		for (const s of top) {
			const folded = s.state === "folded" && !s.pinned;
			if (folded || s.pinned || keepIds.has(s.id) || s.id === lastId) continue;
			s.state = "folded"; s.by = "conductor";
			this.log("conductor", "folded", "#" + s.index);
			this._emit();
			return { by: "conductor", action: "fold", label: `Conductor folded “${s.title}”` };
		}
		return null;
	};

	// Clean batch fit for initial load: keep the last `keep` turns hot, fold the
	// rest, and group each MAXIMAL run (>=3) of consecutive cold folds into one
	// group — yields a few large cold-history groups rather than many tiny ones.
	Store.prototype.conductorFit = function (keep) {
		keep = Math.max(1, keep || 5);
		const vis = this.visible();
		if (!vis.length) return;
		const top = vis.filter((s) => !s.groupId);
		const lastId = vis[vis.length - 1].id;
		const keepIds = new Set(top.slice(-keep).map((s) => s.id));
		for (const s of top) {                              // 1) fold all cold turns
			if (s.pinned || keepIds.has(s.id) || s.id === lastId) continue;
			if (s.state !== "folded") { s.state = "folded"; s.by = s.by || "conductor"; }
		}
		let run = [];                                        // 2) group maximal cold runs
		const flush = () => {
			if (run.length >= 3) {
				const id = "g" + this._gid++;
				this.groups.set(id, { id, sectionIds: run.map((s) => s.id), collapsed: true, by: "conductor" });
				run.forEach((s) => (s.groupId = id));
			}
			run = [];
		};
		for (const s of top) {
			if (s.groupId) { flush(); continue; }
			if (s.state === "folded" && !s.pinned) run.push(s);
			else flush();
		}
		flush();
	};

	App.Store = Store;
	App.util = { estTokens, clip, messageText, messageTokens, sectionDigest, digestTokens, blockText };
})((window.App = window.App || {}));
