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

A placed note costs at most `noteMaxTokens`, and `real + reserve` equals everything but the
carrier plus `noteMaxTokens`, whichever block holds the note. Moving the note therefore shifts
keel-lite's number only by the two blocks that change hands: up by at most one thinking digest or
one small text block, and down when the note overwrites a large thinking block. Before the first
note exists, the reserve costs 600 tokens of headroom and nothing on the wire.

**The carrier sits at the trim boundary.** Rewriting a block invalidates the provider's prompt
cache from that block on. Every keel-lite epoch already invalidates it from its first change on, so
the note goes where the next epoch will start anyway. A conductor cannot insert blocks, and Truth
never lets it edit a `user` block (`not-foldable`); a tool result would pass the note off as tool
output. So the note rides on an existing assistant block:

- The **boundary** is the oldest live `thinking` block outside the protected tail that a fold would
  shrink. keel-lite restarts every epoch at rung R1 (thinking, oldest first), so the next epoch's
  first change is usually at or before it. The exception is rung R0, which runs before R1 and
  re-asserts one of keel-lite's own lapsed decisions (for example a fold the protected tail
  healed). That can make the first change earlier. It costs cache, never budget.
- The **carrier** is the first usable block after the boundary. That is either an unsigned
  `thinking` block, which the note overwrites, or a live assistant `text` block of at most 150
  tokens (and at most a quarter of the cap). A text block keeps its words, with the note appended.
- When no such thinking is left outside the tail, the next epoch starts in the part of the tail
  that leaves it next. The carrier is then the last usable block before the tail.

The stub keel-lite writes for the trimmed region is not an option. keel-lite never revisits a
decided fold, so the next trim is not guaranteed to cover it, and appending there would re-bill
from the stub on.

In the bench sessions every epoch has to shed more than the new thinking alone, so it folds all
live thinking outside the tail. Nearly every placement is therefore at the tail edge, and the note
sits between the compacted history and the live 8k tail (see *Cache cost*). The carrier is
usually a thinking block, because assistant text is rare there.

**Signed thinking is never a carrier.** When the wire rewrites a thinking block it swaps only the
text and keeps the part's other fields, including pi-ai's `thinkingSignature`. What that field
holds depends on the provider:

- Anthropic (and Bedrock) store a signature, which pi-ai re-sends with the thought, and the API
  can reject a thought that no longer matches it. Gemini replays a `thoughtSignature`. OpenAI
  Responses and OpenRouter's `reasoning_details` replay an opaque item instead of the text, so a
  rewrite would be ignored.
- OpenAI-compatible chat APIs, DeepSeek among them, store only the name of the field the text is
  replayed under (`reasoning_content`, `reasoning` or `reasoning_text`). The rewritten text is what
  gets sent. Every thinking block in the recorded DeepSeek sessions carries `reasoning_content`.

`core/wire.ts → thinkingIsSigned` marks a thinking block `signed` (on `Block`, `WireBlock` and
`ViewBlock`) when its signature is anything but one of those field names, or when the reasoning is
redacted. keel-note never places the note on a signed block. With signed thinking the note rides
only on small text blocks. If there is no usable block at all, it is not placed that epoch: a
finished note waits, ready, for the next trim, and keel-lite's reserve still holds its room. There
is no switch for this. DeepSeek also drops earlier reasoning once a new user message arrives; it
re-sends it within one user turn, which covers a SlopCode session.

