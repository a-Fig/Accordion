# Sidecar protocol v1 — pi-extension host over stdio

**Status:** draft, implemented by `extension/sidecar.ts` (Accordion, TS) and `accordion_vibe/` (the
mistral-vibe fork, Python). This file is the single contract both sides build against. Bump `v`
on any breaking change.

## What this is

The **sidecar** is a Node process that hosts pi extensions for a harness that is *not* pi. It
exposes a shim `pi` object (`on` / `registerTool` / `registerCommand` / `registerFlag` / `getFlag` /
`appendEntry`) and a shim `ctx` (`ui.notify` / `ui.setStatus` / `ui.theme` / `model` /
`getContextUsage`) — the exact surface `extension/accordion.ts` already consumes and
`extension/smoke.mjs:79-93` already fakes — and drives them from JSON-lines the host harness
writes to its stdin. Accordion is the first (and for now only) extension it loads; the design is
generic so the harness ends up "pi-hook compatible" for the hooks it can cheaply emit.

The host harness (mistral-vibe fork) is **vibe-native on the wire**: it sends vibe's own
`LLMMessage` JSON, never pi message shapes. **All conversion vibe↔pi happens in the sidecar**
(see "Conversion"), so a pi extension inside the sidecar sees pi shapes and the Python side never
learns pi's types.

## Transport

- Spawn: `node <ACCORDION_HOME>/extension/dist/sidecar.mjs` (cwd = the harness session cwd).
- **stdin / stdout** carry the protocol: UTF-8, one JSON object per line, `\n`-terminated, no
  framing beyond that. **Nothing else may ever be written to stdout** — the sidecar must redirect
  `console.log`/`console.info` to stderr before loading any extension.
- **stderr** is free-form logs.
- Every message has a string `type`. Request/response pairs correlate by an opaque string `req`
  chosen by the requester. Unknown `type`s are ignored (log to stderr), never fatal.
- The harness must wait for `ready` (≤ 5 s) before sending anything else; if `ready` never
  arrives it treats the sidecar as absent and behaves exactly like upstream vibe.
- Exit: harness sends `shutdown`; sidecar runs the `session_shutdown` hook and exits 0. If the
  harness's stdin closes (EOF) the sidecar does the same. If the sidecar dies, the harness
  notes it (status line) and every later hook is a no-op / passthrough.

## Harness → sidecar

### Lifecycle

| type | fields | notes |
|---|---|---|
| `hello` | `v:1, harness:"vibe", harnessVersion, sessionId, cwd, sessionFile?, model:{id, provider, contextWindow}, flags?:{[name]:value}` | First message. `sessionFile` = path of vibe's `messages.jsonl` if known (used for the registry entry only). |
| `shutdown` | — | see Exit. |

### pi hooks (fire-and-forget unless `req` is present)

Names and semantics mirror pi's `ExtensionEvent`s (see the "Pi extension hooks" section of
`CLAUDE.md`). Payload fields are **vibe-native**; the sidecar maps them onto pi event shapes.

| type (= pi hook name) | fields | sidecar reply |
|---|---|---|
| `session_start` | `reason:"start"\|"resume"\|"new"\|"fork", messages: LLMMessage[]` | — (seeds the Truth from `messages`) |
| `session_shutdown` | — | — |
| `session_before_compact` | `req` | `hook_result{req, cancel?:boolean}` — reserved; the harness may also send this without `req` as a notification |
| `session_compact` | `summary?: string` | — (sidecar rebuilds the Truth on the next `context`) |
| `before_agent_start` | `req, prompt: string` | `hook_result{req, systemPrompt?: string}` — if set, harness uses it as `messages[0].content` for **this run only** |
| `agent_start` | — | — |
| `agent_end` | `messages: LLMMessage[]` (this run's messages) | — |
| `turn_start` | `turnIndex:number` | — |
| `turn_end` | `message: LLMMessage, toolResults: LLMMessage[]` | — |
| `message_start` | `message: LLMMessage` | — |
| `message_update` | `message: LLMMessage` (current partial) | — ; harness throttles to ≤ 10/s |
| `message_end` | `message: LLMMessage` | — |
| `context` | `req, messages: LLMMessage[], model:{id, contextWindow}` | `hook_result{req, messages: LLMMessage[] \| null}` — `null` = unchanged / passthrough. **Must answer**; the harness times out at 250 ms and passes through. |
| `tool_execution_start` | `toolCallId, toolName, args` | — |
| `tool_execution_end` | `toolCallId, toolName, result?:string, isError:boolean` | — |
| `tool_call` | `req, toolCallId, toolName, args` | `hook_result{req, block?:boolean, reason?:string, args?:object}` — only if the harness can honor it cheaply; otherwise not emitted |
| `model_select` | `model:{id, provider, contextWindow}, previous?:{…}, source:"select"\|"restore"` | — |
| `resources_discover` | `req` | `hook_result{req, skillPaths:string[], promptPaths:string[], themePaths:string[]}` |
| `usage` (not a pi hook) | `promptTokens, completionTokens, contextWindow` | — ; backs `ctx.getContextUsage()` and token calibration |

Anything in pi's hook list that is **not** in this table is out of scope for v1 (the fork's README
lists them as not bridged).

