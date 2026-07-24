/*
 * conductors/in-process/compaction-naive/compaction-naive.ts — the "Naive compaction" conductor.
 *
 * PORTED from the deleted `conductors/compaction-naive/compaction-naive.ts` (ADR 0014, git rev
 * dc037bc) onto the conductor-v2 contract, via the `ViewConductor` adapter
 * (`core/conductor/view.ts`). Since that port, PR #82 factored the ~90%-duplicated machinery it
 * shared with the sibling `handoff` conductor into `../agedSummaryConductor.ts`'s
 * `AgedSummaryConductor` base class (aged-region derivation, foreign-grouped-id exclusion, group
 * emission, completion launch/inflight/attempt-key/sticky-status lifecycle, and the output-token
 * reservation math). This file now owns only what is genuinely different: `COMPACTION_SYSTEM`,
 * the two `buildPrompt` instruction strings, the count-preamble format, and the three status
 * messages.
 *
 * PARITY NOTE (restored): PR #82 briefly excluded `user`-kind blocks from the fold via an
 * `includeInGroup` override, on the theory that main's "verbatim" promise was unenforceable for an
 * oversized user message. That override has been REMOVED — this conductor once again matches
 * main's behavior byte-for-byte: ALL kinds, including `user`, are swallowed into the single summary
 * group (see `AgedSummaryConductor`'s default `includeInGroup` — every kind). The count preamble
 * (`[Compacted summary of N earlier message(s)]`) counts every aged block again, and a human-held
 * block is the only thing that still splits the group's run.
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
 *   2. USER MESSAGES ARE SWALLOWED INTO THE GROUP, EXACTLY LIKE EVERY OTHER KIND (main parity,
 *      restored — see the PARITY NOTE above). `COMPACTION_SYSTEM` carries main's original "USER
 *      MESSAGES ARE SACRED. Reproduce EVERY user message VERBATIM ... in the '## User messages'
 *      section" instruction verbatim, and both `buildPrompt` instruction strings restore the
 *      matching "carry forward every verbatim user message" / recursive-merge wording. The summary
 *      is expected to actually preserve every user message word-for-word inside that section — the
 *      model is trusted to do so (the same trust every mainstream `/compact`-style tool places),
 *      and there is deliberately no mechanical enforcement of that promise: an oversized user
 *      message is exactly the kind of quality loss this conductor exists to demonstrate as a foil,
 *      not something Accordion's own conductor should quietly work around.
 *
 * Everything else — `COMPACTION_SYSTEM`'s structured-briefing shape, the recursive-merge
 * instructions, and the `MAX_OUTPUT_TOKENS`(8000) / `MIN_OUTPUT_TOKENS`(1000) /
 * `OUTPUT_SAFETY_MARGIN`(512) constants (now shared, unchanged in value) — is ported/kept
 * unchanged.
 *
 * No Svelte, no `$state`, no engine imports. Types only from `../../conductor/contract` and
 * `../agedSummaryConductor`.
 */
import { AgedSummaryConductor, neutralizeClosingTags, sumTokens, blockLabel } from "../agedSummaryConductor";
import type { LockName } from "../../../core/conductor/contract";

/**
 * System prompt for the compaction LLM call. Restored VERBATIM from origin/main (PARITY NOTE
 * above) — structured-briefing template whose one sacred rule is that user messages are reproduced
 * VERBATIM inside a dedicated "## User messages" section; every other kind is genuinely summarized.
 */
export const COMPACTION_SYSTEM = `\
You are a context-compaction assistant. Your task is to read a segment of an AI \
assistant's conversation history and produce a compact, structured briefing that the \
assistant can use to continue working effectively without seeing the original messages.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. \
ONLY output the structured summary.

USER MESSAGES ARE SACRED. Reproduce EVERY user message VERBATIM, in order, exactly as \
originally written, in the "## User messages" section. Do not paraphrase, abbreviate, \
summarize, or omit a single user message — the human's intent and instructions must \
survive compaction intact. (Assistant text, thinking, tool calls, and tool results ARE \
summarized; only user messages are preserved word-for-word.)

Produce your output in EXACTLY this structure — no prose outside the sections. Keep \
every section even when empty; write "(none)" where nothing applies:

## User messages
Every user message from the summarized segment, reproduced verbatim, in order, each \
clearly separated. If there are no user messages, write "(none)".

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

Be terse everywhere EXCEPT the verbatim user messages, which must be complete. Omit \
pleasantries, meta-commentary, and filler. The output will be placed directly into the \
agent's context window.`;

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

	// `includeInGroup` is NOT overridden — every kind, including `user`, may be folded into the
	// summary group (main parity, restored — see this file's banner PARITY NOTE).

	protected firstPassInstruction(): string {
		return "Create a structured summary from the conversation history above.";
	}

	protected recursiveInstruction(): string {
		return (
			'Update the summary in <previous-summary> using the new conversation history in <conversation>. PRESERVE ' +
			"all still-relevant details from the previous summary; remove stale ones; merge in new facts. Move " +
			'completed work into "Progress" and revise "Next Steps" accordingly. Preserve exact file paths, function ' +
			"names, and error messages when known. Carry forward every verbatim user message from the previous " +
			'summary and append the new user messages from the conversation — all still reproduced word-for-word in ' +
			'"## User messages".'
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

	/**
	 * Sticky status when the completion rejected because the session has no live model link (see
	 * `isUnavailableError` in the base class). Mirrors main's `host.can("complete")` pre-check
	 * message verbatim — the base class also clears `lastAttemptKey` for this case, so the very next
	 * pass retries automatically once the link returns, exactly like the old pre-flight did.
	 */
	protected unavailableMessage(): string {
		return "Naive compaction unavailable — waiting for live model link";
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
