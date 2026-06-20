/*
 * score.ts — cold-score ranking for the Cold-score conductor (ported from PR #19's
 * C1 deterministic layer; ADR 0009).
 *
 * Theory: Anderson & Schooler (1991) power-law of forgetting. Each block has an
 * activation level based on when it was created and when it was recalled (unfolded
 * by the agent or user). The activation decays with time:
 *
 *   B = ln( Σ max(T - t_i, recallFloorTurns)^(-d) )
 *
 * where T = current turn, t_i = turn at each retrieval event (creation or recall),
 * and d = decay rate for the block's kind.
 *
 * `coldScore` is a LOWER = COLDER = fold-first metric:
 *   coldScore = prior[kind] + B + pairWarmthBonus?
 *
 * Kind-major by design: the prior gaps (8 units) exceed the maximum realistic
 * activation spread, so with NO recalls the ordering reproduces the legacy
 * FOLD_RANK-then-age exactly — this is a deliberate golden-compatibility property
 * (tool_result folds first, then thinking, then text; tool_call/user effectively
 * never fold).
 *
 * Size pressure intentionally NOT in the score — it stays a greedy-clamp concern in
 * conduct() so the score is a pure relevance signal and size is handled orthogonally.
 *
 * Adapted to the conductor contract: scores `ViewBlock` (the one public surface) and
 * needs only `kind`/`turn`/`order`/`callId`. Pure, dependency-free, Node-safe — types
 * only from `../contract`.
 */
import type { ViewBlock } from "../contract";

/** Kinds that may be folded to a digest — `tool_call` / `user` are never folded. */
export const FOLDABLE_KINDS: ReadonlySet<ViewBlock["kind"]> = new Set<ViewBlock["kind"]>([
	"text",
	"thinking",
	"tool_result",
]);

export interface ScoreCtx {
	/** The current turn number (highest turn in the session). */
	currentTurn: number;
	/**
	 * Map of block id → array of turns (append order) at which it was recalled
	 * (lexically pre-unfolded by the conductor since ingestion). `activation` sums over
	 * the entries order-independently, so the array is not kept sorted.
	 */
	recalls: ReadonlyMap<string, readonly number[]>;
	/**
	 * Set of callIds found in the protected tail — a block sharing a callId
	 * with a tail block gets a warmth bonus (it's part of an ongoing interaction).
	 */
	tailCallIds: ReadonlySet<string>;
}

/**
 * Tunable constants for the scoring model. One object keeps all knobs in one
 * place and makes unit tests self-documenting.
 *
 * priors: kind-level base cost (lower = fold first). Gaps of 8 ensure kind-major
 *   ordering dominates when there are no recalls. Mirrors the built-in's FOLD_RANK:
 *   tool_result (0) < thinking (8) < text (16) < tool_call (24) < user (32).
 *
 * decay: power-law forgetting exponent per kind. tool_result decays fastest (0.9) —
 *   ephemeral lookups; thinking next (0.7) — useful but transient; text slowest (0.5)
 *   — conclusions stay relevant longest.
 *
 * pairWarmthBonus: score boost for a block whose callId is referenced in the
 *   protected tail. A tool_result that the active tail is "using" is warmer.
 *
 * recallFloorTurns: minimum age for ACT-R calculation (prevents ln(0)). Must be ≥1.
 */
export const SCORE_CONFIG = {
	priors: { tool_result: 0, thinking: 8, text: 16, tool_call: 24, user: 32 } as Record<string, number>,
	decay: { tool_result: 0.9, thinking: 0.7, text: 0.5 } as Record<string, number>,
	pairWarmthBonus: 4,
	recallFloorTurns: 1,
};

/**
 * ACT-R base-level activation for a single block.
 *
 * Events: the block's creation turn, plus every recall turn (deduplicated consecutive
 * same-turn recalls are already handled at recording time in the conductor).
 *
 * B = ln( Σ_i max(T - t_i, floor)^(-d) )
 *
 * A block with recent recalls has higher (less negative) activation → higher coldScore
 * → warmer → fold-last. A block created many turns ago with no recalls has very low
 * activation (large negative) → folds first within its kind.
 */
export function activation(b: ViewBlock, ctx: ScoreCtx): number {
	const d = SCORE_CONFIG.decay[b.kind] ?? 0.6;
	const floor = SCORE_CONFIG.recallFloorTurns;
	const T = ctx.currentTurn;
	// Filter out recall events with t > currentTurn — out-of-order JSONL turns must not
	// grant maximal (freshness) weight to a block that hasn't actually been recalled yet.
	const rawEvents: number[] = [b.turn, ...(ctx.recalls.get(b.id) ?? [])];
	const events = rawEvents.filter((t) => t <= T);
	if (!events.length) events.push(b.turn <= T ? b.turn : T); // always at least the creation event
	let sum = 0;
	for (const t of events) {
		const age = Math.max(T - t, floor);
		sum += Math.pow(age, -d);
	}
	// Guard against degenerate sum (shouldn't happen given recallFloorTurns >= 1)
	if (sum <= 0) return -10; // very cold
	return Math.log(sum);
}

/**
 * Cold score for a candidate block. LOWER = colder = fold first.
 *
 * = prior[kind] + activation(b) + pairWarmthBonus (if tail-paired)
 *
 * Kind-major: prior gaps (8) exceed any realistic activation spread for sessions
 * up to ~1000 turns, so the default fold ordering is: tool_result first, then
 * thinking, then text — identical to the built-in's FOLD_RANK ordering for same-kind
 * blocks with equal recalls.
 */
export function coldScore(b: ViewBlock, ctx: ScoreCtx): number {
	const prior = SCORE_CONFIG.priors[b.kind] ?? 24;
	const act = activation(b, ctx);
	const warmth = b.callId && ctx.tailCallIds.has(b.callId) ? SCORE_CONFIG.pairWarmthBonus : 0;
	return prior + act + warmth;
}

/**
 * Sort fold candidates ascending by coldScore (coldest = fold first), ties broken
 * by order (oldest first). Within one kind with no recalls, ln decay is monotonic
 * in age, so oldest-first is automatically preserved.
 */
export function sortCandidates(cands: ViewBlock[], ctx: ScoreCtx): ViewBlock[] {
	return [...cands].sort((a, b) => {
		const sa = coldScore(a, ctx);
		const sb = coldScore(b, ctx);
		if (sa !== sb) return sa - sb;
		return a.order - b.order;
	});
}
