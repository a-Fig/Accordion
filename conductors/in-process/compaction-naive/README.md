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

## User messages: swallowed into the summary, preserved by the prompt's promise (main parity)

An earlier revision of this port (PR #82) briefly excluded `user`-kind blocks from the group
entirely, via a `NaiveCompactionConductor.includeInGroup` override, on the theory that main's
"reproduce verbatim" promise was mechanically unenforceable for an oversized user message. That
override has since been REMOVED — this conductor is restored to match origin/main byte-for-byte:
ALL kinds, including `user`, are swallowed into the single summary group. `COMPACTION_SYSTEM` carries
main's original instruction verbatim: "USER MESSAGES ARE SACRED. Reproduce EVERY user message
VERBATIM, in order, exactly as originally written, in the '## User messages' section" — a dedicated
section the model is expected to fill in completely, while every other kind (assistant text,
thinking, tool calls, tool results) is genuinely summarized/lossy.

**This is a deliberate, unenforced trust, not an oversight.** There is no mechanical check that the
model actually reproduced every user message intact — the same trust every mainstream `/compact`-
style tool (Cursor's composer, Claude Code's own `/compact`) places in its summarizer. An oversized or
silently-paraphrased user message is exactly the kind of quality loss this conductor exists to
demonstrate as a foil, not something Accordion's own conductor should quietly engineer around —
engineering around it would make the foil less faithful to what it is imitating, not more useful.
`handoff` (the sibling conductor) makes the identical choice for the identical reason — see its own
README.

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
  and the four status messages (empty-output / window-too-tight / reject / unavailable).
  `includeInGroup` is NOT overridden — every kind, including `user`, is swallowed into the group.
- `compaction-naive.test.ts` — golden tests against `core/conductor/testhost.ts`'s `TestHost`.
- `../agedSummaryConductor.ts` — the shared base class (see "Shared base (PR #82)" below).

## Shared base (PR #82)

`NaiveCompactionConductor` and `HandoffConductor` were ~90% duplicated: the same aged-region
derivation, foreign-grouped-id exclusion, group-emission run-walk, completion launch/inflight/
attempt-key/sticky-status lifecycle, and output-token reservation math (`MAX_OUTPUT_TOKENS`(8000) /
`MIN_OUTPUT_TOKENS`(1000) / `OUTPUT_SAFETY_MARGIN`(512) — this conductor's own copies were literally
commented "copied verbatim from handoff"). That duplication had already drifted: this conductor was
missing `handoff`'s prompt-injection neutralizer. `../agedSummaryConductor.ts`'s `AgedSummaryConductor`
now owns all of that (including link-unavailability classification — see "Port fidelity" §1 below);
this file owns only what is genuinely different (documented in its own top-of-file PORT FIDELITY
notes) — mainly the prompt text and the four status messages.

## Port fidelity — real adaptations (not cosmetic)

Everything below is now implemented ONCE, in `AgedSummaryConductor`, rather than duplicated per
conductor. Summarized here because it explains why the code looks the way it does; see the base
class's own doc comment for the full detail.

1. **No `host.can()`.** The old contract's `ConductorHost.can("complete"/"countTokens")`
   pre-flight checks are gone from the new contract. `countTokens` is now unconditionally
   available; a **rejected** `complete()` promise IS the "model unavailable" signal —
   `AgedSummaryConductor`'s `isUnavailableError` classifies that rejection (keyed on the exact
   `"no model available"` message `extension/accordion.ts`'s `runCompletion` throws when the
   session has no live model) and, on a match, shows the calm main-parity status ("Naive
   compaction unavailable — waiting for live model link") AND clears the retry gate so the very
   next pass retries automatically — mirroring main's pre-check exactly, without ever recording a
   failed attempt for this case. A genuine rejection (a real provider error, a timeout, …) still
   shows the sticky reject message and still waits for genuinely new content before retrying.

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

Everything else — `agedRegion`, the group-emission run-walk (a held block splits the region into
multiple groups, each carrying the same digest), `COMPACTION_SYSTEM`, both `buildPrompt` instruction
strings, the output-token reservation constants, `lastAttemptKey` retry gating, and the
stale-completion guard (comparing `AbortController` identity) — is ported/kept unchanged in behavior,
just relocated to the shared base (or, for the prompt text and status messages, kept here since they
are genuinely this conductor's own).

## Locks

Declares `locks: ["human-steering", "agent-unfold"]` (ADR 0011). Neither `TestHost` nor the
`ViewConductor` adapter applies a conductor's declared `locks` to the underlying `Truth` on
attach/detach — those are unit-test scaffolding; a test that needs the lock genuinely enforced
still drives `host.truth.setLocks([...], "compaction-naive")` directly in setup. The live path
is different: `LiveConductorHost.select` (`core/conductor/liveHost.ts`) applies this
declaration for real — eagerly, the instant the conductor attaches to a live session — and
releases it via the freeze kill switch on detach.
