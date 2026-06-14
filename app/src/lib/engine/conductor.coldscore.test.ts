/*
 * conductor.coldscore.test.ts — end-to-end behavioral tests for ColdScoreConductor
 * driven through the real AccordionStore (store.attach / store.refold).
 *
 * Pattern mirrors conductor.test.ts: build a ParsedSession, make a store, attach
 * ColdScoreConductor, and assert on store.isFolded / store.groups / store.liveTokens.
 *
 * What we test:
 *   1. Under-budget → returns [] (raw, nothing folded).
 *   2. Over-budget → folds enough to bring liveTokens ≤ budget (THE BUDGET GUARANTEE).
 *   3. Never folds tool_call, user, human-pinned, or protected-tail blocks.
 *   4. Lexical pre-unfold: old block sharing a distinctive file path with the protected
 *      tail text is kept live while a comparable non-matching block IS folded.
 *   5. Hysteresis: a block pre-unfolded in one pass is not immediately re-folded on the
 *      next pass (within cooldown) when budget still allows.
 *   6. Never emits a group command (auto-coalesce was removed from this conductor).
 *   7. Built-in remains selectable and unaffected after swapping conductors.
 */
import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import { ColdScoreConductor } from "$conductors/cold-score/cold-score";
import { BuiltinConductor } from "$conductors";
import { HYSTERESIS } from "$conductors/cold-score/cold-score";
import type { Block, ParsedSession } from "./types";
import type { ConductorView, ViewBlock } from "$conductors/contract";

// ── Test helpers ──────────────────────────────────────────────────────────────

function blk(
	i: number,
	kind: Block["kind"] = "text",
	tokens = 1000,
	extra: Partial<Block> = {},
): Block {
	return {
		id: `m${i}:p0`,
		kind,
		turn: i + 1,
		order: i,
		text: `block ${i} ` + "x".repeat(tokens * 4),
		tokens,
		override: null,
		autoFolded: false,
		by: null,
		...extra,
	};
}

function makeStore(blocks: Block[], budget = 70_000, protect = 20_000): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks,
		lineCount: 0,
		skipped: 0,
	};
	const s = new AccordionStore(parsed);
	s.setProtect(protect);
	s.setBudget(budget);
	return s;
}

// ── 1. Under-budget → raw ─────────────────────────────────────────────────────

describe("ColdScoreConductor — under budget returns raw", () => {
	it("returns [] (nothing folded) when live tokens ≤ budget", () => {
		// 5 blocks × 1000 tokens = 5000, budget = 70k → well under
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.attach(new ColdScoreConductor());

		expect(s.foldedCount).toBe(0);
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
		expect(s.blocks.every((b) => !s.isFolded(b))).toBe(true);
	});

	it("stays raw after refold when still under budget", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.attach(new ColdScoreConductor());
		s.refold();
		s.refold();

		expect(s.foldedCount).toBe(0);
	});
});

// ── 2. Budget guarantee ───────────────────────────────────────────────────────

describe("ColdScoreConductor — budget guarantee", () => {
	it("folds enough to bring liveTokens ≤ budget (basic fixture)", () => {
		// 20 blocks × 1000 = 20k; budget = 10k → must fold at least 10 blocks
		const blocks = Array.from({ length: 20 }, (_, i) => blk(i, "text", 1000));
		const s = makeStore(blocks, 10_000, 0);
		s.attach(new ColdScoreConductor());

		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
		expect(s.foldedCount).toBeGreaterThan(0);
	});

	it("budget guarantee holds with mixed kinds (tool_result, thinking, text)", () => {
		const blocks: Block[] = [];
		for (let i = 0; i < 6; i++) blocks.push(blk(i, "tool_result", 1000));
		for (let i = 6; i < 12; i++) blocks.push(blk(i, "thinking", 1000));
		for (let i = 12; i < 18; i++) blocks.push(blk(i, "text", 1000));
		// 18k total, budget 9k → must fold roughly half
		const s = makeStore(blocks, 9_000, 0);
		s.attach(new ColdScoreConductor());

		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
	});

	it("budget guarantee holds when nearly every block can be folded", () => {
		// 50 tool_result blocks, very tight budget
		const blocks = Array.from({ length: 50 }, (_, i) => blk(i, "tool_result", 2000));
		const s = makeStore(blocks, 5_000, 0);
		s.attach(new ColdScoreConductor());

		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
	});

	it("budget guarantee holds across multiple refold passes", () => {
		const blocks = Array.from({ length: 20 }, (_, i) => blk(i, "text", 1000));
		const s = makeStore(blocks, 10_000, 0);
		s.attach(new ColdScoreConductor());

		for (let i = 0; i < 5; i++) {
			s.refold();
			expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
		}
	});
});

