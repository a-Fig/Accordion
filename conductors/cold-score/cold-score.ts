/*
 * cold-score.ts — the Cold-score conductor.
 *
 * A port of PR #19's C1 DETERMINISTIC layer into the conductor contract
 * (`conduct(view) → Command[]`) — faithful to its algorithm, with one deliberate refinement
 * (see `currentTurn`). It is "the built-in, but with relevance + hysteresis":
 *
 *   1. ACT-R cold-score ranking (Anderson & Schooler power-law of forgetting) replaces
 *      the built-in's flat FOLD_RANK — kind-major, so with no recalls the ordering is
 *      byte-compatible with the built-in (tool_result → thinking → text; tool_call/user
 *      effectively never fold).
 *   2. Lexical pre-unfold: blocks referenced by an identifier in the protected tail are
 *      kept live (a relevance signal), recorded as "recalls" that warm them for future
 *      passes, and put on a per-block cooldown.
 *   3. Budget is the hard guarantee: a re-clamp respects cooldowns, then a relaxed pass
 *      folds even cooled-down blocks if still over budget. Whenever the available fold
 *      candidates can achieve it, the pipeline drives projected live ≤ budget — this is
 *      a true invariant of the fold-only output.
 *
 * Auto-coalesce (collapsing long-cold folded runs into `group` commands) is intentionally
 * REMOVED — it is a roadmap item. The host snaps group ranges outward to whole messages,
 * which can strand live tool_calls as full-cost stragglers (budget violation) and collapse
 * lexically-pre-unfolded blocks. Until the contract provides a safe grouping primitive,
 * this conductor emits only `fold` commands.
 *
 * The C2 (LLM summaries), C3 (attentive tick), and C4 (nested eras) layers from PR #19
 * are intentionally OUT OF SCOPE — this conductor is purely deterministic.
 *
 * It is a PURE function of the view PLUS instance memory. The contract gives no store
 * handle, so cross-pass hysteresis (recalls / per-block cooldown) lives in INSTANCE
 * fields — the host constructs the conductor once via `create()`, so they persist across
 * `conduct()` calls. No Svelte, no `$state`, no engine imports, no Node / Tauri APIs —
 * types only from `../contract`.
 */
import type { Conductor, ConductorView, ViewBlock, Command } from "../contract";
import { sortCandidates, FOLDABLE_KINDS, type ScoreCtx } from "./score";
import { extractIdentifiers, matchBlocks } from "./lexical";

/**
 * Hysteresis constants for the pipeline (verbatim from PR #19).
 *
 * unfoldCooldownTurns: after a lexical pre-unfold, the block may not be auto-refolded
 *   for this many turns. Best-effort: if every candidate is on cooldown and the budget
 *   is exceeded, the relaxed pass folds anyway.
 *
 * maxLexicalUnfoldsPerPass: maximum blocks the lexical pre-unfold step restores per
 *   `conduct()` pass. Prevents a noisy tail from unfurling the entire history.
 */
export const HYSTERESIS = {
	unfoldCooldownTurns: 5,
	maxLexicalUnfoldsPerPass: 4,
};

/** Cap on the tail text scanned for identifiers (mirrors PR #19's 32k-char window). */
const TAIL_TEXT_CAP = 32_000;

export class ColdScoreConductor implements Conductor {
	readonly id = "cold-score";
	readonly label = "Cold-score";

	// ---- cross-pass hysteresis state (instance memory) ----------------------
	/** block id → turns (append order) at which it was lexically pre-unfolded (warms the score). */
	private recalls = new Map<string, number[]>();
	/** block id → turn until which a block may NOT be auto-refolded (post lexical unfold). */
	private coolUntil = new Map<string, number>();

