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
  `process.stdout.write` **itself** to stderr before loading any extension (redirecting only
  `console.log`/`console.info` leaves `console.dir`/`table`/`group`, `util.debuglog` and any
  dependency writing to the stream directly still able to corrupt the channel).
- **stderr** is free-form logs.
- Every message has a string `type`. Request/response pairs correlate by an opaque string `req`
  chosen by the requester. Unknown `type`s are ignored (log to stderr), never fatal.
- **Handshake order:** `hello` is the harness's FIRST message and `ready` is the sidecar's ANSWER to
  it. Nothing is emitted before a `hello` arrives, so the harness must send `hello`, then wait up to
  5 s for `ready` before sending anything else; if `ready` never arrives it treats the sidecar as
  absent and behaves exactly like upstream vibe. A repeat `hello` is idempotent: it re-answers with
  a fresh `ready` and the **current** folding arm, and never resets session state.
- One stdin line is capped at 64 MB. A longer line is dropped with a one-time stderr warning and the
  reader resyncs at the next newline.
- Exit: harness sends `shutdown`; sidecar runs the `session_shutdown` hook and exits 0. If the
  harness's stdin closes (EOF), or the process receives `SIGTERM`/`SIGINT`/`SIGHUP`, it does the
  same — so `proc.terminate()` still tears the session down cleanly instead of leaking the
  `~/.accordion/sessions/<id>.json` registry entry. (Windows cannot deliver these signals to a Node
  process at all; there, close stdin to shut down.) If the sidecar dies, the harness notes it
  (status line) and every later hook is a no-op / passthrough.

## Harness → sidecar

### Lifecycle

| type | fields | notes |
|---|---|---|
| `hello` | `v:1, harness:"vibe", harnessVersion, sessionId, cwd, sessionFile?, model:{id, provider, contextWindow}, flags?:{[name]:value}` | First message. `sessionFile` = path of vibe's `messages.jsonl` if known (used for the registry entry only). `cwd` is best-effort `chdir`'d before `session_start`, since `accordion.ts` captures `process.cwd()` for its registry entry. `sessionId` is **informational**: the extension mints its own (`s-<pid>-<ms>`). The registry entry's `title` and `harness` fields ARE labeled: `SessionEntry.harness` (`app/src/lib/live/registry.ts`) is `"pi" | undefined` for a pi host and `"vibe"` for this bridge, and the title defaults to `` `vibe · <cwd basename>` `` — both sourced from `RuntimeDependencies.harness` (`accordion.ts`), which this file constructs from the `hello` message's (post-`chdir`) `process.cwd()`. Powers the Sessions sidebar's `pi \| vibe \| Claude Code` source switcher. |
| `shutdown` | — | see Exit. |

### pi hooks (fire-and-forget unless `req` is present)

Names and semantics mirror pi's `ExtensionEvent`s (see the "Pi extension hooks" section of
`CLAUDE.md`). Payload fields are **vibe-native**; the sidecar maps them onto pi event shapes.

