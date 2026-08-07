# ADR 0022 — Conductor contract v2: evented, transactional, write-once portable

**Status:** accepted (Phase A — contract + validation suite; Phase C host not yet built)
**Date:** 2026-07-17
**Builds on:** [ADR 0007](0007-conductor-protocol.md) (the original `conduct(view) → Command[]`
contract this ADR replaces the transport/lifecycle of, while keeping its authoring ergonomics
alive through an adapter), [ADR 0008](0008-conductor-first-party-one-view.md) (first-party
conductors, one public view — the framing this ADR keeps), [ADR 0011](0011-conductor-involvement-locks.md)
(involvement locks — declared here, enforced nowhere yet), [ADR 0013](0013-conductor-host-capabilities.md)
(`ConductorHost.complete` — the out-of-band model call this ADR's `ConductorHost` still exposes),
[ADR 0017](0017-handoff-conductor.md) (the handoff conductor, ported onto this contract),
[ADR 0021](0021-truth-in-the-extension.md) (the authoritative Truth this contract's host wraps).

## Context

The entire conductor strategy layer — the `conduct(view) → Command[]` contract, its in-process and
WebSocket runners, the built-in folder, attach/detach/consent, and the out-of-band completion relay
— was excised from this branch (`51ad4a7`/`f4bb4ed`/`51ade0c` and siblings) for a ground-up
redesign; see the CLAUDE.md Conductors section. The old contract's per-turn model — a conductor
returns its *complete* desired state every pass, and the host does an O(n) full-view recompute to
materialize what changed — worked but did not scale to a strategy that wants **asynchronous,
partial, incremental** reasoning: an attention probe scoring blocks in a side process, an LLM
summarizer that takes seconds to return, or a strategy that only needs to react to the handful of
blocks a `turn-committed` event just added.

Phase B ([ADR 0021](0021-truth-in-the-extension.md)) also changed *where* a conductor would have to
run: the authoritative Truth now lives inside the pi extension process, not the GUI. Any conductor
contract from here forward has to work identically whether the strategy is compiled into that same
process or running as a separate program that only ever sees the Truth through a wire.

## Decision

### 1. A conductor is a resident, evented `Conductor`

`core/conductor/contract.ts` defines the frozen v2 shape:

```ts
interface Conductor {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly locks?: readonly LockName[];
  readonly tailTokens?: number;
  readonly holdWireUpToMs?: number;
  attach(host: ConductorHost): void;
  detach(): void;
}
```

A conductor is handed a `ConductorHost` once, at `attach`, and holds it until `detach`. It does not
return a value from a per-turn call; instead it *subscribes* (`host.on(fn)`) to `HostEvent`s —
`blocks-appended`, `turn-committed`, `state-changed`, `wire-departing`, `resync` — and reacts
asynchronously by `await`ing `host.propose({ baseRev, ops })` whenever it has something to say. This
inverts the old model: the host no longer polls a conductor every pass and clears its prior work
first; the conductor pushes transactional diffs whenever its own reasoning (sync or eventually
resolved) produces one. `propose` returns `Promise<TxnResult>` — **async by default**, the
contract's philosophy: an in-process host applies the ops synchronously the instant `propose` is
invoked and resolves the result on a microtask, while an out-of-process host (a spawned conductor
over the wire, §6) resolves it after the `propose`→`proposeResult` round trip. A conductor cannot
tell the two hosts apart, which is the portability property that lets the same `ThermoclineConductor`
run in-process under `TestHost` and out-of-process under the remote SDK.

### 2. Every mutation is a `propose`d, `baseRev`-anchored transaction of ops

`core/ops.ts`'s `Op` union (`fold`/`unfold`/`pin`/`unpin`/`auto`/`replace`/`group`/`ungroup`/
`foldGroup`/`unfoldGroup`/`resetAll`) is the same vocabulary `Truth.apply` uses for human, agent,
and strategy actions alike — there is no separate "conductor command" shape to drift out of sync
with the engine's own write path. `host.propose` forwards straight to `Truth.apply(ops, "auto",
baseRev)`, so every op a conductor proposes is clamped by the exact same predicate a human hand
action or the agent's own tools are clamped by (`canFold`, the protected-tail check, the
human-override check, the birth-fold exemption — [ADR 0023](0023-birth-fold-restored.md)). A
conductor never gets a privileged write path.

Strategy ops run under actor `"auto"`: they set `autoFolded`/`subst` and leave `override` null, so
**a human override always wins** — the same rule ADR 0007 established, now enforced by `Truth`
itself rather than by a host-side check the conductor could bypass. The awaited `TxnResult` returns
one `OpResult` per op (`applied` + an optional `ClampReason`), so a conductor always learns exactly
what happened to its proposal — a batch is never partially silent.

### 3. `ViewConductor` — the old authoring ergonomics, ported onto the new engine

`core/conductor/view.ts`'s `ViewConductor` is an abstract `Conductor` that reintroduces the old
`conduct(view: ConductorView): Command[] | null` shape as a thin authoring layer: it subscribes to
`turn-committed` (and `wire-departing` when the subclass declares `holdWireUpToMs > 0`),
materializes a read-only `ConductorView` from the host's queries, calls the subclass's `conduct()`,
and interprets the return as the strategy's **complete desired state** for that pass — diffing it
against what it previously applied and proposing only the delta (`auto`/`ungroup` for anything no
longer wanted, `fold`/`replace`/`group` for anything new or changed). `null` means "hold current
state." This means a strategy ported from the pre-excision contract needs almost no rewrite: five
of the old `Command` kinds (`fold`/`replace`/`group`/`restore`/`pin`) still exist as a small,
self-contained vocabulary the adapter translates into `Op`s, and the 15-line authoring style ADR
0007 valued is unchanged for anyone who does not need `ConductorHost`'s finer-grained event stream.

### 4. Group summary is a three-state contract, unchanged from ADR 0007's original design

A `group` op's `summary` (or the old vocabulary's `digest`) is `undefined` → the engine's own
tagged recap (`{#code FOLDED}`-recoverable), `null`/`""` → drop the run with no wire message at
all, or a non-empty string → that exact text verbatim, untagged (non-recoverable). This tri-state
is why `compaction-naive` (a genuinely lossy summarizer) and a birth-fold demo like `doorman` (which
always wants the recoverable tag) can share one op shape without a boolean flag proliferation.

### 5. Involvement locks are declared data; nothing enforces them yet

A conductor's `locks`/`tailTokens` fields ([ADR 0011](0011-conductor-involvement-locks.md)) are
present on the contract and read by every shipped conductor's own logic (e.g. `handoff` declares
all three locks with `tailTokens = 0`), but **no host in this codebase turns a conductor's declared
locks into a real `Truth.setLocks(...)` call on attach**, and no host reverses it on detach. Every
shipped conductor's tests drive `Truth.setLocks` directly in setup to simulate what that host will
eventually do. This is a deliberate, explicitly-flagged gap (called "Phase C" throughout the
conductor READMEs) — the contract carries the vocabulary forward so a host can be built against it
without another contract revision, but attaching, consent-gating, and freeze-on-detach are not
implemented on this branch.

