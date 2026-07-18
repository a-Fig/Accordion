/*
 * core/conductors/compaction-naive/compaction-naive.ts — the "Naive compaction" conductor.
 *
 * PORTED from the deleted `conductors/compaction-naive/compaction-naive.ts` (ADR 0014, git rev
 * dc037bc) onto the conductor-v2 contract, via the `ViewConductor` adapter
 * (`core/conductor/view.ts`). Since that port, PR #82 factored the ~90%-duplicated machinery it
 * shared with the sibling `handoff` conductor into `../agedSummaryConductor.ts`'s
 * `AgedSummaryConductor` base class (aged-region derivation, foreign-grouped-id exclusion, group
 * emission, completion launch/inflight/attempt-key/sticky-status lifecycle, and the output-token
 * reservation math). This file now owns only what is genuinely different: `COMPACTION_SYSTEM`,
 * the two `buildPrompt` instruction strings, the count-preamble format, the three status messages,
 * and — the one behavioral fork — excluding `user` blocks from the fold (see `includeInGroup`
 * below and PORT FIDELITY §2).
 *
 * PURPOSE (unchanged): a deliberate BASELINE / FOIL that reproduces what mainstream AI coding
 * tools do today. When the context approaches capacity, it calls an LLM to summarize the aged
 * history into a single prose summary and presents the agent that ONE summary IN PLACE of the
 * whole aged region — faithfully reproducing what Cursor's composer, Claude Code's `/compact`,
 * and similar tools do.
 *
 * It is DELIBERATELY LOSSY AND RECURSIVE:
 *   - Lossy: the aged assistant/tool/thinking blocks are collapsed into ONE group whose digest is
 *     the generated summary. There is no `{#code FOLDED}` tag on the summary, so the agent cannot
 *     call `unfold` to recover the originals. The human can always DETACH this conductor to
 *     recover full history; the agent cannot. That asymmetry is the whole point.
 *   - Recursive: each subsequent compaction summarizes the PRIOR SUMMARY + only the newly aged
 *     blocks. It never re-reads the originals already compressed — the self-imposed amnesia
 *     compounds quality loss over a session, the exact failure mode Accordion's reversible
 *     folding is designed to avoid.
 *
 * SHAPE — a `group(digest: <LLM summary>)` command (REPLACE the aged run with one summary
 * message), close cousin of the sliding-window conductor's `group(digest: null)` (DROP). The
 * host snaps the run outward to whole messages and pair-balances `tool_call`/`tool_result`, so no
 * tool result is ever orphaned.
 *
 * PORT FIDELITY — real adaptations, not cosmetic renames:
 *
 *   1. Everything the `AgedSummaryConductor` base now owns (`../agedSummaryConductor.ts`'s own
 *      banner documents these in full): no `host.can()` pre-flight (a rejected `complete()` IS the
 *      "unavailable" signal); `this.rerun()` in place of the old `host.requestRerun()`; the raw
 *      trigger baseline reconstructed from `sumTokens(view.blocks)` rather than `view.liveTokens`
 *      (which — now that a `group` op is a PERSISTENT Truth overlay, not something the host clears
 *      every pass — already reflects this conductor's own prior folding, so subtracting the same
 *      saving again would double-count it and starve the trigger); `foreignGroupedIds()` in place
 *      of the blanket `ViewBlock.grouped` (which, for the identical persistent-overlay reason,
 *      would also be true of this conductor's OWN prior group by the second pass); and the sticky
 *      reject/empty-output/window-too-tight status (the old reject handler only cleared `inflight`,
 *      since unavailability was reported by the removed `can()` pre-check instead).
 *
 *   2. USER MESSAGES ARE NO LONGER SWALLOWED INTO THE GROUP (sol P1/P2 finding #5, PR #82 task 3).
 *      The pre-refactor conductor's prompt PROMISED "user messages are reproduced VERBATIM" while
 *      mechanically folding them into the SAME non-recoverable group as everything else, capped at
 *      `MAX_OUTPUT_TOKENS` (8000) with ANY nonempty output accepted and nothing verifying the
 *      promise held. A single user message larger than the cap made the promise mathematically
 *      impossible to keep, and nothing caught a smaller one being silently paraphrased either.
 *
 *      Fixed MECHANICALLY, not by asking the model more nicely: `includeInGroup` below excludes
 *      every `user`-kind block from ever becoming a group member. `AgedSummaryConductor`'s shared
 *      run-walk (`emitCoverageGroup`) treats an excluded block exactly like a held/foreign-grouped
 *      one — it forces a flush, splitting the run around it — so a user block sits BETWEEN two
 *      summary groups (or beside one), live, full-fidelity, forever, regardless of its size. The
 *      trigger math's `survivors` filter (also `includeInGroup`-gated, in the base) correctly never
 *      credits a user block's tokens as "saved," since they were never actually removed from the
 *      wire. See the README's "User messages: preserved by staying live, not by the summary"
 *      section for the token-cost tradeoff this accepts on purpose.
 *
 *      `COMPACTION_SYSTEM` and both `buildPrompt` instruction strings were reworded to match: the
 *      summary may still REFERENCE user intent for context, but no longer claims to preserve user
 *      messages verbatim or asks the model to reproduce them — the mechanism does that now, not
 *      the prompt.
 *
 * Everything else — `COMPACTION_SYSTEM`'s structured-briefing shape, the recursive-merge
 * instructions (verbatim user-preservation clause aside), and the `MAX_OUTPUT_TOKENS`(8000) /
 * `MIN_OUTPUT_TOKENS`(1000) / `OUTPUT_SAFETY_MARGIN`(512) constants (now shared, unchanged in
 * value) — is ported/kept unchanged.
 *
 * No Svelte, no `$state`, no engine imports. Types only from `../../conductor/contract` and
 * `../agedSummaryConductor`.
 */
