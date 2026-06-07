# ADR 0006 — Multiblock folds (groups): collapse a range of blocks into one entry

**Status:** accepted (Milestone 4, first cut)
**Date:** 2026-06-07
**Builds on:** [ADR 0005](0005-agent-unfold.md) (fold tags / `foldCode` / the `unfold`
tool — groups reuse all three), [ADR 0004](0004-engine-on-fold-toggle.md) (opt-in armed
folding — group collapse rides the SAME `folding.enabled` gate), [ADR 0003](0003-responsive-block-streaming.md)
(durable ids — a group may only collapse durably-identified messages).

## Context

Per-block folding (ADR 0001–0005) recesses a block in place but keeps every tile on
screen: a 982-block session is still 982 things to scan, and the live context still holds
N message-parts. There is no way to say "this whole stretch of work is one thing now."

Multiblock folds add the first construct that *reduces cardinality*: a **group** — a
human-selected, contiguous run of blocks that collapses into a **single entry**. In the
grid it is one tile (a folder) standing in for the range; in the live context the range's
messages are replaced by one summary message. It is fully reversible (the GUI keeps the
originals) and the agent can pull the whole group back with one code.

This was designed in a long interview with the owner; the decisions below are the
resolved branches of that tree.

## Decision

### 1. A group is an ENGINE OVERLAY, not a `Block`

`Block` is the wire atom — `parse.ts` and `live/mapping.ts` produce blocks 1:1 from real
messages. A group has no underlying message, so it is **not** a block. The store holds a
separate `groups: Group[]` overlay plus a private `blockId → Group` index; `order`,
`index`, `protectedFromIndex`, and the live-append dedup stay purely block-based and
untouched.

```ts
interface Group { id: string; memberIds: string[]; folded: boolean }
```

The "new kind of block" the owner pictured is purely the **UI tile**. Invariants enforced
at creation: members are **contiguous** in block order, **non-overlapping** (a block is in
≤1 group), **flat** (no nesting — a member is always a block, never a group), at least two
members, **entirely older than the protected tail** (`protectedFromIndex`), and **collapse
at least one member** — a group whose every member is a split tool-pair half (nothing folds
into the summary) is refused, since a folded group must *replace* its blocks with the parent
summary, not hide live blocks behind a zero-saving tile. The group
id is `g:<firstMemberDurableId>`; its unfold handle is `foldCode(group.id)` (ADR 0005).

**Rejected: a synthetic group-`Block` in the array.** It would pollute every block-indexed
computation (order/index/protect/dedup) and the 1:1 message mapping for zero gain — the
tile is a render concern, the collapse is a wire concern; neither needs a fake block.

### 2. Two orthogonal states: group-fold (collapse) vs member-fold (per-block)

Folding the group ≠ mutating member overrides. A group carries its own `folded` flag:

- **Folded:** the members are not rendered individually; the grid shows one parent tile,
  and the wire collapses the range (§4). Members keep whatever override they had.
