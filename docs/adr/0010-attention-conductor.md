# ADR 0010 — Attention conductor: periodic, cache-preserving folding via a small LM probe

**Status:** accepted
**Date:** 2026-06-14
**Builds on:** [ADR 0007](0007-conductor-protocol.md) (the conductor seam —
`conduct → Command[]`), [ADR 0008](0008-conductor-first-party-one-view.md) (first-party
conductors, one public `ConductorView`), [ADR 0009](0009-cold-score-conductor.md)
(the cold-score conductor — the in-process relevance-aware peer).

## Context

The cold-score conductor (ADR 0009) estimates block relevance from retrieval history and
lexical signals — no model inference, runs synchronously in the same process. It is a good
approximation for "which old blocks has the agent recently touched by symbol?" but it has
no signal about **structural gravity**: how much the agent's current reasoning actually
attends back to a block, independent of whether that block's identifiers appear in the tail.

A small instruction model run as a probe can read both the earlier blocks and the current
work tail, then report — via its raw attention weights — how much the final readout token
"looks back" at each block's token span. Higher summed attention = more structurally
relevant = fold last. This is a closer proxy to the question "does the model need this
block to reason about the current task?" than any lexical heuristic.

Two hard problems shape the design.

**The prompt-cache constraint.** The agent model runs on an inference server that caches
its prompt prefix. Re-folding on every turn rewrites that prefix, evicting the cache on
every call. A context window of ~100 k tokens at 8 tokens/s means a ~12 s cache-miss
penalty, or roughly a **10x cost increase** for multi-turn sessions. The conductor must
therefore fold **periodically**, not continuously — change the fold set only at deliberate
"epochs" and hold it stable in between.

**The probe latency constraint.** Qwen2.5-0.5B-Instruct reading a full session is a ~6 s
model-load plus ~0.15 s per 2048-token window, totalling **~8–18 s for a full session**
on a 6 GB GPU. `conduct()` / the WS reply path must be fast and synchronous (or at least
non-blocking); the probe cannot run in that path. Scoring must be decoupled from the
fold/hold decision.

The conductor lives in `conductors/attention-folder/` and runs as a standalone Node.js
process. It hosts a WebSocket server that Accordion dials as a client, matching the
out-of-process WS topology defined in ADR 0007.

## Decision

### 1. Standalone WebSocket conductor, not in-process

The attention conductor is implemented as an out-of-process WebSocket conductor (the
escape-hatch path described in ADR 0007/0008) rather than an in-process TypeScript class.

The reason is environmental: the probe requires a Python interpreter with PyTorch and the
`transformers` library installed in a local venv (`probe/.venv/`), plus an NVIDIA GPU for
acceptable latency. A TypeScript class running inside Accordion's webview process has no
mechanism to spawn Python subprocesses or load GPU libraries. The conductor protocol's WS
path was designed exactly for this case — "a separate process / another language" — and
is the documented mechanism for conductors with non-JS runtimes or long-running compute.

The conductor (`attention-folder.mjs`) hosts a `ws://127.0.0.1:7701` WebSocket server,
advertises a heartbeat file at `~/.accordion/conductors/attention-folder.json` (refreshed
every 5 s; deleted on shutdown), and is auto-discovered by the Accordion desktop app.
Accordion dials in as a client, exactly as it does with `recency-folder`. The wire
protocol is `CONDUCTOR_PROTOCOL_VERSION = 2` (ADR 0007's `conductorProtocol` field in
the `conductor/hello` message). The conductor declares `wants: { content: "full" }` —
it needs block text to pass to the probe.

### 2. Periodic hysteresis band [70 %, 90 %] of the context window

The core policy (`policy.mjs → decideFolds`) maintains a **hysteresis band** expressed
as fractions of the model's context window (defaults: `lowWater = 0.70`,
`highWater = 0.90`). The fullness denominator is `contextWindow` from the view, falling
back to `budget` if the host cannot report it.

Fullness is computed from `blocks[].tokens` / `blocks[].foldedTokens` plus the
conductor's own currently-applied fold set — not from the view's `liveTokens` field.
`liveTokens` reflects the host's cleared-vs-applied semantics (the host clears the
conductor's folds before sending a `context/update`, then re-applies them internally),
whereas the conductor must track which blocks it has already folded to compute the correct
rendered size. Computing fullness from per-block data against its own `appliedFoldSet` is
therefore robust and self-consistent.

