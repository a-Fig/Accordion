// policy.mjs — the PURE policy core of the Thermocline conductor (no I/O, no WS, no probe).
//
// Thermocline is the synthesis of two parents (see docs/thermocline-design.html):
//   • attention-folder — a Qwen-0.5B probe scores each block's "temperature" (how much the
//     working tail attends back to it). Cold = unattended = safe to compress.
//   • compaction-naive — real LLM prose summaries via host.complete, user messages verbatim.
//
// …combined under a HARD BUDGET INVARIANT, in deliberate double-buffered EPOCHS. The whole
// product commitment, above relevance and above cache: the agent is NEVER over budget. That is
// guaranteed by a budget LADDER (planEpoch) whose last rung is a hard delete that always frees
// tokens, so the planner provably terminates at "protected tail + one minimal stratum".
//
// This module owns ONE thing: given a view, the probe's temperatures (passed IN as plain data),
// and prior dwell/strata state, decide WHICH blocks to compress and HOW DEEP — and produce the
// Command[] for it. It decides nothing about the network, the GPU, or the LLM: the scores and
// the LLM summary texts are handed to its functions as data; the conductor server
// (thermocline.mjs) owns the WebSocket, the probe child, host.complete, and the applied-state
// memory. Everything here is pure: a function of its arguments, no Date.now(), no mutation of
// inputs. That is what makes it testable with bare `node --test`.
//
// The fidelity ladder a unit can sit at:
//   Full (live) → Trim (L1, deterministic extractive excerpt) → Digest (L2, LLM 1–3 lines)
//   → Stratum (L3, a contiguous cold RUN summarized holistically into one group)
//   → drop (L4 floor, group(digest:null) — the hard delete that backstops the invariant).
//
// RECOVERABILITY. Every fold/stratum digest Thermocline emits is prefixed with the engine's
// `{#<code> FOLDED}` tag (code = foldCode(id), copied byte-for-byte from engine/digest.ts), so
// the agent can `unfold`/`recall` an LLM-summarized block exactly as a normal fold. Strata are
// recall-able by construction: recall returns members' ORIGINAL text regardless of the group
// summary.
//
// Vocabulary used throughout:
//   UNIT  — the atomic compression target. A tool_call + its tool_result (same callId) are ONE
//           unit (they move together everywhere, so a fold/group never orphans a result);
//           every other block is its own unit.
//   RUN   — a maximal contiguous sequence of graduated-cold units, split by "buoy" units
//           (hot / held / protected / grouped). A run that clears the gates becomes a stratum.
//   APPLIED-STATE — the explicit { folded, strata } sets the host is rendering. project() reads
//           ONLY these sets (never the view's per-block flags) so token accounting never
//           double-counts an already-folded block or infers a fold the conductor didn't make.

/** Kinds whose CONTENT may be substituted by a digest on the agent's wire. A tool_call is never
 *  folded (it would orphan its result) and a user block (intent) is never folded — mirrors the
 *  engine's `FOLDABLE_KINDS` and the host's `not-foldable` clamp. The single foldability gate. */
export const FOLDABLE_KINDS = new Set(["text", "thinking", "tool_result"]);

/** Fallback compression order when a temperature is unavailable: lowest-value kind first.
 *  Identical to the built-in/attention-folder FOLD_RANK so degradation lands on known-good order. */
const FOLD_RANK = { tool_result: 0, thinking: 1, text: 2, tool_call: 3, user: 4 };

/**
 * Tuning. Waters are fractions of the cap (= min(budget, contextWindow)); the conductor server
 * reads warmWater/highWater for the PREPARE/EMERGENCY timing, this module reads lowWater as the
 * epoch's fold-down target and ceilingFrac as the deep-zone ceiling.
 *
 *   coldThreshold — temperatures are normalized 0..1 (higher = hotter / more attended). 0.35 is
 *     a deliberately conservative cold line: a unit must be clearly UN-attended (bottom third)
 *     before it is even eligible to deepen, and the graduation gate re-checks the same line.
 *     Picked low on purpose — the cost of leaving a warm-ish block at full fidelity is a few
 *     tokens; the cost of compressing a still-needed block is a quality regression, so the bar
 *     to compress is set high (temperature low).
 */
export const DEFAULT_CFG = {
	highWater: 0.9, // server: a planned epoch must have finished before this
	lowWater: 0.7, // planEpoch composes moves until project(plan) ≤ lowWater·cap
	warmWater: 0.8, // server: begin preparing the next epoch around here
	ceilingFrac: 0.2, // Σ stratum tokens may not exceed this fraction of cap
	coldThreshold: 0.35, // temperature below which a unit counts as cold
	K: 3, // dwell epochs a unit must stay cold+untouched before it graduates to a stratum
	minRunUnits: 3, // a run shorter than this stays merely folded, never becomes a stratum
	minFoldTokens: 200, // a deepen whose savings is below this is not worth a cache slot
};

// ── recoverable fold tags (copied verbatim from app/src/lib/engine/digest.ts) ──────────────────

/**
 * Short, stable handle for a block, derived purely from its durable id (FNV-1a 32-bit → unsigned
 * → base36, last 6 chars). Stateless and deterministic so the engine, the live link, this
 * conductor, and the agent's `unfold`/`recall` resolution never drift. COPIED EXACTLY from
 * engine/digest.ts — if that algorithm ever changes, change it here in lockstep or the agent's
 * codes stop resolving.
 */
export function foldCode(id) {
	let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}

/** The folded-block marker the agent sees and passes back to `unfold`/`recall`, e.g. `{#3f9a2c FOLDED}`. */
export function foldTag(id) {
	return `{#${foldCode(id)} FOLDED}`;
}

// ── units: tool-pair atomicity ──────────────────────────────────────────────────────────────

/**
 * Group blocks into UNITS. A `tool_call` and the `tool_result` that shares its `callId` become
 * ONE atomic unit (they move together everywhere, so no fold/group ever orphans a result); every
 * other block is its own unit. Order is preserved — a unit's `order` is its first block's.
 *
 * A unit carries:
 *   id            — the unit's stable id = its FIRST block's id (so foldCode(unit.id) is stable).
 *   ids           — its block ids in order.
 *   kinds         — its block kinds in order.
 *   blocks        — the ViewBlocks themselves (so prompt builders read .text without a re-lookup).
 *   tokens        — Σ full tokens of the members.
 *   foldedTokens  — Σ folded tokens of the members.
 *   order         — the first member's order (units are emitted in conversation order).
 *   turn          — the first member's turn.
 *   foldable      — true iff EVERY member is a foldable kind (a pure tool_call+tool_result pair is
 *                   NOT foldable as a unit — the tool_call can't fold — so such a pair can only
 *                   ever join a stratum group, never a per-block fold).
 *   temperatureKey — the id to score this unit's temperature against: the RESULT block's id for a
 *                   tool pair (the result is what decays — "what it saw"), else the block's own id.
 *   held / protected / grouped — true if ANY member carries the flag (the whole unit is gated).
 *
 * @param {ViewBlock[]} blocks - the view's blocks, in conversation order.
 * @returns {Unit[]} units in conversation order.
 */
