# ADR 0001 — Live integration with the pi agent

**Status:** accepted (Milestone 1 in progress)
**Date:** 2026-06-04

## Context

Accordion has been a *passive viewer* — it reads pi/Claude session `.jsonl` files
after the fact. The product goal is for it to actually shape what pi sends the
model (the "Conductor" role): fold/compress context live, steerable from the GUI.

pi supports this directly. Its extension API exposes a `context` hook that fires
before every model call and lets an extension **replace** the outgoing
`AgentMessage[]` (see `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`).
The old POC at `src/accordion.ts` already used it (turn-level, terminal-only).

## Decision

**Architecture: "GUI drives, thin extension."** The folding engine that already
exists in `app/src/lib/engine` stays the single brain. The pi extension does no
deciding — it linearizes pi's in-memory messages into blocks, streams them to the
GUI, and applies whatever fold plan the GUI returns.

**Fold granularity: per block.** pi's `AssistantMessage.content` is an array of
`text | thinking | toolCall` parts and a tool result is its own `toolResult`
message — a 1:1 match for our block kinds, so each block folds in place.
Provider-safe apply rules (used from M2 on):

| Block        | Live fold                                                        |
|--------------|-----------------------------------------------------------------|
| `tool_result`| replace `content` with `[{type:"text",text:digest}]`; keep `toolCallId`/`toolName`/`isError` |
| `text`       | replace `part.text` with a non-empty digest                     |
| `thinking`   | replace `part.thinking` with a short digest (replace, not drop) |
| `tool_call`  | **never fold** — removing it orphans its result → provider 400  |
| `user`       | **never fold** (v1)                                             |

**Transport: WebSocket, extension is the server, GUI webview is the client**
(`protocol.ts`, port 4317). A Tauri webview is a browser, so this same loop runs
in `npm run dev` with zero Rust — which is why M1 needs no `src-tauri` changes.
Trade-off: one session per port for now; multi-session (GUI-hosts) is deferred and
uses the identical protocol with only who-binds flipped.

**Protocol: delta-sync, GUI computes the plan** (`app/src/lib/live/protocol.ts` is
the single source of truth, imported by both sides). Context is append-mostly, so
each `sync` carries only newly-added blocks; the GUI keeps the running model,
computes per-block ops + digest text, and replies. The extension applies by id
(ids encode message location).

## Safety invariants

1. **No GUI / timeout ⇒ pass messages through unmodified.** Never corrupt context.
2. **Suppress pi's native `/compact` only while the GUI is attached.** Detached, pi
   must keep its own self-protection. (The old POC suppressed unconditionally — a
   bug to avoid here.)
3. **Protected working tail** (the recent ~N tokens) is never auto-folded; the
   engine enforces it. *(The extension once kept a coarse message-count backstop as
   defense in depth; it was removed in ADR 0011 — under the `tail-size` lock it was
   stricter than the view, so the engine is now the single foldability gate.)*

## Milestone 1 (this change)

Prove the loop with **zero risk**: the GUI replies with an empty plan (`ops: []`),
so the first thing to touch a real model call does nothing. Deliverables:
`protocol.ts`, the pi extension (server + sync + no-op apply + conditional
compaction suppression), and the GUI live client + live store mode. Turning the
engine on and enabling per-block apply is Milestone 2.

## Known follow-ups before Milestone 2 (turning the engine on)

These don't affect M1 (empty plan ⇒ no model call is altered) but must be settled
before non-empty fold ops ship. From the M1 adversarial review:

- **Durable block ids.** `linearize` currently keys ids on the live array index
  (`m<i>:…`). That is stable only while the context is append-only — true while we
  suppress pi's compaction, but a branch switch / `/undo` reorders messages and would
  re-map ids. Before M2, derive ids from a durable per-message identity (pi's message
  id if exposed), mirroring `engine/parse.ts`.
- **`applyPlan` hardening (done early).** It is already pure (never mutates pi's array)
  and kind-checked (an op resolving to a missing or wrong-kind part is ignored), so a
  mis-mapped id cannot fold a `tool_call`. Revisit if M2 introduces partial-message ops.
- **Reconnect correctness (done early).** Stream cursor + pending requests are tied to a
  connection `epoch`; only the current GUI's messages are honored; outstanding requests
  resolve as passthrough on swap/shutdown.
- **Latency / liveness.** The 250 ms per-call wait is on the model-call critical path; a
  half-open GUI socket would tax every turn. Add a heartbeat so `attached()` drops a dead
  client fast (M2 polish).
- **Full re-sync vs. local state.** On `full:true` the GUI rebuilds its store from
  scratch; once manual folds/pins exist (M2) this should reconcile, gated on a changed
  `hello.sessionId`, rather than discard them.

## Rejected alternatives

- **Headless smart-folder / GUI-as-thin-client** — the user chose GUI-drives.
- **Whole-message fold** — simpler apply, but loses the sub-message block model
  that is the app's identity. User chose per-block.
- **Extension reads the on-disk `.jsonl`** — only sees committed history, can't
  influence the live model call, and races the writer.
- **GUI hosts the server (Rust) for M1** — more robust for multi-session but needs
  a Tauri/tokio WS server and can't be exercised in the browser dev loop. Deferred.