**Hold (< 90 %):** while rendered fullness is below `highWater`, `decideFolds` returns
`{ action: 'hold' }` and the conductor sends **nothing** over the wire. Per ADR 0007,
sending no message causes the host (`RemoteRunner`) to keep the last applied fold set
untouched. The fold set is thus byte-stable from turn to turn; new blocks append live at
the tail, which follows the folded region and never disturbs the cached prefix. The
inference prompt cache hits on every turn during a hold phase.

**Epoch (≥ 90 %):** when rendered fullness crosses `highWater`, `decideFolds` runs one
expansion of the fold set — folding the **lowest-attention** blocks first until rendered
fullness drops to or below `lowWater`. The conductor sends a single `conductor/commands`
message with the complete desired fold set (`kind: "fold"`, all folded ids). This is one
deliberate cache-miss. After the epoch the context is stable again until it refills to
`highWater`, producing the next epoch. Epoch frequency is naturally bounded by how fast
new blocks grow the context.

The key idea: **decouple output-change frequency (rare epochs) from invocation frequency
(every block)**. The conductor receives a `context/update` on every turn but replies to
most of them with silence.

### 3. Monotonic / sticky folds

The fold set is **monotonic within a session**: it only grows at epochs. Between epochs,
`decideFolds` prunes the applied set of any block that has since vanished, become
human-held (`b.held`), entered a host group (`b.grouped`), become protected
(`b.protected`), or can no longer actually shrink (`foldedTokens >= tokens`). All other
ids from the previous applied set carry forward unchanged — a block once folded stays
folded.

Blocks the **agent** has pulled back to live (its M3 self-unfold) are tracked in
`respectLive` (a `Set<string>` in per-connection state), populated **only** from
`host/event` messages whose `event === "agentUnfold"`. `foldCandidates` and the epoch's
pruning step both exclude `respectLive` ids, so a block the agent explicitly reclaimed is
never re-folded. **Human** overrides are deliberately *not* added to `respectLive`: the
view's per-block `held` flag already reflects them on every tick and is self-correcting
(a human who folds-then-unfolds, or calls `resetAll`, leaves the block reclaimable), so
adding human ids here would permanently poison blocks a human merely touched.

Monotonicity keeps the folded prefix stable and growing, which is maximally
cache-friendly. The agent's M3 self-unfold mechanism (ADR 0005) is the safety valve if
the agent needs a block the conductor has folded.

After an epoch the conductor sets `rescoreNeeded = true` — the tail has moved and
existing scores are stale — so fresh scores will be requested before the next epoch.

### 4. Background scoring, decoupled from the reply path

The probe runs asynchronously via `scorer.mjs → scoreCandidates()`, which spawns
`probe/probe.py` as a child process (async `spawn`, never `spawnSync`), writes the
candidate list to a temp file, waits for the probe to finish, and resolves a
`Map<blockId, score>`. Scoring **never blocks** the hold/epoch decision in the
`context/update` handler.

Background scoring is triggered by `maybeScore()`, called at the end of every
`context/update` handler. It fires the probe when:
- Fullness has crossed the **warm threshold** (`WARM_WATER`, default 0.80) — the context
  is approaching the epoch boundary, so fresh scores are desirable before it arrives.
- No scoring is already in flight (`scoringInFlight` flag).
- Either `rescoreNeeded` is true (set after each epoch) or a fold candidate has not yet
  been *attempted* (attempts are tracked per run, so a block the probe cannot score does
  not re-trigger the GPU on every tick).
- There is at least one fold candidate, and the protected-tail "current work" text is
  non-empty (with no tail to score against, the band is left to the FOLD_RANK fallback).

When scoring completes, scores are merged into the per-connection `scores` Map. Scores
accumulate and are never cleared between epochs, so the probe only needs to run when
there are new unscored candidates or the tail has substantially moved.

**Graceful degradation.** If scores lag — the probe is slow, missing, or hangs (a
watchdog kills it after `timeoutMs`, default 180 s, so a wedged probe cannot permanently
disable scoring), or the context jumped past 90 % before the warm-water trigger fired —
the epoch degrades to the built-in's FOLD_RANK order for unscored candidates (lowest-value
kind first:
`tool_result → thinking → text`; age / `order` as the tiebreaker within a kind). Scored
candidates are always folded first (sorted ascending by score), then unscored candidates
by FOLD_RANK. The hysteresis band is therefore defended even with zero probe scores; the
attention signal only changes **which** blocks are folded within an epoch, not whether the
epoch fires.

