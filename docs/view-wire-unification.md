# View ↔ Wire unification — make the UI structurally unable to lie

**Status:** near-term fix decided (Option A + alarm); stricter finish deferred (Option C).
**Date:** 2026-06-16
**Owner decision:** yes to Option A now, with the alarm as the standing guardrail; Option C
is a deferred finish, taken only if the alarm ever fires in real use or the render layer is
being reworked for another reason.

## The problem

Accordion is a **source of truth**: the screen must show exactly what the live agent
receives. Today it can lie, because "what is folded" is computed **twice**, in two places,
with two different rule sets that were never reconciled:

- **View side** — the store decides what the human sees: `isFolded` / `effTokens` /
  `digestOf` in [`app/src/lib/engine/store.svelte.ts`](../app/src/lib/engine/store.svelte.ts).
  `fold()` accepts **any** block (no kind/durability gate).
- **Wire side** — what the agent actually gets: `computeFoldOps` in
  [`app/src/lib/live/plan.ts`](../app/src/lib/live/plan.ts) and `applyPlan` in
  [`app/src/lib/live/mapping.ts`](../app/src/lib/live/mapping.ts) (the latter re-derives
  every safety rule independently, in the extension). These enforce a strict gate.

The view side is permissive; the wire side is strict; nobody forces them equal. The gap is
the lie. The concrete trigger that surfaced this: a human folds a `tool_call`. The tile
recesses and the saved-tokens counter drops — but `computeFoldOps` silently drops the fold
(`tool_call` is not in `FOLDABLE_KINDS`), so the agent receives the **full** block. Screen
says folded; agent got it whole.

### Confirmed divergence points (not just tool_call)

| Rule | Wire enforces | View enforces | Diverges? |
|---|---|---|---|
| Kind gate (`FOLDABLE_KINDS` = text/thinking/tool_result only) | yes | no | **yes** |
| Durable-id only (`isDurableId`) | yes | no | **yes** |
| Empty-digest skip | yes | no | yes (rare) |
| Recent-message backstop (`PROTECT_RECENT_MSGS` = 2, by message count) | extension, by msgs | engine, by tokens | yes (rare; unit mismatch) |
| Group straggler balance | `applyPlan` re-derives | `classifyGroup` | **yes — already documented** ([ADR 0006](adr/0006-multiblock-folds.md) watch items: cross-group split tool-pair makes `savedTokens` understate) |

All the same root cause: the UI trusts its own state instead of rendering what actually goes
out. This is governed by the CLAUDE.md rule "preview/read-only is NOT a more permissive
mode" — preview must match the *would-be* wire output too.

## Near-term fix — Option A: one shared predicate (DOING THIS)

Extract the wire's rules into single pure functions and route the store **through** them, so
the view can no longer form a folded-state the wire would refuse.

1. **One foldability predicate.** A single `wireFoldable(block)` (kind + durable-id +
   non-empty-digest) lives in the engine ([`digest.ts`](../app/src/lib/engine/digest.ts)
   already owns `FOLDABLE_KINDS`; `isDurableId` currently lives in `mapping.ts` and must be
   reachable from the engine). `store.fold()`, `store.isFolded`, and `computeFoldOps` all
   gate on this one function. `applyPlan` (extension) imports the same function — it keeps
   re-deriving as defense-in-depth, but from identical code, so it can only ever **agree**,
   never silently disagree.
2. **Group balance becomes one shared function.** The straggler/tool-pair-balance logic in
   `classifyGroup` (store) and `applyPlan` (mapping) collapses to one pure function consumed
   by both. Fixes the documented cross-group `savedTokens` divergence.
3. **Reconcile the backstop unit mismatch.** Guarantee the engine's token-based protected
   tail always covers at least the extension's `PROTECT_RECENT_MSGS` newest messages, so the
   two backstops can't disagree.
4. **Mode-aware, not mode-permissive.** Preview/read-only has no extension and no
   round-trip, so the projection simulates the wire rules locally. Preview === steering
   except that no plan is sent. (Per the CLAUDE.md rule.)

