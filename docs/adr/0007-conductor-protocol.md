# ADR 0007 — The Conductor protocol: an interchangeable context-management contract

> **Superseded in part by [ADR 0008](0008-conductor-first-party-one-view.md):** conductors
> are first-party (not untrusted third parties), the contract moved to `conductors/contract/`,
> the built-in to `conductors/builtin/`, there is one public `ConductorView` for all
> conductors, and the in-process path is now primary (WebSocket demoted to an escape hatch).
> The core contract below — `conduct → Command[]`, content-substitution commands, clamp
> reports, human-overrides-win — still stands.

**Status:** accepted (Milestone 1 — the engine seam)
**Date:** 2026-06-13
**Builds on:** [ADR 0001](0001-pi-live-integration.md) (the live link / "GUI drives, thin
extension"), [ADR 0002](0002-pull-connection-model.md) (registry-file discovery — the
conductor link reuses its shape), [ADR 0006](0006-multiblock-folds.md) (the group overlay
a `group` command rides on).
**Supersedes:** the framing in [docs/conductor-plan.md](../conductor-plan.md) that treats
the built-in auto-folder as a permanent privileged backstop. It is not — it is now just
the default conductor (see Decision).

## Context

Accordion's whole job is the Conductor role: between turns, fold what has gone cold and
keep the live context useful and within budget. Today it does this with exactly **one,
implicit conductor** — the engine's `AccordionStore.refold()` auto-folder. Its decisions
(kind-rank + age, fold-only, fires only over budget) are baked into the store, and on a
live session they are mirrored to the agent through `plan.ts`. There is no abstraction:
no way to name a strategy, swap it, run two side by side, or let someone else write one.

Three developers want to each build their own context-management strategy — a relevance
model, an LLM summariser, a hierarchical compactor — and slot it into Accordion behind a
well-defined interface, in **any language**. None of that is possible while the one
strategy lives as private methods on the store. We need a contract: a stable shape a
stranger can target without reading the engine, and a re-wire of the built-in folder to
prove the contract is sufficient by running through it itself.

The design was settled with the owner in an alignment session; the locked decisions are
recorded under Decision. **Benchmarking and strategy quality are out of scope** — this ADR
defines the seam, not what makes a good conductor.

## Decision

### 1. The contract is one pure idea: `conduct(snapshot) → Command[]`

