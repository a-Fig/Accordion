# Writing a Conductor — developer reference

A **conductor** is an interchangeable context-management strategy for Accordion. Between
turns it reads the agent's context and decides what to fold, replace, group, restore, or
pin — keeping the live context useful and within budget. Accordion ships one (the built-in
budget folder); this document is for writing your own.

Conductors are **first-party** — every one lives in this repo (or a fork). There is no
sandbox or trust boundary; the contract exists to make a conductor cheap to write, with the
built-in as the worked example. The host enforces one floor (provider-validity) plus two
guardrails (human overrides win unless the conductor holds an ADR 0011 involvement lock; unsafe
commands are clamped and reported) — these stop a
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

`conduct()` is always synchronous. If a conductor needs async work — for example an LLM
summary call — it implements the optional lifecycle hook:

```ts
attach(host: ConductorHost): void
detach(): void
```

`host.requestRerun()` is the in-process async bridge. Start the async work from `conduct()`,
return `null` while it is in flight, cache the finished `Command[]` inside the conductor,
then call `requestRerun()`. The host schedules a later `conduct()` pass, debounces bursts of
requests, and ignores stale requests from a conductor that has since been detached or
replaced. Async completions must never mutate the store directly. If a conductor stores the
host object on `this` and may reuse the same instance across attachments, it should also use
its own generation/cancellation token so an old promise cannot write stale commands into a
new attachment.

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
line) or ignore it. Without the `tail-size` lock (ADR 0011), folding into the tail is reverted
by host healing. With the lock, the tail is the conductor's own declared `tailTokens`:
`tailTokens = 0` means no protected tail (you may fold any block), but folds inside a
`tailTokens > 0` tail are still refused with `protected` — you own the tail's *size*, not a
licence to fold into it.

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
- **`null`** — *hold*: the host reuses the previous non-null command batch. It still rebuilds
  from the raw baseline and re-enforces protection/provider-validity, so new content not
  covered by the previous batch arrives raw. Remote conductors use this through
  `RemoteRunner`; in-process conductors use `ConductorHost.requestRerun()` to ask for a fresh
  pass when their async result is ready. The built-in never returns `null`.

Most commands are **content substitution** — a block is replaced in place, not spliced out,
which guarantees a `tool_call`/`tool_result` pair can never orphan. The deliberate exception
is `group` with `digest: null` (DROP): the run is removed from the wire entirely and no
replacement is inserted. Phase A tool-pair balancing still applies, so no orphaned pairs
result. See the `group` row below and ADR 0006 §drop-addendum.

| command   | shape                                | effect                                                                 |
|-----------|--------------------------------------|------------------------------------------------------------------------|
| `fold`    | `{ kind:"fold", ids, digest? }`      | Collapse blocks to a digest. No `digest` → the host's per-kind digest + the `{#code FOLDED}` agent-recovery tag. A `digest` string → exactly that text is shown and the agent receives it. |
| `replace` | `{ kind:"replace", id, content }`    | Substitute a block's content with arbitrary text. The block stays in place (pairing intact). `content: ""` means "shrink to nothing": an empty content part can't be sent on the wire, so the host folds the block to its `{#code FOLDED}` digest (the smallest wire-safe form), so the view matches what the agent receives. Only `text`/`thinking`/`tool_result` fold. |
| `group`   | `{ kind:"group", ids, digest? }`     | Collapse a **contiguous** run (≥1 member) into an entry. The group covers the run from the **first to the last** named id, snapped outward to whole messages — blocks *between* the first and last are swept in even if unnamed. For a non-contiguous set, issue one `group` per run, or empty/replace blocks individually. `digest` controls what replaces the run: **`undefined`** → the host's default deterministic recap + `{#code FOLDED}` tag (unchanged behavior); **`null` or `""`** → **DROP**: the run is removed from the wire and NO replacement is inserted — the agent never sees those blocks, `recall`/`unfold` cannot recover them (they are gone by design); **a non-empty string** → that exact text is the summary verbatim (like `FoldCommand.digest`, no tag added). DROP is the second deliberate exception to "content substitution, never structural removal" (see ADR 0006 §drop-addendum); like the existing group→summary exception it is whole-message and pair-balanced. |
| `restore` | `{ kind:"restore", ids }`            | Return blocks to full, live content (undo a fold/replace). No-op on a human-held block. |
| `pin`     | `{ kind:"pin", ids }`                | Assert blocks stay live and open — e.g. force live a block an earlier command in the same batch folded. Never overrides a *human* pin. |

