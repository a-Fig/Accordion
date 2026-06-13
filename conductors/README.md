# Conductors

A **conductor** is an interchangeable context-management strategy for Accordion — the thing
that decides, between turns, *which* blocks to fold / replace / group / restore / pin to keep
the live context useful and under budget. Conductors are pluggable behind one contract
([ADR 0007](../docs/adr/0007-conductor-protocol.md)); Accordion imposes no strategy of its own
(no conductor attached ⇒ raw context).

**This directory holds external conductor implementations** — one subdirectory per conductor,
in any language. Each hosts a WebSocket endpoint that Accordion dials as a client, and (for
local ones) advertises a heartbeat file at `~/.accordion/conductors/<id>.json` so the desktop
app auto-discovers it. Off-box / remote conductors can instead be added by `ws://` URL in the
app's header conductor dropdown.

> The **built-in** conductor is *not* here — it runs in-process at
> [`app/src/lib/engine/conductor.builtin.ts`](../app/src/lib/engine/conductor.builtin.ts) and is
> the default strategy. This directory is for the external ones, all the way down.

## Writing one

Start with the developer reference: **[`docs/conductor-protocol.md`](../docs/conductor-protocol.md)**
— topology (you host, Accordion dials), the `connect → hello → context → commands` lifecycle,
every message shape, the command set, and the safety rules the host enforces (the
provider-validity floor, human overrides always win, unsafe commands are clamped to
nearest-safe and reported — never dropped). The contract types live in
[`app/src/lib/engine/conductor.ts`](../app/src/lib/engine/conductor.ts) (the in-process shape)
and [`app/src/lib/live/conductorProtocol.ts`](../app/src/lib/live/conductorProtocol.ts) (the
wire messages, which import `Command` / `ClampReport` so there is one definition, not two).

**Convention:** give your conductor its own subdirectory here with its own README/build, pick
a stable `id`, and either advertise a registry file (local) or hand out a `ws://` URL (remote).

## Conductors here

| directory | language | what it does |
|-----------|----------|--------------|
| [`recency-folder/`](recency-folder/) | Node.js | **Reference starter.** Folds the oldest non-protected `tool_result` blocks until the live estimate is under budget, and auto-advertises for discovery. Intentionally crude — copy it and grow your own. |

### Run the reference

```bash
cd recency-folder
npm install
npm start        # listens on ws://127.0.0.1:7700, advertises under ~/.accordion/conductors/
```

Then open the Accordion desktop app, load a session, and pick **Recency folder** from the
conductor dropdown in the map header.
