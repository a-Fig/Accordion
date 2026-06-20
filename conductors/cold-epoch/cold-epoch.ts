/*
 * cold-epoch.ts — cold-score relevance ranking with epoch-based folding.
 *
 * The problem with cold-score (and the built-in): both fold on every turn that
 * exceeds the budget, which rewrites the prompt prefix each turn and kills the
 * model's inference prompt cache (~10x cost). The problem with the attention-
 * folder: it requires a Python sidecar and a GPU to score relevance.
 *
 * This conductor takes the best of both:
 *   - Cold-score's RANKING (ACT-R power-law decay + lexical pre-unfold + call-
 *     pair warmth) — purely deterministic, synchronous, in-process, no GPU.
 *   - Attention-folder's EPOCH MODEL — hold a stable, monotonically-growing fold
 *     set inside a hysteresis band; change it only at deliberate "epoch" events
 *     when projected live tokens cross the high-water mark.
 *
 * Between epochs the fold set is byte-stable, so the folded prefix is cache-warm
 * and new blocks append live at the tail without touching the cached region. At an
 * epoch — a single, deliberate cache-miss — the conductor expands the fold set
 * using cold-score ranking and drops back to the low-water mark.
 *
 * Algorithm per conduct() call:
 *   1. Prune stale block ids; drop from foldSet any block the host won't honour
 *      (held / protected / grouped / no-shrink). Human and agent overrides always
 *      win; the block is eligible again only if the next epoch needs it.
 *   2. Update ACT-R recall warmth (every turn): scan the protected tail for
 *      identifiers that reference older blocks. Warmth is accumulated continuously
 *      so it is current when an epoch fires, not just computed at epoch time.
 *   3. Compute projectedLive: start from view.liveTokens (the host's cleared
 *      baseline, which correctly accounts for human folds and group costs) and
 *      subtract the savings from each foldSet member not already host-folded.
 *   4. HOLD while projectedLive ≤ highWater × cap — return the current foldSet
 *      unchanged. Prefix is stable; cache hits. (cap = min(budget, contextWindow).)
 *   5. EPOCH when projectedLive > highWater × cap — expand foldSet:
 *      a. Build candidate list: not in foldSet, foldable kind, eligible, shrinks.
 *      b. Lex-protect: candidates whose text is referenced in the tail — skip
 *         these in the primary pass (fold them only in the relaxed pass if the
 *         budget still demands it).
 *      c. Primary pass: sort remaining by cold score (coldest first); greedily
 *         add to foldSet until projectedLive ≤ lowWater × budget.
 *      d. Relaxed pass: if still over lowTok, fold lex-protected candidates too.
 *      Return the updated foldSet.
 *
 * Pure function of the view plus instance state. No Svelte, no $state, no engine
 * imports — types only from ../contract. Imports cold-score helpers for the ACT-R
 * math and lexical matching.
 */

import type { Conductor, ConductorView, ViewBlock, Command } from "../contract";
import { sortCandidates, FOLDABLE_KINDS, type ScoreCtx } from "../cold-score/score";
import { extractIdentifiers, matchBlocks } from "../cold-score/lexical";
import { buildTailText, currentTurn } from "../cold-score/cold-score";

/** The hysteresis band as fractions of the effective cap (min of budget and contextWindow). */
export const EPOCH_CFG = {
	highWater: 0.9, // cross this → run a fold epoch
	lowWater: 0.7,  // epoch folds down to roughly here
};

/** Warmth-scan hysteresis — mirrors cold-score's rate-limiting of recall accumulation. */
const WARMTH_COOLDOWN_TURNS = 5;
const MAX_WARMTH_RECORDS_PER_TURN = 4;

export class ColdEpochConductor implements Conductor {
	readonly id = "cold-epoch";
	readonly label = "Cold epoch";

	/** Monotonic fold set — only grows at epochs; pruned when blocks become ineligible. */
	private foldSet = new Set<string>();

	/** ACT-R recall history: block id → turn numbers at which it was found in the tail. */
	private recalls = new Map<string, number[]>();

	/** Per-block cooldown: block id → turn until which no new recall may be recorded. */
	private warmthCoolUntil = new Map<string, number>();