export function buildUnits(blocks) {
	// Index tool_result blocks by callId so a tool_call can pull in its partner.
	const resultByCall = new Map();
	for (const b of blocks) {
		if (b.kind === "tool_result" && b.callId) resultByCall.set(b.callId, b);
	}
	const pairedResultIds = new Set();
	for (const b of blocks) {
		if (b.kind === "tool_call" && b.callId && resultByCall.has(b.callId)) {
			pairedResultIds.add(resultByCall.get(b.callId).id);
		}
	}

	const units = [];
	for (const b of blocks) {
		// A tool_result already swallowed by its call's unit is skipped (it was emitted with the call).
		if (b.kind === "tool_result" && pairedResultIds.has(b.id)) continue;

		let members;
		if (b.kind === "tool_call" && b.callId && resultByCall.has(b.callId)) {
			members = [b, resultByCall.get(b.callId)];
		} else {
			members = [b];
		}
		units.push(makeUnit(members));
	}
	return units;
}

/** Assemble a Unit from its member blocks (≥1, in order). */
function makeUnit(members) {
	const first = members[0];
	const result = members.find((m) => m.kind === "tool_result");
	let tokens = 0;
	let foldedTokens = 0;
	let held = false;
	let protectedFlag = false;
	let grouped = false;
	let foldable = true;
	for (const m of members) {
		tokens += m.tokens;
		foldedTokens += m.foldedTokens;
		held = held || m.held;
		protectedFlag = protectedFlag || m.protected;
		grouped = grouped || m.grouped;
		if (!FOLDABLE_KINDS.has(m.kind)) foldable = false;
	}
	return {
		id: first.id,
		ids: members.map((m) => m.id),
		kinds: members.map((m) => m.kind),
		blocks: members,
		tokens,
		foldedTokens,
		order: first.order,
		turn: first.turn,
		foldable,
		temperatureKey: result ? result.id : first.id,
		held,
		protected: protectedFlag,
		grouped,
	};
}

// ── projection: tokens under an explicit applied state ──────────────────────────────────────

/**
 * The rendered token cost of the context if `applied` were the state. EXPLICIT-set arithmetic
 * (never inferred from view flags), so we never double-count: a block is discounted iff WE chose
 * to fold it or sweep it into a stratum.
 *
 *   project = liveTokens
 *           − Σ folds  ( block.tokens − block.foldedTokens )      // each folded unit's saving
 *           − Σ strata ( Σ member.tokens − stratum.summaryTokens ) // each stratum's net saving
 *
 * `applied` shape:
 *   { foldedIds: Set<string>,            // block ids currently folded to a per-block digest
 *     strata: [{ memberIds: string[], summaryTokens: number }, …] }  // collapsed runs
 *
 * The two sets MUST be disjoint (a block is either folded OR in a stratum, never both) — the
 * caller (planEpoch) keeps them so. `liveTokens` is the host's raw baseline (it clears our folds
 * each pass), so this re-derives our saving from scratch every call; idempotent and pure.
 *
 * @param {ConductorView} view
 * @param {{foldedIds: Set<string>, strata: {memberIds: string[], summaryTokens: number}[]}} applied
 * @returns {number} projected rendered tokens (never below 0).
 */
export function project(view, applied) {
	const byId = new Map(view.blocks.map((b) => [b.id, b]));
	let t = view.liveTokens;

	for (const id of applied.foldedIds ?? new Set()) {
		const b = byId.get(id);
		if (b) t -= Math.max(0, b.tokens - b.foldedTokens);
	}

	for (const s of applied.strata ?? []) {
		let members = 0;
		for (const id of s.memberIds) {
			const b = byId.get(id);
			if (b) members += b.tokens;
		}
		t -= Math.max(0, members - s.summaryTokens);
	}

	return Math.max(0, t);
}

// ── graduation: the double gate (pure) ──────────────────────────────────────────────────────

/**
 * Advance the per-unit dwell clocks and report which units are currently GRADUATED (eligible to
 * sink into a stratum). A unit graduates only when BOTH gates hold, sustained for K epochs:
 *
 *   ① probe temperature is cold (< cfg.coldThreshold), re-scored fresh this epoch, AND
 *   ② the agent did NOT recall/unfold it while it sat folded (a behavioral veto: the agent had
 *      the digest + the recovery tag and chose not to pull the content back).
 *
 * The threshold is K epochs, or 2·K if the unit is in `state.everWarm` (it was hot before — a
 * unit that ran warm earns a longer probation before we trust it cold). ANY re-warm resets the
 * unit's dwell to 0 and clears graduation: a fresh-hot temperature, an `agentTouched` id (recall
 * or unfold this epoch), or a human `held`. A unit not currently folded also can't graduate
 * (gate ② is about behavior WHILE folded) — its dwell holds at 0 until it is first folded.
 *
 * Pure: returns a NEW dwell map and a NEW graduated set; never mutates `state`.
 *
 * @param {ThermoState} state - { dwell: Map<id,number>, graduated: Set<id>, everWarm: Set<id>,
 *                                agentTouched: Set<id>, recalledThisEpoch: Set<id>, … }.
 *                                agentTouched ∪ recalledThisEpoch are the ids the agent pulled
 *                                back this epoch (the server fills these from host events).
 * @param {ConductorView} view
 * @param {Map<string,number>} scores - unit.temperatureKey → temperature (0..1, higher = hotter).
 * @param {object} cfg
 * @returns {{dwell: Map<string,number>, graduated: Set<string>}}
 */
