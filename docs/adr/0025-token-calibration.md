# ADR 0025 — Provider-anchored token calibration

**Status:** accepted, stage 1 shipped (plumbing + display; see Deferred for stage 2)
**Date:** 2026-07-24
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

### Stage-1 invariant: decision math is untouched

`canFold`, `protectedFromIndex`, `stats()`, `serializeWire`/`computeFoldOps`/`computeGroupOps`, and
every conductor-visible number (`ConductorHost.stats`/`countTokens`) read the raw chars/4 estimate,
exactly as before this ADR. `calibration` is invisible to that whole surface — `core/conductor/
hostAdapter.ts`'s `hostEventsFromTruthEvent` explicitly drops a calibration-only `config` event rather
than let it fall through to the existing `budget !== undefined ? "budget" : "protect"` default and
mislabel it a "protect" change, which would otherwise wake every subscribed conductor once per model
reply for a dial it was never meant to see. Stage 1 is plumbing and display; stage 2 (below) is a
separate, later decision about whether/how the fold boundary itself should read calibrated numbers.

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
readouts all route through `store.calTokens(n)`; tile canvas drawing (dice-face bins) is untouched —
stage 2's call, not stage 1's (see below). No new colors — the marker is `var(--muted)`/`var(--faint)`,
matching the existing monochrome UI-chrome rule.

## Consequences

- **A calibrated number and the raw decision it sits next to can visibly disagree in stage 1.** The
  hero line's live/budget text is calibrated for internal consistency (both numbers route through the
  same `calTokens`, so their on-screen ratio still reads sensibly), but `store.overBudget`'s color and
  every fold-boundary decision stay on the raw estimate — so, rarely, the calibrated numbers can read
  as "under" while the tint says "over," or vice versa. Accepted as a stage-1-only cosmetic artifact;
  stage 2 is exactly the decision about whether to close this gap by calibrating the decision math too.
- **Smearing is real and visible per-block.** A single multiplier cannot separate "this block is
  genuinely bigger than we estimated" from "the system prompt is bigger than we estimated" — both show
  up as the same per-block nudge. Most visible on a session with an unusually large tool schema set.
- **One-turn lag.** `k` reflects the LAST completed request, not the one about to be sent — a session
  whose content shape just changed sharply (a burst of code after a burst of prose) sees the new `k`
  only after that shift's own reply lands, not preemptively.
- **Protected-boundary twitch, deferred.** Because `protectedFromIndex()` still walks raw estimates,
  turning stage 2 on later (calibrating the fold/protect math itself) will make the protected-tail
  boundary jump slightly on every calibration snap, as the walk-back's token sum changes underneath it
  without any block actually changing size. Called out here so it is not a surprise when stage 2 lands
  — stage 1 cannot exhibit this, since it never feeds `calTokens` back into `protectedFromIndex`.

## Deferred (stage 2)

- **The affine fit (`real = base + k·est`).** Needs ≥2 observations and a real regression (or at least
  a two-parameter least-squares over a short rolling window) — out of scope here; stage 1 ships the
  pure multiplier knowingly, not as a placeholder for "we'll get to it eventually" but as the
  documented first step.
- **Decision math using calibrated numbers.** Whether `canFold`/`protectedFromIndex`/the budget
  comparison should read `calTokens` output is a separate, later decision — it changes what the model
  actually receives (or when a human/strategy's fold gate fires), which this stage was explicitly
  scoped to leave untouched.
- **Smoothing / outlier rejection.** Once there is an affine fit to smooth, raw-snap-per-observation
  stops being the obviously-simplest option; revisit together with the affine work, not before.
- **Dice-face tile bins.** `ContextMap.svelte`'s `faceFor()` thresholds stay on raw bins in stage 1
  (explicitly out of scope per the task that shipped this ADR) — a calibration-aware bin scheme is a
  stage-2 visual call, not a plumbing one.
