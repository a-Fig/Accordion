# ADR 0012 — Garbage-collector conductor: reachability-based folding (context as a managed heap)

**Status:** accepted
**Date:** 2026-06-18
**Builds on:** [ADR 0007](0007-conductor-protocol.md) (the conductor seam —
`conduct → Command[]`), [ADR 0008](0008-conductor-first-party-one-view.md) (first-party
conductors, one public `ConductorView`), [ADR 0009](0009-cold-score-conductor.md)
(the cold-score conductor — the in-process relevance-aware peer).
**Reference:** [conductor-imaginarium.md](../conductor-imaginarium.md), architecture #3
("The Garbage Collector — context as a managed heap").

## Context

Every shipped conductor decides which blocks to fold by a *score* — the built-in by
kind-value and age (ADR 0007), cold-score by an ACT-R activation power-law (ADR 0009),
cold-epoch by the same ranking held byte-stable inside a hysteresis band. All of them
answer "how likely is this block to be needed?" with a number, and fold the
lowest-numbered candidates until the live context fits the budget. "Folded because
score 0.23 < 0.30" is, ultimately, a shrug: it is a heuristic with no guarantee behind
it, and no auditable reason a given block survived.

The conductor-imaginarium catalog proposes a different foundation: steal the most
battle-tested resource-reclamation theory in computer science — **garbage collection**.
In a GC'd runtime you never delete what's *reachable*: start from **roots**, walk
references, reclaim the rest. Mapped to context:

- **roots** = the protected working tail + human-held blocks + the original task
  statement (the first `user` block) — the things the agent is guaranteed to still need;
