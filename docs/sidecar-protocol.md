# Sidecar protocol v1 — pi-extension host over stdio

**Status:** draft, implemented by `extension/sidecar.ts` (Accordion, TS) and `accordion_vibe/` (the
mistral-vibe fork, Python). This file is the single contract both sides build against. Bump `v`
on any breaking change.

## What this is

The **sidecar** is a Node process that hosts pi extensions for a harness that is *not* pi. It
exposes a shim `pi` object (`on` / `registerTool` / `registerCommand` / `registerFlag` / `getFlag` /
`appendEntry`) and a shim `ctx` (`ui.notify` / `ui.setStatus` / `ui.theme` / `model` /
`getContextUsage` / `getSystemPrompt` / `sessionManager.buildSessionContext` / `modelRegistry`) —
the exact surface `extension/accordion.ts` already consumes and
`extension/smoke.mjs:79-93` already fakes — and drives them from JSON-lines the host harness
writes to its stdin. Accordion is the first (and for now only) extension it loads; the design is
generic so the harness ends up "pi-hook compatible" for the hooks it can cheaply emit.

The host harness (mistral-vibe fork) is **vibe-native on the wire**: it sends vibe's own
`LLMMessage` JSON, never pi message shapes. **All conversion vibe↔pi happens in the sidecar**
(see "Conversion"), so a pi extension inside the sidecar sees pi shapes and the Python side never
learns pi's types.

## Transport

- Spawn: `node <ACCORDION_HOME>/extension/sidecar.mjs` (cwd = the harness session cwd).
  - The bundle is a **generated, gitignored, repo-checkout-only** artifact (like
    `conductors/ws/*/…-sdk.mjs`, and deliberately NOT in the npm tarball). Build it once with
    `npm --prefix extension run build:sidecar`; `npm --prefix extension run build` also emits it.
  - It sits **next to `accordion.js`**, not in `dist/`, and must stay there: `accordion.ts`
    resolves the desktop-app binary, the browser-served client root (`dist/client` /
    `../app/build`), its skill directories, and the out-of-process conductor runners
    (`../conductors/ws`) relative to `import.meta.url`. One directory deeper breaks all four —
    most visibly, no browser UI.
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
| `hello` | `v:1, harness:"vibe", harnessVersion, sessionId, cwd, sessionFile?, model:{id, provider, contextWindow}, flags?:{[name]:value}` | First message. `sessionFile` = path of vibe's `messages.jsonl` if known (used for the registry entry only). `cwd` is best-effort `chdir`'d before `session_start`, since `accordion.ts` captures `process.cwd()` for its registry entry. `sessionId` is **informational**: the extension mints its own (`s-<pid>-<ms>`) and the registry entry's `title` is `accordion.ts`'s hardcoded `"pi session"` — `SessionEntry` (`app/src/lib/live/registry.ts`) has no harness/kind field to label, and adding one is an app change this bridge deliberately does not make. |
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
| `usage` (not a pi hook) | `promptTokens, completionTokens, contextWindow` | — ; backs `ctx.getContextUsage()` and token calibration. **Ordering matters for calibration:** the sidecar arms a pairing window on `usage` and closes it at the next `context` request, so a `usage` message is attached to the assistant `message_end` that follows it (as pi's own `message.usage`, feeding ADR 0025's `k = real/est`). Send `usage` **after** the model call and **before** that message's `message_end`; sent anywhere else it still backs `getContextUsage()` but contributes no calibration. `promptTokens` is taken as the provider's real INPUT count (`input`); `completionTokens` as `output`, which the pairing deliberately excludes. |

Anything in pi's hook list that is **not** in this table is out of scope for v1 (the fork's README
lists them as not bridged).

### Extension-registered things

| type | fields | sidecar reply |
|---|---|---|
| `tool` | `req, name, args:object, toolCallId?` | `tool_result{req, content:string, isError:boolean}` — invokes a tool the extension registered (announced in `ready.tools`). `toolCallId` is optional; the sidecar synthesizes `sidecar-<req>` when it is absent. An unknown `name` answers `isError:true` rather than hanging. The tool's `{content:[{type:"text",text}], …}` result is flattened to one `\n`-joined string. |
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
| `folding` | `enabled:boolean` | whenever Accordion's folding toggle changes; the harness swaps its own compaction middleware off while `true`. Emitted **once unconditionally right after `ready`** with `enabled:false` (the arm is off at birth and the underlying seam only fires on a real transition), then on every change. Sourced from `RuntimeDependencies.onFoldingChanged` — a small additive seam in `accordion.ts`, because the sidecar is not a WebSocket client and the existing `folding` broadcast never reaches it. |
| `append_entry` | `entry:object` | from `pi.appendEntry`; the harness may persist or ignore |

## Conversion (sidecar-internal)

`LLMMessage` (vibe, `vibe/core/types.py`) → `PiMessage` (`core/wire.ts`):