None of this has been tested against a real provider here. The same exposure applies to every
thinking FOLD (keel-lite's R1, doorman), since a fold also swaps the text under the old signature.
That is outside keel-note and is not changed here.

A note lands as a non-recoverable `replace` of the carrier. The content is verbatim, with no
`{#code FOLDED}` handle, and the whole block (kept text plus note) is hard-capped at
`noteMaxTokens` including block overhead. If the model writes more, `fitNote` drops the oldest
"Built & verified" / "Tried and failed" bullets first, then whole lines from the end, then
characters. Once the placement has applied, the original text of an overwritten thinking block
goes into the next note update, like any trimmed block. A clamped placement leaves the thought live
and copies nothing.

**Note calls are batched.** Each applied keel-lite epoch copies the blocks it dropped, at trim time,
into a pending buffer. Each block is clipped head and tail, sent to the note model once, and paired
with its tool call for context. A call starts when:

1. the pending span reaches `minDroppedTokens` (8000) tokens, or the buffer is full (it keeps only
   the newest `spanMaxTokens`, 12000, so waiting longer would only discard more); or
2. `fallbackTurns` turns pass with no call. The fallback sends whatever is pending, topped up with
   the newest blocks the note has not seen.

The threshold counts the clipped span, which is what a call costs, rather than the raw tokens an
epoch frees. At a 40k budget every epoch frees at least 8k raw tokens (HIGH 85% down to LOW 65%), so
a raw 8000 threshold would still call on every trim. While a call is in flight, new spans
accumulate. When it returns, one follow-up call is chained if the buffer has reached the threshold
again.

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

**Every trim moves the note, in the same request.** Right after each applied keel-lite epoch, one
transaction places the note on the new boundary carrier and releases the old one. A thinking
carrier is folded to its engine digest, as the trim does to its neighbours. A text carrier gets its
own words back. If a finished note is waiting, that one is placed; otherwise the current text moves
unchanged, so the note never drops out of context. A finished note never lands on its own: it waits
for the next trim. At a turn boundary the note is re-placed only if it has left the context, for
example because a human took the carrier or a resync lost the substitution.

The old `maxStaleTurns` fallback is gone. With the note at the boundary, landing between trims
would rewrite a block the next trim has not reached yet, and that re-bills the whole suffix. In the
previous replay it never fired anyway. A failed, empty or timed-out call keeps the old note, logs
the error in the status line, and puts its spans back in the buffer for the next trigger. The agent
loop never waits for a note.

**Cache cost.** Before this change the carrier sat about 0.8k tokens into the context. Each landing
re-billed everything from there to the epoch's first change, about 10–12k tokens against a
~580-token note, for +32–42% uncached input over keel-lite. At the boundary, the old note is
inside the region the next epoch re-bills anyway.

A replay of the three keel-lite bench sessions measured the result. It used the real wire and
recorded calibration, a stubbed note model that answers two requests later, and default knobs:

| per seed (0 / 1 / 2) | note pinned near the task (before) | note at the trim boundary |
|---|---|---|
| requests over 40k | 0% | 0% |
| note calls / placements | 78/74, 100/93, 74/69 | 77/122, 107/161, 75/109 |
| placements at the tail edge | – | 121, 161, 109 |
| uncached main input vs keel-lite | +41%, +42%, +32% | +4.8%, +3.4%, +5.1% |
| extra uncached per placement, beyond the epoch's own | 11.1k, 12.4k, 9.8k (mean) | 0.5k, 0.4k, 0.6k (mean; median 0) |
| added $ per run (main + note calls) | +$0.27, +$0.35, +$0.23 | +$0.15, +$0.20, +$0.15 |
| of which note calls | $0.14, $0.18, $0.14 | $0.14, $0.19, $0.14 |
| note position (median) | ~0.8k tokens in | 19.7k, 19.2k, 18.3k tokens in (63–68%), ~9–10k before the end |

- Every request that carried a placement also carried an epoch, with one exception: a turn-boundary
  re-placement in seed 0, which re-billed nothing measurable. Seed 2 had one re-placement too, in a
  request with an epoch. The review of #149 traced both: the extension applies a new calibration
  at `message_end`, before the reply is appended, and `Truth.setCalibration` re-runs
  `healProtected`. The recalibrated tail grew back over the tail-edge carrier and healed its
  substitution, and the turn-boundary re-placement put the same bytes back.
- What remains is mostly the note itself. It sits in every epoch's re-billed region, so each epoch
  re-bills its ~570 tokens. The rest comes from epochs that start just past the note, where the
  move re-bills the carrier's own tool call and results.
- The main-input share of the added cost is now about $0.015 per run. Note calls are about 90% of
  the rest.
- The 12k span bound discards the oldest part of a two-epoch batch: 12–17% of the captured span
  text in the earlier replay and 11–14% in this one.

At the median, the agent reads the task, then the compacted history (folded stubs), then the note
("My progress notes … older turns were trimmed from my context"), then the ~9k tokens of recent
turns that are still live. The note sits at the seam between compacted and live history, in
chronological order, and after the trimmed turns it summarizes.

## Knobs

Constructor options (`KeelNoteOptions`, defaults in `KEEL_NOTE_DEFAULTS`):

| option | default | meaning |
|---|---|---|
| `keel` | keel-lite defaults | keel-lite's own knobs (HIGH/LOW band, ladder) |
| `noteMaxTokens` | 600 | hard cap on the landed carrier block (kept text + note), block overhead included; also the reserve |
| `minDroppedTokens` | 8000 | a call starts once this many clipped span tokens from trimmed blocks are pending (or the buffer is full) |
| `fallbackTurns` | 30 | also call after this many turns with no call |
| `spanMaxTokens` | 12000 | the pending span buffer keeps the most recent this-many tokens (the call's input bound) |
| `blockMaxTokens` | 1500 | each captured block is clipped head and tail to about this size (tool calls: 300) |
| `timeoutMs` | 90000 | abandon a note call after this long; the old note stays |

The registry factory reads these from the environment. Invalid values are ignored.

| variable | range |
|---|---|
| `ACCORDION_KEEL_NOTE_MAX_TOKENS` | integer ≥ 64 |
| `ACCORDION_KEEL_NOTE_MIN_DROPPED_TOKENS` | integer ≥ 0 |
| `ACCORDION_KEEL_NOTE_FALLBACK_TURNS` | integer ≥ 1 |
| `ACCORDION_KEEL_NOTE_SPAN_TOKENS` | integer ≥ 500 |

keel-lite's `ACCORDION_KEEL_LITE_HIGH` / `_LOW` also apply.

## Status

The status line is keel-lite's, followed by `note: N refreshes` and `updating`, `ready` or the last
failure. The metrics add these fields:

- `note_refreshes` (new notes placed), `note_placements` (every write of the note),
  `note_moves`, `note_tail_placements` (placements at the tail edge, with no live thinking left
  outside the tail), `note_reasserts` (turn-boundary re-placements after the note left the
  context), `note_calls`, `note_failures` and `note_fallbacks`
- `note_input_tokens` / `note_output_tokens`, where `note_tokens_estimated` marks counts estimated
  locally because the route reported no usage
- the pending and discarded span tokens
- the carrier id

## Limits

- The cap is enforced at the calibration in force when the note lands. Calibration follows the
  whole context's real-to-estimated token ratio, which was typically about 1.4 in the bench
  sessions but reached 2.6. In the boundary replay a placed 600-token block later measured up to
  735 (661, 689 and 735 in seeds 0–2). keel-lite always sees the carrier's current cost, so this
  drift never breaks the budget. (An earlier version of this README said 871. That was measured
  with the pinned text carrier this design replaced.)
- The note usually rides on an unsigned `thinking` block. With signed thinking (Claude, Gemini) it
  needs a small text block, and it is not placed when there is none.
- With the note at the tail edge, a trim that starts just past it re-bills the carrier's own tool
  call and results when the note moves. In the replay this came to 0.4–0.6k tokens per placement on
  average.
- The note is only as good as the model call. The tests and replay use a stub, so how well the
  prompt preserves continuity is untested until a real run.
