# ADR 0013 — Conductor host capabilities: injecting the model link into in-process conductors

**Status:** accepted
**Date:** 2026-06-15
**Builds on:** [ADR 0007](0007-conductor-protocol.md) (the conductor seam — `conduct →
Command[]`), [ADR 0008](0008-conductor-first-party-one-view.md) (first-party conductors,
one public `ConductorView`), [ADR 0001](0001-pi-live-integration.md) ("GUI drives,
extension is thin" — the live link pattern this mirrors).

## Context

The conductor interface after ADR 0008 is a clean one-way call: the host hands the
conductor a `ConductorView`, the conductor hands back `Command[]`, and the host applies
them. That is exactly the right shape for pure fold/restore/replace strategies (the
built-in, cold-score, attention folder) — they need nothing from the host to compute their
answer.

The next category of strategy, however, needs more: an LLM summarizer must generate text
from the agent's model; a compaction conductor needs a completion. Nothing in the ADR
0007/0008 contract provides that. Before this ADR:

- **In-process conductors (the only documented path)** had no host access at all. An
  in-process conductor that wanted to run a model call had to carry its own credentials and
  API client — defeating the user's existing model link and making the conductor fat.
- **Out-of-process (WS) conductors** already had a partial answer: the conductor wire
  (`conductors/contract/protocol.ts`) defined `cap/request` messages that could, in
  principle, ask the host for services. But no capability of the "call a model" shape was
  defined on the wire, and in-process conductors received nothing.

The result was a two-tier system: the WS escape hatch was nominally richer (cap/request),
while the "primary way" (in-process TypeScript class) had an impoverished surface with
no model access. ADR 0008's promise — "the built-in is the reference, programmed against
exactly the surface anyone else gets" — was structurally incomplete for the LLM-using
category.

Three rejected approaches crystallized the right design:

1. **LLM logic inside the pi extension's context hook.** A natural first instinct: the
   extension already has the model reference (`ctx.model`, `ctx.modelRegistry`). But this
   would put strategy decisions in the extension, violating the ADR 0001 "GUI drives,
   extension is thin" invariant. The extension cannot be a conductor (not swappable, not
   on the same measurement axis) and must never make folding decisions itself.
2. **Own-key WS conductor only.** A WS conductor running out-of-process can carry its
   own API key. Viable, but it bypasses the user's model link (wrong credentials, wrong
   model, double billing), forces an out-of-process deployment for what should be a
   straightforward in-process strategy, and leaves in-process conductors with no model
   access.
3. **WS-only capabilities, nothing for in-process.** Already the status quo — explicitly
   rejected because it makes the WS path structurally richer than the documented primary
   path, which is backwards.

The right framing: the `Conductor` interface needs an optional lifecycle hook that hands
the conductor a services handle before its first `conduct()` call. That handle — not the
wire — is the primary way. The wire is still valid and still uses the same handle, making
it a transport rather than a privileged channel.

## Decision

### 1. `ConductorHost` injected via optional `attach(host)`

The `Conductor` interface in `conductors/contract/conductor.ts` gains two optional
lifecycle methods:

```typescript
attach?(host: ConductorHost): void;
detach?(): void;
```

`attach` is called by the store once per `attach()` call, before the first `conduct()`.
`detach` is called by the store once per detach/swap, after the final `conduct()` of that
instance's lifetime. Both are optional — a pure, stateless conductor (the built-in,
cold-score) compiles and runs unchanged; `attach` is not called if the method is absent.

`ConductorHost` is the services handle:

```typescript
interface ConductorHost {
    can(capability: HostCapabilityId): boolean;
    complete(req: CompletionRequest): Promise<CompletionResult>;
    countTokens(text: string): number;
    digestOf(id: string): string | null;
    setStatus(text: string | null, metrics?: Record<string, number | string | boolean>): void;
    requestRerun(): void;
}
```

`HostCapabilityId` is `"complete" | "countTokens" | "digest"`. `countTokens` and `digest`
are always available (synchronous, engine-backed). `"complete"` requires a live model link
and returns `false` from `can()` without one.

`buildHost()` in `AccordionStore` (`app/src/lib/engine/store.svelte.ts`) constructs the
host object once per `attach()` call. The object reads through the live store state,
so a capability that becomes available after attach — notably the `completer` being set
when the socket opens — is reflected immediately without requiring a new host object.

### 2. `conduct()` stays synchronous and side-effect-free

The `conduct(view)` signature is **not changed** — it remains synchronous, returns
`Command[] | null`, and must never await anything. This is non-negotiable: the host calls
`conduct()` on every context change (a block streaming in, the budget moving, the protect
tail resizing), and that path must never block.

A conductor that needs a model completion follows the async pattern documented in the
`ConductorHost` JSDoc:

1. From `conduct()`: detect that a completion is needed. If one is already in flight,
   return `null` ("hold" — keep the last state). Otherwise kick off
   `host.complete(req)` in the background (store the promise on the instance), and return
   `null` immediately.
2. When the promise resolves: stash the result in instance state, then call
   `host.requestRerun()`. This asks the host to re-run `conduct()` now.
3. On the next `conduct()` call: the stashed result is in instance state; emit the
   commands.

This pattern mirrors exactly how `RemoteRunner` already works for out-of-process conductors
(it holds the last `conductor/commands` batch and returns it synchronously while the remote
is computing). `requestRerun()` is the in-process analogue of the remote's
`poke store.refold()` after receiving fresh commands.

`detach()` is where an in-flight completion should be aborted — a conductor that calls
`host.complete()` should hold an `AbortController`, pass its `signal` in the
`CompletionRequest`, and call `controller.abort()` from `detach()` so stale completions
do not call `host.requestRerun()` after the conductor is gone.

### 3. One host implementation, two transports