export function updateGraduation(state, view, scores, cfg = DEFAULT_CFG) {
	const units = buildUnits(view.blocks);
	const prevDwell = state.dwell ?? new Map();
	const everWarm = state.everWarm ?? new Set();
	const touched = unionSet(state.agentTouched, state.recalledThisEpoch);

	const dwell = new Map();
	const graduated = new Set();

	for (const u of units) {
		const temp = scores.get(u.temperatureKey);
		const cold = temp !== undefined && temp < cfg.coldThreshold;
		const folded = isUnitFolded(u); // graduation only progresses while the unit is folded
		// FIX 8: check ANY member id, not just u.id (the first-block id). The server records raw
		// block ids from msg.ids; a recall of a non-first member (e.g. the tool_result of a pair)
		// would miss the veto if we only checked u.id.
		const reWarm = !cold || u.ids.some((id) => touched.has(id)) || u.held;

		if (reWarm || !folded || u.protected) {
			// Any re-warm (or not-yet-folded / protected) resets the clock and clears graduation.
			dwell.set(u.id, 0);
			continue;
		}

		// Both gates hold this epoch: advance the dwell clock.
		const next = (prevDwell.get(u.id) ?? 0) + 1;
		dwell.set(u.id, next);
		const need = everWarm.has(u.id) ? 2 * cfg.K : cfg.K;
		if (next >= need) graduated.add(u.id);
	}

	return { dwell, graduated };
}

/** A unit is "folded" for graduation purposes iff EVERY member renders folded in the view. */
function isUnitFolded(u) {
	return u.blocks.every((b) => b.folded);
}

// ── runs & sedimentation: graduated-cold → strata ───────────────────────────────────────────

/**
 * Partition graduated units into STRATA runs. A run is a MAXIMAL contiguous sequence of
 * graduated units (`graduated` from updateGraduation) bounded by "buoy" units that split runs:
 * a unit that is hot (temperature ≥ coldThreshold or unscored), held, protected, or grouped. A
 * run is kept only if it has ≥ cfg.minRunUnits units AND lies entirely OLDER than
 * protectedFromIndex (snapped to whole units; tool-pairs are already whole units). Shorter runs
 * stay merely folded — they never sink to a stratum.
 *
 * Each stratum is { unitIds, memberIds (all member block ids, in order), firstId, lastId }. The
 * group command will be group([firstId, lastId]); the host snaps that range outward to whole
 * messages and pair-balances, but because every unit is already a whole message / whole tool-pair
 * and the run never crosses protectedFromIndex, the snap is a no-op here.
 *
 * @param {ConductorView} view
 * @param {Map<string,number>} scores - temperatureKey → temperature.
 * @param {Set<string>} graduated - unit ids that cleared the double gate (from updateGraduation).
 * @param {object} cfg
 * @param {Unit[]} [units] - pre-built units array (from buildUnits); if omitted, built internally.
 * @returns {{unitIds: string[], memberIds: string[], firstId: string, lastId: string}[]}
 */
export function sedimentRuns(view, scores, graduated, cfg = DEFAULT_CFG, units = null) {
	if (!units) units = buildUnits(view.blocks);
	const pfi = Math.min(view.protectedFromIndex, view.blocks.length);
	// COUPLING: `order` must track the block-array index — this tail boundary reads the .order of the
	// block AT index pfi to split runs, so a unit's order field has to be monotone with its position
	// in view.blocks (review §1). buildUnits preserves this (a unit's order = its first block's).
	const protectedFrom = view.blocks[pfi]?.order ?? Infinity;

	const runs = [];
	let cur = [];
	const flush = () => {
		if (cur.length >= cfg.minRunUnits) {
			const memberIds = cur.flatMap((u) => u.ids);
			runs.push({
				unitIds: cur.map((u) => u.id),
				memberIds,
				firstId: memberIds[0],
				lastId: memberIds[memberIds.length - 1],
			});
		}
		cur = [];
	};

	for (const u of units) {
		const olderThanTail = u.order < protectedFrom;
		const isGraduatedCold = graduated.has(u.id) && olderThanTail;
		// A buoy (hot / held / protected / grouped / not-graduated / in-tail) breaks the run.
		if (isGraduatedCold) cur.push(u);
		else flush();
	}
	flush();
	return runs;
}

/**
 * Age-based last-resort runs — same structural constraints as sedimentRuns (maximal contiguous,
 * ≥ cfg.minRunUnits units, bounded by held/protected/grouped buoys, entirely older than
 * protectedFromIndex) but WITHOUT requiring graduation. Used by planEpoch's Rung 3.5 when the
 * probe is absent or attention-driven compaction was insufficient.
 *
 * A unit is eligible for an age-based run iff:
 *   - It is older than the protected tail (u.order < protectedFrom).
 *   - It is NOT held, protected, or grouped (same buoy conditions as sedimentRuns).
 *   - It is NOT already claimed by a prior stratum or fold (passed in as `claimed`).
 *   - It has SOME foldable content (foldable=true) OR is part of a tool pair that a group command
 *     can absorb (the group command covers ALL kinds, not just foldable ones, so even a
 *     tool_call+tool_result pair can be part of a stratum).
 *
 * Returns runs in conversation order (oldest first), same shape as sedimentRuns.
 *
 * @param {Unit[]} units - all units in conversation order (built by buildUnits).
 * @param {ConductorView} view
 * @param {Set<string>} claimed - unit ids already absorbed by prior strata or folds.
 * @param {object} cfg
 * @param {number} [minUnits=cfg.minRunUnits] - minimum run length to keep. Rung 3.5 passes the
 *        default (cfg.minRunUnits); the HARD-CAP FLOOR passes 1 so even a single uncompressed
 *        tool-pair can be force-grouped once over the hard cap.
 * @returns {{unitIds: string[], memberIds: string[], firstId: string, lastId: string}[]}
 */
function ageBasedRuns(units, view, claimed, cfg, minUnits = cfg.minRunUnits) {
	const pfi = Math.min(view.protectedFromIndex, view.blocks.length);
	// COUPLING: `order` must track the block-array index — this tail boundary reads the .order of the
	// block AT index pfi to split runs, so a unit's order field has to be monotone with its position
	// in view.blocks (review §1). buildUnits preserves this (a unit's order = its first block's).
	const protectedFrom = view.blocks[pfi]?.order ?? Infinity;

	const runs = [];
	let cur = [];
	const flush = () => {
		if (cur.length >= minUnits) {
			const memberIds = cur.flatMap((u) => u.ids);
			runs.push({
				unitIds: cur.map((u) => u.id),
				memberIds,
				firstId: memberIds[0],
				lastId: memberIds[memberIds.length - 1],
			});
		}
		cur = [];
	};

	for (const u of units) {
		const olderThanTail = u.order < protectedFrom;
		const notClaimed = !claimed.has(u.id);
		const eligible = olderThanTail && notClaimed && !u.held && !u.protected && !u.grouped;
		if (eligible) cur.push(u);
		else flush();
	}
	flush();
	return runs;
}

// ── planEpoch: the budget ladder ────────────────────────────────────────────────────────────

