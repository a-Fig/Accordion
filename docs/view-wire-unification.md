# View ↔ Wire unification — make the UI structurally unable to lie

**Status:** **Slice 1 LANDED** (the shared kind predicate that kills the `tool_call` lie via
both fold doors, plus the alarm). Slice 2 (group-balance unification, protect-tail unit
reconciliation, id-format reconciliation) is a defined fast-follow, not yet built. Stricter
finish (Option C) remains deferred.
**Date:** 2026-06-16
**Owner decision:** yes to Option A now, with the alarm as the standing guardrail; Option C
is a deferred finish, taken only if the alarm ever fires in real use or the render layer is
being reworked for another reason.

## What Slice 1 actually shipped

One shared **kind** predicate `wireFoldable(b)` in `engine/digest.ts` (KIND-only — durable-id
stays a live-wire emit concern in `computeFoldOps`, because on-disk/demo parse ids legitimately
differ and the view must fold by kind in every mode). Both fold doors route through it:
`store.fold()` refuses a non-foldable kind; `store.substOne()` (the conductor chokepoint for
`fold` **and** `replace`) clamps with a new `"not-foldable"` `ClampReason` instead of silently
applying. `store.canFold()` drives the UI affordance (`ContextMap` no longer offers Fold on a
live `user`/`tool_call`). The **alarm** (`live/foldAlarm.svelte.ts`) re-checks view-vs-wire on
every settled change: a universal kind backstop (all modes, excludes collapsed group members),
a live-only set-equality check (`isFolded` set == `computeFoldOps` set — catches the rare
positional-id divergence), an indicator-only slow-flashing red dot by the wordmark, and a
dev-only `console.error`. The alarm deliberately does **not** verify folded-group straggler
balance — that's the extension's structural guard + Slice 2. Golden (`conductor.builtin`) stayed
byte-identical; the gate is a no-op on foldable-kind candidates.

The sections below are the original design; they remain the reference for the Slice 2 items.

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

| Rule | Wire enforces | View enforces | Diverged? | Slice 1 |
|---|---|---|---|---|
| Kind gate (`FOLDABLE_KINDS` = text/thinking/tool_result only) | yes | no | **yes** | **CLOSED** — both fold doors gate on `wireFoldable`; alarm Layer 1 backstops |
| Durable-id only (`isDurableId`) | yes | no | **yes** | **alarmed** (live Layer 2 fires on the rare non-durable-live fold); view-side gating deferred to Slice 2 (id-format reconcile) |
| Empty-digest skip | yes | no | yes (rare) | unchanged (wire-side in `computeFoldOps`) |
| Recent-message backstop (`PROTECT_RECENT_MSGS` = 2, by message count) | extension, by msgs | engine, by tokens | yes (rare; unit mismatch) | **deferred** to Slice 2 |
| Group straggler balance | `applyPlan` re-derives | `classifyGroup` | **yes — already documented** ([ADR 0006](adr/0006-multiblock-folds.md) watch items: cross-group split tool-pair makes `savedTokens` understate) | **deferred** to Slice 2; alarm deliberately does NOT verify it |

All the same root cause: the UI trusts its own state instead of rendering what actually goes
out. This is governed by the CLAUDE.md rule "preview/read-only is NOT a more permissive
mode" — preview must match the *would-be* wire output too. **Slice 1 closes the per-block
KIND lie (the one a user can actually trigger) and installs the alarm; the rarer rows are
alarmed-or-deferred, not silently dropped.**

## Near-term fix — Option A: one shared predicate (DOING THIS)

> **As-shipped (Slice 1) note — read this first.** The design below originally pictured a
> single predicate combining *kind + durable-id + non-empty-digest*. Implementation found
> that the durable-id half **cannot** gate the view: the on-disk / demo / Claude-Code parse
> assigns non-durable ids (`<eventId>:p<j>`), so demanding durable-id in the view would forbid
> all demo/read-only folding and break the golden. So Slice 1 split it: `wireFoldable(b)` is
> **kind-only** and universal (view + wire), while **durable-id stays a live-wire emit guard**
> inside `computeFoldOps` (unchanged). The kind half is what actually kills the `tool_call`
> lie. Points 2–3 below (group-balance unification, backstop reconciliation) are **Slice 2**,
> not yet built. See the "What Slice 1 actually shipped" section above for the real surface.

Extract the wire's rules into single pure functions and route the store **through** them, so
the view can no longer form a folded-state the wire would refuse.

1. **One foldability predicate.** A single `wireFoldable(block)` lives in the engine
   ([`digest.ts`](../app/src/lib/engine/digest.ts), next to `FOLDABLE_KINDS`). `store.fold()`,
   `store.substOne()`, `store.canFold()`, `store.isFolded` accounting, and `computeFoldOps`
   all gate on it. (As shipped it is **kind-only** — see the note above; the durable-id guard
   remains wire-side in `computeFoldOps`, and the extension's `applyPlan` keeps re-deriving as
   defense-in-depth from identical code, so it can only ever **agree**.)
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
2. **Runtime alarm (identical in dev and production).** On real sessions the check runs
   after each plan computation. On mismatch the UI shows the **slow-flashing red indicator**
   and takes no corrective action — no self-heal, no auto-correct, no halt. This is the same
   in every build: the user-facing alarm does not differ between dev and production. It is an
   alarm, nothing else. (Owner decision.)
3. **Dev-only diagnostic (extra channel, invisible to users).** In a dev build the *same*
   mismatch ALSO emits a **loud console error** naming the diverging block (id, kind, screen
   value vs. wire value), because only a developer can act on that detail and a production
   user has no console open. This is not a different alarm — it is the same alarm plus a debug
   payload that production simply has no use for. The app keeps running either way. (Owner
   decision: loud error, keep running — not a hard throw.)

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
