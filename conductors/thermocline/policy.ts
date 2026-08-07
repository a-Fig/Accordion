// policy.ts — the PURE policy core of the Thermocline conductor (no I/O, no host, no probe).
//
// Ported near-verbatim from the pre-excision `conductors/thermocline/policy.mjs` (commit dc037bc)
// and re-typed against the conductor-v2 contract. Thermocline is the synthesis of two parents:
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
// engine Op[] for it. It decides nothing about the network, the GPU, or the LLM: the scores and
// the LLM summary texts are handed to its functions as data; the conductor (thermocline.ts) owns
// the ConductorHost, the probe child, host.complete, and the applied-state memory. Everything
// here is pure: a function of its arguments, no Date.now(), no mutation of inputs. That is what
// makes it testable with the in-process TestHost (and bare vitest) today.
//
// The fidelity ladder a unit can sit at:
//   Full (live) → Trim (L1, deterministic extractive excerpt) → Digest (L2, LLM 1–3 lines)
//   → Stratum (L3, a contiguous cold RUN summarized holistically into one group)
//   → drop (L4 floor, group(summary:null) — the hard delete that backstops the invariant).
//
// RECOVERABILITY — CHANGED FROM THE .mjs PORT. The old policy copied engine/digest.ts's `foldCode`
// byte-for-byte and hand-authored every `{#code FOLDED}` tag. That lockstep hack is DELETED. Now:
//   • L2 digests → `replace` ops with `recoverable:true`; the ENGINE prepends the canonical tag
//     (see core/truth.ts → opReplace). policy passes the bare digest body, never a tag.
//   • L3 strata → `group` ops with a VERBATIM summary string. Verbatim group summaries are NOT
//     tagged by the engine by design (core/ops.ts → group `summary`), yet strata must stay
//     recall-able, so this ONE site prefixes the group's recall tag itself — importing the
//     canonical `foldTag`/`foldCode` from core/digest.ts (an in-repo relative import; thermocline
//     is a first-party package). This is the SINGLE remaining tag-authoring site; see `emitOps`.
//
// Vocabulary used throughout:
//   UNIT  — the atomic compression target. A tool_call + its tool_result (same callId) are ONE
//           unit (they move together everywhere, so a fold/group never orphans a result);
//           every other block is its own unit.
//   RUN   — a maximal contiguous sequence of graduated-cold units, split by "buoy" units
//           (hot / held / protected / grouped). A run that clears the gates becomes a stratum.
//   APPLIED-STATE — the explicit { foldedIds, strata } sets the plan renders. project() reads
//           ONLY these sets (never the view's per-block flags) so token accounting never
//           double-counts an already-folded block or infers a fold the conductor didn't make.
import type { Op } from "../../core/ops";
import type { ViewBlock } from "../../core/conductor/contract";
import type { BlockKind } from "../../core/types";
import type { ConductorView } from "../../core/conductor/view";
// The SINGLE remaining tag-authoring site imports the canonical tag builder — never a copy.
import { foldTag } from "../../core/digest";

export type { ConductorView, ViewBlock };

/** Kinds whose CONTENT may be substituted by a digest on the agent's wire. A tool_call is never
 *  folded (it would orphan its result) and a user block (intent) is never folded — mirrors the
 *  engine's `FOLDABLE_KINDS` and the host's `not-foldable` clamp. The single foldability gate. */
export const FOLDABLE_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>(["text", "thinking", "tool_result"]);

/**
 * Tuning. Waters are fractions of the cap (= min(budget, contextWindow)); the conductor reads
 * warmWater/highWater for the PREPARE/EMERGENCY timing, this module reads lowWater as the epoch's
 * fold-down target and ceilingFrac as the deep-zone ceiling.
 *
 *   coldThreshold — temperatures are normalized 0..1 (higher = hotter / more attended). 0.35 is
 *     a deliberately conservative cold line: a unit must be clearly UN-attended (bottom third)
 *     before it is even eligible to deepen, and the graduation gate re-checks the same line.
 */