There is **one** `ConductorHost` object, built by `buildHost()` in `AccordionStore`. Its
`complete()` delegates to `store.completer` — a field the live layer sets when the
WebSocket to the pi extension opens (`liveClient.svelte.ts` line `session.store.completer = sendCompletion`) and clears on disconnect.

Out-of-process conductors reach the same capability through the conductor wire. When a
`RemoteRunner` receives a `cap/request { capability: "complete" }` message from the remote
process, `serveCapability()` in `conductorClient.svelte.ts` calls `this.host.complete()` —
the same host object the store injected via `attach(host)`. The WS is a transport for the
same service, not a separate implementation.

### 4. Fulfillment path: app → extension → pi-ai → user's model

When `host.complete(req)` is called by an in-process conductor:

1. `store.completer(req)` is called, which is `sendCompletion` from `liveClient.svelte.ts`.
2. `sendCompletion` writes a `completeRequest` message over the existing pi-extension
   WebSocket (`type: "completeRequest"`, pi wire protocol v5).
3. The pi extension (`extension/accordion.ts`) receives the message in its WS handler,
   fires an async IIFE completely off the sync message path, resolves credentials via
   `ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)`, and calls
   `complete(m, context, ...)` from `@earendil-works/pi-ai` (lazy dynamic import).
4. The extension sends back a `completeResult` message with the text, model id, and usage.
5. `sendCompletion`'s promise resolves, and `liveClient` routes it to the pending promise
   map by `reqId`.
6. The conductor's `.then()` handler fires, stashes the result, calls `host.requestRerun()`,
   and the store re-runs `conduct()`.

The extension is thin throughout: it runs exactly the completion it is handed and returns
the raw result. No folding decision, no strategy, no prompt rewriting.

### 5. Capability availability and graceful degradation

`host.can("complete")` returns `true` only while a live pi session is connected and the
`store.completer` is set. It returns `false` in:

- **Browser dev** (`npm run dev`): no pi extension, no WebSocket, no completer.
- **Read-only Claude Code transcripts**: the CC path never opens a pi socket.
- **Demo session** (bundled sample): same — no live connection.
- **Disconnected extension**: the live client sets `store.completer = null` on socket close.

Conductors using `complete` must call `can("complete")` first and handle unavailability
explicitly. The naive compaction conductor (`conductors/compaction-naive/`) demonstrates
the visible-waiting pattern: when `can("complete")` is false it preserves any existing
summary, leaves newly-aged blocks live, and calls `host.setStatus(...)` instead of
silently switching to a deterministic grouping strategy.

### 6. Protocol versions

- **Conductor wire protocol:** `CONDUCTOR_PROTOCOL_VERSION = 3` (up from 2). `cap/request`
  gains the `"complete"` capability and a `completion: { system?, prompt, maxOutputTokens? }`
  payload. `cap/result` gains `model`, `inputTokens`, and `outputTokens` fields on a
  successful complete result.
- **Pi wire protocol:** `PROTOCOL_VERSION = 5` (up from 4). New message types:
  `completeRequest` (GUI → extension) and `completeResult` (extension → GUI).

Old extensions (protocol < 5) simply do not respond to `completeRequest`, so the pending
promise times out or is drained on disconnect. Old conductors (protocol < 3) never send
`cap/request { capability: "complete" }` and are unaffected.

## Consequences

**What this enables.** An in-process conductor can now run an out-of-band model call
using the user's existing session model, with no credentials of its own. The pattern is
four lines of instance state plus the async pattern above. The naive compaction conductor
(`conductors/compaction-naive/`) is the first consumer and the reference example.

**Backward compatibility.** The built-in and cold-score conductors omit `attach` and
`detach`; they compile and run unchanged. The built-in golden test
(`conductor.builtin.test.ts`) is byte-identical. Old extensions that predate protocol v5
ignore `completeRequest`; old WS conductors that predate protocol v3 never send the
`complete` capability.

**The "extension is thin" invariant is preserved.** The extension executes the exact
completion it is handed and returns the raw text. It decides nothing about folding,
prompt construction, or context management. Those remain in the GUI.

**"Never blocks or alters a model call" invariant is preserved.** The `completeRequest`
path is completely outside the `sync → plan → apply` loop. The extension handler fires an
async IIFE and returns immediately; the gui-side `sendCompletion` is off the `conduct()`
hot path; the `context` hook is never held.

**Known limitation: no per-request wire cancellation.** `AbortSignal` is not serializable
over JSON, so the conductor wire (`cap/request`) does not support per-request cancellation.
A WS conductor that no longer wants a result should simply ignore the arriving `cap/result`
by `reqId`. The in-process path (`host.complete(req)` with `req.signal`) supports
`AbortSignal` fully — the pending promise is removed from the map and rejected immediately
when the signal fires, and a late `completeResult` for that `reqId` is silently ignored.

## Rejected alternatives

- **LLM logic inside the extension context hook.** Rejected: violates "GUI drives,
  extension is thin" (ADR 0001). The extension is not a conductor — it is not swappable,
  not on the same measurement axis, and must never make context-management decisions.
- **Own-key out-of-process WS conductor only.** Rejected: requires its own credentials
  (wrong model, double billing), forces an out-of-process deployment for what should be
  an in-process strategy, and leaves in-process conductors without model access.
- **WS-only capabilities, no in-process change.** Rejected: makes the escape-hatch path
  structurally richer than the primary path — the opposite of ADR 0008's stated goal. The
  `ConductorHost` injected via `attach` is the primary surface; the WS merely transports it.
- **Passing the `ConductorView` enriched with a raw API key / client handle.** Rejected:
  the view is serializable data for the wire path; putting a callable into it would break
  that invariant and require two different view shapes for in-process vs. wire conductors.