### 6. Write-once portability: the same class, in-process today, out-of-process by design

Every conductor is written only against `ConductorHost`'s abstract surface (`on`/`get`/`blocks`/
`groups`/`textOf`/`stats`/`countTokens`/`digestOf`/`complete`/`setStatus`/`propose`) — never against
a concrete Truth or transport. When this ADR was first written, `core/conductor/testhost.ts`'s
`TestHost` (a `ConductorHost` backed by a real, local `Truth`) was the only host that existed, and
it is what every conductor's test suite runs against. The design intent — recorded in
`conductors/thermocline/runner.mjs`'s banner comment and its README — is that a **remote SDK**
(`core/conductor/remote.ts`) mirrors a live session's Truth into a local
`ConductorHost` inside an out-of-process runner, so the exact same `Conductor` class runs whether
it is compiled into the extension or spawned as a separate program the extension launches and talks
to over a token-gated WebSocket. `ThermoclineConductor` is written with no knowledge of which
host it will get — that is the portability property this ADR names. *(Update, later on this same
branch: the Phase-C wave shipped exactly this — `core/conductor/remote.ts` implements
`runRemoteConductor`, `runner.mjs` imports it via the committed `remote-sdk.mjs` bundle, and
`extension/smoke-conductor.mjs` exercises the full spawn → attach → propose → detach path end to
end against a real child process.)*

