# ADR 0009 — Cold-score conductor: relevance-aware folding as a pluggable strategy

**Status:** accepted
**Date:** 2026-06-13
**Builds on:** [ADR 0007](0007-conductor-protocol.md) (the conductor seam —
`conduct → Command[]`), [ADR 0008](0008-conductor-first-party-one-view.md) (first-party
conductors, one public `ConductorView`).
**Context of re-implementation:** PR #19 ("The Conductor: C1–C3") and PR #20 ("[C4] Nested
groups") were built before the merged conductor-protocol refactor. They baked conductor
logic inside the store (`_refoldImpl`). The merged main made the conductor a pluggable
`conduct(view) → Command[]` strategy, so #19/#20 are being re-implemented onto the new
contract rather than rebased. This ADR covers the **C1 deterministic slice** — PR #19's
ACT-R cold-score layer ported as `ColdScoreConductor` (`conductors/cold-score/`). C2
(LLM summaries), C3 (attentive tick), and C4 (nested groups) are deferred; see
[`docs/conductor-rework-roadmap.md`](../conductor-rework-roadmap.md).

## Context

The built-in conductor (`conductors/builtin/builtin.ts`, ADR 0007/0008) folds blocks
purely to fit the live context under budget: oldest-first, lowest-kind-value-first
(`tool_result → thinking → text`). It makes no relevance judgement. A block that was
looked up and discussed ten turns ago ranks the same as one that has never been touched,
as long as they are the same kind and approximate age. Under that strategy:

- A `tool_result` whose output the agent is actively referencing in the protected tail
  gets folded as eagerly as one from a completely unrelated call;
- A block that was explicitly examined by the agent and then re-folded by the built-in
  gets folded again immediately on the next turn — no memory that the agent valued it;
- Long cold runs of already-folded blocks are left as a sequence of individual stubs,
  each emitting a separate digest line, rather than collapsed into a single summary entry.

PR #19 addressed all three gaps: an **ACT-R activation power-law** to rank fold candidates
by estimated relevance, a **lexical pre-unfold** to keep live any block whose identifiers
appear in the protected tail, **fold/unfold hysteresis** (per-block cooldowns) to prevent
thrashing, and **auto-coalesce** to group long-cold folded runs into a single summary. That
code was tightly coupled to the store and cannot be rebased; the decisions implemented here
as a `Conductor` are the first three — ACT-R scoring, lexical pre-unfold, and hysteresis.
Auto-coalesce is deferred (see Consequences below).

## Decision

### 1. A second in-process conductor, not a modification of the built-in

The `ColdScoreConductor` (`id: "cold-score"`) is registered alongside the built-in in
`IN_PROCESS_CONDUCTORS` (`conductors/index.ts`). It is **not** merged into the built-in,
because the built-in's output is pinned byte-identical by a golden test
(`conductor.builtin.test.ts`) and the built-in's simplicity is deliberately preserved as the
minimal worked example (ADR 0008). The cold-score conductor is a **second worked example**
— a relevance-aware strategy that shows what instance state and multi-pass logic look like
in practice.

### 2. Pure function of the view plus instance memory

`conduct(view)` is synchronous and side-effect-free with respect to the view, as the
contract requires. The only source of non-determinism is **instance-level hysteresis state**:

- `recalls: Map<id, turn[]>` — the turns at which each block was lexically pre-unfolded
  (the "recall" events that warm it in the ACT-R model).
- `coolUntil: Map<id, turn>` — the turn until which a block may not be auto-refolded
  after a lexical unfold (per-block cooldown).

The host constructs the conductor once via `create()` in `IN_PROCESS_CONDUCTORS`, so this
state accumulates across `conduct()` calls for the lifetime of a session. No store handle,
no engine imports, no Svelte runes — types only from `../contract`.

### 3. The `conduct()` pipeline

The pipeline mirrors PR #19's `_refoldImpl` in stage order, re-expressed as a pure view
traversal.

**Step 0 — under budget: raw.**
If `liveTokens <= budget`, return `[]` immediately. Matches the built-in; nothing to do.

**Step 1 — candidate filter.**
Blocks eligible for folding: not human-held (`held`), not protected (`protected`), not
already grouped (`grouped`), would actually shrink if folded (`foldedTokens < tokens`), and
a foldable kind (`text | thinking | tool_result` — `tool_call` and `user` are excluded
explicitly; the cold-score priors already deprioritize them, but the explicit kind filter
makes the invariant structural).

**Step 2a — preliminary cold-score clamp.**
Candidates are sorted ascending by `coldScore(b, ctx)` (coldest = fold first) and greedily
folded into a running projection until `liveTokens <= budget`. This produces the initial
fold set the lexical pass will inspect.

The **cold score** is `prior[kind] + activation(b) + pairWarmthBonus?`:

- `prior[kind]` — `{ tool_result: 0, thinking: 8, text: 16, tool_call: 24, user: 32 }`.
  Gaps of 8 units exceed any realistic activation spread for sessions up to ~1000 turns,
  so with no recalls the ordering exactly reproduces the built-in's `FOLD_RANK` (kind-major,
  oldest-first within a kind).
- `activation(b)` — Anderson & Schooler (1991) power-law of forgetting:
  `B = ln(Σ max(T − tᵢ, floor)^(−d))` over creation turn + recall turns. A block with
  recent recalls has higher activation → higher cold score → warmer → folds last. Decay
  exponents are kind-specific: `tool_result 0.9 > thinking 0.7 > text 0.5` (tool results
  decay fastest; text conclusions decay slowest).
- `pairWarmthBonus` (4) — added when the block's `callId` is present in the protected tail
  (the agent is actively using results from that call).

