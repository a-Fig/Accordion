# Writing a Conductor — developer reference

A **conductor** is an interchangeable context-management strategy for Accordion. Between
turns it reads the agent's context and decides what to fold, replace, group, restore, or
pin — keeping the live context useful and within budget. Accordion ships one (the built-in
budget folder); this document is for writing your own.

Conductors are **first-party** — every one lives in this repo (or a fork). There is no
sandbox or trust boundary; the contract exists to make a conductor cheap to write, with the
built-in as the worked example. The host enforces one floor (provider-validity) plus two
guardrails (human overrides win; unsafe commands are clamped and reported) — these stop a
*bug* from corrupting the session or fighting the human, not an adversary.

The design and rationale are in [ADR 0007](adr/0007-conductor-protocol.md), refined by
[ADR 0008](adr/0008-conductor-first-party-one-view.md). The contract is defined in two files
you can read or copy from directly:

- `conductors/contract/conductor.ts` — the in-process shape (`ConductorView`, the `Command`
  union, `ClampReport`, the `Conductor` interface). **This is the primary surface.**
- `conductors/contract/protocol.ts` — the WebSocket messages (the escape hatch), which
  *import* `Command` / `ClampReport` / `ViewBlock` from the contract so there is one
  definition, not two.

---

# Part 1 — The in-process contract (the main way)

The whole contract is one pure idea:

```ts
conduct(view: ConductorView): Command[] | null
```

The easiest conductor is a TypeScript class implementing this method, dropped in
`conductors/<name>/` and registered with one line in `conductors/index.ts`
(`IN_PROCESS_CONDUCTORS`). It then appears in the header switcher and is selectable per
session. The built-in (`conductors/builtin/builtin.ts`) is a ~15-line example of exactly
this; read it to see the surface in action. (For the step-by-step + a minimal example, see
[`conductors/README.md`](../conductors/README.md).)

## The view you receive — `ConductorView`

`conduct()` is handed a read-only `ConductorView`: pure, serializable data the host owns.
Treat everything in it as immutable.

| field                | type           | meaning                                                                                  |
|----------------------|----------------|------------------------------------------------------------------------------------------|
| `blocks`             | `ViewBlock[]`  | every block, in conversation order — your whole field of view                            |
| `budget`             | number         | token budget for the live context window                                                 |
| `contextWindow`      | number \| null | the model's total context window as reported by the host, or `null` if unknown           |
| `liveTokens`         | number         | live token cost at the moment the view is built — **the baseline you fold down from**     |
| `protectedFromIndex` | number         | index of the first block in the host's protected working tail (`blocks.length` ⇒ no tail) |
| `protectTokens`      | number         | the protected-tail token target driving `protectedFromIndex`                              |

`liveTokens` already reflects the human's overrides and any folded groups but **no conductor
folds** — the host clears the previous conductor pass before building the view, so it is a
clean baseline. `protectedFromIndex` / `protectTokens` surface the host's protected working
tail as *policy*: you may honour it (the built-in treats it as a hard "don't fold past here"
line) or ignore it, but folding into the tail may be reverted by host healing.

A **`ViewBlock`** is one block as every conductor sees it — identical in-process and on the
wire:

| field          | type     | notes                                                                            |
|----------------|----------|----------------------------------------------------------------------------------|
| `id`           | string   | durable block id — what every command references                                 |
| `kind`         | string   | `user` · `text` · `thinking` · `tool_call` · `tool_result`                       |
| `turn`         | number   | 1-based user turn                                                                 |
| `order`        | number   | global 0-based position in the conversation                                      |
| `tokens`       | number   | full token cost at full fidelity                                                 |
| `foldedTokens` | number   | token cost **if folded** — the digest size for a foldable kind, or full `tokens` for a non-foldable kind (which can't shrink) — precomputed so you needn't estimate |
| `toolName`     | string?  | for `tool_call` / `tool_result`                                                  |
| `callId`       | string?  | pairing key (a call and its result share it)                                     |
| `isError`      | boolean? | tool-result error flag                                                            |
| `held`         | boolean  | a human override (pin / manual fold / manual unfold) owns this block             |
| `folded`       | boolean  | currently rendered folded in the view                                            |
| `protected`    | boolean  | inside the host's protected working tail                                         |
| `grouped`      | boolean  | member of a folded group (the host owns it)                                      |
| `text`         | string?  | full content (in-process always; on the wire under `wants:"full"`)               |
| `preview`      | string?  | one-line taste (on the wire under `wants:"shape"` / `"onDemand"`)                |

The four booleans fold the host's policy into plain flags so you never call an engine
helper: skip a block when `held`, `protected`, or `grouped`, and read `foldedTokens` for the
saving a fold would buy.

## What you return — the command set

`conduct()` returns one of:

- **`Command[]`** — your *complete desired state*. The host resets to the raw baseline and
  applies the whole batch, so to change one block you re-send your whole intention.
- **`[]`** — explicitly clear to raw (nothing folded).
- **`null`** — *hold*: the host keeps the last applied state untouched. Used by an async
  (remote) conductor still thinking; it must never block a model call. (An in-process
  conductor is synchronous and normally always has a definite answer — the built-in never
  returns `null`.)

Every command is **content substitution, never structural removal** — a block is never
spliced out, only its content changes. That is what guarantees a `tool_call`/`tool_result`
pair can never orphan.

| command   | shape                                | effect                                                                 |
|-----------|--------------------------------------|------------------------------------------------------------------------|
| `fold`    | `{ kind:"fold", ids, digest? }`      | Collapse blocks to a digest. No `digest` → the host's per-kind digest + the `{#code FOLDED}` agent-recovery tag. A `digest` string → exactly that text is shown and the agent receives it. |
| `replace` | `{ kind:"replace", id, content }`    | Substitute a block's content with arbitrary text. The block stays in place (pairing intact). `content: ""` means "shrink to nothing": an empty content part can't be sent on the wire, so the host folds the block to its `{#code FOLDED}` digest (the smallest wire-safe form), so the view matches what the agent receives. Only `text`/`thinking`/`tool_result` fold. |
| `group`   | `{ kind:"group", ids }`              | Collapse a **contiguous** run into one summary entry (summary-on-head, the rest emptied — never removed). The group covers the run from the **first to the last** named id, snapped outward to whole messages — blocks *between* the first and last are swept in even if unnamed. For a non-contiguous set, issue one `group` per run, or empty/replace blocks individually. |
| `restore` | `{ kind:"restore", ids }`            | Return blocks to full, live content (undo a fold/replace). No-op on a human-held block. |
| `pin`     | `{ kind:"pin", ids }`                | Assert blocks stay live and open — e.g. force live a block an earlier command in the same batch folded. Never overrides a *human* pin. |

## Guardrails the host enforces (and reports)

The host clamps each command to the one floor it keeps — **provider-validity, the message
stays sendable** — and reports anything it couldn't apply verbatim. Nothing is silently
dropped; nothing throws.

- **Content substitution only.** There is no remove. `replace(id, "")` "deletes" by folding the block to its `{#code FOLDED}` digest (an empty content part can't be sent), so it still costs the digest, not zero.
- **Human-held blocks are refused.** A `fold` / `replace` / `restore` / `pin` touching a
  block the human pinned, manually folded, or manually unfolded (`held: true`) comes back as
  a `human-override` `ClampReport` and is not applied. The human always wins.
- **A `group` over a human-held block is refused wholesale** — the entire group, not just
  the held member. Re-issue the group around the held block, or leave it.
- **`group` validity.** The ids must be a contiguous, currently-ungrouped, ≥2-member run,
  entirely older than the protected tail. Otherwise: `invalid-group`.
- **Grouped members are off-limits.** A block already inside a folded group (`grouped:
  true`) is owned by the group overlay; folding it individually double-counts → a `grouped`
  report. Leave grouped blocks alone.

A **`ClampReport`** is `{ command, ids, reason, detail }`. `reason` is one of:

| reason           | meaning                                                                       |
|------------------|-------------------------------------------------------------------------------|
| `unknown-id`     | no block with that id exists (vanished in a resync, or never existed)          |
| `human-override` | a human pin / manual fold / manual unfold owns the block — the human wins      |
| `grouped`        | the block is inside a folded group; the group overlay owns it                  |
| `invalid-group`  | a `group`'s ids were not a valid contiguous, ungrouped, ≥2-member run          |
| `protected`      | the block is inside the protected working tail; protection is absolute — the host won't fold it |
| `noop`           | the command was a no-op (e.g. restoring an already-live block)                 |

In-process, `conduct()` returns and the host applies synchronously; the clamp reports are
available to the host immediately (the built-in never trips one). Out of process, they come
back as a `host/commandResult` frame (Part 2).

---

# Part 2 — Out-of-process (the WebSocket escape hatch)

Reach for the wire **only** when an in-process TypeScript class won't do: you need a
separate process, a long-running model, or a non-JS language. The contract is identical —
the same `ConductorView` in, the same `Command[]` out — just serialized to JSON over a
WebSocket. `conductors/recency-folder/` is the runnable reference.

## Topology — you host, Accordion connects

You host a WebSocket endpoint. Accordion connects to it as a **client** and dials out.
(Accordion is a webview; it cannot host a server. It is already a client to the pi
extension — this mirrors that exactly.) One JSON message per WebSocket frame; the shapes
are below. You *declare* the content fidelity you want (`wants.content`) — a bandwidth/own-
preference choice, not a security boundary, since trust is full once connected.

## How Accordion finds you

Two ways:

**1. Advertise a registry file** (local conductors — auto-discovered). Write a JSON file
at `~/.accordion/conductors/<id>.json` matching the `ConductorEntry` shape, refresh it on a
heartbeat (Accordion treats an entry older than 15 s as offline and hides it from the
conductor list — the descriptor file is not deleted), and delete it on shutdown. The fields (see `registry.ts`):

| field              | type     | meaning                                                     |
|--------------------|----------|-------------------------------------------------------------|
| `registryProtocol` | number   | must equal `1` (the `REGISTRY_PROTOCOL` constant)           |
| `conductorProtocol`| number   | the conductor wire version you speak (`2` today)            |
| `id`               | string   | stable conductor id (also the file's basename)              |
| `label`            | string   | human-facing name shown in the switcher                     |
| `url`              | string   | the `ws://` endpoint Accordion dials                        |
| `pid`              | number   | your process id (diagnostics only)                          |
| `startedAt`        | number   | epoch ms when you started                                   |
| `heartbeatAt`      | number   | epoch ms of the last refresh — the liveness signal          |

Sample `~/.accordion/conductors/recency-folder.json`:

```json
{
  "registryProtocol": 1,
  "conductorProtocol": 2,
  "id": "recency-folder",
  "label": "Recency folder",
  "url": "ws://127.0.0.1:7700",
  "pid": 48213,
  "startedAt": 1749830400000,
  "heartbeatAt": 1749830460000
}
```

Write it atomically (temp file + rename) so Accordion never reads a half-written
descriptor, and bump `heartbeatAt` every few seconds (well under the 15 s stale window).

**2. Be configured by URL** (remote conductors). The user can add your `ws://` URL by hand
in the app — no registry file needed. Use this when you run off-box or do not control the
`~/.accordion/` directory.

## Lifecycle

```
  Accordion connects  ──────────────────────────▶  (your WS server accepts)
  host/hello          ──────────────────────────▶
                      ◀──────────────────────────  conductor/hello  (declare wants.content)
  context/update rev=1 ─────────────────────────▶
                      ◀──────────────────────────  conductor/commands rev=1
  host/commandResult rev=1 (clamp reports) ──────▶
  context/update rev=2 ─────────────────────────▶
                      ◀──────────────────────────  conductor/commands rev=2
                                  ...
```

1. **Connect.** Accordion dials your endpoint and sends `host/hello` (session identity,
   budget, context window).
2. **Declare intent.** Reply with `conductor/hello` — your `id`, `label`, and the content
   fidelity you want (`wants.content`, default `"full"`).
3. **Receive context.** On every change (a block streamed in, the budget or protect tail
   moved) Accordion sends `context/update` — a full `ConductorView` payload with a monotonic
   `rev`.
4. **Reply with your complete desired state.** Send `conductor/commands` with the full
   batch of commands (not a diff) and echo the `rev` you are responding to.
5. **Read what was clamped.** Accordion replies `host/commandResult` with one
   `ClampReport` per command it could not apply verbatim.
6. **Hold by staying silent.** If you have nothing new to say, send nothing — the host
   keeps your last applied batch in force. New blocks arrive raw until you next speak.

Your commands are a **complete desired state**: Accordion resets to the raw baseline and
re-applies the whole batch each time. To change one block, re-send your whole intention.

## Message reference

All shapes are exact (from `conductors/contract/protocol.ts`). `CONDUCTOR_PROTOCOL_VERSION`
is `2`.

### host → conductor

**`host/hello`** — first frame after connect.

```json
{
  "type": "host/hello",
  "conductorProtocol": 2,
  "session": { "title": "fix the parser", "model": "google/gemini-2.5-flash-lite", "cwd": "/home/me/proj" },
  "budget": 70000,
  "contextWindow": 1000000
}
```

**`context/update`** — the context changed; the payload **is a `ConductorView`** (the same
view the in-process built-in receives) plus a monotonic `rev` to echo back. Carries the full
block list each time.

```json
{
  "type": "context/update",
  "rev": 7,
  "budget": 70000,
  "contextWindow": 1000000,
  "liveTokens": 92000,
  "protectedFromIndex": 940,
  "protectTokens": 20000,
  "blocks": [ /* ViewBlock[] — see the ViewBlock table in Part 1 */ ]
}
```

`liveTokens` is the baseline to fold down from; `protectedFromIndex` / `protectTokens` are
the host's protected-tail *policy* you may honour or ignore (folding into the tail may be
reverted by host healing). Each `block` is a `ViewBlock` — its `text` is present under
`wants:"full"`, replaced by a one-line `preview` under `wants:"shape"` / `"onDemand"`.

**`host/commandResult`** — what the host clamped from your last batch.

```json
{
  "type": "host/commandResult",
  "rev": 7,
  "reports": [
    { "command": "fold", "ids": ["m12:p0"], "reason": "human-override", "detail": "block pinned by human" }
  ]
}
```

`reason` is one of the `ClampReason`s tabled in Part 1 (`unknown-id`, `human-override`,
`grouped`, `invalid-group`, `protected`, `noop`). Commands are never silently dropped — every
clamp is reported.

**`cap/result`** — answer to a `cap/request` you sent (same `reqId`).

```json
{ "type": "cap/result", "reqId": "r1", "ok": true, "value": "{#a3f9 FOLDED} ls — 412 files" }
```

On failure: `{ "type": "cap/result", "reqId": "r1", "ok": false, "error": "unknown id" }`.

**`host/event`** — something happened you did not initiate.

```json
{ "type": "host/event", "event": "agentUnfold", "ids": ["m31:r"], "detail": "agent called unfold" }
```

`event` is `"agentUnfold"` (the live agent pulled blocks back to full via its `unfold`
tool) or `"humanOverride"` (the human pinned/folded/unfolded by hand — their choice always
wins). `ids` are **block ids** in both cases — the same ids that appear in `ViewBlock.id`,
so you can correlate them directly against the blocks you received in `context/update`. For
`agentUnfold`, all block ids that mapped to the restored fold codes are included (a short
hash can rarely collide → multiple ids per code are possible). Treat both events as facts
about the current state to fold into your next batch.

### conductor → host

**`conductor/hello`** — your opening frame.

```json
{ "type": "conductor/hello", "conductorProtocol": 2, "id": "recency-folder", "label": "Recency folder", "wants": { "content": "full" } }
```

`wants.content`: `"full"` (every block's text — the default), `"shape"` (structure +
one-line `preview`, no full text), or `"onDemand"` (structure only; fetch text per block
via the `getContent` capability). Trust is full once connected — this is bandwidth/taste,
not security.

**`conductor/commands`** — your complete desired state.

```json
{
  "type": "conductor/commands",
  "rev": 7,
  "commands": [
    { "kind": "fold", "ids": ["m4:r", "m6:r"] },
    { "kind": "replace", "id": "m9:r", "content": "" }
  ]
}
```

Echo the `rev` of the `context/update` you are answering so the host can spot a reply to a
stale snapshot.

**`cap/request`** — ask the host to do something only it can (it owns the engine +
tokenizer). The host answers with a `cap/result` carrying the same `reqId`.

```json
{ "type": "cap/request", "reqId": "r1", "capability": "countTokens", "text": "some text to measure" }
```

| capability     | input            | returns                                                          |
|----------------|------------------|------------------------------------------------------------------|
| `summarize`    | `ids` (a block, or a group head) | the engine digest for those ids                   |
| `countTokens`  | `text`           | token estimate (number) for `text`                               |
| `getContent`   | `ids[0]`         | full text of that block (for `wants:"onDemand"`)                 |
| `getDigest`    | `ids[0]`         | the engine's per-kind folded digest (incl. the `{#code FOLDED}` tag) |

**`conductor/status`** — *display-only* telemetry: a one-line summary of what you are
calculating, for the host to surface to a human near the conductor switcher.

```json
{ "type": "conductor/status", "text": "82% full · holding · band 70–90% · 14 folded", "metrics": { "fullness": 82, "scoring": false } }
```

Purely informational. The host renders `text` (and may use the optional structured
`metrics`) and does **nothing else** — it never folds, alters commands, or triggers a model
call on this. Additive and non-breaking: it carries no `rev` and expects no reply, so it is
safe to emit (or never emit) independently of `conductor/commands`. A conductor that never
sends one simply shows no readout. See `conductors/attention-folder/` for a worked emitter.

## A reference conductor (Node.js, on the wire)

A minimal, copy-paste-runnable conductor (`npm i ws`). It hosts a WS server, declares it
wants full content, and on each `context/update` folds the oldest non-`protected`
`tool_result` blocks until the live estimate is under budget — the spirit of the built-in
(oldest-first, results decay fastest), in ~35 lines.

> A **runnable copy** of this conductor — with the `~/.accordion/conductors/` heartbeat
> wired up so the desktop app auto-discovers it — lives at
> [`conductors/recency-folder/`](../conductors/recency-folder/) (`cd` in, `npm install`,
> `npm start`). New conductors get their own subdirectory under
> [`conductors/`](../conductors/).

```js
// recency-folder.js — run: node recency-folder.js   (npm i ws)
// Advertise it for auto-discovery by writing this JSON to
// ~/.accordion/conductors/recency-folder.json (refresh heartbeatAt every few seconds):
//   { "registryProtocol":1, "conductorProtocol":2, "id":"recency-folder",
//     "label":"Recency folder", "url":"ws://127.0.0.1:7700",
//     "pid":<pid>, "startedAt":<ms>, "heartbeatAt":<ms> }
import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ host: "127.0.0.1", port: 7700 });

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({
    type: "conductor/hello", conductorProtocol: 2,
    id: "recency-folder", label: "Recency folder", wants: { content: "full" },
  }));

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "context/update") return; // ignore hello/result/event for this demo

    // Fold oldest, non-protected, not-yet-folded tool_results until under budget.
    // Use the host-supplied liveTokens as the baseline (already accounts for human
    // folds, folded-group carriers, and digest residue). Each fold saves the
    // difference between full and folded cost (foldedTokens is precomputed).
    let live = msg.liveTokens;
    const ids = [];
    for (const b of msg.blocks) {          // blocks arrive in conversation order (oldest first)
      if (live <= msg.budget) break;
      if (b.kind !== "tool_result" || b.folded || b.protected) continue;
      ids.push(b.id);
      live -= (b.tokens - b.foldedTokens); // host clamps + re-counts exactly
    }

    ws.send(JSON.stringify({
      type: "conductor/commands", rev: msg.rev,
      commands: ids.length ? [{ kind: "fold", ids }] : [],
    }));
  });
});

console.log("recency-folder listening on ws://127.0.0.1:7700");
```

This is intentionally minimal (it ignores `host/commandResult` and `host/event`). A real
conductor reads the clamp reports, respects `human-override`, and may use `countTokens` for
exact accounting. But it is correct against the real message shapes and Accordion will
attach to it, fold tiles, and report back.