### 7. Bounded wire-hold for last-moment shrinkage

A conductor may declare `holdWireUpToMs` (default 0) to ask the host to pause the departing wire
briefly and give it one more chance to propose before the model call actually leaves — `wire-departing`
carries `freshIds` (blocks never yet sent whole) for exactly this purpose. The `propose` it fires is
async, but its ops are *invoked* synchronously inside the host's event dispatch, so the fold lands
in Truth before the sent cursor advances; the host awaits the handler settling (an in-process fold
settles on a microtask — measured sub-2ms — far under the window, while a remote conductor releases
the hold with its `propose` message). Doorman (see [ADR 0023](0023-birth-fold-restored.md)) is the
shipped example: `holdWireUpToMs: 150`, used to skeletonize or fold a giant fresh `tool_result`
before it ever reaches the model.

### 8. The sacred set stays sacred

Observation, the budget dial, the agent's `recall`, and detach remain outside the lock vocabulary
entirely (unchanged from [ADR 0011](0011-conductor-involvement-locks.md)) — nothing in the v2
contract reopens that question.

## Validation suite: four conductors on the contract

- **`core/conductors/compaction-naive`** — a straight port of the deleted naive LLM-summarization
  conductor (ADR 0014) onto `ViewConductor`; the reference case for "an old `conduct()` strategy
  ports mechanically."
- **`core/conductors/handoff`** — the fresh-start simulator (ADR 0017) ported the same way; the
  reference case for a conductor that declares all three locks and a zero `tailTokens`.
- **`core/conductors/doorman`** — a raw (non-`ViewConductor`) `Conductor` subscribing directly to
  `wire-departing`; the reference case for the birth-fold exemption (ADR 0023) and for
  `holdWireUpToMs`.
- **`conductors/thermocline`** — an attention-gated, LLM-quality compression strategy under a hard
  budget invariant, combining a Python attention-probe temperature signal with real LLM summaries
  across a deterministic epoch state machine (HOLD/PREPARE/COMMIT/EMERGENCY); the reference case
  for a conductor intended to run **out of process** (see §6) and for `locks: ["human-steering"]`
  only, deliberately leaving `agent-unfold` free since the agent's own unfold is one of its
  graduation gates.

Each ships with its own golden test suite against `TestHost`; none is wired into a live session or
any conductor-selection UI on this branch.

## Consequences

- **A conductor can do real async work — a probe subprocess, an LLM call — without blocking a
  model call or an engine turn.** The old full-recompute-per-turn model could not express this
  cleanly; evented + transactional-diff can.
- **The old authoring ergonomics are not lost.** `ViewConductor` means a strategy author who wants
  the simple `conduct(view) → Command[]` shape still gets it, on top of the richer contract.
- **Human overrides winning is now an engine invariant, not a per-host convention** — every
  `propose` is clamped by the same `Truth.apply` a human action goes through.
- **The contract is validated and attached.** Four conductors and their test suites prove the
  shape is sufficient for a real strategy. At the time this ADR was first written the host did not
  yet exist; the Phase-C wave on this same branch then shipped it — `LiveConductorHost`
  (`core/conductor/liveHost.ts`) attaches conductors to live pi sessions, applies their declared
  locks eagerly on attach, converts their folds to human-owned via the `freeze` op on detach,
  spawns out-of-process conductors where declared, and mediates `complete()` against the live
  model through the extension's completion executor.

## Rejected alternatives

- **Keep the old per-turn full-recompute model and just make it faster.** Rejected: the ceiling is
  structural (an async strategy cannot express "I'm still thinking" inside a call that must return
  synchronously every turn), not a performance tuning problem.
- **A single blocking `conduct()` call with a promise return.** Considered and rejected: an
  in-flight promise the host awaits on every turn re-introduces exactly the kind of stall Phase B's
  local `context` hook was designed to eliminate ([ADR 0021](0021-truth-in-the-extension.md)). The
  evented model lets a conductor take arbitrarily long between proposals without ever occupying a
  hook.
- **Separate wire and in-process command vocabularies.** Rejected for the same reason ADR 0007
  rejected it the first time: importing one `Op`/`ClampReason` definition everywhere is what keeps
  the wire and the engine from drifting.
