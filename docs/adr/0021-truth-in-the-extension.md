# ADR 0021 — Truth in the extension: the Phase B architecture inversion

**Status:** accepted (Phase B)
**Date:** 2026-07-17
**Builds on:** [ADR 0001](0001-pi-live-integration.md) (the live link — "GUI drives, extension is
thin"; the pull discovery model this ADR's registry/HTTP surface keeps unchanged), [ADR 0005](0005-agent-unfold.md)
(the agent `unfold` tool — resolved GUI-side there, extension-side here), [ADR 0011](0011-conductor-involvement-locks.md)
(the `recall` tool and the involvement-lock vocabulary, both carried into `core/locks.ts`
unchanged), [ADR 0020](0020-plan-applied-ack.md) (the `passthrough` ack + plan-outcome taxonomy
this ADR retires wholesale).
**Supersedes:** the plan-round-trip protocol (`sync`/`plan`, `unfoldRequest`/`unfoldResult`,
`recallRequest`/`recallResult`, `armed`/`armedAck`, `passthrough`) described across ADR 0001,
0005, 0007, 0011, 0018–0020, protocol versions up to v10.

## Context

Through protocol v10, the GUI (the Tauri app) held the one authoritative copy of a live session's
fold state. Pi's `context` hook — which fires synchronously, immediately before every model call —
had to ask the GUI what to send: it sent a `sync`, waited up to a fixed timeout for a `plan` reply,
and applied whatever came back (or the last cached plan on timeout, or raw passthrough if nothing
was cached). That round trip is where several structural costs came from at once:

- **A hard timeout on the model-call path.** The wait was bounded (historically 250ms) because a
  hung GUI must never hang the agent — but a bounded wait on an unbounded IPC (a webview process,
  a WebSocket, a human's laptop under load) is itself a reliability liability, and its overrun path
  (stale-plan fallback, ADR 0020 §context) needed its own taxonomy, counters, and reconciliation
  logic just to stay honest.
- **A one-turn view lag.** The GUI only learns about an assistant reply at the *next* `context`
  hook, because the sync/plan exchange is the only wire path — there was no separate "here's what
  just happened" push.
- **GUI-dependent agent tools.** `unfold` and `recall` (ADR 0005, ADR 0011) resolved against the
  GUI's store, so an agent running with no GUI attached had no working fold-recovery tools at all.
- **A pile of machinery whose only job was making the round trip survivable**: plan caching,
  timeout/deadline knobs, an `armed`/`armedAck` handshake, and the `passthrough` cause taxonomy
  (ADR 0020) that existed specifically to make the round trip's failure modes observable.

The insight behind Phase B: none of this is inherent to folding context. It is inherent to putting
the authoritative state on the *far side of an IPC boundary* from the hook that needs it
synchronously. Move the authoritative state into the same process as the hook, and the round trip
— and everything built to tolerate it — disappears.

## Decision

### 1. `Truth` moves into the pi extension process

`core/truth.ts`'s `Truth` class — the block log, the per-block overlay (`override`/`autoFolded`/
`subst`/`by`), multiblock groups, the protected working tail, the involvement locks, the
budget/context-window dials, the monotonic `rev` counter, and the `sentThroughOrder`/`birthFolded`
bookkeeping — is framework-free, dependency-free TypeScript. It previously ran only inside the
app's Svelte store; it now runs, *the same class*, as the authoritative in-process state of
`extension/accordion.ts`. There is exactly one `Truth` instance per live pi session, owned by the
extension, and the GUI is no longer where fold decisions live.

### 2. The `context` hook becomes a local, synchronous operation

`extension/accordion.ts`'s `context` handler does no IPC and no disk I/O. Per invocation:

1. **Reconcile.** `ingestMessages` compares pi's `event.messages` against the last-seen array by a
   cheap durable-id walk (`sameMessageIdentity`, comparing each message's block ids via
   `messageInfo`). If it is the prior array plus a new suffix, only the suffix is linearized and
   appended (`appendSuffix` — O(Δ) text work, not O(n)); if it diverges structurally (compaction,
   fork, tree-nav, another extension rewriting `event.messages`), the Truth is rebuilt from scratch.
2. **Wire-departing hold.** A named no-op seam (`// PHASE C: wire-departing hold`) where a
   conductor's last-moment fold plugs in — nothing occupies it yet (see ADR 0022).
3. **Serialize, if armed.** If `foldingEnabled` (opt-in, off by default), `truth.serializeWire`
   folds the outgoing messages and pi sends that; otherwise the hook returns `undefined` and pi's
   own messages pass through untouched.
4. **`markSent`.** The Truth's `sentThroughOrder` cursor advances to the newest block now known to
   have reached the model — the mechanism ADR 0023 depends on.

The whole guarded body is wrapped in a `try`/`catch`: any throw (a bad parse, an unexpected message
shape, a Truth bug) is counted (`hookErrors`) and falls back to passthrough rather than breaking
the model call — the hook must never be the reason a turn fails. In practice the hook runs in
sub-millisecond time; a telemetry ring (`hookDurations`, bounded to 256 samples) tracks
`lastHookMs`/`maxHookMs`/`p95HookMs`, streamed to clients after every hook and surfaced by
`MapHeader.svelte`'s LATENCY badge. The badge's thresholds are inherited from the old plan
timeout's meaning, not arbitrary: neutral/green under 250ms, amber ≥250ms, red ≥1000ms — a local
hook is expected to run far under the bound the old round trip needed, so crossing it at all is
worth flagging.

`message_end` appends each just-finished assistant/tool message to the Truth **immediately** (not
at the next `context` hook) — this is what eliminates the one-turn lag. Pi's
`agent_end.messages` array contains only messages generated by that run, so `agent_end` replays
those messages through the same idempotent append path as a backstop for anything `message_end`
missed; it must never be treated as an authoritative full-session snapshot.

### 3. The GUI becomes a replica + remote control, not the source of truth

A connecting client receives `hello` (protocol version, session meta, role) then a full `snapshot`
(`core/replica.ts → serializeSnapshot`), from which it builds a **rev-aligned replica `Truth`**
(`hydrateSnapshot`, `Truth.adoptSnapshot`). Every subsequent Truth mutation on the extension side
emits a `TruthEvent`; `wireEventFromTruthEvent` maps it to a **replayable input**
(`appended`/`ops`/`config`/`locks`/`sent`/`reset`), stamped with the post-mutation `rev`, and
broadcasts it to every connected client. The client's `liveClient.svelte.ts` replays each event
through its own replica Truth (`session.store.replayEvent`) and asserts `replica.rev === event.rev`
— a mismatch, or a `reset` event, triggers a `resnapshot` request rather than attempting to patch
around the gap.

Human steering (fold/unfold/pin/setBudget/setProtect/the folding arm) is sent as a `command`
message over the wire (`AccordionStore.setCommandSink`); the extension applies it to the
authoritative Truth (which emits the resulting events to *every* client, including the one that
sent the command) and replies `commandResult` for clamp-UX purposes only. **There is no optimistic
apply on the client** — the replica's state moves only when the echoed event arrives. This is
deliberately simpler than a dual-write-then-reconcile design because the loopback round trip is
sub-millisecond in practice; optimistic apply exists to hide latency that Phase B does not have.

### 4. Agent `unfold`/`recall` resolve locally, with zero clients attached

`core/agentView.ts`'s `resolveUnfold`/`resolveRecall` run directly against the extension's Truth —
no wire round trip, no GUI dependency. The registered pi tools (`extension/accordion.ts`) call them
in-process and return a result in the same tool call. A `recall` additionally broadcasts a
`RecallObservationMessage` so an attached client/conductor can observe the read (no Truth state
changes, so it carries no `rev` and is not a `WireEvent`).

### 5. Structural divergence forces a rebuild — without losing state

A divergence (tree-nav, compaction, another extension rewriting `event.messages`) still requires
building a fresh Truth from the reconciled block log, since block identity and order can both
shift. The rebuild path is `Truth.rebuildFrom(prev, parsed)`: it constructs the fresh Truth, then —
unless `prev` is null (the very first build of a session) — carries over every surviving block's
overlay (`override`/`autoFolded`/`by`/`subst`), `birthFolded` membership, the scalar dials (budget,
protect target, locks, tail tokens), and any group whose members *all* survive. This was a real
review-caught defect: an earlier version of `buildTruth` constructed a bare `new Truth(...)` on
every divergence, silently dropping every human/host fold, pin, group, and dial — even for block
ids that survived untouched. `extension/accordion.ts`'s `buildTruth`/`rebuildTruth` now call
`Truth.rebuildFrom` and only re-snap the budget to the model's context window on the *first* build
(`if (!prev) t.setBudget(contextWindow)`), so a rebuild never silently overwrites a human's custom
budget. A divergence rebuild is counted (`rebuilds`, in telemetry) and forces every connected client
to resnapshot rather than attempt to replay across the gap.

### 6. The involvement-lock vocabulary lives in `core/locks.ts`, engine-side

The `human-steering`/`agent-unfold`/`tail-size` lock names, their labels, and the `hasLock`/
`isExclusive` predicates ([ADR 0011](0011-conductor-involvement-locks.md)) moved into the
dependency-free `core/` package so the extension's Truth and the app's mirror gate on one
definition. `Truth.setLocks`/`clearLocks` are the only way lock state changes; nothing calls them
in Phase B outside of tests — see [ADR 0022](0022-conductor-contract-v2.md) for who eventually will.

### 7. WS auth model is unchanged

The loopback-only bind, the per-session token, and the Origin verification rules (native/Tauri
origins trusted, a served browser's bearer or exact-origin cookie, a cross-session dial accepted
only after a live registry-matching probe) are untouched by Phase B — hardened separately in
PR #72 and carried forward as-is. Phase B changes *what* rides the wire (events/commands instead of
sync/plan), not *who* is allowed to open it.

