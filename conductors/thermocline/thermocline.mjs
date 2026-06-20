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

import { WebSocketServer } from "ws";
import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync } from "node:fs";
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

// ── Persistence: deep-zone strata + dwell survive reconnect ──
// Only strata (with their actual summary TEXT) and dwell/everWarm are worth saving.
// Folds re-derive from scores on reconnect; only the compacted zone is irreversible.
const PERSIST_DIR = join(process.env.ACCORDION_HOME || homedir(), ".accordion", "conductors");

/** Deterministic key for a session — used as part of the filename so each session keeps its own deep zone. */
function sessionKey(session) {
	const raw = `${session.title}|${session.model}|${session.cwd}`;
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
	// Best-effort, async (we don't await this — an occasional missed write is fine).
	try {
		mkdirSync(PERSIST_DIR, { recursive: true });
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
		writeFileSync(tmp, JSON.stringify(data, null, 2));
		renameSync(tmp, p);
	} catch (e) {
		log(`persist failed (non-fatal): ${e.message}`);
	}
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
	if (fill >= CFG.highWater * cap) return true;
	return false;
}

// ── Background scoring trigger ──
// Mirrors attention-folder's maybeScore exactly. Fires when approaching warmWater.
function maybeScore(ws, state, view) {
	const units = buildUnits(view.blocks);
	// Score candidates = units with a temperatureKey not yet attempted.
	const cands = units.filter(
		(u) => !u.protected && !u.held && !state.attempted.has(u.temperatureKey),
	);
	const fill = state.lastFill;
	const cap = Math.min(view.budget, view.contextWindow ?? view.budget);

	if (fill < CFG.warmWater || state.scoringInFlight || !(state.rescoreNeeded || cands.some((u) => !state.attempted.has(u.temperatureKey)))) return;
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
			for (const id of ids) state.attempted.add(id);
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

// ── commit: send conductor/commands and update internal state ──
// This is the ATOMIC COMMIT point. After this, the host holds the new state.
function commit(ws, state, view, plan, digests) {
	const cmds = emitCommands(plan, digests, view);
	const sig = commandSig(cmds);

	// Update our applied state from the plan.
	const newFoldedIds = new Set(plan.folds.flatMap((f) => f.ids));
	const newStrata = plan.strata.map((s) => {
		const key = `stratum:${s.ids[0]}`;
		const summary = digests?.get(key) ?? null;
		return {
			firstId: s.ids[0],
			lastId: s.ids[1],
			unitIds: s.unitIds,
			memberIds: s.memberIds,
			summary,
			summaryTokens: summary != null ? Math.ceil(summary.length / 4) : s.summaryTokens,
		};
	});

	state.applied = {
		plan,
		foldedIds: newFoldedIds,
		strata: newStrata,
		sig,
	};

	// Track pending confirmation (mirrors attention-folder).
	state.pendingRev = view.rev ?? -1;
	state.pendingSet = new Set(newFoldedIds);

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
	log(`COMMIT: ${plan.folds.length} folds · ${plan.strata.length} strata → projected ~${(plan.projected / Math.max(1, plan.cap) * 100).toFixed(0)}% full`);
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
	state.pendingSet = new Set(state.applied.foldedIds);
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
	if (state.prepareToken !== token) {
		log(`prepare ${token} superseded — discarding`);
		state.preparing = false;
		return;
	}

	// Cache whatever came back (null = timed-out/rejected → deterministic fallback fires in emitCommands).
	for (const r of results) {
		if (r.status === "fulfilled" && r.value) {
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
			const saved = loadPersistedState(state.sessionKey);
			if (saved) {
				// Restore strata (with their summary texts) and dwell.
				if (Array.isArray(saved.strata) && saved.strata.length) {
					state.applied.strata = saved.strata;
					// Re-populate the digest cache from saved summaries.
					for (const s of saved.strata) {
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
				// If a prepare is in flight that would compact any of these ids, discard it.
				if (state.preparing && ids.length) {
					const units = state.lastView ? buildUnits(state.lastView.blocks) : [];
					const touchedUnits = new Set(
						units.filter((u) => u.ids.some((bid) => ids.includes(bid))).map((u) => u.id),
					);
					// If any of the prepare's planned folds/strata touch an agent-unfolded unit,
					// bump the token to discard the stale prepare.
					if (state.applied.plan) {
						const planUnits = new Set([
							...(state.applied.plan.folds ?? []).map((f) => f.unitId),
							...(state.applied.plan.strata ?? []).flatMap((s) => s.unitIds),
						]);
						if ([...touchedUnits].some((uid) => planUnits.has(uid))) {
							log(`agentUnfold conflicts with in-flight prepare — discarding`);
							++state.prepareToken;
							state.preparing = false;
						}
					}
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

		// ── Validate restored strata on the first real view (#6) ──
		// Drop any stratum whose firstId/lastId/memberIds no longer exist in the view (stale
		// session — a group([firstId,lastId]) over vanished ids would be clamped as invalid-group).
		if (state._restoredPendingValidation) {
			state._restoredPendingValidation = false;
			const liveIds = new Set(view.blocks.map((b) => b.id));
			const validStrata = state.applied.strata.filter(
				(s) => liveIds.has(s.firstId) && liveIds.has(s.lastId),
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

		// ── Update graduation state ──
		// Fold result into grad.everWarm: any unit that is currently NOT cold gets everWarm'd.
		const gResult = updateGraduation(gradState(state), view, state.scores, CFG);
		// Track newly-hot units (scored ≥ coldThreshold this turn) as everWarm.
		const units = buildUnits(view.blocks);
		for (const u of units) {
			const temp = state.scores.get(u.temperatureKey);
			if (temp !== undefined && temp >= CFG.coldThreshold) {
				state.grad.everWarm.add(u.id);
			}
		}
		state.grad.dwell = gResult.dwell;
		state.grad.graduated = gResult.graduated;

		// ── SAFETY / EMERGENCY: if we are ALREADY over budget, act immediately ──
		// deterministic:true → no LLM, instant. Bump prepareToken FIRST so any in-flight
		// prepare is discarded when it resolves — the emergency commit is the ground truth
		// and a stale prepare must not layer on top of it (#3).
		if (fill > 1.0) {
			log(`EMERGENCY: fill ${(fill * 100).toFixed(0)}% > 100% — deterministic compaction`);
			++state.prepareToken; // discard any in-flight prepare
			state.preparing = false;
			const plan = planEpoch(view, state.scores, gradState(state), CFG, { deterministic: true, graduated: state.grad.graduated });
			commit(ws, state, view, plan, new Map()); // empty digest map → all deterministic fallbacks
			state.lastAction = "emergency";
			// Don't return — still run ANTICIPATE below in case a new prepare is warranted.
		}

		// ── ANTICIPATE: if approaching warmWater and no prepare in flight, start one ──
		if (fill >= CFG.warmWater && !state.preparing && needNewEpoch(state, view, fill, cap)) {
			state.preparing = true;
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
		for (const [, { reject, timer }] of state.pendingCaps) {
			clearTimeout(timer);
			reject(new Error("ws closed"));
		}
		state.pendingCaps.clear();
		log("Accordion disconnected");
	});
});

log(`${LABEL} listening on ${URL}`);
log(`waters: warm=${(CFG.warmWater * 100).toFixed(0)}% high=${(CFG.highWater * 100).toFixed(0)}% low=${(CFG.lowWater * 100).toFixed(0)}%  advertised at ${REG_FILE}`);
