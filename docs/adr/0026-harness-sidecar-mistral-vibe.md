# ADR 0026 — A pi-extension host sidecar, and mistral-vibe as the first non-pi harness

**Status:** proposed / in progress (branch `vibe`)
**Date:** 2026-08-22
**Builds on:** [ADR 0021](0021-truth-in-the-extension.md) (the authoritative Truth lives in the
harness-side extension process; the `context` hook is local and fail-open), [ADR 0022](0022-conductor-contract-v2.md),
[ADR 0024](0024-single-controller-and-stable-door.md) (the door URL `/accordion` prints).
**Contract:** [`docs/sidecar-protocol.md`](../sidecar-protocol.md).

## Context

Accordion has only ever attached to **pi**: `extension/accordion.ts` is a pi extension and the
whole product (Truth, wire protocol v22, registry, door, conductors, `unfold`/`recall`) sits
behind pi's `ExtensionAPI`. The owner wants Accordion on **mistral-vibe** (Python/Textual CLI,
Apache-2.0, closed to code contributions, ~2.4 squash-merged releases a week).

Investigation (2026-08-22) established:

- vibe exposes no per-model-call rewrite hook, but `AgentLoop._messages_for_backend`
  (`vibe/core/agent_loop/_loop.py`, sync, touched in 3/82 releases) is a complete pre-model-call
  seam, and `AgentLoop` is constructed in one place (`app_server/_runtime.py`).
- `accordion.ts` touches pi through a tiny surface: 11 `pi.on` hooks, `registerTool/Command/Flag`,
  `getFlag`, `appendEntry`, and `ctx.ui.notify/setStatus/theme`, `ctx.model`, `ctx.getContextUsage`
  — exactly what `extension/smoke.mjs` already fakes in ~15 lines. Nothing in `core/` or the app
  depends on pi.
- vibe's `LLMMessage.message_id` (auto-uuid) gives durable block ids; vibe messages have no
  timestamps, which is what `blockId()` keyed user/assistant ids off.

Alternatives weighed: an OpenAI-compatible **gateway proxy** (harness-agnostic, but needs a
content-hash id scheme, a wire-dialect layer, request classification, and cannot add a slash
command); a **Python port** of `core/` (a second source of truth — rejected); a broad fork of vibe
with a TUI widget (perpetual rebase against high-churn `app.py` — rejected).

## Decision

1. **A generic sidecar host** (`extension/sidecar.ts` → `extension/dist/sidecar.mjs`): a Node
   process that presents the shim `pi`/`ctx` surface to an unchanged `accordionLive()` and is
   driven over stdin/stdout JSON-lines by the host harness. The harness is vibe-native on the wire;
   the sidecar converts `LLMMessage` ⇄ `PiMessage` (system message → bolted system prompt; assistant
   `reasoning_content` is a foldable thinking part only when `reasoning_payloads` is null; tool →
   `toolResult`) and back-converts `context` results onto the original LLMMessage JSON by source
   index so vibe-only fields survive untouched. The design is deliberately pi-hook-shaped so the
   harness side is "pi-extension compatible" for every hook it can emit cheaply.
2. **`core/wire.ts`:** `PiMessage.messageId?` is preferred over `timestamp` in `blockId()`
   (`u:<messageId>`, assistant anchor `responseId → messageId → timestamp`). Additive; pi ids
   unchanged.
3. **The fork** (`a-Fig/mistral-vibe`, branch `accordion`, pinned at v2.24.3 for now): a ~20-line
   in-tree diff (one-line `AgentLoop` factory swap + a generic extension-command entry so the
   sidecar's `ready.commands` appear as slash commands, giving `/accordion`) plus a new top-level
   `accordion_vibe/` package: `AgentLoop` subclass overriding `_messages_for_backend` (blocking
   sidecar `context` call, 250 ms timeout → passthrough), `_setup_middleware` (drop
   `AutoCompactMiddleware` while Accordion folding is on), event forwarding, `unfold`/`recall` as
   native `BaseTool`s, sidecar process management. Activated only by `ACCORDION_HOME` / `[accordion]
   home`; otherwise upstream behavior.
4. **Project layout (owner's machine):** one folder `…/vibe-accordion/` holding `accordion/` (this
   repo, worktree on branch `vibe`) and `mistral-vibe/` (the fork). Dependency points fork →
   Accordion only; the stdio protocol is the sole contract.

## Consequences

- One bounded IPC hop on the model-call path in vibe (ADR 0021's "no IPC" holds for pi; for vibe
  the hop is local, ~8 ms, and fail-open — `hookErrors` counts timeouts). A push-cache (sidecar
  pushes the substitution map, Python applies locally) stays available as a later optimization.
- Conductor `complete()` has no provider inside the sidecar until a relay to vibe's backend lands;
  LLM-backed conductors are display-only on vibe until then (doorman works).
- Stranger-installable packaging (bundled sidecar + UI in the wheel / npm) is deferred; day-1
  requires Node 22+ and both checkouts.
- Pi hooks the fork does not bridge are listed in the fork's `accordion_vibe/README.md`.