## Consequences

- **`PROTOCOL_VERSION` is 12.** v11 was the initial Phase B cut (`hello`/`snapshot`/`event`/
  `telemetry`/`commandResult`/`folding`/`recall`/`stream`, `command` client→server); v12 added
  `birthFolded` to `SnapshotState` (see below) and `resnapshot` to the client-message set. A
  strict `protocolVersion !== PROTOCOL_VERSION` check on both peers refuses a mismatched pairing
  rather than silently misbehaving.
- **The one-turn view lag is gone.** `message_end` streams finished blocks the instant they exist.
- **The old plan-timeout machinery is deleted wholesale**, not merely bypassed: the
  `ACCORDION_PLAN_TIMEOUT_MS`/`ACCORDION_PLAN_DEADLINE_MS` knobs, plan caching, the
  `armed`/`armedAck` handshake, and the `passthrough` cause taxonomy of ADR 0020 have no Phase B
  equivalent — there is no round trip left for them to describe. `/__accordion/meta` reports hook
  telemetry (`hookCount`/`lastHookMs`/`maxHookMs`/`p95HookMs`/`rebuilds`/`hookErrors`) in place of
  `planOutcomes`.
- **Agent `unfold`/`recall` work with no GUI attached at all** — a real capability change, not just
  an implementation detail, since they used to hard-depend on a connected client.