## Guardrails the host enforces (and reports)

The host clamps each command to the one floor it keeps — **provider-validity, the message
stays sendable** — and reports anything it couldn't apply verbatim. Nothing is silently
dropped; nothing throws.

- **Content substitution, with one removal exception.** `replace(id, "")` "deletes" by folding the block to its `{#code FOLDED}` digest (an empty content part can't be sent), so it still costs the digest, not zero. The sole true removal is `group` with `digest: null` (DROP) — it removes the whole run from the wire and inserts nothing; see the `group` row above and ADR 0006 §drop-addendum.
- **Human-held blocks are refused** (in the `human-steering`-unlocked domains). A `fold` / `replace` / `restore` / `pin` touching a
  block the human pinned, manually folded, or manually unfolded (`held: true`) comes back as
  a `human-override` `ClampReport` and is not applied. Under the `human-steering` lock, no
  human overrides exist to refuse — the UI blocks the action at the source (ADR 0011).
- **A `group` over a human-held block is refused wholesale** — the entire group, not just
  the held member. Re-issue the group around the held block, or leave it.
- **`group` validity.** The ids must form a contiguous, currently-ungrouped, ≥1-member run
  entirely older than the protected tail. Otherwise: `invalid-group`. A single-member group
  is valid — it is the idiomatic way to drop or summarize one lone block.
- **Grouped members are off-limits.** A block already inside a folded group (`grouped:
  true`) is owned by the group overlay; folding it individually double-counts → a `grouped`
  report. Leave grouped blocks alone.

A **`ClampReport`** is `{ command, ids, reason, detail }`. `reason` is one of:

| reason           | meaning                                                                       |
|------------------|-------------------------------------------------------------------------------|
| `unknown-id`     | no block with that id exists (vanished in a resync, or never existed)          |
| `human-override` | a human pin / manual fold / manual unfold owns the block — the human wins      |
| `grouped`        | the block is inside a folded group; the group overlay owns it                  |
| `invalid-group`  | a `group`'s ids were not a valid contiguous, ungrouped, ≥1-member run entirely outside the protected tail |
| `protected`      | the block is inside the active protected working tail; the host refuses to fold it. Without `tail-size` this is the human's `protectTokens` tail; with `tail-size` it is the conductor's declared `tailTokens` tail (`tailTokens = 0` ⇒ no tail, no `protected` clamps). See ADR 0011 |
| `not-foldable`   | the command targeted a kind the engine never folds/replaces (`user` or `tool_call`) |
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
| `conductorProtocol`| number   | the conductor wire version you speak (`3` today)            |
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
  "conductorProtocol": 3,
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
is `3` (bumped from 2 by ADR 0011 to carry the lock declaration in `conductor/hello`).

### host → conductor

**`host/hello`** — first frame after connect.

```json
{
  "type": "host/hello",
  "conductorProtocol": 3,
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
`grouped`, `invalid-group`, `protected`, `not-foldable`, `noop`). Commands are never silently dropped — every
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
{ "type": "conductor/hello", "conductorProtocol": 3, "id": "recency-folder", "label": "Recency folder", "wants": { "content": "full" } }
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
| `complete`     | `completion`     | out-of-band model completion result (text/model/usage); see Part 3 |

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
//   { "registryProtocol":1, "conductorProtocol":3, "id":"recency-folder",
//     "label":"Recency folder", "url":"ws://127.0.0.1:7700",
//     "pid":<pid>, "startedAt":<ms>, "heartbeatAt":<ms> }
import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ host: "127.0.0.1", port: 7700 });

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({
    type: "conductor/hello", conductorProtocol: 3,
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

---

# Part 3 — Host capabilities

Some conductors need services only the host can provide: a tokenizer, access to the engine's
digest function, or — the most powerful one — the ability to run an out-of-band model
completion to summarize aged context. The **`ConductorHost`** interface delivers these.

## Receiving the host — `attach(host)` and `detach()`

The host injects its services via an optional lifecycle hook:

```ts
interface Conductor {
  attach?(host: ConductorHost): void;   // called once, before the first conduct()
  conduct(view: ConductorView): Command[] | null;
  detach?(): void;                    // called when the conductor is detached/swapped
}
```

- **`attach(host)`** is called once per conductor instance, before the first `conduct()` call.
  A pure stateless conductor (the built-in) omits it entirely — `attach` is not called if
  absent. Hold a reference to `host` on the instance.
- **`detach()`** is called when the conductor is detached or swapped out. Use it to cancel
  in-flight async work (abort any outstanding `host.complete()` calls via the `AbortSignal`
  you passed in the request, so stale completions do not call `host.requestRerun()` after the
  conductor is gone). Optional.

## The `conduct()` contract stays synchronous

`conduct()` **must remain synchronous**. A conductor that needs a model completion follows
the fire-and-forget / requestRerun pattern:

1. From `conduct()`: detect that a completion is needed. If one is already in-flight, return
   `null` (hold — keep last state). If not, kick off `host.complete(req)` in the background
   (stash the promise on the instance) and return `null` immediately.
2. When the promise resolves: stash the result in instance state, then call
   `host.requestRerun()`. This asks the host to schedule a fresh `conduct()` pass.
3. On the **next** `conduct()` call: the result is already in instance state. Emit the
   commands based on it.

This is exactly how the out-of-process `RemoteRunner` already works (it caches the last
`conductor/commands` batch and returns it synchronously while the remote is thinking). The
key invariant: `conduct()` never awaits, never blocks, never has side effects — only
instance-state reads and command emission.

## `ConductorHost` method reference

| method | signature | meaning |
|--------|-----------|---------|
| `can` | `(capability: HostCapabilityId) => boolean` | Is this capability available right now? Always call this before depending on `complete`. Returns `false` when the extension is disconnected, the session is read-only (Claude Code transcript), or no model link exists. `"countTokens"` and `"digest"` are always `true`. |
| `complete` | `(req: CompletionRequest) => Promise<CompletionResult>` | Run an out-of-band model completion asynchronously. Not on the `conduct()` hot path — use the async pattern above. Rejects if `"complete"` is unavailable or the `AbortSignal` fires. In this version, specific model id strings are reserved for future use and treated as `"current"`. |
| `countTokens` | `(text: string) => number` | Synchronous token estimate for `text` using the host's tokenizer (chars/4 for Accordion's default). Safe to call inside `conduct()`. |
| `digestOf` | `(id: string) => string \| null` | The engine's per-kind folded digest for block `id` — the exact string the agent receives when that block is folded (including the `{#code FOLDED}` tag). Returns `null` if the block is unknown. Synchronous; safe inside `conduct()`. |
| `setStatus` | `(text: string \| null, metrics?: Record<string, number \| string \| boolean>) => void` | Surface display-only conductor status to the human. `null`/empty clears it. This never steers context; it is for visible unavailable/working/error states. |
| `requestRerun` | `() => void` | Ask the host to re-run `conduct()` now. Call this from an async completion handler after stashing the result. Has no effect if the conductor is no longer attached (stale calls after `detach()` are ignored). |

`HostCapabilityId` is `"complete" | "countTokens" | "digest"`.

## `CompletionRequest` fields

| field | type | meaning |
|-------|------|---------|
| `prompt` | `string` | The user-role content to operate on (required). |
| `system` | `string?` | Optional system instruction — e.g. a compaction persona or template. |
| `maxOutputTokens` | `number?` | Requested cap on output tokens. The extension clamps this to the model's own max-output ceiling before forwarding, so a conductor can safely pass any positive number without risking a provider rejection. The model enforces the (clamped) value as a hard cap — over-long output is truncated, not rejected. Omit to use the model default. |
| `signal` | `AbortSignal?` | Abort signal from an `AbortController` you hold. Pass `controller.signal` here; call `controller.abort()` from `detach()` so stale completions do not race back after the conductor is gone. |
| `model` | `"current" \| string?` | `"current"` (default when omitted) = the user's live session model. A specific model id string is reserved for future use and, in this version, is treated as `"current"`. |

## `CompletionResult` fields

| field | type | meaning |
|-------|------|---------|
| `text` | `string` | The model's full text output. |
| `model` | `string` | The model id that actually ran (resolved from `request.model`). |
| `inputTokens` | `number?` | Host-counted input token usage for this call, when available. |
| `outputTokens` | `number?` | Host-counted output token usage for this call, when available. |

## `can("complete")` and degradation

`host.can("complete")` returns `false` when:

- The app is in **browser dev mode** (no pi extension, no model link).
- The session is a **read-only Claude Code transcript** (`session.readOnly`).
- The pi extension is **disconnected** or the model is currently unavailable.

A conductor that depends on `"complete"` should always check `can` first and handle
unavailability deliberately — e.g. emit an explicit non-LLM command set, or call
`host.setStatus(...)` and hold/preserve the last state until the model link recovers.

## Minimal worked example

A conductor that, when over budget, summarizes the oldest non-protected block via
`host.complete()` and replaces it with the summary — illustrative only, not production-ready:

```ts
import type { Conductor, ConductorHost, ConductorView, Command } from "../contract";

export class SummarizingConductor implements Conductor {
  readonly id = "summarizing";
  readonly label = "Summarizing";

  private host: ConductorHost | null = null;
  private summary: string | null = null;
  private headId: string | null = null;
  private inflight: AbortController | null = null;

  attach(host: ConductorHost): void { this.host = host; }

  detach(): void {
    this.inflight?.abort();
    this.inflight = null;
    this.host = null;
  }

  conduct(view: ConductorView): Command[] | null {
    if (!this.host) return null;
    if (view.liveTokens <= view.budget) return [];   // fits — clear to raw

    // If a completion is in-flight, hold last state.
    if (this.inflight) {
      return this.headId ? [{ kind: "replace", id: this.headId, content: this.summary! }] : null;
    }

    // Find the oldest non-protected, non-held block to summarize.
    const target = view.blocks.find(b => !b.protected && !b.held && b.text);
    if (!target || !target.text) return [];

    if (!this.host.can("complete")) {
      // Degrade: no model link — emit a fold instead.
      return [{ kind: "fold", ids: [target.id] }];
    }

    // Launch summary in the background; return null (hold) until it resolves.
    const ctrl = new AbortController();
    this.inflight = ctrl;
    this.host.complete({ prompt: target.text, signal: ctrl.signal }).then(
      result => {
        this.inflight = null;
        this.summary = result.text;
        this.headId = target.id;
        this.host?.requestRerun();   // triggers a fresh conduct() pass
      },
      _err => { this.inflight = null; }
    );

    return null;
  }
}
```

## The wire transport for `"complete"` (out-of-process conductors)

An out-of-process conductor accessing `"complete"` uses the `cap/request` / `cap/result`
message pair over the existing WebSocket — the same channel used for `countTokens` and
`getDigest`. Internally, the host fulfils the request via the same `ConductorHost.complete`
path (which in turn relays over the pi wire as `completeRequest` / `completeResult`).

**Sending a completion request:**

```json
{
  "type": "cap/request",
  "reqId": "r1",
  "capability": "complete",
  "completion": {
    "system": "You are a compaction assistant …",
    "prompt": "… aged context blocks …",
    "maxOutputTokens": 8000
  }
}
```

The `completion` object accepts `system`, `prompt`, and `maxOutputTokens`. The host uses the
user's live session model (there is no `model` override on the wire in this version). Remote
completion requests are not cancellable over JSON/WS; if the conductor detaches or no longer
wants the result, the in-flight model call may still finish and the stale result is ignored.

**Receiving the result:**

```json
{
  "type": "cap/result",
  "reqId": "r1",
  "ok": true,
  "value": "## Goal\nFix the parser …",
  "model": "google/gemini-2.5-flash",
  "inputTokens": 4320,
  "outputTokens": 218
}
```

On failure: `{ "type": "cap/result", "reqId": "r1", "ok": false, "error": "no model link" }`.

`value` carries the completion text. `model`, `inputTokens`, and `outputTokens` are present
on success when the host can supply them — for a conductor's own accounting.

**AbortSignal note:** `AbortSignal` is not serializable, so per-request wire cancellation is
**not supported** in this version. A wire conductor that no longer wants a result should
simply ignore the arriving `cap/result` by `reqId`. The in-process path supports `AbortSignal`
fully via `CompletionRequest.signal`.

## Version notes

- **Conductor protocol version 3** (`CONDUCTOR_PROTOCOL_VERSION = 3`): adds the `"complete"`
  capability — `cap/request` gains the `completion` payload; `cap/result` gains `model`,
  `inputTokens`, `outputTokens` on a successful "complete" result.
- **Pi wire protocol version 5** (`PROTOCOL_VERSION = 5`): adds `completeRequest` /
  `completeResult` — the relay messages the GUI sends to the extension to fulfil a
  conductor's model call. This is the underlying transport for `ConductorHost.complete` in
  a live session. It is a separate model invocation, completely outside the `sync→plan→apply`
  loop, and **never blocks or alters the agent's own model call or the `context` hook**.
