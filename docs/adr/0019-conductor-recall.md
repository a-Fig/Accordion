# ADR 0019 — Conductor `recall`: surfacing folded content without a prompt-cache miss

**Status:** accepted
**Date:** 2026-07-05
**Builds on:** [ADR 0005](0005-agent-unfold.md) (the agent's `recall` tool — the read that this is
the conductor analog of), [ADR 0006](0006-multiblock-folds.md) (group collapse — the recall
injection rides the same same-role-adjacency footing as `GroupOp`), [ADR 0007](0007-conductor-protocol.md)
(the conductor contract and its "complete desired state" re-apply model — which recall is the
*one* deliberate exception to).

## Context

A conductor can `fold` a block (substitute its content with a short digest) and later `restore`
it. But `restore` un-folds the block **in place**: the full text goes back where the digest was,
mid-history. That rewrites the prefix the provider has already cached, so the very next model call
is a **prompt-cache miss** — the whole conversation up to that point must be re-processed. For a
conductor that wants to bring an old detail back into view for one stretch of work, that cache
miss is a real, recurring cost.

The agent already has the cheaper move: its `recall` tool (ADR 0005) reads a folded block's
original content back **as a fresh tool result** without changing the standing view — the folded
digest stays exactly where it is, and the full content arrives appended at the tail, so the cached
prefix is untouched. Issue #46 asks for the conductor to have the same move.

## Decision

### 1. `RecallCommand` — a new command in the union

`RecallCommand { kind: "recall"; ids: string[] }` (additive, `conductors/contract/conductor.ts`).
The named blocks **stay folded** (their `{#code FOLDED}` digests stay in place). The host records
the recall and, on the wire, appends each block's **original full text** as ONE synthetic
user-role message at a **stable anchor near the tail**. The anchor is **frozen** the moment the
recall is first issued, so the prefix up to it never shifts on later passes — the injection is
cache-safe, the exact opposite of an in-place unfold.

### 2. Sticky semantics — the ONE exception to full-state reset

Every other command is re-derived from the raw baseline each pass (ADR 0007): omit it and it
drops. A recall is **deliberately different**. Dropping a tail injection would mutate the prefix
and cost the very cache miss recall exists to avoid — so a recall persists by **host policy**
until one of:

- **(a)** the block is **unfolded** — human hand-unfold, agent `unfold` tool, OR the conductor
  simply stops folding it so it settles live on the wire. Once the full text is standing in place,
  the tail injection would be a redundant duplicate, so it is released.
- **(b)** the block **leaves the store** (structural reset).
- **(c)** the conductor issues **`restore`** for that id — the explicit opt-out. `restore` releases
  the recall in addition to its normal "return to live" meaning.

Merely leaving a recall out of a later `Command[]` batch keeps it alive. To release one, name it in
a `restore`. This exception exists **solely to protect the prompt cache** and is documented loudly
on `RecallCommand` and in the `recalled` field in the store.

### 3. Host state: `recalled`, frozen anchor, live text

`AccordionStore.recalled: Map<blockId, { anchorId }>` lives **outside** `clearConductorState`'s
per-pass reset (like `birthFolded` in ADR 0018). Only the **anchor** is stored — the injected text
is read **live** from `get(id).text` at emission time (`Block.text` is never mutated), so nothing
is copied or can go stale.

The anchor is chosen once, at record time: the **newest non-grouped, durable-id block whose
message emits no `tool_call`** at that instant — the closest a command can get to "just before
the working tail," and durable so `applyPlan` can re-resolve it on the wire. Every block of a
tool-calling message is excluded — not just the `tool_call` block itself: the injection lands
after the anchor's **message**, and a `text`/`thinking` sibling of a `tool_call` lives in that
same assistant message, so anchoring on the sibling would insert the synthetic user message
BETWEEN the call's message and its result — provider-invalid for providers that require a tool
result to immediately follow its call. (The sibling case is exactly what a newest-first walk
finds when a conduct pass runs on a view-only `message_end` sync mid-tool-loop, before the
result streams in.) As a wire-side backstop, `applyPlan` additionally slides any interior
insertion forward past tool_result message(s) — covering the group-swallow walk-back, which can
land on a tool-calling message the GUI-side picker never chose. The anchor is never re-chosen
while the recall is active, so the injection point stays byte-stable across passes (cache-safe).

**Recallability** mirrors `resolveRecall`/`computeFoldOps` exactly: a block is recallable iff it is
currently folded, a wire-foldable kind, durably identified, and NOT swallowed by a folded group
(the group owns its members on the wire). Anything else clamps — a nonexistent id ⇒ `unknown-id`;
a live block / non-foldable kind / non-durable id / grouped member ⇒ the new **`not-recallable`**
`ClampReason`. Re-recalling an already-recalled block is a silent no-op (the frozen anchor is kept).