export interface Config {
	highWater: number;
	lowWater: number;
	warmWater: number;
	ceilingFrac: number;
	coldThreshold: number;
	K: number;
	minRunUnits: number;
	minFoldTokens: number;
}

export const DEFAULT_CFG: Config = {
	highWater: 0.9, // conductor: a planned epoch must have finished before this
	lowWater: 0.7, // planEpoch composes moves until project(plan) ≤ lowWater·cap
	warmWater: 0.8, // conductor: begin preparing the next epoch around here
	ceilingFrac: 0.2, // Σ stratum tokens may not exceed this fraction of cap
	coldThreshold: 0.35, // temperature below which a unit counts as cold
	K: 3, // dwell epochs a unit must stay cold+untouched before it graduates to a stratum
	minRunUnits: 3, // a run shorter than this stays merely folded, never becomes a stratum
	minFoldTokens: 200, // a deepen whose savings is below this is not worth a cache slot
};

// ── types ────────────────────────────────────────────────────────────────────────────────────

export interface Unit {
	/** The unit's stable id = its FIRST block's id (so foldCode(unit.id) is stable). */
	id: string;
	/** Its block ids in order. */
	ids: string[];
	/** Its block kinds in order. */
	kinds: BlockKind[];
	/** The ViewBlocks themselves (so prompt builders read .text without a re-lookup). */
	blocks: ViewBlock[];
	/** Σ full tokens of the members. */
	tokens: number;
	/** Σ folded tokens of the members. */
	foldedTokens: number;
	/** The first member's order (units are emitted in conversation order). */
	order: number;
	/** The first member's turn. */
	turn: number;
	/** True iff EVERY member is a foldable kind (a pure tool_call+tool_result pair is NOT). */
	foldable: boolean;
	/** The id to score this unit's temperature against: the RESULT block's id for a tool pair. */
	temperatureKey: string;
	held: boolean;
	protected: boolean;
	grouped: boolean;
}

/** A stratum entry the plan renders — a contiguous run collapsed into one group. */
export interface PlanStratum {
	/** [firstId, lastId] — the group op's boundary ids. */
	ids: [string, string];
	unitIds: string[];
	memberIds: string[];
	digestKind: "summary" | "drop";
	summaryTokens: number;
}

/** A per-block fold entry the plan renders. */
export interface PlanFold {
	unitId: string;
	ids: string[];
	tier: "trim" | "digest";
}

export interface Plan {
	folds: PlanFold[];
	strata: PlanStratum[];
	targetTokens: number;
	cap: number;
	projected: number;
}

/** The dwell/graduation/touch state the caller threads through updateGraduation / planEpoch. */
export interface ThermoState {
	dwell: Map<string, number>;
	graduated?: Set<string>;
	everWarm?: Set<string>;
	agentTouched?: Set<string>;
	recalledThisEpoch?: Set<string>;
}

/** The project()-shape applied state: disjoint folded ids + strata. */
export interface Applied {
	foldedIds: Set<string>;
	strata: { memberIds: string[]; summaryTokens: number }[];
}

// ── units: tool-pair atomicity ──────────────────────────────────────────────────────────────

/**
 * Group blocks into UNITS. A `tool_call` and the `tool_result` that shares its `callId` become
 * ONE atomic unit (they move together everywhere, so no fold/group ever orphans a result); every
 * other block is its own unit. Order is preserved — a unit's `order` is its first block's.
 */
export function buildUnits(blocks: readonly ViewBlock[]): Unit[] {
	// Index tool_result blocks by callId so a tool_call can pull in its partner.
	const resultByCall = new Map<string, ViewBlock>();
	for (const b of blocks) {
		if (b.kind === "tool_result" && b.callId) resultByCall.set(b.callId, b);
	}
	const pairedResultIds = new Set<string>();
	for (const b of blocks) {
		if (b.kind === "tool_call" && b.callId && resultByCall.has(b.callId)) {
			pairedResultIds.add(resultByCall.get(b.callId)!.id);
		}
	}

	const units: Unit[] = [];
	for (const b of blocks) {
		// A tool_result already swallowed by its call's unit is skipped (it was emitted with the call).
		if (b.kind === "tool_result" && pairedResultIds.has(b.id)) continue;

		let members: ViewBlock[];
		if (b.kind === "tool_call" && b.callId && resultByCall.has(b.callId)) {
			members = [b, resultByCall.get(b.callId)!];
		} else {
			members = [b];
		}
		units.push(makeUnit(members));
	}
	return units;
}