- **Unfolded:** members render inline inside a tinted band (the parent tile dulls and sits
  at the band's far left), each with its **own** per-block fold state — "some folded, some
  not," exactly as before grouping. On the wire an unfolded group is invisible: its members
  go through normal `computeFoldOps`.

So group state drives collapse; member overrides are preserved and only matter when the
group is open. Creating a group folds it by default. "Editing" a group's membership is, on
the backend, **delete + recreate** — there is one create path and one delete path, no
incremental-membership machinery and no persistent group identity to maintain.

### 3. The grid renders a display-list; the parent tile is the sole control surface

`ContextMap` no longer maps `blocks` 1:1. It walks blocks in order and, at the first member
of a group, emits ONE parent item for a folded group (skipping the rest of the range), or a
band-open + the member tiles for an unfolded group. The parent tile is a permanent grid
citizen at the range's start and is where fold / unfold / delete happen. Its dice-face reads
the group's live token cost (§5). This is the one place the "always 982 tiles" property is
deliberately broken: a folded group is *fewer* tiles, which is the entire point. All the
perf rules (cached pip sprites, overlay-not-reflow, no per-tile gradients/filters
mid-interaction) carry over to the parent tile and the select-to-preview fan-out.

### 4. Wire: collapse the range into ONE synthetic summary message (true removal)

When a group is folded **and folding is armed**, the GUI sends a `GroupOp` and the extension
**removes the grouped messages and inserts one synthetic summary message** in their place.
This is a genuinely new wire operation — every prior op was length-preserving in-place
substitution (`FoldOp`). It is contained and safe because **`applyPlan`'s output only ever
feeds the model; the GUI is always streamed the real, un-collapsed blocks and the
`sentCount` cursor runs off those** — so a range-collapse can never corrupt the sync/dedup
state, and it is recomputed fresh every `context` hook (stateless on the wire).

```ts
interface GroupOp { id: string; memberIds: string[]; summaryText: string }
```

`PlanMessage` gains `groups?: GroupOp[]` (additive). `PROTOCOL_VERSION` → 4.

**What may be removed — message granularity, balanced pairs, three independent guards:**

1. **Whole messages only.** A message is removable iff *every* block it emits is durable
   AND a member of the group. A message only partially covered by the group (the selection
   cut mid-message) stays live. Membership is per-block; removal is per-message.
2. **Tool-pairs stay balanced.** A `tool_call` and its `tool_result` are removed only if
   BOTH fall in the removal set. If a pair straddles the group edge, the straggler half is
   demoted to stay-live (the owner's "leave straggler live" choice). `applyPlan`
   **re-derives** this independently of the GUI (defense in depth, ADR 0004 style): it
   never emits an array with an orphaned tool call/result.
3. **Recent backstop.** The newest `PROTECT_RECENT_MSGS` messages are never removed (this
   is on top of the engine's token-based protected tail, which already bars protected
   blocks from groups at all).

Each maximal run of removable messages collapses to one message: **role = the role of the
first message in the run**, content = a single text part = `summaryText` (which carries the
group's `{#<code> FOLDED}` tag and a deterministic recap; the recap always names that user
instructions are inside, since a group may legally summarize a `user` turn). A group split
by an interior straggler yields one synthetic entry per run, all sharing the same code.

**Any uncertainty → passthrough.** A group op that fails any guard is skipped entirely
(its messages pass through untouched); `applyPlan` never produces a structurally invalid
array. Combined with the opt-in arm (off by default), the prime directive — never corrupt
context — holds even if a guard is wrong.

**Deterministic summary now, LLM later.** `summaryText` is built by a deterministic
`groupDigest()` (counts, turn range, tool names, the user ask, first-lines) — instant,
free, reproducible, no model infra and no "thin extension" violation. Swapping in an
LLM-written précis later changes only the text, not the mechanics.

**Rejected: in-place "summary + breadcrumbs"** (keep all messages; one carrier holds the
summary, the rest fold to tiny stubs). Provably safe (reuses the battle-tested substitution
path) and was the conservative candidate — but it cannot compress a `user` or `tool_call`
member (those are never folded in place), so it cannot honor "summarize the whole turn,
user included," and it leaves N stubs rather than one entry. True removal is what the owner
chose; the in-place path is the documented fallback if live-provider testing rejects the
restructured array.

### 5. Token accounting follows the wire

A folded group contributes, once, `groupDigestTokens(g)` (the one summary entry) plus the
full tokens of any member kept live (a wire straggler). `liveTokens` / `savedTokens` /
`foldedCount` become group-aware: the per-block sum skips a folded group's collapsed members
and adds the group's live cost at the range's start. The auto-folder (`refold`) excludes
folded-group members from its candidate set (they are already collapsed) and seeds its
running total from the group-aware `liveTokens`; manual fold/pin/protect are otherwise
unchanged.

### 6. Agent self-unfold: one code restores the whole group

The summary entry carries one `{#<code> FOLDED}` tag where `code = foldCode(group.id)`.
`resolveUnfold` (the existing `unfoldRequest` path) resolves a group code by setting
`group.folded = false` — the whole range returns on the agent's next `context` hook (the
group drops out of `computeGroupOps`), exactly like a per-block agent unfold. Provenance is
`"agent"`; the human sees it in the activity log and can re-collapse. The agent can request,
never force; it can only unfold a group that is actually folded.

## Safety invariants

1. All ADR 0004/0005 invariants hold: no GUI / disarmed / no reply / empty plan ⇒ messages
   pass through unmodified. Group collapse rides `folding.enabled` (off by default, reset on
   every attach).
2. `applyPlan` never emits an array with an orphaned tool call/result, an emptied message,
   or a removed protected/recent message — each guarded independently of the GUI. On any
   doubt it passes the affected messages through.
3. A group only ever collapses durably-identified, non-protected, contiguous messages.
   Non-durable ids are never removed (their position is unstable across array shifts).
4. The collapse is content removal *to the model only*; the GUI keeps every original block,
   so it is fully reversible (unfold the group → originals reflow next turn).
5. The cursor/dedup machinery is untouched: `applyPlan` output is never re-linearized or
   re-synced, so removing messages from the model array cannot desync the GUI.

## Watch items

- **#1 — live-provider acceptance (UNVERIFIED HERE).** The restructured array (messages
  removed, one synthetic summary inserted, role = first-removed role mapped to user/assistant)
  is proven balanced and non-empty by unit tests, but was NOT validated against a real model
  call in this environment. Verify a live armed group-collapse round-trips 200 before relying
  on it. **Synthetic-message role rhythm is the most likely rough edge:** a removed `user`
  turn can create assistant/assistant adjacency, and a run whose first removed message is a
  `tool_result` (or a straggler-split sub-run) becomes a `user`-role summary — which can
  create user/user adjacency. pi normalization is expected to coalesce consecutive same-role
  messages, but confirm; if not, the candidate fix is to map `tool_result`/summary-first runs
  to `assistant`, or fall back to the in-place mechanism (§4).