// ── 3. Never folds forbidden block types ─────────────────────────────────────

describe("ColdScoreConductor — never folds forbidden blocks", () => {
	it("never folds a tool_call block", () => {
		// Mix of tool_result (foldable) and tool_call (never) — tight budget forces folding
		const blocks: Block[] = [];
		for (let i = 0; i < 5; i++) blocks.push(blk(i, "tool_call", 500, { callId: `c${i}` }));
		for (let i = 5; i < 10; i++) blocks.push(blk(i, "tool_result", 500, { callId: `c${i - 5}` }));
		const s = makeStore(blocks, 2_000, 0);
		s.attach(new ColdScoreConductor());

		for (const b of s.blocks) {
			if (b.kind === "tool_call") {
				expect(s.isFolded(b)).toBe(false);
			}
		}
	});

	it("never folds a user block", () => {
		const blocks: Block[] = [];
		for (let i = 0; i < 5; i++) blocks.push(blk(i, "user", 1000));
		for (let i = 5; i < 15; i++) blocks.push(blk(i, "text", 1000));
		// 15k total, budget 8k → must fold
		const s = makeStore(blocks, 8_000, 0);
		s.attach(new ColdScoreConductor());

		for (const b of s.blocks) {
			if (b.kind === "user") {
				expect(s.isFolded(b)).toBe(false);
			}
		}
	});

	it("never folds a human-pinned block", () => {
		const blocks = Array.from({ length: 15 }, (_, i) => blk(i, "text", 1000));
		const s = makeStore(blocks, 8_000, 0);
		s.pin("m0:p0");
		s.pin("m1:p0");
		s.attach(new ColdScoreConductor());

		expect(s.isFolded(s.get("m0:p0")!)).toBe(false);
		expect(s.isFolded(s.get("m1:p0")!)).toBe(false);
		expect(s.get("m0:p0")!.override).toBe("pinned");
	});

	it("never folds a protected-tail block", () => {
		// 20 blocks × 1000 = 20k; budget 10k; protect 5k → last 5 blocks are protected
		const blocks = Array.from({ length: 20 }, (_, i) => blk(i, "text", 1000));
		const s = makeStore(blocks, 10_000, 5_000);
		s.attach(new ColdScoreConductor());

		const pf = s.protectedFromIndex;
		expect(pf).toBeGreaterThan(0); // sanity: protection is active
		s.blocks.forEach((b, i) => {
			if (i >= pf) {
				expect(s.isFolded(b)).toBe(false);
			}
		});
		// Budget guarantee still holds
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
	});
});

// ── 4. Lexical pre-unfold ─────────────────────────────────────────────────────

describe("ColdScoreConductor — lexical pre-unfold", () => {
	it("keeps live a block whose identifier appears in the protected tail text", () => {
		/*
		 * Fixture:
		 *   blocks 0-14 = old text blocks at turn 1 (foldable), budget forces folding
		 *   block 0 = special: its text mentions "coldScoreEngine.ts" (a distinctive path)
		 *   block 1 = comparable old text block WITHOUT that path
		 *   protected tail (block 15) = text block at high turn mentioning "coldScoreEngine.ts"
		 *
		 * Expected: block 0 is kept live (lexically pre-unfolded); block 1 IS folded.
		 * Note: the lexical pre-unfold only restores blocks that the preliminary clamp DID fold.
		 * We must construct the budget so that block 0 would be cold-score-targeted for folding.
		 * tool_result has the lowest prior, so we use tool_result for the special block
		 * (folds first). To ensure it's in the preliminary clamp set, the budget must be tight
		 * enough to require folding it.
		 */
		const SPECIAL_PATH = "coldScoreEngine/internals/scoring.ts";
		const blocks: Block[] = [];

		// Block 0: old tool_result that mentions the special path (coldest kind → folds first)
		blocks.push({
			...blk(0, "tool_result", 1500),
			text: `reading file ${SPECIAL_PATH} for analysis`,
		});
		// Blocks 1-13: comparable old tool_result blocks (no special path)
		for (let i = 1; i < 14; i++) {
			blocks.push(blk(i, "tool_result", 1500));
		}
		// Block 14: protected tail — mentions the special path (turn = high)
		blocks.push({
			...blk(14, "text", 2000),
			turn: 100,
			text: `now refactoring ${SPECIAL_PATH} entry point`,
		});

		// Budget: 14 × 1500 + 2000 = 23000 total; we want only the tail live + ~3 more blocks,
		// so budget = 2000 (tail) + 3000 (a few non-matched) = 5000.
		// This forces the preliminary clamp to fold block 0 (coldest), then lexical pre-unfold
		// should restore it because it matches the tail's SPECIAL_PATH.
		const s = makeStore(blocks, 5_000, 2_500); // protect covers tail (2000 tok)
		s.attach(new ColdScoreConductor());

		const b0 = s.get("m0:p0")!;
		const b1 = s.get("m1:p0")!;

		// Block 0 should be kept live (lexically matched to the tail)
		// Block 1 should be folded (no match, colder in ranking)
		expect(s.isFolded(b1)).toBe(true); // b1 is folded (no lexical match)
		expect(s.isFolded(b0)).toBe(false); // b0 is kept live by lexical pre-unfold
	});
});

