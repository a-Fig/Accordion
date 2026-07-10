# ADR 0020 — `passthrough`: acking every `context` hook outcome back to the GUI

**Status:** accepted
**Date:** 2026-07-09
**Builds on:** [ADR 0018](0018-conductor-birth-fold.md) (the birth-fold exemption and its `markSent`
cursor — the mechanism this ADR's reconciliation calls into), issue #58 (the stale-plan fallback:
a timeout re-applies the last known plan instead of shipping raw) and its follow-up #61
(steering mode + plan RTT), which is where the observability gap below was first named but
deliberately left open.

## Context

`extension/accordion.ts`'s `context` hook has always had more outcomes than "apply the GUI's
plan": no GUI attached, the reply timing out, a GUI reconnect superseding the in-flight request,
the socket dropping mid-wait, and (post-#58) a timeout falling back to a **stale** cached plan.
Every one of those branches returned `undefined` (or the stale-applied messages) and the GUI never
found out. Two concrete costs of that silence:

1. **No visibility for anyone.** A benchmark rig (bellows) polling for "how much of this session
   actually got folded" had nothing to poll — the extension's own state was the only place that
   knew, and it never left the process. #58 contamination — a stale-plan fallback silently
   diverging from what the GUI's engine believed it sent — was diagnosed by reading logs after the
   fact, not by anything either side could check live.
2. **A real correctness gap in birth-fold bookkeeping.** `liveClient.svelte.ts` calls
   `session.store.markSent({ rawWire: !folding.enabled })` the instant it **replies** to a planned
   sync — on the assumption that its reply is what rides the wire. On a timeout that assumption is
   false: the extension applied the *stale* plan (or nothing), not the fresh one the GUI just
   computed. A block the GUI's fresh plan folded — believing the model would never see it whole —
   could ride the wire unfolded via the stale plan, while the birth-fold exemption survives
   (ADR 0018's sticky `birthFolded` set has no way to learn its assumption was wrong). This was
   called out as a known, unfixed gap in the stale-fallback code comment (search "Known gap
   (pre-existing on both parents, issue #60)" — now resolved, comment updated in the same commit
   as this ADR).

## Decision

### 1. A cause taxonomy for every `context` hook resolution

Every `context` hook invocation resolves to **exactly one** of seven causes
(`PlanOutcomeCause` in `accordion.ts`):

- `applied` — the GUI's non-empty plan was applied.
- `empty-plan` — the GUI intentionally replied with no folds (a real success, not a failure —
  this is the conductor's own decision, distinct from a miss).
- `timeout-stale` — the plan reply missed the wait; the last known plan was re-applied (#58).
- `timeout-raw` — the plan reply missed the wait and there was no usable cached plan; raw
  passthrough, same wire effect as `empty-plan` but caused by a miss, not intent.
- `no-gui` — no client attached at all.
- `epoch-mismatch` — a new client attached mid-wait, superseding the view the request was sent to.
- `unsent` — the socket dropped mid-wait with no reconnect (so there is no client to ack).

The last two have no reachable client to notify, so they are **counter-only**; the other five are
also acked to the GUI as a `passthrough` message (`PassthroughCause` in `protocol.ts` is the same
union minus those two).

### 2. The `passthrough` ack (wire, additive, no version bump)

`PassthroughMessage { type: "passthrough", reqId, cause, ops, groups, recalls }` — sent
fire-and-forget from `recordPlanOutcome` (never awaited; `send()` itself is try/catch-and-forget,
matching every other push in this file). `ops`/`groups`/`recalls` are the counts **actually
applied to the wire** for that call (0 for every raw/empty cause; for `applied` and
`timeout-stale`, the counts after applyPlan filtering of unmatched ids and straggler-demoted
groups; recalls = safe recalls only).

Follows the `armed`/`armedAck` precedent (protocol.ts's version-history comment): purely additive,
**no `PROTOCOL_VERSION` bump**. An old GUI simply drops the unknown message type and silently
keeps the pre-#60 behavior — there is no mixed-version hazard to force a bump over, since the
extension never requires a reply to this message.

`epoch-mismatch` is acked to the **current** client (whoever that now is), not dropped — it can
still count the outcome, even though the `reqId` belongs to the view it superseded. This is the
one cause where the ack's `reqId` does not correspond to anything the receiving client itself
sent.

### 3. Counters, not events: `/__accordion/meta`'s `planOutcomes`

Module-scoped, in-memory, per-extension-lifetime counters (`planOutcomeCounts`, mirroring the
existing `sentCount` pattern) — one per cause, plus `contextHookCount` (the total). **Never
persisted** (the context hook stays disk-I/O-free, a hard invariant) and **not reset on
`session_start`**: unlike `sentCount`/`epoch`/`lastPlan`, which describe the current session's
cursor and must not leak across a session swap, these are a running lifetime total whose
observability value survives a swap. Exposed as `planOutcomes` in the existing
`/__accordion/meta` HTTP response (ungated, same reasoning as the rest of that endpoint) — this is
the shape the bellows bench rig polls to see how much of a run actually rode the GUI's plan versus
a silent/fallback passthrough, without instrumenting pi itself.

Transition-only logging: a `console.warn` fires when a `context` hook resolves to a **silent**
cause (`no-gui`/`unsent`/`epoch-mismatch`) immediately after a **healthy** one (`applied`/
`empty-plan`/`timeout-stale`/`timeout-raw`) — not on every silent call, since every session
legitimately starts unattached and per-turn no-gui logging would be pure noise. The already-loud
timeout branches (`console.warn`/`console.error` with cause + reqId + elapsed) are untouched.

### 4. Birth-fold reconciliation on the GUI side

`liveClient.svelte.ts` tracks `lastPlannedReqId` — the `reqId` of the last planned sync it
replied to. On a `passthrough` ack:

- `timeout-stale` / `timeout-raw` **and** `msg.reqId === lastPlannedReqId` → call
  `session.store.markSent({ rawWire: true })` again. This is the correctness fix: the GUI's
  optimistic `markSent()` call (made at reply time, believing its plan would ride) is
  retroactively overridden — `rawWire: true` conservatively drops **every** birth-fold exemption,
  because the model may have seen any block from that call whole via the stale/raw fallback.
  `markSent`'s cursor advance is a `Math.max`, so calling it twice for the same call is idempotent.
- `epoch-mismatch` → counted, never reconciled — the ack is for a superseded view; the GUI that
  answers today has already rebuilt its store from scratch (a fresh attach) and has nothing to
  reconcile.
- An ack for any other `reqId` (unknown or older than `lastPlannedReqId`) → ignored for
  reconciliation, counted only. Since a WS connection processes one `context` hook at a time,
  reqIds and their acks arrive strictly in order, so an exact-match guard suffices — no
  "older-or-equal" comparison needed.

This relies on one ordering assumption, stated as a comment at the call site: WS delivery is FIFO
and the extension sends the ack strictly **after** the plan wait for that `reqId` resolves — i.e.
after the sync it answers and before the *next* planned sync — so reconciliation always lands
before this client's next `markSent()` call and can never race a later, legitimate exemption.

### 5. UI surfacing

`MapHeader.svelte` shows a small monochrome "wire N/M" readout (M = acked model calls seen this
connection, N = calls where the GUI's plan — or its intentional empty plan — actually applied,
i.e. `applied + empty-plan`) with a tooltip breakdown by cause. Gated on
`live.status === "connected" && total > 0`, following the existing pattern for live-only chrome
(the arm toggle, the READ-ONLY badge): hidden entirely for a browsing/read-only/demo session,
which has no wire at all. `#044EFF` (reserved for `user` blocks) is never used here.

## Non-goals

- **No cross-check against provider-reported usage.** This ADR counts *hook resolutions*, not
  tokens actually billed — it says nothing about whether `wireTokens`/the model's own usage report
  matches what the GUI believes it sent. That reconciliation (if ever wanted) is a separate,
  larger effort and out of scope here.
- **No bellows-side consumption.** This ADR ships the counters and the endpoint; how (or whether)
  the bellows bench rig ingests `planOutcomes` into its own dashboards is bellows' repo, not this
  one.
- **No change to the stale-plan fallback policy itself** (#58's decision to re-apply the last known
  plan on timeout stands untouched) — this ADR only makes that decision *observable*, on both the
  counter/log side and the GUI's own bookkeeping.

## Consequences

- **The GUI's birth-fold exemption can no longer silently outlive a call it assumed rode the wire
  but didn't.** The fix is conservative (drops every exemption, not just the affected block's) by
  design — precise per-block tracking of "which blocks did the stale plan actually differ on" would
  require diffing two plans against the live message array, disproportionate to a rare fallback
  path.
- **Every `context` hook outcome is now counted somewhere** — no branch is unaccounted for, and the
  five reachable-client causes are individually observable over the wire.
- **No protocol version bump, no breaking change** for any existing peer (GUI, headless bellows
  host, or a stale extension) — same reasoning as `armed`/`armedAck`.
- **The golden conductor test is untouched** — this ADR touches only the extension's outcome
  bookkeeping and the GUI's wire handling, never fold decisions themselves.

## Rejected alternatives

- **Only fix the birth-fold bug, skip the observability counters/UI.** Rejected: the same
  `passthrough` ack that lets the GUI reconcile birth-fold is the natural vehicle for counting —
  building the wire message just for internal reconciliation and not exposing it would waste the
  one thing bellows actually needs (see #58/#61's own after-the-fact log-reading pain).
  Additionally, this project would remain difficult to debug (both `no-gui` and `epoch-mismatch`
  are silent by construction) without the counters.
- **Precise per-block reconciliation** (diff the stale plan against the fresh plan and only drop
  exemptions for blocks that actually differ). Rejected as disproportionate: the stale-fallback
  path is already a rare, logged-loudly degradation; conservatively dropping the whole exemption
  set costs at most a few blocks' folding for one extra call, versus real implementation and
  testing cost for a narrow win.
- **Bump `PROTOCOL_VERSION` for the new message.** Rejected for the same reason `armed`/`armedAck`
  didn't: the strict version-mismatch check both peers already do would break every mixed-version
  pairing for a message that is purely additive and never blocks on a reply.
