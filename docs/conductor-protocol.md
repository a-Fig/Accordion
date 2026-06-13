# Writing a Conductor — developer reference

A **conductor** is an interchangeable context-management strategy for Accordion. Between
turns it reads the agent's context and decides what to fold, replace, group, restore, or
pin — keeping the live context useful and within budget. Accordion ships one (the built-in
budget folder); this document is for writing your own, in any language.

The design and rationale are in [ADR 0007](adr/0007-conductor-protocol.md). The contract is
defined in two files you can read or copy from directly:

- `app/src/lib/engine/conductor.ts` — the in-process shape (`ContextSnapshot`, the
  `Command` union, `ClampReport`).
- `app/src/lib/live/conductorProtocol.ts` — the WebSocket messages (this document's
  reference), which *import* `Command` / `ClampReport` from the contract so there is one
  definition, not two.

## Topology — you host, Accordion connects

You host a WebSocket endpoint. Accordion connects to it as a **client** and dials out.
(Accordion is a webview; it cannot host a server. It is already a client to the pi
extension — this mirrors that exactly.) One JSON message per WebSocket frame; the shapes
are below.

Trust is full once connected. The only thing the host enforces on your commands is
**provider-validity** — the outgoing message must stay sendable. Everything else (what to
fold, recency, summaries, tags) is your strategy.

## How Accordion finds you

Two ways:

**1. Advertise a registry file** (local conductors — auto-discovered). Write a JSON file
at `~/.accordion/conductors/<id>.json` matching the `ConductorEntry` shape, refresh it on a
heartbeat (Accordion treats an entry older than 15 s as dead and reaps it), and delete it on
shutdown. The fields (see `registry.ts`):

| field              | type     | meaning                                                     |
|--------------------|----------|-------------------------------------------------------------|
| `registryProtocol` | number   | must equal `1` (the `REGISTRY_PROTOCOL` constant)           |
| `conductorProtocol`| number   | the conductor wire version you speak (`1` today)            |
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
  "conductorProtocol": 1,
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
   moved) Accordion sends `context/update` with the full block list and a monotonic `rev`.
4. **Reply with your complete desired state.** Send `conductor/commands` with the full
   batch of commands (not a diff) and echo the `rev` you are responding to.
5. **Read what was clamped.** Accordion replies `host/commandResult` with one
   `ClampReport` per command it could not apply verbatim.
6. **Hold by staying silent.** If you have nothing new to say, send nothing — the host
   keeps your last applied batch in force. New blocks arrive raw until you next speak.

Your commands are a **complete desired state**: Accordion resets to the raw baseline and
re-applies the whole batch each time. To change one block, re-send your whole intention.

## Message reference

All shapes are exact (from `conductorProtocol.ts`). `CONDUCTOR_PROTOCOL_VERSION` is `1`.

### host → conductor

**`host/hello`** — first frame after connect.

```json
{
  "type": "host/hello",
  "conductorProtocol": 1,
  "session": { "title": "fix the parser", "model": "google/gemini-2.5-flash-lite", "cwd": "/home/me/proj" },
  "budget": 70000,
  "contextWindow": 1000000
}
```

**`context/update`** — the context changed; carries the full block list each time.

```json
{
  "type": "context/update",
  "rev": 7,
  "budget": 70000,
  "contextWindow": 1000000,
  "protectedFromIndex": 940,
  "blocks": [ /* BlockView[] */ ]
}
```

`protectedFromIndex` is the first index of the host's protected working tail — host
*policy* you may honour or ignore. The host does not enforce it as a floor, but folding
into the tail may be reverted by host healing while the built-in is the active policy.

A **`BlockView`** is a serialisable projection of an engine block:

| field       | type    | notes                                                                  |
|-------------|---------|------------------------------------------------------------------------|
| `id`        | string  | durable block id — what every command references                       |
| `kind`      | string  | `user` · `text` · `thinking` · `tool_call` · `tool_result`             |
| `turn`      | number  | 1-based user turn (0 = preamble)                                       |
| `order`     | number  | global 0-based position in the conversation                            |
| `tokens`    | number  | full token cost at full fidelity                                       |
| `toolName`  | string? | for `tool_call` / `tool_result`                                        |
| `callId`    | string? | pairing key (a call and its result share it)                           |
| `isError`   | boolean?| tool-result error flag                                                 |
| `folded`    | boolean | currently folded in the host view (by a prior command or a human)      |
| `protected` | boolean | inside the host's protected working tail                               |
| `text`      | string? | full content — present only under `wants:"full"`                       |
| `preview`   | string? | one-line taste — present under `wants:"shape"`/`"onDemand"` in place of `text` |

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

`reason` is one of: `unknown-id` (no such block — vanished in a resync or never existed),
`human-override` (a human pin/fold/unfold owns it — human wins), `grouped` (inside a folded
group the group overlay owns), `invalid-group` (a `group`'s ids were not a contiguous,
ungrouped, ≥2-member run), `noop` (already in the requested state). Commands are never
silently dropped — every clamp is reported.

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
wins). Treat both as facts about the current state to fold into your next batch.