// ── 5. Hysteresis ─────────────────────────────────────────────────────────────

describe("ColdScoreConductor — hysteresis (unfold cooldown)", () => {
	it("a block pre-unfolded in one pass is not immediately re-folded on the next pass within cooldown", () => {
		/*
		 * Fixture for hysteresis. The budget must be achievable by folding all OTHER blocks
		 * without folding block 0 (the pre-unfolded one). Key arithmetic:
		 *
		 *   - Block 0: tool_result 1000 tok, mentions SPECIAL_PATH → gets lexically pre-unfolded
		 *   - Blocks 1-19: tool_result 1000 tok each (19 other foldable candidates)
		 *   - Tail block: 3000 tok, mentions SPECIAL_PATH (drives the lexical match)
		 *     turn = 100 → currentTurn = 100
		 *
		 *   protectTokens = 3500 → protectedFromIndex = last block(s) summing to ≥ 3500.
		 *     Tail (3000) < 3500 → pull in block 19 (1000): 4000 > 3500 * 1.25 = 4375? NO.
		 *     4000 ≥ 3500 → protectedFromIndex = 19. Blocks 0-18 foldable (19 candidates).
		 *
		 *   view.liveTokens = 20*1000 + 3000 = 23000. Budget = 6000.
		 *   Savings per fold ≈ 1000 - 27 = 973 tok.
		 *   To reach budget from 23000: need (23000-6000)/973 ≈ 18 folds.
		 *   With block 0 pre-unfolded: fold blocks 1-18 (18 folds): live ≈ 23000 - 18*973 = 5486 ≤ 6000 ✓
		 *
		 *   In the re-clamp after pre-unfold: block 0 is on cooldown → skip it.
		 *   Remaining non-folded candidates: blocks 1-18 (the 18 that aren't already folded).
		 *   After folding them, live ≈ 5486 ≤ 6000 → budget met without touching block 0.
		 *
		 *   On the SECOND refold(): conductor re-runs from scratch. Preliminary clamp folds
		 *   coldest-first. Block 0 still on cooldown? No — we're calling refold() with
		 *   the same T (currentTurn = 100, coolUntil = 100 + 5 = 105). T = 100 ≤ 105, so
		 *   block 0 IS still on cooldown. Re-clamp skips it; relaxed pass also skips it
		 *   (budget already met by the 18 other blocks). So block 0 stays live. ✓
		 */
		const SPECIAL_PATH = "coldScoreHysteresis/module.ts";
		const blocks: Block[] = [];

		// Block 0: old tool_result mentioning special path
		blocks.push({
			...blk(0, "tool_result", 1000),
			text: `processing ${SPECIAL_PATH} module`,
		});
		// Blocks 1-19: old tool_result blocks (enough to meet budget without block 0)
		for (let i = 1; i < 20; i++) {
			blocks.push(blk(i, "tool_result", 1000));
		}
		// Protected tail mentioning special path (turn=100 → currentTurn=100)
		blocks.push({
			...blk(20, "text", 3000),
			turn: 100,
			text: `current work on ${SPECIAL_PATH}`,
		});

		// Total: 20×1000 + 3000 = 23000. Budget = 6000. Protect = 3500.
		// protectedFromIndex = 19 (blocks 0-18 foldable, blocks 19-20 protected).
		// 18 folds (blocks 1-18) bring live ≈ 23000 - 18*973 = 5486 ≤ 6000 without block 0.
		const s = makeStore(blocks, 6_000, 3_500);
		const conductor = new ColdScoreConductor();
		s.attach(conductor);

		// Verify block 0 is live after first pass (lexically pre-unfolded)
		const b0 = s.get("m0:p0")!;
		expect(s.isFolded(b0)).toBe(false);

		// Run another refold — within cooldown (same T), block 0 should NOT be re-folded
		// because the re-clamp skips cooled-down blocks, and the relaxed pass doesn't
		// need to touch block 0 to reach budget.
		s.refold();
		expect(s.isFolded(s.get("m0:p0")!)).toBe(false);
		// Budget guarantee still holds
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
	});

	it("HYSTERESIS constants have expected values", () => {
		expect(HYSTERESIS.unfoldCooldownTurns).toBe(5);
		expect(HYSTERESIS.maxLexicalUnfoldsPerPass).toBe(4);
	});
});