- **references** = entity links (a block mentions a file/symbol another block mentions),
  causal links (a `tool_call`/`tool_result` pair sharing a `callId`), and message links
  (an assistant message's parts sharing an id prefix);
- **mark** = every block reachable from the roots through those references;
- **sweep** = fold the UNREACHABLE candidates first.

What GC contributes that scoring doesn't: **semantics instead of thresholds**. "Folded
because unreachable from anything live" is a *guarantee-shaped* statement — auditable,
testable, explainable ("nothing in the current tail or the original task references
it"). The two compose (imaginarium §3): reachability decides *eligibility and order*,
the budget decides *how far to go*.

## Decision

### 1. A third collaborative in-process conductor, additive

`GarbageCollectorConductor` (`id: "garbage-collector"`) is registered alongside the
built-in, cold-score, cold-epoch, sliding-window, and autopilot conductors in
`IN_PROCESS_CONDUCTORS` (`conductors/index.ts`). It is **collaborative** — it declares no
involvement locks (ADR 0011): reachability is a relevance signal, not a claim of
authority, and human overrides win exactly as they do for the built-in and cold-score.
No consent gate is shown. It is **not** merged into the built-in: the built-in's output
is golden-pinned and its simplicity is preserved as the minimal reference (ADR 0008). The
GC conductor is additive — a third worked example showing what a structurally different
strategy looks like against the same public `ConductorView`.

### 2. Pure function of the view, no instance state

`conduct(view)` is synchronous and side-effect-free with respect to the view, as the
contract requires. Unlike cold-score, the GC conductor carries **no instance memory** —
reachability is recomputed from the view each pass (the reference graph is a pure
function of the blocks). This makes it fully deterministic and trivially testable: the
same view always yields the same fold set, with no hysteresis to reason about. A
future generational refinement (see Consequences) may introduce cross-pass state, but
the first slice does not.

### 3. The reference graph (`conductors/garbage-collector/edges.ts`)

Three kinds of bidirectional edges, all derived from the pure `ConductorView`:

- **Causal** — `tool_call` ↔ `tool_result` sharing a `callId`. The host already refuses
  to fold a `tool_call` (folding it would orphan its result), so this edge's job is to
  keep a result reachable while its call is live, and to let a call in the tail pull its
  foldable result partner back into reachability.
- **Message** — assistant parts sharing an id prefix before `:` (`m<i>`). An assistant
  message's thinking / text / tool_call are one reasoning unit; if any part is live, the
  rest stay reachable. (This mirrors the parse-level id encoding in `live/mapping.ts` /
  `engine/parse.ts`.)
- **Entity** — blocks whose text shares a distinctive identifier (file path, symbol,
  quoted string). This is the relevance signal: an old `tool_result` that read `parse.ts`
  and a protected-tail block that mentions `parse.ts` are linked, so the old lookup stays
  warm while the agent still works on that file.

Identifier extraction is **single-sourced**: the GC conductor reuses cold-score's
`extractIdentifiers` (`conductors/cold-score/lexical.ts`) so the two relevance-aware
conductors agree on what counts as a "symbol." The entity edge is **rarity-guarded**
(mirrors cold-score's `matchBlocks`): an identifier appearing in more than
`max(3, 25% of blocks)` is too common to be a signal and creates no edges. Members of a
kept identifier group are linked as a **chain**, not a clique — reachability through a
chain is equivalent to through a clique for the mark phase, and chaining keeps the edge
count linear per identifier (a clique would be O(k²) per group).

### 4. Roots: protected tail + held + the FIRST user message

Roots are the seeds of reachability:

- every **protected** block (the working tail) — the agent's live context;
- every **held** block (a human pin / manual fold / manual unfold owns it) — a human
  anchor keeps its neighbours reachable;
- the **first `user` block** — the original task statement.

Only the *first* user message is a root, not every user message. Mid-session user turns
that have aged out of the tail are durable (never folded — `user` is not a foldable kind)
but no longer anchor reachability. This is deliberate: if every user message were a root,
an old user mention of a file would keep that file's old blocks reachable forever, and
work the agent has moved on from could never go unreachable — defeating the conductor's
purpose. The founding intent stays a root forever; later intents only anchor while they
sit in the protected tail.

### 5. Sweep: unreachable-first, reachable fallback, budget guarantee

The fold pipeline:

1. **Under budget → `[]`** (raw), matching the convention of every shipped in-process
   conductor. The GC's distinguishing behaviour shows under budget pressure, not when the
   context already fits.
2. **Mark** every block reachable from the roots (iterative DFS in `markReachable` — no
   recursion, so a long chain can't overflow the stack on a big session).
3. **Candidates** are the same set every conductor honours: foldable kind
   (`text` / `thinking` / `tool_result`), not human-held, not protected, not inside a
   folded group, and would actually shrink (`foldedTokens < tokens`).
4. **Order** candidates by `(reachable? → kind-rank → conversation order)`: unreachable
   first (the GC-eligible set), then — within each tier — the built-in's kind-value
   ordering (`tool_result` → `thinking` → `text`) and oldest-first. The reachable tier
   therefore behaves like the built-in when the reachability signal is exhausted.
5. **Greedily fold** until live ≤ budget. If the unreachable blocks don't suffice,
   reachable ones follow — the **budget guarantee is the hard invariant** every conductor
   honours, and reachability is the ordering, not a veto on it. This mirrors cold-score's
   relaxed pass overriding hysteresis under budget pressure.

The conductor emits only `fold` commands (no `group` / `replace` / `pin`), like the
built-in and cold-score. It never returns `null` — it is synchronous and always has a
definite answer.

### 6. The `text` field is required for entity edges

`ViewBlock.text` is present in in-process views (the app builds the full
`ConductorView`) but may be absent for wire-shape views. A block without `text` simply
contributes no entity edges — it still participates in causal and message edges, and
folds or stays live on reachability through those plus the budget fallback. No error.

## Consequences

- **A new, structurally different strategy is selectable in the header switcher.** It
  composes with the existing conductors — selection is global and persisted
  (`conductorState.activeId`); swapping is a one-line `store.attach`. The built-in golden
  test is untouched.
- **Reachability is explainable.** A future "why is this block still live?" debug affordance
  (imaginarium §3: "show the reference chain from the roots, like a heap profiler's
  retention path") has a natural home here — the graph is already built. That UI is out of
  scope for this ADR.
- **The identifier extractor is shared with cold-score.** This is the first cross-conductor
  code reuse. If a third conductor wants the same notion of "symbol," the natural next step
  (called out in the backlog's "single source" theme) is to hoist `extractIdentifiers` (and
  the foldable-kind set) into `conductors/contract` or a `conductors/shared/` module. The
  dependency is intentionally narrow (one pure function) so the hoist is mechanical.

## Rejected alternatives

- **Merging into the built-in.** Rejected: the built-in is golden-pinned and deliberately
  minimal. The GC conductor is additive.
- **Folding unreachable blocks even when under budget.** Rejected: every shipped
  in-process conductor returns `[]` under budget, and breaking that convention would make
  the GC conductor surprisingly aggressive (folding provably-dead blocks the user never
  asked to shrink). The reachability semantics show under pressure, where they matter.
- **Making reachability a veto (never fold a reachable block).** Rejected: it would break
  the budget guarantee whenever the unreachable set can't meet budget (a large protected
  tail, or a session where everything links to the tail). The budget guarantee is sacred;
  reachability is the ordering.
- **All user messages as roots.** Rejected as described in §4 — it would prevent
  moved-on-from work from ever going unreachable.
- **Clique entity edges.** Rejected for performance: a clique is O(k²) per identifier
  group and a chain preserves mark-phase reachability exactly.

## Future work (generational GC)

The imaginarium's generational refinement — a **nursery** (the tail), an **old
generation** (folded summaries), a **tenured** store (long survivors), exploiting the
generational hypothesis that most tool results die young while survivors live long — is
deliberately out of scope for this cut. It would introduce cross-pass state (generation
assignment, survival counts) and a promotion policy, which deserve their own ADR. This
first slice is plain mark-and-sweep: the worked, testable foundation that proves a
reachability-based conductor fits the contract and the budget guarantee, on which
generations can later build.
