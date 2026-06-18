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
- **`null`** — *hold*: reuse the previous non-null command batch (used by an async/remote
  conductor still thinking; never blocks a model call). The host still rebuilds from the raw
  baseline and enforces invariants, so new blocks not named in that batch arrive raw.

In-process conductors may also implement optional lifecycle hooks:

```ts
attach(host: ConductorHost): void
detach(): void
```

Use `attach()` only when you need a host service. Today that service is
`host.requestRerun()`: start async work outside `conduct()`, return `null` while it is in
flight, cache the finished command set, then call `requestRerun()` so Accordion schedules a
fresh synchronous `conduct()` pass. The host debounces bursts of requests and ignores stale
requests after the conductor is replaced.

The `Command` union is `fold · replace · group · restore · pin`. Most are **content
substitution** (a block is replaced in place, never removed), so a `tool_call`/`tool_result`
pair can never orphan. The one exception: a `group` command with `digest: null` or `digest: ""`
is a **DROP** — the run is removed from the wire entirely and no replacement is inserted. This
is the idiomatic way to implement hard deletion (e.g. `drop-oldest`). Phase A tool-pair
balancing still applies, so no orphaned pairs can result. The host enforces exactly one floor — **provider-validity** (the outgoing message
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
| [`builtin/`](builtin/)   | The default conductor (`builtin.ts`) — the minimal worked example. |
| [`cold-score/`](cold-score/) | Relevance-aware in-process conductor — ACT-R scoring + lexical pre-unfold + hysteresis. The second worked example. |
| [`garbage-collector/`](garbage-collector/) | Reachability-aware in-process conductor — mark-and-sweep from roots over entity/causal/message edges; folds unreachable blocks first. The third worked example. |
| [`index.ts`](index.ts)   | The in-process registry (`IN_PROCESS_CONDUCTORS`). Add a line; it appears in the switcher. |
| [`recency-folder/`](recency-folder/) | The runnable out-of-process (WebSocket) example. |

## Conductors here

> **This table may be out of date.** `ls conductors/` is the authoritative list.

| directory | language | in/out of process | what it does |
|-----------|----------|-------------------|--------------|
| [`builtin/`](builtin/) | TypeScript | in-process | **The default + reference.** Folds purely to keep the live context under budget, oldest-first, lowest-value-kind-first (`tool_result` → `thinking` → `text` → `tool_call` → `user`). ~15-line `conduct`; golden-tested byte-identical. |
| [`cold-score/`](cold-score/) | TypeScript | in-process | **Relevance-aware folder.** ACT-R cold-score ranking + lexical pre-unfold (keep blocks live whose identifiers appear in the protected tail) + per-block hysteresis cooldowns. Emits `fold` commands only. Instance state (recalls / cooldowns) accumulates across `conduct()` calls. See [ADR 0009](../docs/adr/0009-cold-score-conductor.md). |
| [`attention-folder/`](attention-folder/) | Node.js + Python | out-of-process (WS) | **Attention-based periodic folder.** A Qwen2.5-0.5B probe scores how much the current work tail attends to each older block; the conductor folds the least-attended blocks at deliberate "epochs" rather than every turn, keeping the inference prompt cache stable between folds. Hysteresis band: 70–90% of the context window. See [ADR 0010](../docs/adr/0010-attention-conductor.md) and its own [README](attention-folder/README.md). |
| [`sliding-window/`](sliding-window/) | TypeScript | in-process | **Hard-delete oldest non-user blocks.** A high-water/low-water band: when the agent-visible window crosses ~90% of budget it issues `group` commands with `digest: null` (DROP) over the oldest non-`user` blocks — skipping user messages, which stay live — down to ~70%, then **holds** (re-emitting the deletes) while the window refills. Carries a monotonic drop-set as instance state. Locks `human-steering` + `agent-unfold` (NOT `tail-size`). Known limitations (bounded, self-correcting straggler/snap overshoot): see [ADR 0006](../docs/adr/0006-multiblock-folds.md#known-limitations-sliding-window). |
| [`garbage-collector/`](garbage-collector/) | TypeScript | in-process | **Reachability-based folder.** Treats context as a managed heap: roots = protected tail + human-held + the first `user` message; a reference graph (entity identifiers shared with cold-score's extractor, `callId` causal pairs, same-message id-prefix links) seeds a mark phase, and the sweep folds UNREACHABLE candidates first, falling back to reachable ones only under budget pressure. Collaborative (no locks). See [ADR 0012](../docs/adr/0012-garbage-collector-conductor.md). |
| [`recency-folder/`](recency-folder/) | Node.js | out-of-process (WS) | **Wire example.** Folds the oldest non-protected `tool_result` blocks until under budget, and auto-advertises for discovery. Intentionally crude — copy it and grow your own. |

### Garbage-collector conductor

[`garbage-collector/`](garbage-collector/) is a third in-process conductor — a
reachability-aware peer to the built-in and cold-score. Where the built-in folds
oldest-first and cold-score folds coldest-activation-first, the garbage collector folds
**unreachable-first**: it treats context as a managed heap and runs mark-and-sweep.

- **Roots** = the protected working tail + human-held blocks + the **first** `user`
  message (the original task statement). Only the first user message is a root — a
  mid-session user turn that has aged out of the tail is durable (never folded) but no
  longer anchors reachability, so work the agent has moved on from can go unreachable.
- **Reference graph** (`edges.ts`) — three bidirectional edge kinds, all derived from the
  pure `ConductorView`: **entity** edges (blocks sharing a distinctive file/symbol
  identifier, extracted via cold-score's `extractIdentifiers` so the two relevance-aware
  conductors agree on what a "symbol" is), **causal** edges (`tool_call`/`tool_result`
  sharing a `callId`), and **message** edges (assistant parts sharing an id prefix). Entity
  edges are rarity-guarded and chained (not cliqued) — reachability is preserved, edge count
  stays linear.
- **Mark then sweep** — mark every block reachable from the roots; fold candidates are
  ordered unreachable-first, then by the built-in's kind-rank and age within each tier, and
  folded greedily until the live context fits the budget. If unreachable blocks don't
  suffice, reachable ones follow — the **budget guarantee is the hard invariant**;
  reachability is the ordering, not a veto.

It is **collaborative** (no involvement locks — reachability is a relevance signal, not a
claim of authority), carries **no instance state** (the graph is recomputed from the view
each pass, so it is fully deterministic), and emits only `fold` commands. See
[ADR 0012](../docs/adr/0012-garbage-collector-conductor.md). The imaginarium's
generational refinement (nursery / old gen / tenured) is future work.

### Cold-score conductor

[`cold-score/`](cold-score/) is a second in-process conductor — a relevance-aware peer to
the built-in. Where the built-in treats all blocks of the same kind and approximate age as
interchangeable, the cold-score conductor adds:

- **ACT-R activation scoring** — blocks the agent has retrieved recently (via lexical
  pre-unfold) decay more slowly, so they fold last.
- **Lexical pre-unfold** — before the greedy clamp finalises, any just-folded block whose
  symbols/paths appear in the protected tail is restored and put on a cooldown (at most 4
  per pass; longest identifier wins).
- **Hysteresis** — a pre-unfolded block cannot be auto-refolded for 5 turns.

The conductor emits only `fold` commands. Auto-coalesce (collapsing long cold runs into
`group` stubs) is a planned follow-on; see the roadmap
([`docs/conductor-rework-roadmap.md`](../docs/conductor-rework-roadmap.md), C1.5) for why
it requires aligning runs to whole-message boundaries and modelling the host's straggler
cost before it is safe to emit.

It is the **second worked example** alongside the built-in — read it to see what instance
state and a multi-pass pipeline look like in a real in-process conductor. The built-in's
golden test is untouched.

### Async in-process conductors

`conduct()` must remain synchronous, but an in-process conductor can bridge to async work by
using the optional host hook:

```ts
import type { Command, Conductor, ConductorHost, ConductorView } from "../contract";

export class AsyncSummaryConductor implements Conductor {
  readonly id = "async-summary";
  readonly label = "Async summary";
  private host: ConductorHost | null = null;
  private desired: Command[] | null = null;
  private inFlight = false;
  private generation = 0;

  attach(host: ConductorHost): void {
    this.host = host;
    this.desired = null;
    this.generation++;
  }

  detach(): void {
    this.host = null;
    this.desired = null;
    this.inFlight = false;
    this.generation++;
  }

  conduct(view: ConductorView): Command[] | null {
    if (this.desired) return this.desired;
    if (!this.inFlight) {
      this.inFlight = true;
      const host = this.host;
      const generation = this.generation;
      void summarizeLater(view).then((commands) => {
        if (this.generation !== generation || this.host !== host) return;
        this.desired = commands;
        this.inFlight = false;
        host?.requestRerun();
      });
    }
    return null; // hold the previous state while the async work runs
  }
}
```

The important rule is that async completion never mutates the store directly. It only updates
the conductor's own cache and asks the host to re-enter `conduct()`.
If you store the host on `this`, guard async completions with a conductor-local generation
like the example above: Accordion ignores stale host objects, but a reused conductor instance
must also avoid letting an old promise write into its new attachment.

**Convention:** give your conductor its own subdirectory here, pick a stable `id`, and either
register it in-process (`index.ts`) or — for the WS escape hatch — advertise a registry file
(local) / hand out a `ws://` URL (remote).