// ── 6. Never emits group commands ────────────────────────────────────────────

describe("ColdScoreConductor — never emits group commands", () => {
	it("store.groups remains empty even with many old foldable blocks over budget", () => {
		// 20 old tool_result blocks at turn 1, tight budget forces heavy folding.
		// Auto-coalesce was removed from this conductor — no group command should ever appear.
		const blocks: Block[] = Array.from({ length: 20 }, (_, i) => ({
			...blk(i, "tool_result", 1000),
			turn: 1, // old (far below any ageCutoff)
		}));
		// Protected tail at a much newer turn
		blocks.push({
			...blk(20, "text", 3000),
			turn: 100,
			text: "tail",
		});

		// Budget tight enough to require folding most blocks
		const s = makeStore(blocks, 5_000, 2_500);
		s.attach(new ColdScoreConductor());

		// Budget guarantee holds
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
		// No groups — the conductor only emits fold commands
		expect(s.groups.filter((g) => g.by === "auto" || g.by === "conductor").length).toBe(0);
	});
});

// ── 7. Built-in still works after swapping ────────────────────────────────────

describe("ColdScoreConductor — built-in unaffected by conductor swap", () => {
	it("attaching cold-score then re-attaching built-in restores built-in behavior", () => {
		const blocks = Array.from({ length: 20 }, (_, i) => blk(i, "text", 1000));
		const s = makeStore(blocks, 10_000, 0);

		// Attach built-in first, record its fold set
		s.attach(new BuiltinConductor());
		const builtinFoldCount = s.foldedCount;
		const builtinLive = s.liveTokens;
		expect(builtinFoldCount).toBeGreaterThan(0);

		// Swap to cold-score
		s.attach(new ColdScoreConductor());
		// May fold differently but budget guarantee still holds
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);

		// Swap back to a fresh built-in — should get the same outcome
		s.attach(new BuiltinConductor());
		expect(s.foldedCount).toBe(builtinFoldCount);
		expect(s.liveTokens).toBe(builtinLive);
	});

	it("cold-score folds ≥ 1 block when over budget (sanity)", () => {
		const blocks = Array.from({ length: 20 }, (_, i) => blk(i, "text", 1000));
		const s = makeStore(blocks, 10_000, 0);
		s.attach(new ColdScoreConductor());

		expect(s.foldedCount).toBeGreaterThan(0);
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
	});

	it("detach() returns to raw even when cold-score was active", () => {
		const blocks = Array.from({ length: 15 }, (_, i) => blk(i, "text", 1000));
		const s = makeStore(blocks, 8_000, 0);
		s.attach(new ColdScoreConductor());
		expect(s.foldedCount).toBeGreaterThan(0);

		s.detach();
		expect(s.foldedCount).toBe(0);
		expect(s.liveTokens).toBe(s.fullTokens);
	});
});