import { AgedSummaryConductor, neutralizeClosingTags, sumTokens, blockLabel } from "../agedSummaryConductor";
import type { LockName, ViewBlock } from "../../conductor/contract";

/**
 * System prompt for the compaction LLM call. Structured-briefing template with one change from
 * the pre-#82 wording (PORT FIDELITY §2): user messages are no longer claimed to be reproduced
 * verbatim IN the summary — they now stay live on the wire, outside it, by mechanism, so the
 * prompt asks the model to use them only as context.
 */
export const COMPACTION_SYSTEM = `\
You are a context-compaction assistant. Your task is to read a segment of an AI \
assistant's conversation history and produce a compact, structured briefing that the \
assistant can use to continue working effectively without seeing the original messages.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. \
ONLY output the structured summary.

User messages in the segment are NOT included in this summary and are not your responsibility to \
preserve — they remain live, in full, elsewhere in the conversation (this conductor never folds \
them away). Use them only as context for the sections below, to describe goals, decisions, and \
progress accurately. Do not reproduce a user message verbatim and do not include a dedicated \
user-messages section.

Produce your output in EXACTLY this structure — no prose outside the sections. Keep \
every section even when empty; write "(none)" where nothing applies:

## Goal
One sentence: what is the overall task or objective being pursued?

## Progress
Bullet list of what has been accomplished so far. Be specific: files changed, commands \
run, decisions made, errors encountered and resolved.

## Key decisions
Bullet list of the important choices made (architecture, approach, libraries, \
workarounds). Include the reasoning where it matters for future steps.

## Next steps
Bullet list of what is expected to happen next, in the order the work is heading.

## Critical context
Any facts, invariants, or constraints the assistant MUST remember: API keys pattern \
(never actual values), file paths, environment quirks, non-obvious rules from the \
human's instructions, hard constraints on scope. Err on the side of including \
something here if it would be surprising to lose it.

## Relevant files
- {file path}: why it matters. List files that were read, written, or are central to \
the task. Write "(none)" if none.

Be terse. Omit pleasantries, meta-commentary, and filler. The output will be placed directly \
into the agent's context window.`;

export class NaiveCompactionConductor extends AgedSummaryConductor {
	readonly id = "compaction-naive";
	readonly label = "Naive compaction";

