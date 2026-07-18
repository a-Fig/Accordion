# Naive compaction conductor

A deliberately-lossy LLM-summarization foil (ADR 0014): when the visible context crosses 90% of
budget, summarize the aged region (everything older than the protected working tail, minus any
human-held or already-grouped blocks) into ONE literal summary group. Recursive on later passes
(`<previous-summary>` + only the newly-aged blocks — the already-summarized originals are
deliberately never re-read). Non-recoverable: the emitted `group`'s digest is a plain string, never
a `{#code FOLDED}` tag, so the agent has no `unfold` path back to the originals — only a human
detaching the conductor can.

This is a port of the deleted `conductors/compaction-naive/compaction-naive.ts` (git rev `dc037bc`)
onto the conductor-v2 contract via the `ViewConductor` adapter (`core/conductor/view.ts`). PR #82
then factored the machinery this conductor shared near-verbatim with the sibling `handoff`
conductor into `../agedSummaryConductor.ts`'s `AgedSummaryConductor` base class — see that file's
own doc comment and "Shared base (PR #82)" below.

## User messages: preserved by staying live, not by the summary

Pre-#82, this conductor's system prompt PROMISED user messages were reproduced verbatim inside the
summary, while mechanically folding them into the SAME non-recoverable group as everything else —
capped at 8000 output tokens, with any nonempty result accepted and nothing checking the promise
actually held. A single user message larger than the cap made "verbatim" mathematically impossible;
a smaller one could be silently paraphrased and nothing would notice.

Fixed mechanically, not by prompt-tweaking: `NaiveCompactionConductor.includeInGroup` excludes every
`user`-kind block from ever becoming a group member. The shared base's run-walk
(`emitCoverageGroup`) treats an excluded block exactly like a held or foreign-grouped one — it
forces the run to split around it — so a user block always sits live, at full token cost, either
between two summary groups or beside one. It is still fed to the completion prompt as CONTEXT (via
`newlyAged`), so the summary can accurately describe what was asked; it is just never a candidate to
be folded away.

**The honest cost of this fix: aged user messages stay live, at full token cost, forever.** They are
never grouped, never folded, never counted as "saved" by the trigger math (see
`AgedSummaryConductor.conduct`'s `survivors` filter). In a session with a large volume of user text,
this conductor's real compaction ratio is worse than the pre-#82 numbers implied, because those
numbers were crediting savings from content that was never safely removable in the first place. This
is the same rule the UI's own fold gate applies elsewhere in Accordion: user words are sacred, and
"the conductor collapsed my instructions into a lossy AI paraphrase, silently" is not a trade this
codebase is willing to make just to hit a better ratio. `handoff` (the sibling conductor) does NOT
apply this exclusion — see its own README for why that is a deliberate difference, not the same bug.

## Prompt injection defense

Block text and the prior round's summary are interpolated inside `<conversation>` /
`<previous-summary>` tags when building the completion prompt. Pre-#82, this conductor had NO
defense against a tool result whose content contained a literal `</conversation>` — a web fetch or
file read (attacker-influenceable) could break out of the data section and inject fake instructions
into the summarizer, e.g. baking fabricated "verbatim user messages" into the summary. The sibling
`handoff` conductor already had this defense; PR #82 moved it into the shared base
(`AgedSummaryConductor.buildPrompt`'s `neutralize`) so both conductors get it structurally rather
than by each remembering to port it. `COMPACTION_SYSTEM` also declares everything inside those tags
untrusted data, never instructions.

## Files

- `compaction-naive.ts` — the `NaiveCompactionConductor` (`AgedSummaryConductor` subclass): the
  `COMPACTION_SYSTEM` prompt, the two `buildPrompt` instruction strings, the count-preamble format,
  the three status messages, and the `includeInGroup` override that excludes `user` blocks.
- `compaction-naive.test.ts` — golden tests against `core/conductor/testhost.ts`'s `TestHost`.
- `../agedSummaryConductor.ts` — the shared base class (see "Shared base (PR #82)" below).

## Shared base (PR #82)

`NaiveCompactionConductor` and `HandoffConductor` were ~90% duplicated: the same aged-region
derivation, foreign-grouped-id exclusion, group-emission run-walk, completion launch/inflight/
attempt-key/sticky-status lifecycle, and output-token reservation math (`MAX_OUTPUT_TOKENS`(8000) /
`MIN_OUTPUT_TOKENS`(1000) / `OUTPUT_SAFETY_MARGIN`(512) — this conductor's own copies were literally
commented "copied verbatim from handoff"). That duplication had already drifted: this conductor was
missing `handoff`'s prompt-injection neutralizer, and this conductor alone had the user-verbatim bug
above. `../agedSummaryConductor.ts`'s `AgedSummaryConductor` now owns all of that; this file owns
only what is genuinely different (documented in its own top-of-file PORT FIDELITY notes) — mainly
the prompt text and the `includeInGroup` override.

## Port fidelity — real adaptations (not cosmetic)

Everything below is now implemented ONCE, in `AgedSummaryConductor`, rather than duplicated per
conductor. Summarized here because it explains why the code looks the way it does; see the base
class's own doc comment for the full detail.

1. **No `host.can()`.** The old contract's `ConductorHost.can("complete"/"countTokens")`
   pre-flight checks are gone from the new contract. `countTokens` is now unconditionally
   available; a **rejected** `complete()` promise IS the "model unavailable" signal.

2. **`this.rerun()` replaces `host.requestRerun()`.** `ViewConductor.rerun()` is the adapter's
   local successor: a protected method the subclass calls directly once its async completion
   resolves, to schedule a fresh `conduct()` pass immediately.

3. **Trigger math: the raw baseline can no longer come from `view.liveTokens`.** A `group` op this
   conductor proposes is a **persistent** Truth-level overlay, not something the host clears and
   re-derives every pass — so `Truth.stats().liveTokens` already reflects this conductor's own
   prior folding. The base class reconstructs the always-growing raw baseline locally instead, via
   `sumTokens(view.blocks)` (every block's full, un-folded token cost).

4. **Sticky failure status.** A completion failure (reject, empty output, or a too-tight window)
   sets a status that survives subsequent `conduct()` passes until a genuine retry launches or a
   result commits — every idle path calls `surfaceIdleStatus()` instead of bare-clearing the bar.

Everything else — `agedRegion`, the group-emission run-walk (a held/grouped/excluded block splits
the region into multiple groups, each carrying the same digest), `COMPACTION_SYSTEM`, both
`buildPrompt` instruction strings, the output-token reservation constants, `lastAttemptKey` retry
gating, and the stale-completion guard (comparing `AbortController` identity) — is ported/kept
unchanged in behavior, just relocated to the shared base (or, for the prompt text and
`includeInGroup`, kept here since they are genuinely this conductor's own).

## Locks

Declares `locks: ["human-steering", "agent-unfold"]` (ADR 0011). Neither `TestHost` nor the
`ViewConductor` adapter applies a conductor's declared `locks` to the underlying `Truth` on
attach/detach — those are unit-test scaffolding; a test that needs the lock genuinely enforced
still drives `host.truth.setLocks([...], "compaction-naive")` directly in setup. The live path
is different: `LiveConductorHost.select` (`core/conductor/liveHost.ts`) applies this
declaration for real — eagerly, the instant the conductor attaches to a live session — and
releases it via the freeze kill switch on detach.
