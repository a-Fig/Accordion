# ADR 0017 — The birth-fold exemption: letting a conductor fold a block before it is ever sent

**Status:** accepted
**Date:** 2026-07-05
**Builds on:** [ADR 0007](0007-conductor-protocol.md) (the conductor contract — `conduct →
Command[]`, the "complete desired state" re-apply model), [ADR 0011](0011-conductor-involvement-locks.md)
(the `tail-size` lock — the ONLY existing way a conductor could previously touch the protected
tail).

## Context

The protected working tail exists so the agent's most recent reasoning never gets folded out
from under it mid-turn. It is a **token-target walk-back from the newest block** — not a
fixed number of turns — so its width in blocks shrinks and grows with how big those blocks
happen to be.

That has a sharp edge (issue #43): a single **huge** `tool_result` — a large file read, a big
shell dump — streams in as the newest block and, by construction, is *inside* the tail the
instant it arrives (the walk-back always includes at least the newest block, however large).
Every conductor without the `tail-size` lock is refused by `substOne`'s "protected" clamp on
that block, so the model sees it **at full, uncompressed size on its very first call** — the
exact case a folding tool exists to prevent. Only an EXCLUSIVE conductor holding `tail-size`
could route around this, and that requires the user to grant it ownership of the *entire*
tail, an outsized ask to fix what is really a first-arrival edge case.

The insight: protection exists to stop the agent from having context **yanked out from under
it** — content it has already seen and may be reasoning about right now. A block the model has
**never yet seen** has nothing to yank; there is no continuity to protect. So a block that
hasn't crossed the wire yet should be foldable regardless of where it geometrically falls
relative to the tail boundary.

## Decision

### 1. `fresh` — a new per-block signal on `ConductorView`

`ViewBlock.fresh: boolean` (additive, `conductors/contract/conductor.ts`) is true for a block
that has **never yet been part of a completed model call**. A conductor may fold or replace a
`fresh` block even while it is `protected`, without holding the `tail-size` lock — a narrow,
kind-gated exemption from the protected-tail floor, not a new capability. `wireFoldable` still
applies: `fresh` never makes a `user` or `tool_call` block foldable.

### 2. The "sent" cursor: `sentThroughOrder` + `markSent()`

The host (`AccordionStore`) tracks the highest block `order` that has actually reached the
model in an **applied** plan (`sentThroughOrder`, starts at -1). `isFresh(b)` is simply
`b.order > sentThroughOrder`. The cursor advances only via `markSent()`, called by the live
client **after replying to a `planned` sync** — the ONE sync site whose reply the extension
actually applies to a model call (`extension/accordion.ts`'s `context` hook). Every other sync
site (`message_end`, `agent_end`, `model_select`, the connect-time backlog flush) is
VIEW-ONLY — the extension never awaits or applies their replies — so they must NOT advance the
cursor. `SyncMessage.planned?: boolean` (protocol v6, additive) carries this distinction over
the wire; `liveClient.svelte.ts` calls `markSent()` iff `msg.planned === true`.

### 3. Why the exemption must be STICKY (`birthFolded`), not fresh-only

Commands are re-applied from a **raw baseline every pass** (ADR 0007's "complete desired
state" model): `clearConductorState()` resets every conductor-owned block before `conduct()`
runs again. If eligibility were purely `isFresh(b)`, a block a conductor folded on pass 1 would
un-fold ITSELF the moment `markSent()` advances past it on pass 2 — the model has now seen it
once, so it reads non-fresh, but it is still `protected` (it hasn't aged out of the tail yet)
and no non-`tail-size` conductor may fold a protected block outside this exemption. That is a
regression the conductor did not ask for and cannot see coming.

The fix: `AccordionStore` keeps a `birthFolded: Set<string>` of block ids it has successfully
birth-folded. `birthFoldEligible(b)` is `wireFoldable(b) && (birthFolded.has(b.id) ||
isFresh(b))` — the sticky set stands in for "was fresh when this became folded" for as long as
the block remains in the tail. `substOne` adds an id to the set the moment it applies a
fold/replace to a block that is protected (which, given the eligibility gate, is necessarily a
birth-fold). The set lives **outside** `clearConductorState`'s per-pass reset on purpose.

Pruning: `pruneBirthFolded()` (called every `runConductor()` pass, alongside the existing
`pruneProtectedGroups()`) drops an id the moment its block is no longer `isProtected` — once a
block ages out of the tail, ordinary (non-birth) fold rules already cover it, so the sticky
entry would otherwise leak forever as dead weight.

A human mutator (`fold`, `unfold`, `pin`) deletes the id from `birthFolded` — the human now
owns that block's fold state outright, and the pre-existing human-override clamp in `substOne`
already refuses a conductor's competing fold regardless.

### 4. `healProtected` is unchanged, and that is correct

`healProtected` only force-reverts a HUMAN override (`b.override === "folded"`) that the tail
has grown over. A birth-folded block has `override === null` (it is conductor-owned — `subst`
+ `autoFolded`, exactly like an ordinary conductor fold) — so `healProtected` was already
inert against it, no new gate was needed. Confirmed by test
(`store.birthfold.test.ts`, case (g)).

### 5. Bulk-loaded (non-live) sessions are never fresh

A parsed transcript — the sample session, an opened `.jsonl`, a Claude Code read-only
browse — hands the constructor its full block array up front. Those blocks were **factually
already part of a completed conversation**; none of them should ever read `fresh`. The
constructor calls `markAllSent()` (sets `sentThroughOrder` to the last block's `order`)
immediately after `reindex()`, before the first `refold()`. A LIVE session constructs with an
**empty** block array and streams everything in via `appendBlocks` — `markAllSent()` is then a
no-op (nothing to mark), and freshness is governed purely by `markSent()` per planned sync.
This is the one behavioral fork in the whole feature; every other code path (the store's fold
machinery, the conductor contract, the wire) is identical for both session kinds.

### 6. A demo conductor: `birth-fold-demo`

`conductors/birth-fold-demo/birth-fold-demo.ts` (registered in `IN_PROCESS_CONDUCTORS`,
collaborative — no locks) folds any block where `fresh && protected && kind === "tool_result"
&& tokens > 4000`. It exists purely to exercise the new `fresh` flag end-to-end; it is not a
serious context-management strategy.

## Known, accepted limitation

**First full sync after a live attach/reconnect is conservatively marked sent:** on the very
first `context` hook after the GUI connects (or reconnects to a resumed session), the entire
pre-existing history streams in as one `full` sync into a freshly-built EMPTY store
(`sentThroughOrder` = -1). Without correction, every replayed block would read `fresh`
(`order > -1`) and a birth-folding conductor could fold the already-seen protected tail during
the very pass the append triggers — recording those ids in the sticky `birthFolded` set, which
the later `markSent()` does not undo. That is a protection BYPASS on content the model has
genuinely seen, the exact thing protection exists to prevent. So the live client passes
`appendBlocks(blocks, { sent: true })` for any `full: true` sync, advancing `sentThroughOrder`
past the incoming blocks' max order BEFORE the internal conduct pass runs — history replay is
never mistaken for newly-born content. The cost: genuinely-new blocks that happen to arrive in
that same full sync (e.g. a huge tool_result completing right at attach time) are ALSO marked
sent, losing birth-foldability for that one call. This is deliberate — conservative rather
than permissive: over-protecting one block for one call is the mild, self-correcting failure
(it ages out of the tail normally), whereas the permissive alternative silently folds
already-seen protected content and sticks. Distinguishing "replayed history" from
"new-in-this-full-sync" precisely would mean threading per-block sent state through the wire,
disproportionate to a single-call window.

**The protected-tail walk-back keeps using FULL tokens, not folded tokens.** A birth-folded
block's boundary math is untouched by this ADR: `protectedFromIndex` still walks back by each
block's full `tokens`, exactly as before. This is deliberate — if the walk-back used a folded
block's shrunk size, the tail boundary would move every time a conductor birth-folds something,
which could pull an OLDER block into the tail on the very next pass (or push one out), making
the tail's width a function of conductor decisions instead of a stable policy the conductor
reads. The boundary must not breathe in response to the folds it itself causes.

## Consequences

- **A conductor no longer needs the `tail-size` lock to avoid shipping an oversized first
  block whole.** The exemption is narrow (kind-gated, sticky-but-boundable, never touches
  already-seen content) and requires no user consent gate — it is additive to every existing
  collaborative conductor's behavior for free.
- **Protocol version bump (v5 → v6, additive):** `SyncMessage.planned?: boolean`. Old
  extensions/GUIs that omit the field simply never birth-fold (falls back to pre-#43
  behavior, i.e. `sentThroughOrder` never advances past -1 for a fresh block — actually it
  advances via `markAllSent()` only for bulk loads, so a live session on an old extension
  paired with a new GUI would see everything as permanently fresh; version-mismatch is
  already a hard error in `liveClient.svelte.ts`, so this combination cannot occur in
  practice).
- **The golden test (`conductor.builtin.test.ts`) is untouched** — the built-in conductor
  never overs its own tail (`tailTokens` omitted ⇒ 0, no lock), so `fresh` never changes its
  behavior; the byte-identical snapshot stays green.
- **New engine-owned state** (`sentThroughOrder`, `birthFolded`) mirrors the existing
  `protectedFromIndex`/group-pruning pattern — computed/pruned once per `runConductor()` pass,
  never duplicated per-conductor.

## Rejected alternatives

- **Require every conductor to hold `tail-size` to fix this.** Rejected: it forces an
  all-or-nothing consent gate and full tail ownership onto conductors that only want to avoid
  one edge case (a huge first block), which is a disproportionate ask for a narrow problem.
- **Shrink the protected tail to exclude a single huge boundary block.** Already the existing
  `PROTECT_OVERFLOW_CAP` behavior for OLDER blocks being pulled in — but the NEWEST block is
  unconditionally protected regardless of size (by design: the tail must never be empty), so
  this doesn't reach the huge-newest-block case at all.
- **A fresh-only (non-sticky) exemption.** Rejected: breaks on the very next conductor pass
  once `markSent()` advances, since commands re-apply from a raw baseline every time (see
  Decision §3) — a bug that would look like folding is randomly unstable.
- **Thread per-block "was this part of history-at-attach" state through the wire so
  genuinely-new blocks in a first full sync keep their birth-foldability.** Rejected as
  disproportionate to a single-call window; the full sync is conservatively marked sent
  instead (see Known limitation above).