/**
 * Plan one epoch: the COMPLETE next compression state, composed cheapest-move-first until the
 * projection fits under lowWater·cap (or it bottoms out). This is the §01 ladder:
 *
 *   (1) DEEPEN the coldest ELIGIBLE unit to a per-block fold. Eligible = foldable kind, !held,
 *       !protected, !grouped, foldedTokens < tokens, and NOT scored hot. Ordered BIGGEST-COLD-
 *       FIRST: primary key = tokens saved (tokens − foldedTokens) descending, tie-break colder,
 *       then older. A unit whose savings < cfg.minFoldTokens is SKIPPED (not worth a cache slot).
 *   (2) GRADUATE double-gated cold runs into strata (sedimentRuns). A stratum's saving is its
 *       members' tokens minus its summary cost; folds inside a graduating run are absorbed by it.
 *   (3) If Σ stratum tokens > cfg.ceilingFrac·cap, MERGE the oldest strata into one coarser
 *       stratum (graded forgetting) to keep the deep zone bounded.
 *   (4) FLOOR: DROP the oldest stratum (digestKind:"drop"). This ALWAYS frees tokens and is
 *       ALWAYS available while any stratum exists — the move that makes the invariant a
 *       guarantee, not a hope. The loop bottoms out at "protected tail + one minimal stratum".
 *
 * Strata are added before folds in the projection (a graduated run's tokens are claimed by its
 * stratum, not double-counted as folds). The summary token cost is ESTIMATED here (we don't have
 * the LLM text yet — that is fired during PREPARE); emitCommands substitutes the real text later.
 *
 * @param {ConductorView} view
 * @param {Map<string,number>} scores - temperatureKey → temperature (0..1, higher = hotter).
 * @param {ThermoState} state - dwell/graduation/everWarm/touched (kept for signature stability; the
 *        graduated SET is now taken from opts.graduated, NOT recomputed here — see below).
 * @param {object} cfg
 * @param {{deterministic?: boolean, graduated?: Set<string>}} opts -
 *        deterministic:true ⇒ never rely on an LLM digest; every fold/stratum uses its
 *        deterministic tier (the emergency epoch).
 *        graduated ⇒ the set of unit ids that have already graduated this tick. planEpoch does NOT
 *        advance dwell — the CALLER owns graduation: it calls `updateGraduation` exactly once per
 *        tick and threads the resulting `graduated` set in here. (Previously planEpoch re-ran
 *        updateGraduation internally, double-incrementing dwell so a unit graduated in ~⌈K/2⌉ ticks
 *        instead of K. Defaults to an empty set ⇒ no graduated-run strata, but folds + the
 *        age-based last resort still work.)
 * @returns {Plan} { folds: [{unitId, ids, tier}], strata: [{ids:[first,last], unitIds, memberIds,
 *                   digestKind, summaryTokens}], targetTokens, cap, projected }.
 */
