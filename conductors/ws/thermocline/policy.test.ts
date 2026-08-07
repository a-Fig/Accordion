// policy.test.ts — unit tests for Thermocline's pure policy core (vitest, probe-independent).
//
// Ported from the pre-excision `policy.test.mjs` (commit dc037bc) and re-typed. Scores are injected
// as plain Maps, so nothing here spawns the probe. Covers the load-bearing invariants:
//   • the HARD BUDGET INVARIANT (planEpoch drives project ≤ cap; the drop-floor always frees tokens),
//   • BIGGEST-COLD-FIRST deepen ordering + the minFoldTokens skip,
//   • the FOLDABLE-KIND gate + TOOL-PAIR atomicity + BUOY split,
//   • the DOUBLE GATE (cold + not-recalled, sustained K epochs; re-warm reset; ever-warm 2K; FIX 8),
//   • FIX 9 (drop strata in conversation order) + FIX 7 (merge adjacency guard),
//   • the deterministic/emergency path + empty-scores age-based last resort,
//   • emitOps shapes: folds → recoverable `replace`, strata → tagged `group`, drop → `summary:null`.
import { describe, test, expect } from "vitest";
import {
	DEFAULT_CFG,
	buildUnits,
	project,
	planEpoch,
	updateGraduation,
	sedimentRuns,
	emitOps,
	FOLDABLE_KINDS,
	type ConductorView,
	type ViewBlock,
} from "./policy";
import { foldTag } from "../../../core/digest";

// ── factories ───────────────────────────────────────────────────────────────────────────────
let _order = 0;
function blk(o: Partial<ViewBlock> & { id: string }): ViewBlock {
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
		sent: o.sent ?? true,
		text: o.text ?? o.id,
	};
}

