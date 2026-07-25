# ADR 0025 — Provider-anchored token calibration

**Status:** accepted, stage 1 + stage 2 shipped (plumbing + display, then decision math; see the
Stage 2 section below)
**Date:** 2026-07-24 (stage 1) / 2026-07-24 (stage 2)
**Builds on:** [ADR 0021](0021-truth-in-the-extension.md) (the Truth that owns every config dial in
the pi extension process, and whose `context` hook is the one place the departing wire and pi's own
`getContextUsage()` are both in scope), [ADR 0011](0011-conductor-involvement-locks.md) (the config-
dial event shape `calibration` reuses verbatim).
**Tracks:** issue #11.

## Context

Every token number Accordion shows — the hero live/budget readout, the composition strip, a tile's
tooltip, the Inspector's `full`/`live` table — is `core/tokens.ts`'s `estTokens`: `ceil(chars / 4)`.
That estimate is off by 10–20% against what a provider actually bills, and the error is not uniform
across models or content shapes (code vs. prose, a `tool_result` heavy in whitespace vs. dense JSON).
The gap is invisible to the user: the map just looks slightly, unaccountably wrong next to whatever
number pi's own status line or `/context` reports.

pi already knows the real number. The extension calls `ctx.getContextUsage()` on every `context` hook
(`refreshFromCtx` in `extension/accordion.ts`) and, separately, every finished assistant message
carries the provider's own `usage` object (`input`/`output`/`cacheRead`/`cacheWrite`, the same shape
`runCompletion`'s out-of-band completion path already reads at `result.usage?.input`/`?.output`).
Neither number reached the live GUI before this ADR — `getContextUsage().tokens` fed only the
sessions-registry file, and `usage` was read only for the extension's own out-of-band completions.

## Decision

### The affine truth, and why we ship a pure multiplier anyway

The honest relationship between a request's real token count and Accordion's block-sum estimate is
affine, not linear: `real = base + k · est`, where `base` is the fixed overhead no block owns — the
system prompt, the tool-call schema definitions, provider-specific framing — and `k` is the per-token
over/under-estimation ratio for whatever content shape this session happens to have. Fitting both
`base` and `k` needs at least two independent (est, real) pairs and a regression, which is a stage-2
problem (see Deferred).

Stage 1 ships the **pure multiplier**: `k = realTokens / estimatedTokens` for the same request, with
`base` implicitly folded into `k` — one number that, applied to a raw block-token estimate, distributes
the fixed overhead **proportionally across every block** rather than carrying it as its own line item.
This is a known, accepted simplification, not an oversight: it is the honest first step (a single
session-level dial, no per-block bookkeeping, no regression state), it converges to something useful
after exactly one real observation, and it composes cleanly with everything the engine already does
(a calibrated number is just `Math.round(n * k)` of a number some other code path already computed).

### `k` lives on `Truth` as a rev-stamped scalar dial

