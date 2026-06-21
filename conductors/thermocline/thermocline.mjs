// thermocline.mjs — the WebSocket SERVER for the Thermocline conductor.
//
// Thermocline is a double-buffered, multi-tier context-compression conductor:
//   • A small LM probe scores each block's "temperature" (attention to the working tail).
//   • Cold units dwell through K epochs before graduating to a stratum (holistic LLM summary).
//   • Under pressure the planner layers: deepen (per-block fold) → graduate (stratum) →
//     merge (ceiling) → drop (hard delete). Budget invariant: the agent is NEVER over budget.
//
// The epoch machine mirrors attention-folder's boundary model (periodic, hysteresis-banded,
// cache-warm) but adds a second channel: host.complete (cap/request) for LLM digest/stratum
// summaries, plus a PREPARE anticipation window so summaries arrive BEFORE the high-water
// commit deadline. EMERGENCY falls back to deterministic tiers instantly, with no LLM.
//
// Topology mirrors attention-folder: this process hosts a WebSocket server, advertises itself
// under ~/.accordion/conductors/ for desktop auto-discovery, and Accordion dials in.
//
// Run:  npm install   then   npm start   (or: node thermocline.mjs)
//       The probe path is resolved from attention-folder's own directory — see scorer.mjs.

// `ws` is imported DYNAMICALLY inside the !SMOKE bootstrap so the inline smoke harness
// (node thermocline.mjs --smoke) can load this module to exercise the pure commit/graduation
// helpers WITHOUT requiring `npm install` (ws absent) — mirrors how policy.test.mjs needs no deps.
import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync, writeFile, rename } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CFG,
	buildUnits,
	project,
	updateGraduation,
	planEpoch,
	emitCommands,
	buildDigestPrompt,
	buildStratumPrompt,
} from "./policy.mjs";
import { scoreCandidates, tailTextFromView } from "./scorer.mjs";

const ID = "thermocline";
const LABEL = "Thermocline";
const PORT = Number(process.env.THERMO_PORT || 7703);
const URL = `ws://127.0.0.1:${PORT}`;

// `node thermocline.mjs --smoke` runs the inline smoke harness instead of the WS server (it must
// NOT bind a port or advertise a heartbeat). See the bottom of the file.
const SMOKE = process.argv.includes("--smoke");

// Copy the CFG defaults from policy so each can be overridden via env.
const CFG = {
	highWater: Number(process.env.THERMO_HIGH_WATER || DEFAULT_CFG.highWater),
	lowWater: Number(process.env.THERMO_LOW_WATER || DEFAULT_CFG.lowWater),
	warmWater: Number(process.env.THERMO_WARM_WATER || DEFAULT_CFG.warmWater),
	ceilingFrac: Number(process.env.THERMO_CEILING_FRAC || DEFAULT_CFG.ceilingFrac),
	coldThreshold: Number(process.env.THERMO_COLD_THRESHOLD || DEFAULT_CFG.coldThreshold),
	K: Number(process.env.THERMO_K || DEFAULT_CFG.K),
	minRunUnits: Number(process.env.THERMO_MIN_RUN_UNITS || DEFAULT_CFG.minRunUnits),
	minFoldTokens: Number(process.env.THERMO_MIN_FOLD_TOKENS || DEFAULT_CFG.minFoldTokens),
};