/** Assemble a Unit from its member blocks (≥1, in order). */
function makeUnit(members: ViewBlock[]): Unit {
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
 */
export function project(view: ConductorView, applied: Partial<Applied>): number {
	const byId = new Map(view.blocks.map((b) => [b.id, b]));
	let t = view.liveTokens;

	for (const id of applied.foldedIds ?? new Set<string>()) {
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
 *   ② the agent did NOT recall/unfold it while it sat folded (a behavioral veto).
 *
 * The threshold is K epochs, or 2·K if the unit is in `state.everWarm`. ANY re-warm resets the
 * unit's dwell to 0 and clears graduation. A unit not currently folded also can't graduate.
 *
 * Pure: returns a NEW dwell map and a NEW graduated set; never mutates `state`.
 */
export function updateGraduation(
	state: ThermoState,
	view: ConductorView,
	scores: Map<string, number>,
	cfg: Config = DEFAULT_CFG,
): { dwell: Map<string, number>; graduated: Set<string> } {
	const units = buildUnits(view.blocks);
	const prevDwell = state.dwell ?? new Map<string, number>();
	const everWarm = state.everWarm ?? new Set<string>();
	const touched = unionSet(state.agentTouched, state.recalledThisEpoch);

	const dwell = new Map<string, number>();
	const graduated = new Set<string>();

	for (const u of units) {
		const temp = scores.get(u.temperatureKey);
		const cold = temp !== undefined && temp < cfg.coldThreshold;
		const folded = isUnitFolded(u); // graduation only progresses while the unit is folded
		// FIX 8: check ANY member id, not just u.id (the first-block id). The conductor records raw
		// block ids from state-changed events; a recall of a non-first member (e.g. the tool_result
		// of a pair) would miss the veto if we only checked u.id.
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
function isUnitFolded(u: Unit): boolean {
	return u.blocks.every((b) => b.folded);
}

// ── runs & sedimentation: graduated-cold → strata ───────────────────────────────────────────

export interface Run {
	unitIds: string[];
	memberIds: string[];
	firstId: string;
	lastId: string;
}

/**
 * Partition graduated units into STRATA runs. A run is a MAXIMAL contiguous sequence of
 * graduated units bounded by "buoy" units that split runs (hot / held / protected / grouped). A
 * run is kept only if it has ≥ cfg.minRunUnits units AND lies entirely OLDER than
 * protectedFromIndex. Shorter runs stay merely folded — they never sink to a stratum.
 */
export function sedimentRuns(
	view: ConductorView,
	scores: Map<string, number>,
	graduated: Set<string>,
	cfg: Config = DEFAULT_CFG,
	units: Unit[] | null = null,
): Run[] {
	if (!units) units = buildUnits(view.blocks);
	const pfi = Math.min(view.protectedFromIndex, view.blocks.length);
	// COUPLING: `order` must track the block-array index — this tail boundary reads the .order of the
	// block AT index pfi to split runs, so a unit's order field has to be monotone with its position
	// in view.blocks. buildUnits preserves this (a unit's order = its first block's).
	const protectedFrom = view.blocks[pfi]?.order ?? Infinity;

	const runs: Run[] = [];
	let cur: Unit[] = [];
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
 * Age-based last-resort runs — same structural constraints as sedimentRuns but WITHOUT requiring
 * graduation. Used by planEpoch's Rung 3.5 when the probe is absent or attention-driven
 * compaction was insufficient. Returns runs in conversation order (oldest first).
 */
function ageBasedRuns(units: Unit[], view: ConductorView, claimed: Set<string>, cfg: Config, minUnits: number = cfg.minRunUnits): Run[] {
	const pfi = Math.min(view.protectedFromIndex, view.blocks.length);
	const protectedFrom = view.blocks[pfi]?.order ?? Infinity;

	const runs: Run[] = [];
	let cur: Unit[] = [];
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

export interface PlanOpts {
	deterministic?: boolean;
	graduated?: Set<string>;
}

/**
 * Plan one epoch: the COMPLETE next compression state, composed cheapest-move-first until the
 * projection fits under lowWater·cap (or it bottoms out). The §01 ladder:
 *
 *   (1) DEEPEN the coldest ELIGIBLE unit to a per-block fold. Ordered BIGGEST-COLD-FIRST.
 *   (2) GRADUATE double-gated cold runs into strata (sedimentRuns).
 *   (3) If Σ stratum tokens > cfg.ceilingFrac·cap, MERGE the oldest strata into one coarser stratum.
 *   (3.5) AGE-BASED last resort (probe-independent safety net).
 *   (4) FLOOR: DROP the oldest stratum. This ALWAYS frees tokens.
 *   (5) HARD-CAP FLOOR: force-fold/force-group/drop once over the HARD cap.
 *
 * planEpoch does NOT advance dwell — the CALLER owns graduation and threads `opts.graduated` in.
 */
export function planEpoch(
	view: ConductorView,
	scores: Map<string, number>,
	_state: ThermoState,
	cfg: Config = DEFAULT_CFG,
	opts: PlanOpts = {},
): Plan {
	const deterministic = !!opts.deterministic;
	const cap = capOf(view);
	const targetTokens = cfg.lowWater * cap;

	const units = buildUnits(view.blocks);
	const byUnit = new Map(units.map((u) => [u.id, u]));

	// 1. Sediment the already-graduated-cold units (graduation was advanced ONCE by the caller and
	//    handed in via opts.graduated — planEpoch never advances dwell itself) into strata runs.
	const graduated = opts.graduated ?? new Set<string>();
	const runs = sedimentRuns(view, scores, graduated, cfg, units);

	const strata: PlanStratum[] = runs.map((r) => ({
		ids: [r.firstId, r.lastId],
		unitIds: r.unitIds,
		memberIds: r.memberIds,
		digestKind: "summary", // an LLM (or deterministic recap) summary; never DROP at birth
		summaryTokens: estimateStratumTokens(r, byUnit),
	}));
	const claimedByStratum = new Set(strata.flatMap((s) => s.unitIds));

	// 2. Eligible deepen candidates, BIGGEST-COLD-FIRST.
	const cands = units
		.filter((u) => isEligibleToDeepen(u, scores, cfg) && !claimedByStratum.has(u.id))
		.filter((u) => savingOf(u) >= cfg.minFoldTokens)
		.sort(
			(a, b) =>
				savingOf(b) - savingOf(a) || // biggest saving first
				(scores.get(a.temperatureKey) ?? 1) - (scores.get(b.temperatureKey) ?? 1) || // colder first
				a.order - b.order, // older first
		);

	const folds: PlanFold[] = [];
	const foldedIds = new Set<string>();

	const applied = (): Applied => ({
		foldedIds,
		strata: strata.map((s) => ({ memberIds: s.memberIds, summaryTokens: s.summaryTokens })),
	});

	// 3. Compose moves until the projection fits, or we run out of moves.
	let ci = 0;
	// Rung 1: deepen coldest-biggest units one at a time.
	while (project(view, applied()) > targetTokens && ci < cands.length) {
		const u = cands[ci++];
		const tier: "trim" | "digest" = deterministic ? "trim" : "digest";
		folds.push({ unitId: u.id, ids: u.ids.filter((id) => isMemberFoldable(byUnit.get(u.id)!, id)), tier });
		for (const id of u.ids) {
			if (isMemberFoldable(byUnit.get(u.id)!, id)) foldedIds.add(id);
		}
	}

	// Rung 3: if the deep zone is over its ceiling, MERGE the oldest strata into one coarser stratum.
	mergeOverCeiling(strata, cap, cfg, byUnit);

	// Rung 3.5 — AGE-BASED LAST-RESORT COMPACTION. Engaged ONLY when still over budget after
	// Rungs 1–3. This is the probe-independent safety net that makes the budget invariant hold even
	// when scores is empty (no probe) or when attention-driven compaction was insufficient.
	if (project(view, applied()) > targetTokens) {
		const claimedBeforeLastResort = new Set<string>([
			...claimedByStratum,
			...folds.flatMap((f) => byUnit.get(f.unitId)?.ids ?? []),
		]);
		const ageRuns = ageBasedRuns(units, view, claimedBeforeLastResort, cfg);
		for (const r of ageRuns) {
			if (project(view, applied()) <= targetTokens) break;
			const alreadyClaimed = r.unitIds.some((id) => claimedBeforeLastResort.has(id));
			if (alreadyClaimed) continue;
			const stratumEntry: PlanStratum = {
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

	// Rung 4: the DROP floor toward the SOFT target. Drop strata OLDEST-FIRST (hard delete).
	dropStrataOldestFirst(strata, view, applied, targetTokens);

	// Rung 5 — the HARD-CAP FLOOR. Everything above seeks the SOFT lowWater target while SPARING
	// hot / short / un-graduated content. This last rung is the unconditional guarantee behind the
	// #1 product invariant — live tokens ≤ the HARD cap = min(budget, contextWindow) — and it is
	// GATED on being over that HARD cap, so it is fully DORMANT whenever the soft-target rungs
	// already brought us under cap. Once over the hard cap, budget beats attention-sparing.
	if (project(view, applied()) > cap) {
		const claimed = new Set<string>([...claimedByStratum, ...strata.flatMap((s) => s.unitIds)]);
		for (const f of folds) claimed.add(f.unitId);

		let prev = Infinity;
		while (project(view, applied()) > cap) {
			const before = project(view, applied());
			if (before >= prev) break; // no progress last pass → irreducible floor reached
			prev = before;

			// (a) Force-fold the biggest eligible-by-KIND foldable unit not already folded.
			const foldU = biggestForceFoldable(units, foldedIds, claimed);
			if (foldU) {
				const tier: "trim" | "digest" = deterministic ? "trim" : "digest";
				folds.push({
					unitId: foldU.id,
					ids: foldU.ids.filter((id) => isMemberFoldable(byUnit.get(foldU.id)!, id)),
					tier,
				});
				for (const id of foldU.ids) {
					if (isMemberFoldable(byUnit.get(foldU.id)!, id)) foldedIds.add(id);
				}
				claimed.add(foldU.id);
				continue;
			}

			// (b) No per-block fold left — force-GROUP the biggest contiguous run of NOT-yet-claimed
			//     units (≥1 unit, ungraduated OK). ageBasedRuns(minUnits=1) surfaces the non-foldable
			//     tool-pairs / lone user|tool_call that only a group command can absorb.
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
 * Convert strata to drops OLDEST-FIRST until the projection is ≤ `bound`. Mutates `strata` in
 * place. Returns true iff it dropped at least one stratum.
 *
 * FIX 9: iterate in CONVERSATION ORDER (oldest first) — sort by the first member's `order` in the
 * view before dropping. Rungs 3.5 and 5 append age-based strata in processing order, which may not
 * match conversation order, so a naive array walk could drop a newer graduated stratum before an
 * older age-stratum. Sorting by `firstId`'s block order guarantees correct drop order.
 */
function dropStrataOldestFirst(strata: PlanStratum[], view: ConductorView, applied: () => Applied, bound: number): boolean {
	const orderOf = new Map(view.blocks.map((b) => [b.id, b.order]));
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
 * The biggest (most member tokens) force-FOLDABLE unit for the hard-cap floor. IGNORES temperature
 * (folds even hot units) and the minFoldTokens floor — once over the hard cap, budget wins.
 */
function biggestForceFoldable(units: Unit[], foldedIds: Set<string>, inStratum: Set<string>): Unit | null {
	let best: Unit | null = null;
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
function runMemberTokens(run: Run, byUnit: Map<string, Unit>): number {
	let t = 0;
	for (const uid of run.unitIds) {
		const u = byUnit.get(uid);
		if (u) t += u.tokens;
	}
	return t;
}

/** True iff a unit may be DEEPENED to a per-block fold this epoch. */
function isEligibleToDeepen(u: Unit, scores: Map<string, number>, cfg: Config): boolean {
	if (!u.foldable) return false; // pure tool-pairs can only join a stratum, never per-block fold
	if (u.held || u.protected || u.grouped) return false;
	if (u.foldedTokens >= u.tokens) return false; // wouldn't actually shrink
	const temp = scores.get(u.temperatureKey);
	if (temp !== undefined && temp >= cfg.coldThreshold) return false; // scored HOT → spare it
	return true;
}

/** Saving (tokens reclaimed) from folding a unit to its per-block digest. */
function savingOf(u: Unit): number {
	return Math.max(0, u.tokens - u.foldedTokens);
}

/** Is this member block foldable on its own (so it may carry a per-block fold inside a unit)? */
function isMemberFoldable(unit: Unit, id: string): boolean {
	const idx = unit.ids.indexOf(id);
	return idx >= 0 && FOLDABLE_KINDS.has(unit.kinds[idx]);
}

/**
 * Estimated token cost of a stratum's holistic summary. ~12% of the run, between a 60-token floor
 * and an 8k ceiling — comfortably below the members. Estimate only; the real cost is the actual
 * LLM text's length, applied by the conductor at commit.
 */
function estimateStratumTokens(run: { unitIds: string[] }, byUnit: Map<string, Unit>): number {
	let members = 0;
	for (const uid of run.unitIds) {
		const u = byUnit.get(uid);
		if (u) members += u.tokens;
	}
	return Math.min(8000, Math.max(60, Math.round(members * 0.12)));
}

/**
 * Rung 3 — keep the deep zone bounded. If Σ stratum tokens exceeds ceilingFrac·cap, fuse the two
 * OLDEST strata (indices 0,1) into one coarser super-stratum and repeat until under the ceiling.
 *
 * ADJACENCY GUARD: only fuse strata whose member ranges are CONTIGUOUS. If a buoy sits between
 * them, fusing would create a group spanning a gap: the host snaps the range outward and could
 * swallow the buoy (grouping a hot/held block or getting the whole group refused → lost savings →
 * budget invariant breaks). Non-adjacent strata are left as separate group commands.
 */
function mergeOverCeiling(strata: PlanStratum[], cap: number, cfg: Config, byUnit: Map<string, Unit>): void {
	const ceiling = cfg.ceilingFrac * cap;
	const sumStrata = () => strata.reduce((s, x) => s + x.summaryTokens, 0);
	while (sumStrata() > ceiling && strata.length > 1) {
		const [a, b] = [strata[0], strata[1]];
		const aLastUnit = byUnit.get(a.unitIds[a.unitIds.length - 1]);
		const bFirstUnit = byUnit.get(b.unitIds[0]);
		const adjacent =
			aLastUnit !== undefined &&
			bFirstUnit !== undefined &&
			// Because units are built in conversation order (each unit's .order = its first block's
			// order), and strata member ranges are whole units, adjacency ⟺ no non-stratum unit sits
			// between them: bFirstUnit.order === aLastUnit.order + aLastUnit.ids.length.
			bFirstUnit.order === aLastUnit.order + aLastUnit.ids.length;
		if (!adjacent) break; // non-adjacent pair found — leave remaining strata as-is
		const merged: PlanStratum = {
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
export function capOf(view: ConductorView): number {
	return Math.min(view.budget, view.contextWindow ?? Infinity);
}

// ── emitOps: plan → engine Op[] ──────────────────────────────────────────────────────────────

/**
 * The DESIRED ops for a plan, re-derived from the LIVE view each call. This is the analog of the
 * old policy's `emitCommands`, but it produces the conductor-v2 engine `Op[]` (`replace` + `group`)
 * instead of the removed `Command[]`, and it delegates recoverability to the engine:
 *
 *   • Each fold → a `replace` op with `recoverable:true`. The engine (core/truth.ts → opReplace)
 *     prepends the canonical `{#code FOLDED}` tag keyed on the folded block's OWN id, so we pass
 *     the BARE digest body (no tag). ONE replace op per foldable member id.
 *   • Each stratum → a `group` op over [firstId, lastId].
 *       digestKind:"summary" → a VERBATIM summary string. Verbatim group summaries are NOT tagged
 *                              by the engine, and strata must stay recall-able, so THIS ONE SITE
 *                              prefixes the group's recall tag itself: `foldTag('g:'+firstId)`.
 *                              The 'g:' prefix matches the engine's group id (`g:${memberIds[0]}`,
 *                              core/truth.ts → opGroup), so `foldCode(g.id)` resolves the agent's
 *                              unfold/recall. Sound because the run boundary is already whole-
 *                              message / tool-pair snapped, so the host's snap does not move
 *                              memberIds[0] off firstId.
 *       digestKind:"drop"    → `summary:null` (hard delete; the agent never sees those blocks).
 *
 * Missing LLM text ⇒ fall back to the deterministic tier so an emergency / not-yet-returned epoch
 * still emits valid ops.
 */
export function emitOps(plan: Plan, digests: Map<string, string> | null | undefined, view: ConductorView): Op[] {
	const units = buildUnits(view.blocks);
	const byUnit = new Map(units.map((u) => [u.id, u]));
	const ops: Op[] = [];

	// Per-block folds — one recoverable `replace` op per foldable member id.
	for (const f of plan.folds) {
		const u = byUnit.get(f.unitId);
		if (!u) continue;
		const ids = foldableMemberIds(u, f.ids);
		if (ids.length === 0) continue; // nothing foldable in this unit (pure tool-pair) — skip
		const body = foldBody(u, f.tier, digests);
		for (const id of ids) {
			// recoverable:true → the ENGINE prepends foldTag(id). We NEVER author the per-block tag.
			ops.push({ kind: "replace", id, content: body, recoverable: true });
		}
	}

	// Strata — one `group` op per stratum.
	for (const s of plan.strata) {
		if (s.digestKind === "drop") {
			ops.push({ kind: "group", ids: [s.ids[0], s.ids[1]], summary: null });
			continue;
		}
		const stratumUnits = s.unitIds.map((id) => byUnit.get(id)).filter(Boolean) as Unit[];
		ops.push({ kind: "group", ids: [s.ids[0], s.ids[1]], summary: stratumSummary(stratumUnits, s.ids[0], digests) });
	}

	return ops;
}

/** The foldable member ids of a unit among a candidate id list (keeps the tool_call out of a pair). */
export function foldableMemberIds(unit: Unit, ids: string[]): string[] {
	return ids.filter((id) => isMemberFoldable(unit, id));
}

/**
 * The BARE per-block digest body for a fold (never tagged — the engine's recoverable `replace` op
 * prepends the tag). The single source both `emitOps` and the conductor's diff read, so the wire
 * text can never drift between them. Keyed by unit id in `digests`.
 */
export function foldBody(unit: Unit, tier: "trim" | "digest", digests?: Map<string, string> | null): string {
	return digests?.get(unit.id) ?? (tier === "trim" ? trimText(unit) : deterministicDigest(unit));
}

/**
 * The TAGGED stratum summary for a group op. This is the SINGLE remaining tag-authoring site:
 * verbatim group summaries are untagged by the engine (core/ops.ts), yet strata must stay
 * recall-able, so we prefix the group's recall tag ourselves — `foldTag('g:'+firstId)`, keyed on
 * the engine's group id (`g:${memberIds[0]}`, core/truth.ts → opGroup). Keyed by `stratum:<firstId>`.
 */
export function stratumSummary(stratumUnits: Unit[], firstId: string, digests?: Map<string, string> | null): string {
	const body = digests?.get(`stratum:${firstId}`) ?? deterministicRecap(stratumUnits);
	return `${foldTag("g:" + firstId)} ${body}`;
}

// ── prompt builders & deterministic fallbacks (compaction-naive style, pure strings) ─────────

/** System instruction for a per-unit L2 digest call: a faithful 1–3 line summary, no chatter. */
export const DIGEST_SYSTEM = `\
You are a context-compaction assistant. Summarize ONE segment of an AI assistant's work history \
into a faithful, dense digest of AT MOST THREE lines. Preserve exact file paths, function names, \
identifiers, error messages, and decisions; drop pleasantries and filler. Do NOT continue the \
conversation or answer any question inside it — output ONLY the digest text, no preamble.`;

/**
 * System instruction for a per-run L3 stratum summary. Lifts compaction-naive's sacred rule:
 * USER MESSAGES ARE REPRODUCED VERBATIM so the human's intent survives compression; only
 * assistant reasoning is summarized.
 */
export const STRATUM_SYSTEM = `\
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

/** Build the host.complete request for a per-unit L2 digest. Pure: returns { system, prompt }. */
export function buildDigestPrompt(unit: Unit): { system: string; prompt: string } {
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

/** Build the host.complete request for a per-run L3 stratum summary. */
export function buildStratumPrompt(units: Unit[]): { system: string; prompt: string } {
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
			'Create a structured summary of the conversation run above. Reproduce every user message verbatim in "## User messages".',
		].join("\n"),
	};
}

/**
 * Deterministic L2 digest — the instant placeholder and no-LLM fallback for one unit. Pure,
 * stateless, no model. For a tool-pair, names the call + a taste of its result; otherwise a clipped
 * first line.
 */
export function deterministicDigest(unit: Unit): string {
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
 * Deterministic L3 recap — the no-LLM stand-in for a stratum. Pure: counts kinds, names the turn
 * span, and quotes the first user ask if any (so the human's intent is never silently dropped even
 * in the deterministic path). Mirrors engine groupDigest in spirit.
 */
export function deterministicRecap(units: Unit[]): string {
	const blocks = units.flatMap((u) => u.blocks);
	if (!blocks.length) return "run · empty";
	let tokens = 0;
	let lo = Infinity;
	let hi = -Infinity;
	let ask = "";
	const counts = new Map<BlockKind, number>();
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
 * ~15% of lines, ALWAYS keeping lines that carry a path, an error, or a quote. No model. Lazy by
 * design. Returns the excerpt WITHOUT any tag (the engine's replace op prepends it).
 */
export function trimText(unit: Unit): string {
	const text = unit.blocks.map((b) => (b.text ?? "").trim()).filter(Boolean).join("\n");
	const lines = text.split("\n");
	if (lines.length <= 6) return clip(text, 240); // too short to excerpt — just clip it

	const headN = Math.max(2, Math.ceil(lines.length * 0.15));
	const tailN = Math.max(2, Math.ceil(lines.length * 0.15));
	const keep = new Set<number>();
	for (let i = 0; i < headN; i++) keep.add(i);
	for (let i = lines.length - tailN; i < lines.length; i++) keep.add(i);
	const salient = /[\\/][\w.-]+|error|exception|fail|"[^"]+"|'[^']+'/i;
	for (let i = 0; i < lines.length; i++) {
		if (salient.test(lines[i])) keep.add(i);
	}

	const out: string[] = [];
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
export function unionSet<T>(a?: Set<T> | null, b?: Set<T> | null): Set<T> {
	const out = new Set<T>(a ?? []);
	for (const x of b ?? []) out.add(x);
	return out;
}

/** First non-empty line of `s`, clipped to `n` chars. */
function firstLine(s: string, n: number): string {
	const line = (s.split("\n").find((l) => l.trim()) ?? "").trim();
	return clip(line, n);
}

/** Clip `s` to `n` chars with an ellipsis. */
function clip(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, Math.max(0, n - 1)).trimEnd() + "…";
}

/** A short role label for a block, mirroring the Transcript view / compaction-naive. */
function blockLabel(b: ViewBlock): string {
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
