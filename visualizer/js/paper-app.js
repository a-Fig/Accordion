/*
 * paper-app.js — wiring for the warm-paper visualizer. Reuses App.parse +
 * App.Store; owns the replay history, the Conductor (auto), the timeline scrub,
 * peek, and session loading. Drives App.paper.render(store, ui).
 */
(function (App) {
	"use strict";
	let store = null;
	let replayTimer = null;
	let bgTimer = null;
	let scrubbing = false;

	const ui = {
		peekId: null,
		conductorOn: true,
		viewIndex: 0,
		history: [],
		density: "cozy",
		showTerminal: true,
		samples: [],
		replayRunning: false,
		keep: 4,
		replaying: false,
	};

	const roundNice = (n) => Math.round(n / 1000) * 1000;
	const $ = (id) => document.getElementById(id);

	function render() {
		if (!store) return;
		ui.replaying = ui.viewIndex < ui.history.length - 1;
		App.paper.render(store, ui);
	}

	// commit current store state as a new history step (must be at live)
	function commit(event) {
		ui.history.push({ snap: store.snapshot(), event: event || null });
		ui.viewIndex = ui.history.length - 1;
		render();
	}
	const isLive = () => ui.viewIndex >= ui.history.length - 1;

	// fold/group to a clean fitted state, WITHOUT recording each as history
	function silentFit() { store.conductorFit(ui.keep); }

	function load(parsed) {
		stopReplay();
		store = new App.Store(parsed);
		store.windowBudget = Math.max(roundNice(store.wouldBeTokens() * 1.06), 50000);
		silentFit();
		ui.peekId = null;
		ui.replayRunning = false;
		ui.history = [{ snap: store.snapshot(), event: null }];
		ui.viewIndex = 0;
		render();
	}
	function loadRaw(raw, label) {
		try { load(App.parse(raw)); }
		catch (e) { toast("Could not parse " + (label || "file") + ": " + e.message); }
	}

	// ---- sample discovery (served only; ignored on file://) ----------------
	const CANDIDATES = [
		{ path: "samples/local/real-omp.jsonl", label: "real OMP session" },
		{ path: "samples/local/real-claude.jsonl", label: "real Claude Code session" },
		{ path: "samples/synthetic-arsenal.jsonl", label: "synthetic sample" },
	];
	async function discoverSamples() {
		let first = -1;
		for (const c of CANDIDATES) {
			try {
				const res = await fetch(c.path, { cache: "no-store" });
				if (!res.ok) continue;
				const raw = await res.text();
				if (!raw.trim()) continue;
				ui.samples.push({ label: c.label, raw, active: false });
				if (first < 0) first = ui.samples.length - 1;
			} catch (_) { /* file:// or missing */ }
		}
		if (first < 0 && App.EMBEDDED) { ui.samples.push({ label: "embedded demo", raw: App.EMBEDDED, active: false }); first = 0; }
		if (first >= 0) loadSample(first);
	}
	function loadSample(i) {
		const s = ui.samples[i];
		if (!s) return;
		ui.samples.forEach((x, j) => (x.active = j === i));
		loadRaw(s.raw, s.label);
	}

	// ---- replay (reveal turns 1..N, Conductor reacts) ----------------------
	function stopReplay() {
		if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
		ui.replayRunning = false;
	}
	function toggleReplay() {
		if (ui.replayRunning) { stopReplay(); render(); return; }
		if (!store) return;
		if (store.sections.length < 3) { toast("Session too short to replay."); return; }
		store.expandAll();              // unfold + ungroup everything
		store.revealUpTo = 1;
		ui.history = [{ snap: store.snapshot(), event: { by: "you", action: "replay", label: "Replay — watching the context build" } }];
		ui.viewIndex = 0;
		ui.replayRunning = true;
		render();
		replayTimer = setInterval(stepReplay, 480);
	}
	function stepReplay() {
		if (!store) return stopReplay();
		if (store.revealUpTo >= store.sections.length) { stopReplay(); render(); return; }
		store.revealUpTo++;
		commit({ by: "agent", action: "advance", label: `Turn ${store.revealUpTo} — the agent works` });
		if (ui.conductorOn) {
			let passes = 0;
			while (passes < 2) { const ev = store.conductorKeepPass(ui.keep); if (!ev) break; commit(ev); passes++; }
		}
	}

	// ---- background Conductor (gentle, only while live) ---------------------
	function startBgConductor() {
		bgTimer = setInterval(() => {
			if (!store || !ui.conductorOn || ui.replayRunning || !isLive()) return;
			const ev = store.conductorKeepPass(ui.keep);
			if (ev) commit(ev);
		}, 5200);
	}

	// ---- timeline scrub -----------------------------------------------------
	function scrubIndexFromX(clientX) {
		const el = document.querySelector(".tl-scrub");
		if (!el) return ui.viewIndex;
		const r = el.getBoundingClientRect();
		const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
		return Math.round(p * Math.max(1, ui.history.length - 1));
	}
	function scrubTo(i) {
		ui.viewIndex = Math.max(0, Math.min(ui.history.length - 1, i));
		store.restore(ui.history[ui.viewIndex].snap);
		render();
	}
	function jumpLive() {
		ui.viewIndex = ui.history.length - 1;
		store.restore(ui.history[ui.viewIndex].snap);
		render();
	}

	// ---- toast --------------------------------------------------------------
	let toastTimer = null;
	function toast(msg) {
		const t = $("toast");
		t.textContent = msg; t.classList.add("show");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
	}

	// ---- wiring -------------------------------------------------------------
	function wire() {
		// delegated clicks
		document.addEventListener("click", (e) => {
			// peek scrim background closes
			const scrim = e.target.closest(".peek-scrim");
			if (scrim && !e.target.closest(".peek-card")) { ui.peekId = null; render(); return; }

			const el = e.target.closest("[data-act]");
			if (!el) return;
			const act = el.dataset.act;
			const id = el.dataset.id, gid = el.dataset.gid;

			// mode toggles (any time)
			if (act === "conductor") { ui.conductorOn = !ui.conductorOn; render(); return; }
			if (act === "toggleterminal") { ui.showTerminal = !ui.showTerminal; render(); return; }
			if (act === "toggledensity") { ui.density = ui.density === "cozy" ? "compact" : "cozy"; render(); return; }
			if (act === "replaytoggle") { toggleReplay(); return; }
			if (act === "live") { jumpLive(); return; }
			if (act === "sample") { loadSample(+el.dataset.i); return; }
			if (act === "peek") { ui.peekId = id; render(); return; }
			if (act === "gpeek") { ui.peekId = gid; render(); return; }
			if (act === "peekclose") { ui.peekId = null; render(); return; }

			// mutating actions — only when live
			if (!isLive()) return;
			const s = id ? store.get(id) : null;
			if (act === "fold") { store.fold(id, "you"); commit({ by: "you", action: "fold", label: `You folded “${s ? s.title : ""}”` }); }
			else if (act === "unfold") { store.unfold(id, "you"); commit({ by: "you", action: "unfold", label: `You unfolded “${s ? s.title : ""}”` }); }
			else if (act === "pin") { store.pin(id); commit({ by: "you", action: "pin", label: `You pinned “${s ? s.title : ""}” open` }); }
			else if (act === "unpin") { store.unpin(id); commit({ by: "you", action: "unpin", label: `You unpinned “${s ? s.title : ""}”` }); }
			else if (act === "gexpand") { const n = store.countTurns ? store.countTurns(gid) : 0; store.toggleGroup(gid); commit({ by: "you", action: "expand", label: `You unfolded a ${n}-turn group` }); }
			else if (act === "gcollapse") { const n = store.countTurns ? store.countTurns(gid) : 0; store.toggleGroup(gid); commit({ by: "you", action: "collapse", label: `You folded ${n} turns into a group` }); }
		});

		// file open
		document.addEventListener("change", (e) => {
			if (e.target && e.target.id === "fileInput") {
				const f = e.target.files[0];
				if (!f) return;
				ui.samples.forEach((x) => (x.active = false));
				const r = new FileReader();
				r.onload = () => loadRaw(r.result, f.name);
				r.readAsText(f);
			}
		});

		// timeline scrub
		document.addEventListener("pointerdown", (e) => {
			if (!e.target.closest(".tl-scrub")) return;
			if (ui.replayRunning) { stopReplay(); }
			scrubbing = true;
			scrubTo(scrubIndexFromX(e.clientX));
			e.preventDefault();
		});
		window.addEventListener("pointermove", (e) => { if (scrubbing) scrubTo(scrubIndexFromX(e.clientX)); });
		window.addEventListener("pointerup", () => { scrubbing = false; });

		// drag & drop a session file
		const body = document.body;
		["dragenter", "dragover"].forEach((ev) => body.addEventListener(ev, (e) => { e.preventDefault(); body.classList.add("dragging"); }));
		body.addEventListener("dragleave", (e) => { if (!e.relatedTarget || !body.contains(e.relatedTarget)) body.classList.remove("dragging"); });
		body.addEventListener("drop", (e) => {
			e.preventDefault();
			body.classList.remove("dragging");
			const f = e.dataTransfer.files[0];
			if (!f) return;
			ui.samples.forEach((x) => (x.active = false));
			const r = new FileReader();
			r.onload = () => loadRaw(r.result, f.name);
			r.readAsText(f);
		});

		// Esc closes peek
		document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ui.peekId) { ui.peekId = null; render(); } });
	}

	document.addEventListener("DOMContentLoaded", () => {
		wire();
		startBgConductor();
		discoverSamples();
	});
})((window.App = window.App || {}));