- **Cross-group split tool-pair (accounting only, not safety).** If two SEPARATE adjacent
  groups split one tool pair (call in group A, result in group B), the wire correctly removes
  BOTH halves (balanced), but the GUI's `classifyGroup` pairs only within a single group, so
  it marks each half a "straggler" — `savedTokens` understates and the tooltip's "N kept live"
  over-reports. The model array stays valid; only the GUI's numbers drift. Fix later by either
  refusing a range that splits a pair already half-grouped, or making classification
  cross-group-aware. (Single-group split pairs — the common case — are exact.)
- **Wire recap describes the GUI's collapsed set.** `summaryText` is built from the engine's
  `classifyGroup`; when the extension's independent re-derivation removes a slightly different
  set (the cross-group case above, or a durability mismatch), the recap text counts/names
  blocks that differ from what was physically removed. The `{#code FOLDED}` tag/code is still
  correct for unfolding; only the prose is approximate.
- **Protect-tail grows into a group.** Widening `protectTokens` so the tail overlaps an
  existing group must spring the overlap live; groups dissolve/clamp rather than collapsing
  protected content (handled like the existing fold self-heal in `refold`).
- **Straggler honesty.** The grid parent tile covers the whole range; a wire straggler kept
  live is surfaced in the tile's tooltip, not as a separate poking tile (v1 simplification).

## Scope / limitations (this change)

- **Manual creation only.** The human selects a contiguous range (click first tile,
  shift-click last). Auto-grouping (collapse-this-turn / cluster tool spam) is the
  Conductor's later job.
- **Flat, contiguous, non-overlapping.** No nested groups (folders-in-folders) this cut.
- **Deterministic summary.** No LLM précis yet (text-only swap later).
- **Whole-message wire collapse.** A group whose selection cuts mid-message keeps the
  partial end message(s) live; only fully-covered, pair-balanced messages are removed.

## Verification

Unit (`vitest`): `applyPlan` group-collapse — removes a fully-covered balanced run into one
summary message, keeps a straddling tool-pair straggler live, never removes a protected/
recent message, passes through on any guard failure, stays pure; `computeGroupOps` /
`resolveUnfold` group-code path; store group actions + group-aware `liveTokens`/`savedTokens`
and the protect-tail/group interactions; `groupDigest` shape/determinism. Extension
`smoke.mjs`: an armed group-collapse round-trip and a group-code unfold. Full gate:
`svelte-check` 0/0/0, `vitest` green, extension smoke.
