// policy.test.mjs — unit tests for Thermocline's pure policy core (node:test, no extra deps).
//
// Covers the load-bearing invariants from the v4 design brief:
//   • the HARD BUDGET INVARIANT (planEpoch drives project ≤ target; the drop-floor always frees
//     tokens; the planner terminates),
//   • BIGGEST-COLD-FIRST deepen ordering + the minFoldTokens skip,
//   • the FOLDABLE-KIND gate (never folds user / tool_call),
//   • TOOL-PAIR atomicity (one unit; a stratum takes the whole pair or neither),
//   • BUOY split + whole-message snap (a hot/held unit splits a run; no run crosses the tail),
//   • the DOUBLE GATE (cold-probe AND not-recalled, sustained K epochs; re-warm resets; ever-warm
//     needs 2K),
//   • foldCode determinism + the `{#xxxxxx FOLDED}` tag shape,
//   • emitCommands conforming to the contract (fold ids all foldable; group ids = [first,last];
//     drop → digest null).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
	foldCode,
	foldTag,
	buildUnits,
	project,
	planEpoch,
	updateGraduation,
	sedimentRuns,
	emitCommands,
	DEFAULT_CFG,
	FOLDABLE_KINDS,
} from "./policy.mjs";

// ── factories ───────────────────────────────────────────────────────────────────────────────

let _order = 0;
/** ViewBlock factory (auto-incrementing order unless given). */
function blk(o) {
	return {
		id: o.id,
		kind: o.kind ?? "text",
		turn: o.turn ?? 1,
		order: o.order ?? _order++,
		tokens: o.tokens ?? 1000,
		foldedTokens: o.foldedTokens ?? 40,
		toolName: o.toolName,
		callId: o.callId,
		isError: o.isError,
		held: !!o.held,
		folded: !!o.folded,
		protected: !!o.protected,
		grouped: !!o.grouped,
		text: o.text ?? o.id,
	};
}

/** Minimal ConductorView; liveTokens defaults to Σ full tokens. */
function view(blocks, opts = {}) {
	const liveTokens = opts.liveTokens ?? blocks.reduce((s, b) => s + b.tokens, 0);
	return {
		blocks,
		budget: opts.budget ?? 100_000,
		contextWindow: opts.contextWindow ?? null,
		liveTokens,
		protectedFromIndex: opts.protectedFromIndex ?? blocks.length,
		protectTokens: opts.protectTokens ?? 0,
	};
}

/** Fresh Thermocline policy state. */
function state(o = {}) {
	return {
		dwell: o.dwell ?? new Map(),
		graduated: o.graduated ?? new Set(),
		everWarm: o.everWarm ?? new Set(),
		agentTouched: o.agentTouched ?? new Set(),
		recalledThisEpoch: o.recalledThisEpoch ?? new Set(),
	};
}

const cap = (v) => Math.min(v.budget, v.contextWindow ?? Infinity);