| type (= pi hook name) | fields | sidecar reply |
|---|---|---|
| `session_start` | `reason:"start"\|"resume"\|"new"\|"fork", messages: LLMMessage[]` | — (seeds the Truth from `messages`) |
| `session_shutdown` | — | — |
| `session_before_compact` | `req` | `hook_result{req, cancel?:boolean}` — reserved; the harness may also send this without `req` as a notification |
| `session_compact` | `summary?: string`, **`messages?: LLMMessage[]`** | — . **Send the POST-compaction `messages`.** The extension's handler reconciles the map against the session history *and then tells the user it rebuilt to match*; with no `messages` the sidecar can only hand it the stale pre-compaction view, which would reproduce exactly the history compaction just removed. Given `messages`, the sidecar refreshes first and the rebuild is real; without them it passes an empty history, which the handler's own guard skips (notify only) and the next `context` reconciles for real. |
| `before_agent_start` | `req, prompt: string` | `hook_result{req, systemPrompt?: string}` — if set, harness uses it as `messages[0].content` for **this run only** |
| `agent_start` | — | — |
| `agent_end` | `messages: LLMMessage[]` (this run's messages) | — |
| `turn_start` | `turnIndex:number` | — |
| `turn_end` | `message: LLMMessage, toolResults: LLMMessage[]` | — |
| `message_start` | `message: LLMMessage` | — |
| `message_update` | `message: LLMMessage` (current partial) | — ; harness throttles to ≤ 10/s |
| `message_end` | `message: LLMMessage` | — |
| `context` | `req, messages: LLMMessage[], model:{id, contextWindow}` | `hook_result{req, messages: LLMMessage[] \| null}` — `null` = unchanged / passthrough. **Must answer**; the harness times out at 250 ms and passes through. A request whose `messages` is absent, not an array, or **empty** is answered `null` without touching any state: an empty array is not "a context with nothing in it", it is a malformed request, and ingesting it would read as structural divergence and rebuild the session's Truth down to nothing — destroying every fold, group and dial. (`session_start` is different: an empty array there is a legitimately fresh session.) |
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
| `ready` | `v:1, protocolVersion:number (Accordion wire), tools:[{name, description, parameters: JSONSchema}], commands:[{name, description}], flags:[{name, description, default}]` | the ANSWER to `hello`, never unsolicited; every extension's `register*` calls have run by then. A repeat `hello` re-answers idempotently. |
| `hook_result` | `req, …` | see table above |
| `tool_result` | `req, content, isError` | |
| `command_result` | `req, ok, error?` | |
| `notify` | `message:string, level:"info"\|"warning"\|"error"` | from `ctx.ui.notify` |
| `status` | `text:string` | from `ctx.ui.setStatus` |
| `folding` | `enabled:boolean` | whenever Accordion's folding toggle changes; the harness swaps its own compaction middleware off while `true`. Also emitted **immediately after every `ready`**, carrying the CURRENT arm (the underlying seam fires only on a real transition, so the state has to be restated — and a repeat `hello` mid-session must not be told `false` while folding is on). Sourced from `RuntimeDependencies.onFoldingChanged` — a small additive seam in `accordion.ts`, because the sidecar is not a WebSocket client and the existing `folding` broadcast never reaches it. |
| `append_entry` | `entry:object` | from `pi.appendEntry`; the harness may persist or ignore |

## Conversion (sidecar-internal)

`LLMMessage` (vibe, `vibe/core/types.py`) → `PiMessage` (`core/wire.ts`):

- **the LEADING `system` message (source index 0 only)** → **not** a PiMessage; passed as the system prompt (`Truth.setSystemPrompt` path). On the way back it is re-inserted at index 0, byte-identical (the bolted block). A `Truth` holds exactly ONE system block, so a system message anywhere else is ordinary content and rides the passthrough rule below — never hoisted to index 0, never overwriting the prompt.
- `user` → `{ role:"user", content:text, messageId:message_id }` (`Content` may be a string or a list of chunks — concatenate text chunks; images are dropped from the **view**, never from the wire).
- `assistant` → `{ role:"assistant", content:[ thinking?, text?, toolCall* ], responseId:message_id, messageId:message_id }` where `thinking` = `reasoning_content` **only when `reasoning_payloads` is null** (payload-bearing reasoning is provider-opaque and is never represented, hence never folded); `toolCall` parts carry `{ id: tool_calls[i].id, name, arguments }`.
- `tool` → `{ role:"toolResult", toolCallId:tool_call_id, toolName:name, content:text, isError }`.
  `isError` is read from `is_error` (falling back to `isError`); if vibe carries neither, it is
  `false` — the flag is display/fingerprint metadata only and never affects foldability.
- `context_boundary:"compaction"` messages are passed through as ordinary `user` messages, as is
  **any unrecognized role**.
- `session_start.messages` and `context.messages` are converted the same way; `session_start` also
  seeds `ctx.sessionManager.buildSessionContext()`, which is where `accordion.ts` reads a resumed
  session's history from. `agent_end` / `message_end` payloads are converted too, but never
  tagged — they only ever flow inward.

### The passthrough rule — no message is ever deleted

Some messages carry nothing Accordion can model as blocks. **They are never dropped:** the sidecar
records them as *passthrough* slots and `fromPi` re-emits the ORIGINAL JSON at its original position.
Because such a message contributes no blocks, no fold or group op can ever target it, so passing it
straight through is exactly correct. The cases:

| shape | why it cannot be represented |
|---|---|
| an assistant turn with empty content, payload-bearing reasoning only, non-text-only chunks, or an aborted empty turn | nothing maps to a `text`/`thinking`/`toolCall` part |
| a `system` message that is **not** at index 0 | a `Truth` has exactly one system block |
| an assistant turn carrying a `tool_call` with **no `id`** | `core/wire.ts messageInfo` records a call only for a non-empty id, so an id-less call is invisible to the tool-pair fixpoint — a group drop could then remove the call while orphaning its `tool` result. Keeping the whole message off the block set keeps it off the removable set |
| a `tool` message repeating an already-seen `tool_call_id` | both would map to block id `r:<id>`: `Truth.append` keeps one while `applyPlan` folds BOTH, silently overwriting one body with the other's digest |

A repeated **`message_id`** on a user/assistant message is handled differently, because the message
itself is perfectly representable: the anchor is **suppressed** (no `messageId`, no `responseId`), so
`blockId` falls back to its positional `m<i>:…` form, which `isDurableId` rejects and `canFold`
therefore refuses. The duplicate stays fully visible in the map — just unfoldable, rather than
mis-foldable. (A tool message's duplicate `message_id` is harmless: its block id comes from
`tool_call_id`.)

The upshot, and the single invariant worth testing on the Python side:
**`len(reply) == len(request)` unless Accordion deliberately collapsed a group.**

Back-conversion for `hook_result{messages}`: the sidecar tags each converted PiMessage with its
source index; for every returned message that still carries a tag it emits the **original
LLMMessage JSON** with only `content` (and, for a folded `thinking` part, `reasoning_content`)
overwritten — and only when that text **actually changed**, so an untouched message keeps its
exact original `content` value, chunk lists and images included. Passthrough slots (above) are
re-interleaved at their source positions as it goes. A returned message without a tag
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

## Known limitations

- **A cleared system prompt leaves an EMPTY bolted block, not no block.** When a conversion finds no
  leading `system` message, `ctx.getSystemPrompt()` returns `""` so `Truth.setSystemPrompt("", 0)`
  drops the stale text and zeroes its tokens — without this the previously captured prompt would
  stand forever and keep counting against the budget. `Truth` has no remove-the-block path, though,
  so the map shows a zero-token empty `system` tile rather than the "silent absence" CLAUDE.md
  describes. Fixing it properly means a `Truth.clearSystemPrompt`, which is a core change this
  bridge deliberately does not make.
- **Images and other non-text content chunks are dropped from the VIEW** (never from the wire — the
  original `content` is preserved verbatim unless folding actually changed the text). So a message
  carrying images is under-counted in Accordion's token accounting; provider-side token calibration
  (the `usage` message) absorbs the difference into `k` rather than attributing it per block.
- **`ctx.getContextUsage()` reports the LAST `usage` report**, i.e. the previous model call, not the
  one being assembled. It feeds the registry entry's display `tokens` field only; every folding and
  budget decision runs off `Truth`'s own accounting, so the lag is cosmetic.
- **A passthrough message re-interleaved into a collapsed range** (see the passthrough rule) can in
  principle sit between two same-role survivors, which `applyPlan`'s role-validity floor would have
  prevented had it known about the message. Keeping it is still strictly better than deleting real
  content, and the shapes involved (payload-only reasoning, id-less tool calls) are rare.

## Harness notes — the mistral-vibe fork (`accordion_vibe/`)

Decisions the Python side made where the spec left room. Each is a fact the sidecar can rely on,
not a request for the sidecar to change.

**Spawn / handshake**

- Command is `node <ACCORDION_HOME>/extension/sidecar.mjs`, with `<home>/extension/dist/sidecar.mjs`
  accepted as a fallback so a local build that still emits into `dist/` keeps working.
- `hello.model` is always sent. vibe has **no declared provider context window**, so
  `contextWindow` is the active model's `auto_compact_threshold` — the number every other vibe
  surface already treats as the window (`_runtime.py` builds its own `RuntimeSnapshot` from it).
  The same value rides `context.model` and `model_select.model`.
- `context.model` carries `provider` as well as `id`/`contextWindow` (a superset of the table).
- `hello.flags` carries `accordion-app` only when the user configured one (`ACCORDION_APP`, or
  `[accordion] app` in vibe's config); it is omitted rather than sent as `null`.
- `hello.sessionFile` is `<session_dir>/messages.jsonl` when the session logger has a directory.

**Hook payload shapes**

- `session_start.reason` is always `"start"` in v1. Resume / new / fork are decided in the
  app-server's session intent, which `AgentLoop` never sees; the bridge attaches per `AgentLoop`,
  so a fork or resume produces a *new sidecar* rather than a different `reason`.
- `agent_end.messages` is every message appended during that `act()` call, the triggering user
  message included.
- `turn_end.message` is the first assistant message the turn produced; `toolResults` is that
  turn's `role:"tool"` messages. A turn that produced no assistant message emits nothing.
- `message_start` / `message_end`: vibe has no per-message notification, so the bridge diffs its
  message log at turn and run boundaries. A **streamed** assistant message gets a real
  `message_start` on the first chunk followed by throttled `message_update`s; every other message
  (user, tool, non-streamed assistant) gets a degenerate `message_start` immediately before its
  `message_end`. Ordering within a turn is still log order.
- `tool_execution_end.result` is the tool's own result model serialized as JSON (vibe's
  human-readable rendering happens after this point and is not reachable from the emission site).
- `usage` is emitted **only for the main agent completion**. vibe routes title generation,
  compaction summaries and teleport summaries through the same accounting, and letting those
  usages into the pairing window would poison the calibration anchor. The discriminator is object
  identity — `messages is self.messages` — which also gates the `context` hook itself.
- `session_before_compact` is sent in the **notification** form (no `req`); the harness never
  cancels its own compaction from the sidecar's answer. The matching `session_compact` carries the
  full POST-compaction `messages`.
- A `context` whose message list would be **empty** is never sent: it is malformed on the wire and
  would be answered `null` anyway, so the harness skips the round trip and passes through.
- Outbound lines are refused above the sidecar's **64 MB** cap rather than written and silently
  dropped; the affected `context` then times out into a normal passthrough.

**Replies the harness reads**

- `tool_result`'s error flag is read as `is_error` first, then `isError`.
- `resources_discover`'s `skillPaths` ARE applied, on the first `act()`. One adaptation: pi hands
  back each **skill directory** (`.../extension/skills/accordion-context-folding`), while vibe's
  `SkillManager` searches a directory for `<child>/SKILL.md`, so each returned path whose own
  `SKILL.md` exists is lifted to its parent before being added. `promptPaths` and `themePaths` are
  ignored: vibe has no equivalent runtime list to extend.
- A `hook_result{messages}` that is not a list, that is **longer than the request** (Accordion may
  collapse a group, so shorter is legal and longer is not a rewrite of what was sent), or whose
  entries fail `LLMMessage.model_validate`, is treated exactly like a timeout: passthrough plus a
  counter bump.

**Not emitted by this harness**

- `tool_call` and `tool_result` (pi's mutable pre/post-tool hooks). vibe's pre-tool path is a
  multi-stage pipeline in `AgentLoopHooksMixin` — rewrite re-validation, denial synthesis,
  permission re-check — and honoring `block`/`args` correctly means reproducing it.
  `tool_execution_start`/`_end` already carry the observable outcome.
- `tool_execution_update`. vibe streams partial tool output as `ToolStreamEvent`s; forwarding
  every one is a high-rate hook with no consumer.

**Tools**

- `unfold` and `recall` are hand-written `BaseTool`s with `{codes: string[]}`, registered on the
  session's `ToolManager` only while the bridge is attached. `ready.tools` schemas are **not**
  turned into tools dynamically; a name the harness does not implement logs a warning.
- Every relayed `tool` message carries vibe's own `toolCallId`.
