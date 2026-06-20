// policy.test.mjs — unit tests for the pure fold policy (node:test, no extra deps)
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideFolds, renderedTokens, foldCandidates, FOLDABLE_KINDS, DEFAULT_CFG } from "./policy.mjs";

/** ViewBlock factory */
function blk(o) {
	return {
		id: o.id,
		kind: o.kind ?? "tool_result",
		turn: o.turn ?? 0,
		order: o.order ?? 0,
		tokens: o.tokens ?? 1000,
		foldedTokens: o.foldedTokens ?? 50,
		held: !!o.held,
		folded: !!o.folded,
		protected: !!o.protected,
		grouped: !!o.grouped,
		text: o.text ?? o.id,
	};
}

/** Minimal view builder */
function view(blocks, { contextWindow = 100_000, budget = 100_000, liveTokens = 0, protectedFromIndex = 0, protectTokens = 20_000 } = {}) {
	return { blocks, contextWindow, budget, liveTokens, protectedFromIndex, protectTokens };
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. Hold under high-water
// ──────────────────────────────────────────────────────────────────────────────
test("hold under high-water: action===hold and foldSet empty", () => {
	// contextWindow = 100_000; highWater = 0.9 → threshold = 90_000
	// three blocks totalling 20_000 tokens — well under
	const blocks = [
		blk({ id: "a", tokens: 5_000, foldedTokens: 50 }),
		blk({ id: "b", tokens: 8_000, foldedTokens: 50 }),
		blk({ id: "c", tokens: 7_000, foldedTokens: 50 }),
	];
	const v = view(blocks, { contextWindow: 100_000 });
	const result = decideFolds(v, new Map(), new Set(), new Set(), DEFAULT_CFG);

	assert.equal(result.action, "hold");
	assert.equal(result.foldSet.size, 0);
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. Epoch over high-water folds down to ≤ low-water
// ──────────────────────────────────────────────────────────────────────────────
test("epoch over high-water folds rendered down to ≤ low-water", () => {
	// contextWindow = 100_000; highWater=0.9 → 90k; lowWater=0.7 → 70k
	// 10 big blocks × 10k each = 100k rendered — clearly over 90k
	const blocks = Array.from({ length: 10 }, (_, i) =>
		blk({ id: `b${i}`, tokens: 10_000, foldedTokens: 100, order: i })
	);
	const v = view(blocks, { contextWindow: 100_000 });
	const result = decideFolds(v, new Map(), new Set(), new Set(), DEFAULT_CFG);

	assert.equal(result.action, "epoch");
	assert.ok(result.rendered <= 0.7 * result.cap, `rendered ${result.rendered} should be ≤ lowWater ${0.7 * result.cap}`);
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. Lowest-attention folds first
// ──────────────────────────────────────────────────────────────────────────────
test("lowest-attention score folds first, highest score preserved", () => {
	// contextWindow = 100_000; blocks each 35k tokens.
	// rendered = 3 × 35k = 105k > 90k. One fold brings it to 70k+50 ≈ at/below low-water.
	const blocks = [
		blk({ id: "a", tokens: 35_000, foldedTokens: 50, order: 0 }),
		blk({ id: "b", tokens: 35_000, foldedTokens: 50, order: 1 }),
		blk({ id: "c", tokens: 35_000, foldedTokens: 50, order: 2 }),
	];
	const scores = new Map([["a", 0.1], ["b", 0.5], ["c", 0.9]]);
	const v = view(blocks, { contextWindow: 100_000 });
	const result = decideFolds(v, scores, new Set(), new Set(), DEFAULT_CFG);

	assert.equal(result.action, "epoch");
	// 'a' has lowest score → must be folded
	assert.ok(result.foldSet.has("a"), "lowest-score block 'a' should be folded");
	// 'c' has highest score → must NOT be folded (only one fold needed)
	assert.ok(!result.foldSet.has("c"), "highest-score block 'c' should NOT be folded");
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. Unscored fallback by FOLD_RANK
// ──────────────────────────────────────────────────────────────────────────────
test("unscored fallback: tool_result folds before text (FOLD_RANK order)", () => {
	// contextWindow = 100_000; blocks each 35k tokens: one tool_result, one thinking, one text.
	// Over high-water; no scores → unscored fallback uses FOLD_RANK.
	// FOLD_RANK: tool_result=0, thinking=1, text=2 → tool_result folds first.
	// Two folds brings rendered to 70k+100 ≈ at/below low-water, so text may not be needed.
	const blocks = [
		blk({ id: "tr", kind: "tool_result", tokens: 35_000, foldedTokens: 50, order: 0 }),
		blk({ id: "th", kind: "thinking",    tokens: 35_000, foldedTokens: 50, order: 1 }),
		blk({ id: "tx", kind: "text",        tokens: 35_000, foldedTokens: 50, order: 2 }),
	];
	// rendered = 105k > 90k; after one fold: 70050; after two: 35100.
	// lowWater = 70k → one fold (tool_result) puts us at 70050 which is > 70000, so two folds needed.
	// Actually: 105000 - 34950 = 70050 > 70000; need second fold → thinking gets folded too.
	// text (FOLD_RANK=2) should NOT be needed.
	const v = view(blocks, { contextWindow: 100_000 });
	const result = decideFolds(v, new Map(), new Set(), new Set(), DEFAULT_CFG);

	assert.equal(result.action, "epoch");
	assert.ok(result.foldSet.has("tr"), "tool_result id should be in foldSet");
	// Only one fold may be enough if rendered hits ≤ lowTok; text (highest FOLD_RANK) should not be touched
	// if tool_result + thinking suffice.
	assert.ok(!result.foldSet.has("tx"), "text id should NOT be in foldSet when lower-rank kinds suffice");
});

// ──────────────────────────────────────────────────────────────────────────────
// 5. Partial scores: scored-lowest first, unscored only after scored exhausted
// ──────────────────────────────────────────────────────────────────────────────
test("partial scores: scored blocks fold before unscored ones", () => {
	// 6 blocks × 20k each = 120k > 90k. lowWater = 70k.
	// Scored: s1=0.2, s2=0.6. Unscored: u1, u2, u3, u4.
	// Need to fold ~50k: one fold = 20k-50 ≈ 19950 savings.
	// Savings per fold: 19950. To drop from 120k to ≤70k need ~50k in savings → ~3 folds.
	// Scored candidates sorted ascending: s1(0.2) then s2(0.6).
	// After folding s1: 120k-19950 = 100050 > 70k → fold s2: 100050-19950=80100 > 70k → fold u1 (unscored).
	// So: s1 ∈ foldSet (lowest scored), s2 ∈ foldSet, at least one unscored ∈ foldSet.
	const blocks = [
		blk({ id: "s1", tokens: 20_000, foldedTokens: 50, order: 0 }),
		blk({ id: "s2", tokens: 20_000, foldedTokens: 50, order: 1 }),
		blk({ id: "u1", tokens: 20_000, foldedTokens: 50, order: 2 }),
		blk({ id: "u2", tokens: 20_000, foldedTokens: 50, order: 3 }),
		blk({ id: "u3", tokens: 20_000, foldedTokens: 50, order: 4 }),
		blk({ id: "u4", tokens: 20_000, foldedTokens: 50, order: 5 }),
	];
	const scores = new Map([["s1", 0.2], ["s2", 0.6]]);
	const v = view(blocks, { contextWindow: 100_000 });
	const result = decideFolds(v, scores, new Set(), new Set(), DEFAULT_CFG);

	assert.equal(result.action, "epoch");
	// The lowest-scored scored block must be folded
	assert.ok(result.foldSet.has("s1"), "s1 (lowest scored) must be in foldSet");
	// Unscored blocks are only used after scored ones are exhausted — but we need 3 folds
	// and there are only 2 scored candidates, so at least one unscored must appear
	const hasAnyUnscored = ["u1", "u2", "u3", "u4"].some((id) => result.foldSet.has(id));
	assert.ok(hasAnyUnscored, "at least one unscored block must be folded after scored ones exhausted");
	// Crucially, s1 (lowest score) appears before any unscored
	assert.ok(result.foldSet.has("s1"), "s1 must be folded before unscored blocks are used");
});

// ──────────────────────────────────────────────────────────────────────────────
// 6. respectLive is never folded
// ──────────────────────────────────────────────────────────────────────────────
test("respectLive blocks are never folded even when over high-water", () => {
	// Only one big foldable candidate; it's in respectLive.
	const blocks = [
		blk({ id: "big", tokens: 95_000, foldedTokens: 50, order: 0 }),
		blk({ id: "small", tokens: 1_000, foldedTokens: 50, order: 1 }),
	];
	const respectLive = new Set(["big"]);
	const v = view(blocks, { contextWindow: 100_000 });
	const result = decideFolds(v, new Map([["big", 0.1]]), new Set(), respectLive, DEFAULT_CFG);

	// We're over high-water (96k > 90k) so action should be epoch
	assert.equal(result.action, "epoch");
	// 'big' must never appear in foldSet
	assert.ok(!result.foldSet.has("big"), "'big' in respectLive must not be folded");
});

// ──────────────────────────────────────────────────────────────────────────────
// 7. Never fold protected / held / grouped / already-folded / tool_call / user
// ──────────────────────────────────────────────────────────────────────────────
test("ineligible blocks (protected/held/grouped/folded/tool_call/user) never enter foldSet", () => {
	// All blocks are over budget but none are eligible to fold.
	const blocks = [
		blk({ id: "prot",    kind: "tool_result", tokens: 20_000, foldedTokens: 50, protected: true }),
		blk({ id: "held_b",  kind: "tool_result", tokens: 20_000, foldedTokens: 50, held: true }),
		blk({ id: "grp",     kind: "tool_result", tokens: 20_000, foldedTokens: 50, grouped: true }),
		blk({ id: "tcall",   kind: "tool_call",   tokens: 20_000, foldedTokens: 50 }),
		blk({ id: "usr",     kind: "user",        tokens: 20_000, foldedTokens: 50 }),
	];
	const v = view(blocks, { contextWindow: 100_000 });
	// rendered = 100k; highWater = 90k → over the band, but nothing is foldable
	const result = decideFolds(v, new Map(), new Set(), new Set(), DEFAULT_CFG);

	// Action may be 'epoch' (we're over), but foldSet must be empty (nothing eligible)
	assert.equal(result.foldSet.size, 0, "foldSet must be empty — no eligible candidates");
});

// ──────────────────────────────────────────────────────────────────────────────
// 8. Sticky + prune on hold
// ──────────────────────────────────────────────────────────────────────────────
test("sticky: previously folded id persists on hold; held block is pruned", () => {
	// Under high-water. appliedFoldSet contains 'y' which is a valid foldable block.
	const blocks = [
		blk({ id: "y", tokens: 1_000, foldedTokens: 50, held: false }),
		blk({ id: "z", tokens: 500,   foldedTokens: 50 }),
	];
	const v = view(blocks, { contextWindow: 100_000 });
	// rendered live: y contributes foldedTokens (50) since it's in appliedFoldSet + z=500 → 550
	// well under 90k → hold
	const result1 = decideFolds(v, new Map(), new Set(["y"]), new Set(), DEFAULT_CFG);
	assert.equal(result1.action, "hold");
	assert.ok(result1.foldSet.has("y"), "sticky: 'y' should remain in foldSet on hold");

	// Second call: 'y' is now held:true → should be pruned from foldSet
	const blocks2 = [
		blk({ id: "y", tokens: 1_000, foldedTokens: 50, held: true }), // human override
		blk({ id: "z", tokens: 500,   foldedTokens: 50 }),
	];
	const v2 = view(blocks2, { contextWindow: 100_000 });
	const result2 = decideFolds(v2, new Map(), new Set(["y"]), new Set(), DEFAULT_CFG);
	assert.ok(!result2.foldSet.has("y"), "held block 'y' must be pruned from foldSet");
});

// ──────────────────────────────────────────────────────────────────────────────
// 9. Cache-stability across holds
// ──────────────────────────────────────────────────────────────────────────────
test("cache-stability: two consecutive hold calls return identical foldSet", () => {
	const blocks = [
		blk({ id: "a", tokens: 1_000, foldedTokens: 50 }),
		blk({ id: "b", tokens: 1_000, foldedTokens: 50 }),
	];
	// Under high-water with an appliedFoldSet containing 'a'
	const v = view(blocks, { contextWindow: 100_000 });
	const appliedFoldSet = new Set(["a"]);

	const result1 = decideFolds(v, new Map(), appliedFoldSet, new Set(), DEFAULT_CFG);
	const result2 = decideFolds(v, new Map(), appliedFoldSet, new Set(), DEFAULT_CFG);

	assert.equal(result1.action, "hold");
	assert.equal(result2.action, "hold");

	const set1 = [...result1.foldSet].sort();
	const set2 = [...result2.foldSet].sort();
	assert.deepEqual(set1, set2, "foldSet must be identical across consecutive hold calls");
});

// ──────────────────────────────────────────────────────────────────────────────
// 10. contextWindow null falls back to budget
// ──────────────────────────────────────────────────────────────────────────────
test("contextWindow null falls back to budget for band calculation", () => {
	// budget = 100_000; contextWindow = null
	// blocks sum to 95k (over 90% of budget = 90k) → should still epoch
	const blocks = Array.from({ length: 10 }, (_, i) =>
		blk({ id: `b${i}`, tokens: 9_500, foldedTokens: 50, order: i })
	);
	const v = {
		blocks,
		contextWindow: null,
		budget: 100_000,
		liveTokens: 0,
		protectedFromIndex: 0,
		protectTokens: 20_000,
	};
	const result = decideFolds(v, new Map(), new Set(), new Set(), DEFAULT_CFG);

	assert.equal(result.action, "epoch", "should epoch when over budget (contextWindow null)");
	assert.equal(result.cap, 100_000, "cap should fall back to budget");
});

// ──────────────────────────────────────────────────────────────────────────────
// 14. Budget below contextWindow: band uses budget, not contextWindow
// ──────────────────────────────────────────────────────────────────────────────
test("user budget below contextWindow: band is computed from budget", () => {
	// contextWindow = 200_000 but user set budget = 100_000.
	// 10 blocks × 9_500 = 95_000 rendered — over 90% of budget (90k) → epoch.
	// If cap were contextWindow (200k), 95k would be 47.5% → hold (wrong).
	const blocks = Array.from({ length: 10 }, (_, i) =>
		blk({ id: `b${i}`, tokens: 9_500, foldedTokens: 50, order: i })
	);
	const v = view(blocks, { contextWindow: 200_000, budget: 100_000 });
	const result = decideFolds(v, new Map(), new Set(), new Set(), DEFAULT_CFG);

	assert.equal(result.cap, 100_000, "cap should be budget (the tighter ceiling)");
	assert.equal(result.action, "epoch", "should epoch against budget, not contextWindow");
	assert.ok(result.rendered <= 0.7 * 100_000, "rendered should fold down to ≤ lowWater of budget");
});

// ──────────────────────────────────────────────────────────────────────────────
// 11. Epoch grows monotonically (superset of appliedFoldSet)
// ──────────────────────────────────────────────────────────────────────────────
test("epoch grows monotonically: returned foldSet is superset of appliedFoldSet", () => {
	// appliedFoldSet has 'a'; view is over high-water so we need more folds.
	// 'a' is a valid foldable block that passes the prune check.
	const blocks = [
		blk({ id: "a", tokens: 40_000, foldedTokens: 50, order: 0 }),
		blk({ id: "b", tokens: 40_000, foldedTokens: 50, order: 1 }),
		blk({ id: "c", tokens: 40_000, foldedTokens: 50, order: 2 }),
	];
	// rendered with 'a' already folded: 50 + 40000 + 40000 = 80050 < 90000? No: 80050 < 90000 → hold!
	// Need more: use 4 blocks so rendered-with-a-folded is still over 90k.
	// 4 blocks × 40k = 160k; with 'a' folded: 50 + 40k + 40k + 40k = 120050 > 90k → epoch.
	const blocks2 = [
		blk({ id: "a", tokens: 40_000, foldedTokens: 50, order: 0 }),
		blk({ id: "b", tokens: 40_000, foldedTokens: 50, order: 1 }),
		blk({ id: "c", tokens: 40_000, foldedTokens: 50, order: 2 }),
		blk({ id: "d", tokens: 40_000, foldedTokens: 50, order: 3 }),
	];
	const v = view(blocks2, { contextWindow: 100_000 });
	const result = decideFolds(v, new Map(), new Set(["a"]), new Set(), DEFAULT_CFG);

	assert.equal(result.action, "epoch");
	assert.ok(result.foldSet.has("a"), "'a' from appliedFoldSet must remain in foldSet (monotonic)");
	assert.ok(result.foldSet.size > 1, "epoch must add at least one more fold on top of applied set");
});

// ──────────────────────────────────────────────────────────────────────────────
// 12. Best-effort when low-water unreachable
// ──────────────────────────────────────────────────────────────────────────────
test("best-effort when low-water unreachable: no throw, epoch with available folds", () => {
	// contextWindow = 100_000; lowWater = 70k.
	// Protected big block (90k) + small foldable block (10k).
	// rendered = 100k > 90k → epoch triggered.
	// But folding the one foldable block: 90050 + 50 = 90_100 → still > 70k (unreachable).
	// Should not throw, action===epoch, foldSet contains the small block.
	const blocks = [
		blk({ id: "prot_big", tokens: 90_000, foldedTokens: 50, protected: true }),
		blk({ id: "small",    tokens: 10_000, foldedTokens: 50 }),
	];
	const v = view(blocks, { contextWindow: 100_000 });

	let result;
	assert.doesNotThrow(() => {
		result = decideFolds(v, new Map(), new Set(), new Set(), DEFAULT_CFG);
	}, "decideFolds must not throw when low-water is unreachable");

	assert.equal(result.action, "epoch", "action should still be 'epoch'");
	assert.ok(result.foldSet.has("small"), "the one available foldable block must be in foldSet");
	// rendered may be > lowWater — that's the best-effort guarantee
	assert.ok(result.rendered > 0.7 * result.cap, "rendered stays above low-water (best-effort, not a failure)");
});

// ──────────────────────────────────────────────────────────────────────────────
// 13. Straggler (grouped but rendered LIVE) must count at FULL tokens
// ──────────────────────────────────────────────────────────────────────────────
test("straggler (grouped:true, folded:false) is NOT discounted — counts full tokens", () => {
	// A straggler is a member of a folded group whose tool-pair partner sits OUTSIDE the group:
	// the host renders it live at full tokens yet flags it grouped:true. renderedTokens must count
	// it full — discounting it would read fullness low and HOLD past the high-water mark.
	const straggler = blk({ id: "strag", tokens: 40_000, foldedTokens: 50, grouped: true, folded: false, order: 0 });
	const collapsed = blk({ id: "coll", tokens: 40_000, foldedTokens: 50, grouped: true, folded: true, order: 1 });
	const live = blk({ id: "live", tokens: 30_000, foldedTokens: 50, order: 2 });

	// straggler full (40k) + collapsed folded (50) + live full (30k) = 70_050 (NOT 30_100)
	assert.equal(renderedTokens([straggler, collapsed, live], new Set()), 40_000 + 50 + 30_000);

	// Band: 40k(strag) + 50(coll) + 30k(live) + 25k(live2) = 95_050 > 90_000 → epoch.
	const live2 = blk({ id: "live2", tokens: 25_000, foldedTokens: 50, order: 3 });
	const v = view([straggler, collapsed, live, live2], { contextWindow: 100_000 });
	const result = decideFolds(v, new Map(), new Set(), new Set(), DEFAULT_CFG);
	assert.equal(result.action, "epoch", "straggler's full tokens must push fullness over high-water → epoch");
	assert.ok(!result.foldSet.has("strag"), "a grouped straggler must never be folded");
});