// ── 8. Two-pass black-box: pre-unfold+re-fold must NOT write hysteresis ────────
//
// This test pins the bug fixed in the cold-score conductor where the lexical
// pre-unfold step (Step 2b) used to record a recall AND set a cooldown for block X
// IMMEDIATELY upon keeping it live — even though the relaxed pass (Step 4) might
// subsequently RE-FOLD X under budget pressure. The result was that a block that
// ended up FOLDED after pass 1 still carried:
//   (a) a cooldown → shielding it from Step 3's re-clamp in pass 2
//   (b) a recall   → inflating its cold-score activation in pass 2 (warmer = folds later)
//
// The buggy cooldown effect is the most directly observable: on pass 2 the tail again
// references block X. Step 2b sees X is on cooldown (coolUntil > T) and SKIPS the
// pre-unfold entirely. X stays folded. The budget can then be met without touching Y
// (the only other candidate), so Y stays live. With the FIX, X carries no cooldown;
// Step 2b correctly pre-unfolds X; Step 3 folds Y instead to stay within budget; X ends
// up live. The final fold-id sets are disjoint — the two-pass sequence is fully
// deterministic and distinguishes fixed from buggy code.
//
// Pass-1 setup (called via conduct() directly, no store):
//   budget=700, liveTokens=1700
//   X  = tool_result, turn=1, order=0, tokens=500, foldedTokens=10, text has SIGNAL_PATH
//   Y  = tool_result, turn=1, order=1, tokens=500, foldedTokens=10
//   Z  = tool_result, turn=1, order=2, tokens=500, foldedTokens=10
//   P  = text, turn=10, protected, tokens=200, foldedTokens=10, text has SIGNAL_PATH
//
// Step 2a folds X,Y,Z to meet budget (live 1700 → 230 ≤ 700; P stays live, it's protected).
// Step 2b: X is in the fold set and matches P's SIGNAL_PATH → pre-unfolded; live goes back over.
// Step 3: no remaining unfrozen candidates (Y,Z already folded) → nothing.
// Step 4: X is the only non-folded candidate → re-folded. Final fold set = {X,Y,Z}.
// FIX: no recall or cooldown recorded for X (re-folded in relaxed pass).
// BUG: recall[X]=[10] and coolUntil[X]=15 recorded immediately in step 2b.
//
// Pass-2 setup (same instance, same turn T=10):
//   budget=800, liveTokens=1200
//   X  = tool_result, turn=1, order=0, tokens=500, foldedTokens=10, text has SIGNAL_PATH
//   Y  = tool_result, turn=1, order=1, tokens=500, foldedTokens=10
//   P  = text, turn=10, protected, tokens=200, foldedTokens=10, text has SIGNAL_PATH
//
// Step 2a: fold X (coldest/lowest order): live=1200-490=710 ≤ 800. Stop. folded={X}.
// Step 2b:
//   FIX  — coolUntil[X]=0 ≤ T=10 → X is pre-unfolded; live=1200; preUnfolded={X}.
//           Step 3: live=1200 > 800; fold Y (only non-preUnfolded candidate): live=710 ≤ 800.
//           Final fold set = {Y}. X is LIVE, Y is FOLDED.
//   BUG  — coolUntil[X]=15 > T=10 → X is skipped in step 2b; preUnfolded={}.
//           Step 3: live=710 ≤ 800 → nothing. Step 4: nothing.
//           Final fold set = {X}. X is FOLDED, Y is LIVE.