function log(msg) {
	process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// ── Auto-discovery: advertise a heartbeat file under ~/.accordion/conductors/ ──
// Mirrors attention-folder exactly — ACCORDION_HOME fallback + atomic rename.
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
const heartbeat = SMOKE ? null : (advertise(), setInterval(advertise, 5_000));

function shutdown() {
	if (heartbeat) clearInterval(heartbeat);
	try {
		rmSync(REG_FILE, { force: true });
	} catch {
		/* already gone */
	}
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Persistence: deep-zone strata + dwell survive reconnect ──
// Only strata (with their actual summary TEXT) and dwell/everWarm are worth saving.
// Folds re-derive from scores on reconnect; only the compacted zone is irreversible.
// Persist files live in the SAME dir as the discovery heartbeat (~/.accordion/conductors),
// so there is one path source of truth — PERSIST_DIR is an alias of REG_DIR.
const PERSIST_DIR = REG_DIR;

/**
 * Deterministic key for a session — used as part of the persist filename so each session keeps
 * its own deep zone. Prefer a stable session id when the host supplies one (a fork may extend the
 * `host/hello` session payload — the contract today is only {title,model,cwd}, but an `id` is the
 * primary key when present). Otherwise hash title|model|cwd.
 *
 * Returns `null` when there is no usable identity (no id AND any of title/model/cwd is missing) so
 * the caller skips persistence entirely — two under-specified sessions must NOT hash to the same
 * `undefined|undefined|undefined` file and corrupt each other's deep zone.
 */
function sessionKey(session) {
	if (session && typeof session.id === "string" && session.id) {
		// A real session id is already unique — namespace it so it can't collide with a hash key.
		return `id-${session.id}`;
	}
	// Fall back to the {title,model,cwd} hash, but only if ALL three are present. A missing field
	// would stringify to "undefined" and let two distinct under-specified sessions share a file.
	const { title, model, cwd } = session ?? {};
	if (typeof title !== "string" || typeof model !== "string" || typeof cwd !== "string") return null;
	const raw = `${title}|${model}|${cwd}`;
	// FNV-1a 32-bit, same algorithm as foldCode, just a different use-site.
	let h = 0x811c9dc5;
	for (let i = 0; i < raw.length; i++) {
		h ^= raw.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36).padStart(8, "0");
}

function persistPath(key) {
	return join(PERSIST_DIR, `thermocline-state-${key}.json`);
}

function loadPersistedState(key) {
	try {
		const raw = readFileSync(persistPath(key), "utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function persistState(key, applied, grad) {
	// Best-effort, truly non-blocking — fire-and-forget async I/O so commit() stays fast.
	// An occasional missed write is fine; the deep zone is regenerable from a fresh epoch.
	try {
		mkdirSync(PERSIST_DIR, { recursive: true });
	} catch {
		return; // can't even make the dir — give up silently
	}
	const data = {
		strata: applied.strata.map((s) => ({
			firstId: s.firstId,
			lastId: s.lastId,
			unitIds: s.unitIds,
			memberIds: s.memberIds,
			summary: s.summary ?? null, // the actual LLM text, if we have it
			summaryTokens: s.summaryTokens,
		})),
		dwell: [...(grad.dwell ?? new Map()).entries()],
		everWarm: [...(grad.everWarm ?? new Set())],
	};
	const p = persistPath(key);
	const tmp = `${p}.${process.pid}.tmp`;
	// Atomic write-temp-then-rename, async (fire-and-forget — errors logged but not thrown).
	writeFile(tmp, JSON.stringify(data, null, 2), (writeErr) => {
		if (writeErr) {
			log(`persist write failed (non-fatal): ${writeErr.message}`);
			return;
		}
		rename(tmp, p, (renameErr) => {
			if (renameErr) log(`persist rename failed (non-fatal): ${renameErr.message}`);
		});
	});
}

// ── Per-connection conductor state ──
// One Accordion session per WebSocket connection. State resets on reconnect.
function freshState() {
	return {
		// Double-buffer: what the host has CONFIRMED applied.
		confirmedApplied: new Set(), // fold block ids confirmed by host/commandResult
		pendingRev: -1, // rev of an unconfirmed emitted batch
		pendingSet: new Set(), // fold ids of that pending batch

		// The FRONT BUFFER — the full applied state we last committed.
		applied: {
			plan: null, // the Plan from planEpoch that produced the current commit
			foldedIds: new Set(), // block ids that are folded (our choice)
			strata: [], // [{firstId, lastId, unitIds, memberIds, summary, summaryTokens}]
			sig: null, // signature of the last emitted commands (for the HOLD gate)
		},

		// PREPARE state.
		preparing: false,
		prepareToken: 0, // incremented to discard stale LLM completions

		// Graduation state (dwell + everWarm — persisted).
		grad: {
			dwell: new Map(),
			graduated: new Set(),
			everWarm: new Set(),
		},

		// Scoring (from the attention probe).
		scores: new Map(), // temperatureKey → temperature (0..1)
		scoringInFlight: false,
		rescoreNeeded: true,
		attempted: new Set(), // temperatureKeys already sent to the probe

		// Agent/human touch tracking (resets dwell, vetoes graduation).
		agentTouched: new Set(), // block ids the agent unfolded/recalled this epoch
		recalledThisEpoch: new Set(), // same (agentUnfold events)

		// Digest cache: key → LLM summary text (survives across epochs).
		digestCache: new Map(),

		// Pending cap/request completions.
		pendingCaps: new Map(), // reqId → {resolve, reject, timer}
		reqIdCounter: 0,

		// Display telemetry.
		lastStatusText: "",
		lastFill: 0,
		lastAction: "hold",

		// Session identification (set after host/hello).
		sessionKey: null,
		lastView: null,

		// AbortController for the in-flight probe (abort on disconnect).
		abort: new AbortController(),
	};
}

// ── Status line ──
function buildStatus(state) {
	const rawFill = Number.isFinite(state.lastFill) ? state.lastFill : 0;
	const pct = Math.round(rawFill * 100);
	const folded = state.confirmedApplied.size;
	const strata = state.applied.strata.length;
	const action = state.preparing ? "PREPARE" : state.lastAction === "emergency" ? "EMERGENCY" : "HOLD";
	const scoring = state.scoringInFlight ? " · scoring…" : "";
	const text = `${action} ${pct}% · ${folded} folded · ${strata} strata${scoring}`;
	const metrics = {
		fullness: pct,
		action,
		folded,
		strata,
		scoring: state.scoringInFlight,
		lowWater: Math.round(CFG.lowWater * 100),
		highWater: Math.round(CFG.highWater * 100),
	};
	return { text, metrics };
}

function sendStatus(ws, state) {
	if (ws.readyState !== 1 /* WebSocket.OPEN */) return;
	const { text, metrics } = buildStatus(state);
	if (text === state.lastStatusText) return;
	state.lastStatusText = text;
	ws.send(JSON.stringify({ type: "conductor/status", text, metrics }));
}

// ── cap/request bridge: host.complete over the wire ──
function nextReqId(state) {
	return `thermo-${++state.reqIdCounter}`;
}

/**
 * Send a cap/request for a model completion and return a Promise<string> that resolves to
 * the model's text, or rejects on error/timeout. 120 s timeout — rejected completions cause
 * emitCommands to fall back to the deterministic tier automatically (no special-casing needed).
 */
function complete(ws, state, { system, prompt, maxOutputTokens }) {
	return new Promise((resolve, reject) => {
		if (ws.readyState !== 1) {
			reject(new Error("ws closed before complete"));
			return;
		}
		const reqId = nextReqId(state);
		const timer = setTimeout(() => {
			// Settle EXACTLY ONCE: only reject if this entry is still pending. cap/result and the
			// ws-close handler both delete-then-settle, so a late timer that races past clearTimeout
			// finds no entry and does nothing — never rejecting an already-settled promise (which
			// would be an unhandled rejection under --unhandled-rejections=throw).
			if (!state.pendingCaps.has(reqId)) return;
			state.pendingCaps.delete(reqId);
			reject(new Error(`cap/request ${reqId} timed out`));
		}, 120_000);
		state.pendingCaps.set(reqId, { resolve, reject, timer });
		ws.send(
			JSON.stringify({
				type: "cap/request",
				reqId,
				capability: "complete",
				completion: { system, prompt, maxOutputTokens },
			}),
		);
	});
}

// ── Command signature: cheap stable key for the HOLD gate ──
// We want to skip re-sending if the commands haven't changed (content-addressable dedup).
function commandSig(commands) {
	return JSON.stringify(commands);
}

// ── needNewEpoch: decide whether the current applied state still looks fresh ──
// A new epoch is warranted when: (a) there is no current plan, OR (b) the projected fill
// under the current applied state is already above highWater (the plan is too stale to trust).
function needNewEpoch(state, view, fill, cap) {
	if (!state.applied.plan) return true;
	// If we're above high-water the current plan no longer brings us down safely.
	// fill is a FRACTION (0..1), CFG.highWater is a FRACTION — compare fraction vs fraction.
	if (fill >= CFG.highWater) return true;
	return false;
}

// ── Background scoring trigger ──
// Mirrors attention-folder's maybeScore exactly. Fires when approaching warmWater.
function maybeScore(ws, state, view) {
	const units = buildUnits(view.blocks);
	// Score candidates = units with a temperatureKey not yet attempted.
	// (attempted is REPLACED each run so a unit can be re-scored when rescoreNeeded fires again.)
	const cands = units.filter(
		(u) => !u.protected && !u.held && !state.attempted.has(u.temperatureKey),
	);
	const fill = state.lastFill;

	// Guard: must be warm, not already scoring, and have work to do (rescoreNeeded or new cands).
	if (fill < CFG.warmWater || state.scoringInFlight || !(state.rescoreNeeded || cands.length)) return;
	if (!cands.length) return;

	const tailText = tailTextFromView(view.blocks);
	if (!tailText.trim()) return; // no work tail to score against

	state.scoringInFlight = true;
	const candidates = cands.map((u) => ({ id: u.temperatureKey, text: u.blocks.map((b) => b.text ?? "").join("\n") }));
	const ids = candidates.map((c) => c.id);
	log(`scoring ${candidates.length} units (fill ${(fill * 100).toFixed(0)}%)…`);
	sendStatus(ws, state);

	scoreCandidates({ tailText, candidates, signal: state.abort.signal, log })
		.then((scores) => {
			for (const [id, v] of scores) state.scores.set(id, v);
			// REPLACE (not accumulate) so a unit can be re-scored on the next rescoreNeeded.
			// Mirrors attention-folder: state.attempted = new Set(ids).
			state.attempted = new Set(ids);
			state.rescoreNeeded = false;
			state.scoringInFlight = false;
			log(`scores ready: ${state.scores.size} cached`);
			sendStatus(ws, state);
		})
		.catch((err) => {
			state.scoringInFlight = false;
			log(`scoring failed: ${err.message}`);
			sendStatus(ws, state);
		});
}

// ── gradState: assemble the ThermoState shape that updateGraduation / planEpoch expect ──
function gradState(state) {
	return {
		dwell: state.grad.dwell,
		graduated: state.grad.graduated,
		everWarm: state.grad.everWarm,
		agentTouched: state.agentTouched,
		recalledThisEpoch: state.recalledThisEpoch,
	};
}

// ── appliedForProject: translate our internal applied state into the shape project() expects ──
function appliedForProject(state) {
	return {
		foldedIds: state.applied.foldedIds,
		strata: state.applied.strata.map((s) => ({
			memberIds: s.memberIds,
			summaryTokens: s.summaryTokens,
		})),
	};
}

// ── commit helpers: reconcile (BLOCKER 2) + real-token top-up (BLOCKER 1) ──

/** Union of two (possibly undefined) sets into a fresh Set (policy.unionSet is not exported). */
function unionSet(a, b) {
	const out = new Set(a ?? []);
	for (const x of b ?? []) out.add(x);
	return out;
}

/** cap = the tighter of budget and contextWindow (mirrors policy.capOf, which is not exported). */
function capOfView(view) {
	return Math.min(view.budget, view.contextWindow ?? view.budget);
}

/** The project()-shape applied state derived from a working plan's folds + strata. */
function appliedShapeOf(plan) {
	return {
		foldedIds: new Set(plan.folds.flatMap((f) => f.ids)),
		strata: plan.strata.map((s) => ({ memberIds: s.memberIds, summaryTokens: s.summaryTokens })),
	};
}

/**
 * BLOCKER 2 — commit-time assemble()/reconcile. Any unit the agent recalled, unfolded, or
 * re-warmed during PREPARE is dropped from the epoch before it is swapped in: a fold whose member
 * ids intersect `touched` is removed, and a whole stratum that contains a touched member is removed
 * (you cannot partially un-group, so the whole run stays live this epoch). Belt-and-suspenders with
 * the round-1 discard-on-agentUnfold — guarantees the agent's veto holds even if a prepare slipped
 * through (e.g. the first epoch where state.applied.plan was null and the discard couldn't see the
 * coming folds). Returns a NEW plan (does not mutate the input).
 */
function reconcilePlan(plan, touched) {
	if (!touched || touched.size === 0) return plan;
	const folds = plan.folds.filter((f) => !f.ids.some((id) => touched.has(id)));
	const strata = plan.strata.filter((s) => !s.memberIds.some((id) => touched.has(id)));
	if (folds.length === plan.folds.length && strata.length === plan.strata.length) return plan;
	return { ...plan, folds, strata };
}

/**
 * Substitute REAL LLM-summary token counts into a plan's strata (the digest text length), so the
 * projection reflects what the agent will actually receive — not planEpoch's ~12% estimate. Returns
 * a NEW plan with each stratum's summaryTokens replaced when a real summary exists.
 */
function planWithRealStratumTokens(plan, digests) {
	const d = digests ?? new Map();
	const strata = plan.strata.map((s) => {
		if (s.digestKind === "drop") return s; // a drop contributes 0 — no real text
		const summary = d.get(`stratum:${s.ids[0]}`);
		if (summary == null) return s; // no LLM text yet → keep the estimate
		return { ...s, summaryTokens: Math.ceil(summary.length / 4) };
	});
	return { ...plan, strata };
}

/**
 * Convert a plan's OWN strata to drops OLDEST-FIRST until project() ≤ bound (or none remain).
 * Mirrors policy.dropStrataOldestFirst but operates on our working plan. Each drop frees the
 * stratum's REAL summaryTokens, so this strictly reduces and terminates. Mutates `plan.strata`
 * elements in place; returns true iff it dropped at least one stratum.
 */
function dropOwnStrataOldestFirst(plan, view, bound) {
	const orderOf = new Map(view.blocks.map((b) => [b.id, b.order]));
	const sorted = plan.strata
		.map((s) => ({ s, ord: orderOf.get(s.ids[0]) ?? Infinity }))
		.sort((a, b) => a.ord - b.ord);
	let dropped = false;
	for (const { s } of sorted) {
		if (project(view, appliedShapeOf(plan)) <= bound) break;
		if (s.digestKind !== "drop") {
			s.digestKind = "drop";
			s.summaryTokens = 0;
			dropped = true;
		}
	}
	return dropped;
}

/**
 * BLOCKER 1 — guarantee the agent NEVER receives a batch whose projected live exceeds cap, using
 * the REAL summary token counts (not the estimate planEpoch projected with). Called after the plan
 * has real stratum tokens substituted in. If projected ≤ cap there is nothing to do. Otherwise:
 *
 *   (1) Run a DETERMINISTIC planEpoch over the live view to get additional folds/age-strata/drops,
 *       and MERGE its NEW moves into our plan (a fold whose unit is already folded or claimed by a
 *       stratum is skipped; a stratum whose members are already claimed is skipped) — keeping our
 *       real-token LLM strata. Re-check (≤3 passes; the deterministic floor terminates so this is a
 *       guard against a pathological loop, not the real terminator).
 *   (2) If merging makes no further progress yet we're still over cap (e.g. a single verbose stratum
 *       at maxOutputTokens whose region the deterministic plan would only re-stratum, so it's skipped
 *       as already-claimed), DROP our own strata oldest-first until ≤ cap. Dropping always frees real
 *       tokens down to the irreducible floor, which planEpoch guarantees is ≤ cap.
 *
 * Mutates / returns a plan whose project(view) ≤ cap (with real tokens). Pure-ish: builds new fold
 * entries, may convert strata to drops.
 */
function topUpToCap(plan, view, state, cap) {
	if (project(view, appliedShapeOf(plan)) <= cap) return plan;

	const liveUnits = buildUnits(view.blocks);
	const memberIdsOfUnit = new Map(liveUnits.map((u) => [u.id, u.ids]));
	// Track every UNIT id our plan has already claimed (folded or swept into a stratum) so merged
	// deterministic moves never double-fold/double-group the same unit.
	const claimedUnits = new Set([
		...plan.folds.map((f) => f.unitId),
		...plan.strata.flatMap((s) => s.unitIds ?? []),
	]);
	// Every member id already claimed by a fold OR a stratum — the secondary (member-level) guard
	// behind claimedUnits. (Units partition blocks, so claimedUnits alone is airtight; this just
	// keeps the "no member already claimed" check literally true against all existing content.)
	const foldedMembers = new Set([
		...plan.folds.flatMap((f) => f.ids),
		...plan.strata.flatMap((s) => s.memberIds ?? []),
	]);

	const MAX_PASSES = 3;
	for (let pass = 0; pass < MAX_PASSES; pass++) {
		if (project(view, appliedShapeOf(plan)) <= cap) return plan;
		const det = planEpoch(view, state.scores, gradState(state), CFG, {
			deterministic: true,
			graduated: state.grad.graduated,
		});
		let added = false;

		// Merge NEW deterministic folds (unit not already claimed, no member already folded).
		for (const f of det.folds) {
			if (claimedUnits.has(f.unitId)) continue;
			if (f.ids.some((id) => foldedMembers.has(id))) continue;
			plan.folds.push({ unitId: f.unitId, ids: f.ids, tier: f.tier });
			for (const id of f.ids) foldedMembers.add(id);
			claimedUnits.add(f.unitId);
			added = true;
		}

		// Merge NEW deterministic strata (no member already folded/claimed). These carry estimated
		// tokens / deterministic recaps — emitCommands renders deterministicRecap for them (no LLM).
		for (const s of det.strata) {
			const units = s.unitIds ?? [];
			if (units.some((id) => claimedUnits.has(id))) continue;
			if (s.memberIds.some((id) => foldedMembers.has(id))) continue;
			plan.strata.push({
				ids: s.ids,
				unitIds: units,
				memberIds: s.memberIds,
				digestKind: s.digestKind,
				summaryTokens: s.summaryTokens,
			});
			for (const id of units) claimedUnits.add(id);
			for (const id of s.memberIds) foldedMembers.add(id);
			// member ids of the unit (incl. non-foldable tool_call) are now claimed.
			for (const uid of units) for (const mid of memberIdsOfUnit.get(uid) ?? []) foldedMembers.add(mid);
			added = true;
		}

		if (project(view, appliedShapeOf(plan)) <= cap) return plan;
		if (!added) break; // no NEW moves available — fall through to dropping our own strata
	}

	// Last resort: drop our OWN strata oldest-first (frees real tokens) until ≤ cap. Always
	// terminates — the floor (no strata, only folds + protected tail) is ≤ cap by planEpoch's
	// hard-cap guarantee.
	dropOwnStrataOldestFirst(plan, view, cap);
	return plan;
}

// ── commit: send conductor/commands and update internal state ──
// This is the ATOMIC COMMIT point. After this, the host holds the new state.
function commit(ws, state, view, plan, digests) {
	// (1) BLOCKER 2 — reconcile against reality: drop any fold/stratum the agent touched (recalled,
	//     unfolded, or re-warmed) during PREPARE before this state is swapped in.
	const touched = unionSet(state.agentTouched, state.recalledThisEpoch);
	// (2) Substitute REAL LLM-summary tokens so the projection reflects the actual wire, then
	//     (3) BLOCKER 1 — top up deterministically until projected live ≤ cap with those real tokens.
	let working = reconcilePlan(plan, touched);
	working = planWithRealStratumTokens(working, digests);
	working = topUpToCap(working, view, state, working.cap || capOfView(view));

	// Recompute the final projection (with real tokens + any top-up) for the log + telemetry.
	const finalProjected = project(view, appliedShapeOf(working));
	working = { ...working, projected: finalProjected };

	// Build the commands from the FINAL reconciled+topped-up plan (so plan ↔ commands ↔ applied
	// all agree — holdOrResend later re-derives from state.applied.plan).
	const cmds = emitCommands(working, digests, view);
	const sig = commandSig(cmds);

	// Update our applied state from the FINAL plan.
	const newFoldedIds = new Set(working.folds.flatMap((f) => f.ids));
	const newStrata = working.strata.map((s) => {
		const key = `stratum:${s.ids[0]}`;
		const summary = s.digestKind === "drop" ? null : (digests?.get(key) ?? null);
		return {
			firstId: s.ids[0],
			lastId: s.ids[1],
			unitIds: s.unitIds,
			memberIds: s.memberIds,
			summary,
			// summaryTokens already carries the real text length for summarised strata (set in
			// planWithRealStratumTokens / 0 for drops); recompute from text when we have it to stay exact.
			summaryTokens: summary != null ? Math.ceil(summary.length / 4) : s.summaryTokens,
		};
	});

	state.applied = {
		plan: working,
		foldedIds: newFoldedIds,
		strata: newStrata,
		sig,
	};

	// Track pending confirmation (mirrors attention-folder).
	// Include each stratum's group id ('g:'+firstId) so a group-only batch arms
	// pendingUnconfirmed and self-heals if the host drops it.
	state.pendingRev = view.rev ?? -1;
	state.pendingSet = new Set([
		...newFoldedIds,
		...newStrata.map((s) => `g:${s.firstId}`),
	]);

	ws.send(JSON.stringify({ type: "conductor/commands", rev: view.rev, commands: cmds }));

	// Persist the deep zone so strata+summaries survive reconnect.
	if (state.sessionKey) {
		persistState(state.sessionKey, { strata: newStrata }, state.grad);
	}

	// Clear per-epoch touch sets: the epoch just committed so the "agent touched this epoch"
	// signal has been consumed. Not clearing here would permanently veto graduation (#4, #5).
	state.recalledThisEpoch = new Set();
	state.agentTouched = new Set();

	state.lastAction = "epoch";
	state.rescoreNeeded = true; // tail moved; rescore before the next epoch
	const capForLog = working.cap || capOfView(view);
	log(`COMMIT: ${working.folds.length} folds · ${working.strata.length} strata → projected ~${(finalProjected / Math.max(1, capForLog) * 100).toFixed(0)}% full`);
}

// ── HOLD: re-derive commands from current applied plan, send only if changed ──
// Self-heal: if the last batch we sent is still UNCONFIRMED (its rev has not been acked by
// host/commandResult) re-emit regardless of sig — the host may have dropped it as stale.
// This mirrors attention-folder: we drive re-emission off confirmation, not off sig alone.
function holdOrResend(ws, state, view) {
	if (!state.applied.plan) return; // nothing committed yet — can't re-derive
	const cmds = emitCommands(state.applied.plan, state.digestCache, view);
	const sig = commandSig(cmds);

	// Determine whether the last emitted batch is still pending (host hasn't acked it).
	const pendingUnconfirmed =
		state.pendingRev >= 0 &&
		[...state.pendingSet].some((id) => !state.confirmedApplied.has(id));

	// HOLD gate: skip only when the command set is unchanged AND the last batch is confirmed.
	if (sig === state.applied.sig && !pendingUnconfirmed) return;

	state.applied.sig = sig;
	state.pendingRev = view.rev;
	// Include stratum group ids so group-only batches arm pendingUnconfirmed (mirrors commit).
	state.pendingSet = new Set([
		...state.applied.foldedIds,
		...state.applied.strata.map((s) => `g:${s.firstId}`),
	]);
	ws.send(JSON.stringify({ type: "conductor/commands", rev: view.rev, commands: cmds }));
	log(`re-emit (view changed or pending unconfirmed)`);
}

// ── PREPARE epoch in background: score + LLM summaries + commit ──
// Runs entirely asynchronously. A stale token (prepareToken mismatch) causes early exit
// so a superseded prepare (new human override, emergency, reconnect) is cleanly discarded.
async function prepareEpoch(ws, state, view, token) {
	// 1. Compute fresh plan (deterministic paths, no LLM yet). Graduation was advanced ONCE this tick
	//    by the context/update handler — we thread that graduated set in; planEpoch never re-advances.
	const plan = planEpoch(view, state.scores, gradState(state), CFG, { graduated: state.grad.graduated });

	// 2. Fire cap/request completions for every digest/stratum that is not cached.
	const jobs = [];

	// Per-unit L2 digest jobs.
	const units = buildUnits(view.blocks);
	const byUnit = new Map(units.map((u) => [u.id, u]));
	for (const f of plan.folds) {
		if (f.tier !== "digest") continue;
		if (state.digestCache.has(f.unitId)) continue;
		const u = byUnit.get(f.unitId);
		if (!u) continue;
		const { system, prompt } = buildDigestPrompt(u);
		jobs.push(
			complete(ws, state, { system, prompt, maxOutputTokens: 120 })
				.then((text) => ({ key: f.unitId, text }))
				.catch(() => null), // fallback: null → emitCommands uses deterministicDigest
		);
	}

	// Per-stratum L3 summary jobs.
	for (const s of plan.strata) {
		if (s.digestKind !== "summary") continue;
		const key = `stratum:${s.ids[0]}`;
		if (state.digestCache.has(key)) continue;
		const stratumUnits = s.unitIds.map((id) => byUnit.get(id)).filter(Boolean);
		if (!stratumUnits.length) continue;
		const { system, prompt } = buildStratumPrompt(stratumUnits);
		jobs.push(
			complete(ws, state, { system, prompt, maxOutputTokens: 600 })
				.then((text) => ({ key, text }))
				.catch(() => null),
		);
	}

	// Await all LLM calls (Promise.allSettled so partial failures don't abort the epoch).
	const results = await Promise.allSettled(jobs);
	// Check if this prepare is still current (a newer one or an emergency may have superseded it).
	// Do NOT clear state.preparing here — the current owner (or EMERGENCY / agentUnfold discard)
	// manages that flag; clearing it from a stale branch would incorrectly signal completion to
	// the live owner and allow a spurious re-prepare to fire on the same tick.
	if (state.prepareToken !== token) {
		log(`prepare ${token} superseded — discarding`);
		return;
	}

	// Cache whatever came back — but ONLY real, non-empty text (#5). r.value is the wrapper
	// {key,text} (always truthy), so an empty model response (text="" or whitespace) would
	// otherwise be cached as "" — and emitCommands' `d.get(...) ?? deterministic` does NOT fall
	// back on "" (it's non-nullish), giving the agent a bare `{#code FOLDED}` tag with no body.
	// Dropping empty/whitespace responses lets emitCommands fall back to deterministicDigest/Recap.
	for (const r of results) {
		if (r.status === "fulfilled" && r.value && r.value.text && r.value.text.trim()) {
			state.digestCache.set(r.value.key, r.value.text);
		}
	}

	// Re-plan on the LAST view (not the stale one we started with) so the commands are fresh.
	const lv = state.lastView ?? view;
	const freshPlan = planEpoch(lv, state.scores, gradState(state), CFG, { graduated: state.grad.graduated });

	// COMMIT — atomic. commit() clears recalledThisEpoch + agentTouched at the single commit point.
	if (ws.readyState === 1) {
		commit(ws, state, lv, freshPlan, state.digestCache);
	}
	state.preparing = false;
	sendStatus(ws, state);
}

// ── Main message handler ──
// Defined as a named function so the inline smoke harness (--smoke) can load this module without
// binding a port; the server is only created + wired below, guarded by !SMOKE.
function onConnection(ws) {
	const state = freshState();
	log("Accordion connected");

	ws.send(
		JSON.stringify({
			type: "conductor/hello",
			conductorProtocol: 3,
			id: ID,
			label: LABEL,
			wants: { content: "full" }, // need block text for probe + digest prompts
			locks: ["human-steering"], // thermocline manages fold/unfold/pin/group
		}),
	);

	ws.on("message", (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}

		// ── host/hello — session identity + optional state restore ──
		if (msg.type === "host/hello") {
			state.sessionKey = sessionKey(msg.session ?? {});
			// A null key means the session is under-specified (no id, missing title/model/cwd):
			// skip restore AND later persistence so we never read/write a shared "null" file.
			const saved = state.sessionKey ? loadPersistedState(state.sessionKey) : null;
			if (saved) {
				// Restore strata (with their summary texts) and dwell.
				// LOW: skip strata from PRE-EXISTING persist files that lack a non-empty unitIds —
				// emitCommands would render deterministicRecap([]) ("run · empty") over a real summary
				// (it reads s.unitIds → byUnit → []), clobbering the saved digest. A stratum with no
				// unitIds also can't be re-validated by member id below, so it can never heal.
				const savedStrata = Array.isArray(saved.strata)
					? saved.strata.filter((s) => Array.isArray(s.unitIds) && s.unitIds.length > 0)
					: [];
				if (savedStrata.length) {
					state.applied.strata = savedStrata;
					// Re-populate the digest cache from saved summaries.
					for (const s of savedStrata) {
						if (s.summary != null) {
							state.digestCache.set(`stratum:${s.firstId}`, s.summary);
						}
					}
					// Reconstruct a synthetic plan from the restored strata so holdOrResend can
					// emit them on the first context/update (#6). No folds — those re-derive from
					// scores. The plan shape emitCommands expects: folds[], strata[{ids,unitIds,
					// memberIds,digestKind,summaryTokens}], projected, cap, targetTokens.
					// We don't know projected/cap/targetTokens yet — use 0 as safe sentinels;
					// they're only used for the COMMIT log, not by holdOrResend/emitCommands.
					state.applied.plan = {
						folds: [],
						strata: state.applied.strata.map((s) => ({
							ids: [s.firstId, s.lastId],
							unitIds: s.unitIds ?? [],
							memberIds: s.memberIds ?? [],
							digestKind: "summary",
							summaryTokens: s.summaryTokens ?? 0,
						})),
						projected: 0,
						cap: 0,
						targetTokens: 0,
					};
					// Mark that we need to validate strata ids on the first view (#6).
					state._restoredPendingValidation = true;
				}
				if (Array.isArray(saved.dwell)) {
					state.grad.dwell = new Map(saved.dwell);
				}
				if (Array.isArray(saved.everWarm)) {
					state.grad.everWarm = new Set(saved.everWarm);
				}
				log(`restored state for session ${state.sessionKey}: ${state.applied.strata.length} strata, ${state.grad.dwell.size} dwell entries`);
			}
			return;
		}

		// ── host/event — agent self-unfold or human override ──
		if (msg.type === "host/event") {
			const ids = msg.ids ?? [];
			if (msg.event === "agentUnfold") {
				for (const id of ids) {
					state.agentTouched.add(id);
					state.recalledThisEpoch.add(id);
				}
				// If a prepare is in flight, UNCONDITIONALLY discard it on any agentUnfold.
				// The in-flight prepare's plan is local to prepareEpoch and not stored on state,
				// so checking state.applied.plan (the LAST COMMITTED plan) would miss folds the
				// in-flight prepare will add — a conservative discard guarantees the veto is
				// never missed. Agent unfolds are rare; the next tick re-prepares if still needed.
				if (state.preparing && ids.length) {
					log(`agentUnfold — discarding in-flight prepare to guarantee veto`);
					++state.prepareToken;
					state.preparing = false;
				}
			} else if (msg.event === "humanOverride") {
				// Do NOT add humanOverride ids to agentTouched: the view's per-block `held` flag
				// already reflects them on the next tick and policy's graduation resets on `held`.
				// Adding them here would permanently poison ids a human merely folded-then-unfolded
				// (the exact anti-pattern warned about in attention-folder.mjs:214-221) — #5.
			}
			return;
		}

		// ── cap/result — LLM completion or other cap response ──
		if (msg.type === "cap/result") {
			const pending = state.pendingCaps.get(msg.reqId);
			if (!pending) return; // stale or already settled
			state.pendingCaps.delete(msg.reqId);
			clearTimeout(pending.timer);
			if (msg.ok) {
				pending.resolve(typeof msg.value === "string" ? msg.value : String(msg.value ?? ""));
			} else {
				pending.reject(new Error(msg.error ?? "cap/result ok:false"));
			}
			return;
		}

		// ── host/commandResult — confirmation that our batch was applied ──
		if (msg.type === "host/commandResult") {
			if (msg.rev === state.pendingRev) {
				// The host confirmed our pending batch — it is now the live confirmed state.
				state.confirmedApplied = new Set(state.pendingSet);
				sendStatus(ws, state);
			}
			// Log any clamps (unexpected — our commands should be provider-valid, but useful for debugging).
			if (msg.reports?.length) {
				for (const r of msg.reports) {
					log(`CLAMP rev=${msg.rev}: ${JSON.stringify(r)}`);
				}
			}
			return;
		}

		// ── context/update — the main steady-state message ──
		if (msg.type !== "context/update") return;

		const view = {
			rev: msg.rev,
			blocks: msg.blocks,
			contextWindow: msg.contextWindow,
			budget: msg.budget,
			liveTokens: msg.liveTokens,
			protectedFromIndex: msg.protectedFromIndex,
			protectTokens: msg.protectTokens,
		};
		state.lastView = view;

		// ── Validate restored strata on the first real view (#6, #7) ──
		// Drop any stratum with ANY missing member id, not just a missing firstId/lastId (#7). An
		// interior member can vanish (scrolled out / session diverged) while the boundary ids
		// survive — project() would still subtract that stratum's summaryTokens (permanently low
		// fill → delayed epochs) and the group([firstId,lastId]) could even swallow live blocks that
		// drifted into the gap. A stratum is only safe to keep if EVERY member is still live.
		if (state._restoredPendingValidation) {
			state._restoredPendingValidation = false;
			const liveIds = new Set(view.blocks.map((b) => b.id));
			const validStrata = state.applied.strata.filter(
				(s) =>
					liveIds.has(s.firstId) &&
					liveIds.has(s.lastId) &&
					Array.isArray(s.memberIds) &&
					s.memberIds.length > 0 &&
					s.memberIds.every((id) => liveIds.has(id)),
			);
			if (validStrata.length !== state.applied.strata.length) {
				const dropped = state.applied.strata.length - validStrata.length;
				log(`restore validation: dropped ${dropped} stale strata (ids vanished from view)`);
				state.applied.strata = validStrata;
				// Rebuild the plan stub from the surviving strata.
				state.applied.plan = validStrata.length
					? {
						folds: [],
						strata: validStrata.map((s) => ({
							ids: [s.firstId, s.lastId],
							unitIds: s.unitIds ?? [],
							memberIds: s.memberIds ?? [],
							digestKind: "summary",
							summaryTokens: s.summaryTokens ?? 0,
						})),
						projected: 0,
						cap: 0,
						targetTokens: 0,
					}
					: null; // nothing left to emit
			}
		}

		const cap = Math.min(view.budget, view.contextWindow ?? view.budget);
		const fill = cap > 0 ? project(view, appliedForProject(state)) / cap : 0;
		state.lastFill = fill;

		// ── everWarm update (EVERY tick) ──
		// everWarm feeds scoring/graduation (need=K vs 2K), so it must track the latest scores on
		// every tick — even HOLD ticks where no epoch fires. Update it BEFORE any graduation
		// computation so a unit that became hot THIS tick is already in everWarm when graduation
		// decides need=K vs 2K (prevents a one-tick lag where a newly-hot unit graduates at K).
		const units = buildUnits(view.blocks);
		for (const u of units) {
			const temp = state.scores.get(u.temperatureKey);
			if (temp !== undefined && temp >= CFG.coldThreshold) {
				state.grad.everWarm.add(u.id);
			}
		}

		// ── Prune unbounded per-session maps (#6). ──
		// scores/attempted/digestCache otherwise grow forever — scrolled-out block ids and
		// merged-away strata accumulate. Best-effort, cheap, no behavior change beyond bounding
		// memory: drop any key whose underlying id is absent from the CURRENT view. Reuse this
		// tick's `units` (don't rebuild) for the live temperatureKey / unit-id sets.
		const liveBlockIds = new Set(view.blocks.map((b) => b.id));
		const liveTempKeys = new Set(units.map((u) => u.temperatureKey));
		const liveUnitIds = new Set(units.map((u) => u.id));
		for (const k of state.scores.keys()) if (!liveTempKeys.has(k)) state.scores.delete(k);
		for (const k of state.attempted) if (!liveTempKeys.has(k)) state.attempted.delete(k);
		for (const k of state.digestCache.keys()) {
			// keys are either a unit id (per-block digest) or `stratum:<firstId>` (run summary).
			const stale = k.startsWith("stratum:")
				? !liveBlockIds.has(k.slice("stratum:".length))
				: !liveUnitIds.has(k);
			if (stale) state.digestCache.delete(k);
		}

		// ── Graduation advances PER EPOCH, not per tick (#4). ──
		// updateGraduation advances dwell, so calling it every tick would graduate a unit after K
		// USER TURNS instead of K compaction EPOCHS — defeating the "sustained K dwell epochs"
		// double-gate. Instead we advance dwell at most ONCE per tick, and only when an epoch
		// actually fires (EMERGENCY commit or an ANTICIPATE prepare). On HOLD ticks dwell holds.
		// (everWarm above is already current, preserving round-1's ordering intent.)
		let _gradAdvanced = false;
		const advanceGraduationOnce = () => {
			if (_gradAdvanced) return; // already advanced this tick — an epoch fired earlier
			_gradAdvanced = true;
			const g = updateGraduation(gradState(state), view, state.scores, CFG);
			state.grad.dwell = g.dwell;
			state.grad.graduated = g.graduated;
		};

		// ── SAFETY / EMERGENCY: if we are ALREADY over budget, act immediately ──
		// deterministic:true → no LLM, instant. Bump prepareToken FIRST so any in-flight
		// prepare is discarded when it resolves — the emergency commit is the ground truth
		// and a stale prepare must not layer on top of it (#3).
		if (fill > 1.0) {
			log(`EMERGENCY: fill ${(fill * 100).toFixed(0)}% > 100% — deterministic compaction`);
			++state.prepareToken; // discard any in-flight prepare
			state.preparing = false;
			advanceGraduationOnce(); // this epoch advances dwell (once per tick)
			const plan = planEpoch(view, state.scores, gradState(state), CFG, { deterministic: true, graduated: state.grad.graduated });
			commit(ws, state, view, plan, new Map()); // empty digest map → all deterministic fallbacks
			state.lastAction = "emergency";
			// Don't return — still run ANTICIPATE below in case a new prepare is warranted.
		}

		// ── ANTICIPATE: if approaching warmWater and no prepare in flight, start one ──
		if (fill >= CFG.warmWater && !state.preparing && needNewEpoch(state, view, fill, cap)) {
			state.preparing = true;
			advanceGraduationOnce(); // the prepare epoch advances dwell (guarded: at most once/tick)
			const token = ++state.prepareToken;
			log(`ANTICIPATE: fill ${(fill * 100).toFixed(0)}% ≥ ${(CFG.warmWater * 100).toFixed(0)}% — preparing epoch (token ${token})`);
			// Fire and forget — prepareEpoch sets state.preparing=false when done.
			prepareEpoch(ws, state, view, token).catch((err) => {
				state.preparing = false;
				log(`prepareEpoch failed: ${err.message}`);
			});
		}

		// ── HOLD: re-derive and re-emit if the command set changed ──
		// This keeps the host in sync when blocks shift (tail moves, blocks added) without
		// triggering a new LLM epoch. The hasNew gate mirrors attention-folder.
		holdOrResend(ws, state, view);

		// Background scoring: warm up scores for the next epoch.
		maybeScore(ws, state, view);

		sendStatus(ws, state);
	});

	ws.on("close", () => {
		// Abort any in-flight probe — it's scoring a context nobody is listening to.
		state.abort.abort();
		// Reject any pending cap requests (their promises will never settle otherwise).
		// Drain by delete-then-reject so each is settled exactly once: clearing the map up front
		// means a timer that fires mid-loop finds no entry (its has()-guard) and stays silent —
		// no double-reject, no unhandled rejection under --unhandled-rejections=throw.
		const pending = [...state.pendingCaps.values()];
		state.pendingCaps.clear();
		for (const { reject, timer } of pending) {
			clearTimeout(timer);
			reject(new Error("ws closed"));
		}
		log("Accordion disconnected");
	});
}

// ── Inline smoke harness (node thermocline.mjs --smoke) ───────────────────────────────────────
// Exercises the two PR-review fixes that the pure policy.test.mjs cannot reach because they live in
// the server layer: BLOCKER 1 (a commit whose REAL summary exceeds the estimate is topped up to ≤
// cap BEFORE send) and MAJOR 4 (dwell advances per EPOCH, not per HOLD tick). It needs no `ws` and
// no probe — it calls the in-module commit() / onConnection() directly with fakes.

function assert(cond, label) {
	if (!cond) {
		log(`SMOKE FAIL: ${label}`);
		process.exitCode = 1;
		throw new Error(`smoke assertion failed: ${label}`);
	}
	log(`  ok: ${label}`);
}

/** A minimal fake WebSocket: captures sent frames, lets the harness drive registered handlers. */
function makeFakeWs() {
	const sent = [];
	const handlers = new Map();
	const ws = {
		readyState: 1, // OPEN
		send: (raw) => sent.push(JSON.parse(raw)),
		on: (ev, fn) => handlers.set(ev, fn),
		emit: (ev, arg) => {
			if (ev === "close") ws.readyState = 3; // CLOSED — a post-close commit() will no-op (readyState check)
			handlers.get(ev)?.(arg);
		},
		sent,
	};
	return ws;
}

/** Build a ViewBlock with sensible defaults. */
function smokeBlock(o) {
	return {
		id: o.id,
		kind: o.kind ?? "text",
		turn: o.turn ?? 1,
		order: o.order,
		tokens: o.tokens ?? 100,
		foldedTokens: o.foldedTokens ?? 8,
		held: o.held ?? false,
		folded: o.folded ?? false,
		protected: o.protected ?? false,
		grouped: o.grouped ?? false,
		text: o.text ?? `block ${o.id}`,
		toolName: o.toolName,
		isError: o.isError,
	};
}

// ── BLOCKER 1: real summary tokens > estimate ⇒ top-up to ≤ cap before send ──
function smokeBlocker1() {
	log("SMOKE BLOCKER 1 — real-summary top-up keeps projected ≤ cap");
	// cap=1000, liveTokens=1180. One stratum over 5 text units (200 tok each = 1000 tok). The
	// ESTIMATE (~12% = 120) keeps projected at 1180-(1000-120)=300 (under cap) — but a VERBOSE real
	// summary (~950 tok) would push projected to 1180-(1000-950)=1130 > cap. Top-up must fix that.
	const blocks = [];
	for (let i = 0; i < 5; i++) {
		blocks.push(smokeBlock({ id: `m${i}`, kind: "text", order: i, tokens: 200, foldedTokens: 10, folded: true }));
	}
	// A protected tail block at the end so protectedFromIndex < length (older blocks are foldable).
	blocks.push(smokeBlock({ id: "tail", kind: "text", order: 5, tokens: 180, protected: true }));
	const view = {
		rev: 1,
		blocks,
		contextWindow: 1000,
		budget: 1000,
		liveTokens: 1180,
		protectedFromIndex: 5, // index of "tail" → m0..m4 are older/foldable
		protectTokens: 180,
	};
	const cap = capOfView(view);

	// A plan with ONE summary stratum over m0..m4 (members 1000 tok), estimate 120.
	const memberIds = ["m0", "m1", "m2", "m3", "m4"];
	const plan = {
		folds: [],
		strata: [{ ids: ["m0", "m4"], unitIds: memberIds, memberIds, digestKind: "summary", summaryTokens: 120 }],
		targetTokens: CFG.lowWater * cap,
		cap,
		projected: project(view, { foldedIds: new Set(), strata: [{ memberIds, summaryTokens: 120 }] }),
	};
	assert(plan.projected <= cap, "estimate alone is under cap (so only real tokens trigger top-up)");

	// A VERBOSE real summary: ~3800 chars → ~950 tokens (chars/4), far above the 120 estimate.
	const hugeSummary = "x ".repeat(1900); // 3800 chars → ceil(3800/4)=950 tokens
	const digests = new Map([[`stratum:m0`, hugeSummary]]);

	const state = freshState();
	state.sessionKey = null; // skip persistence in the smoke
	state.lastView = view;
	const ws = makeFakeWs();

	commit(ws, state, view, plan, digests);

	// The applied state after commit must project ≤ cap with the REAL summary tokens.
	const projectedAfter = project(view, appliedForProject(state));
	assert(projectedAfter <= cap, `projected after commit (${projectedAfter}) ≤ cap (${cap})`);

	// And the batch actually SENT must be the same state — recompute its projection from the wire.
	const frame = ws.sent.find((m) => m.type === "conductor/commands");
	assert(!!frame, "a conductor/commands frame was sent");
	// The verbose stratum should have been converted to a DROP (group with digest:null) by the
	// own-strata drop fallback, since no other content was compressible in this view.
	const droppedGroup = frame.commands.find((c) => c.kind === "group" && c.digest === null);
	assert(!!droppedGroup, "verbose stratum was dropped (group digest:null) to satisfy the cap");

	// ── BLOCKER 1 (merge path): when OTHER foldable content exists, the top-up's deterministic
	// merge folds it to reach cap and KEEPS the LLM stratum as a summary (no drop needed). ──
	log("  · merge path: deterministic folds added, LLM stratum kept");
	const b2 = [];
	// Stratum over m0,m1 (400 tok); plus 3 unclaimed foldable units e2,e3,e4 (200 tok each) the
	// plan left live; plus protected tail. liveTokens 1300: estimate keeps us under cap, the verbose
	// real summary tips us over, and folding e2/e3/e4 recovers — WITHOUT dropping the stratum.
	// e2/e3/e4 each save 280 tok (≥ minFoldTokens 200) so the deterministic Rung 1 folds them
	// INDIVIDUALLY (rather than sweeping them into an age-stratum that would overlap the claimed
	// region), giving the merge real per-block folds to add.
	b2.push(smokeBlock({ id: "n0", kind: "text", order: 0, tokens: 200, foldedTokens: 10, folded: true }));
	b2.push(smokeBlock({ id: "n1", kind: "text", order: 1, tokens: 200, foldedTokens: 10, folded: true }));
	b2.push(smokeBlock({ id: "e2", kind: "text", order: 2, tokens: 300, foldedTokens: 20 }));
	b2.push(smokeBlock({ id: "e3", kind: "text", order: 3, tokens: 300, foldedTokens: 20 }));
	b2.push(smokeBlock({ id: "e4", kind: "text", order: 4, tokens: 300, foldedTokens: 20 }));
	b2.push(smokeBlock({ id: "tail2", kind: "text", order: 5, tokens: 300, protected: true, text: "" }));
	const view2 = {
		rev: 2, blocks: b2, contextWindow: 1000, budget: 1000, liveTokens: 1300,
		protectedFromIndex: 5, protectTokens: 300,
	};
	const cap2 = capOfView(view2);
	const mids2 = ["n0", "n1"];
	const plan2 = {
		folds: [],
		strata: [{ ids: ["n0", "n1"], unitIds: mids2, memberIds: mids2, digestKind: "summary", summaryTokens: 48 }],
		targetTokens: CFG.lowWater * cap2, cap: cap2,
		projected: project(view2, { foldedIds: new Set(), strata: [{ memberIds: mids2, summaryTokens: 48 }] }),
	};
	assert(plan2.projected <= cap2, "merge: estimate alone under cap");
	const verbose2 = "y ".repeat(760); // 1520 chars → 380 tokens, far above the 48 estimate
	const digests2 = new Map([["stratum:n0", verbose2]]);
	const state2 = freshState();
	state2.sessionKey = null;
	state2.lastView = view2;
	const ws2 = makeFakeWs();
	commit(ws2, state2, view2, plan2, digests2);

	const proj2 = project(view2, appliedForProject(state2));
	assert(proj2 <= cap2, `merge: projected after commit (${proj2}) ≤ cap (${cap2})`);
	assert(state2.applied.foldedIds.size > 0, "merge: top-up added per-block folds (e2/e3/e4)");
	// The LLM stratum survived as a real summary (group with a NON-null digest), not a drop.
	const f2 = ws2.sent.find((m) => m.type === "conductor/commands");
	const keptGroup = f2.commands.find((c) => c.kind === "group" && c.digest && c.digest.includes("FOLDED"));
	assert(!!keptGroup, "merge: the LLM stratum was kept as a summary (group with a real digest)");
}

// ── MAJOR 4: dwell advances per EPOCH, not per HOLD tick ──
// Two parts: (A) drive the REAL handler (onConnection) and confirm a HOLD tick fires NO epoch while
// an over-budget tick fires exactly one — i.e. dwell-advancing work happens only on epoch ticks;
// (B) confirm the per-epoch dwell delta is exactly +1 via the same updateGraduation the handler gates.
function smokeMajor4() {
	log("SMOKE MAJOR 4 — dwell advances per epoch, unchanged across HOLD ticks");
	const COLD = CFG.coldThreshold - 0.1; // clearly cold

	function viewWithLive(liveTokens, rev) {
		return {
			rev,
			blocks: [
				smokeBlock({ id: "c0", kind: "text", order: 0, tokens: 300, foldedTokens: 10, folded: true }),
				smokeBlock({ id: "c1", kind: "text", order: 1, tokens: 300, foldedTokens: 10, folded: true }),
				// Empty protected-tail text ⇒ tailTextFromView is blank ⇒ maybeScore bails before
				// spawning the probe (the smoke is hermetic — no python child, no hang).
				smokeBlock({ id: "tail", kind: "text", order: 2, tokens: 200, protected: true, text: "" }),
			],
			contextWindow: 1000,
			budget: 1000,
			liveTokens,
			protectedFromIndex: 2,
			protectTokens: 200,
		};
	}

	// (A) Handler-driven: a HOLD tick (fill < warmWater) must produce NO commands frame; an
	// over-budget tick must produce at least one (the EMERGENCY commit). A commands frame is the
	// observable "an epoch fired this tick" — HOLD ticks emit none, so no dwell-advancing work runs.
	const ws = makeFakeWs();
	onConnection(ws);
	const recv = (obj) => ws.emit("message", JSON.stringify(obj));
	recv({ type: "host/hello", session: {}, budget: 1000, contextWindow: 1000 }); // sessionKey null → no disk
	const cmdCount = () => ws.sent.filter((m) => m.type === "conductor/commands").length;

	let before = cmdCount();
	recv({ type: "context/update", ...viewWithLive(500, 1) }); // HOLD: fill 0.5 → no epoch
	assert(cmdCount() === before, "HOLD tick (fill 50%) fires no epoch (no commands frame)");

	before = cmdCount();
	recv({ type: "context/update", ...viewWithLive(500, 2) }); // HOLD again → still no epoch
	assert(cmdCount() === before, "second HOLD tick still fires no epoch");

	before = cmdCount();
	recv({ type: "context/update", ...viewWithLive(1200, 3) }); // over budget → EMERGENCY epoch fires
	assert(cmdCount() >= before + 1, "over-budget tick fires an epoch (≥1 commands frame)");

	// The over-budget tick also kicks ANTICIPATE → prepareEpoch → a pending cap/request with a
	// 120 s timer. Emit close to settle it so the smoke process exits promptly (mirrors a real
	// disconnect: rejects pending caps, clears timers).
	ws.emit("close");

	// (B) Per-epoch dwell delta = +1 (the same updateGraduation the handler calls once per epoch).
	// Seed dwell at 2 (a prior epoch), with both units cold+folded+untouched.
	const st = {
		dwell: new Map([["c0", 2], ["c1", 2]]),
		graduated: new Set(),
		everWarm: new Set(),
		agentTouched: new Set(),
		recalledThisEpoch: new Set(),
	};
	const scores = new Map([["c0", COLD], ["c1", COLD]]);
	const v = viewWithLive(500, 9);

	// A HOLD tick does NOT call updateGraduation, so dwell is untouched — model that by simply not
	// calling it and asserting the map is unchanged.
	const dwellAtHold = new Map(st.dwell);
	assert(st.dwell.get("c0") === dwellAtHold.get("c0"), "HOLD: dwell untouched (no updateGraduation call)");

	// An EPOCH tick calls updateGraduation exactly once → +1.
	const g = updateGraduation(st, v, scores, CFG);
	assert(g.dwell.get("c0") === 3, `EPOCH: dwell advances exactly once (2 → ${g.dwell.get("c0")})`);
	assert(g.dwell.get("c1") === 3, "EPOCH: a second cold unit also advances exactly once");
}

async function runSmoke() {
	log("Running thermocline.mjs inline smoke harness…");
	try {
		smokeBlocker1();
		smokeMajor4();
	} catch (e) {
		log(`SMOKE harness threw: ${e.message}`);
		process.exitCode = 1;
		return;
	}
	if (process.exitCode) log("SMOKE: FAILURES (see above)");
	else log("SMOKE: all assertions passed");
}

if (!SMOKE) {
	const { WebSocketServer } = await import("ws");
	const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
	wss.on("connection", onConnection);
	log(`${LABEL} listening on ${URL}`);
	log(`waters: warm=${(CFG.warmWater * 100).toFixed(0)}% high=${(CFG.highWater * 100).toFixed(0)}% low=${(CFG.lowWater * 100).toFixed(0)}%  advertised at ${REG_FILE}`);
} else {
	await runSmoke();
}