**Cost:** medium. **Risk:** low–medium — shared code means a bug hits both sides identically,
but they already diverge silently, which is worse. Keep the extension's final *structural*
guard (never emit an orphaned pair / emptied message) as a true last-resort assert; if it
ever fires it's a loud crash, not a silent lie.

**Result:** the tool_call lie and every row in the table above become impossible by
construction — the view cannot express a fold the wire won't reproduce.

## The alarm (standing guardrail on top of Option A)

Option A makes divergence *prevented by a shared predicate*. The alarm is the enforcement
that the prevention is actually holding — if the screen and the wire ever disagree about a
single block, it is surfaced, never swallowed.

**What it checks.** The full *resolved* per-block state, two ways — what the screen renders
vs. what the agent would actually receive: (1) folded or not, (2) effective content, (3)
effective token cost. It covers **groups and the protected tail**, not just per-block folds
(that's where a second silent divergence already lives). It runs in **both preview and
steering** — preview must match the would-be wire output.

**Three layers:**

1. **Test (always on).** A property-based test in the suite: generate many random
   fold/pin/group/protect-tail states across every kind and id type; assert the view
   projection and the wire projection are identical per block. Fails red on any mismatch.
   This is the primary guarantee.
2. **Dev runtime (loud, non-halting).** On real sessions during dogfooding, the check runs
   after each plan computation. On mismatch it logs a **loud console error** naming the
   diverging block (id, kind, what the screen says vs. what the wire does) — but **keeps
   running**. (Owner decision: loud error, keep running — not a hard throw.)
3. **Production (UI alarm only).** If it ever happens to a real user, the app **only alerts**
   — it takes no corrective action. No self-heal, no auto-correct, no halt. It is an alarm,
   nothing else. (Owner decision.)

**What it looks like (production + dev).** A **slow-flashing red indicator** in the UI,
placed either next to the **"Accordion"** wordmark or **above the context bar** (the
composition strip in [`MapHeader.svelte`](../app/src/lib/ui/map/MapHeader.svelte)). Slow
flash = "something that must never happen is happening," without hijacking the whole screen.
It stays until the divergence clears.

## Deferred finish — Option C: single source / projection (NOT NOW)

The stricter design that makes divergence not just *prevented* but *unrepresentable*.

**Shape.** One function `project(rawBlocks, overrides, conductorState, ctx) →
ProjectedBlock[]`, where each `ProjectedBlock` carries its final, fully-resolved
`{ content, tokens, folded, foldedReason }` with every wire rule already applied. The store
stops *computing* folded-ness; it holds only the **inputs** (human overrides, conductor
state, budget, protect-tail) and exposes the projection's output. `isFolded(b)` becomes a
lookup into the projection. `computeFoldOps` reads the projection. The UI renders the
projection. There is exactly **one** place in the app where folded-ness exists.

**Why it's stronger than A.** Option A makes two representations *agree* (via a shared
predicate, relying on every future code path going through it — the alarm polices this).
Option C **deletes the second representation**, so there is nowhere for a disagreement to
live. Divergence is unrepresentable, not merely prevented.

**Why deferred.** Wide blast radius: every reader of `isFolded` / `effTokens` / `digestOf`
across `ContextMap`, `MapHeader`, `Inspector`, and the transcript view must be rewired to
read projection fields; the store's reactive surface changes shape; tests churn. Doing it
cold means refactoring the safety predicate and the entire render layer at the same time —
the riskiest way to land it.

**A is the first half of C.** Option A already isolates the shared predicate. Once that's in,
C becomes a mechanical render-layer migration on top of an already-unified rulebook — calm,
not a leap.

**Trigger to actually do C:** either the alarm **fires in real use** (proving the shared
predicate alone wasn't enough), or the render layer is being reworked for another reason and
C can be folded in cheaply. Until then, A + the alarm is durable in practice.

## Sequence

1. Option A: shared `wireFoldable` predicate → route `store.fold`/`isFolded`/`computeFoldOps`
   through it; collapse group-balance to one function; reconcile the backstop unit.
2. The alarm: property test (always) + dev loud-error check + production slow-flashing red
   indicator near the "Accordion" wordmark / above the context bar.
3. Option C: deferred — only on the trigger above.
