/*
 * coldscore.score.test.ts — unit tests for the ACT-R cold-score ranking.
 *
 * Adapted from PR #19's score.test.ts to operate on ViewBlock (the public conductor
 * surface) instead of engine Block. The semantic properties tested are identical.
 *
 * Key properties tested:
 *   1. Monotonic decay — older blocks have lower activation.
 *   2. Recall boost — a recalled block has higher activation than a never-recalled one.
 *   3. Kind-major ordering — default sort with no recalls matches legacy FOLD_RANK ordering.
 *   4. pairWarmthBonus raises score for blocks whose callId is in the tail.
 *   5. ties broken by order (oldest first).
 */
import { describe, it, expect } from "vitest";
import { activation, coldScore, sortCandidates, SCORE_CONFIG } from "$conductors/cold-score/score";
import type { ScoreCtx } from "$conductors/cold-score/score";
import type { ViewBlock } from "$conductors/contract";

function vblk(
	id: string,
	kind: ViewBlock["kind"],
	turn: number,
	order: number,
	extra: Partial<ViewBlock> = {},
): ViewBlock {
	return {
		id,
		kind,
		turn,
		order,
		tokens: 1000,
		foldedTokens: 50,
		held: false,
		folded: false,
		protected: false,
		grouped: false,
		text: `block ${id}`,
		...extra,
	};
}

const emptyCtx = (currentTurn: number): ScoreCtx => ({
	currentTurn,
	recalls: new Map(),
	tailCallIds: new Set(),
});

describe("activation — monotonic decay", () => {
	it("an older block has lower activation than a newer one (same kind, no recalls)", () => {
		const newer = vblk("newer", "text", 8, 1);
		const older = vblk("older", "text", 2, 0);
		const ctx = emptyCtx(10);
		const actNewer = activation(newer, ctx);
		const actOlder = activation(older, ctx);
		// older = age 8, newer = age 2; both same decay; older decays more → lower activation
		expect(actOlder).toBeLessThan(actNewer);
	});

	it("activation increases with each recall event", () => {
		const b = vblk("b1", "text", 1, 0);
		const ctx0 = emptyCtx(10);
		const ctx1: ScoreCtx = {
			currentTurn: 10,
			recalls: new Map([["b1", [5]]]),
			tailCallIds: new Set(),
		};
		const ctx2: ScoreCtx = {
			currentTurn: 10,
			recalls: new Map([["b1", [5, 8]]]),
			tailCallIds: new Set(),
		};
		const a0 = activation(b, ctx0);
		const a1 = activation(b, ctx1);
		const a2 = activation(b, ctx2);
		// More recalls → higher activation (more events in the sum)
		expect(a1).toBeGreaterThan(a0);
		expect(a2).toBeGreaterThan(a1);
	});

	it("activation is finite and a real number for reasonable inputs", () => {
		const b = vblk("b1", "text", 1, 0);
		const ctx = emptyCtx(100);
		const a = activation(b, ctx);
		expect(Number.isFinite(a)).toBe(true);
		expect(Number.isNaN(a)).toBe(false);
	});

	it("future recall events (t > currentTurn) are filtered out", () => {
		const b = vblk("b1", "text", 1, 0);
		// Recall at turn 20 with currentTurn=10 — out-of-order JSONL must not inflate warmth
		const ctxWithFuture: ScoreCtx = {
			currentTurn: 10,
			recalls: new Map([["b1", [20]]]),
			tailCallIds: new Set(),
		};
		const ctxWithout = emptyCtx(10);
		// Future recall should be ignored; activation should equal creation-only case
		const aFuture = activation(b, ctxWithFuture);
		const aClean = activation(b, ctxWithout);
		expect(aFuture).toBe(aClean);
	});

	it("recallFloorTurns prevents ln(0) — age is always at least 1", () => {
		// Block created at current turn → age = max(0, floor=1) = 1 — no NaN/Infinity
		const b = vblk("b1", "text", 10, 0);
		const ctx = emptyCtx(10);
		const a = activation(b, ctx);
		expect(Number.isFinite(a)).toBe(true);
		expect(Number.isNaN(a)).toBe(false);
	});
});