	/**
	 * Involvement locks (ADR 0011). This conductor takes EXCLUSIVE control of the two STEERING
	 * controls — the human's hand fold/unfold/pin/group/reset and the agent's `unfold` tool — so
	 * the user, the agent, and the conductor cannot fight over the same blocks while a compaction
	 * pass is rewriting them. `human-steering` is load-bearing for the single-group shape: under
	 * that lock the human cannot pin or group a block inside the aged region, so the region stays
	 * CONTIGUOUS and the one `group` command covering it is always valid (the host refuses a run
	 * that spans a human-held block). Dropping the lock would let a held block split the region,
	 * fragmenting the single summary tile.
	 *
	 * Deliberately does NOT lock `tail-size` (see ADR 0014 §4 for the full reasoning) — this
	 * conductor relies on the host's protected tail rather than owning its own.
	 *
	 * Note on `agent-unfold`: because this conductor emits a `group` (no `{#code FOLDED}` tags),
	 * the agent never has a fold code for a compacted block, so it could not `unfold` (or even
	 * `recall`) one regardless. The lock is the honest declaration of intent and future-proofs
	 * against the agent unfolding any OTHER folded block while this conductor is exclusive.
	 *
	 * NOTHING applies this list today — the new contract's host (Phase C) owns turning a
	 * conductor's declared `locks` into an actual `Truth.setLocks(...)` call on attach/detach.
	 * This conductor only DECLARES the intent; enforcement is out of scope for this port.
	 */
	readonly locks: readonly LockName[] = ["human-steering", "agent-unfold"];

	protected readonly systemPrompt = COMPACTION_SYSTEM;
	protected readonly priorTag = "previous-summary";

	/**
	 * User blocks are never eligible to be folded into the summary group (PORT FIDELITY §2 above).
	 * They still count as "aged" and still get fed to the prompt (as context, via `newlyAged`) —
	 * they are only ever excluded from the group MEMBERSHIP, which forces `emitCoverageGroup`'s
	 * run-walk to split around them so they stay live, full-fidelity, on the wire.
	 */
	protected includeInGroup(b: ViewBlock): boolean {
		return b.kind !== "user";
	}

	protected firstPassInstruction(): string {
		return "Create a structured summary from the conversation history above.";
	}

	protected recursiveInstruction(): string {
		return (
			'Update the summary in <previous-summary> using the new conversation history in <conversation>. PRESERVE ' +
			"all still-relevant details from the previous summary; remove stale ones; merge in new facts. Move " +
			'completed work into "Progress" and revise "Next Steps" accordingly. Preserve exact file paths, function ' +
			"names, and error messages when known. Reference user requests only for context — do not reproduce them " +
			"verbatim and do not add a user-messages section; they remain live on the wire outside this summary."
		);
	}

	protected formatText(count: number, body: string): string {
		return `[Compacted summary of ${count} earlier message${count === 1 ? "" : "s"}]\n\n${body}`;
	}

	protected emptyOutputMessage(_count: number): string {
		return "Naive compaction failed — model returned an empty summary";
	}

	protected windowTooTightMessage(inputTokens: number, contextWindow: number): string {
		return `Naive compaction needs a bigger window — input ≈ ${inputTokens} tokens leaves no room to write in a ${contextWindow}-token window`;
	}

	/**
	 * Unlike `handoff`'s reject message, this one does not surface the provider's real error text —
	 * ported verbatim from the pre-#82 conductor, which only ever reported a generic "waiting for
	 * new context" message here (availability used to be reported by the old contract's separate
	 * `can("complete")` pre-check instead; see the base class's PORT FIDELITY note). Kept as-is: a
	 * real behavioral difference from `handoff`, not an oversight of this extraction.
	 */
	protected rejectMessage(_err: unknown): string {
		return "Naive compaction failed — waiting for new context to age in before retrying";
	}
}

// ── utilities ─────────────────────────────────────────────────────────────────

/** Neutralize a `</conversation>` / `</previous-summary>` sentinel-breakout attempt hidden in
 *  interpolated, attacker-influenceable content (PORT FIDELITY §1 / PR #82 task 2 — this conductor
 *  had no such defense before; `handoff`'s identical defense is the ported original). */
export function neutralizeSentinels(s: string): string {
	return neutralizeClosingTags(s, ["conversation", "previous-summary"]);
}

export { sumTokens, blockLabel };