export function planEpoch(view, scores, state, cfg = DEFAULT_CFG, opts = {}) {
	const deterministic = !!opts.deterministic;
	const cap = capOf(view);
	const targetTokens = cfg.lowWater * cap;

	const units = buildUnits(view.blocks);
	const byUnit = new Map(units.map((u) => [u.id, u]));

	// 1. Sediment the already-graduated-cold units (graduation was advanced ONCE by the caller and
	//    handed in via opts.graduated — planEpoch never advances dwell itself) into strata runs.
	//    These claim their member tokens FIRST so the deepen loop never double-folds them.
	const graduated = opts.graduated ?? new Set();
	const runs = sedimentRuns(view, scores, graduated, cfg, units); // pass pre-built units (no second O(n) scan)

	const strata = runs.map((r) => ({
		ids: [r.firstId, r.lastId],
		unitIds: r.unitIds,
		memberIds: r.memberIds,
		digestKind: "summary", // an LLM (or deterministic recap) summary; never DROP at birth
		summaryTokens: estimateStratumTokens(r, byUnit),
	}));
	const claimedByStratum = new Set(strata.flatMap((s) => s.unitIds));

	// 2. Eligible deepen candidates, BIGGEST-COLD-FIRST. Skip anything already claimed by a stratum
	//    and anything whose saving is below the minFold floor.
	const cands = units
		.filter((u) => isEligibleToDeepen(u, scores, cfg) && !claimedByStratum.has(u.id))
		.filter((u) => savingOf(u) >= cfg.minFoldTokens)
		.sort(
			(a, b) =>
				savingOf(b) - savingOf(a) || // biggest saving first
				(scores.get(a.temperatureKey) ?? 1) - (scores.get(b.temperatureKey) ?? 1) || // colder first
				a.order - b.order, // older first
		);

	const folds = [];
	const foldedIds = new Set();

	const applied = () => ({
		foldedIds,
		strata: strata.map((s) => ({ memberIds: s.memberIds, summaryTokens: s.summaryTokens })),
	});

	// 3. Compose moves until the projection fits, or we run out of moves.
	let ci = 0;
	// Rung 1: deepen coldest-biggest units one at a time.
	while (project(view, applied()) > targetTokens && ci < cands.length) {
		const u = cands[ci++];
		const tier = deterministic ? "trim" : "digest";
		folds.push({ unitId: u.id, ids: u.ids.filter((id) => isMemberFoldable(byUnit.get(u.id), id)), tier });
		for (const id of u.ids) {
			if (isMemberFoldable(byUnit.get(u.id), id)) foldedIds.add(id);
		}
	}

	// Rung 3: if the deep zone is over its ceiling, MERGE the oldest strata into one coarser
	//   stratum. (Runs are in conversation order, so index 0 is the oldest.)
	mergeOverCeiling(strata, cap, cfg, byUnit);

	// Rung 3.5 — AGE-BASED LAST-RESORT COMPACTION. Engaged ONLY when still over budget after
	// Rungs 1–3 (biggest-cold folds + graduated strata + ceiling merge). This is the probe-
	// independent safety net that makes the budget invariant hold even when scores is empty
	// (no probe — degraded mode) or when attention-driven compaction was insufficient.
	//
	// We form maximal contiguous runs from the OLDEST eligible units (same constraints as
	// sedimentRuns: ≥ cfg.minRunUnits units, whole-message snapped, tool-pairs whole, entirely
	// older than protectedFromIndex, bounded by held/protected/grouped "buoys") but WITHOUT
	// requiring graduation. Each run is immediately added as a "summary" stratum (deterministicRecap
	// is the wire text; the WS server upgrades via host.complete if available). We prefer compaction
	// over dropping — less information loss. opts.deterministic also uses this path (no LLM, no
	// fresh graduation), so an instant emergency epoch can always reach budget.
	if (project(view, applied()) > targetTokens) {
		const claimedBeforeLastResort = new Set([
			...claimedByStratum,
			...folds.flatMap((f) => byUnit.get(f.unitId)?.ids ?? []),
		]);
		const ageRuns = ageBasedRuns(units, view, claimedBeforeLastResort, cfg);
		for (const r of ageRuns) {
			if (project(view, applied()) <= targetTokens) break;
			// Skip if every unit in this run has savings below minFoldTokens AND the run doesn't
			// free meaningful space — but never skip entirely: a run with any foldable content is
			// worth absorbing (the group command frees all member tokens minus a tiny summary).
			const alreadyClaimed = r.unitIds.some((id) => claimedBeforeLastResort.has(id));
			if (alreadyClaimed) continue;
			const stratumEntry = {
				ids: [r.firstId, r.lastId],
				unitIds: r.unitIds,
				memberIds: r.memberIds,
				digestKind: "summary",
				summaryTokens: estimateStratumTokens(r, byUnit),
			};
			strata.push(stratumEntry);
			for (const uid of r.unitIds) claimedBeforeLastResort.add(uid);
		}
		// Re-apply ceiling merge after adding age-based strata.
		mergeOverCeiling(strata, cap, cfg, byUnit);
	}

	// Rung 4: the DROP floor toward the SOFT target. While still over target and any non-dropped
	//   stratum exists, drop strata OLDEST-FIRST (hard delete). Each drop strictly reduces tokens,
	//   so this terminates: it either reaches target or runs out of droppable strata. (Bug fix: this
	//   must NOT `break` after dropping the oldest — it has to keep converting strata[1..] to drops
	//   too, or a multi-stratum context stays over budget. See the iterate-oldest-first helper.)
	dropStrataOldestFirst(strata, view, applied, targetTokens);

	// Rung 5 — the HARD-CAP FLOOR. Everything above seeks the SOFT lowWater target while SPARING
	// hot / short / un-graduated content (attention-gating). This last rung is the unconditional
	// guarantee behind the #1 product invariant — live tokens ≤ the HARD cap = min(budget,
	// contextWindow) — and it is GATED on being over that HARD cap, so it is fully DORMANT whenever
	// the soft-target rungs already brought us under cap (the common case keeps attention-gating
	// untouched). Once over the hard cap, budget beats attention-sparing: we reduce the single
	// biggest reducible thing per step, ignoring the hot / minFoldTokens / minRunUnits gates:
	//   • prefer force-FOLDING the biggest eligible-by-KIND foldable unit (text/thinking/tool_result)
	//     not already folded — even if hot, even if its saving < minFoldTokens;
	//   • else force-GROUP a contiguous foldable run as a stratum even if < minRunUnits (down to a
	//     single unit) and even if not graduated — this is how non-foldable tool_call+tool_result
	//     pairs get compressed when no per-block fold is possible;
	//   • then DROP strata oldest-first.
	// It runs in BOTH normal and deterministic (emergency) modes. It terminates at the TRUE
	// irreducible floor — nothing foldable/groupable/droppable remains older than the protected tail
	// (only the protected tail + the non-foldable head are left). Each branch STRICTLY reduces the
	// projection (a fresh fold saves ≥1; a fresh group's members exceed its summary; a drop frees a
	// summary), and every unit it touches is permanently marked folded/claimed, so no move repeats —
	// the loop provably makes monotone progress to a fixed point.
	if (project(view, applied()) > cap) {
		// `claimed` tracks UNIT ids already absorbed by a per-block fold OR a stratum, so the floor
		// never re-folds or re-groups the same unit — the property that guarantees monotone progress.
		const claimed = new Set([...claimedByStratum, ...strata.flatMap((s) => s.unitIds)]);
		for (const f of folds) claimed.add(f.unitId);

		// Monotone-progress guard. Each branch STRICTLY reduces the projection (a fresh fold saves ≥1;
		// a fresh group reduces by members−summary>0 or is born a DROP freeing members≥1; a drop frees
		// a positive summary), and every unit it touches is marked claimed so no move repeats — the
		// projection strictly decreases until a fixed point. This guard is the belt-and-suspenders
		// stop: if a pass frees nothing, we are at the irreducible floor and must halt. The TRUE floor
		// is: the protected tail + held/grouped buoys + the per-block-fold residue (Σ foldedTokens of
		// the foldable units). Folds are PREFERRED (recoverable) over drops, so a context that is fully
		// foldable bottoms out at that fold residue; the only way below it would be to drop recoverable
		// content, which the floor declines unless the content is non-foldable (only groupable).
		let prev = Infinity;
		while (project(view, applied()) > cap) {
			const before = project(view, applied());
			if (before >= prev) break; // no progress last pass → irreducible floor reached
			prev = before;

			// (a) Force-fold the biggest eligible-by-KIND foldable unit not already folded. (Preferred:
			//     a per-block fold is recoverable — the agent can unfold/recall it.)
			const foldU = biggestForceFoldable(units, byUnit, foldedIds, claimed);
			if (foldU) {
				const tier = deterministic ? "trim" : "digest";
				folds.push({
					unitId: foldU.id,
					ids: foldU.ids.filter((id) => isMemberFoldable(byUnit.get(foldU.id), id)),
					tier,
				});
				for (const id of foldU.ids) {
					if (isMemberFoldable(byUnit.get(foldU.id), id)) foldedIds.add(id);
				}
				claimed.add(foldU.id);
				continue;
			}

			// (b) No per-block fold left — force-GROUP the biggest contiguous run of NOT-yet-claimed
			//     units (≥1 unit, ungraduated OK). ageBasedRuns(minUnits=1) surfaces the non-foldable
			//     tool-pairs / lone user|tool_call that only a group command can absorb. Picking by
			//     position (oldest run first) keeps strata in conversation order and their ranges
			//     non-overlapping, so the host's group snap stays a no-op.
			const forceRuns = ageBasedRuns(units, view, claimed, cfg, 1);
			if (forceRuns.length) {
				const best = forceRuns[0]; // oldest eligible run → strata stay ordered & disjoint
				const bestTok = runMemberTokens(best, byUnit);
				const summaryTokens = estimateStratumTokens(best, byUnit);
				// Recoverable summary preferred; but if a degenerate run's members are ≤ the summary
				// floor, a summary would not reduce — born a DROP instead so the step still frees members.
				const reduces = bestTok > summaryTokens;
				strata.push({
					ids: [best.firstId, best.lastId],
					unitIds: best.unitIds,
					memberIds: best.memberIds,
					digestKind: reduces ? "summary" : "drop",
					summaryTokens: reduces ? summaryTokens : 0,
				});
				for (const uid of best.unitIds) claimed.add(uid);
				continue;
			}

			// (c) Nothing left to fold or newly group — DROP strata oldest-first down to the cap.
			//     (If this frees nothing, the next pass's no-progress guard stops the loop.)
			const droppedAny = dropStrataOldestFirst(strata, view, applied, cap);
			if (!droppedAny) break; // only the protected tail + held buoys + fold residue remain — floor
		}
	}

	return {
		folds,
		strata,
		targetTokens,
		cap,
		projected: project(view, applied()),
	};
}

