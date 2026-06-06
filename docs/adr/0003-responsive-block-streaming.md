# ADR 0003 — Responsive, trustworthy live blocks (durable ids + committed streaming + forming ghosts)

**Status:** proposed
**Date:** 2026-06-05
**Builds on:** [ADR 0001](0001-pi-live-integration.md) (the fold loop / wire protocol) and
[ADR 0002](0002-pull-connection-model.md) (discovery). The wire protocol of 0001 is
*extended* here (new id scheme, one new server→client frame); the fold loop and its
passthrough guarantees are unchanged.

## Context

The live view updates only at pi's `context` hook (before each model call) and, since
the `agent_end` fix, once at loop end. Between those moments — while the model is
writing, while a tool runs — the grid is silent, then everything appears at once. For a
tool whose stated purpose is to be a **reliable, responsive source of truth** for an
agent's context, that silence is a defect: the user can't tell whether Accordion is
tracking reality or has stalled.

The naive fix — stream raw tokens into blocks — was rejected (see Rejected). It forces
blocks to mutate in place (a "patch" protocol verb, breaking the append-only model),
makes per-token token estimates jitter so the protected-tail boundary thrashes, and
floods a 982-tile grid with repaints CLAUDE.md explicitly warns against.

The deeper problem is **identity**. Today a block's id encodes its *position* in pi's
message array (`m<i>:p<j>`). A block that is still streaming is not yet in that array, so
its eventual id can only be *predicted*. A wrong prediction yields a phantom block — and
a self-healing phantom is still a moment Accordion showed something false. Reliability-
first rules out prediction-and-heal entirely.

## Decision

Three layers, foundation-first. Each is independently shippable and verifiable.

### 1. Durable, content-anchored block ids (the foundation)

Replace position-based ids with ids anchored on the block's *intrinsic* identity, so the
id a block gets when streamed early is **byte-for-byte identical** to the id it gets when
re-derived from pi's array. Then receiving the same block twice is a provable no-op, not
a duplicate.

Anchors (pi gives us durable identity for free on the tool axis only; the text axis we
synthesize):

| block | id | anchor source |
|---|---|---|
| user | `u:<timestamp>` | `UserMessage.timestamp` |
| assistant part `j` — text / thinking / **tool_call** | `a:<responseId ?? "t"+timestamp>:p<j>` | `responseId` if present, else `timestamp`; `j` is the stable part index |
| tool_result | `r:<toolCallId>` | provider id — durable |
| summary / other | `s:<timestamp>` | message `timestamp` |

A tool_call is an assistant content part, so it takes the assistant-part id like text/thinking
(its provider `toolCall.id` is still carried in the block's `callId` field, which is what pairs
it with its `tool_result` — pairing never depends on the block id). Durable identity is "free"
on the tool-result axis (`toolCallId`) and synthesized from `responseId`/`timestamp` elsewhere.

`blockId(message, partIndex)` becomes a single helper in `mapping.ts`, used by **both**
`linearize` and `applyPlan`, so the two can never compute an id differently. `applyPlan`'s
structure is unchanged — it still recomputes each block's id while walking the array and
matches the ops map; only the id formula moves into the shared helper.

This is the prerequisite ADR 0001 recorded for M2 (folding/compaction makes the array
non-append-only, which re-keys every positional id). The responsiveness requirement and
the M2 folding requirement need the *same* foundation; we build it now.

### 2. Committed streaming (block appears the instant pi finishes it)

The extension adds a `message_end` handler that linearizes the just-finished message and
sends its new blocks as a **view-only sync** (same shape as the existing `agent_end`
path: no fold plan awaited — folding may legally happen only at `context`). It shares the
`sentCount` cursor with `context`/`agent_end` so deltas never overlap. The GUI **upserts
by id** (layer 3 below), so the authoritative full-array reconcile at the next `context`
is idempotent and silently corrects any incremental mistake.

Streaming-for-speed, reconcile-for-truth, durable ids making them agree.

### 3. Forming ghosts (presentation-only sub-block liveness)

While a block is being generated — before it finishes — show a deliberately distinct
**pulsing placeholder** at the grid's live edge, colored by kind. It carries **no content
and no token count**. It is the honest, weaker claim "pi is generating a block of this
kind, right now," which is always true at the moment it is shown — not the false claim
"this block exists with this content."

- **Origin → wire.** Stream lifecycle fires in the extension (`message_update`'s
  `assistantMessageEvent`: `text_start`/`thinking_start`/`toolcall_start` → spawn;
  `*_end` → resolve; `error`/`aborted` → clear). The extension forwards only **start /
  end / abort** phases over a new `stream` frame (kind + contentIndex + phase, **never
  content**). The token-delta firehose is consumed *and throttled at the source* — deltas
  never cross the wire; the pulse is a CSS animation that needs no per-token nudge.