function view(blocks: ViewBlock[], opts: Partial<ConductorView> = {}): ConductorView {
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

function stateOf(o: { dwell?: Map<string, number>; graduated?: Set<string>; everWarm?: Set<string>; agentTouched?: Set<string>; recalledThisEpoch?: Set<string> } = {}) {
	return {
		dwell: o.dwell ?? new Map<string, number>(),
		graduated: o.graduated ?? new Set<string>(),
		everWarm: o.everWarm ?? new Set<string>(),
		agentTouched: o.agentTouched ?? new Set<string>(),
		recalledThisEpoch: o.recalledThisEpoch ?? new Set<string>(),
	};
}

const cap = (v: ConductorView) => Math.min(v.budget, v.contextWindow ?? Infinity);
const appliedOf = (plan: ReturnType<typeof planEpoch>) => ({
	foldedIds: new Set(plan.folds.flatMap((f) => f.ids)),
	strata: plan.strata.map((s) => ({ memberIds: s.memberIds, summaryTokens: s.summaryTokens })),
});

// ── buildUnits — tool-pair atomicity ─────────────────────────────────────────────────────────
describe("buildUnits", () => {
	test("a tool_call + its tool_result (same callId) is ONE atomic unit", () => {
		_order = 0;
		const blocks = [
			blk({ id: "u", kind: "user" }),
			blk({ id: "call", kind: "tool_call", callId: "c1", tokens: 200, toolName: "read_file" }),
			blk({ id: "res", kind: "tool_result", callId: "c1", tokens: 5000 }),
			blk({ id: "t", kind: "text", tokens: 800 }),
		];
		const units = buildUnits(blocks);
		expect(units.length).toBe(3);
		const pair = units.find((x) => x.ids.includes("call"))!;
		expect(pair.ids).toEqual(["call", "res"]);
		expect(pair.tokens).toBe(5200);
		expect(pair.temperatureKey).toBe("res"); // the pair scores on its result id
		expect(pair.foldable).toBe(false); // a pure call+result pair is NOT per-block foldable
		expect(units.map((x) => x.id)).toEqual(["u", "call", "t"]);
	});

	test("a lone tool_result (no matching call) is its own foldable unit", () => {
		_order = 0;
		const units = buildUnits([blk({ id: "loned", kind: "tool_result", callId: "zzz", tokens: 3000 })]);
		expect(units.length).toBe(1);
		expect(units[0].foldable).toBe(true);
	});
});

// ── project — explicit-set arithmetic ─────────────────────────────────────────────────────────
test("project subtracts fold + stratum savings from liveTokens, no double-count", () => {
	_order = 0;
	const blocks = [
		blk({ id: "a", tokens: 10_000, foldedTokens: 50 }),
		blk({ id: "b", tokens: 10_000, foldedTokens: 50 }),
		blk({ id: "c", tokens: 10_000, foldedTokens: 50 }),
	];
	const v = view(blocks);
	expect(project(v, { foldedIds: new Set(), strata: [] })).toBe(30_000);
	expect(project(v, { foldedIds: new Set(["a"]), strata: [] })).toBe(20_050);
	expect(project(v, { foldedIds: new Set(), strata: [{ memberIds: ["b", "c"], summaryTokens: 200 }] })).toBe(10_200);
});

// ── BUDGET INVARIANT ──────────────────────────────────────────────────────────────────────────
describe("budget invariant", () => {
	test("planEpoch folds rendered down to ≤ lowWater·cap when possible", () => {
		_order = 0;
		const blocks = Array.from({ length: 10 }, (_, i) => blk({ id: `b${i}`, tokens: 10_000, foldedTokens: 50, order: i }));
		const v = view(blocks, { budget: 100_000, contextWindow: 100_000 });
		const scores = new Map(blocks.map((b) => [b.id, 0.05]));
		const plan = planEpoch(v, scores, stateOf(), DEFAULT_CFG);
		expect(plan.projected).toBeLessThanOrEqual(plan.targetTokens);
		expect(plan.projected).toBeLessThanOrEqual(cap(v));
		expect(plan.targetTokens).toBe(0.7 * cap(v));
	});

	test("a tiny budget with a stratum uses the drop-floor and terminates", () => {
		_order = 0;
		const N = 8;
		const blocks = Array.from({ length: N }, (_, i) => blk({ id: `g${i}`, tokens: 9_000, foldedTokens: 50, order: i, folded: true }));
		const v = view(blocks, { budget: 4_000, contextWindow: 4_000, protectedFromIndex: N });
		const scores = new Map(blocks.map((b) => [b.id, 0.02]));
		const st = stateOf({ dwell: new Map(blocks.map((b) => [b.id, DEFAULT_CFG.K])) });
		const graduated = updateGraduation(st, v, scores, DEFAULT_CFG).graduated;
		const plan = planEpoch(v, scores, st, DEFAULT_CFG, { graduated });
		expect(plan.strata.length).toBeGreaterThanOrEqual(1);
		expect(plan.strata.some((s) => s.digestKind === "drop")).toBe(true);
		expect(project(v, appliedOf(plan))).toBeLessThanOrEqual(cap(v));
	});
});

// ── BIGGEST-COLD-FIRST + minFoldTokens ────────────────────────────────────────────────────────
describe("ladder ordering", () => {
	test("a big cold unit folds before a tiny one; the tiny one (< minFoldTokens) is skipped", () => {
		_order = 0;
		const big = blk({ id: "big", tokens: 20_000, foldedTokens: 50, order: 0 });
		const tiny = blk({ id: "tiny", tokens: 60, foldedTokens: 40, order: 1 });
		const v = view([big, tiny], { budget: 25_000, contextWindow: 25_000 });
		const scores = new Map([["big", 0.05], ["tiny", 0.05]]);
		const plan = planEpoch(v, scores, stateOf(), DEFAULT_CFG);
		const folded = plan.folds.map((f) => f.unitId);
		expect(folded).toContain("big");
		expect(folded).not.toContain("tiny");
	});

	test("ordering prefers larger saving, then colder, then older", () => {
		_order = 0;
		const a = blk({ id: "a", tokens: 5_000, foldedTokens: 50, order: 0 });
		const b = blk({ id: "b", tokens: 30_000, foldedTokens: 50, order: 1 });
		const c = blk({ id: "c", tokens: 8_000, foldedTokens: 50, order: 2 });
		const v = view([a, b, c], { budget: 50_000, contextWindow: 50_000 });
		const scores = new Map([["a", 0.1], ["b", 0.1], ["c", 0.1]]);
		const plan = planEpoch(v, scores, stateOf(), DEFAULT_CFG);
		expect(plan.folds[0].unitId).toBe("b");
	});
});

// ── FOLDABLE-KIND gate ────────────────────────────────────────────────────────────────────────
test("foldable-kind gate: planEpoch never folds a user or a lone tool_call", () => {
	_order = 0;
	const blocks = [
		blk({ id: "usr", kind: "user", tokens: 40_000, foldedTokens: 50, order: 0 }),
		blk({ id: "call", kind: "tool_call", callId: "c9", tokens: 40_000, foldedTokens: 50, order: 1 }),
	];
	const v = view(blocks, { budget: 50_000, contextWindow: 50_000 });
	const scores = new Map([["usr", 0.01], ["call", 0.01]]);
	const plan = planEpoch(v, scores, stateOf(), DEFAULT_CFG);
	expect(plan.folds.length).toBe(0);
	expect(emitOps(plan, new Map(), v).filter((o) => o.kind === "replace").length).toBe(0);
});

// ── TOOL-PAIR atomicity + BUOY split ──────────────────────────────────────────────────────────
test("tool-pair atomicity: a stratum run includes the whole call+result pair or neither", () => {
	_order = 0;
	const blocks = [
		blk({ id: "t0", kind: "text", tokens: 4_000, order: 0, folded: true }),
		blk({ id: "call", kind: "tool_call", callId: "c1", tokens: 300, toolName: "grep", order: 1, folded: true }),
		blk({ id: "res", kind: "tool_result", callId: "c1", tokens: 6_000, order: 2, folded: true }),
		blk({ id: "t1", kind: "text", tokens: 4_000, order: 3, folded: true }),
	];
	const v = view(blocks, { protectedFromIndex: blocks.length });
	const scores = new Map([["t0", 0.02], ["res", 0.02], ["t1", 0.02]]);
	const graduated = new Set(buildUnits(blocks).map((u) => u.id));
	const runs = sedimentRuns(v, scores, graduated, DEFAULT_CFG);
	expect(runs.length).toBe(1);
	expect(runs[0].memberIds).toContain("call");
	expect(runs[0].memberIds).toContain("res");
	expect(runs[0].unitIds).toEqual(["t0", "call", "t1"]);
});

test("buoy split: a hot unit between cold units splits the run into two strata", () => {
	_order = 0;
	const blocks = Array.from({ length: 7 }, (_, i) => blk({ id: i === 3 ? "HOT" : `c${i}`, tokens: 3_000, order: i, folded: i !== 3 }));
	const v = view(blocks, { protectedFromIndex: blocks.length });
	const scores = new Map(blocks.map((b) => [b.id, b.id === "HOT" ? 0.95 : 0.02]));
	const graduated = new Set(blocks.filter((b) => b.id !== "HOT").map((b) => b.id));
	const runs = sedimentRuns(v, scores, graduated, DEFAULT_CFG);
	expect(runs.length).toBe(2);
	for (const r of runs) expect(r.memberIds).not.toContain("HOT");
});

// ── MESSAGE-ATOM SNAP — a run may not start/end mid assistant-message ──────────────────────────
// Sibling parts of ONE assistant message share a messageKey (`a:m1:p0/p1/p2` → `a:m1`) but graduate
// independently. If a run starts or ends on a mid-message part whose siblings are hot buoys, Truth's
// group snap (core/truth.ts → snappedRange) would walk the boundary out to the whole message and pull
// the excluded siblings into the group. sedimentRuns must snap the run INWARD to message atoms so its
// member set is a FIXED POINT of that snap — the partial-message parts stay at their current fidelity.
test("message-atom snap: a run excludes partial-message clusters at BOTH edges (fixed point)", () => {
	_order = 0;
	// mA is split at the FRONT (mA:p0 hot, mA:p1 graduated); mE is split at the BACK (mE:p0 graduated,
	// mE:p1 hot). Only whole messages mB/mC/mD may survive into the stratum.
	const blocks = [
		blk({ id: "a:mA:p0", kind: "thinking", order: 0, tokens: 3_000 }), // HOT buoy
		blk({ id: "a:mA:p1", kind: "text", order: 1, tokens: 3_000, folded: true }), // front partial
		blk({ id: "a:mB:p0", kind: "text", order: 2, tokens: 3_000, folded: true }),
		blk({ id: "a:mC:p0", kind: "text", order: 3, tokens: 3_000, folded: true }),
		blk({ id: "a:mD:p0", kind: "text", order: 4, tokens: 3_000, folded: true }),
		blk({ id: "a:mE:p0", kind: "text", order: 5, tokens: 3_000, folded: true }), // back partial
		blk({ id: "a:mE:p1", kind: "thinking", order: 6, tokens: 3_000 }), // HOT buoy
	];
	const v = view(blocks, { protectedFromIndex: blocks.length });
	const scores = new Map(blocks.map((b) => [b.id, /p1$/.test(b.id) && b.kind === "thinking" ? 0.95 : b.id === "a:mA:p0" ? 0.95 : 0.02]));
	// Everything cold graduates; the two hot buoys (mA:p0, mE:p1) do not.
	const graduated = new Set(["a:mA:p1", "a:mB:p0", "a:mC:p0", "a:mD:p0", "a:mE:p0"]);
	const runs = sedimentRuns(v, scores, graduated, DEFAULT_CFG);

	expect(runs.length).toBe(1);
	const r = runs[0];
	// Only the three WHOLE middle messages survive — the mid-message parts are excluded, not absorbed.
	expect(r.unitIds).toEqual(["a:mB:p0", "a:mC:p0", "a:mD:p0"]);
	expect(r.firstId).toBe("a:mB:p0");
	expect(r.lastId).toBe("a:mD:p0");
	for (const excluded of ["a:mA:p0", "a:mA:p1", "a:mE:p0", "a:mE:p1"]) expect(r.memberIds).not.toContain(excluded);
});

// ── DOUBLE GATE ───────────────────────────────────────────────────────────────────────────────
describe("double-gate graduation", () => {
	test("a cold + not-recalled folded unit graduates only after K epochs", () => {
		_order = 0;
		const v = view([blk({ id: "x", tokens: 3_000, order: 0, folded: true })]);
		const scores = new Map([["x", 0.02]]);
		let st = stateOf();
		for (let i = 1; i <= DEFAULT_CFG.K; i++) {
			const g = updateGraduation(st, v, scores, DEFAULT_CFG);
			expect(g.dwell.get("x")).toBe(i);
			if (i < DEFAULT_CFG.K) expect(g.graduated.has("x")).toBe(false);
			else expect(g.graduated.has("x")).toBe(true);
			st = stateOf({ dwell: g.dwell });
		}
	});

	test("gate ②: an agent recall this epoch resets dwell and blocks graduation", () => {
		_order = 0;
		const v = view([blk({ id: "x", tokens: 3_000, order: 0, folded: true })]);
		const st = stateOf({ dwell: new Map([["x", DEFAULT_CFG.K - 1]]), recalledThisEpoch: new Set(["x"]) });
		const g = updateGraduation(st, v, new Map([["x", 0.02]]), DEFAULT_CFG);
		expect(g.dwell.get("x")).toBe(0);
		expect(g.graduated.has("x")).toBe(false);
	});

	test("gate ①: a re-warm resets dwell", () => {
		_order = 0;
		const v = view([blk({ id: "x", tokens: 3_000, order: 0, folded: true })]);
		const st = stateOf({ dwell: new Map([["x", DEFAULT_CFG.K - 1]]) });
		const g = updateGraduation(st, v, new Map([["x", 0.9]]), DEFAULT_CFG);
		expect(g.dwell.get("x")).toBe(0);
		expect(g.graduated.has("x")).toBe(false);
	});

	test("an ever-warm unit needs 2K epochs, not K", () => {
		_order = 0;
		const v = view([blk({ id: "x", tokens: 3_000, order: 0, folded: true })]);
		const scores = new Map([["x", 0.02]]);
		let g = updateGraduation(stateOf({ everWarm: new Set(["x"]), dwell: new Map([["x", DEFAULT_CFG.K - 1]]) }), v, scores, DEFAULT_CFG);
		expect(g.graduated.has("x")).toBe(false);
		g = updateGraduation(stateOf({ everWarm: new Set(["x"]), dwell: new Map([["x", 2 * DEFAULT_CFG.K - 1]]) }), v, scores, DEFAULT_CFG);
		expect(g.graduated.has("x")).toBe(true);
	});

	test("FIX 8: a recall/agentTouch on a NON-FIRST member id resets the unit's dwell", () => {
		_order = 0;
		const blocks = [
			blk({ id: "tcall", kind: "tool_call", callId: "cx", tokens: 200, order: 0, toolName: "grep", folded: true }),
			blk({ id: "tres", kind: "tool_result", callId: "cx", tokens: 4_000, order: 1, folded: true }),
		];
		const v = view(blocks, { protectedFromIndex: blocks.length });
		const scores = new Map([["tres", 0.02]]); // the pair scores on its result id
		// unit id = "tcall" (first block); the recall names the RESULT id ("tres") — a non-first member.
		const recall = updateGraduation(stateOf({ dwell: new Map([["tcall", DEFAULT_CFG.K - 1]]), recalledThisEpoch: new Set(["tres"]) }), v, scores, DEFAULT_CFG);
		expect(recall.dwell.get("tcall")).toBe(0);
		expect(recall.graduated.has("tcall")).toBe(false);
		const touch = updateGraduation(stateOf({ dwell: new Map([["tcall", DEFAULT_CFG.K - 1]]), agentTouched: new Set(["tres"]) }), v, scores, DEFAULT_CFG);
		expect(touch.dwell.get("tcall")).toBe(0);
	});
});

// ── FIX 9 — drop strata in CONVERSATION ORDER ────────────────────────────────────────────────
test("FIX 9: dropStrataOldestFirst drops the OLDER stratum first, even when it appears later in the plan array", () => {
	_order = 0;
	// runA (older, orders 0-5) is age-based → appended AFTER runB (newer, orders 7-12, graduated).
	// Array order is [runB, runA]; conversation order must drop runA (older) first.
	const mkPairRun = (p: string, start: number) => {
		const b: ViewBlock[] = [];
		for (let i = 0; i < 3; i++) {
			b.push(blk({ id: `${p}call${i}`, kind: "tool_call", callId: `${p}c${i}`, tokens: 100, foldedTokens: 10, order: start + i * 2, toolName: "fn", folded: true }));
			b.push(blk({ id: `${p}res${i}`, kind: "tool_result", callId: `${p}c${i}`, tokens: 3_000, foldedTokens: 50, order: start + i * 2 + 1, folded: true }));
		}
		return b;
	};
	const runA = mkPairRun("O", 0);
	const heldBuoy = blk({ id: "BUOY", kind: "text", tokens: 200, order: 6, held: true });
	const runB = mkPairRun("N", 7);
	const blocks = [...runA, heldBuoy, ...runB];
	const v = view(blocks, { budget: 2_500, contextWindow: 2_500, protectedFromIndex: blocks.length });
	const scores = new Map<string, number>([["BUOY", 0.95], ...["Ores0", "Ores1", "Ores2", "Nres0", "Nres1", "Nres2"].map((id) => [id, 0.02] as [string, number])]);
	const runBUnitIds = ["Ncall0", "Ncall1", "Ncall2"];
	const st = stateOf({ dwell: new Map(runBUnitIds.map((id) => [id, DEFAULT_CFG.K])) });
	const graduated = updateGraduation(st, v, scores, DEFAULT_CFG).graduated;
	const plan = planEpoch(v, scores, st, DEFAULT_CFG, { graduated });

	const strataA = plan.strata.find((s) => ["Ocall0", "Ocall1", "Ocall2"].includes(s.unitIds[0]))!;
	const strataB = plan.strata.find((s) => runBUnitIds.includes(s.unitIds[0]))!;
	expect(strataA.digestKind).toBe("drop"); // OLDER run dropped first (conversation order wins)
	expect(strataB.digestKind).not.toBe("drop");
});

// ── FIX 7 — merge adjacency guard ────────────────────────────────────────────────────────────
test("FIX 7: mergeOverCeiling does NOT merge two strata separated by a held buoy", () => {
	_order = 0;
	const mkrun = (prefix: string, start: number) => [0, 1, 2].map((i) => blk({ id: `${prefix}${i}`, kind: "text", tokens: 5_000, foldedTokens: 50, order: start + i, folded: true }));
	const runA = mkrun("A", 0);
	const buoy = blk({ id: "HOT", kind: "text", tokens: 100, order: 3, held: true });
	const runB = mkrun("B", 4);
	const blocks = [...runA, buoy, ...runB];
	const v = view(blocks, { budget: 100_000, contextWindow: 100_000, protectedFromIndex: blocks.length });
	const scores = new Map(blocks.map((b) => [b.id, b.id === "HOT" ? 0.95 : 0.02]));
	const st = stateOf({ dwell: new Map([...runA, ...runB].map((b) => [b.id, DEFAULT_CFG.K])) });
	const CFG = { ...DEFAULT_CFG, ceilingFrac: 0.001 }; // force the merge to WANT to fire
	const graduated = updateGraduation(st, v, scores, CFG).graduated;
	const plan = planEpoch(v, scores, st, CFG, { graduated });

	const groups = emitOps(plan, new Map(), v).filter((o) => o.kind === "group");
	expect(groups.length).toBeGreaterThanOrEqual(2); // two non-adjacent runs stay separate
	for (const g of groups) {
		if (g.kind !== "group") continue;
		const firstOrd = blocks.find((b) => b.id === g.ids[0])!.order;
		const lastOrd = blocks.find((b) => b.id === g.ids[1])!.order;
		expect(firstOrd < buoy.order && lastOrd > buoy.order).toBe(false); // never spans the buoy
	}
});

// ── deterministic / emergency + empty-scores age-based last resort ────────────────────────────
describe("deterministic + empty-scores invariants", () => {
	test("deterministic emergency with non-foldable pairs still reaches budget", () => {
		_order = 0;
		const N = 8;
		const blocks: ViewBlock[] = [];
		for (let i = 0; i < N; i++) {
			blocks.push(blk({ id: `ecall${i}`, kind: "tool_call", callId: `ec${i}`, tokens: 500, foldedTokens: 30, order: i * 2, toolName: "grep" }));
			blocks.push(blk({ id: `eres${i}`, kind: "tool_result", callId: `ec${i}`, tokens: 9_500, foldedTokens: 50, order: i * 2 + 1, folded: true }));
		}
		const v = view(blocks, { budget: 5_000, contextWindow: 5_000, protectedFromIndex: blocks.length });
		const plan = planEpoch(v, new Map(), stateOf(), DEFAULT_CFG, { deterministic: true });
		expect(plan.folds.length).toBe(0); // pairs are not per-block foldable
		expect(plan.strata.length).toBeGreaterThanOrEqual(1); // age-based last resort produced strata
		expect(project(v, appliedOf(plan))).toBeLessThanOrEqual(cap(v));
	});

	test("empty scores (no probe) → age-based last resort still keeps projection ≤ cap", () => {
		_order = 0;
		const N = 10;
		const blocks = Array.from({ length: N }, (_, i) => blk({ id: `f${i}`, kind: "text", tokens: 5_000, foldedTokens: 4_999, order: i }));
		const v = view(blocks, { budget: 5_000, contextWindow: 5_000, protectedFromIndex: N });
		const plan = planEpoch(v, new Map(), stateOf(), DEFAULT_CFG); // no scores at all
		expect(plan.folds.length).toBe(0); // saving (1) below minFoldTokens
		expect(plan.strata.length).toBeGreaterThanOrEqual(1);
		expect(project(v, appliedOf(plan))).toBeLessThanOrEqual(cap(v));
	});

	test("deterministic folds use the 'trim' tier", () => {
		_order = 0;
		const N = 8;
		const blocks = Array.from({ length: N }, (_, i) => blk({ id: `d${i}`, tokens: 8_000, foldedTokens: 60, order: i }));
		const v = view(blocks, { budget: 50_000, contextWindow: 50_000, protectedFromIndex: N });
		const scores = new Map(blocks.map((b) => [b.id, 0.1]));
		const plan = planEpoch(v, scores, stateOf(), DEFAULT_CFG, { deterministic: true });
		for (const f of plan.folds) expect(f.tier).toBe("trim");
	});
});

// ── IRREDUCIBLE OVERFLOW (P1-4) — the ladder gives up with projected still > cap ────────────────
//
// Every mover on the Rung-5 hard-cap floor excludes `held`/`protected`/`grouped` units BY DESIGN
// (biggestForceFoldable, ageBasedRuns) — Truth itself refuses to fold inside the protected tail. So
// when the protected tail alone (nothing else can ever move) already exceeds the cap, the ladder
// cannot terminate at "≤ cap" no matter how many rungs it tries. `planEpoch` must say so explicitly
// via `Plan.irreducible` rather than just returning a `projected` that silently exceeds `cap`.
describe("IRREDUCIBLE OVERFLOW (P1-4)", () => {
	test("planEpoch marks irreducible when the protected tail ALONE exceeds the cap — nothing moved", () => {
		_order = 0;
		const N = 10;
		// Every block is protected (both the per-block flag AND protectedFromIndex:0 agree) — the
		// ladder has NOTHING eligible to fold/group/drop at any rung.
		const blocks = Array.from({ length: N }, (_, i) => blk({ id: `p${i}`, tokens: 3_000, foldedTokens: 50, order: i, protected: true }));
		const v = view(blocks, { budget: 12_000, contextWindow: 12_000, protectedFromIndex: 0 });
		const plan = planEpoch(v, new Map(), stateOf(), DEFAULT_CFG, { deterministic: true });
		expect(plan.irreducible).toBe(true);
		expect(plan.projected).toBeGreaterThan(plan.cap);
		expect(plan.projected).toBe(30_000); // fully protected — the ladder touched nothing
		expect(plan.folds.length).toBe(0);
		expect(plan.strata.length).toBe(0);
	});

	test("planEpoch does NOT mark irreducible when the ladder CAN reach cap (nothing protected)", () => {
		_order = 0;
		const N = 10;
		const blocks = Array.from({ length: N }, (_, i) => blk({ id: `q${i}`, tokens: 3_000, foldedTokens: 50, order: i }));
		const v = view(blocks, { budget: 12_000, contextWindow: 12_000, protectedFromIndex: N }); // nothing protected
		const plan = planEpoch(v, new Map(), stateOf(), DEFAULT_CFG, { deterministic: true });
		expect(plan.irreducible).toBe(false);
		expect(plan.projected).toBeLessThanOrEqual(plan.cap);
	});

	test("raising the budget for the SAME protected-everything config clears irreducible", () => {
		_order = 0;
		const N = 10;
		const blocks = Array.from({ length: N }, (_, i) => blk({ id: `p${i}`, tokens: 3_000, foldedTokens: 50, order: i, protected: true }));
		const v = view(blocks, { budget: 40_000, contextWindow: 40_000, protectedFromIndex: 0 }); // 30k tail now fits
		const plan = planEpoch(v, new Map(), stateOf(), DEFAULT_CFG, { deterministic: true });
		expect(plan.irreducible).toBe(false);
		expect(plan.projected).toBe(30_000);
		expect(plan.projected).toBeLessThanOrEqual(plan.cap);
	});
});

// ── emitOps — engine op shapes + recoverability ──────────────────────────────────────────────
describe("emitOps", () => {
	test("a fold emits a recoverable `replace` op with the BARE body (engine adds the tag)", () => {
		_order = 0;
		const blocks = [blk({ id: "tx", kind: "text", tokens: 30_000, foldedTokens: 50, order: 0, text: "line one\nline two" })];
		const v = view(blocks, { budget: 35_000, contextWindow: 35_000 });
		const plan = planEpoch(v, new Map([["tx", 0.05]]), stateOf(), DEFAULT_CFG);
		const ops = emitOps(plan, new Map([["tx", "LLM digest of tx"]]), v);
		const rep = ops.find((o) => o.kind === "replace");
		expect(rep).toBeTruthy();
		if (rep?.kind === "replace") {
			expect(rep.id).toBe("tx");
			expect(rep.recoverable).toBe(true);
			expect(rep.content).toBe("LLM digest of tx"); // NO tag — the engine prepends foldTag(id)
			expect(rep.content).not.toMatch(/FOLDED/);
		}
	});

	test("a fold falls back to the deterministic digest when no LLM text is supplied", () => {
		_order = 0;
		const blocks = [blk({ id: "tx", kind: "text", tokens: 30_000, foldedTokens: 50, order: 0, text: "line one\nline two" })];
		const v = view(blocks, { budget: 35_000, contextWindow: 35_000 });
		const plan = planEpoch(v, new Map([["tx", 0.05]]), stateOf(), DEFAULT_CFG);
		const ops = emitOps(plan, new Map(), v);
		const rep = ops.find((o) => o.kind === "replace");
		expect(rep?.kind === "replace" && rep.content.includes("line one")).toBe(true);
	});

	test("a stratum emits a `group` op with a tag keyed on the GROUP id (g:firstId); a drop → summary null", () => {
		_order = 0;
		const N = 5;
		const blocks = Array.from({ length: N }, (_, i) => blk({ id: `g${i}`, kind: "text", tokens: 8_000, foldedTokens: 50, order: i, folded: true, text: `body ${i}` }));
		const tiny = view(blocks, { budget: 2_000, contextWindow: 2_000, protectedFromIndex: N });
		const scores = new Map(blocks.map((b) => [b.id, 0.02]));
		const st = stateOf({ dwell: new Map(blocks.map((b) => [b.id, DEFAULT_CFG.K])) });
		const gradTiny = updateGraduation(st, tiny, scores, DEFAULT_CFG).graduated;
		const dropOps = emitOps(planEpoch(tiny, scores, st, DEFAULT_CFG, { graduated: gradTiny }), new Map(), tiny);
		const dropGroup = dropOps.find((o) => o.kind === "group");
		expect(dropGroup?.kind === "group" && dropGroup.summary).toBe(null);

		const roomy = view(blocks, { budget: 100_000, contextWindow: 100_000, protectedFromIndex: N });
		const gradRoomy = updateGraduation(st, roomy, scores, DEFAULT_CFG).graduated;
		const keepOps = emitOps(planEpoch(roomy, scores, st, DEFAULT_CFG, { graduated: gradRoomy }), new Map([["stratum:g0", "holistic run summary"]]), roomy);
		const keepGroup = keepOps.find((o) => o.kind === "group");
		expect(keepGroup?.kind === "group" && keepGroup.summary).toBe(`${foldTag("g:g0")} holistic run summary`);
		// The tag encodes the GROUP id, NOT the bare first-member id.
		expect(keepGroup?.kind === "group" && keepGroup.summary!.startsWith(foldTag("g0"))).toBe(false);
	});

	test("every emitted replace id is a foldable kind", () => {
		_order = 0;
		const blocks = [
			blk({ id: "th", kind: "thinking", tokens: 30_000, foldedTokens: 50, order: 0 }),
			blk({ id: "tx", kind: "text", tokens: 30_000, foldedTokens: 50, order: 1 }),
		];
		const v = view(blocks, { budget: 40_000, contextWindow: 40_000 });
		const plan = planEpoch(v, new Map([["th", 0.05], ["tx", 0.05]]), stateOf(), DEFAULT_CFG);
		const byId = new Map(blocks.map((b) => [b.id, b]));
		for (const o of emitOps(plan, new Map(), v)) {
			if (o.kind === "replace") expect(FOLDABLE_KINDS.has(byId.get(o.id)!.kind)).toBe(true);
		}
	});
});