/**
 * Convert strata to drops OLDEST-FIRST until the projection is ≤ `bound` (or no non-dropped stratum
 * remains). Mutates `strata` in place. Returns true iff it dropped at least one stratum. Used BOTH
 * by Rung 4 (bound = soft target) and the hard-cap floor's branch (c) (bound = hard cap). Iterating
 * (not `break`-ing after the first) is the fix for the multi-stratum drop bug: every stratum that is
 * still needed to get under the bound is converted, not just the oldest one.
 *
 * FIX 9: iterate in CONVERSATION ORDER (oldest first) — sort by the first member's `order` in the
 * view before dropping. Rungs 3.5 and 5 append age-based strata to the array in processing order,
 * which may not match conversation order, so a naive array walk could drop a newer graduated stratum
 * before an older age-stratum. Sorting by `firstId`'s block order guarantees correct drop order.
 */
function dropStrataOldestFirst(strata, view, applied, bound) {
	// Build a lookup for each stratum's first member's position in conversation order.
	const orderOf = new Map(view.blocks.map((b) => [b.id, b.order]));
	// Sort a COPY by conversation order (ascending) — we mutate the original strata array elements
	// in place, so we only need a sorted reference list, not a sorted copy of the array.
	const sorted = strata
		.map((s, i) => ({ s, i, ord: orderOf.get(s.ids[0]) ?? Infinity }))
		.sort((a, b) => a.ord - b.ord);
	let droppedAny = false;
	for (const { s } of sorted) {
		if (project(view, applied()) <= bound) break;
		if (s.digestKind !== "drop") {
			s.digestKind = "drop";
			s.summaryTokens = 0; // a dropped run contributes nothing to the wire
			droppedAny = true;
		}
	}
	return droppedAny;
}

/**
 * The biggest (most member tokens) force-FOLDABLE unit for the hard-cap floor: a unit whose every
 * member is a foldable kind (`u.foldable`), not held/protected/grouped, that would actually shrink
 * (foldedTokens < tokens), and that is not already folded or already swept into a stratum. UNLIKE
 * the attention-gated Rung 1, this IGNORES temperature (folds even hot units) and the minFoldTokens
 * floor — once over the hard cap, budget wins. Returns null if none remains.
 */
function biggestForceFoldable(units, byUnit, foldedIds, inStratum) {
	let best = null;
	let bestSave = 0;
	for (const u of units) {
		if (!u.foldable) continue;
		if (u.held || u.protected || u.grouped) continue;
		if (u.foldedTokens >= u.tokens) continue;
		if (inStratum.has(u.id)) continue;
		if (u.ids.some((id) => foldedIds.has(id))) continue; // already folded this epoch
		const save = savingOf(u);
		if (save > bestSave) {
			best = u;
			bestSave = save;
		}
	}
	return best;
}

/** Σ member tokens of a run (for picking the biggest force-group candidate). */
function runMemberTokens(run, byUnit) {
	let t = 0;
	for (const uid of run.unitIds) {
		const u = byUnit.get(uid);
		if (u) t += u.tokens;
	}
	return t;
}

/** True iff a unit may be DEEPENED to a per-block fold this epoch. */
function isEligibleToDeepen(u, scores, cfg) {
	if (!u.foldable) return false; // pure tool-pairs can only join a stratum, never per-block fold
	if (u.held || u.protected || u.grouped) return false;
	if (u.foldedTokens >= u.tokens) return false; // wouldn't actually shrink
	const temp = scores.get(u.temperatureKey);
	if (temp !== undefined && temp >= cfg.coldThreshold) return false; // scored HOT → spare it
	return true;
}

/** Saving (tokens reclaimed) from folding a unit to its per-block digest. */
function savingOf(u) {
	return Math.max(0, u.tokens - u.foldedTokens);
}

/** Is this member block foldable on its own (so it may carry a per-block fold inside a unit)? */
function isMemberFoldable(unit, id) {
	const idx = unit.ids.indexOf(id);
	return idx >= 0 && FOLDABLE_KINDS.has(unit.kinds[idx]);
}

/**
 * Estimated token cost of a stratum's holistic summary. A run summary is shorter than the sum of
 * its members (the whole point), so we model it as a fraction of member tokens, floored so a
 * tiny run still has a non-zero summary, and capped at maxSummaryTokens. Estimate only — the real
 * cost is the actual LLM text's length, applied in emitCommands.
 */
function estimateStratumTokens(run, byUnit) {
	let members = 0;
	for (const uid of run.unitIds) {
		const u = byUnit.get(uid);
		if (u) members += u.tokens;
	}
	// ~12% of the run, between a 60-token floor and an 8k ceiling — comfortably below the members.
	return Math.min(8000, Math.max(60, Math.round(members * 0.12)));
}

/**
 * Rung 3 — keep the deep zone bounded. If Σ stratum tokens exceeds ceilingFrac·cap, fuse the two
 * OLDEST strata (indices 0,1) into one coarser super-stratum and repeat until under the ceiling
 * (or only one stratum remains). Mutates `strata` in place (it is plan-local, freshly built).
 *
 * ADJACENCY GUARD: only fuse strata whose member ranges are CONTIGUOUS — i.e. stratum a's last
 * member id is immediately followed by stratum b's first member id in conversation order. If a
 * buoy (hot/held/protected/non-grouped block) sits between them, fusing would create a group
 * spanning a gap: the host snaps the range outward and could swallow the buoy (grouping a
 * hot/held block or getting the whole group refused → lost savings → budget invariant breaks).
 * Non-adjacent strata are left as separate group commands; the drop-floor handles ceiling
 * enforcement in that case.
 */