- **Engine purity.** A ghost is **never** an entry in `store.blocks` and never on the
  block wire. It lives only in GUI presentation state, keyed by `contentIndex`, rendered
  as a third visual state alongside solid-live and recessed-folded. The engine continues
  to hold only committed, complete, durable blocks (CLAUDE.md: "engine is the source of
  truth — the UI only renders it").
- **Resolution.** When the message's committed blocks arrive (layer 2, at `message_end`),
  the GUI clears that message's ghosts and the real durable blocks take their place.

## Safety / robustness invariants

1. **No window where the view is false.** Forming → pulsing ghost (true). Finished →
   committed durable block (true). Aborted → gone (true). The ghost's claim is always
   true at display time because it is driven directly by the live stream.
2. **Guaranteed teardown on every terminal path.** Every ghost spawned on `*_start` is
   cleared on its clean `*_end`, on `error`/`aborted`, and — as backstops — on
   `message_end`, `agent_end`, and GUI disconnect. Any ghost not resolved by its own end
   is swept at message/loop end. No ghost can pulse forever.
3. **Commit-to-real only on clean end, never on abort.** A ghost becomes a committed
   block only via the layer-2 path on clean completion. On `error`/`aborted` it only
   vanishes. Accordion never shows a committed block pi rolled back.
4. **Idempotent ingest.** `appendBlocks` dedups by id (preserving any user fold state on
   an existing id); receiving the same durable block from streaming and again from the
   reconcile is a no-op. The full-array reconcile remains the authoritative truth.
5. **View-only, never alters a model call.** Layers 2–3 are pure view sync; the only
   place messages are altered remains the `context` hook (ADR 0001). All passthrough
   guarantees are untouched.
6. **Wire compatibility.** New id scheme + new `stream` frame ⇒ `PROTOCOL_VERSION` → 2;
   `isServerMessage` gains `"stream"`. Extension and app share `protocol.ts`, so they
   version together; `hello.protocolVersion` lets a mismatched pair refuse cleanly.

## Implementation phases (each independently verifiable)

- **Phase 0 — Verify the load-bearing assumption.** Smoke-test that an anchor
  (`responseId`, else `timestamp`) is (a) **present on the streaming `partial`** and (b)
  **identical when the message lands in the array**. Whichever field satisfies both
  becomes the anchor. *Gate: if neither is stable, fall back to a content-hash anchor —
  decision point before proceeding.*
- **Phase 1 — Durable ids.** Extract `blockId()`; switch `linearize` + `applyPlan` to it;
  bump `PROTOCOL_VERSION`. Behavior unchanged (still M1 empty plan). *Verify: adapt the
  14 existing tests + new id-stability tests; `smoke.mjs`; `svelte-check` 0/0/0.*
- **Phase 2 — Idempotent ingest.** `appendBlocks` → dedup-by-id, preserving fold state.
  *Verify: store tests for dedup + fold-state preservation.*
- **Phase 3 — Committed streaming.** Extension `message_end` view-only sync sharing the
  cursor; GUI upserts. *Verify: smoke asserts a `message_end` sync arrives before the
  next `context`, with no duplicate blocks after the following reconcile.*
- **Phase 4 — Ghost layer.** New `stream` frame; extension forwards start/end/abort; GUI
  renders the pulsing third state at the live edge with guaranteed teardown. *Verify:
  smoke asserts spawn→clear, teardown on simulated abort, and that no ghost survives
  `message_end`; ghost never appears in `store.blocks`.*

## Scope / limitations (this change)

- **Ghosts show liveness, not content.** A long-writing block pulses but does not reveal
  its text mid-stream; that is the intended ceiling for a *block-structure* visualizer.
- **`tool_execution_*` not consumed here.** A long-running tool's progress is out of
  scope; the tool_call block commits at `message_end` and its result at the next
  `context`/`message_end`. A tool-execution liveness ghost is a natural follow-up.
- **Committed streaming is per-message (`message_end`), not per-part.** Per-part `*_end`
  committed streaming (so a finished thinking block commits while text still streams) is a
  defined enhancement that durable ids already make sound — deferred to keep wire traffic
  and surface area down.
- **Timestamp-collision edge.** Two messages in the same millisecond would collide on a
  `timestamp` anchor; `responseId` (per response) avoids it on the assistant axis. A
  short content-hash tiebreaker is the defined hardening if it is ever observed.

## Rejected alternatives

- **Stream raw tokens into blocks** — rejected: forces in-place block mutation (a patch
  verb, breaking append-only), jittery per-token token counts that thrash the protected
  tail, and a per-token repaint storm on the tile grid. The ghost extracts the only
  useful bit from the token firehose ("something is forming here, now") and discards the
  rest.
- **Predicted positional ids + heal on reconcile** — rejected by the reliability
  requirement: a mispredicted id produces a phantom block, and a self-healing phantom is
  still a moment Accordion showed something false.
- **Put ghosts in the engine `blocks` array (flagged/excluded from accounting)** —
  rejected: pollutes the source of truth with provisional view state; keeping ghosts a
  pure presentation concern preserves "the engine holds only committed blocks."
- **Forward token deltas over the wire to drive the pulse** — rejected: hundreds of
  frames per reply for a signal a CSS animation already provides; start/end/abort is
  sufficient, and stall detection (if ever wanted) needs only a throttled heartbeat.
