// attention-folder.mjs — an attention-based, PERIODIC context conductor for Accordion.
//
// What it does: a small LM (Qwen2.5-0.5B, the `probe/` sidecar) reads the context and scores
// how much attention the current work tail pays back to each earlier block ("structural
// gravity"). When the context gets full, the conductor folds the LEAST-attended blocks.
//
// The product constraint that shapes everything: fold PERIODICALLY, not per-block. Re-folding
// every turn rewrites the inference prompt prefix and destroys the model's prompt cache
// (~10x cost). So this conductor holds a STABLE fold set inside a hysteresis band and only
// changes it at "epochs". See policy.mjs for the band logic and
// docs/adr/0010-attention-conductor.md for the full design.
//
// Topology mirrors recency-folder.js: this process HOSTS a WebSocket server, advertises
// itself under ~/.accordion/conductors/ for desktop auto-discovery, and Accordion dials in.
//
// Run:  npm install   then   npm start   (or: node attention-folder.mjs)
//       Needs a Python venv with the probe deps — see probe/requirements.txt and README.md.
import { WebSocketServer } from "ws";
import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decideFolds, foldCandidates, DEFAULT_CFG } from "./policy.mjs";
import { scoreCandidates, tailTextFromView } from "./scorer.mjs";

const ID = "attention-folder";
const LABEL = "Attention folder";
const PORT = Number(process.env.ATTN_PORT || 7701); // recency-folder uses 7700
const URL = `ws://127.0.0.1:${PORT}`;

// Hysteresis band (fractions of the context window) + the warm threshold at which we kick
// off background scoring so fresh scores are ready before the epoch.
const CFG = {
	highWater: Number(process.env.ATTN_HIGH_WATER || DEFAULT_CFG.highWater),
	lowWater: Number(process.env.ATTN_LOW_WATER || DEFAULT_CFG.lowWater),
};
const WARM_WATER = Number(process.env.ATTN_WARM_WATER || 0.8);