describe("ColdScoreConductor — two-pass hysteresis: re-folded blocks must not gain warmth/cooldown", () => {
	// ── Helpers for direct conduct() calls (no AccordionStore needed) ─────────

	function makeViewBlock(
		id: string,
		kind: ViewBlock["kind"],
		turn: number,
		order: number,
		tokens: number,
		foldedTokens: number,
		opts: { protected?: boolean; text?: string } = {},
	): ViewBlock {
		return {
			id,
			kind,
			turn,
			order,
			tokens,
			foldedTokens,
			held: false,
			folded: false,
			protected: opts.protected ?? false,
			grouped: false,
			text: opts.text,
		};
	}

	function makeView(blocks: ViewBlock[], budget: number, liveTokens: number): ConductorView {
		return {
			blocks,
			budget,
			liveTokens,
			contextWindow: null,
			protectedFromIndex: blocks.findIndex((b) => b.protected),
			protectTokens: 0,
		};
	}

	it("re-folded-under-budget block carries no cooldown and is correctly pre-unfolded on the next pass", () => {
		const SIGNAL_PATH = "src/widget/foo.ts";

		// ── Pass 1 ────────────────────────────────────────────────────────────
		// Budget tighter than even folding all three foldable blocks can satisfy (because P
		// is protected and cannot be folded). The preliminary clamp folds X,Y,Z. The
		// lexical step pre-unfolds X (matches SIGNAL_PATH in P). The relaxed pass must
		// re-fold X because the budget still can't be met without it. Final fold set = {X,Y,Z}.
		const p1X = makeViewBlock("m0:p0", "tool_result", 1, 0, 500, 10, { text: `reading ${SIGNAL_PATH}` });
		const p1Y = makeViewBlock("m1:p0", "tool_result", 1, 1, 500, 10);
		const p1Z = makeViewBlock("m2:p0", "tool_result", 1, 2, 500, 10);
		const p1P = makeViewBlock("m3:p0", "text", 10, 3, 200, 10, {
			protected: true,
			text: `now working on ${SIGNAL_PATH}`,
		});

		// liveTokens = 500+500+500+200 = 1700; budget = 700
		// After folding X,Y,Z: live = 700-490+490+490 = 700... wait, let's be precise:
		// live starts at 1700. Fold X: 1700-490=1210. Fold Y: 1210-490=720. Fold Z: 720-490=230.
		// Pre-unfold X: 230+490=720. Step 3: nothing new to fold (Y,Z already folded).
		// Step 4: fold X: 720-490=230. Final live=230. folded={X,Y,Z}. Budget=700 is irrelevant here
		// (budget constraint satisfied as best as possible given protected P is off-limits).
		const pass1View = makeView([p1X, p1Y, p1Z, p1P], 700, 1700);

		const conductor = new ColdScoreConductor();
		const pass1Result = conductor.conduct(pass1View);

		// Pass 1: X must be in the fold set (re-folded by the relaxed pass after pre-unfold)
		const pass1Ids = new Set(
			pass1Result.length > 0 && pass1Result[0].kind === "fold" ? pass1Result[0].ids : [],
		);
		expect(pass1Ids.has("m0:p0"), "pass 1: X should be folded (re-folded by relaxed pass)").toBe(true);
		expect(pass1Ids.has("m1:p0"), "pass 1: Y should also be folded").toBe(true);
		expect(pass1Ids.has("m2:p0"), "pass 1: Z should also be folded").toBe(true);

		// ── Pass 2 ────────────────────────────────────────────────────────────
		// Two foldable blocks (X and Y) and one protected tail block (P). Budget can be met
		// by folding just ONE of X or Y (either saves 490 tokens, bringing live from 1200
		// to 710 ≤ 800). The FIXED code: X has no cooldown, so step 2b pre-unfolds it again
		// and step 3 folds Y to close the gap → fold set = {Y}, X is live. The BUGGY code:
		// X has coolUntil=15 > T=10 so step 2b skips it, X stays folded → fold set = {X}.
		const p2X = makeViewBlock("m0:p0", "tool_result", 1, 0, 500, 10, { text: `reading ${SIGNAL_PATH}` });
		const p2Y = makeViewBlock("m1:p0", "tool_result", 1, 1, 500, 10);
		const p2P = makeViewBlock("m3:p0", "text", 10, 2, 200, 10, {
			protected: true,
			text: `now working on ${SIGNAL_PATH}`,
		});

		// liveTokens = 500+500+200 = 1200; budget = 800
		// Step 2a: fold X (coldest by order): live=1200-490=710 ≤ 800. folded={X}.
		// FIX — Step 2b: X matches tail, no cooldown → pre-unfold: live=1200. preUnfolded={X}.
		//        Step 3: live=1200>800. Y is the only non-preUnfolded candidate → fold Y: live=710. folded={Y}.
		//        Final: {Y}. X is live.
		// BUG — Step 2b: coolUntil[X]=15>10 → skip. Step 3,4: live=710≤800 → no change. Final: {X}.
		const pass2View = makeView([p2X, p2Y, p2P], 800, 1200);
		const pass2Result = conductor.conduct(pass2View);

		const pass2Ids = new Set(
			pass2Result.length > 0 && pass2Result[0].kind === "fold" ? pass2Result[0].ids : [],
		);

		// With the FIX: X is live (pre-unfolded correctly), Y is folded
		expect(pass2Ids.has("m0:p0"), "pass 2 (fixed): X should NOT be folded — it was pre-unfolded correctly").toBe(false);
		expect(pass2Ids.has("m1:p0"), "pass 2 (fixed): Y should be folded — stepped up to close budget gap").toBe(true);
	});
});