**Step 2b — lexical pre-unfold.**
The protected tail text (newest-walking, capped at ~32 k chars) is scanned for identifiers
— file paths, camelCase/snake_case/PascalCase symbols, quoted strings of 3–80 chars. A
rarity guard rejects any identifier that matches more than `max(3, 25%)` of candidates
(a common token carries no signal). Among just-folded blocks, any block whose `.text`
contains a matching identifier is un-folded (kept live), subject to:

- The cap of `maxLexicalUnfoldsPerPass = 4` per pass (prevents a noisy tail from
  unfurling the entire history).
- Longest-identifier-first ordering (most specific signal restores first).
- A skip if the block is already on cooldown — re-recording a recall for an identifier
  that has persisted across turns would artificially inflate warmth.

A pre-unfolded block is recorded as a recall at the current turn (warming it in the ACT-R
model) and put on cooldown (`coolUntil[id] = T + unfoldCooldownTurns`, default 5 turns) — but
**only if it actually stays live through the rest of the pass.** A block the relaxed pass
(Step 4) has to re-fold under budget pressure is recorded as neither: warming or cooling a
block that ends up folded would falsely protect it on the next pass, so the bookkeeping is
deferred until the final fold set is known. Within the pass, a freshly pre-unfolded block is
shielded from the Step 3 re-clamp regardless.

**Step 3 — re-clamp respecting cooldowns.**
If the pre-unfolds pushed tokens back over budget, fold additional candidates (cold-score
order) excluding any block that is on cooldown (`coolUntil > T`) or was just pre-unfolded
this pass.

**Step 4 — relaxed pass.**
If still over budget, fold remaining candidates including cooled-down ones. **Budget is the
hard guarantee whenever the available fold candidates can achieve it; hysteresis is
best-effort.** Like the built-in, the conductor cannot fold below the protected tail plus the
non-foldable kinds, so an extreme budget can still leave live > budget — the relaxed pass
simply folds everything it is allowed to.

**Return:** `[foldCommand?]` — never `null` (synchronous, always definite). The conductor
emits only `fold` commands; no `group` commands are produced.

### 4. Files

```
conductors/cold-score/
  cold-score.ts   — ColdScoreConductor (pipeline + hysteresis state)
  score.ts        — coldScore(), activation(), sortCandidates() (ACT-R math)
  lexical.ts      — extractIdentifiers(), matchBlocks() (lexical pre-unfold)
```

All files: no Svelte, no `$state`, no engine imports, Node-safe — types only from
`../contract`.

## Consequences

**What this adds.** A relevance-aware conductor that — with no LLM cost — uses retrieval
history, lexical signals, and hysteresis to approximate "which old blocks is the agent still
using?" `tool_result` blocks whose outputs appear in recent tool calls or are referenced by
symbol name in the tail are protected from folding. The golden test on the built-in is
untouched.

**Auto-coalesce intentionally deferred.** Grouping long cold runs (collapsing N fold-stubs
into a single `group` command) was part of PR #19 but is not in this cut. The reason is
contractual: a `group` command's `ids` are snapped **outward** to whole messages by the host
(`snappedRange` in `store.svelte.ts`), and `classifyGroup` leaves any tool-pair-unbalanced
or partial-message blocks as full-cost "stragglers." A conductor emitting groups must
therefore (a) align runs to whole-message boundaries and keep tool-pairs intact, and (b)
re-project `liveTokens` using the host's real group-cost model — one carrier digest plus
full-cost stragglers — and add a top-up fold pass when grouping re-inflates the budget. Or
the host must expose a message-id per `ViewBlock` so the conductor can reason about message
boundaries directly. That is a deliberate design task; auto-coalesce is tracked in the
roadmap ([`docs/conductor-rework-roadmap.md`](../conductor-rework-roadmap.md)).

**Fidelity notes (one genuine deviation from PR #19).** The conductor learns warmth (recalls)
only from its **own** lexical pre-unfolds. The `ViewBlock` surface exposes no recall
provenance — agent-unfolded blocks (`held: true`) are honored (the conductor never folds
them) but they do not feed `this.recalls`. In PR #19 the store's recall log was shared
across all unfold sources; that coupling is gone. In practice the delta is small: the agent's
explicit unfolds set `held`, which already protects the block permanently, so the missing
warmth credit only matters if the agent un-holds and the conductor needs to independently
decide to keep the block warm — a rare second-order effect. Accepted trade-off; fixing it
would require a recall-history field in `ViewBlock` (a future `ConductorView` extension).

**Budget is the floor the pipeline drives toward.** The relaxed pass (Step 4) folds every
candidate it is allowed to — including cooled-down ones — so the conductor reaches budget
whenever the foldable candidates can achieve it. This is the built-in's exact limitation, not
a new one: a large protected tail or many non-foldable `tool_call`/`user` blocks can still
leave live > budget, since those are never folded. The host's provider-validity clamp and
human-override rules remain a backstop (ADR 0007/0008) but should never fire for a
well-behaved budget fold.

**The `text` field is required for lexical matching.** `ViewBlock.text` is present in
in-process views (the app builds the full `ConductorView` for in-process conductors) but
may be absent for wire-shape views (`wants: "shape"`). A candidate without `text` simply
never matches in the lexical step — it folds or stays folded purely on cold-score. No error.

## Rejected alternatives

- **Merging into the built-in.** Rejected: the built-in's output is golden-pinned and its
  simplicity is preserved as the minimal reference. The cold-score conductor is additive, not
  a replacement.
- **Storing recall history in `ViewBlock`.** Rejected for now: requires a `ConductorView`
  extension and a host-side decision about what counts as a recall event. The current
  instance-state approach is sufficient for the one-source-of-truth case (lexical pre-unfolds
  this conductor performed). Deferred to a future `ConductorView` field if cross-source
  warmth becomes important.