### 5. The probe: Qwen2.5-0.5B-Instruct, VATP-corrected last-token attention

`probe/probe.py` loads `Qwen/Qwen2.5-0.5B-Instruct` (24 decoder layers, 14 Q-heads,
2 KV-heads GQA, 64-dimensional heads) and scores blocks by reading the raw attention
weights from layers 18–23 (the final six layers) via `forward_pre_hook`s that capture
each layer's input hidden states and position embeddings before projection.

The scoring recipe for each window:

1. **Window assembly.** Blocks are greedy-packed into 2048-token windows (`DEFAULT_WINDOW`).
   Each window is formatted as a single user chat message containing `[blockId]\ntext\n`
   entries, a fixed neutral anchor (`ANCHOR_TEXT`, ~25 tokens), then a `=== CURRENT WORK
   ===` separator followed by the work tail (newest `TAIL_TOK_BUDGET = 700` tokens) and a
   `Which earlier sections are most relevant to the current work? Answer:` prompt. The
   anchor is always placed immediately before the tail.

2. **Forward pass.** In production the model runs a padded **batch** of windows
   (`--batch 24 --attn-impl sdpa` — the defaults the conductor always passes). The batched
   forward is **early-aborted** after layer 23's pre-hook fires (the `_StopForward` exception),
   skipping the final norm and the 151,936-token lm_head projection — dead-compute removal that
   cuts both wall time and peak VRAM. (The eager single-window path, `--batch 1`, is the
   byte-identical reproduction baseline; it runs the full forward without the abort, and the
   conductor never takes it.)

3. **Attention readout.** For each probed layer, the last-token query is recomputed
   against all keys using the captured hidden states and rotary embeddings. The raw
   attention scores (pre-softmax) are scaled, softmaxed, then VATP-corrected: each
   position's attention weight is multiplied by the L1 norm of its value vector (mapping
   each query head to its GQA KV head group). The first two positions are zeroed
   (attention-sink masking) and the remainder renormalized. Scores are averaged over the
   14 query heads and over the 6 probed layers to produce a single `[n]` per-position
   relevance mass.

4. **Block aggregation.** Each block's score is the **mean** of its per-position mass over
   its token span `[s, e)` in the window's input_ids.

5. **Anchor calibration.** Every block score is divided by the anchor's score in the same
   window (when the anchor score is above 1e-12), normalizing out per-window competition
   differences and constant positional components.

The probe communicates via temp files: `scorer.mjs` writes `{ tail, blocks }` as JSON to
a temp directory and reads `{ scores, meta }` back after the process exits. Block text is
capped at `BLOCK_CHAR_CAP = 3000` chars by `scorer.mjs` before the payload is written
(`capHeadTail`, 75 % head + 25 % tail); the probe re-caps to 400 tokens internally.
Tail text is taken from the view's protected-tail blocks (newest-first walking until
`TAIL_CHAR_CAP = 12000` chars).

### Files

```
conductors/attention-folder/
  attention-folder.mjs   — WS server, per-connection state, hold/epoch dispatch
  policy.mjs             — decideFolds(), renderedTokens(), foldCandidates() (pure, no I/O)
  scorer.mjs             — scoreCandidates(), tailTextFromView() (async probe bridge)
  policy.test.mjs        — unit tests for the pure policy (node:test, no probe, no GPU)
  smoke.test.mjs         — wire-level WS test (probe stubbed out — GPU-free)
  package.json           — scripts: start / test
  probe/
    probe.py             — Qwen2.5-0.5B attention scorer
    requirements.txt     — pinned Python deps; torch cu121 wheel must be installed first
```

`policy.mjs` is intentionally dependency-free and side-effect-free — no I/O, no
`Date.now()`, no mutation of its inputs. The server (`attention-folder.mjs`) owns the
WebSocket, the scorer, and the applied-set memory; `policy.mjs` owns exactly one thing:
which blocks to fold, and when. This separation makes the core logic unit-testable with
no GPU or network.

## Consequences

**What this adds.** A conductor that approximates structural gravity — how much the
model's current reasoning would naturally look back at each earlier block — and folds the
least-attended blocks at epoch boundaries while holding the fold set stable between
epochs. The inference prompt cache is preserved across the full hold phase. The
degradation path (FOLD_RANK fallback) is identical to the built-in's behavior, so the
band is always defended even when the probe is unavailable.

**What stays the same.** The built-in and cold-score conductors are untouched. The
golden test (`conductor.builtin.test.ts`) is untouched. The pi wire and Accordion's
engine layer are untouched — the conductor communicates only through the standard
`conductor/commands` / `context/update` / `host/event` message shapes.