// ──────────────────────────────────────────────────────────────────────────────────────────
// foldCode / foldTag
// ──────────────────────────────────────────────────────────────────────────────────────────
test("foldCode is deterministic, 6-char base36, and tag matches {#xxxxxx FOLDED}", () => {
	const id = "a:f2965ed9-1234-dead-beef-d93e8c55c59e:p0";
	const c1 = foldCode(id);
	const c2 = foldCode(id);
	assert.equal(c1, c2, "same id → same code");
	assert.match(c1, /^[0-9a-z]{6}$/, "6-char base36");
	assert.notEqual(foldCode("other-id"), c1, "different id → (almost surely) different code");
	assert.equal(foldTag(id), `{#${c1} FOLDED}`, "tag wraps the code");
	assert.match(foldTag(id), /^\{#[0-9a-z]{6} FOLDED\}$/, "tag shape");
});

// Reproduce the engine's FNV-1a by hand for one known input to prove the algorithm was copied
// exactly (any drift would break the agent's unfold/recall resolution).
test("foldCode matches the engine's FNV-1a algorithm exactly", () => {
	const ref = (id) => {
		let h = 0x811c9dc5;
		for (let i = 0; i < id.length; i++) {
			h ^= id.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
	};
	for (const id of ["m0:p0", "m12:r", "x", "", "tool-result-7"]) {
		assert.equal(foldCode(id), ref(id), `foldCode("${id}")`);
	}
});

// ──────────────────────────────────────────────────────────────────────────────────────────
// buildUnits — tool-pair atomicity
// ──────────────────────────────────────────────────────────────────────────────────────────
test("buildUnits: a tool_call + its tool_result (same callId) is ONE atomic unit", () => {
	_order = 0;
	const blocks = [
		blk({ id: "u", kind: "user" }),
		blk({ id: "call", kind: "tool_call", callId: "c1", tokens: 200, toolName: "read_file" }),
		blk({ id: "res", kind: "tool_result", callId: "c1", tokens: 5000 }),
		blk({ id: "t", kind: "text", tokens: 800 }),
	];
	const units = buildUnits(blocks);
	assert.equal(units.length, 3, "user, [call+res] pair, text → 3 units");

	const pair = units.find((x) => x.ids.includes("call"));
	assert.deepEqual(pair.ids, ["call", "res"], "the pair's ids are the call then the result");
	assert.equal(pair.tokens, 5200, "pair tokens are summed");
	assert.equal(pair.temperatureKey, "res", "the result id scores the pair's temperature");
	assert.equal(pair.foldable, false, "a pure call+result pair is NOT a per-block-foldable unit");

	// Order is preserved and continuous.
	assert.deepEqual(units.map((x) => x.id), ["u", "call", "t"]);
});

test("buildUnits: a lone tool_result (no matching call) is its own foldable unit", () => {
	_order = 0;
	const blocks = [blk({ id: "loned", kind: "tool_result", callId: "zzz", tokens: 3000 })];
	const units = buildUnits(blocks);
	assert.equal(units.length, 1);
	assert.equal(units[0].foldable, true, "a tool_result alone is foldable");
});

// ──────────────────────────────────────────────────────────────────────────────────────────
// project — explicit-set arithmetic
// ──────────────────────────────────────────────────────────────────────────────────────────
test("project subtracts fold savings and stratum savings from liveTokens, no double-count", () => {
	_order = 0;
	const blocks = [
		blk({ id: "a", tokens: 10_000, foldedTokens: 50 }),
		blk({ id: "b", tokens: 10_000, foldedTokens: 50 }),
		blk({ id: "c", tokens: 10_000, foldedTokens: 50 }),
	];
	const v = view(blocks); // liveTokens = 30_000
	assert.equal(project(v, { foldedIds: new Set(), strata: [] }), 30_000, "no folds → baseline");

	// Fold 'a': saves 10_000-50 = 9_950 → 20_050.
	assert.equal(project(v, { foldedIds: new Set(["a"]), strata: [] }), 20_050);

	// Stratum over b+c (20_000 members, 200-token summary): saves 19_800 → 30_000-19_800 = 10_200.
	const proj = project(v, {
		foldedIds: new Set(),
		strata: [{ memberIds: ["b", "c"], summaryTokens: 200 }],
	});
	assert.equal(proj, 10_200);
});

// ──────────────────────────────────────────────────────────────────────────────────────────
// BUDGET INVARIANT — planEpoch drives project ≤ target, and terminates
// ──────────────────────────────────────────────────────────────────────────────────────────
test("budget invariant: planEpoch folds rendered down to ≤ lowWater·cap when possible", () => {
	_order = 0;
	// 10 cold text blocks × 10k = 100k; cap = 100k; lowWater target = 70k.
	const blocks = Array.from({ length: 10 }, (_, i) =>
		blk({ id: `b${i}`, tokens: 10_000, foldedTokens: 50, order: i }),
	);
	const v = view(blocks, { budget: 100_000, contextWindow: 100_000 });
	const scores = new Map(blocks.map((b) => [b.id, 0.05])); // all cold
	const plan = planEpoch(v, scores, state(), DEFAULT_CFG);

	assert.ok(plan.projected <= plan.targetTokens, `projected ${plan.projected} ≤ target ${plan.targetTokens}`);
	assert.ok(plan.projected <= cap(v), `projected ${plan.projected} ≤ HARD cap ${cap(v)}`);
	assert.equal(plan.targetTokens, 0.7 * cap(v));
});

test("budget invariant: a tiny budget with a stratum present uses the drop-floor and terminates", () => {
	_order = 0;
	// A long cold run that has already graduated (so it sediments into a stratum), plus a budget
	// far below even one stratum + the run. The only way down is the drop floor.
	const N = 8;
	const blocks = Array.from({ length: N }, (_, i) =>
		blk({ id: `g${i}`, kind: "text", tokens: 9_000, foldedTokens: 50, order: i, folded: true }),
	);
	const v = view(blocks, { budget: 4_000, contextWindow: 4_000, protectedFromIndex: N });
	const scores = new Map(blocks.map((b) => [b.id, 0.02])); // all cold
	// All graduated (dwell already satisfied) so sedimentRuns yields one stratum.
	const st = state({
		dwell: new Map(blocks.map((b) => [b.id, DEFAULT_CFG.K])),
	});
	// The CALLER owns graduation now: advance dwell exactly once and feed the graduated set in.
	const graduated = updateGraduation(st, v, scores, DEFAULT_CFG).graduated;

	let plan;
	assert.doesNotThrow(() => {
		plan = planEpoch(v, scores, st, DEFAULT_CFG, { graduated }); // must not infinite-loop
	}, "planEpoch must terminate even when target is unreachable");

	// A stratum exists and the floor must have dropped it (digest null on emit).
	assert.ok(plan.strata.length >= 1, "a graduated cold run produced a stratum");
	assert.ok(
		plan.strata.some((s) => s.digestKind === "drop"),
		"with the target unreachable, the oldest stratum is dropped (the floor that guarantees progress)",
	);
	// HARD-CAP INVARIANT: the plan must drive projected ≤ the HARD cap (here there is no protected
	// tail, so the floor can fully close the gap).
	const appliedFromPlan = {
		foldedIds: new Set(plan.folds.flatMap((f) => f.ids)),
		strata: plan.strata.map((s) => ({ memberIds: s.memberIds, summaryTokens: s.summaryTokens })),
	};
	assert.ok(project(v, appliedFromPlan) <= cap(v), `projected ${project(v, appliedFromPlan)} ≤ hard cap ${cap(v)}`);
});

test("budget invariant: drop-floor strictly reduces projected tokens vs keeping the summary", () => {
	_order = 0;
	const N = 6;
	const blocks = Array.from({ length: N }, (_, i) =>
		blk({ id: `g${i}`, kind: "text", tokens: 8_000, foldedTokens: 50, order: i, folded: true }),
	);
	const v = view(blocks, { budget: 3_000, contextWindow: 3_000, protectedFromIndex: N });
	const scores = new Map(blocks.map((b) => [b.id, 0.02]));
	const st = state({ dwell: new Map(blocks.map((b) => [b.id, DEFAULT_CFG.K])) });
	const graduated = updateGraduation(st, v, scores, DEFAULT_CFG).graduated;
	const plan = planEpoch(v, scores, st, DEFAULT_CFG, { graduated });

	// project with the dropped stratum (summaryTokens 0) must be below project with a summary cost.
	const droppedProj = project(v, {
		foldedIds: new Set(),
		strata: plan.strata.map((s) => ({ memberIds: s.memberIds, summaryTokens: s.summaryTokens })),
	});
	const keptProj = project(v, {
		foldedIds: new Set(),
		strata: plan.strata.map((s) => ({ memberIds: s.memberIds, summaryTokens: 200 })),
	});
	assert.ok(droppedProj < keptProj, "dropping (summaryTokens→0) frees more than keeping a summary");
});

// ──────────────────────────────────────────────────────────────────────────────────────────
// BIGGEST-COLD-FIRST + minFoldTokens skip
// ──────────────────────────────────────────────────────────────────────────────────────────
test("biggest-cold-first: a 20000-token cold unit folds before a 60-token one; tiny is skipped", () => {
	_order = 0;
	// Two cold units. The big one's saving clears one epoch. The tiny one's saving (60-40=20) is
	// below minFoldTokens (200) so it must be SKIPPED entirely.
	const big = blk({ id: "big", kind: "text", tokens: 20_000, foldedTokens: 50, order: 0 });
	const tiny = blk({ id: "tiny", kind: "text", tokens: 60, foldedTokens: 40, order: 1 });
	// Padding to get over the band but reachable by folding 'big' alone.
	// cap = 25_000; lowWater target = 17_500. live = 20_000+60 = 20_060 > target.
	// Folding 'big' → 20_060 - 19_950 = 110 ≤ target.
	const v = view([big, tiny], { budget: 25_000, contextWindow: 25_000 });
	const scores = new Map([
		["big", 0.05],
		["tiny", 0.05],
	]);
	const plan = planEpoch(v, scores, state(), DEFAULT_CFG);

	const foldedUnitIds = plan.folds.map((f) => f.unitId);
	assert.ok(foldedUnitIds.includes("big"), "the big cold unit is folded");
	assert.ok(!foldedUnitIds.includes("tiny"), "the tiny unit (saving < minFoldTokens) is skipped");
});

test("biggest-cold-first: ordering prefers larger saving, then colder, then older", () => {
	_order = 0;
	// Three cold foldable units of different savings; only need to fold the largest to hit target.
	const a = blk({ id: "a", kind: "text", tokens: 5_000, foldedTokens: 50, order: 0 });
	const b = blk({ id: "b", kind: "text", tokens: 30_000, foldedTokens: 50, order: 1 });
	const c = blk({ id: "c", kind: "text", tokens: 8_000, foldedTokens: 50, order: 2 });
	// cap = 50_000, target = 35_000. live = 43_000 > target. Fold 'b' (saving 29_950) → 13_050 ≤ target.
	const v = view([a, b, c], { budget: 50_000, contextWindow: 50_000 });
	const scores = new Map([
		["a", 0.1],
		["b", 0.1],
		["c", 0.1],
	]);
	const plan = planEpoch(v, scores, state(), DEFAULT_CFG);
	assert.equal(plan.folds[0].unitId, "b", "largest-saving unit is folded first");
});

// ──────────────────────────────────────────────────────────────────────────────────────────
// FOLDABLE-KIND gate
// ──────────────────────────────────────────────────────────────────────────────────────────
test("foldable-kind gate: planEpoch never folds a user or a lone tool_call", () => {
	_order = 0;
	// Big user + big lone tool_call — both non-foldable. Over budget, but nothing may be folded.
	const blocks = [
		blk({ id: "usr", kind: "user", tokens: 40_000, foldedTokens: 50, order: 0 }),
		blk({ id: "call", kind: "tool_call", callId: "c9", tokens: 40_000, foldedTokens: 50, order: 1 }),
	];
	const v = view(blocks, { budget: 50_000, contextWindow: 50_000 });
	const scores = new Map([
		["usr", 0.01],
		["c9", 0.01],
		["call", 0.01],
	]);
	const plan = planEpoch(v, scores, state(), DEFAULT_CFG);
	assert.equal(plan.folds.length, 0, "no fold targets a user or a lone tool_call");

	const cmds = emitCommands(plan, new Map(), v);
	const foldCmds = cmds.filter((c) => c.kind === "fold");
	assert.equal(foldCmds.length, 0, "no fold command emitted for non-foldable kinds");
});

test("foldable-kind gate: a fold command's ids are all foldable kinds", () => {
	_order = 0;
	const blocks = [
		blk({ id: "th", kind: "thinking", tokens: 30_000, foldedTokens: 50, order: 0 }),
		blk({ id: "tx", kind: "text", tokens: 30_000, foldedTokens: 50, order: 1 }),
	];
	const v = view(blocks, { budget: 40_000, contextWindow: 40_000 });
	const scores = new Map([
		["th", 0.05],
		["tx", 0.05],
	]);
	const plan = planEpoch(v, scores, state(), DEFAULT_CFG);
	const cmds = emitCommands(plan, new Map(), v);
	const byId = new Map(blocks.map((b) => [b.id, b]));
	for (const c of cmds.filter((c) => c.kind === "fold")) {
		for (const id of c.ids) {
			assert.ok(FOLDABLE_KINDS.has(byId.get(id).kind), `fold id ${id} must be a foldable kind`);
		}
	}
});

// ──────────────────────────────────────────────────────────────────────────────────────────
// TOOL-PAIR atomicity in strata
// ──────────────────────────────────────────────────────────────────────────────────────────
test("tool-pair atomicity: a stratum run includes the whole call+result pair or neither", () => {
	_order = 0;
	// A cold run of: text, [tool_call+tool_result], text — all graduated. The stratum's memberIds
	// must contain BOTH the call and its result (never one without the other).
	const blocks = [
		blk({ id: "t0", kind: "text", tokens: 4_000, order: 0, folded: true }),
		blk({ id: "call", kind: "tool_call", callId: "c1", tokens: 300, toolName: "grep", order: 1, folded: true }),
		blk({ id: "res", kind: "tool_result", callId: "c1", tokens: 6_000, order: 2, folded: true }),
		blk({ id: "t1", kind: "text", tokens: 4_000, order: 3, folded: true }),
	];
	const v = view(blocks, { protectedFromIndex: blocks.length });
	const scores = new Map([
		["t0", 0.02],
		["res", 0.02], // the pair scores on its result id
		["t1", 0.02],
	]);
	const units = buildUnits(blocks);
	const graduated = new Set(units.map((u) => u.id)); // all graduated
	const runs = sedimentRuns(v, scores, graduated, DEFAULT_CFG);

	assert.equal(runs.length, 1, "a single contiguous cold run");
	const m = runs[0].memberIds;
	assert.ok(m.includes("call") && m.includes("res"), "the pair is whole inside the stratum");
	assert.equal(runs[0].firstId, "t0", "run starts at the first member");
	assert.equal(runs[0].lastId, "t1", "run ends at the last member");
	assert.deepEqual(runs[0].unitIds, ["t0", "call", "t1"], "all three units (pair counts once) in the run");
});

// ──────────────────────────────────────────────────────────────────────────────────────────
// BUOY split + whole-message snap
// ──────────────────────────────────────────────────────────────────────────────────────────
test("buoy split: a hot unit between cold units splits the run into two strata", () => {
	_order = 0;
	const blocks = [
		blk({ id: "c0", kind: "text", tokens: 3_000, order: 0, folded: true }),
		blk({ id: "c1", kind: "text", tokens: 3_000, order: 1, folded: true }),
		blk({ id: "c2", kind: "text", tokens: 3_000, order: 2, folded: true }),
		blk({ id: "HOT", kind: "text", tokens: 3_000, order: 3, folded: false }), // a buoy
		blk({ id: "c3", kind: "text", tokens: 3_000, order: 4, folded: true }),
		blk({ id: "c4", kind: "text", tokens: 3_000, order: 5, folded: true }),
		blk({ id: "c5", kind: "text", tokens: 3_000, order: 6, folded: true }),
	];
	const v = view(blocks, { protectedFromIndex: blocks.length });
	const scores = new Map([
		["c0", 0.02], ["c1", 0.02], ["c2", 0.02],
		["HOT", 0.95], // hot → buoy
		["c3", 0.02], ["c4", 0.02], ["c5", 0.02],
	]);
	// Everything cold is graduated; HOT is not.
	const graduated = new Set(["c0", "c1", "c2", "c3", "c4", "c5"]);
	const runs = sedimentRuns(v, scores, graduated, DEFAULT_CFG);

	assert.equal(runs.length, 2, "the hot buoy splits the cold region into two runs");
	assert.deepEqual(runs[0].unitIds, ["c0", "c1", "c2"]);
	assert.deepEqual(runs[1].unitIds, ["c3", "c4", "c5"]);
	for (const r of runs) assert.ok(!r.memberIds.includes("HOT"), "the buoy is never inside a stratum");
});

test("buoy split: a held unit also splits the run", () => {
	_order = 0;
	const blocks = [
		blk({ id: "c0", kind: "text", tokens: 3_000, order: 0, folded: true }),
		blk({ id: "c1", kind: "text", tokens: 3_000, order: 1, folded: true }),
		blk({ id: "c2", kind: "text", tokens: 3_000, order: 2, folded: true }),
		blk({ id: "HELD", kind: "text", tokens: 3_000, order: 3, held: true, folded: false }),
		blk({ id: "c3", kind: "text", tokens: 3_000, order: 4, folded: true }),
		blk({ id: "c4", kind: "text", tokens: 3_000, order: 5, folded: true }),
		blk({ id: "c5", kind: "text", tokens: 3_000, order: 6, folded: true }),
	];
	const v = view(blocks, { protectedFromIndex: blocks.length });
	const scores = new Map(blocks.map((b) => [b.id, 0.02]));
	// HELD is graduated-cold by score but held — sediment must still treat it as a buoy because the
	// held flag is not in `graduated` (graduation resets it). Simulate that: it is NOT graduated.
	const graduated = new Set(["c0", "c1", "c2", "c3", "c4", "c5"]);
	const runs = sedimentRuns(v, scores, graduated, DEFAULT_CFG);
	assert.equal(runs.length, 2, "the held buoy splits the region");
});

test("whole-message snap: no run crosses into the protected tail", () => {
	_order = 0;
	// 6 cold units, but protectedFromIndex = 4 — the last two are the protected tail and must be
	// excluded from any stratum.
	const blocks = Array.from({ length: 6 }, (_, i) =>
		blk({ id: `c${i}`, kind: "text", tokens: 3_000, order: i, folded: true, protected: i >= 4 }),
	);
	const v = view(blocks, { protectedFromIndex: 4 });
	const scores = new Map(blocks.map((b) => [b.id, 0.02]));
	const graduated = new Set(["c0", "c1", "c2", "c3"]); // tail units never graduate
	const runs = sedimentRuns(v, scores, graduated, DEFAULT_CFG);

	assert.equal(runs.length, 1);
	assert.deepEqual(runs[0].unitIds, ["c0", "c1", "c2", "c3"], "run stops at the tail boundary");
	assert.ok(!runs[0].memberIds.includes("c4") && !runs[0].memberIds.includes("c5"), "tail excluded");
});

// ──────────────────────────────────────────────────────────────────────────────────────────
// DOUBLE GATE — graduation
// ──────────────────────────────────────────────────────────────────────────────────────────
test("double gate: a cold + not-recalled folded unit graduates only after K epochs", () => {
	_order = 0;
	const blocks = [blk({ id: "x", kind: "text", tokens: 3_000, order: 0, folded: true })];
	const v = view(blocks);
	const scores = new Map([["x", 0.02]]); // cold

	let st = state();
	// Run K epochs, threading dwell forward each time.
	for (let i = 1; i <= DEFAULT_CFG.K; i++) {
		const g = updateGraduation(st, v, scores, DEFAULT_CFG);
		assert.equal(g.dwell.get("x"), i, `dwell advances to ${i}`);
		if (i < DEFAULT_CFG.K) assert.ok(!g.graduated.has("x"), `not graduated before K (epoch ${i})`);
		else assert.ok(g.graduated.has("x"), "graduated at K");
		st = state({ dwell: g.dwell });
	}
});

test("double gate ②: an agent recall this epoch resets dwell and blocks graduation", () => {
	_order = 0;
	const blocks = [blk({ id: "x", kind: "text", tokens: 3_000, order: 0, folded: true })];
	const v = view(blocks);
	const scores = new Map([["x", 0.02]]); // still cold

	// Pretend dwell already reached K-1; now the agent recalls it → reset to 0, not graduated.
	const st = state({
		dwell: new Map([["x", DEFAULT_CFG.K - 1]]),
		recalledThisEpoch: new Set(["x"]),
	});
	const g = updateGraduation(st, v, scores, DEFAULT_CFG);
	assert.equal(g.dwell.get("x"), 0, "agent recall resets the dwell clock");
	assert.ok(!g.graduated.has("x"), "a recalled unit does not graduate");
});

test("double gate ①: a re-warm (temp rises above coldThreshold) resets dwell", () => {
	_order = 0;
	const blocks = [blk({ id: "x", kind: "text", tokens: 3_000, order: 0, folded: true })];
	const v = view(blocks);
	const st = state({ dwell: new Map([["x", DEFAULT_CFG.K - 1]]) });
	const hot = new Map([["x", 0.9]]); // re-warmed
	const g = updateGraduation(st, v, hot, DEFAULT_CFG);
	assert.equal(g.dwell.get("x"), 0, "a hot re-score resets the clock");
	assert.ok(!g.graduated.has("x"));
});

test("double gate: a not-yet-folded cold unit does not accumulate dwell (gate ② is behavioral)", () => {
	_order = 0;
	const blocks = [blk({ id: "x", kind: "text", tokens: 3_000, order: 0, folded: false })];
	const v = view(blocks);
	const scores = new Map([["x", 0.02]]);
	const st = state({ dwell: new Map([["x", 2]]) });
	const g = updateGraduation(st, v, scores, DEFAULT_CFG);
	assert.equal(g.dwell.get("x"), 0, "an unfolded unit cannot progress toward graduation");
});

test("double gate: an ever-warm unit needs 2K epochs, not K", () => {
	_order = 0;
	const blocks = [blk({ id: "x", kind: "text", tokens: 3_000, order: 0, folded: true })];
	const v = view(blocks);
	const scores = new Map([["x", 0.02]]);

	// At exactly K epochs it must NOT yet graduate (ever-warm needs 2K).
	let st = state({ everWarm: new Set(["x"]), dwell: new Map([["x", DEFAULT_CFG.K - 1]]) });
	let g = updateGraduation(st, v, scores, DEFAULT_CFG);
	assert.equal(g.dwell.get("x"), DEFAULT_CFG.K);
	assert.ok(!g.graduated.has("x"), "ever-warm unit not graduated at K");

	// At 2K it graduates.
	st = state({ everWarm: new Set(["x"]), dwell: new Map([["x", 2 * DEFAULT_CFG.K - 1]]) });
	g = updateGraduation(st, v, scores, DEFAULT_CFG);
	assert.equal(g.dwell.get("x"), 2 * DEFAULT_CFG.K);
	assert.ok(g.graduated.has("x"), "ever-warm unit graduates at 2K");
});

// ──────────────────────────────────────────────────────────────────────────────────────────
// emitCommands — contract shapes
// ──────────────────────────────────────────────────────────────────────────────────────────
test("emitCommands: per-unit fold carries the recoverable tag + the LLM digest when given", () => {
	_order = 0;
	const blocks = [
		blk({ id: "tx", kind: "text", tokens: 30_000, foldedTokens: 50, order: 0 }),
		blk({ id: "tx2", kind: "text", tokens: 30_000, foldedTokens: 50, order: 1 }),
	];
	const v = view(blocks, { budget: 40_000, contextWindow: 40_000 });
	const scores = new Map([["tx", 0.05], ["tx2", 0.05]]);
	const plan = planEpoch(v, scores, state(), DEFAULT_CFG);
	const digests = new Map(plan.folds.map((f) => [f.unitId, `LLM summary of ${f.unitId}`]));
	const cmds = emitCommands(plan, digests, v);

	const fold = cmds.find((c) => c.kind === "fold");
	assert.ok(fold, "a fold command exists");
	assert.equal(fold.digest, `${foldTag(fold.ids[0])} LLM summary of ${fold.ids[0]}`, "tag + LLM body");
	assert.match(fold.digest, /^\{#[0-9a-z]{6} FOLDED\} /, "digest starts with a fold tag");
});

test("emitCommands: a fold falls back to the deterministic digest when no LLM text is supplied", () => {
	_order = 0;
	const blocks = [blk({ id: "tx", kind: "text", tokens: 30_000, foldedTokens: 50, order: 0, text: "line one\nline two" })];
	const v = view(blocks, { budget: 35_000, contextWindow: 35_000 });
	const plan = planEpoch(v, new Map([["tx", 0.05]]), state(), DEFAULT_CFG);
	const cmds = emitCommands(plan, new Map(), v); // no digests → deterministic
	const fold = cmds.find((c) => c.kind === "fold");
	assert.ok(fold, "a fold command exists with deterministic body");
	assert.match(fold.digest, /^\{#[0-9a-z]{6} FOLDED\} /, "still tagged for recoverability");
	assert.ok(fold.digest.includes("line one"), "deterministic digest keeps the head line");
});

test("emitCommands: a stratum group spans [first,last] and a drop stratum carries digest null", () => {
	_order = 0;
	const N = 5;
	const blocks = Array.from({ length: N }, (_, i) =>
		blk({ id: `g${i}`, kind: "text", tokens: 8_000, foldedTokens: 50, order: i, folded: true, text: `body ${i}` }),
	);
	// Tiny budget forces the drop floor on the (only) stratum.
	const v = view(blocks, { budget: 2_000, contextWindow: 2_000, protectedFromIndex: N });
	const scores = new Map(blocks.map((b) => [b.id, 0.02]));
	const st = state({ dwell: new Map(blocks.map((b) => [b.id, DEFAULT_CFG.K])) });
	const graduated = updateGraduation(st, v, scores, DEFAULT_CFG).graduated;
	const plan = planEpoch(v, scores, st, DEFAULT_CFG, { graduated });
	const cmds = emitCommands(plan, new Map(), v);

	const group = cmds.find((c) => c.kind === "group");
	assert.ok(group, "a group command exists for the stratum");
	assert.equal(group.ids.length, 2, "group ids are exactly [first, last]");
	assert.equal(group.ids[0], "g0", "first id is the run's first member");
	assert.equal(group.digest, null, "the dropped stratum carries digest null (hard delete)");
});

test("emitCommands: a non-dropped stratum group carries a recoverable tagged summary", () => {
	_order = 0;
	const N = 4;
	// A cold run that graduates but the budget is generous enough NOT to drop it (keeps a summary).
	const blocks = Array.from({ length: N }, (_, i) =>
		blk({ id: `g${i}`, kind: "text", tokens: 9_000, foldedTokens: 50, order: i, folded: true, text: `body ${i}` }),
	);
	const v = view(blocks, { budget: 100_000, contextWindow: 100_000, protectedFromIndex: N });
	const scores = new Map(blocks.map((b) => [b.id, 0.02]));
	const st = state({ dwell: new Map(blocks.map((b) => [b.id, DEFAULT_CFG.K])) });
	const graduated = updateGraduation(st, v, scores, DEFAULT_CFG).graduated;
	const plan = planEpoch(v, scores, st, DEFAULT_CFG, { graduated });
	const cmds = emitCommands(plan, new Map([[`stratum:g0`, "holistic run summary"]]), v);

	const group = cmds.find((c) => c.kind === "group");
	assert.ok(group, "a group exists for the graduated run");
	assert.equal(group.digest, `${foldTag("g0")} holistic run summary`, "tag + holistic summary");
});

// ──────────────────────────────────────────────────────────────────────────────────────────
// graduated runs are not also per-block folded (no double action)
// ──────────────────────────────────────────────────────────────────────────────────────────
test("a graduated run becomes a stratum, not a set of per-block folds", () => {
	_order = 0;
	const N = 5;
	const blocks = Array.from({ length: N }, (_, i) =>
		blk({ id: `g${i}`, kind: "text", tokens: 9_000, foldedTokens: 50, order: i, folded: true }),
	);
	const v = view(blocks, { budget: 40_000, contextWindow: 40_000, protectedFromIndex: N });
	const scores = new Map(blocks.map((b) => [b.id, 0.02]));
	const st = state({ dwell: new Map(blocks.map((b) => [b.id, DEFAULT_CFG.K])) });
	const graduated = updateGraduation(st, v, scores, DEFAULT_CFG).graduated;
	const plan = planEpoch(v, scores, st, DEFAULT_CFG, { graduated });

	assert.ok(plan.strata.length >= 1, "the graduated cold run sediments into at least one stratum");
	const foldedUnitIds = new Set(plan.folds.map((f) => f.unitId));
	const stratumUnitIds = new Set(plan.strata.flatMap((s) => s.unitIds));
	for (const id of stratumUnitIds) {
		assert.ok(!foldedUnitIds.has(id), `unit ${id} is in a stratum, so it must not also be per-block folded`);
	}
});

// ──────────────────────────────────────────────────────────────────────────────────────────
// AGE-BASED LAST-RESORT COMPACTION — budget invariant with empty/missing probe scores
// ──────────────────────────────────────────────────────────────────────────────────────────

test("empty-scores invariant: no probe, non-foldable pairs → age-based last resort produces strata", () => {
	_order = 0;
	// Use ONLY tool_call+tool_result PAIRS: paired units are NOT per-block foldable (the tool_call
	// can't fold), so Rung 1 (per-block folds) cannot help them at all. With scores=empty, nothing
	// graduates either. The ONLY path to budget is the age-based last-resort stratum (a group
	// command CAN absorb all kinds, including tool_call+tool_result pairs). This proves age-based
	// runs are needed and actually fire when per-block folds are unavailable.
	//
	// 8 pairs × (500 call + 9_500 result) = 80k total. Budget = 5k → target = 3.5k.
	const N = 8;
	const blocks = [];
	for (let i = 0; i < N; i++) {
		blocks.push(blk({ id: `call${i}`, kind: "tool_call", callId: `c${i}`, tokens: 500, foldedTokens: 30, order: i * 2, toolName: "read_file" }));
		blocks.push(blk({ id: `res${i}`, kind: "tool_result", callId: `c${i}`, tokens: 9_500, foldedTokens: 50, order: i * 2 + 1, folded: true }));
	}
	const v = view(blocks, { budget: 5_000, contextWindow: 5_000, protectedFromIndex: blocks.length });
	const scores = new Map(); // empty — no probe

	let plan;
	assert.doesNotThrow(() => {
		plan = planEpoch(v, scores, state(), DEFAULT_CFG);
	}, "planEpoch must terminate even with empty scores and non-foldable units");

	// No per-block folds should exist (paired units are not per-block foldable).
	assert.equal(plan.folds.length, 0, "no per-block folds: paired tool units are not foldable");

	// Age-based strata MUST have been produced.
	assert.ok(plan.strata.length >= 1, "age-based strata must be produced (no per-block folds possible, no graduation)");

	// And the plan must have reached budget (or hit the irreducible floor — but here there is no
	// protected tail, so the plan must fully close the gap).
	const applied = {
		foldedIds: new Set(plan.folds.flatMap((f) => f.ids)),
		strata: plan.strata.map((s) => ({ memberIds: s.memberIds, summaryTokens: s.summaryTokens })),
	};
	assert.ok(
		project(v, applied) <= plan.targetTokens,
		`projected ${project(v, applied)} must be ≤ targetTokens ${plan.targetTokens}`,
	);
	// HARD-CAP INVARIANT (the #1 requirement): never over the hard cap (no protected tail here, so
	// the planner must fully close the gap).
	assert.ok(project(v, applied) <= cap(v), `projected ${project(v, applied)} ≤ HARD cap ${cap(v)}`);
});

test("empty-scores invariant: no probe, already-at-fold-floor blocks → age-based last resort fires", () => {
	_order = 0;
	// Blocks where foldedTokens ≈ tokens: per-block folds save nothing (saving < minFoldTokens
	// floor), so Rung 1 skips them. With empty scores, graduation can't happen. Only age-based
	// last resort can form strata (which use group commands and absorb full member tokens).
	// 10 blocks × 5k tokens, foldedTokens = 4_999 → saving = 1 < minFoldTokens (200).
	const N = 10;
	const blocks = Array.from({ length: N }, (_, i) =>
		blk({ id: `f${i}`, kind: "text", tokens: 5_000, foldedTokens: 4_999, order: i }),
	);
	const v = view(blocks, { budget: 5_000, contextWindow: 5_000, protectedFromIndex: N });
	const scores = new Map(Object.entries({})); // empty

	let plan;
	assert.doesNotThrow(() => {
		plan = planEpoch(v, scores, state(), DEFAULT_CFG);
	});

	// Per-block folds: none (saving = 1 < minFoldTokens = 200).
	assert.equal(plan.folds.length, 0, "no per-block folds: saving below minFoldTokens for all units");

	// Age-based strata must exist.
	assert.ok(plan.strata.length >= 1, "age-based strata must be produced when per-block folds are skipped");

	const applied = {
		foldedIds: new Set(plan.folds.flatMap((f) => f.ids)),
		strata: plan.strata.map((s) => ({ memberIds: s.memberIds, summaryTokens: s.summaryTokens })),
	};
	assert.ok(
		project(v, applied) <= plan.targetTokens,
		`projected ${project(v, applied)} must be ≤ targetTokens ${plan.targetTokens}`,
	);
	// HARD-CAP INVARIANT: projected ≤ the hard cap (no protected tail ⇒ gap fully closed).
	assert.ok(project(v, applied) <= cap(v), `projected ${project(v, applied)} ≤ HARD cap ${cap(v)}`);
});

test("deterministic/emergency invariant: opts.deterministic + non-foldable pairs still reaches budget", () => {
	_order = 0;
	// Emergency epoch: no LLM, no probe scores, non-foldable pairs (same shape as the first
	// empty-scores test but with opts.deterministic:true to exercise the emergency code path).
	const N = 8;
	const blocks = [];
	for (let i = 0; i < N; i++) {
		blocks.push(blk({ id: `ecall${i}`, kind: "tool_call", callId: `ec${i}`, tokens: 500, foldedTokens: 30, order: i * 2, toolName: "grep" }));
		blocks.push(blk({ id: `eres${i}`, kind: "tool_result", callId: `ec${i}`, tokens: 9_500, foldedTokens: 50, order: i * 2 + 1, folded: true }));
	}
	const v = view(blocks, { budget: 5_000, contextWindow: 5_000, protectedFromIndex: blocks.length });
	const scores = new Map(); // no probe

	let plan;
	assert.doesNotThrow(() => {
		plan = planEpoch(v, scores, state(), DEFAULT_CFG, { deterministic: true });
	}, "emergency epoch must terminate");

	// No per-block folds for non-foldable pairs.
	assert.equal(plan.folds.length, 0, "no per-block folds for paired tool units");

	// Age-based strata or drops must have appeared.
	assert.ok(plan.strata.length >= 1, "emergency epoch must produce strata via age-based last resort");

	const applied = {
		foldedIds: new Set(plan.folds.flatMap((f) => f.ids)),
		strata: plan.strata.map((s) => ({ memberIds: s.memberIds, summaryTokens: s.summaryTokens })),
	};
	assert.ok(
		project(v, applied) <= plan.targetTokens,
		`emergency epoch projected ${project(v, applied)} must be ≤ targetTokens ${plan.targetTokens}`,
	);
	// HARD-CAP INVARIANT in the emergency (deterministic) path too.
	assert.ok(project(v, applied) <= cap(v), `emergency projected ${project(v, applied)} ≤ HARD cap ${cap(v)}`);
});

test("deterministic/emergency invariant: deterministic folds use 'trim' tier inside age-based strata", () => {
	_order = 0;
	// When opts.deterministic is true, per-block folds should use the 'trim' tier.
	// We verify that: (a) the plan terminates, (b) any fold entries carry tier:'trim'.
	const N = 8;
	const blocks = Array.from({ length: N }, (_, i) =>
		blk({ id: `d${i}`, kind: "text", tokens: 8_000, foldedTokens: 60, order: i }),
	);
	// Budget generous enough that per-block folds suffice (scores non-empty so deepen candidates exist).
	const v = view(blocks, { budget: 50_000, contextWindow: 50_000, protectedFromIndex: N });
	const scores = new Map(blocks.map((b) => [b.id, 0.1])); // all cold
	const plan = planEpoch(v, scores, state(), DEFAULT_CFG, { deterministic: true });

	for (const f of plan.folds) {
		assert.equal(f.tier, "trim", `fold for unit ${f.unitId} should use 'trim' tier in deterministic mode`);
	}
});

test("last-resort dormancy: sufficient graduated strata means age-based path stays dormant", () => {
	_order = 0;
	// 10 blocks: the FIRST 6 are graduated-cold (will form a stratum large enough to hit target),
	// the LAST 4 are warm/un-graduated. If age-based last resort were incorrectly greedy, it would
	// also swallow the warm blocks. It must NOT, because the graduated stratum already meets budget.
	//
	// Setup: budget = 60k; live = 10 × 8k = 80k; target = 0.7 × 60k = 42k.
	// Graduated stratum over 6 blocks: 6×8k = 48k members, ~12% summary ≈ 5.8k → saves ~42.2k.
	// After the stratum: 80k - 42.2k ≈ 37.8k ≤ 42k → under target → last resort must NOT fire.
	const N = 10;
	const allBlocks = Array.from({ length: N }, (_, i) =>
		blk({ id: `h${i}`, kind: "text", tokens: 8_000, foldedTokens: 55, order: i, folded: i < 6 }),
	);
	const v = view(allBlocks, { budget: 60_000, contextWindow: 60_000, protectedFromIndex: N });
	const scores = new Map(allBlocks.map((b) => [b.id, 0.02])); // all cold
	// Only the first 6 are graduated (dwell = K). The last 4 are warm (dwell = 0, not graduated).
	const graduatedIds = allBlocks.slice(0, 6).map((b) => b.id);
	const st = state({
		dwell: new Map([
			...graduatedIds.map((id) => [id, DEFAULT_CFG.K]),
			...allBlocks.slice(6).map((b) => [b.id, 0]),
		]),
	});
	// Caller-owned graduation: the first 6 (cold, folded, dwell=K) graduate; the last 4 (dwell=0) do not.
	const graduated = updateGraduation(st, v, scores, DEFAULT_CFG).graduated;
	assert.equal(graduated.size, 6, "exactly the first 6 graduate this tick");

	const plan = planEpoch(v, scores, st, DEFAULT_CFG, { graduated });

	// The plan should be under target.
	const applied = {
		foldedIds: new Set(plan.folds.flatMap((f) => f.ids)),
		strata: plan.strata.map((s) => ({ memberIds: s.memberIds, summaryTokens: s.summaryTokens })),
	};
	assert.ok(
		project(v, applied) <= plan.targetTokens,
		`projected ${project(v, applied)} ≤ targetTokens ${plan.targetTokens}`,
	);

	// The 4 warm/un-graduated blocks (h6..h9) must NOT appear in any stratum.
	const ungraduatedIds = new Set(allBlocks.slice(6).map((b) => b.id));
	const allStratumMemberIds = new Set(plan.strata.flatMap((s) => s.memberIds));
	for (const id of ungraduatedIds) {
		assert.ok(
			!allStratumMemberIds.has(id),
			`un-graduated block ${id} must not be swallowed by a stratum (last resort must stay dormant)`,
		);
	}
});

// ──────────────────────────────────────────────────────────────────────────────────────────
// HARD-CAP FLOOR — the #1 invariant: live tokens ≤ min(budget, contextWindow) at ALL times.
// These cases are NOT reachable by the soft-target rungs (hot / sub-minRunUnits / multi-stratum),
// so they exercise the dedicated hard-cap floor (Rung 5) that ignores the attention/minFold/minRun
// gates once over the HARD cap.
// ──────────────────────────────────────────────────────────────────────────────────────────

/** Apply a plan to project() shape (folds → foldedIds, strata → {memberIds, summaryTokens}). */
function appliedOf(plan) {
	return {
		foldedIds: new Set(plan.folds.flatMap((f) => f.ids)),
		strata: plan.strata.map((s) => ({ memberIds: s.memberIds, summaryTokens: s.summaryTokens })),
	};
}

test("hard-cap floor: all-HOT foldable blocks over cap with NO protected tail are force-folded (normal mode)", () => {
	_order = 0;
	// Two big HOT text blocks (run length 2 < minRunUnits, so neither sedimentRuns nor the age-based
	// last resort can touch them) and no cold block to graduate. Rung 1 spares them (hot). Budget is
	// far below their sum. ONLY the hard-cap floor (force-fold ignoring temperature) can save this.
	const blocks = [
		blk({ id: "h1", kind: "text", tokens: 50_000, foldedTokens: 40, order: 0 }),
		blk({ id: "h2", kind: "text", tokens: 50_000, foldedTokens: 40, order: 1 }),
	];
	const v = view(blocks, { budget: 60_000, contextWindow: 60_000 }); // protectedFromIndex defaults to len ⇒ no tail
	const scores = new Map([
		["h1", 0.95], // hot
		["h2", 0.95], // hot
	]);
	const plan = planEpoch(v, scores, state(), DEFAULT_CFG);

	assert.ok(plan.folds.length >= 1, "the hard-cap floor force-folded at least one HOT block");
	assert.ok(
		project(v, appliedOf(plan)) <= cap(v),
		`projected ${project(v, appliedOf(plan))} ≤ HARD cap ${cap(v)} (hot content force-compressed)`,
	);
});

test("hard-cap floor: all-HOT foldable blocks over cap with NO protected tail are force-folded (deterministic mode)", () => {
	_order = 0;
	const blocks = [
		blk({ id: "h1", kind: "text", tokens: 50_000, foldedTokens: 40, order: 0 }),
		blk({ id: "h2", kind: "text", tokens: 50_000, foldedTokens: 40, order: 1 }),
	];
	const v = view(blocks, { budget: 60_000, contextWindow: 60_000 });
	const scores = new Map([
		["h1", 0.95],
		["h2", 0.95],
	]);
	const plan = planEpoch(v, scores, state(), DEFAULT_CFG, { deterministic: true });

	assert.ok(plan.folds.length >= 1, "the emergency hard-cap floor force-folded at least one HOT block");
	for (const f of plan.folds) assert.equal(f.tier, "trim", "deterministic folds use the trim tier");
	assert.ok(
		project(v, appliedOf(plan)) <= cap(v),
		`emergency projected ${project(v, appliedOf(plan))} ≤ HARD cap ${cap(v)}`,
	);
});

test("hard-cap floor: 3 surviving strata, budget so small that MORE THAN ONE must drop (bug-b fix)", () => {
	_order = 0;
	// Three graduated cold runs separated by tiny PROTECTED hot buoys (uncompressible, but a small
	// irreducible floor). ceilingFrac is raised so the merge never fuses the three strata. The budget
	// is far below even three summarized strata, so ALL THREE must be dropped to get under the hard
	// cap. The OLD Rung 4 dropped only strata[0] then `break`ed — this asserts >1 stratum drops.
	const CFG = { ...DEFAULT_CFG, ceilingFrac: 100 }; // effectively disable the ceiling merge
	const mkrun = (p, start) => [0, 1, 2].map((i) => blk({ id: `${p}${i}`, kind: "text", tokens: 2_000, foldedTokens: 50, order: start + i, folded: true }));
	const blocks = [
		...mkrun("A", 0),
		blk({ id: "H1", kind: "text", tokens: 200, order: 3, folded: false, protected: true }),
		...mkrun("B", 4),
		blk({ id: "H2", kind: "text", tokens: 200, order: 7, folded: false, protected: true }),
		...mkrun("C", 8),
	];
	const v = view(blocks, { budget: 1_000, contextWindow: 1_000, protectedFromIndex: blocks.length });
	const scores = new Map(blocks.map((b) => [b.id, b.id.startsWith("H") ? 0.95 : 0.02]));
	const st = state({ dwell: new Map(blocks.filter((b) => !b.id.startsWith("H")).map((b) => [b.id, CFG.K])) });
	const graduated = updateGraduation(st, v, scores, CFG).graduated;
	const plan = planEpoch(v, scores, st, CFG, { graduated });

	assert.equal(plan.strata.length, 3, "the three graduated runs stay separate (ceiling merge disabled)");
	const drops = plan.strata.filter((s) => s.digestKind === "drop").length;
	assert.ok(drops > 1, `MORE THAN ONE stratum must drop (got ${drops}) — proves the Rung-4 break bug is fixed`);
	assert.ok(
		project(v, appliedOf(plan)) <= cap(v),
		`projected ${project(v, appliedOf(plan))} ≤ HARD cap ${cap(v)}`,
	);
});

test("hard-cap floor: force-GROUPs a sub-minRunUnits run of non-foldable tool pairs over the hard cap", () => {
	_order = 0;
	// TWO tool_call+tool_result pairs (each a non-foldable unit) — only 2 units, below minRunUnits (3),
	// so the age-based last resort (which needs ≥ minRunUnits) cannot form a run. No per-block fold is
	// possible (pairs aren't foldable). The hard-cap floor's force-group (minUnits=1) is the only path.
	const blocks = [
		blk({ id: "call0", kind: "tool_call", callId: "c0", tokens: 500, foldedTokens: 30, order: 0, toolName: "read_file" }),
		blk({ id: "res0", kind: "tool_result", callId: "c0", tokens: 40_000, foldedTokens: 50, order: 1 }),
		blk({ id: "call1", kind: "tool_call", callId: "c1", tokens: 500, foldedTokens: 30, order: 2, toolName: "grep" }),
		blk({ id: "res1", kind: "tool_result", callId: "c1", tokens: 40_000, foldedTokens: 50, order: 3 }),
	];
	const v = view(blocks, { budget: 50_000, contextWindow: 50_000, protectedFromIndex: blocks.length });
	const scores = new Map(); // empty probe

	const plan = planEpoch(v, scores, state(), DEFAULT_CFG);
	assert.equal(plan.folds.length, 0, "no per-block folds possible for non-foldable tool pairs");
	assert.ok(plan.strata.length >= 1, "the hard-cap floor force-grouped a sub-minRunUnits run");
	assert.ok(
		project(v, appliedOf(plan)) <= cap(v),
		`projected ${project(v, appliedOf(plan))} ≤ HARD cap ${cap(v)}`,
	);
});

test("hard-cap floor: terminates at the protected-tail floor when the cap is unreachable (tail never touched)", () => {
	_order = 0;
	// A huge PROTECTED tail whose tokens ALONE exceed the hard cap. The floor can compress everything
	// OLDER than the tail (here: a user head, which a group command can absorb) but the protected tail
	// is host-absolute — the floor must terminate at it WITHOUT looping, even though the cap stays
	// unreachable. This proves the irreducible floor = "only the protected tail remains".
	const blocks = [
		blk({ id: "usr", kind: "user", tokens: 6_000, foldedTokens: 40, order: 0 }), // older than the tail
		blk({ id: "tail0", kind: "text", tokens: 40_000, foldedTokens: 40, order: 1, protected: true }),
		blk({ id: "tail1", kind: "text", tokens: 40_000, foldedTokens: 40, order: 2, protected: true }),
	];
	const v = view(blocks, { budget: 50_000, contextWindow: 50_000, protectedFromIndex: 1 });
	const scores = new Map([["usr", 0.02], ["tail0", 0.02], ["tail1", 0.02]]);

	let plan;
	assert.doesNotThrow(() => {
		plan = planEpoch(v, scores, state(), DEFAULT_CFG); // must terminate (provable progress to fixed point)
	}, "the hard-cap floor must terminate at the protected-tail floor, not loop");

	// The protected tail blocks are NEVER folded or swept into a stratum (host-absolute floor).
	const touched = new Set([...plan.folds.flatMap((f) => f.ids), ...plan.strata.flatMap((s) => s.memberIds)]);
	assert.ok(!touched.has("tail0") && !touched.has("tail1"), "the protected tail is never compressed by the floor");
	// The cap is genuinely unreachable (tail alone = 80k > 50k cap), so projected stays above cap —
	// but the planner terminated rather than spinning. That is the irreducible-floor guarantee.
	assert.ok(project(v, appliedOf(plan)) > cap(v), "cap unreachable: 80k protected tail exceeds the 50k cap");
});

// ──────────────────────────────────────────────────────────────────────────────────────────
// FLOAT-UP — planEpoch re-derives reversible folds from the CURRENT scores each call: a unit whose
// temperature recovered since last epoch is simply NOT re-folded (epoch-granularity float-up).
// Strata (the deep zone) are monotonic/irreversible and not part of this.
// ──────────────────────────────────────────────────────────────────────────────────────────
test("float-up: a unit cold one epoch and hot the next is folded then NOT re-folded (re-derived from current scores)", () => {
	_order = 0;
	// Two units; only one needs folding to reach target. Epoch 1: 'b' is cold and gets folded.
	// Epoch 2: 'b' has re-warmed (hot) — planEpoch re-derives candidates from the CURRENT scores and
	// must NOT fold it again; it folds the other cold unit instead. No monotonic fold set is carried.
	const a = blk({ id: "a", kind: "text", tokens: 30_000, foldedTokens: 50, order: 0 });
	const b = blk({ id: "b", kind: "text", tokens: 30_000, foldedTokens: 50, order: 1 });
	const v = view([a, b], { budget: 40_000, contextWindow: 40_000 }); // target 28k; folding one ⇒ ~30k? need one fold to pass
	// live = 60k, target = 28k. Folding ONE unit ⇒ 60k - 29_950 = 30_050 > 28k ⇒ folds BOTH if both cold.
	// Make it so folding the larger-saving one suffices: equal savings, so it folds in order until ≤ target.
	// We only assert WHICH unit is folded under each score map, not the count.

	// Epoch 1: both cold ⇒ biggest-cold-first folds 'a' then 'b' (equal saving, older first).
	const cold = new Map([["a", 0.05], ["b", 0.05]]);
	const p1 = planEpoch(v, cold, state(), DEFAULT_CFG);
	const folded1 = new Set(p1.folds.map((f) => f.unitId));
	assert.ok(folded1.has("b"), "epoch 1: 'b' is cold and folded");

	// Epoch 2: 'b' re-warmed (hot), 'a' still cold. Re-derived from CURRENT scores ⇒ 'b' is spared by
	// the attention-gated rungs; only 'a' is foldable. (We are NOT over the hard cap here — 'a' folded
	// alone leaves 30_050, under the 40k cap — so the hard-cap floor stays dormant and 'b' floats up.)
	const reWarm = new Map([["a", 0.05], ["b", 0.95]]);
	const p2 = planEpoch(v, reWarm, state(), DEFAULT_CFG);
	const folded2 = new Set(p2.folds.map((f) => f.unitId));
	assert.ok(!folded2.has("b"), "epoch 2: re-warmed 'b' is NOT re-folded (float-up — re-derived from current scores)");
	assert.ok(folded2.has("a"), "epoch 2: the still-cold 'a' is folded instead");
});