`pruneRecalled()` runs at the END of each `runConductor()` pass (after fold state settles) and
drops any recall whose block ended the pass live or has left the store — case (a)/(b) above.

Every recall lifecycle transition is observable like any other conductor action: recording emits
"recalled to tail", an explicit `restore` release emits "recall released", and an auto-prune emits
"recall dropped" — each to both the activity feed and the decision journal (action `"recall"`).

### 4. Accounting stays honest

`recalledTokens` (derived) sums each active recall's injected text using the same estimator as
every other fold (`substTokens` over the labeled injection), and `liveTokens` includes it. The
folded block keeps costing its digest; the recall adds the full text on top — which is exactly
what the wire sends, so the budget readout matches reality. Zero when nothing is recalled, so the
raw/built-in path (and the golden test) is byte-identical.

### 5. The wire: `RecallOp` and `applyPlan`

`PlanMessage.recalls?: RecallOp[]` (pi protocol v6 → **v7**, additive). `RecallOp { id, afterId,
text }`: `text` is the labeled/tagged injection (`recallInjection` — ONE source of truth shared by
`recalledTokens` and `computeRecallOps`, mirroring the agent recall tool's `[recalled <label>
(#<code>)]` format), `afterId` is the frozen anchor, `id` is carried for correlation only.

`applyPlan(messages, ops, groups, recalls)` inserts ONE `{ role:"user", content:[{type:"text",
text}] }` message immediately AFTER the message that emits `afterId`. It is **additive** — it never
removes or edits an existing message, so tool_call/result pairing is untouched. It re-derives the
anchor defensively (never trusting the peer's shape) and applies a **group-swallow fallback**: if a
`GroupOp` in the same plan collapsed the anchor's message, insert after that group's summary; if the
run was dropped with no summary, after the last surviving message before the gap; if the anchor
can't be resolved at all, append at the very end. A malformed op is skipped; it never throws.

### 6. Detach / attach / reset drop recalls

`attach()`, `detach()`, and `resetAll()` clear `recalled` — the recalling conductor's authorship is
gone or being cleared, so its tail injections go with it. This is a **one-time** prompt-cache miss
(the injected messages leave the prefix), the same cost detach already pays to freeze folds.
Acceptable because these are deliberate, human-driven transitions, not per-turn churn.

### 7. A demo conductor: `recall-demo`

`conductors/recall-demo/recall-demo.ts` (registered, collaborative — no locks) folds large older
`tool_result`s and recalls the single most recent of them to the tail, showing `fold` + `recall`
composing. The `fold` for a block must precede its `recall` in the batch — `recall` requires the
block to be folded at the instant the host processes the command.

## Provider role-rhythm note (watch item)

The recall injects a **user-role** message at the tail. If the message immediately before the anchor
is already user-role, this creates two adjacent user messages — the same same-role-adjacency footing
`GroupOp` rides on (ADR 0006 watch item #1). Providers observed to date tolerate this, but it has
**not** been exhaustively live-verified for the recall path across every provider; verify live before
relying hard on adjacency correctness. The mitigation if a provider rejects it is the same as for
groups (coalesce adjacent same-role messages), and would live in `applyPlan`.

## Consequences

- **A conductor can surface folded detail without a cache miss** — the defining win over `restore`.
- **The AGENT's `recall` tool path is completely untouched** — different code path
  (`resolveRecall` / `recallRequest` wire / the extension `recall` tool), never lockable, unchanged.
- **Two protocol bumps, both additive:** conductor protocol v3 → v4 (the `Command` union grew;
  recall rides the existing `ConductorCommandsMessage.commands`), pi wire v6 → v7
  (`PlanMessage.recalls`). A host/extension that omits the field simply never injects.
- **The golden test is byte-identical** — `recalledTokens` is 0 with no recalls, and the raw path
  never issues one.
- **Preview / read-only obey every rule.** A recall is a producible steering state, so the "recalled
  to tail" indicator renders identically in demo/read-only (per CLAUDE.md's RULE).

## Rejected alternatives

- **Just use `restore`.** That is the in-place unfold that causes the cache miss — the whole reason
  this ADR exists.
- **Make omission drop the recall (pure full-state semantics).** Rejected: dropping a tail injection
  mutates the prefix and forces a cache miss on the next call, defeating the point. Stickiness is the
  deliberate, documented exception.
- **Freeze a copy of the block's text at record time.** Unnecessary — `Block.text` is immutable once
  committed, so reading it live at emission is both simpler and can never go stale.
- **Re-choose the anchor each pass to keep it "just before the tail."** Rejected: a moving anchor
  shifts the injection point and re-breaks the cache every pass. The anchor is frozen on purpose.
