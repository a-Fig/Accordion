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

**The carrier.** A conductor cannot insert blocks, so the note rides on an existing one. Truth
never lets a conductor edit a `user` block (`not-foldable`), so the task message cannot hold it;
the foldable kinds are `text`, `thinking` and `tool_result`, and a tool result would pass the note
off as tool output. keel-note therefore picks, after the task and outside the protected tail:

1. the first assistant `text` block of at most 150 tokens (and at most a quarter of the cap). The
   note is appended to the block's own words, which stay;
2. only if there is none, the first assistant `thinking` block, which the note overwrites.

Text comes first because every provider replays assistant text verbatim. A thinking block is
fragile: Anthropic signs thinking blocks, and the wire keeps the part's other fields and swaps only
its text; OpenAI's reasoning items are opaque; DeepSeek and others drop earlier reasoning once a new
user message arrives. None of this has been tested against a real provider here.

In the three SlopCode bench sessions the first reply is thinking plus a tool call, and the first
assistant text part appears in the 11th to 13th reply. Until the first note lands, the carrier is
therefore provisional: keel-note holds the first thought and moves to a small text block as soon as
one has left the protected tail. After the first landing the carrier stays put, because every move
rewrites an early block. If a human takes the carrier, the note moves to the next usable block.

A note lands as a non-recoverable `replace` of the carrier. The content is verbatim, with no
`{#code FOLDED}` handle, and the whole block (kept text plus note) is hard-capped at
`noteMaxTokens` including block overhead. If the model writes more, `fitNote` drops the oldest
"Built & verified" / "Tried and failed" bullets first, then whole lines from the end, then
characters.

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
accumulate. When it lands, one follow-up call is chained if the buffer has reached the threshold
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

**Landing rides on a trim.** A finished note waits and lands right after the next applied
keel-lite epoch, in the same request. If no epoch comes within `maxStaleTurns` (40) turn boundaries,
it lands at the next boundary anyway, before keel-lite evaluates that turn. The old note stays until
then. A failed, empty or timed-out call keeps the old note, logs the error in the status line, and
puts its spans back in the buffer for the next trigger. The agent loop never waits for a note.

**Cache cost.** Rewriting the carrier invalidates the provider's prompt cache from the carrier on.
An epoch invalidates it from its first dropped block on. If the carrier sat at or after that
block, landing with the epoch would add only about the note's own tokens. It does not: the carrier
sits near the front, while keel-lite's ladder restarts each epoch at the oldest *undecided* block,
which is roughly where the previous epoch stopped. Everything in between (the compacted prefix of
fold stubs, tool calls, trimmed results and small blocks keel-lite never folds) is cached before
the landing and re-billed by it.

A replay of the three keel-lite bench sessions (note model stubbed, default knobs) measured this:

- The carrier was a text block about 0.7–0.9k tokens into the context. Each epoch's first change
  sat at a median of 9.5k–14k tokens.
- Every landing coincided with an epoch. Each one still added about 10–12k uncached tokens, against
  about 580 for the note itself.
- In one session the carrier's message also holds a ~5k-token `write` tool call. keel-lite never
  folds tool calls, so every landing re-bills it too.
- Landings account for about 90% of keel-note's extra uncached input over keel-lite (+32–42%).

For a landing to cost about the note's size, the note would have to sit at or after the trim
point, for example on a fresh block at the tail, with old copies left to keel-lite's ordinary
sweep. That is not implemented.

With the defaults, the replay had 0% of requests over budget. It made 74–100 note calls for 113–173
epochs and landed 69–93 notes, every one with an epoch; `maxStaleTurns` never fired, and 20 gave
identical results. The added cost was about $0.23–0.35 per run at DeepSeek prices, roughly half
note calls and half cache. When every trim called the model and every note landed at the next turn
boundary, it was $0.56–0.82. The 12k bound discarded 12–17% of the captured span text, the oldest
part of a two-epoch batch.

## Knobs

Constructor options (`KeelNoteOptions`, defaults in `KEEL_NOTE_DEFAULTS`):

| option | default | meaning |
|---|---|---|
| `keel` | keel-lite defaults | keel-lite's own knobs (HIGH/LOW band, ladder) |
| `noteMaxTokens` | 600 | hard cap on the landed carrier block (kept text + note), block overhead included; also the reserve |
| `minDroppedTokens` | 8000 | a call starts once this many clipped span tokens from trimmed blocks are pending (or the buffer is full) |
| `fallbackTurns` | 30 | also call after this many turns with no call |
| `maxStaleTurns` | 40 | a finished note waits at most this many turn boundaries for an epoch to land with |
| `spanMaxTokens` | 12000 | the pending span buffer keeps the most recent this-many tokens (the call's input bound) |
| `blockMaxTokens` | 1500 | each captured block is clipped head and tail to about this size (tool calls: 300) |
| `timeoutMs` | 90000 | abandon a note call after this long; the old note stays |

The registry factory reads these from the environment. Invalid values are ignored.

| variable | range |
|---|---|
| `ACCORDION_KEEL_NOTE_MAX_TOKENS` | integer ≥ 64 |
| `ACCORDION_KEEL_NOTE_MIN_DROPPED_TOKENS` | integer ≥ 0 |
| `ACCORDION_KEEL_NOTE_FALLBACK_TURNS` | integer ≥ 1 |
| `ACCORDION_KEEL_NOTE_MAX_STALE_TURNS` | integer ≥ 1 |
| `ACCORDION_KEEL_NOTE_SPAN_TOKENS` | integer ≥ 500 |

keel-lite's `ACCORDION_KEEL_LITE_HIGH` / `_LOW` also apply.

## Status

The status line is keel-lite's, followed by `note: N refreshes` and `updating`, `ready` or the last
failure. The metrics add these fields:

- `note_refreshes`, `note_calls`, `note_failures`, `note_fallbacks`, `note_reasserts`, and
  `note_stale_landings` (landings that gave up waiting for an epoch)
- `note_input_tokens` / `note_output_tokens`, where `note_tokens_estimated` marks counts estimated
  locally because the route reported no usage
- the pending and discarded span tokens
- the carrier id

## Limits

- The cap is enforced at the calibration in force when the note lands. Calibration follows the
  whole context's real-to-estimated token ratio, which was typically about 1.4 in the bench
  sessions but reached 2.6, so a landed 600-token block later measured up to 871. keel-lite always sees the
  carrier's current cost, so this drift never breaks the budget.
- When a session has no small assistant text block, the note rides on a `thinking` block, with the
  provider risks above. DeepSeek re-sends reasoning within a single user turn, which covers a
  SlopCode session.
- The note is only as good as the model call. The tests and replay use a stub, so how well the
  prompt preserves continuity is untested until a real run.