function mergeOverCeiling(strata, cap, cfg, byUnit) {
	const ceiling = cfg.ceilingFrac * cap;
	const sumStrata = () => strata.reduce((s, x) => s + x.summaryTokens, 0);
	while (sumStrata() > ceiling && strata.length > 1) {
		const [a, b] = [strata[0], strata[1]];
		// Check adjacency: a's last memberIds entry must immediately precede b's first memberIds entry
		// in the byUnit map. Both must be units (present in byUnit); if either is absent, skip merge.
		const aLastUnit = byUnit.get(a.unitIds[a.unitIds.length - 1]);
		const bFirstUnit = byUnit.get(b.unitIds[0]);
		const adjacent =
			aLastUnit !== undefined &&
			bFirstUnit !== undefined &&
			// The two strata are contiguous iff a's last unit and b's first unit have consecutive orders.
			// Because units are built in conversation order (each unit's .order = its first block's order),
			// and strata member ranges are whole units, adjacency ⟺ no non-stratum unit sits between them.
			// We check: the last memberIds of `a` is the block immediately before the first memberIds of `b`
			// by looking at orders — if b.firstUnit.order === aLastUnit.order + aLastUnit.ids.length, they
			// are contiguous in block-index space. Use the simpler unit-order check: adjacent if there is no
			// gap in unit orders, i.e. bFirstUnit.order === aLastUnit.order + aLastUnit.ids.length.
			bFirstUnit.order === aLastUnit.order + aLastUnit.ids.length;
		if (!adjacent) break; // non-adjacent pair found — leave remaining strata as-is
		const merged = {
			ids: [a.ids[0], b.ids[1]],
			unitIds: [...a.unitIds, ...b.unitIds],
			memberIds: [...a.memberIds, ...b.memberIds],
			digestKind: "summary",
			summaryTokens: estimateStratumTokens({ unitIds: [...a.unitIds, ...b.unitIds] }, byUnit),
		};
		strata.splice(0, 2, merged);
	}
}

/** cap = the tighter of budget and contextWindow (never exceed either ceiling). */
function capOf(view) {
	return Math.min(view.budget, view.contextWindow ?? Infinity);
}

// ── emitCommands: plan → Command[] ──────────────────────────────────────────────────────────

/**
 * Translate a plan into the contract's Command[] (fold + group only), re-derived from the LIVE
 * view each call. Every digest the agent receives is the recoverable `{#code FOLDED} <text>`.
 *
 *   • Each fold → a `fold` command. We BATCH folds of the same tier into ONE command ONLY when
 *     they share a digest — and a per-block digest is per-id (each carries its own foldTag(id)),
 *     so distinct ids never share a digest. Hence: ONE fold command per unit (the simplest shape
 *     the contract allows), its `ids` the unit's foldable member ids, its `digest` =
 *     foldTag(unit.id) + " " + (LLM digest for this unit, or the deterministic tier text).
 *   • Each stratum → a `group` command over [firstId, lastId].
 *       digestKind:"summary" → digest = foldTag('g:'+firstId) + " " + (LLM stratum summary OR
 *                              deterministicRecap) — recoverable, recall returns originals. The
 *                              'g:' prefix matches the host's group id format (store.svelte.ts
 *                              ~1279: `id: \`g:\${memberIds[0]}\``), so foldCode(g.id) resolves.
 *       digestKind:"drop"    → digest = null (hard delete; the agent never sees those blocks).
 *
 * @param {Plan} plan - from planEpoch.
 * @param {Map<string,string>} digests - LLM texts keyed by unit id (per-block digest) or by a
 *        stratum key `stratum:<firstId>` (run summary). Missing ⇒ fall back to the deterministic
 *        tier (so an emergency / not-yet-returned epoch still emits valid commands).
 * @param {ConductorView} view - the live view (to read member .text for deterministic fallbacks).
 * @returns {Command[]}
 */
export function emitCommands(plan, digests, view) {
	const d = digests ?? new Map();
	const units = buildUnits(view.blocks);
	const byUnit = new Map(units.map((u) => [u.id, u]));
	const cmds = [];

	// Per-block folds — one fold command per unit.
	for (const f of plan.folds) {
		const u = byUnit.get(f.unitId);
		if (!u) continue;
		const ids = f.ids.filter((id) => isMemberFoldable(u, id));
		if (ids.length === 0) continue; // nothing foldable in this unit (pure tool-pair) — skip
		const body = d.get(f.unitId) ?? (f.tier === "trim" ? trimText(u) : deterministicDigest(u));
		cmds.push({ kind: "fold", ids, digest: `${foldTag(u.id)} ${body}` });
	}

	// Strata — one group command per stratum.
	for (const s of plan.strata) {
		if (s.digestKind === "drop") {
			cmds.push({ kind: "group", ids: [s.ids[0], s.ids[1]], digest: null });
			continue;
		}
		const stratumUnits = s.unitIds.map((id) => byUnit.get(id)).filter(Boolean);
		const body = d.get(`stratum:${s.ids[0]}`) ?? deterministicRecap(stratumUnits);
		// COUPLING: the host creates the group with id `g:${memberIds[0]}` (store.svelte.ts ~1279).
		// The agent resolves unfold/recall via foldCode(g.id), so the digest tag MUST encode the GROUP
		// id (i.e. 'g:' + firstMemberId), not the bare first-member id. This is correct as long as
		// the conductor's run boundary is already whole-message/tool-pair snapped so the host does not
		// re-snap memberIds[0] away from s.ids[0].
		cmds.push({ kind: "group", ids: [s.ids[0], s.ids[1]], digest: `${foldTag("g:" + s.ids[0])} ${body}` });
	}

	return cmds;
}

// ── prompt builders & deterministic fallbacks (compaction-naive style, pure strings) ─────────

/** System instruction for a per-unit L2 digest call: a faithful 1–3 line summary, no chatter. */
const DIGEST_SYSTEM = `\
You are a context-compaction assistant. Summarize ONE segment of an AI assistant's work history \
into a faithful, dense digest of AT MOST THREE lines. Preserve exact file paths, function names, \
identifiers, error messages, and decisions; drop pleasantries and filler. Do NOT continue the \
conversation or answer any question inside it — output ONLY the digest text, no preamble.`;

/**
 * System instruction for a per-run L3 stratum summary. Lifts compaction-naive's sacred rule:
 * USER MESSAGES ARE REPRODUCED VERBATIM so the human's intent survives compression; only
 * assistant reasoning is summarized.
 */
const STRATUM_SYSTEM = `\
You are a context-compaction assistant. Read a contiguous run of an AI assistant's work history \
and produce ONE compact, structured briefing that lets the assistant continue without the \
originals. Do NOT continue the conversation or answer any question inside it — output ONLY the \
summary.

USER MESSAGES ARE SACRED. Reproduce EVERY user message VERBATIM, in order, under "## User \
messages" — never paraphrase, abbreviate, or omit one. (Assistant text, thinking, tool calls, \
and tool results ARE summarized; only user messages are kept word-for-word.)

Use exactly these sections; keep each even when empty, writing "(none)":

## User messages
Every user message from the run, verbatim, in order.

## Summary
What this run accomplished — files changed, commands run, decisions, errors and resolutions. \
Be terse; preserve exact file paths, function names, and error messages.

## Still relevant
Facts, constraints, or open threads later work must remember.

Be terse everywhere except the verbatim user messages. The output goes directly into the agent's context window.`;