### Extension-registered things

| type | fields | sidecar reply |
|---|---|---|
| `tool` | `req, name, args:object` | `tool_result{req, content:string, isError:boolean}` — invokes a tool the extension registered (announced in `ready.tools`) |
| `command` | `req, name, args?:string` | `command_result{req, ok:boolean, error?:string}` — invokes a slash command the extension registered (announced in `ready.commands`). Any `ctx.ui.notify` during the handler arrives as `notify` messages before the result. |

## Sidecar → harness

| type | fields | notes |
|---|---|---|
| `ready` | `v:1, protocolVersion:number (Accordion wire), tools:[{name, description, parameters: JSONSchema}], commands:[{name, description}], flags:[{name, description, default}]` | sent once after every extension's `register*` calls ran |
| `hook_result` | `req, …` | see table above |
| `tool_result` | `req, content, isError` | |
| `command_result` | `req, ok, error?` | |
| `notify` | `message:string, level:"info"\|"warning"\|"error"` | from `ctx.ui.notify` |
| `status` | `text:string` | from `ctx.ui.setStatus` |
| `folding` | `enabled:boolean` | whenever Accordion's folding toggle changes; the harness swaps its own compaction middleware off while `true` |
| `append_entry` | `entry:object` | from `pi.appendEntry`; the harness may persist or ignore |

## Conversion (sidecar-internal)

`LLMMessage` (vibe, `vibe/core/types.py`) → `PiMessage` (`core/wire.ts`):

- `system` → **not** a PiMessage; passed as the system prompt (`Truth.setSystemPrompt` path). On the way back it is re-inserted at index 0, byte-identical (the bolted block).
- `user` → `{ role:"user", content:text, messageId:message_id }` (`Content` may be a string or a list of chunks — concatenate text chunks; images are dropped from the **view**, never from the wire).
- `assistant` → `{ role:"assistant", content:[ thinking?, text?, toolCall* ], responseId:message_id, messageId:message_id }` where `thinking` = `reasoning_content` **only when `reasoning_payloads` is null** (payload-bearing reasoning is provider-opaque and is never represented, hence never folded); `toolCall` parts carry `{ id: tool_calls[i].id, name, arguments }`.
- `tool` → `{ role:"toolResult", toolCallId:tool_call_id, toolName:name, content:text, isError }`.
- `context_boundary:"compaction"` messages are passed through as ordinary `user` messages.

Back-conversion for `hook_result{messages}`: the sidecar tags each converted PiMessage with its
source index; for every returned message that still carries a tag it emits the **original
LLMMessage JSON** with only `content` (and, for a folded `thinking` part, `reasoning_content`)
overwritten; a returned message without a tag (a recap the wire inserted) becomes a minimal
`{ role:"user", content }` LLMMessage. The harness validates each entry with
`LLMMessage.model_validate`. This keeps every vibe-only field (images, `reasoning_payloads`,
`user_display_content`, `tool_result`, …) exactly as it was.

Block ids: `core/wire.ts blockId()` prefers `messageId` over `timestamp`
(`u:<messageId>`, `a:<messageId>:p<i>`, `r:<toolCallId>`), so vibe sessions get durable ids from
`message_id` without timestamps; pi messages have no `messageId` and are unaffected.

## Failure semantics (the harness side MUST honor)

- No `ACCORDION_HOME` (and no `[accordion] home` in config) ⇒ the bridge is inert; upstream behavior.
- Sidecar spawn failure / no `ready` / crash / `context` timeout ⇒ passthrough + a one-time status
  note; never an exception on the model-call path.
- `context` is the only hook that blocks the harness; everything else is fire-and-forget writes.