`core/truth.ts`'s `Truth` gets a `calibration` dial — default `1`, alongside `budget`/`protectTokens`
in shape: a private field, a getter, and `setCalibration(k)` that goes through the same rev/event
machinery every other config dial uses (`this.revCounter++`, emit `{ type: "config", calibration, rev
}`). It rides `SnapshotState` (optional, same "a stale/test literal without it still type-checks"
treatment as v15's `carriedSent`) and the `config` `WireEvent`, so a replica hydrates and replays it
exactly like `budget`/`protectTokens` — `core/replica.ts`'s `serializeSnapshot`/`hydrateSnapshot`/
`wireEventFromTruthEvent`/`applyWireEvent` all round-trip it, and `Truth.rebuildFrom` carries it over a
structural-divergence rebuild the same way it carries every other scalar dial.

`Truth.calTokens(n) = Math.round(n * calibration)` is the one DISPLAY-only read helper: a component
routes a number it already computed (`liveTokens()`, `effTokens(b)`, a per-kind sum) through it to opt
into calibration. Protocol v18 (`core/protocol.ts`) bumps for the new wire vocabulary — `calibration`
on `SnapshotState` and the `config` event, plus `realTokens`/`estWireTokens` on `TelemetryMessage` (the
raw ingredients of the most recent observation, so the GUI/smoke tests can audit `k` independently of
the derived multiplier).

### Stage-1 invariant (historical): decision math was untouched

At stage 1, `canFold`, `protectedFromIndex`, `stats()`, `serializeWire`/`computeFoldOps`/
`computeGroupOps`, and every conductor-visible number (`ConductorHost.stats`/`countTokens`) read the
raw chars/4 estimate, exactly as before this ADR. `calibration` was invisible to that whole surface —
`core/conductor/hostAdapter.ts`'s `hostEventsFromTruthEvent` explicitly drops a calibration-only
`config` event rather than let it fall through to the existing `budget !== undefined ? "budget" :
"protect"` default and mislabel it a "protect" change, which would otherwise wake every subscribed
conductor once per model reply for a dial it was never meant to see (this guard is still in place —
`calibration` never becomes a conductor `state-changed` notification, even after stage 2). Stage 2
(below) is what flips the rest of that surface onto calibrated numbers.

### Pairing: real usage vs. the estimate of the wire that earned it

The chosen pairing is the "rigorous" one the design allows for, over the `ctx.getContextUsage()`-based
fallback: at the `context` hook, after (optionally) serializing the wire, record the estimate of what
just departed — `pendingWireEst = foldingEnabled ? truth.liveTokens() : truth.fullTokens()` (Truth's
own accounting of the folded wire when folding is armed; the raw unfolded size when it's off, since
passthrough departs `event.messages` verbatim). When the resulting assistant message lands
(`message_end`, with `agent_end` as the existing idempotent backstop), pair that estimate against the
message's REAL usage: `real = usage.input + usage.cacheRead + usage.cacheWrite`.

`usage.output` is **deliberately excluded** — it is that same call's own reply, never part of what was
sent, so it cannot describe the cost of the departing wire `pendingWireEst` estimated. This is the one
place this project's pairing diverges from pi's own `calculateContextTokens` (`@earendil-works/pi-
coding-agent`'s compaction module: `usage.totalTokens || input + output + cacheRead + cacheWrite`) —
that function is forward-looking (estimating the *next* call's context size, which legitimately
includes this reply as history), while calibration needs "what did THIS request actually cost," a
different quantity. `cacheRead`/`cacheWrite` both describe prompt-side (input) tokens, so both count.

The rigorous pairing was chosen over the `ctx.getContextUsage().tokens`-based v1 fallback because it is
never `null` (`getContextUsage()` returns `tokens: null` right after compaction, before the next
response) and it isolates exactly the one request the estimate describes, rather than blending in
`getContextUsage()`'s own trailing-message estimate for anything appended since the last real reply.

### Update rule: raw snap, no clamp, no smoothing

`setCalibration(k)` always overwrites — no EMA, no bounding window, no outlier rejection beyond
refusing a non-finite/non-positive `k` (the same poison guard every other dial already has, since NaN/
Infinity survive naive arithmetic and JSON-serialize as `null`, forking replicas). This is a deliberate
v1 simplification: the dial always reflects the session's most recent observation. A single unusual
reply (a huge cache hit, an unusually short completion) can swing `k` visibly until the next real
observation lands. Accepted for stage 1 — smoothing is a natural stage-2 addition once there is a
second axis (the affine `base` term) to smooth alongside, not before.

### Cold start, model switch, and read-only sessions

- **Cold start:** `k = 1` until the first observation — a session's opening turns show the same
  uncalibrated number they always did.
- **Model switch:** the dial is left alone. A swap does not reset `k` to `1`; the last observed
  multiplier is a better prior than "no calibration" even for a different model, and the very next
  reply re-anchors it anyway.
- **Read-only / demo / CC / file sessions:** `k` stays `1` forever. There is no live host — no
  `context` hook, no assistant `usage` — to ever call `setCalibration`, so the dial simply never moves.
  No offline calibration in v1 ([the RULE in `CLAUDE.md`](../../CLAUDE.md) already requires these
  sessions behave exactly as the steering path would with nothing new to say).

### Display: the "≈" marker

A calibrated number renders bare when it is provider-anchored; a component shows a leading "≈" when
`store.calibration === 1` (covers both cold start and every read-only/demo/CC/file session in one
check — the same failure mode either way) or, in `MapHeader` specifically, the existing `readOnly`
prop. `MapHeader`'s hero line, composition-strip tooltips, and `ContextMap`/`Inspector`'s token
readouts all route through `store.calTokens(n)`; tile canvas drawing (dice-face bins) stayed on raw
bins through stage 1 — stage 2 (below) is what routes `faceFor()`'s input through `calTokens` too. No
new colors — the marker is `var(--muted)`/`var(--faint)`, matching the existing monochrome UI-chrome
rule.

## Stage 2 — decision math reads calibrated numbers too

Stage 2 flips the surface stage 1 deliberately left alone: `protectedFromIndex()`, `Truth.stats()`,
and every conductor-facing read (`ViewBlock.tokens`/`foldedTokens`, `ConductorHost.countTokens`) now
report CALIBRATED numbers, so the protected-tail boundary, a conductor's own budget-trigger math
(`compaction-naive`/`handoff`'s 90% high-water mark, thermocline's hard-budget ladder), and the app's
over-budget/composition-bar chrome all agree with the hero readout stage 1 already calibrated.
`canFold` itself needed no direct change — it carries no token-threshold comparison of its own
(verified by audit; it only ever calls `isProtected`), so it inherits the calibrated boundary
transitively through `protectedFromIndex`.

### The chosen convention: calibrate every conductor-facing read surface

Two conventions were on the table: (a) calibrate only the AGGREGATE (`stats()`), leaving every
per-block read (`ViewBlock.tokens`/`foldedTokens`, `countTokens`) raw, with each conductor doing its
own unit conversion where it mixes the two; or (b) calibrate at EVERY read surface a conductor
touches, so nothing downstream ever needs to know calibration exists. (b) shipped. The deciding
evidence: `AgedSummaryConductor` (`conductors/in-process/agedSummaryConductor.ts`, the shared base of
`compaction-naive`/`handoff`) sums `ViewBlock.tokens` directly to build its own trigger baseline
(`sumTokens(view.blocks)`) rather than reading `stats().liveTokens`, and thermocline's `project()`
(`conductors/ws/thermocline/policy.ts`) subtracts per-block `tokens − foldedTokens` from a
`stats()`-derived baseline in the SAME expression. Leaving one side of either calculation raw and the
other calibrated would not just shift a trigger threshold — it would produce a wrong-order-of-magnitude
number the instant `calibration` drifts from 1. Calibrating every read surface means no shipped
conductor needed a single code change to become calibration-aware: they already treat whatever
`ViewBlock.tokens`/`stats()`/`countTokens` report as ground truth. `budget`/`protectTokens`/
`contextWindow` — the literal dial values a human sets (or a conductor declares via `tailTokens`) —
are the one thing that stays UNCONVERTED: stage 2 treats the number already on the dial as meaning
REAL tokens (that is the entire point of calibrating the numerator against it), never multiplying it.

### `protectedFromIndex`: one division of the target, not a multiplication per block

`computeProtectedFromIndex` (`core/truth.ts`) still walks the block log's RAW `Block.tokens` — it does
not call `calTokens` inside the loop. Instead the REAL-token target (`protectTokens`, or a `tail-size`
holder's `activeTailTokens`) is converted ONCE, before the walk, to the equivalent raw-estimate
threshold: `target = targetReal / calibration`. `calibrated(rawSum) >= targetReal` iff `rawSum >=
targetReal / calibration`, so the two forms decide identically — the division-first form was chosen
purely for host/replica determinism: `calibration` is a rev-stamped scalar both sides carry
byte-identical (JSON round-trips any finite double exactly), so one shared division from the same two
operands is bit-identical on both sides (IEEE-754 basic ops are deterministic). Calibrating per block
inside the walk instead would call `Math.round` (inside `calTokens`) once per iteration, whose
cumulative rounding error is a function of iteration order/count — something a host and a replica have
no contractual guarantee to reproduce identically walk-for-walk over a session's lifetime. A single
division has no such accumulation to diverge on. `core/truth.test.ts` extends the stage-1 replica
round-trip tests with a non-1-calibration case asserting the host and a JSON-round-tripped replica
compute the IDENTICAL `protectedFromIndex()`.

### `Truth.stats()`: the aggregate is calibrated once per call, not per block

`stats().liveTokens`/`fullTokens` route the ALREADY-SUMMED raw total through one `calTokens` call
each — never a per-block calibration inside `liveTokens()`/`fullTokens()` themselves, which stay the
raw accessors every other internal caller (`effTokens`, group accounting, `serializeWire`) still needs
untouched. `budget`/`protectTokens`/`contextWindow`/`protectedFromIndex`/`blockCount` are unconverted
(the first three are literal dial values under the convention above; the last two are already
calibration-aware or structural facts, not token sums).

### The app: closing the hero/bar/flag disagreement stage 1 accepted

`store.overBudget` now compares `calTokens(liveTokens)` against `budget` (previously a raw-vs-raw
comparison sitting next to an already-calibrated hero readout — exactly the disagreement stage 1's
Consequences called out). `MapHeader`'s composition-bar axis (`denom`) and everything scaled against
it (segment widths, the budget marker, headroom, the protected-tail handle/underline) now run on
`calTokens(fullTokens)` instead of the raw total, so the bar's proportions agree with the calibrated
hero numbers and with `budget`/`protectTokens` (both already real-token dial values). `calBudget` —
stage 1's `calTokens(budget)` — is now simply `budget` itself: under the new convention the dial is
ALREADY real, so multiplying it again would double-calibrate it and reintroduce a hero/flag mismatch
in the other direction. `ContextMap.svelte`'s `faceFor()` die-face binning now feeds on
`store.calTokens(tokens)` (wrapped once at the call site, `tileDraw.ts`'s pure `faceFor` function
itself untouched) so a tile's visual weight matches its calibrated readout.

## Consequences

- **Protected-boundary twitch, as predicted.** Because `protectedFromIndex()` now reads the
  calibration dial, the protected-tail boundary can shift by a block or two on a calibration snap
  (once per model reply) even though no block actually changed size — this was called out as an
  expected stage-2 consequence in the original version of this ADR, and stage 2 confirms it: it is the
  direct, intended effect of sizing the tail in real tokens rather than raw estimate tokens.
- **Smearing is still real and visible per-block.** Unchanged from stage 1 — a single multiplier
  cannot separate "this block is genuinely bigger than we estimated" from "the system prompt is bigger
  than we estimated." Stage 2 makes the smeared number load-bearing for MORE decisions (the protected
  boundary, a conductor's trigger) than stage 1 did (display only), so this caveat now matters more,
  not less.
- **One-turn lag, still present.** `k` reflects the LAST completed request — a session whose content
  shape just changed sharply sees the new `k`, and therefore the new protected-boundary/trigger
  behavior, only after that shift's own reply lands.
- **A conductor's trigger point moves with the session, not just with content volume.** Two sessions
  with byte-identical raw content can now trigger `compaction-naive`'s 90% mark at different points if
  their `calibration` differs (see `compaction-naive.test.ts`'s "token calibration" describe block) —
  accepted as the whole point of the stage (a REAL 90%, not a raw-estimate 90%), but worth naming
  explicitly since it means the trigger is no longer a pure function of block count/kind alone.

## Deferred

- **The affine fit (`real = base + k·est`).** Still needs ≥2 observations and a real regression (or a
  two-parameter least-squares over a short rolling window) — out of scope for both stages shipped so
  far; the pure multiplier remains a documented simplification, not a placeholder.
- **Smoothing / outlier rejection.** Once there is an affine fit to smooth, raw-snap-per-observation
  stops being the obviously-simplest option; revisit together with the affine work, not before.
