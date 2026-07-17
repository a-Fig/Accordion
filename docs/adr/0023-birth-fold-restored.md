# ADR 0023 — Birth-fold, restored: folding a block before it is ever sent

**Status:** accepted (restores [ADR 0018](0018-conductor-birth-fold.md), previously removed from
devmain and re-filed as issue #77)
**Date:** 2026-07-17
**Builds on:** [ADR 0011](0011-conductor-involvement-locks.md) (the `tail-size` lock — historically
the *only* way a strategy could touch the protected tail before this exemption existed),
[ADR 0021](0021-truth-in-the-extension.md) (the Truth that now owns `sentThroughOrder`/`birthFolded`
in the pi extension process, and the divergence-rebuild / snapshot fixes this ADR depends on),
[ADR 0022](0022-conductor-contract-v2.md) (the `wire-departing` `HostEvent` and `holdWireUpToMs` —
the seam `doorman` uses to exercise this exemption).
**Supersedes:** [ADR 0018](0018-conductor-birth-fold.md), which specified the same mechanism
against the pre-excision GUI-side store; that ADR's status line records its removal ("ripped out
for simplification") on 2026-07-11 and its re-filing as issue #77. This ADR is the restoration —
same mechanism, re-specified against `core/truth.ts` and the conductor-v2 contract.

## Context

The protected working tail exists so a strategy can never fold content the model has already
reasoned over mid-turn — it is a token-target walk-back from the newest block, not a fixed number
of turns, so it shrinks and grows with how large recent blocks happen to be. That has a sharp edge:
a single **huge** `tool_result` — a large file read, a big shell dump — streams in as the newest
block and, by construction, is inside the tail the instant it arrives (the walk-back always
includes at least the newest block, however large). Every conductor without the `tail-size` lock is
refused by the protected-tail clamp on that block, so the model sees it **at full, uncompressed
size on its very first call** — exactly the case folding exists to prevent. Only an exclusive
conductor holding `tail-size` could route around this, and that requires the user to grant it
ownership of the *entire* tail — an outsized ask to fix what is really a first-arrival edge case.

The underlying insight, unchanged from ADR 0018: the protected tail exists to stop content the
model has **already seen** from being yanked out from under it mid-reasoning. A block the model has
**never yet seen** has nothing to yank — there is no continuity to protect. So a block that has not
crossed the wire yet should be foldable regardless of where it geometrically falls relative to the
tail boundary, without needing the `tail-size` lock at all.

## Decision

### 1. `canFold` exempts never-sent blocks from the protected-tail floor

`Truth.canFold(b, by)` ([`core/truth.ts`](../../core/truth.ts)) is the one predicate every fold path
shares. For a human (`by: "you"`) protection is absolute — a protected block is never foldable by
hand, full stop. For a strategy (`by: "auto"`, or the agent unfolding/recalling, which route
through the same protected-block check elsewhere) the rule is:

```ts
if (this.isProtected(b)) return !this.sent(b); // birth-fold exemption
```

`sent(b)` is `b.order <= this.sentThroughOrder` — has this block's content already reached the
model in an applied plan? A protected block that has never been sent is birth-fold-eligible; a
protected block that has been sent even once is not. `opFold`/`opReplace` (the two ops that can
create a strategy fold) implement the identical check before applying: `if (this.isProtected(b)) {
if (this.sent(b)) return "protected"; this.birthFolded.add(id); }` — the moment a fold is applied
to a protected-but-unsent block, its id enters the sticky `birthFolded` set (see §3).

### 2. The sent cursor: `sentThroughOrder` + `markSent`, advanced at the wire-departure seam

`Truth` tracks the highest block `order` that has actually reached the model in an applied plan
(`sentThroughOrder`, starts at `-1`). The **only** place this advances in Phase B is the `context`
hook's step (d) in `extension/accordion.ts`: after (optionally) serializing the wire, `markSent`
is called with the order of the newest block present — the one point in the whole extension where
"this content just left for the model" is actually true. No other hook (`message_end`, `agent_end`,
`model_select`, a client attach) is view-only *and* advances the cursor; advancing it anywhere else
would mark content sent that the model has not actually seen.

### 3. Stickiness: `birthFolded` survives the strategy's own re-derivation

A `ViewConductor`-style strategy re-derives its complete desired state every pass and diffs against
what it previously applied ([ADR 0022](0022-conductor-contract-v2.md) §3) — so if eligibility were
purely `!sent(b)`, a block folded on pass 1 would become ineligible for its *own* prior fold the
moment `markSent` advances past it on pass 2: it now reads sent, but it is still protected (it has
not aged out of the tail), and no non-`tail-size` conductor may fold a protected block outside this
exemption. That is a regression the conductor never asked for.

The fix is `Truth`'s `birthFolded: Set<string>` — ids a strategy has folded via this exemption. Two
prunes keep it truthful ("in the tail AND never sent whole"):

- `pruneProtectedGroups`/`healProtected`'s housekeeping pass drops an id the moment its block is no
  longer protected (once a block ages out of the tail, ordinary fold rules already cover it).
- Any human mutator (`fold`/`unfold`/`pin`) deletes the id — the human now owns the block outright,
  and the existing human-override clamp already refuses a strategy's competing fold regardless.

Because these prune the set truthfully, it is **not** cleared on ordinary strategy re-derivation —
membership belongs to the block's wire history (has it ever been sent whole?), not to whichever
conductor first folded it.

### 4. `healProtected` skips the exemption — the reason a birth-fold outlives tail growth

`healProtected` force-reverts a fold the protected tail has grown over — but only when the fold is
either a human override or a **non**-birth-folded strategy fold:

```ts
if (b.override === "folded") { /* heal a human fold the tail grew over */ }
else if (b.autoFolded && !this.birthFolded.has(b.id)) { /* heal a non-birth strategy fold */ }
```

A birth-folded block is skipped: the model never saw it whole, so the tail growing over it (an
older block aging further into protection, or the block itself sliding deeper as newer content
arrives) yanks nothing back. The exemption ends naturally once the block ages *out* of the tail
(ordinary fold rules apply) or once a planned sync actually sends it whole (`markSent` advances
past its order, and the next housekeep prunes it from `birthFolded`).

### 5. Bulk-loaded sessions are born sent

A parsed transcript — the sample session, an opened `.jsonl`, a Claude Code read-only browse —
constructs `Truth` with its full block array up front. `Truth`'s constructor sets
`sentThroughOrderValue` to the last block's `order` immediately, so every loaded block reads
`sent`. None of that history is birth-foldable, which is correct: it was factually already part of
a completed conversation, and treating it as "never sent" would be a protection bypass on content a
human is actively browsing. A **live** session constructs with an empty block array and streams
everything in via `append`, so freshness there is governed purely by `markSent` at the wire seam.

### 6. `doorman` — the shipped proof, on the new `wire-departing` seam

`core/conductors/doorman/doorman.ts` is a raw `Conductor` (not a `ViewConductor`) that subscribes
directly to the `wire-departing` `HostEvent` and declares `holdWireUpToMs: 150`. On every
wire-departure it looks at `freshIds` (blocks never yet sent — the host's own definition of the
birth-fold-eligible set) and, for any candidate `tool_result` at least `MIN_SKELETON_TOKENS` (1500)
and not in the current turn: skeletonizes it in place if it is a worthwhile code read
(`{ kind: "replace", recoverable: true }`), folds it to the engine digest otherwise
(`{ kind: "fold" }`), or leaves it alone if skeletonizing would not actually save enough. Every
decision is proposed as one transaction against the pass's `baseRev`. Because doorman's candidates
are drawn straight from `freshIds`, every fold/replace it proposes is, by construction, exercising
the exemption in §1 — this is the mechanism's validation conductor, not an incidental user of it.

## Consequences

- **A conductor no longer needs the `tail-size` lock — and its consent gate — to avoid shipping an
  oversized first block whole.** The exemption is narrow (kind-gated by `wireFoldable`,
  sticky-but-boundable, never touches already-seen content) and additive to every existing
  collaborative conductor's behavior for free.
- **Snapshot round-trip is load-bearing** ([ADR 0021](0021-truth-in-the-extension.md)'s fix wave 1):
  `SnapshotState.birthFolded` must carry the set verbatim, or a replica GUI's own housekeeping heals
  a block the extension's Truth still keeps folded — a divergence that a bare rev-mismatch check
  cannot detect on its own, since both sides still advance by exactly one. `serializeSnapshot`/
  `hydrateSnapshot`/`Truth.adoptSnapshot` all round-trip `birthFoldedIds` for exactly this reason.
- **A structural-divergence rebuild must also carry `birthFolded` membership**, alongside the
  overlay and dials fix from the same wave — `Truth.rebuildFrom` copies `prev.birthFolded` for every
  surviving block id, so a compaction/fork/tree-nav rebuild does not silently un-exempt a block the
  model still has never seen whole.
- **Known, accepted cosmetic quirk: `healProtected` zeroes `by` provenance after an agent unfolds a
  birth-folded block.** `opUnfold`'s agent branch sets `override: "unfolded"`, `by: "agent"`, and
  removes the id from `birthFolded` — but it does not clear `autoFolded`. The very next housekeeping
  pass (run in the same `apply()` call) sees `autoFolded === true` and `!birthFolded.has(id)` and
  runs the non-birth heal branch, which sets `by = null`. The block's `override` correctly stays
  `"unfolded"` (the agent's action is not undone — the content is live), but the `by` field that
  would otherwise say `"agent"` reads `null` instead. This is a display/attribution quirk only — no
  fold state is wrong, and the same-turn provenance is still visible in the activity log at the
  moment the unfold happens — but it means a later read of `Block.by` cannot distinguish "the agent
  unfolded this" from "no one has touched this" for a block that happened to be birth-folded at the
  time. Accepted rather than special-cased, since fixing it would mean threading an extra
  `wasAgentUnfolded` bit through `healProtected` for a cosmetic-only gap.

## Deferred

- **Conductor-initiated recall (issue #78).** ADR 0019's `RecallCommand` — a conductor surfacing
  folded detail at the tail without paying the prompt-cache miss `restore` costs — was removed in
  the same simplification pass as birth-fold and is **deliberately not restored here**. The `Op`
  union (`core/ops.ts`) has room for a future `recall` op (mirroring the agent's own unblockable
  `recall` tool, [ADR 0011](0011-conductor-involvement-locks.md) §4), but adding it is out of scope
  for this ADR — birth-fold and conductor-recall are independent restorations, and this one only
  covers the former.