function log(msg) {
	process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// ── Auto-discovery: advertise a heartbeat file under ~/.accordion/conductors/ ──
// Base honors ACCORDION_HOME (falling back to homedir) — this MUST mirror the Rust
// registry_root() resolver (app/src-tauri/src/lib.rs) so the app reads heartbeats from the
// same dir the conductor writes them to. Diverge and the launched conductor never gets discovered.
const REG_DIR = join(process.env.ACCORDION_HOME || homedir(), ".accordion", "conductors");
const REG_FILE = join(REG_DIR, `${ID}.json`);
const startedAt = Date.now();

function advertise() {
	mkdirSync(REG_DIR, { recursive: true });
	const entry = {
		registryProtocol: 1,
		conductorProtocol: 3,
		id: ID,
		label: LABEL,
		url: URL,
		pid: process.pid,
		startedAt,
		heartbeatAt: Date.now(),
	};
	const tmp = `${REG_FILE}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(entry, null, 2));
	renameSync(tmp, REG_FILE);
}
advertise();
const heartbeat = setInterval(advertise, 5_000);

function shutdown() {
	clearInterval(heartbeat);
	try {
		rmSync(REG_FILE, { force: true });
	} catch {
		/* already gone */
	}
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Per-connection conductor state ──
// One Accordion session per connection. State resets on reconnect (a new session).
function freshState() {
	return {
		confirmedApplied: new Set(), // fold set the host has CONFIRMED applied (via host/commandResult)
		pendingRev: -1, // rev of an emitted-but-unconfirmed fold batch
		pendingSet: new Set(), // the fold set of that pending batch
		scores: new Map(), // id → attention relevance (higher = keep)
		attempted: new Set(), // ids sent to the probe in the latest scoring run (scored or not)
		respectLive: new Set(), // ids the AGENT pulled live (M3 self-unfold); never re-fold
		scoringInFlight: false,
		rescoreNeeded: true, // score on the first warm approach, and after every epoch
		abort: new AbortController(), // fired on disconnect → kills any in-flight probe child
		// ── display-only telemetry (conductor/status) — NEVER affects folds/commands ──
		lastFullness: 0, // most recent rendered fullness (0..1)
		lastAction: "hold", // "hold" | "epoch" from the most recent decision
		lastEpoch: null, // { added, fullnessAfter } stamped when we emit a fold
		lastStatusText: "", // dedup: the last human summary we put on the wire
	};
}

/**
 * Build the display-only status payload from current connection state. Pure: reads state,
 * touches nothing. The host renders `text` and may use `metrics`; it never acts on either.
 */
function buildStatus(state) {
	// Guard a degenerate fullness: when the host reports no contextWindow AND budget 0, the
	// policy's cap is 0 → fullness is Infinity/NaN. Coerce to a finite 0 so `metrics.fullness`
	// stays a number (the wire schema is number|string|boolean) and the text never reads
	// "NaN% full". Display-only — the fold policy is unaffected.
	const rawFull = Number.isFinite(state.lastFullness) ? state.lastFullness : 0;
	const fullnessPct = Math.round(rawFull * 100);
	const low = Math.round(CFG.lowWater * 100);
	const high = Math.round(CFG.highWater * 100);
	const folded = state.confirmedApplied.size;
	const action = state.lastAction === "epoch" ? "epoch" : "holding";
	let text = `${fullnessPct}% full · ${action} · band ${low}–${high}% · ${folded} folded`;
	if (state.lastEpoch) {
		text += ` · last epoch: folded ${state.lastEpoch.added} → ${Math.round(state.lastEpoch.fullnessAfter * 100)}%`;
	}
	if (state.scoringInFlight) text += " · scoring…";
	const metrics = {
		fullness: fullnessPct,
		action: state.lastAction ?? "hold",
		lowWater: low,
		highWater: high,
		folded,
		scoring: state.scoringInFlight,
	};
	if (state.lastEpoch) {
		metrics.lastEpochFolded = state.lastEpoch.added;
		metrics.lastEpochFullness = Math.round(state.lastEpoch.fullnessAfter * 100);
	}
	return { text, metrics };
}

/**
 * Emit a `conductor/status` IFF the human summary changed since the last send (the text
 * encodes everything meaningful — fullness, action, fold count, last epoch, scoring), so an
 * unchanged hold doesn't re-spam the wire. Strictly a `ws.send`: no fold/command/model-call
 * side effect — this is the display-only invariant.
 */
function sendStatus(ws, state) {
	if (ws.readyState !== 1 /* WebSocket.OPEN */) return; // socket gone (e.g. disconnect mid-scoring)
	const { text, metrics } = buildStatus(state);
	if (text === state.lastStatusText) return;
	state.lastStatusText = text;
	ws.send(JSON.stringify({ type: "conductor/status", text, metrics }));
}

/**
 * Background scoring trigger. Fires the probe (async) when we approach the band's top and
 * either have stale scores or new unscored candidates — so the epoch has fresh numbers to
 * fold against. Decoupled from the reply path: scoring NEVER blocks a hold/epoch.
 */
function maybeScore(ws, state, view, fullness) {
	const cands = foldCandidates(view.blocks, state.respectLive);
	// "Unscored" means not yet ATTEMPTED — not merely absent from the score map. A block the
	// probe can't score (e.g. omitted by windowing) would otherwise look perpetually unscored and
	// re-trigger the GPU on every warm tick.
	const someUnscored = cands.some((b) => !state.attempted.has(b.id));
	if (fullness < WARM_WATER || state.scoringInFlight || !(state.rescoreNeeded || someUnscored)) return;
	if (!cands.length) return;

	const tailText = tailTextFromView(view.blocks);
	if (!tailText.trim()) return; // no "current work" tail to score against → let FOLD_RANK defend the band

	state.scoringInFlight = true;
	const candidates = cands.map((b) => ({ id: b.id, text: b.text || "" }));
	const ids = candidates.map((c) => c.id);
	log(`scoring ${candidates.length} candidates (fullness ${(fullness * 100).toFixed(0)}%)…`);
	sendStatus(ws, state); // surface the "scoring…" transition

	scoreCandidates({ tailText, candidates, signal: state.abort.signal, log })
		.then((scores) => {
			for (const [id, v] of scores) state.scores.set(id, v);
			state.attempted = new Set(ids); // mark this run's candidates attempted (even if unscored)
			state.rescoreNeeded = false;
			state.scoringInFlight = false;
			log(`scores ready: ${state.scores.size} cached`);
			sendStatus(ws, state); // scoring finished → drop the "scoring…" suffix
		})
		.catch((err) => {
			state.scoringInFlight = false;
			log(`scoring failed: ${err.message}`);
			sendStatus(ws, state);
		});
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });

wss.on("connection", (ws) => {
	const state = freshState();
	log("Accordion connected");

	ws.send(
		JSON.stringify({
			type: "conductor/hello",
			conductorProtocol: 3,
			id: ID,
			label: LABEL,
			wants: { content: "full" }, // we need block text for the probe
		}),
	);

	ws.on("message", (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}

		if (msg.type === "host/event") {
			// Only AGENT self-unfolds (M3) become permanent "keep live" — the agent pulled these
			// back and the view may not flag them `held`, so we must not re-fold them. HUMAN
			// overrides are deliberately NOT added here: the view's per-block `held` flag already
			// reflects them every tick (self-correcting and reclaimable after resetAll), so adding
			// them would permanently poison blocks a human merely folded-then-unfolded.
			if (msg.event === "agentUnfold") for (const id of msg.ids || []) state.respectLive.add(id);
			return;
		}

		if (msg.type === "host/commandResult") {
			// The host applied our batch for this rev — it is now the live state. We deliberately
			// ignore `msg.reports`: this conductor only ever emits `fold` ids drawn from
			// foldCandidates/the prune loop (never held/protected/grouped/missing), which are EXACTLY
			// the host's four clamp conditions, and the host drops stale replies — so an emitted fold
			// is structurally unclampable and `reports` is always empty here. If this conductor ever
			// emits `replace`/`group`, or folds outside that guard, revisit: a silently-clamped id
			// recorded here as applied would never be retried.
			if (msg.rev === state.pendingRev) {
				state.confirmedApplied = state.pendingSet;
				// Refresh the readout now the epoch is CONFIRMED: until this point the status still
				// reported the pre-epoch fold count (the host suppresses the post-fold context/update,
				// so without this the line is stuck showing e.g. "0 folded · last epoch: folded 4").
				sendStatus(ws, state);
			}
			return;
		}

		if (msg.type !== "context/update") return; // ignore hello/cap-result

		const view = {
			blocks: msg.blocks,
			contextWindow: msg.contextWindow,
			budget: msg.budget,
			liveTokens: msg.liveTokens,
			protectedFromIndex: msg.protectedFromIndex,
			protectTokens: msg.protectTokens,
		};

		// Decide against the CONFIRMED applied set (what the host actually holds), so a dropped
		// reply doesn't make us believe a fold landed when it didn't.
		const decision = decideFolds(view, state.scores, state.confirmedApplied, state.respectLive, CFG);
		state.lastFullness = decision.fullness;
		state.lastAction = decision.action;

		// Emit ONLY when the desired set adds folds the host has not confirmed. This (a) keeps the
		// prompt prefix — and the inference cache — stable between epochs (a 'hold' adds nothing),
		// (b) terminates the apply→re-enter loop once the fold is confirmed, and (c) SELF-HEALS: a
		// reply dropped as stale leaves confirmedApplied unchanged, so the next update re-emits with
		// a fresh rev.
		const hasNew = [...decision.foldSet].some((id) => !state.confirmedApplied.has(id));
		if (hasNew) {
			// One deliberate cache-miss: emit the COMPLETE desired fold set, echoing the rev.
			ws.send(
				JSON.stringify({
					type: "conductor/commands",
					rev: msg.rev,
					commands: [{ kind: "fold", ids: [...decision.foldSet] }],
				}),
			);
			state.pendingRev = msg.rev;
			state.pendingSet = new Set(decision.foldSet);
			state.rescoreNeeded = true; // the tail moved; refresh scores before the next epoch
			// Telemetry only: remember this epoch's size for the status line (blocks newly folded
			// vs. what the host had confirmed, and the resulting fullness).
			const added = [...decision.foldSet].filter((id) => !state.confirmedApplied.has(id)).length;
			state.lastEpoch = { added, fullnessAfter: decision.fullness };
			log(`EPOCH: folding ${decision.foldSet.size} blocks → ~${(decision.fullness * 100).toFixed(0)}% full`);
		}

		maybeScore(ws, state, view, decision.fullness);
		sendStatus(ws, state); // display-only: reflect this decision to the human (deduped)
	});

	ws.on("close", () => {
		// Kill any in-flight probe: it's scoring a context nobody is listening to, and on
		// Accordion's reconnect a fresh probe would otherwise stack on the same GPU.
		state.abort.abort();
		log("Accordion disconnected");
	});
});

log(`${LABEL} listening on ${URL}`);
log(`band ${(CFG.lowWater * 100).toFixed(0)}–${(CFG.highWater * 100).toFixed(0)}%  warm ${(WARM_WATER * 100).toFixed(0)}%  advertised at ${REG_FILE}`);
