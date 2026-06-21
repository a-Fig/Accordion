# ADR 0015 — Thermocline conductor: attention-gated LLM compression in deliberate epochs

**Status:** proposed / implemented, not yet integration-tested end-to-end
**Date:** 2026-06-20
**Builds on:** [ADR 0007](0007-conductor-protocol.md) (the conductor seam),
[ADR 0008](0008-conductor-first-party-one-view.md) (first-party conductors, one public
`ConductorView`), [ADR 0010](0010-attention-conductor.md) (the attention probe and
epoch model), [ADR 0013](0013-conductor-host-capabilities.md) (`ConductorHost.complete`),
[ADR 0014](0014-naive-compaction-conductor.md) (the naive compaction baseline).

## Context

The two existing conductors that do real compression each have a single critical weakness:

**attention-folder** (ADR 0010) has a learned relevance signal — the Qwen2.5-0.5B probe's
structural gravity — and a cache-warm epoch model. But it only ever folds to shallow
per-block digests (the engine's mechanical per-kind stub, no LLM), only ever grows the
fold set, and eventually runs out of reversible room. Once everything foldable is folded,
it can no longer free tokens under a hard budget — the band becomes best-effort, not
guaranteed.

**compaction-naive** (ADR 0014) does real token recovery via LLM prose summaries and can
always free space. But it is blind — it compacts by age alone, no relevance signal — and
its design is deliberately irreversible (no `{#code FOLDED}` tags, so no agent `unfold`)
and recursively amnesiac (each compaction summarizes its own prior summary, compounding
loss linearly over everything aged).

Neither conductor achieves both: guaranteed budget compliance with an attention-ordered,
recoverable, non-amnesiac compression path.

The gap is the synthesis: give the deep-compression engine an attention admission test and
LLM-quality intermediate digests; stage every irreversible step behind a reversible
recoverable probation; and bound the result so it cannot outgrow the budget regardless of
session length. That is Thermocline.

## Decision

### 1. External WebSocket conductor reusing the attention-folder probe

Thermocline is an external WS conductor (`conductors/thermocline/`) matching the topology
of attention-folder: the Node.js process hosts `ws://127.0.0.1:7703` (default;
`THERMO_PORT` overrides), advertises a heartbeat file at
`~/.accordion/conductors/thermocline.json`, and is auto-discovered by the Accordion
desktop app. Accordion dials in as a client (protocol v3, `CONDUCTOR_PROTOCOL_VERSION = 3`).

The probe is the same Qwen2.5-0.5B subprocess used by attention-folder. Rather than
duplicating the spawn and temp-file logic, `scorer.mjs` re-exports `scoreCandidates` and
`tailTextFromView` directly from `../attention-folder/scorer.mjs` via a cwd-independent
absolute path. The probe path therefore resolves correctly regardless of invocation
working directory.

LLM summaries run on the agent's own model via `cap/request complete` — the same
`ConductorHost.complete` channel in-process conductors use, relayed out-of-band through
the pi extension (ADR 0013). No separate API key or model is needed.

The code is split into a pure-data policy module (`policy.mjs` — no I/O, no `Date.now()`,
no mutation of inputs; fully unit-testable with bare `node --test`) and a stateful server
module (`thermocline.mjs` — owns the WebSocket, probe child, cap/request bridge,
applied-state memory, and persistence).

### 2. Hard budget invariant via a deterministic budget ladder

Thermocline's founding commitment, above relevance and above cache: the agent is never
over budget. This is enforced by `planEpoch`, a deterministic budget ladder that composes
moves cheapest-first until the projected token count fits under `lowWater·cap`, or it
bottoms out. The ladder has four rungs:

1. **Deepen** the coldest eligible unit to a per-block fold (Full → Trim → Digest).
   Eligible = foldable kind (`text`, `thinking`, `tool_result`), not held, not protected,
   not grouped, saving ≥ `minFoldTokens`. Ordered biggest-cold-first: largest saving first,
   then colder, then older. Tiny units (saving < `minFoldTokens`) are skipped.
2. **Graduate** a double-gated cold run into a stratum (a `group` command with an LLM
   holistic summary as its digest). Strata are sediment — formed from maximal contiguous
   runs of graduated units, bounded by "buoy" units (hot, held, protected, or grouped),
   with a minimum run length (`minRunUnits`).
3. **Merge** the oldest strata if the deep zone exceeds `ceilingFrac·cap`. The two oldest
   strata fuse into a coarser super-stratum; repeated until the zone fits. Graded
   forgetting: recent strata stay fine-grained; ancient ones blur.
4. **Drop** the oldest stratum (`group(digest: null)`, a hard delete). This rung is always
   available while any stratum exists and always strictly reduces tokens. It is what makes
   the invariant a guarantee rather than a hope. The loop terminates at "protected tail + one
   minimal stratum"; below that is the human's budget/tail dials, not the conductor's to touch.

Rung 3.5 (age-based last resort) is engaged only when rungs 1–3 are insufficient:
maximal contiguous runs of old eligible units are compacted without requiring graduation.
This is the probe-independent safety net that keeps the invariant even when scores are
empty (no probe, degraded mode).

Token accounting uses explicit-set arithmetic (`project(view, applied)`) and never infers
folds from view flags, so there is no double-counting between the folded set and strata.

### 3. Double-buffered epoch lifecycle

Thermocline runs like double-buffered graphics: the entire next state is computed and all
LLM summaries are collected off to the side, while the agent keeps seeing the current
byte-stable state. When everything is ready, the new state commits atomically in one
update.

**HOLD** — below `warmWater·cap` (~80%). Re-sends the current applied state unchanged each
turn. No LLM calls. The prompt cache is warm.

**PREPARE** — crossing `warmWater`: `planEpoch` plans the next target; every LLM digest
(`cap/request complete`, 120 s timeout per call) and stratum summary fires in parallel.
A stale-token mechanism (incrementing `prepareToken`) allows a superseded prepare to be
cleanly discarded if a human override, agent unfold, or emergency epoch intervenes.

**COMMIT** — atomic swap: the full next state replaces the current one in one
`conductor/commands` message, dropping to `lowWater·cap`. One deliberate cache miss.
Strata and summaries are persisted to disk immediately after commit.

**EMERGENCY** — if a burst would breach budget before PREPARE is ready, an instant
deterministic epoch (`planEpoch(view, scores, state, cfg, { deterministic: true })`)
commits immediately with no LLM. The Trim tier stands in for Digest; deterministic recap
stands in for stratum summaries. The LLM-quality epoch still arrives after.

### 4. Fidelity ladder with recoverable LLM digests

Every block sits at the highest fidelity the budget pressure and attention allow:

- **L0 Full** — original text; the protected tail and any attended block.
- **L1 Trim** — query-aware extractive excerpt (~25%): head + tail lines, plus any line
  carrying a path, error marker, or quoted value kept unconditionally. Deterministic,
  instant, used as the placeholder and no-LLM fallback.
- **L2 Digest** — faithful 1–3 line LLM summary via `host.complete`, content-hash cached
  forever (one call per unit, never repeated). Committed during PREPARE; Trim stands in
  for the emergency epoch. The fix over attention-folder's mechanical stub: the most-
  populated layer is now LLM-quality.
- **L3 Stratum** — a contiguous cold run summarized holistically into a single `group`
  command (shorter than the sum of its L2 digests — cross-unit deduplication). User
  messages reproduced verbatim in the summary (Claude Code `/compact` convention); only
  assistant reasoning is condensed.
- **L4 Merged / drop** — graded forgetting of the deep zone; `digest: null` is the floor.

**Recoverability verified — no platform change required.** The host passes a conductor's
custom fold digest verbatim, and `resolveUnfold`/`resolveRecall` match the agent's code
against `foldCode(id)` independent of the body text. Every L1/L2 digest is therefore
prefixed with `{#${foldCode(id)} FOLDED}` (copied byte-for-byte from `engine/digest.ts`)
and the agent can `unfold` or `recall` it exactly as a normal fold. `recall` on a stratum
group returns members' original `.text` regardless of the group summary — strata are
recall-able by construction. The `foldCode` algorithm is copied verbatim into `policy.mjs`
and must be kept in lockstep if `engine/digest.ts` ever changes.

### 5. Double-gate graduation

A unit may not descend to a stratum until both gates hold, sustained for K consecutive
epochs:

- **Gate ①** — the probe temperature is cold (< `coldThreshold`), re-scored fresh this
  epoch. The threshold (`coldThreshold = 0.35`) is deliberately conservative: the cost of
  leaving a warm-ish block at full fidelity is a few tokens; the cost of compressing a
  still-needed block is a quality regression.
- **Gate ②** — the agent did NOT `recall` or `unfold` the block while it sat folded
  (behavioral veto). The agent had the digest and the recovery tag and chose not to pull
  the content back.

Any re-warm resets the dwell clock to zero. A unit that has ever been warm (scored ≥
`coldThreshold` at any prior epoch) goes into `everWarm` and must sustain 2K epochs of
cold+untouched, not K. This probation-within-a-probation guards against the known
recency bias in the probe's scores.

`agentUnfold` host events veto graduation and discard any in-flight PREPARE that would
compact the touched unit.

### 6. Bounded, re-compressible deep zone (immutable strata rejected)

Immutable strata were considered and rejected. Over a long session, N strata accumulate
and their token sum eventually exceeds any fixed ceiling with no reclaim path — a fatal
flaw for the budget invariant.

Instead, the deep zone lives under a fixed token ceiling (`ceilingFrac·cap`, default 20%
of budget). Rung 3 (ceiling merge) fuses the oldest strata into a coarser super-stratum
when the zone overflows; rung 4 (drop floor) hard-deletes the oldest when merging is
insufficient. This makes deep-zone token cost constant regardless of session length. The
recursive amnesia of the deep zone is bounded-log (the oldest, coldest content blurs with
age) rather than the linear amnesia of naive compaction (which re-reads its own summary
for everything aged).

### 7. Persistence across reconnect

After each commit, the deep zone (strata with their actual LLM summary text) and
graduation state (dwell clock, everWarm set) are written atomically to
`~/.accordion/conductors/thermocline-state-<sessionKey>.json`, where `sessionKey` is an
FNV-1a 32-bit hash of the session's title, model, and cwd. On reconnect the state is
restored from disk, so the compacted history and graduation progress survive without new
LLM calls. The saved file is bounded by the deep zone ceiling (constant size).

### 8. Governance

Thermocline declares `locks: ["human-steering"]` in its `conductor/hello` handshake,
triggering the ADR 0011 consent gate on attach. The lock is load-bearing: strata and dwell
bookkeeping need a single owner to stay wire-valid; a human fold/unfold inside a compacted
run could split a stratum in ways the conductor cannot reconcile. The same reasoning
applies to `compaction-naive`.

**`agent-unfold` is deliberately kept open.** The agent's `unfold` is gate ② of the
double-gate graduation — a real compaction veto that makes the system responsive to the
agent's actual behavior. Locking the agent out (as `compaction-naive` does) would defeat
that veto and remove the behavioral second gate entirely.

**`recall` is never lockable** (ADR 0011 floor). `recall` on any block, including a
stratum, returns the original `.text`. The budget dial, observation (the live map, activity
log, budget readout), and detach are likewise never lockable.

Detach freezes the current folded view in place (fold state is human-reversible; no
reset-to-raw). Stale LLM completions in-flight are discarded via `prepareToken` bump; the
probe subprocess is aborted via `AbortController`.

## Consequences

**What this adds.** An external WS conductor that combines the attention probe's relevance
signal (order) with real LLM compression (depth), under a hard budget invariant that holds
in every mode — normal, PREPARE, and emergency. Unlike attention-folder, it can free tokens
beyond shallow folds; unlike compaction-naive, it is attention-ordered, recoverable, and
not recursively amnesiac over the whole aged region.

**What stays the same.** The attention-folder probe, its Python venv, and its scoring
logic are shared unchanged. The golden test (`conductor.builtin.test.ts`) is untouched.
The engine, the wire protocol, and all in-process conductors are untouched.

**Known tradeoffs and honest limitations.**

- **Attention-biased forgetting.** The probe has a known recency bias; cold scores skew
  toward old, far-from-tail blocks. The double gate (especially gate ②'s behavioral signal)
  and the 2K ever-warm probation reduce but do not eliminate this. ADR 0010 documents the
  probe's fine-rank instability; only coarse cold/warm distinctions should be trusted.
- **Ancient detail is genuinely lost.** Bounded memory under a fixed budget requires
  graded forgetting — information theory, not a flaw to engineer away. `recall` only works
  while a stratum exists; once dropped, that detail is gone. The design chooses the *shape*
  of the loss (recent-sharp, ancient-blurred, attention-spared), not its abolition.
- **LLM spend and latency.** One `cap/request complete` call per folded unit (cached
  forever after) plus per-stratum summary calls. Off the model-call path and
  budget-independent, but real cost. The deterministic Trim/recap shows until the LLM
  result lands.
- **Each epoch commit is a cache miss.** Epochs are deliberately infrequent (one per
  refill cycle) but each commit evicts the prompt cache from the changed point forward.
  An emergency epoch followed by a planned epoch commit is two cache misses in quick
  succession; rare but possible.
- **Age-based last-resort can compact un-graduated content.** Under extreme budget
  pressure, rung 3.5 compacts old content that has not cleared the double gate. `recall`
  still exhumes the original text, but the graduation probation is bypassed. This is a
  deliberate design choice to preserve the hard budget guarantee over the graduation gate.
- **No end-to-end integration test with GPU + app.** The pure policy (`policy.test.mjs`)
  and the wire lifecycle are testable without hardware. The full PREPARE→COMMIT path with
  a real probe and a real `cap/request complete` round-trip requires a running Accordion
  desktop instance with a live pi session and an NVIDIA GPU.
- **Stratum recoverability couples to the host's group-id format.** A stratum's recovery
  tag is `foldTag('g:' + firstMemberId)` to match the host's `g:${memberIds[0]}` group id
  (`store.svelte.ts`), so `unfold`/`recall` resolve. This holds because the conductor's runs
  are already whole-message / tool-pair snapped, so the host's outward snap does not move
  `memberIds[0]` off `firstId`. A host-side change to prepend the recovery tag to ANY
  conductor-supplied group digest would make this unconditional and is the cleaner fix (a
  small engine change, deferred to keep this PR conductor-only).
- **Dwell counts compaction epochs, not user turns.** Graduation advances at most once per
  tick and only when an epoch actually fires (EMERGENCY or ANTICIPATE), so the K-epoch
  probation is measured in compaction events, not raw `context/update` ticks.
- **The budget invariant outranks the recall veto under EMERGENCY.** On the PREPARE→commit
  path the agent's recall/unfold veto is honored at commit time (`reconcilePlan`). But when
  the context is already over the hard cap, the emergency deterministic top-up may re-fold a
  unit the agent just touched — staying ≤ cap wins, consistent with the ladder's floor-lift.
  In the common (empty-`touched`) case this never triggers.

## Out of scope (this cut)

- Score re-normalization across probe windows (ADR 0010's documented cross-window caveat
  applies here too).
- Automatic re-attach after a persistent `cap/request complete` failure; the human must
  re-select the conductor.
- Per-section quality heuristics or re-summarization on timeout.
- Model-spend accounting (`inputTokens`/`outputTokens`).
- Continuous, relevance-margin float-up (tiered-relevance style). Re-surfacing IS present,
  but only at epoch granularity: each epoch re-plans folds from current temperatures, so a
  unit whose attention recovered is not re-folded and returns to full at the next commit
  (plus the agent's `unfold`). A continuous mechanism is intentionally omitted — it would
  violate the epoch model.
