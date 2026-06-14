# Conductors

A **conductor** is an interchangeable context-management strategy for Accordion — the thing
that decides, between turns, *which* blocks to fold / replace / group / restore / pin to keep
the live context useful and under budget. Conductors are pluggable behind one contract
([ADR 0007](../docs/adr/0007-conductor-protocol.md), refined by
[ADR 0008](../docs/adr/0008-conductor-first-party-one-view.md)); Accordion imposes no
strategy of its own (no conductor attached ⇒ raw context).

Conductors are **first-party** — every one ships in this repo or a fork of it. There is no
sandbox and no trust boundary; the point of the interface is to make a conductor *cheap to
write*, with the built-in folder as the worked example.

## What a conductor is

One pure idea:

```ts
conduct(view: ConductorView): Command[] | null
```

The host hands you a read-only [`ConductorView`](contract/conductor.ts) — every block in
conversation order plus the budget, context window, live token count, and the protected-tail
policy. You return the context you *want*, as commands:

- **`Command[]`** — your complete desired state. The host resets to the raw baseline and
  applies the whole batch, so to change one block you re-send your whole intention.
- **`[]`** — explicitly clear to raw (nothing folded).
- **`null`** — *hold*: keep the last applied state (used by an async/remote conductor still
  thinking; never blocks a model call).

The `Command` union is `fold · replace · group · restore · pin` — all **content
substitution, never structural removal**, so a `tool_call`/`tool_result` pair can never
orphan. The host enforces exactly one floor — **provider-validity** (the outgoing message
stays sendable) — plus two guardrails: human overrides always win, and anything it can't
apply verbatim is clamped to nearest-safe and **reported**, never silently dropped. These
are bug/UX rails, not defenses against you.

## Writing one (in-process — the main way)

Drop a TypeScript class in `conductors/<your-name>/` and register one line. Here is a
complete conductor that folds the oldest non-protected `tool_result` blocks until the live
context fits the budget:

```ts
// conductors/recency-min/recency-min.ts
import type { Conductor, ConductorView, Command } from "../contract";

export class RecencyMinConductor implements Conductor {
  readonly id = "recency-min";
  readonly label = "Recency (min)";

  conduct(view: ConductorView): Command[] {
    let live = view.liveTokens;
    if (live <= view.budget) return []; // already fits → raw

    const ids: string[] = [];
    for (const b of view.blocks) {
      // blocks are in conversation order (oldest first)
      if (live <= view.budget) break;
      if (b.kind !== "tool_result" || b.held || b.protected || b.grouped) continue;
      ids.push(b.id);
      live += b.foldedTokens - b.tokens; // foldedTokens is precomputed for you
    }
    return ids.length ? [{ kind: "fold", ids }] : [];
  }
}
```

Then register it — one line in [`index.ts`](index.ts), in the `IN_PROCESS_CONDUCTORS` array:

```ts
import { RecencyMinConductor } from "./recency-min/recency-min";

export const IN_PROCESS_CONDUCTORS: InProcessConductor[] = [
  { id: "builtin",     label: "Built-in",      create: () => new BuiltinConductor() },
  { id: "recency-min", label: "Recency (min)", create: () => new RecencyMinConductor() }, // ← added
];
```

That's it. It appears in the conductor dropdown in the map header. Conductor selection is
**global** — one active conductor applies to whatever session is loaded (persisted in
`conductorState.activeId`), not chosen per session.

**The real worked example is the built-in:** [`builtin/builtin.ts`](builtin/builtin.ts) is a
~15-line `conduct` that does exactly this kind of budget-folding (oldest-first,
lowest-value-kind-first). It reads the *same* public `ConductorView` you do — there is no
privileged richer input — so reading it teaches you the whole interface. The full contract
(the `ConductorView` / `ViewBlock` field tables, every command, the clamp reasons) is the
first half of [`docs/conductor-protocol.md`](../docs/conductor-protocol.md).

## Escape hatch: separate process / another language (WebSocket)

Reach for this **only** when an in-process TypeScript class won't do — you need a separate
process, a long-running model, or a non-JS language. The conductor then hosts a WebSocket
endpoint that Accordion dials as a client; the `context/update` frame carries the same
`ConductorView`, and you reply with the same `Command[]`. Local conductors advertise a
heartbeat file at `~/.accordion/conductors/<id>.json` so the desktop app auto-discovers them;
off-box ones are added by `ws://` URL in the header dropdown.

The runnable wire example is [`recency-folder/`](recency-folder/) (Node.js). The full
lifecycle and message reference is the second half of
[`docs/conductor-protocol.md`](../docs/conductor-protocol.md).

```bash
cd recency-folder
npm install
npm start        # listens on ws://127.0.0.1:7700, advertises under ~/.accordion/conductors/
```

Then open the Accordion desktop app, load a session, and pick **Recency folder** from the
conductor dropdown in the map header. The selection is global — it applies to whatever
session is currently active.

## Layout

| path                  | what                                                                 |
|-----------------------|----------------------------------------------------------------------|
| [`contract/`](contract/) | The contract, dependency-free: `conductor.ts` (the in-process `ConductorView` / `Command` / `Conductor`) + `protocol.ts` (the WebSocket messages, which import `Command`/`ViewBlock` so there's one definition). |
| [`builtin/`](builtin/)   | The default conductor (`builtin.ts`) — the worked example. |
| [`index.ts`](index.ts)   | The in-process registry (`IN_PROCESS_CONDUCTORS`). Add a line; it appears in the switcher. |
| [`recency-folder/`](recency-folder/) | The runnable out-of-process (WebSocket) example. |

## Conductors here

| directory | language | in/out of process | what it does |
|-----------|----------|-------------------|--------------|
| [`builtin/`](builtin/) | TypeScript | in-process | **The default + reference.** Folds purely to keep the live context under budget, oldest-first, lowest-value-kind-first (`tool_result` → `thinking` → `text` → `tool_call` → `user`). ~15-line `conduct`; golden-tested byte-identical. |
| [`recency-folder/`](recency-folder/) | Node.js | out-of-process (WS) | **Wire example.** Folds the oldest non-protected `tool_result` blocks until under budget, and auto-advertises for discovery. Intentionally crude — copy it and grow your own. |

**Convention:** give your conductor its own subdirectory here, pick a stable `id`, and either
register it in-process (`index.ts`) or — for the WS escape hatch — advertise a registry file
(local) / hand out a `ws://` URL (remote).