### conductor → host

**`conductor/hello`** — your opening frame.

```json
{ "type": "conductor/hello", "conductorProtocol": 1, "id": "recency-folder", "label": "Recency folder", "wants": { "content": "full" } }
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

## The command set

Every command is **content substitution, never structural removal** — a block is never
spliced out, only its content changes. That is what guarantees a `tool_call`/`tool_result`
pair can never orphan.

| command   | shape                                | effect                                                                 |
|-----------|--------------------------------------|------------------------------------------------------------------------|
| `fold`    | `{ kind:"fold", ids, digest? }`      | Collapse blocks to a digest. No `digest` → the host's per-kind digest + the `{#code FOLDED}` agent-recovery tag. A `digest` string → exactly that text is shown and the agent receives it. |
| `replace` | `{ kind:"replace", id, content }`    | Substitute a block's content with arbitrary text. `content: ""` is the safe form of **delete** — the block stays in place (pairing intact) but contributes almost nothing. |
| `group`   | `{ kind:"group", ids }`              | Collapse a **contiguous** run into one summary entry (summary-on-head, the rest emptied — never removed). Non-contiguous selections are not representable; empty/replace individually instead. |
| `restore` | `{ kind:"restore", ids }`            | Return blocks to full, live content (undo a fold/replace). No-op on a human-held block. |
| `pin`     | `{ kind:"pin", ids }`                | Assert blocks stay live and open — e.g. force live a block an earlier command in the same batch folded. Never overrides a *human* pin. |

### Safety rules you must expect

- **Content substitution only.** There is no remove. `replace(id, "")` is how you "delete".
- **Human-held blocks are refused.** A `fold` / `replace` / `restore` / `pin` touching a
  block the human pinned, manually folded, or manually unfolded comes back as a
  `human-override` `ClampReport` and is not applied. The human always wins.
- **A `group` over a human-held block is refused wholesale** — the entire group, not just
  the held member (`invalid-group` / `human-override`). Re-issue the group around the held
  block, or leave it.
- **`group` validity.** The ids must be a contiguous, currently-ungrouped, ≥2-member run,
  entirely older than the protected tail. Otherwise: `invalid-group`.
- **Grouped members are off-limits.** A block already inside a folded group is owned by the
  group overlay; folding it individually double-counts. `BlockView` does not flag group
  membership directly in v1 — leave blocks you grouped alone and watch for a `grouped`
  report.

## A reference conductor

A minimal, copy-paste-runnable conductor in Node.js (`npm i ws`). It hosts a WS server,
declares it wants full content, and on each `context/update` folds the oldest
non-`protected` `tool_result` blocks until the live estimate is under budget — the spirit
of the built-in (oldest-first, results decay fastest), in ~35 lines.

> A **runnable copy** of this conductor — with the `~/.accordion/conductors/` heartbeat
> wired up so the desktop app auto-discovers it — lives at
> [`conductors/recency-folder/`](../conductors/recency-folder/) (`cd` in, `npm install`,
> `npm start`). New conductors get their own subdirectory under
> [`conductors/`](../conductors/).

```js
// recency-folder.js — run: node recency-folder.js   (npm i ws)
// Advertise it for auto-discovery by writing this JSON to
// ~/.accordion/conductors/recency-folder.json (refresh heartbeatAt every few seconds):
//   { "registryProtocol":1, "conductorProtocol":1, "id":"recency-folder",
//     "label":"Recency folder", "url":"ws://127.0.0.1:7700",
//     "pid":<pid>, "startedAt":<ms>, "heartbeatAt":<ms> }
import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ host: "127.0.0.1", port: 7700 });

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({
    type: "conductor/hello", conductorProtocol: 1,
    id: "recency-folder", label: "Recency folder", wants: { content: "full" },
  }));

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "context/update") return; // ignore hello/result/event for this demo

    // Fold oldest, non-protected, not-yet-folded tool_results until under budget.
    let live = msg.blocks.reduce((n, b) => n + (b.folded ? 0 : b.tokens), 0);
    const ids = [];
    for (const b of msg.blocks) {          // blocks arrive in conversation order (oldest first)
      if (live <= msg.budget) break;
      if (b.kind !== "tool_result" || b.folded || b.protected) continue;
      ids.push(b.id);
      live -= b.tokens;                    // approximate; the host clamps + re-counts exactly
    }

    ws.send(JSON.stringify({
      type: "conductor/commands", rev: msg.rev,
      commands: ids.length ? [{ kind: "fold", ids }] : [],
    }));
  });
});

console.log("recency-folder listening on ws://127.0.0.1:7700");
```

This is intentionally crude (it estimates token savings as the whole block, where the host
counts the digest residue; it ignores `host/commandResult` and `host/event`). A real
conductor reads the clamp reports, respects `human-override`, and may use `countTokens` for
exact accounting. But it is correct against the real message shapes and Accordion will
attach to it, fold tiles, and report back.