- `system` → **not** a PiMessage; passed as the system prompt (`Truth.setSystemPrompt` path). On the way back it is re-inserted at index 0, byte-identical (the bolted block).
- `user` → `{ role:"user", content:text, messageId:message_id }` (`Content` may be a string or a list of chunks — concatenate text chunks; images are dropped from the **view**, never from the wire).
- `assistant` → `{ role:"assistant", content:[ thinking?, text?, toolCall* ], responseId:message_id, messageId:message_id }` where `thinking` = `reasoning_content` **only when `reasoning_payloads` is null** (payload-bearing reasoning is provider-opaque and is never represented, hence never folded); `toolCall` parts carry `{ id: tool_calls[i].id, name, arguments }`.
- `tool` → `{ role:"toolResult", toolCallId:tool_call_id, toolName:name, content:text, isError }`.
  `isError` is read from `is_error` (falling back to `isError`); if vibe carries neither, it is
  `false` — the flag is display/fingerprint metadata only and never affects foldability.
- `context_boundary:"compaction"` messages are passed through as ordinary `user` messages. So is
  **any unrecognized role** — nothing is ever silently dropped from the view except `system`
  (which becomes the prompt) and an assistant message with no thinking, no text and no tool calls
  (which emits no wire content at all).
- `session_start.messages` and `context.messages` are converted the same way; `session_start` also
  seeds `ctx.sessionManager.buildSessionContext()`, which is where `accordion.ts` reads a resumed
  session's history from. `agent_end` / `message_end` payloads are converted too, but never
  tagged — they only ever flow inward.

Back-conversion for `hook_result{messages}`: the sidecar tags each converted PiMessage with its
source index; for every returned message that still carries a tag it emits the **original
LLMMessage JSON** with only `content` (and, for a folded `thinking` part, `reasoning_content`)
overwritten — and only when that text **actually changed**, so an untouched message keeps its
exact original `content` value, chunk lists and images included. A returned message without a tag
(a recap the wire inserted) becomes a minimal `{ role, content }` LLMMessage. The harness
validates each entry with `LLMMessage.model_validate`. This keeps every vibe-only field (images,
`reasoning_payloads`, `user_display_content`, `tool_result`, …) exactly as it was.

> **Deviation from the original draft** (`{ role:"user", content }` for every insert): the insert
> keeps **its own role**, mapped to `assistant`/`user`. `core/wire.ts applyPlan` chooses that role
> deliberately — its role-validity floor exists to stop a collapse producing a leading non-`user`
> message or two adjacent same-role survivors, and forcing every insert to `user` would
> re-introduce exactly that. In the common case (a run starting on a non-assistant message) the
> emitted role is `user` anyway, so the two rules agree.

The tag is an ordinary enumerable own property (`__accordionSrcIndex`), which is what makes this
work: `applyPlan` passes untouched messages through **by reference** and clones folded ones with
object spread (`{ ...m, content }`), so the tag survives both; only the synthetic messages a group
collapse *inserts* are built fresh, and those are precisely the ones that must not map back.

Block ids: `core/wire.ts blockId()` prefers `messageId` over `timestamp`
(`u:<messageId>`, `a:<messageId>:p<i>`, `r:<toolCallId>`), so vibe sessions get durable ids from
`message_id` without timestamps; pi messages have no `messageId` and are unaffected.

## Failure semantics (the harness side MUST honor)

- No `ACCORDION_HOME` (and no `[accordion] home` in config) ⇒ the bridge is inert; upstream behavior.
- Sidecar spawn failure / no `ready` / crash / `context` timeout ⇒ passthrough + a one-time status
  note; never an exception on the model-call path.
- `context` is the only hook that blocks the harness; everything else is fire-and-forget writes.

## Not bridged in v1

- **Conductor `complete()`** — Accordion's out-of-band model call (`ConductorHost.complete`, used by
  `compaction-naive` / `handoff` / `triptych` / thermocline's summarizer). The sidecar's `ctx`
  shim declines credential resolution, so a conductor that asks gets a clear
  `could not resolve API key: the Accordion sidecar does not relay conductor completions` rather
  than a crash. The **in-process** conductor `doorman` (no completions, no credentials) and any
  purely structural strategy work fine today. Wiring this needs a `complete` request/response pair
  over stdio (the harness owns the provider credentials), or `RuntimeDependencies.complete`
  pointed at a sidecar-side client.
- **Per-message `usage` inside `agent_end`** — only the dedicated `usage` message feeds calibration
  (see its row above).
- **`message_update` stream frames** — the hook is dispatched, but `accordion.ts` reads only
  `event.assistantMessageEvent` (pi's token-level lifecycle frames), which vibe does not emit; the
  GUI's "ghost" pulse is therefore inert under the sidecar. Purely presentational.
- Every pi hook absent from the tables above.