	conduct(view: ConductorView): Command[] {
		const byId = new Map(view.blocks.map((b) => [b.id, b]));

		// ── 1. Prune stale ids ──────────────────────────────────────────────────
		for (const id of [...this.foldSet]) if (!byId.has(id)) this.foldSet.delete(id);
		for (const id of [...this.recalls.keys()]) if (!byId.has(id)) this.recalls.delete(id);
		for (const id of [...this.warmthCoolUntil.keys()]) if (!byId.has(id)) this.warmthCoolUntil.delete(id);

		// Drop from foldSet any block the host won't honour. Human/agent overrides
		// always win; the block re-enters as a candidate only if a future epoch
		// needs it and the override is gone.
		for (const id of [...this.foldSet]) {
			const b = byId.get(id)!;
			if (b.held || b.protected || b.grouped || b.foldedTokens >= b.tokens) {
				this.foldSet.delete(id);
			}
		}

		const T = currentTurn(view.blocks);

		// ── 2. Update ACT-R recall warmth (every turn) ─────────────────────────
		// Scan the protected tail for identifiers that reference older blocks.
		// Runs every turn so warmth is current when an epoch fires — not computed
		// only at epoch time (which would miss recall signals from quiet turns).
		// Rate-limited: per-block cooldown + per-turn cap prevent unbounded growth.
		const tailText = buildTailText(view.blocks);
		const tailIds = extractIdentifiers(tailText);
		if (tailIds.size > 0) {
			const allCands = view.blocks.filter(
				(b) => FOLDABLE_KINDS.has(b.kind) && !b.held && !b.protected && !b.grouped,
			);
			let recorded = 0;
			for (const bid of matchBlocks(tailIds, allCands).keys()) {
				if (recorded >= MAX_WARMTH_RECORDS_PER_TURN) break;
				if ((this.warmthCoolUntil.get(bid) ?? 0) > T) continue;
				const arr = this.recalls.get(bid);
				if (!arr) { this.recalls.set(bid, [T]); }
				else if (!arr.includes(T)) arr.push(T);
				this.warmthCoolUntil.set(bid, T + WARMTH_COOLDOWN_TURNS);
				recorded++;
			}
		}

		// ── 3. Compute projected live with our foldSet applied ──────────────────
		// Start from the host's cleared baseline and subtract savings for each
		// foldSet member that isn't already host-folded (b.folded covers human
		// folds and collapsed group members — those savings are already in
		// view.liveTokens, so we only subtract our own additions).
		const projected = projectedLive(view, this.foldSet);
		const cap = Math.min(view.budget, view.contextWindow ?? Infinity);
		const highTok = EPOCH_CFG.highWater * cap;

		// ── 4. HOLD — prefix is stable, cache is warm ──────────────────────────
		if (projected <= highTok) {
			return this.foldSet.size > 0 ? [{ kind: "fold", ids: [...this.foldSet] }] : [];
		}

		// ── 5. EPOCH — expand foldSet down to lowWater ─────────────────────────
		const lowTok = EPOCH_CFG.lowWater * cap;

		// call-pair warmth: a block whose callId appears in the protected tail gets
		// a warmth bonus (it's part of an active call chain).
		const tailCallIds = new Set<string>();
		for (const b of view.blocks) if (b.protected && b.callId) tailCallIds.add(b.callId);

		const ctx: ScoreCtx = { currentTurn: T, recalls: this.recalls, tailCallIds };

		// Candidates: not already in foldSet, eligible, foldable kind, would shrink.
		const candidates = view.blocks.filter(
			(b) =>
				!this.foldSet.has(b.id) &&
				FOLDABLE_KINDS.has(b.kind) &&
				!b.held &&
				!b.protected &&
				!b.grouped &&
				b.foldedTokens < b.tokens,
		);

		// Lex-protected: candidates referenced by the tail — fold these last.
		const lexProtected = new Set<string>();
		if (tailIds.size > 0 && candidates.length > 0) {
			for (const bid of matchBlocks(tailIds, candidates).keys()) lexProtected.add(bid);
		}

		// Primary pass: fold coldest non-lex-protected candidates first.
		let now = projected;
		for (const b of sortCandidates(candidates.filter((b) => !lexProtected.has(b.id)), ctx)) {
			if (now <= lowTok) break;
			this.foldSet.add(b.id);
			now += b.foldedTokens - b.tokens;
		}

		// Relaxed pass: if still over lowTok, fold lex-protected candidates too.
		// Budget is the hard guarantee; lex-protection is best-effort.
		if (now > lowTok) {
			for (const b of sortCandidates(candidates.filter((b) => !this.foldSet.has(b.id)), ctx)) {
				if (now <= lowTok) break;
				this.foldSet.add(b.id);
				now += b.foldedTokens - b.tokens;
			}
		}

		return this.foldSet.size > 0 ? [{ kind: "fold", ids: [...this.foldSet] }] : [];
	}
}

/**
 * Projected live token count if `foldSet` were applied on top of the host's
 * cleared baseline. Starts from `view.liveTokens` (which already accounts for
 * human folds, group costs, and stragglers correctly) and subtracts the savings
 * from each foldSet member that isn't already host-folded.
 */
function projectedLive(view: ConductorView, foldSet: Set<string>): number {
	let live = view.liveTokens;
	for (const b of view.blocks) {
		if (foldSet.has(b.id) && !b.folded) live += b.foldedTokens - b.tokens;
	}
	return live;
}