A **conductor** is an interchangeable context-management strategy. The host hands it a
read-only `ContextSnapshot` (every block in conversation order, the budget, the context
window, the current live token cost, and the host's protected-tail policy); the conductor
replies with `Command[]` describing the context it wants. The host clamps those commands
to the one floor it enforces, applies them to the session store, and — on a live session —
mirrors the resulting store state down the unchanged pi wire via `computeFoldOps`.

The in-process shape lives in `app/src/lib/engine/conductor.ts` (`ContextSnapshot`, the
`Command` union, `ClampReport`/`ClampReason`, and `interface Conductor`). It is
dependency-free and runes-free so the engine, the live wire layer, and an out-of-process
conductor can all import it.

The return value carries three meanings:

- **`Command[]`** — the conductor's *complete desired state*; the host resets to the raw
  baseline and applies the batch.
- **`[]`** — explicitly clear to raw (nothing folded).
- **`null`** — *hold*: keep the last applied state untouched. This is how an async
  (remote) conductor that is still thinking declines to block a model call.

### 2. The async, cross-process form is a WebSocket — the **conductor hosts, Accordion connects**

The wire (`app/src/lib/live/conductorProtocol.ts`) is the same contract serialised to
JSON, with capability negotiation and a `rev` so a reply to a stale snapshot is detectable.
Topology mirrors the pi extension link (ADR 0001): **the conductor hosts the `ws://`
endpoint and Accordion dials out as a client.** The reason is the same — the app is a
webview and cannot host a server. The command vocabulary and clamp reports are *imported*
from the in-process contract, so there is no separate wire representation of a fold to
drift out of sync.

A local conductor advertises itself with a registry file at
`~/.accordion/conductors/<id>.json` (the `ConductorEntry` shape in `registry.ts`),
refreshed on a heartbeat and reaped when stale — the exact discovery model ADR 0002 gave
pi sessions. A remote conductor is a `ws://` URL the user configures by hand. stdio
transport is a later add.

### 3. "Conductors all the way down" — the built-in is just the default

The built-in folder is re-wired into a `BuiltinConductor implements Conductor`
(`conductor.builtin.ts`) — a verbatim lift of `refold()`'s decision body. It is no longer
a privileged backstop the engine falls back to; it is one conductor among many, the one
attached by default. With **no conductor attached the context is raw** — Accordion never
invents a strategy of its own. This is the supersession of `conductor-plan.md`'s framing:
there is no permanent auto-folder underneath, only a default that can be detached or
swapped like any other.

### 4. The locked decisions

- **One host floor only: provider-validity.** The outgoing message must always stay
  sendable. Everything else — what to fold, protected tails, recovery tags, kind ranking —
  is the *conductor's* strategy, not a host rail.
- **Commands are content-substitution, never structural removal.** A block is never
  spliced out of the conversation; only its content changes — including to empty
  (`replace(id, "")`, the safe form of "delete": the block stays in place so its
  `callId`/pairing is intact but contributes almost nothing). This single rule makes
  broken states unrepresentable: a `tool_call`/`tool_result` pair can never orphan,
  because neither block can vanish.
- **Imperative commands accumulate into a persistent current state.** Each `conduct()`
  return is the complete desired state — the host resets to baseline, then applies the
  batch. While a conductor is silent (`null` / no wire message), the host holds the last
  applied state. New blocks that stream in before it next speaks arrive raw.
- **Human GUI overrides always win.** A human pin / manual fold / manual unfold owns its
  block; a conductor command touching a human-held block is refused, never honoured. A
  `group` that would swallow a human-held block is refused **wholesale** (the whole group,
  not just the held member). Human overrides are always reversible and auditable —
  originals are retained, and conductor substitutions write only `Block.subst`
  (+ `autoFolded`), never `override`, which stays the human's alone.
- **A command that breaks validity is clamped, never dropped, never crashes.** The host
  clamps to the nearest safe form (or a no-op) and returns one `ClampReport` per affected
  command — reasons: `unknown-id`, `human-override`, `grouped`, `invalid-group`, `noop`.
  The conductor learns and adapts; the session never corrupts.
- **Full trust once connected.** Attaching a conductor grants it full trust. It *declares*
  the content it wants (`wants.content`: `"full"` | `"shape"` | `"onDemand"`, default
  `"full"`) — a bandwidth/own-preference choice, not a security boundary.
- **Groups are contiguous-only.** A `group` command collapses a contiguous run
  (summary-on-head, the rest emptied — never removed). Anything non-contiguous is done by
  emptying/replacing blocks individually.

## Consequences

**What this enables.** A stranger writes a conductor in any language, advertises it in
`~/.accordion/conductors/`, and Accordion attaches to it over a WebSocket — no engine
knowledge required, only the message shapes in `conductorProtocol.ts` (see
[docs/conductor-protocol.md](../conductor-protocol.md)). Multiple conductors can be listed
and switched per session, which makes A/B comparison of strategies a UI affordance rather
than a code change. The built-in becomes the reference implementation a newcomer reads to
see "what a simple budget folder does."

**What stays the same.** The pi extension is untouched — the app remains a single client
to the extension and becomes an *additional* client to the conductor. The live mirror path
is unchanged: the conductor drives the store, and `computeFoldOps` / `computeGroupOps`
(`plan.ts`) mirror store state to the pi wire exactly as before. The provider-validity
floor still lives in `mapping.ts` (`isDurableId`, the `tool_call` refusal); `applyCommands`
mirrors it store-side and emits the `ClampReport`s. `protocol.ts` / `PROTOCOL_VERSION` do
not move.

**Known v1 scoping.**

- **The protected tail stays physically in the store**, but it is host *policy* surfaced
  in the snapshot (`protectedFromIndex`, `protectTokens`), not a host floor. It is
  consulted as a hard line only when the **built-in** conductor is attached — the
  built-in's own knob, driven by the existing protect handle. When an external conductor
  is active the host applies its commands directly (validity-clamped only) and the grid
  shows a single box, unless the conductor later declares a protected region. This honours
  "Accordion imposes no strategy" where it matters while avoiding a ~20-call-site refactor
  of `protectedFromIndex`; full extraction into the built-in is a clean fast-follow.
- **`group` = summary-on-head + empty-the-rest** via the existing group overlay (ADR
  0006) — no new wire op, no structural removal, the invariant preserved. The human's
  manual group feature is unchanged.
- **Async staleness.** A `context/update` may be stale by the time commands return; the
  host applies by durable id and folds any op naming a vanished id into a `ClampReport`
  (`unknown-id`) rather than failing.

**Supersession note.** This ADR supersedes the part of `docs/conductor-plan.md` that
assumes the auto-folder is a permanent backstop beneath every strategy. Under this
contract it is the *default* conductor, detachable and swappable; "no conductor" means raw
context, not auto-folded context. The rest of `conductor-plan.md` (the milestone roadmap
for richer strategies) still stands.

## Rejected alternatives

- **Accordion hosts the conductor server.** Rejected for the same reason as ADR 0001's
  transport: the webview cannot host. The conductor hosts; Accordion dials out. (A Rust
  WS host is the same deferred option it was for the pi link.)
- **Structural removal as a command.** Rejected: splicing a block out is the one operation
  that can orphan a `tool_call`/`tool_result` pair and produce a provider 400. Content
  substitution (incl. `""`) gets "delete" with the pairing invariant intact.
- **A privileged auto-folder backstop under every conductor.** Rejected: it would mean
  Accordion always imposes a strategy, contradicting "no conductor ⇒ raw context" and
  making strangers' conductors second-class. The built-in is a peer, attached by default.
- **A separate wire representation of a fold.** Rejected: the wire imports `Command` /
  `ClampReport` from the engine contract, so there is exactly one definition and nothing to
  drift.
- **Declarative diffs over the wire.** Rejected for v1: imperative full-state batches are
  simpler to reason about under async staleness (resend the whole intention, echo the
  `rev`) and let a conductor work declaratively *internally* if it prefers.