	/**
	 * Record that a block was recalled at `turn`. Deduplicates globally per (id, turn)
	 * so multiple `conduct()` calls in the same turn never inflate the recall count.
	 */
	private recordRecall(id: string, turn: number): void {
		const arr = this.recalls.get(id);
		if (!arr) {
			this.recalls.set(id, [turn]);
			return;
		}
		if (arr.includes(turn)) return; // already recorded this turn
		arr.push(turn);
	}

	/**
	 * Compute the conductor's complete desired fold state for this view.
	 *
	 * Mirrors PR #19's `_refoldImpl` pipeline, re-expressed as a pure function over the
	 * view plus instance memory. Returns `[]` (under budget / nothing to do) or a single
	 * `[{kind:"fold", ids}]` command — no `group` commands. Never returns `null`
	 * (this conductor is synchronous and always has a definite answer).
	 */
	conduct(view: ConductorView): Command[] {
		// Prune stale entries from instance Maps to prevent unbounded growth over long
		// sessions. Build the current-id set once, then drop any key absent from it.
		const currentIds = new Set<string>(view.blocks.map((b) => b.id));
		for (const id of this.recalls.keys()) {
			if (!currentIds.has(id)) this.recalls.delete(id);
		}
		for (const id of this.coolUntil.keys()) {
			if (!currentIds.has(id)) this.coolUntil.delete(id);
		}

		// Step 0: under budget → raw, nothing to do (matches the built-in).
		if (view.liveTokens <= view.budget) return [];

		const T = currentTurn(view.blocks);

		// callIds present in the protected tail — a candidate sharing one gets a warmth bonus.
		const tailCallIds = new Set<string>();
		for (const b of view.blocks) {
			if (b.protected && b.callId) tailCallIds.add(b.callId);
		}
		const ctx: ScoreCtx = { currentTurn: T, recalls: this.recalls, tailCallIds };

		// The blocks the host will actually let us fold (mirrors the built-in's filter):
		// not human-held, not protected, not grouped, and would actually shrink. We further
		// restrict to FOLDABLE kinds so tool_call / user are never selected — the cold-score
		// priors already deprioritize them, this makes it explicit and matches FOLD_RANK intent.
		const candidates = view.blocks.filter(
			(b) =>
				!b.held &&
				!b.protected &&
				!b.grouped &&
				b.foldedTokens < b.tokens &&
				FOLDABLE_KINDS.has(b.kind),
		);

		// Running projection of live tokens as we mark blocks folded.
		let live = view.liveTokens;
		const folded = new Set<string>(); // ids currently in the fold set this pass
		const candById = new Map<string, ViewBlock>();
		for (const b of candidates) candById.set(b.id, b);

		const markFold = (b: ViewBlock): void => {
			if (folded.has(b.id)) return;
			folded.add(b.id);
			live += b.foldedTokens - b.tokens;
		};
		const unmarkFold = (b: ViewBlock): void => {
			if (!folded.has(b.id)) return;
			folded.delete(b.id);
			live -= b.foldedTokens - b.tokens; // undo (adds back the full-vs-digest delta)
		};

		// Step 2a: PRELIMINARY CLAMP — cold-score sorted greedy fold (no cooldown check),
		// producing the initial fold set the lexical pass inspects.
		const preliminary = sortCandidates(candidates, ctx);
		for (const b of preliminary) {
			if (live <= view.budget) break;
			markFold(b);
		}

		// Step 2b: LEXICAL PRE-UNFOLD — keep live any just-folded block referenced by an
		// identifier in the protected tail (a relevance signal). The recall + cooldown are NOT
		// recorded here: a block kept live now can still be re-folded by the relaxed pass (Step 4)
		// under budget pressure, and a re-folded block must not carry warmth. The persistent
		// bookkeeping is deferred until AFTER the final fold set is known (see end of pass).
		const preUnfolded = new Set<string>();
		const tailText = buildTailText(view.blocks);
		const tailIds = extractIdentifiers(tailText);
		const lexCandidates = candidates.filter((b) => folded.has(b.id));
		if (tailIds.size > 0 && lexCandidates.length > 0) {
			const matches = matchBlocks(tailIds, lexCandidates);
			// Longest identifier first (most specific signal).
			const matchedEntries = [...matches.entries()].sort((a, b) => b[1].length - a[1].length);
			let unfolded = 0;
			for (const [bid] of matchedEntries) {
				if (unfolded >= HYSTERESIS.maxLexicalUnfoldsPerPass) break;
				const b = candById.get(bid);
				if (!b || !folded.has(bid)) continue;
				// Skip blocks already on cooldown — they are already relevance-protected;
				// re-recording a recall every turn while the identifier persists would
				// inflate their warmth artificially.
				if ((this.coolUntil.get(bid) ?? 0) > T) continue;
				unmarkFold(b); // keep it live
				preUnfolded.add(bid); // shielded from Step 3 re-clamp; persisted only if it survives
				unfolded++;
			}
		}

		// Step 3: RE-CLAMP respecting cooldowns — if the pre-unfolds put us back over
		// budget, fold MORE candidates (coldest first), EXCLUDING blocks on cooldown.
		if (live > view.budget) {
			const reclamp = sortCandidates(
				candidates.filter(
					(b) => !folded.has(b.id) && !preUnfolded.has(b.id) && (this.coolUntil.get(b.id) ?? 0) <= T,
				),
				ctx,
			);
			for (const b of reclamp) {
				if (live <= view.budget) break;
				markFold(b);
			}
		}

		// Step 4: RELAXED PASS — if STILL over budget, fold the remaining candidates
		// INCLUDING cooled-down ones. Budget is the hard guarantee; hysteresis is best-effort.
		if (live > view.budget) {
			const relaxed = sortCandidates(
				candidates.filter((b) => !folded.has(b.id)),
				ctx,
			);
			for (const b of relaxed) {
				if (live <= view.budget) break;
				markFold(b);
			}
		}

		// Persist hysteresis ONLY for pre-unfolded blocks that actually stayed live. A block the
		// relaxed pass had to re-fold under budget pressure must carry NEITHER a recall (which
		// would falsely warm it next pass) NOR a cooldown (which would falsely shield it from the
		// Step 3 re-clamp) — record only the survivors.
		for (const bid of preUnfolded) {
			if (folded.has(bid)) continue; // re-folded by the relaxed pass — do not warm
			this.coolUntil.set(bid, T + HYSTERESIS.unfoldCooldownTurns);
			this.recordRecall(bid, T);
		}

		// Emit a single fold command for the final fold set, or nothing if it is empty.
		const foldIds = [...folded];
		if (!foldIds.length) return [];
		return [{ kind: "fold", ids: foldIds }];
	}

}

/**
 * Concatenate the protected-tail text, newest-walking, capped at ~32k chars — the
 * identifier source for the lexical pre-unfold. Mirrors PR #19's tail-text window.
 * Exported so cold-epoch can share the same tail-text builder without copying.
 */
export function buildTailText(blocks: ViewBlock[]): string {
	let text = "";
	for (let i = blocks.length - 1; i >= 0 && text.length < TAIL_TEXT_CAP; i--) {
		const b = blocks[i];
		if (!b.protected) break; // walked past the protected tail
		if (b.text !== undefined) text = b.text + "\n" + text;
	}
	return text;
}

/**
 * The conductor's notion of "now" — the HIGHEST turn across the blocks (0 for an empty
 * session). Deliberately the max, not the last block's turn: robust to a resync that appends
 * an older-turn block. PR #19's runtime used the last block's turn, which coincides with the
 * max whenever turns are monotonic (the normal case).
 * Exported so cold-epoch (and any future conductor) can share the same definition.
 */
export function currentTurn(blocks: ViewBlock[]): number {
	let t = 0;
	for (const b of blocks) if (b.turn > t) t = b.turn;
	return t;
}
