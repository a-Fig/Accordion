# ADR 0004 — Engine on: live folding behind an opt-in toggle

**Status:** accepted (Milestone 2, first cut)
**Date:** 2026-06-06
**Builds on:** [ADR 0001](0001-pi-live-integration.md) (the fold loop / wire protocol),
[ADR 0002](0002-pull-connection-model.md) (discovery), [ADR 0003](0003-responsive-block-streaming.md)
(durable ids + committed streaming + ghosts — the foundation this stands on).

## Context

Through M1 the live loop was proven end-to-end while the GUI replied to every
`context` hook with an **empty plan** (`ops: []`) — so the one thing that touches a
real model call deliberately did nothing. ADR 0003's foundation (durable,
content-anchored block ids; idempotent ingest; committed streaming) then landed.
Everything needed to fold a live agent's context safely now exists **except the act
of doing it**: `computePlan()` was still a stub returning `[]`.

M2 is "turning the engine on" — the GUI returns a non-empty plan that pi applies,
so for the first time Accordion changes what the model sees. This is also the first
change that can break a running agent, so the first cut is deliberately conservative.

## Decision

### 1. Mirror the engine, don't re-derive a policy

The engine (`AccordionStore`) already decides, per block, what is folded — it runs
`refold()` on every `appendBlocks`, and the on-screen grid renders exactly that.
`computeFoldOps(store)` (`app/src/lib/live/plan.ts`) is a **pure** translation that
emits one `FoldOp` per block the store currently folds. The plan the agent receives
is therefore always identical to the fold state the user is looking at — there is no
second, divergent policy. (Rejected: computing a separate plan from raw blocks — it
could drift from the view, which is the one thing a "source of truth" must never do.)

### 2. Folding the live agent is opt-in and OFF by default

A switch (`folding.enabled`, `app/src/lib/live/folding.svelte.ts`) gates whether the
plan is sent. The gate sits in `computePlan()`:

```
if (!folding.enabled) return [];        // disarmed ⇒ M1 behavior, no model call altered
return computeFoldOps(session.store);   // armed ⇒ mirror the engine's folds
```

The engine **always** folds locally for the preview; the toggle only controls whether
those folds are applied to the agent. So OFF = "preview folds in the view, agent
untouched" (exactly M1); ON = "apply the previewed folds to the agent." This matches
the VISION distinction that *seeing* is not *steering*. The header control reads
**Folding: preview** (muted) when off and **Folding: steering** (accent-lit) when on,
and only appears while a live socket is actually connected (`live.status ===
"connected"` — NOT the broader `session.live`, which is also true for a polled file).
Folding takes effect on the agent's next turn (plans are applied only at the `context`
hook — ADR 0003).

**Arming is per-attach, not persisted.** `folding.enabled` defaults off and is reset
to off on every new live attach (the `hello` handler). For the first feature that can
change a real model call, the switch must never be silently carried from one agent to
the next: each session is armed by a deliberate act. (Both points hardened in response
to the M2 adversarial review.)

### 3. Durable-id guard — the bundled Phase 0 safety

ADR 0003 Phase 0 ("verify the anchor is present and stable") had never actually been
executed; `PiMessage`'s anchor fields are all optional, and `blockId()` falls back to
a **positional** id (`m<i>:…`) when an anchor is missing. A positional id is not
stable once folding makes the message array non-append-only, so folding such a block
risks a mis-targeted op.

Rather than block M2 on proving anchors are always present, we make engine-on
**correct by construction**: a fold op is only ever produced (`computeFoldOps`, GUI)
**and** applied (`applyPlan`, extension) for a block whose id is durable
(`isDurableId`). A block that fell back to a positional id is simply left full — it
costs tokens but can never be mis-folded. Both sides enforce the guard so neither is
a single point of failure. This converts the unverified Phase-0 assumption from a
*correctness risk* into a *coverage limitation* (a rare anchor-less block just isn't
folded). (Rejected: trust positional ids and self-heal — a mis-fold is exactly the
"showed something false / corrupted the model call" failure the project rules out.)

## Safety invariants (unchanged from ADR 0001, re-verified here)

1. No GUI / reply timeout / disarmed ⇒ messages pass through unmodified.
2. `tool_call` and `user` blocks are never folded (kind-checked on both sides).
3. The protected working tail is never auto-folded (engine). *(The extension's
   `PROTECT_RECENT_MSGS` message-count backstop that once added defense-in-depth here was
   removed in ADR 0011 — it was stricter than the view under the `tail-size` lock; the engine
   is now the single foldability gate.)*
4. Folding is content substitution, never removal — provider-safe and reversible.

**Load-bearing external dependency (review Q1):** reversibility rests on pi treating
the `context` hook's returned `AgentMessage[]` as a **per-call view** — i.e. the next
hook still receives pi's own original (unfolded) array, not our folded one. The
extension never writes `applyPlan`'s output back into its `lastMessages` cache, and
`applyPlan` is pure, so nothing on our side persists a fold; but if a future pi
persisted the returned array, folds would become permanent. This is the one guarantee
to re-verify on a pi upgrade. A re-fold every turn (re-sending ops for still-folded
blocks) makes the applied state idempotent and self-correcting either way.

## Scope / limitations (this change)

- **Auto-folder only.** The plan reflects the engine's automatic, budget-driven
  folds. Manual fold/pin reconciliation across a full re-sync (ADR 0001 follow-up)
  and a socket heartbeat are still open and out of scope here.
- **Anchor-less blocks are never folded** (by the guard above). If a real session is
  observed producing many positional ids, the defined hardening is a content-hash
  anchor (ADR 0003 Phase 0 fallback) — not yet needed.
- **Effect is next-turn.** Arming folding mid-turn applies on the agent's next
  `context` hook, by protocol design.

## Verification

`computeFoldOps` and `isDurableId` unit-tested (`plan.test.ts`); the anchor-less /
positional path and the `applyPlan` durable-id + empty-digest + kind guards covered
in `mapping.test.ts` and the extension `smoke.mjs`. Full gate: `svelte-check` 0/0/0,
`vitest`, `npm run build`, extension smoke. Default-off keeps the empty-plan path
(and its proofs) intact.
