# ADR 0025 — Provider-anchored token calibration

**Status:** accepted, stage 1 + stage 2 shipped (plumbing + display, then decision math; see the
Stage 2 section below); system-prompt un-smearing addendum shipped alongside issue #93 (see the
Addendum sections below); receipt-frontier fix shipped for issue #102
**Date:** 2026-07-24 (stage 1 + stage 2 + issue #93) / 2026-08-03 (issue #102)
**Builds on:** [ADR 0021](0021-truth-in-the-extension.md) (the Truth that owns every config dial in
the pi extension process, and whose `context` hook is the one place the departing wire and pi's own
`getContextUsage()` are both in scope), [ADR 0011](0011-conductor-involvement-locks.md) (the config-
dial event shape `calibration` reuses verbatim).
**Tracks:** issues #11, #93, and #102.

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
in shape: a private field, a getter, and `setCalibration(k, throughOrder)` that goes through the same rev/event
machinery every other config dial uses (`this.revCounter++`, emit `{ type: "config", calibration, rev
}`). It rides `SnapshotState` (optional, same "a stale/test literal without it still type-checks"
treatment as v15's `carriedSent`) and the `config` `WireEvent`, so a replica hydrates and replays it
exactly like `budget`/`protectTokens` — `core/replica.ts`'s `serializeSnapshot`/`hydrateSnapshot`/
`wireEventFromTruthEvent`/`applyWireEvent` all round-trip it. Protocol v20 also carries the receipt's
`calibrationThroughOrder` coverage frontier. A structural-divergence rebuild resets calibration to
the cold state because reordered/inserted blocks make the old scalar frontier ambiguous.

`Truth.calTokens(n) = Math.round(n * calibration)` remains the generic estimate helper for content
that is not a session block. Block reads use `calBlockTokens(block, n)`, which applies k only when the
block's order is at or below `calibrationThroughOrder`; later blocks remain raw. Protocol v18
introduced `calibration`
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

`setCalibration(k, throughOrder)` always overwrites — no EMA, no bounding window, no outlier rejection beyond
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
`store.calibrationThroughOrder === null` (covers both cold start and every read-only/demo/CC/file session in one
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

### `protectedFromIndex`: receipt-covered blocks and new blocks use different weights

`computeProtectedFromIndex` (`core/truth.ts`) walks real-weighted block costs: `tokens * k` for a
block covered by the latest receipt, otherwise raw `tokens`. It keeps those values unrounded during
the walk, avoiding cumulative per-block rounding. Host and replica carry the same k, frontier, and
block order, so they compute the same boundary. The old single `targetReal / k` division was valid
only while one multiplier applied to the entire log; issue #102 deliberately removes that premise.

### `Truth.stats()`: covered and newly appended totals are partitioned

`stats().liveTokens`/`fullTokens` partition the current total into receipt-covered and uncovered raw
sums, then report `round(covered * k + uncovered)`. `liveTokens()`/`fullTokens()` themselves stay the
raw accessors every other internal caller (`effTokens`, group accounting, `serializeWire`) needs.
`budget`/`protectTokens`/`contextWindow`/`protectedFromIndex`/`blockCount` are unconverted
(the first three are literal dial values under the convention above; the last two are already
calibration-aware or structural facts, not token sums). Issue #93's addendum (below) adds the system
prompt's raw estimate into what `liveTokens()`/`fullTokens()` sum — the calibration mechanism here is
otherwise unchanged, it's just summing one more raw quantity before the single `calTokens` call.

### The app: closing the hero/bar/flag disagreement stage 1 accepted

`store.overBudget` now compares the frontier-aware calibrated live total against `budget` (previously a raw-vs-raw
comparison sitting next to an already-calibrated hero readout — exactly the disagreement stage 1's
Consequences called out). `MapHeader`'s composition-bar axis (`denom`) and everything scaled against
it (segment widths, the budget marker, headroom, the protected-tail handle/underline) now run on
the calibrated full total instead of the raw total, so the bar's proportions agree with the calibrated
hero numbers and with `budget`/`protectTokens` (both already real-token dial values). `calBudget` —
stage 1's `calTokens(budget)` — is now simply `budget` itself: under the new convention the dial is
ALREADY real, so multiplying it again would double-calibrate it and reintroduce a hero/flag mismatch
in the other direction. `ContextMap.svelte`'s `faceFor()` die-face binning now feeds on
`store.calBlockTokens(block, tokens)` (`tileDraw.ts`'s pure `faceFor` function
itself untouched) so a tile's visual weight matches its calibrated readout.

## Consequences

- **Protected-boundary twitch, as predicted.** Because `protectedFromIndex()` now reads the
  calibration dial, the protected-tail boundary can shift by a block or two on a calibration snap
  (once per model reply) even though no block actually changed size — this was called out as an
  expected stage-2 consequence in the original version of this ADR, and stage 2 confirms it: it is the
  direct, intended effect of sizing the tail in real tokens rather than raw estimate tokens.
- **Smearing is still real and visible per-block — for tool-call schemas.** Stage 2 makes the smeared
  number load-bearing for MORE decisions (the protected boundary, a conductor's trigger) than stage 1
  did (display only), so this caveat matters. The issue-#93 addendum (below) removed the system
  prompt's contribution to this smear; a single multiplier still cannot separate "this block is
  genuinely bigger than we estimated" from "the tool-call schemas are bigger than we estimated."
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

## Addendum (issue #93) — the system prompt is un-smeared from `k`

Issue #93 made the system prompt a captured, visible fact (`Truth.systemPrompt`, `extension/
accordion.ts`'s `refreshFromCtx` reading `ExtensionContext.getSystemPrompt()` on every `context` hook).
That gave this ADR's "smearing caveat" a real fix for one of its two named terms.

**Before:** `est` (`Truth.liveTokens()`/`fullTokens()`, what `pendingWireEst` records) summed block
tokens only. `real` (the paired provider usage) always included the system prompt. `k = real/est`
therefore absorbed the system prompt's actual cost, smeared proportionally across every block —
exactly the "Smearing is still real and visible per-block" consequence stage 2 called out.

**After:** `liveTokens()`/`fullTokens()` now add the system prompt's own raw `estTokens` estimate
before summing blocks. `pendingWireEst` inherits this automatically (it reads `truth.liveTokens()`/
`fullTokens()` directly, no separate change needed at its call site). `k` no longer needs to correct
for a term it now has independently: only tool-call-schema overhead (the other, still-unaddressed
"belongs to no block" term named in the original smearing caveat) remains folded into the multiplier.

**Consequence:** `k` will visibly shift — expected downward — on a session's first calibration
observation after upgrade, since a real, previously-hidden source of numerator inflation is now
accounted for directly rather than smeared. This is a one-time, expected transition, not drift to
investigate. Sessions with a large system prompt relative to their block content see the bigger shift;
a session with a tiny or empty system prompt sees essentially none.

**Scope note:** this is not the affine fit from Deferred above — `k` is still a single, un-clamped,
un-smoothed multiplier (the Update Rule section is unchanged). It is a partial, mechanical
un-smearing of ONE known-named fixed-cost term, made tractable only because issue #93 needed the
system prompt's own token estimate captured anyway — not a step toward `base` as a fitted parameter.

## Addendum (issue #102) — a receipt calibrates only the wire it measured

Issue #102 exposed a category error in the original global-multiplier design. In the reproduced tool
loop, a 2,539-token block estimate paired with 15,943 real provider tokens, producing `k ≈ 6.28`.
Before another provider receipt arrived, an 8,851-token tool result was appended. Applying the stale
6.28 multiplier to that new block flashed roughly 71.5k; the next receipt immediately corrected the
display back near 25k. Nothing actually entered and left the context at that scale — only the estimate
spiked.

The fix records `{ est, throughOrder }` together at the `context` hook. When the matching assistant
usage lands, `setCalibration(real / est, throughOrder)` advances k and its coverage frontier
atomically. Existing covered blocks use k; blocks appended after `throughOrder` stay raw until the
next receipt covers them. In aggregate form this is `coveredRaw * k + newerRaw`, not
`(coveredRaw + newerRaw) * k`.

`sentThroughOrder` cannot substitute for this frontier. Sent-ness advances immediately when the wire
departs, before provider usage exists; using it when the receipt arrives would include blocks that
were appended after the measured request. The separately captured calibration frontier preserves the
causal pairing.

The current system prompt has equivalent coverage state: a prompt changed after the last receipt is
raw until the next one. Structural rebuilds reset k/frontier to the cold state because an order-only
frontier cannot prove coverage after blocks are inserted or reordered; the next request re-anchors it.

This deliberately does not implement the deferred affine regression. The observed spike was not
caused by the absence of a fitted base term; it was caused by applying any stale calibration to
content that calibration had never measured.
