# Naive compaction conductor

A deliberately-lossy LLM-summarization foil (ADR 0014): when the visible context crosses 90% of
budget, summarize the aged region (everything older than the protected working tail, minus any
human-held or already-grouped blocks — **all kinds**, `user` included) into ONE literal summary
group. Recursive on later passes (`<previous-summary>` + only the newly-aged blocks — the
already-summarized originals are deliberately never re-read). User messages are reproduced
verbatim in the summary; only assistant reasoning compounds loss across passes. Non-recoverable:
the emitted `group`'s digest is a plain string, never a `{#code FOLDED}` tag, so the agent has no
`unfold` path back to the originals — only a human detaching the conductor can.

This is a straight port of the deleted `conductors/compaction-naive/compaction-naive.ts`
(git rev `dc037bc`) onto the new conductor-v2 contract via the `ViewConductor` adapter
(`core/conductor/view.ts`), which bridges the old `conduct(view) → Command[] | null` vocabulary.

## Files

- `compaction-naive.ts` — the `NaiveCompactionConductor` (`ViewConductor` subclass) plus the
  ported `COMPACTION_SYSTEM` prompt and `buildPrompt`/`blockLabel`/`sumTokens` helpers.
- `compaction-naive.test.ts` — golden tests against `core/conductor/testhost.ts`'s `TestHost`.

## Port fidelity — real adaptations (not cosmetic)

1. **No `host.can()`.** The old contract's `ConductorHost.can("complete"/"countTokens")`
   pre-flight checks are gone from the new contract. `countTokens` is now unconditionally
   available; a **rejected** `complete()` promise IS the "model unavailable" signal. The old
   `if (!can("complete")) { setStatus(...); return; }` branch is removed — this conductor always
   attempts the call (subject to the same `lastAttemptKey` retry gate it always had) and reports
   failure from the reject handler instead.

2. **`this.rerun()` replaces `host.requestRerun()`.** `ViewConductor.rerun()` is the adapter's
   local successor: a protected method the subclass calls directly once its async completion
   resolves, to schedule a fresh `conduct()` pass immediately.

3. **Trigger math: the raw baseline can no longer come from `view.liveTokens`.** The old
   contract's `ConductorView.liveTokens` was, per ADR 0014 §2, "the RAW, fully-unfolded size (the
   host clears conductor folds before every pass)" — always growing, which is what let the
   conductor subtract its own tracked saving to get a `visible` window with real hysteresis.

   In the new core, a `group` op this conductor proposes is a **persistent** Truth-level overlay,
   not something the host clears and re-derives every pass — so `Truth.stats().liveTokens` (what
   `ConductorView.liveTokens` is materialized from) already reflects this conductor's own prior
   folding. Subtracting `savedTokens` from it a second time would double-count the saving and
   starve the trigger indefinitely after the first compaction.

   Fix: `ViewBlock.tokens` is documented as the block's "full token cost", unaffected by current
   fold/group state. Summing it over every block (`sumTokens(view.blocks)`) reconstructs exactly
   the always-growing raw baseline the original algorithm assumed. Everything downstream —
   `savedTokens = Σ survivor tokens − summary cost`, `visible = rawTotal − savedTokens`,
   `visible >= 0.9 * budget` — is the untouched original formula, fed a locally-reconstructed
   `rawTotal` instead of the (now fold-aware) `view.liveTokens`.

4. **Sticky reject status.** The old reject handler only cleared `inflight` (unavailability was
   reported by the removed `can()` pre-check instead). This port calls `host.setStatus(...)`
   directly from the reject handler so a human still sees why nothing is progressing; the status
   is sticky — left in place until a genuinely new aged set changes `lastAttemptKey` and a fresh
   attempt clears it right before launching.

Everything else — `agedRegion`, `emitSummaryGroup`'s per-run walk (a held/grouped block splits the
region into multiple groups, each carrying the same digest), `COMPACTION_SYSTEM`, both
`buildPrompt` branches (first-pass and recursive-merge), `MAX_SUMMARY_TOKENS` (8000),
`lastAttemptKey` retry gating, and the stale-completion guard (comparing `AbortController`
identity) are ported unchanged.

## Locks

Declares `locks: ["human-steering", "agent-unfold"]` (ADR 0011) — data only. Neither `TestHost`
nor the `ViewConductor` adapter applies a conductor's declared `locks` to the underlying `Truth`
on attach/detach; that is the Phase-C host's job (turning `conductor.locks` into an actual
`Truth.setLocks(...)` call). Tests that need the lock genuinely enforced should drive
`host.truth.setLocks([...], "compaction-naive")` directly in setup.