## Risks and honest limitations

**Proxy-of-a-proxy.** Qwen2.5-0.5B-Instruct is not the agent's actual model. Its
attention weights reflect how a 500 M-parameter instruction model reads a 2048-token
window — not how the agent's model (which may be much larger, differently trained, and
sees a different prompt format) weights the same blocks. The score is one small model's
opinion of relevance, not ground truth.

**Position and recency confound.** Raw attention has a known recency bias — later
positions typically attract higher attention. The attention sink (positions 0–1) is
masked, but a recency bias likely remains in the residual. Summed attention therefore
partly re-encodes position, which is computable for free without a probe. The anchor
calibration removes a **constant** positional component per window but cannot remove
block-specific positional components; blocks near the tail consistently score higher
regardless of content relevance.

**Fine-rank instability.** Anchor calibration divides scores by a small float
(~1e-3 range), amplifying numerical noise from bfloat16 arithmetic into large rank moves
among near-tied blocks. Only **coarse** relevance is trustworthy — which blocks are
clearly least-attended versus those the model is clearly using. The fold decision only
needs coarse relevance (fold the bottom-K), so this is acceptable in practice.

**Scoring lag and first-epoch degradation.** If the context crosses 90 % before the
warm-water trigger (80 %) has had time to complete a probe run — for example, the session
starts with a large existing context — the first epoch folds entirely by FOLD_RANK with
no attention signal. Subsequent epochs will have scores.

**Score staleness between epochs.** Scores are refreshed when `rescoreNeeded` is true
(after each epoch) or when unscored candidates appear, but between epochs they drift as
the protected tail moves. A block whose relevance changes mid-hold-phase will carry its
pre-epoch score until the next probe run.

**Disconnect reverts to raw.** If the conductor process exits or loses its WS connection,
the host clears its fold state (ADR 0007: no message = hold last state, but a
*disconnect* is treated as detach). The conductor must stay alive to maintain its folds.
There is no reconnect-and-restore mechanism in this cut; a restart produces a fresh
applied set and the context appears raw until the next epoch.

**Band is best-effort, not a hard guarantee.** `foldCandidates` excludes protected,
held, grouped, and already-folded blocks, and blocks where `foldedTokens >= tokens`. A
sufficiently large protected tail — or a session with many non-foldable `tool_call`/`user`
blocks — can keep rendered fullness above `highWater` even after folding every eligible
block. The epoch is still triggered and the best-effort fold set is still emitted; the
band target simply cannot be reached.

## Out of scope (this cut)

- **Per-turn or continuous folding.** The probe's compute floor (~8–18 s/session) is
  roughly 1000x too slow to run between every turn. Closing that gap requires a distilled
  proxy model (a much smaller embedding or classifier trained to imitate the probe's
  rankings), which is a separate effort.
- **Attention-guided unfolding.** The conductor currently only folds; it does not
  resurface blocks that become relevant after being folded. The agent's M3 self-unfold
  (ADR 0005) covers the agent-initiated path; a conductor-driven attention-guided unfold
  is a future extension.
- **In-process variant.** An in-process version of this conductor is not feasible while
  the probe requires a Python GPU subprocess. A future compiled or WASM-based
  approximation could run in-process; that would require a different probe architecture.
- **Cross-window score normalization.** Anchor calibration normalizes within each window
  but not across windows. Blocks in windows with many strong candidates may receive
  systematically inflated calibrated scores; this is documented as a known caveat in
  `probe.py` (the `CAVEAT(M1)` comment).

## Rejected alternatives

- **In-process TypeScript conductor.** Rejected: cannot spawn Python GPU subprocesses
  from the webview process. The WS escape hatch is the correct path for a probe with
  non-JS runtime requirements.
- **Synchronous probe in the WS handler.** Rejected: `spawnSync` in the message handler
  would stall all hold/epoch replies for 8–18 s per invocation. Background async spawn is
  the only viable shape.
- **Running the probe on every turn.** Rejected: even at 1 s latency (requiring a 10–18x
  faster probe or a distilled model), folding every turn destroys the prompt cache.
  Periodic epochs are the product constraint, not a simplification.
- **LRU or age-only fold order.** Rejected as the sole signal: the cold-score conductor
  already does age + kind + lexical relevance. The attention conductor's value over
  cold-score is exactly the structural gravity signal, which age and lexical heuristics
  cannot recover.