/**
 * Build the host.complete request for a per-unit L2 digest. Pure: returns { system, prompt }; the
 * server attaches maxOutputTokens / signal and fires it.
 *
 * @param {Unit} unit
 * @returns {{system: string, prompt: string}}
 */
export function buildDigestPrompt(unit) {
	const body = unit.blocks
		.map((b) => {
			const text = (b.text ?? "").trim();
			return text ? `[${blockLabel(b)}]\n${text}` : `[${blockLabel(b)}]`;
		})
		.join("\n\n");
	return {
		system: DIGEST_SYSTEM,
		prompt: ["<segment>", body, "</segment>", "", "Summarize the segment above in at most three faithful lines."].join("\n"),
	};
}

/**
 * Build the host.complete request for a per-run L3 stratum summary. User messages are surfaced to
 * the model verbatim; the SYSTEM prompt's verbatim rule keeps them word-for-word in the output.
 *
 * @param {Unit[]} units - the run's units, in conversation order.
 * @returns {{system: string, prompt: string}}
 */
export function buildStratumPrompt(units) {
	const conversation = units
		.flatMap((u) => u.blocks)
		.map((b) => {
			const text = (b.text ?? "").trim();
			return text ? `[${blockLabel(b)}]\n${text}` : `[${blockLabel(b)}]`;
		})
		.join("\n\n");
	return {
		system: STRATUM_SYSTEM,
		prompt: [
			"<conversation>",
			conversation,
			"</conversation>",
			"",
			"Create a structured summary of the conversation run above. Reproduce every user message verbatim in \"## User messages\".",
		].join("\n"),
	};
}

/**
 * Deterministic L2 digest — the instant placeholder and no-LLM fallback for one unit. Pure,
 * stateless, no model. For a tool-pair, names the call + a taste of its result; otherwise a clipped
 * first line. Kept lazy: a couple of lines, the salient head.
 */
export function deterministicDigest(unit) {
	const head = unit.blocks[0];
	const result = unit.blocks.find((b) => b.kind === "tool_result");
	if (head.kind === "tool_call") {
		const name = head.toolName ?? "tool";
		const peek = result ? firstLine((result.text ?? "").trim(), 60) : "";
		return `${name}() → ${result?.isError ? "error" : peek || "done"}`;
	}
	return clip((head.text ?? "").trim(), 120) || `${blockLabel(head)} · ~${head.tokens} tok`;
}

/**
 * Deterministic L3 recap — the no-LLM stand-in for a stratum (the host's group-recap shape). Pure:
 * counts kinds, names the turn span, and quotes the first user ask if any (so the human's intent
 * is never silently dropped even in the deterministic path). Mirrors engine groupDigest in spirit.
 */
export function deterministicRecap(units) {
	const blocks = units.flatMap((u) => u.blocks);
	if (!blocks.length) return "run · empty";
	let tokens = 0;
	let lo = Infinity;
	let hi = -Infinity;
	let ask = "";
	const counts = new Map();
	for (const b of blocks) {
		tokens += b.tokens;
		if (b.turn < lo) lo = b.turn;
		if (b.turn > hi) hi = b.turn;
		counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
		if (b.kind === "user" && !ask) ask = firstLine((b.text ?? "").trim(), 70);
	}
	const span = lo === hi ? (lo > 0 ? `turn ${lo}` : "preamble") : lo > 0 ? `turns ${lo}–${hi}` : `preamble–turn ${hi}`;
	const breakdown = [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(", ");
	const quote = ask ? ` · “${ask}”` : "";
	return `run · ${blocks.length} block${blocks.length === 1 ? "" : "s"} · ${span} · ~${tokens} tok · ${breakdown}${quote}`;
}

/**
 * Deterministic L1 "Trim" — a query-light extractive excerpt of a unit: roughly the first and last
 * ~15% of lines, ALWAYS keeping lines that carry a path, an error, or a quote (the artifacts most
 * costly to lose). No model. Lazy by design — a few lines, not a real summarizer.
 *
 * @param {Unit} unit
 * @returns {string} the excerpt (already without the tag; emitCommands prepends foldTag).
 */
export function trimText(unit) {
	const text = unit.blocks.map((b) => (b.text ?? "").trim()).filter(Boolean).join("\n");
	const lines = text.split("\n");
	if (lines.length <= 6) return clip(text, 240); // too short to excerpt — just clip it

	const headN = Math.max(2, Math.ceil(lines.length * 0.15));
	const tailN = Math.max(2, Math.ceil(lines.length * 0.15));
	const keep = new Set();
	for (let i = 0; i < headN; i++) keep.add(i);
	for (let i = lines.length - tailN; i < lines.length; i++) keep.add(i);
	// Unconditionally keep salient lines: a path, an error marker, or a quote.
	const salient = /[\\/][\w.-]+|error|exception|fail|"[^"]+"|'[^']+'/i;
	for (let i = 0; i < lines.length; i++) {
		if (salient.test(lines[i])) keep.add(i);
	}

	const out = [];
	let gapped = false;
	for (let i = 0; i < lines.length; i++) {
		if (keep.has(i)) {
			out.push(lines[i]);
			gapped = false;
		} else if (!gapped) {
			out.push("…");
			gapped = true;
		}
	}
	return clip(out.join("\n"), 600);
}

// ── tiny pure utilities ─────────────────────────────────────────────────────────────────────

/** Union of two (possibly undefined) sets into a fresh Set. */
function unionSet(a, b) {
	const out = new Set(a ?? []);
	for (const x of b ?? []) out.add(x);
	return out;
}

/** First non-empty line of `s`, clipped to `n` chars. */
function firstLine(s, n) {
	const line = (s.split("\n").find((l) => l.trim()) ?? "").trim();
	return clip(line, n);
}

/** Clip `s` to `n` chars with an ellipsis. */
function clip(s, n) {
	if (s.length <= n) return s;
	return s.slice(0, Math.max(0, n - 1)).trimEnd() + "…";
}

/** A short role label for a block, mirroring the Transcript view / compaction-naive. */
function blockLabel(b) {
	switch (b.kind) {
		case "user":
			return "user";
		case "text":
			return "assistant";
		case "thinking":
			return "assistant thinking";
		case "tool_call":
			return b.toolName ? `tool call: ${b.toolName}` : "tool call";
		case "tool_result":
			return b.toolName ? `tool result: ${b.toolName}` : "tool result";
		default:
			return String(b.kind);
	}
}