describe("coldScore — kind-major property", () => {
	it("tool_result always scores lower (colder) than thinking, which scores lower than text", () => {
		const ctx = emptyCtx(5);
		const tr = vblk("tr", "tool_result", 2, 0);
		const th = vblk("th", "thinking", 2, 1);
		const tx = vblk("tx", "text", 2, 2);
		expect(coldScore(tr, ctx)).toBeLessThan(coldScore(th, ctx));
		expect(coldScore(th, ctx)).toBeLessThan(coldScore(tx, ctx));
	});

	it("kind-major gap dominates: an old text block is colder than a new tool_result block", () => {
		// text prior = 16, tool_result prior = 0; even at turn 1 vs turn 9,
		// the prior gap of 16 exceeds any realistic activation diff → tool_result still colder
		const ctx = emptyCtx(10);
		const oldText = vblk("old_text", "text", 1, 0);
		const newTR = vblk("new_tr", "tool_result", 9, 1);
		expect(coldScore(newTR, ctx)).toBeLessThan(coldScore(oldText, ctx));
	});

	it("within same kind: older block has lower coldScore (folds first)", () => {
		const ctx = emptyCtx(10);
		const old_tr = vblk("old_tr", "tool_result", 1, 0);
		const newer_tr = vblk("new_tr", "tool_result", 5, 1);
		expect(coldScore(old_tr, ctx)).toBeLessThan(coldScore(newer_tr, ctx));
	});

	it("a recent recall lifts a tool_result's score above an older unrecalled one", () => {
		const ctx0 = emptyCtx(10);
		const old_tr = vblk("old_tr", "tool_result", 1, 0);
		const newer_tr = vblk("new_tr", "tool_result", 5, 1);
		// Older scores lower without recalls
		expect(coldScore(old_tr, ctx0)).toBeLessThan(coldScore(newer_tr, ctx0));

		// Recall the older block at turn 9 — it gets warmer (score increases)
		const ctx1: ScoreCtx = {
			currentTurn: 10,
			recalls: new Map([["old_tr", [9]]]),
			tailCallIds: new Set(),
		};
		expect(coldScore(old_tr, ctx1)).toBeGreaterThan(coldScore(newer_tr, ctx0));
	});

	it("pairWarmthBonus raises score for blocks whose callId is in the tail", () => {
		const ctx = emptyCtx(5);
		const tr_no_pair = vblk("tr1", "tool_result", 2, 0);
		const tr_with_pair = vblk("tr2", "tool_result", 2, 1, { callId: "c1" });
		const ctxWithTail: ScoreCtx = {
			currentTurn: 5,
			recalls: new Map(),
			tailCallIds: new Set(["c1"]),
		};
		expect(coldScore(tr_with_pair, ctxWithTail)).toBeGreaterThan(coldScore(tr_no_pair, ctx));
		// The bonus is pairWarmthBonus (4), compare against same-context baseline
		const baseScore = coldScore(tr_with_pair, { ...ctxWithTail, tailCallIds: new Set() });
		const pairedScore = coldScore(tr_with_pair, ctxWithTail);
		expect(pairedScore - baseScore).toBeCloseTo(SCORE_CONFIG.pairWarmthBonus, 5);
	});

	it("tool_call and user priors are highest (they effectively never fold)", () => {
		const ctx = emptyCtx(5);
		const tc = vblk("tc", "tool_call", 2, 0);
		const u = vblk("u", "user", 2, 1);
		const tx = vblk("tx", "text", 2, 2);
		// tool_call (prior=24) and user (prior=32) are warmer than text (prior=16)
		expect(coldScore(tc, ctx)).toBeGreaterThan(coldScore(tx, ctx));
		expect(coldScore(u, ctx)).toBeGreaterThan(coldScore(tc, ctx));
	});
});

describe("sortCandidates — default ordering matches legacy FOLD_RANK", () => {
	it("no recalls: sort order equals legacy FOLD_RANK then age on a synthetic mixed session", () => {
		// Golden-compatibility: with no recalls, cold-score ordering reproduces
		// FOLD_RANK-then-order. Blocks are co-monotonic within each kind group.
		const ctx = emptyCtx(12);
		const blocks: ViewBlock[] = [
			vblk("tr_1", "tool_result", 1, 0),
			vblk("th_1", "thinking", 2, 1),
			vblk("tx_1", "text", 3, 2),
			vblk("tr_2", "tool_result", 4, 3),
			vblk("th_2", "thinking", 5, 4),
			vblk("tx_2", "text", 6, 5),
			vblk("tr_3", "tool_result", 7, 6),
			vblk("th_3", "thinking", 8, 7),
			vblk("tx_3", "text", 9, 8),
		];

		// Legacy oracle: FOLD_RANK then order asc within kind
		const FOLD_RANK_ORACLE: Record<string, number> = {
			tool_result: 0,
			thinking: 1,
			text: 2,
			tool_call: 3,
			user: 4,
		};
		const legacyOrder = [...blocks].sort(
			(a, b) => FOLD_RANK_ORACLE[a.kind] - FOLD_RANK_ORACLE[b.kind] || a.order - b.order,
		);

		const newOrder = sortCandidates(blocks, ctx);

		const legacySeq = legacyOrder.map((b) => `${b.kind}:${b.order}`);
		const newSeq = newOrder.map((b) => `${b.kind}:${b.order}`);
		expect(newSeq).toEqual(legacySeq);
	});

	it("ties broken by order (oldest first)", () => {
		const ctx = emptyCtx(5);
		const b1 = vblk("a", "text", 1, 3);
		const b2 = vblk("b", "text", 1, 1);
		const b3 = vblk("c", "text", 1, 2);
		const sorted = sortCandidates([b1, b3, b2], ctx);
		// All same kind, same turn → tie on score → order breaks tie (lowest order first)
		expect(sorted.map((b) => b.id)).toEqual(["b", "c", "a"]);
	});

	it("sortCandidates returns a new array, not a mutation of the input", () => {
		const ctx = emptyCtx(5);
		const blocks = [vblk("a", "text", 3, 1), vblk("b", "text", 1, 0)];
		const original = [...blocks];
		sortCandidates(blocks, ctx);
		expect(blocks[0].id).toBe(original[0].id); // input unchanged
	});

	it("empty array returns empty", () => {
		const result = sortCandidates([], emptyCtx(5));
		expect(result).toEqual([]);
	});

	it("SCORE_CONFIG priors have expected gap of 8 between consecutive kinds", () => {
		const { priors } = SCORE_CONFIG;
		expect(priors.thinking - priors.tool_result).toBe(8);
		expect(priors.text - priors.thinking).toBe(8);
		expect(priors.tool_call - priors.text).toBe(8);
		expect(priors.user - priors.tool_call).toBe(8);
	});
});
