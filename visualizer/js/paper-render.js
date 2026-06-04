/*
 * paper-render.js — the "Warm Paper Instrument" view (ported from the Claude
 * Design handoff) painted over a REAL-session Store. Pure view: reads the store
 * + a ui object, writes HTML, tags interactive bits with data-act for app.js.
 */
(function (App) {
	"use strict";
	const U = App.util;
	const fmt = (n) => Math.round(n || 0).toLocaleString("en-US");
	const esc = (s) =>
		String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
	const clip = U.clip;

	const HANDS = {
		you: { label: "You", color: "#B97A2E" },
		agent: { label: "Agent", color: "#5C76A8" },
		conductor: { label: "Conductor", color: "#5E8B6A" },
	};

	// ---- icons (from the design's icon set) --------------------------------
	const ICONS = {
		fold: '<polyline points="6 9 12 15 18 9"/>',
		unfold: '<polyline points="18 15 12 9 6 15"/>',
		pin: '<line x1="12" y1="17" x2="12" y2="22"/><path d="M9 3.5h6l-1 7 2.4 2.5H7.6L10 10.5z"/>',
		pinOff: '<line x1="3" y1="3" x2="21" y2="21"/><line x1="12" y1="17" x2="12" y2="22"/><path d="M9 3.5h6l-1 7 2.4 2.5H7.6"/>',
		peek: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="2.6"/>',
		search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.7" y2="16.7"/>',
		read: '<path d="M4 4h11l5 5v11H4z"/><polyline points="14 4 14 9 19 9"/><line x1="8" y1="13" x2="15" y2="13"/><line x1="8" y1="16.5" x2="13" y2="16.5"/>',
		write: '<path d="M4 20h16"/><path d="M14.5 5.5l4 4L8 20l-4 1 1-4z"/>',
		think: '<path d="M12 3a6 6 0 0 1 4 10.5V17H8v-3.5A6 6 0 0 1 12 3z"/><line x1="9.5" y1="20" x2="14.5" y2="20"/>',
		prompt: '<path d="M5 5h14v10H9l-4 4z"/>',
		conductor: '<path d="M3 18l7-6 4 3 7-8"/><circle cx="10" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="14" cy="15" r="1.4" fill="currentColor" stroke="none"/>',
		play: '<polygon points="7 4 20 12 7 20 7 4"/>',
		pause: '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>',
		close: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
		layers: '<polygon points="12 3 21 8 12 13 3 8 12 3"/><polyline points="3 13 12 18 21 13"/>',
	};
	function icon(name, size, sw) {
		size = size || 16;
		return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw || 2}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
	}
	const KIND = {
		prompt: { icon: "prompt", label: "Request" },
		thinking: { icon: "think", label: "Thinking" },
		search: { icon: "search", label: "Web search" },
		read: { icon: "read", label: "Read" },
		write: { icon: "write", label: "Writing" },
		tool: { icon: "read", label: "Tool" },
		reply: { icon: "write", label: "Reply" },
	};

	// ---- per-section inference ---------------------------------------------
	function hasAgentWork(s) { return s.messages.some((m) => m.role !== "user"); }
	function ownerOf(s, isFirst) { return isFirst ? "you" : (hasAgentWork(s) ? "agent" : "you"); }
	function classify(s, isFirst) {
		if (isFirst || !hasAgentWork(s)) return "prompt";
		const tools = []; let think = false, text = false;
		for (const m of s.messages) for (const b of m.blocks) {
			if (b.type === "tool_call") tools.push((b.name || "").toLowerCase());
			else if (b.type === "thinking") think = true;
			else if (b.type === "text" && m.role === "assistant" && (b.text || "").trim()) text = true;
		}
		const any = (re) => tools.some((t) => re.test(t));
		if (any(/search|web|google|browse|duckduck/)) return "search";
		if (any(/write|edit|create|apply|str_replace|patch|insert|mkdir/)) return "write";
		if (any(/read|cat|open|view|grep|glob|\bls\b|find|fetch|load|get/)) return "read";
		if (tools.length) return "tool";
		if (think && !text) return "thinking";
		return "reply";
	}
	function argStr(args) {
		if (args == null) return "";
		if (typeof args === "string") return args;
		const keys = ["query", "q", "path", "file", "file_path", "url", "pattern", "command", "cmd", "prompt", "name", "search", "expression"];
		for (const k of keys) if (args[k] != null && typeof args[k] !== "object") return String(args[k]);
		try { return JSON.stringify(args); } catch (e) { return ""; }
	}
	function reasonFor(s, by, full, isFirst) {
		if (s.pinned) return "Pinned open — kept in view all session.";
		if (!full) {
			if (by === "conductor") return "Conductor folded this — went cold while the agent moved on.";
			if (by === "you") return "You folded this to a summary.";
			return "Folded to a summary.";
		}
		if (by === "you") return "You unfolded this.";
		if (isFirst) return "The original request.";
		return "The agent's working context.";
	}

	// ---- body mapping: real blocks → design body blocks --------------------
	function mapBody(s, max) {
		const cand = [];
		for (const m of s.messages) for (const b of m.blocks) {
			if (b.type === "text") { const t = (b.text || "").trim(); if (t) cand.push({ type: "text", text: clip(t, 650) }); }
			else if (b.type === "thinking") { const t = (b.text || "").trim(); if (t) cand.push({ type: "think", text: clip(t, 420) }); }
			else if (b.type === "tool_call") cand.push({ type: "tool", tool: b.name || "tool", arg: clip(argStr(b.args), 90) });
			else if (b.type === "tool_result") {
				const lines = (b.text || "").split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 4).map((x) => clip(x, 150));
				if (lines.length) cand.push({ type: "results", items: lines, err: !!b.isError });
			}
		}
		if (cand.length > max) { const head = cand.slice(0, max); head.push({ type: "more", n: cand.length - max }); return head; }
		return cand;
	}
	function renderBody(blocks) {
		return '<div class="body">' + blocks.map((b) => {
			if (b.type === "text") return `<p class="b-text">${esc(b.text)}</p>`;
			if (b.type === "think") return `<p class="b-text b-think">${esc(b.text)}</p>`;
			if (b.type === "tool") return `<div class="b-tool"><span class="b-tool-name">${esc(b.tool)}</span><span class="b-tool-paren">(</span><span class="b-tool-arg">“${esc(b.arg)}”</span><span class="b-tool-paren">)</span></div>`;
			if (b.type === "results") return `<ul class="b-results${b.err ? " err" : ""}">${b.items.map((it) => `<li>${esc(it)}</li>`).join("")}</ul>`;
			if (b.type === "more") return `<div class="b-more">+${b.n} more blocks — peek to read it all</div>`;
			return "";
		}).join("") + "</div>";
	}

	function handTag(by, verb) {
		const h = HANDS[by] || HANDS.agent;
		return `<span class="hand-tag" style="color:${h.color}"><span class="hand-dot" style="background:${h.color}"></span>${h.label}${verb ? ` <span class="hand-verb">${verb}</span>` : ""}</span>`;
	}

	// ---- turn card ----------------------------------------------------------
	function turnCard(store, s, ui, lastIdx) {
		const isFirst = s.index === 1;
		const dispBy = s.by || ownerOf(s, isFirst);
		const h = HANDS[dispBy] || HANDS.agent;
		const full = s.pinned || s.state !== "folded";
		const km = KIND[classify(s, isFirst)] || KIND.read;
		const peeking = ui.peekId === s.id;
		const active = !ui.replaying && s.index === lastIdx;
		const stateLabel = s.pinned ? "Pinned" : full ? "Full" : "Folded";
		const tok = full ? s.tokens : U.digestTokens(s);
		const cls = ["acc-card", full ? "is-full" : "is-folded", s.pinned ? "is-pinned" : "", active ? "is-active" : "", peeking ? "is-peeking" : ""].filter(Boolean).join(" ");

		const actions = ui.replaying ? "" : (full
			? `<button class="act-btn" title="Fold to summary" data-act="fold" data-id="${s.id}">${icon("fold", 15)}</button>`
				+ `<button class="act-btn" title="${s.pinned ? "Unpin" : "Pin open"}" data-act="${s.pinned ? "unpin" : "pin"}" data-id="${s.id}"${s.pinned ? ' style="color:var(--terra)"' : ""}>${icon(s.pinned ? "pinOff" : "pin", 15)}</button>`
			: `<button class="act-btn" title="Unfold to full" data-act="unfold" data-id="${s.id}">${icon("unfold", 15)}</button>`
				+ `<button class="act-btn" title="Peek (read without unfolding)" data-act="peek" data-id="${s.id}"${peeking ? ` style="color:${h.color}"` : ""}>${icon("peek", 15)}</button>`);

		const fullBody = `<h3 class="card-title">${esc(s.title)}</h3>${renderBody(mapBody(s, 10))}`
			+ `<div class="card-foot">${handTag(dispBy)}<span class="foot-reason">${esc(reasonFor(s, dispBy, full, isFirst))}</span></div>`;
		const foldBody = `<div class="fold-summary"><span class="fold-corner"></span><p class="fold-text">${esc(U.sectionDigest(s) || s.title)}</p></div>`
			+ `<div class="fold-foot">${handTag(dispBy, "folded")}<span class="fold-saved">${fmt(s.tokens)} → ${fmt(U.digestTokens(s))} tok</span></div>`;

		return `<div class="${cls}" style="--accent:${h.color}">
  <span class="card-spine"></span>
  <div class="card-top">
    <span class="state-pill ${stateLabel.toLowerCase()}">${s.pinned ? icon("pin", 11) : ""}${stateLabel}</span>
    <span class="kind-chip">${icon(km.icon, 13)} ${km.label}</span>
    <span class="turn-badge">turn ${String(s.index).padStart(2, "0")}</span>
    ${active ? '<span class="live-dot" title="active turn"></span>' : ""}
    <span class="card-top-right"><span class="tok">${fmt(tok)}</span><span class="actions">${actions}</span></span>
  </div>
  <div class="morph ${full ? "open" : "closed"}"><div>${fullBody}</div></div>
  <div class="morph ${!full ? "open" : "closed"}"><div>${foldBody}</div></div>
</div>`;
	}

	// ---- group --------------------------------------------------------------
	function groupCard(store, g, ui, lastIdx) {
		const members = g.sectionIds.map((id) => store.get(id)).filter(Boolean);
		if (!members.length) return "";
		const h = HANDS[g.by] || HANDS.conductor;
		const n = members.length;
		const a = members[0].index, b = members[members.length - 1].index;
		const tok = store.groupDigestTokens(g);
		const peeking = ui.peekId === g.id;
		const summary = `${n} cold turns (${a}–${b}) — ${clip(U.sectionDigest(members[0]) || members[0].title, 80)}`;

		if (g.collapsed) {
			return `<div class="group-strip${peeking ? " is-peeking" : ""}" style="--accent:${h.color}">
  <span class="stack-sheet s2"></span><span class="stack-sheet s1"></span>
  <div class="group-strip-inner">
    <div class="group-strip-top">
      <span class="group-pill">${icon("layers", 12)} ${n} turns</span>
      <span class="group-label">grouped fold</span>
      <span class="card-top-right"><span class="tok">${fmt(tok)}</span>${ui.replaying ? "" : `<span class="actions always"><button class="act-btn" title="Unfold group" data-act="gexpand" data-gid="${g.id}">${icon("unfold", 15)}</button><button class="act-btn" title="Peek inside" data-act="gpeek" data-gid="${g.id}"${peeking ? ` style="color:${h.color}"` : ""}>${icon("peek", 15)}</button></span>`}</span>
    </div>
    <p class="group-summary">${esc(summary)}</p>
    <div class="fold-foot">${handTag(g.by || "conductor", "grouped")}</div>
  </div>
</div>`;
		}
		return `<div class="group-well" style="--accent:${h.color}">
  <div class="group-well-head">
    <span class="group-pill open">${icon("layers", 12)} ${n} turns</span>
    <span class="group-well-title">Turns ${a}–${b}</span>
    ${ui.replaying ? "" : `<span class="actions always"><button class="act-btn" title="Fold group back up" data-act="gcollapse" data-gid="${g.id}">${icon("fold", 15)}</button></span>`}
  </div>
  <div class="group-well-body"><div class="node-list">${members.map((m) => turnCard(store, m, ui, lastIdx)).join("")}</div></div>
</div>`;
	}

	function nodeList(store, ui, lastIdx) {
		const out = [];
		const done = new Set();
		for (const s of store.visible()) {
			const grp = store.groupOf(s);
			if (grp) { if (!done.has(grp.id)) { out.push(groupCard(store, grp, ui, lastIdx)); done.add(grp.id); } continue; }
			out.push(turnCard(store, s, ui, lastIdx));
		}
		return out.join("");
	}

	// ---- budget -------------------------------------------------------------
	function budget(store) {
		const used = store.liveTokens();
		const fullTok = store.fullTokens();
		const foldedTok = Math.max(0, used - fullTok);
		const would = store.wouldBeTokens();
		const bud = store.windowBudget;
		const saved = Math.max(0, would - used);
		const pct = bud ? used / bud : 0;
		const w = (t) => (bud ? Math.max(0, (t / bud) * 100) : 0);
		return `<div class="budget">
  <div class="budget-row">
    <span class="budget-label">Context budget</span>
    <span class="budget-num"><span class="tok strong">${fmt(used)}</span><span class="budget-of"> / ${fmt(bud)}</span></span>
  </div>
  <div class="budget-track" title="Full ${fmt(fullTok)} · folded ${fmt(foldedTok)} · ${fmt(saved)} saved">
    <div class="seg full" style="width:${w(fullTok)}%"></div>
    <div class="seg folded" style="width:${w(foldedTok)}%"></div>
    <div class="seg ghost" style="width:${w(saved)}%"></div>
  </div>
  <div class="budget-foot">
    <span><b>${Math.round(pct * 100)}%</b> used</span>
    <span class="budget-sep">·</span>
    <span class="budget-saved">folding saved <b>${fmt(saved)}</b> tokens</span>
    <span class="budget-ghost-key">would be ${fmt(would)}</span>
  </div>
</div>`;
	}

	// ---- terminal -----------------------------------------------------------
	function termLine(s, isFirst, active) {
		const by = s.by || ownerOf(s, isFirst);
		const kind = classify(s, isFirst);
		const h = HANDS[by] || HANDS.agent;
		let tool = null, firstText = null;
		for (const m of s.messages) for (const b of m.blocks) {
			if (!tool && b.type === "tool_call") tool = { name: b.name || "tool", arg: clip(argStr(b.args), 80) };
			if (!firstText && b.type === "text" && (b.text || "").trim()) firstText = clip(b.text.trim(), 200);
		}
		return `<div class="term-turn${active ? " term-active" : ""}">
  <div class="term-head">
    <span class="term-gutter" style="color:${h.color}">${String(s.index).padStart(2, "0")}</span>
    ${kind === "prompt" ? '<span class="term-role you">❯ you</span>' : '<span class="term-role agent">agent</span>'}
    <span class="term-title">${esc(s.title)}</span>
  </div>
  ${tool ? `<div class="term-tool"><span class="term-tool-name">${esc(tool.name)}</span>(<span class="term-tool-arg">${esc(tool.arg)}</span>)</div>` : ""}
  ${firstText && kind === "prompt" ? `<div class="term-quote">${esc(firstText)}</div>` : ""}
  ${active ? '<div class="term-cursor">working<span class="blink">▍</span></div>' : ""}
</div>`;
	}
	function terminal(store, ui) {
		const vis = store.visible();
		const lastIdx = vis.length ? vis[vis.length - 1].index : 0;
		const lines = vis.map((s) => termLine(s, s.index === 1, !ui.replaying && s.index === lastIdx)).join("")
			|| '<div class="term-empty">No session loaded — drop a .jsonl, or pick one above.</div>';
		const samples = (ui.samples || []).map((s, i) => `<button class="sb${s.active ? " active" : ""}" data-act="sample" data-i="${i}">${esc(s.label)}</button>`).join("");
		return `<div class="terminal">
  <div class="term-bar">
    <span class="term-traffic"><i></i><i></i><i></i></span>
    <span class="term-bar-title">${esc(store ? store.format.toUpperCase() + " · " + store.title : "no session")}</span>
    <span class="term-bar-ctx">context: managed by 🪗</span>
  </div>
  <div class="term-load"><span class="ll">session</span>${samples}<label class="sb open">open…<input type="file" id="fileInput" accept=".jsonl,.json,.txt" hidden></label></div>
  <div class="term-scroll">${lines}</div>
</div>`;
	}

	// ---- timeline -----------------------------------------------------------
	function colorFor(by, index) { return (HANDS[by] || HANDS[index === 1 ? "you" : "agent"]).color; }
	function timeline(store, ui) {
		const bars = store.leafStates();
		const live = ui.viewIndex >= ui.history.length - 1;
		const denom = Math.max(1, ui.history.length - 1);
		const lastIdx = bars.length ? bars[bars.length - 1].index : 0;
		const barHTML = bars.map((b) => {
			const c = colorFor(b.by, b.index);
			const active = !ui.replaying && b.index === lastIdx;
			return `<div class="tl-bar ${b.folded ? "folded" : "full"}${active ? " active" : ""}" title="Turn ${b.index} · ${b.folded ? "folded" : "full"}" style="--c:${c}"><span class="tl-bar-fill"></span>${b.pinned ? '<span class="tl-pin"></span>' : ""}</div>`;
		}).join("");
		const ticks = ui.history.map((s, i) => s.event ? `<span class="tl-tick" title="${esc(s.event.label)}" style="left:${(i / denom) * 100}%;background:${(HANDS[s.event.by] || HANDS.agent).color}"></span>` : "").join("");
		const ev = ui.history[ui.viewIndex] && ui.history[ui.viewIndex].event;
		return `<div class="timeline${live ? "" : " replaying"}">
  <div class="tl-head">
    <span class="tl-title">Session timeline</span>
    ${live ? `<span class="tl-status live">● live · turn ${bars.length}</span>` : `<span class="tl-status past">⟲ replaying · move ${ui.viewIndex} of ${ui.history.length - 1}</span>`}
    ${live ? "" : '<button class="tl-live-btn" data-act="live">Jump to live →</button>'}
  </div>
  <div class="tl-bars">${barHTML}</div>
  <div class="tl-scrub" data-role="scrub">
    <div class="tl-scrub-track"></div>
    <div class="tl-scrub-fill" style="width:${(ui.viewIndex / denom) * 100}%"></div>
    ${ticks}
    <span class="tl-handle" style="left:${(ui.viewIndex / denom) * 100}%"></span>
  </div>
  <div class="tl-caption">${ev ? `<span><span class="tl-cap-dot" style="background:${(HANDS[ev.by] || HANDS.agent).color}"></span>${esc(ev.label)}</span>` : '<span class="tl-cap-muted">Session start — drag the handle to replay how the context evolved</span>'}</div>
</div>`;
	}

	// ---- window -------------------------------------------------------------
	function modelOf(store) {
		const m = store.sections.flatMap((s) => s.messages).find((x) => x.model);
		return m ? m.model : store.format;
	}
	function windowPane(store, ui) {
		const vis = store.visible();
		const lastIdx = vis.length ? vis[vis.length - 1].index : 0;
		const tally = (() => { const ls = store.leafStates(); return { total: ls.length, full: ls.filter((x) => !x.folded).length, folded: ls.filter((x) => x.folded).length }; })();
		const legend = Object.keys(HANDS).map((k) => `<span class="legend-item"><span class="hand-dot" style="background:${HANDS[k].color}"></span>${HANDS[k].label}</span>`).join("");
		const end = ui.replaying ? "" :
			`<button class="advance-btn" data-act="replaytoggle">${icon(ui.replayRunning ? "pause" : "play", 13)} ${ui.replayRunning ? "Pause replay" : "Replay the session"}${ui.replayRunning ? "" : '<span class="advance-hint">watch the Conductor make room</span>'}</button>`;

		return `<section class="window">
  <header class="win-head">
    <div class="win-brand">
      <span class="win-logo">🪗</span>
      <div><div class="win-name">Accordion</div><div class="win-sub">${esc(store.title)} · <span class="tok">${esc(modelOf(store))}</span></div></div>
    </div>
    <div class="win-head-right">
      <button class="conductor-toggle${ui.conductorOn ? " on" : ""}" data-act="conductor">${icon("conductor", 15)}<span>Conductor</span><span class="ct-state">${ui.conductorOn ? "auto" : "off"}</span></button>
    </div>
  </header>
  <div class="win-legend">${legend}<span class="legend-tally">${tally.full} full · ${tally.folded} folded · ${tally.total} turns</span></div>
  ${budget(store)}
  <div class="win-scroll${ui.replaying ? " is-replaying" : ""}">
    ${ui.replaying ? `<div class="replay-banner">${icon("peek", 14)} Replaying an earlier moment — controls paused</div>` : ""}
    <div class="node-list">${nodeList(store, ui, lastIdx)}</div>
    <div class="win-end">${end}</div>
  </div>
  ${timeline(store, ui)}
</section>`;
	}

	// ---- peek overlay -------------------------------------------------------
	function peekHTML(store, ui) {
		if (!ui.peekId) return "";
		const s = store.get(ui.peekId);
		if (s) {
			const by = s.by || ownerOf(s, s.index === 1);
			const h = HANDS[by] || HANDS.agent;
			return `<div class="peek-scrim" data-role="scrim"><div class="peek-card" data-stop style="--accent:${h.color}">
  <div class="peek-head"><span class="peek-flag">${icon("peek", 14)} Peeking — the agent's context is unchanged</span><button class="peek-close" data-act="peekclose">${icon("close", 16)}</button></div>
  <div class="peek-body"><h3 class="peek-title">${esc(s.title)}</h3>${renderBody(mapBody(s, 40))}</div>
  <div class="peek-foot">${handTag(by)} · close to leave the agent's view as it was</div>
</div></div>`;
		}
		const g = store.groups.get(ui.peekId);
		if (!g) return "";
		const members = g.sectionIds.map((id) => store.get(id)).filter(Boolean);
		const h = HANDS[g.by] || HANDS.conductor;
		const a = members[0] ? members[0].index : 0, b = members.length ? members[members.length - 1].index : 0;
		const children = members.map((m) => `<div class="peek-child"><span class="turn-badge">turn ${String(m.index).padStart(2, "0")}</span><span class="peek-child-title">${esc(m.title)}</span><p class="peek-child-sum">${esc(U.sectionDigest(m) || "")}</p></div>`).join("");
		return `<div class="peek-scrim" data-role="scrim"><div class="peek-card" data-stop style="--accent:${h.color}">
  <div class="peek-head"><span class="peek-flag">${icon("peek", 14)} Peeking — the agent's context is unchanged</span><button class="peek-close" data-act="peekclose">${icon("close", 16)}</button></div>
  <div class="peek-body"><h3 class="peek-title">${icon("layers", 16)} <span class="nowrap">${members.length} folded turns (${a}–${b})</span></h3><div class="peek-children">${children}</div></div>
  <div class="peek-foot">${handTag(g.by || "conductor", "grouped these")} · close to leave the agent's view as it was</div>
</div></div>`;
	}

	// ---- top-level paint ----------------------------------------------------
	App.paper = {
		HANDS,
		render(store, ui) {
			const root = document.getElementById("app-root");
			root.className = "app";
			root.setAttribute("data-density", ui.density || "cozy");
			root.setAttribute("data-terminal", ui.showTerminal === false ? "off" : "on");
			root.innerHTML = (ui.showTerminal === false ? "" : terminal(store, ui)) + windowPane(store, ui);
			document.getElementById("overlay").innerHTML = peekHTML(store, ui);
		},
	};
})((window.App = window.App || {}));