- **Two review-driven hardenings shipped in the same fix wave as this ADR:**
  1. **`birthFolded` now rides the snapshot.** Without it, a replica hydrated after a strategy
     birth-folded a block (ADR 0023) started with an empty birth-fold set, so its very next
     housekeep would heal the block locally while the host still kept it folded — a divergence
     `rev` bookkeeping alone can't catch, since both sides still bump by exactly one. This is the
     reason for the v11→v12 bump.
  2. **Overlay and dials survive a divergence rebuild** (`Truth.rebuildFrom`, §5 above) — a
     surviving block id keeps its fold/pin/group state and the session keeps its human-set budget
     and protected-tail size across a rebuild, instead of both being silently wiped.
- **The GUI's role is now purely observational + remote-control** — it renders whatever the
  extension's Truth says and sends commands, but it can no longer be the reason a fold decision is
  inconsistent with what the model actually saw, because there is only one decision-maker.

## Rejected alternatives

- **Incremental-protocol-in-GUI: keep the GUI authoritative, make the round trip cheaper.**
  Rejected: the round trip itself — not its latency — is the root cause of the timeout machinery,
  the one-turn lag, and the GUI-dependence of the agent tools. A faster timeout still needs a
  timeout, still needs a stale-plan fallback, and still leaves `unfold`/`recall` unusable without a
  GUI. Moving the authority, not tuning the wait, is what removes the failure modes rather than
  narrowing them.
- **Truth-less event projection for the replica** (have the client rebuild its view from a stream
  of derived facts — "block X is now folded" — rather than replaying Truth-shaped inputs through
  its own Truth instance). Rejected after review: derived-fact events are insufficient to
  reconstruct exact accounting (group token math, birth-fold eligibility, protected-tail
  boundaries) without re-deriving the same logic a second time on the client, which is exactly the
  drift risk a single source of truth exists to avoid. Replaying the *same* `Truth` class client-side
  guarantees the replica's arithmetic can never diverge from the host's by construction.
