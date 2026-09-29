# keel-note

[keel-lite](../keel-lite/)'s synchronous budget keeper, plus a small model-written progress note
that survives every trim. A collaborative, in-process conductor with no locks.

## Why

In the 2026-09-28 SlopCode bench (DeepSeek V4 Flash, 40k budget), keel-lite held its budget on
every turn. In one of three seeds, though, the agent stalled once its oldest turns were folded. It
lost continuity and started calling itself "the previous agent (me)" 216 times.

compaction-naive kept continuity, because its summary is the agent's memory. It was over budget on
12–17% of turns, though: an async summary lags a step that can add about 15k tokens.

keel-note keeps the part that must be synchronous, the trim, exactly as keel-lite does it. It moves
the memory into a small note that a model call refreshes off the hot path.

## How

**Composition.** keel-note wraps an unmodified `KeelLiteConductor`, attached to a thin proxy of the
real host. The proxy changes three things:

- It reports `stats().liveTokens`, and the `liveTokens` carried by events, as `real + reserve`,
  where `reserve = max(0, noteMaxTokens − carrier cost)`. From the first turn on, keel-lite plans
  against a context that already holds a full-size note, whether or not one exists yet.
- It reports the carrier block as `held`, so keel-lite never folds, trims, groups or adopts it.
- It records which blocks each of keel-lite's applied epochs dropped (folded, replaced or grouped),
  and copies their original text at trim time.

A landed note costs at most `noteMaxTokens`, so landing one never changes `real + reserve`. A note
can land late, even the turn right after a trim, and still never push the context past what
keel-lite already made room for. Before the first note exists, the reserve costs about 600 tokens
of headroom and nothing on the wire.

**The carrier.** A conductor cannot insert blocks, so the note rides on an existing one. The
carrier is the first assistant `text` or `thinking` block after the first user message (the task)
that has left the protected tail. keel-note prefers a `text` part of that message if it has one. In
SlopCode, the carrier is the agent's one-line first thought ("Let me start by reading the briefing
file.").

A note lands as a non-recoverable `replace` of the carrier. The content is verbatim, with no
`{#code FOLDED}` handle, and hard-capped at `noteMaxTokens` including block overhead. If the model
writes more, `fitNote` drops the oldest "Built & verified" / "Tried and failed" bullets first, then
whole lines from the end, then characters. If a human takes the carrier, the note moves to the next
usable block.

**Refresh triggers.**

1. An applied keel-lite epoch that dropped content the note has not seen yet.
2. A fallback after `fallbackTurns` turns with no trigger. It is fed the most recent blocks the note
   has not seen.

While an update is in flight, new spans accumulate. When the update lands, one follow-up call is
chained. The pending buffer keeps only the most recent `spanMaxTokens` tokens. Each block is clipped
head and tail, sent to the note model once, and paired with its tool call for context.

**The update call** goes through `host.complete`, which uses the live session's model and route and
is logged by the extension's completion-usage log. The input is the previous note plus the dropped
span(s), wrapped in `<previous-notes>` and `<my-earlier-turns>`. The system prompt frames those
turns as the agent's own earlier work in this same session and forbids "the previous agent". The
output is five terse first-person sections under a fixed header:

```
My progress notes (written by me, earlier in this same session; older turns were trimmed from my context):
Current goal / checkpoint:
Built & verified:
Tried and failed:
Current failing test / error:
Next step:
```

**Async landing.** A finished note waits and lands at whichever comes first:

- the next `turn-committed`, before keel-lite evaluates that turn;
- right after an applied keel-lite epoch.

The old note stays until then. A failed, empty or timed-out call keeps the old note, logs the error
in the status line, and puts its spans back in the buffer for the next trigger. The agent loop never
waits for a note.

**Cache cost.** Rewriting the carrier invalidates the provider's prompt cache from the carrier on,
which is nearly the whole context, because the carrier sits right after the task. Each landing
therefore re-bills about one full context as uncached input. Two knobs trade note freshness for
fewer busts:

- With `landDelayTurns > 0`, a finished note waits up to that many turn boundaries for the next
  epoch, so the two cache busts coincide.
- With `minLandGapTurns > 0`, fresh landings are spaced at least that many turns apart. The first
  note is exempt. Updates keep running meanwhile, each one building on the waiting note, and the
  newest one lands.

Both knobs default to 0, which lands every note at the next boundary.

In a replay of the three keel-lite bench sessions, the note model was stubbed. Landing every note
raised uncached main-context input by 130–146% over keel-lite, and the note calls added about 1M
more input tokens. Setting `landDelayTurns: 10, minLandGapTurns: 20` cut the uncached increase to
31–45%. Every configuration had 0% of requests over budget.

## Knobs

Constructor options (`KeelNoteOptions`, defaults in `KEEL_NOTE_DEFAULTS`):

| option | default | meaning |
|---|---|---|
| `keel` | keel-lite defaults | keel-lite's own knobs (HIGH/LOW band, ladder) |
| `noteMaxTokens` | 600 | hard cap on the landed note, block overhead included; also the reserve |
| `fallbackTurns` | 30 | refresh after this many turns without a trim |
| `spanMaxTokens` | 12000 | the pending span buffer keeps the most recent this-many tokens |
| `blockMaxTokens` | 1500 | each captured block is clipped head and tail to about this size (tool calls: 300) |
| `minSpanTokens` | 400 | a trim starts a call only once this many span tokens are pending |
| `timeoutMs` | 90000 | abandon a note call after this long; the old note stays |
| `landDelayTurns` | 0 | a finished note may wait this many turn boundaries for an epoch |
| `minLandGapTurns` | 0 | fresh landings are at least this many turns apart (the first is exempt) |

The registry factory reads these from the environment. Invalid values are ignored.

| variable | range |
|---|---|
| `ACCORDION_KEEL_NOTE_MAX_TOKENS` | integer ≥ 64 |
| `ACCORDION_KEEL_NOTE_FALLBACK_TURNS` | integer ≥ 1 |
| `ACCORDION_KEEL_NOTE_SPAN_TOKENS` | integer ≥ 500 |
| `ACCORDION_KEEL_NOTE_LAND_DELAY_TURNS` | integer ≥ 0 |
| `ACCORDION_KEEL_NOTE_MIN_LAND_GAP_TURNS` | integer ≥ 0 |

keel-lite's `ACCORDION_KEEL_LITE_HIGH` / `_LOW` also apply.

## Status

The status line is keel-lite's, followed by `note: N refreshes` and `updating`, `ready` or the last
failure. The metrics add these fields:

- `note_refreshes`, `note_calls`, `note_failures`, `note_fallbacks`, `note_reasserts`
- `note_input_tokens` / `note_output_tokens`, where `note_tokens_estimated` marks counts estimated
  locally because the route reported no usage
- the pending and discarded span tokens
- the carrier id

## Limits

- The cap is enforced at the calibration in force when the note lands. Calibration follows the
  whole context's real-to-estimated token ratio, which ranged from 1.1 to 1.5 in the bench
  sessions, so a landed 600-token note later measured up to 689. keel-lite always sees the
  carrier's current cost, so this drift never breaks the budget.
- The carrier is a `thinking` block when the first reply has no text. DeepSeek re-sends reasoning
  within a single user turn, which covers a SlopCode session. A provider that drops reasoning from
  before the latest user message would hide a thinking-borne note once a second user message
  arrives.
- The note is only as good as the model call. The tests and replay use a stub, so how well the
  prompt preserves continuity is untested until a real run.
