# thermocline

An external WebSocket conductor that combines two parents: **attention-folder** (a
Qwen2.5-0.5B probe scores each block's "temperature" — how much the working tail attends
back to it) and **compaction-naive** (real LLM prose summaries via the agent's own model
through `cap/request complete`), under a **hard budget invariant**, in deliberate
double-buffered epochs. The headline commitment: the agent is never over budget, guaranteed
by a move that always frees tokens. Attention decides order; the budget decides depth.

See [docs/thermocline-design.html](../../docs/thermocline-design.html) for the full design
rationale and [ADR 0015](../../docs/adr/0015-thermocline-conductor.md) for the decision record.

## The model

Every block sits at the highest fidelity its attention earns under the current budget
pressure. The **fidelity ladder**:

| Level | Name | What the agent sees |
|---|---|---|
| L0 | Full | original text — protected tail and attended blocks |
| L1 | Trim | deterministic extractive excerpt (~25%), instant; keeps paths, errors, decisions |
| L2 | Digest | faithful 1–3 line LLM summary via `host.complete`, content-hash cached; prefixed with `{#code FOLDED}` so the agent can `unfold`/`recall` it |
| L3 | Stratum | a contiguous cold run summarized holistically into one `group`; user messages verbatim; `recall` returns original text by construction |
| L4 | Merged / drop | oldest strata fuse into a coarser super-stratum; the floor is `group(digest: null)` — a hard delete that always frees tokens |

**Attention decides order, budget decides depth.** The probe scores "temperature"; coldest
units compress first. The budget invariant decides how deep the epoch must reach.

**Double-buffered epochs.** The conductor runs in three phases:

1. **HOLD** — below ~80% full. Byte-stable applied state re-sent each turn. Cache warm. No LLM calls.
2. **PREPARE** — crossing ~80%: compute the entire next state off to the side, firing every LLM digest and stratum summary in parallel while the agent keeps seeing the current stable state.
3. **COMMIT** — atomic swap in one update. One deliberate cache miss. Back to HOLD.

If a burst outruns PREPARE, an **emergency epoch** applies instantly (deterministic
tier only, no LLM), and the planned epoch still lands after.

**Double-gate graduation.** A unit may not descend to a stratum until BOTH gates hold,
sustained for K epochs: ① the probe temperature is cold (< `coldThreshold`), re-scored
fresh this epoch, AND ② the agent did not `recall`/`unfold` it while it sat folded (a
behavioral veto — the agent had the digest and the recovery tag and chose not to pull it
back). Any re-warm (fresh hot score, agent touch, or human hold) resets the dwell clock.
A unit that has ever been warm needs 2K epochs, not K.

**Per-run sedimentation.** A `tool_call` + its `tool_result` (same `callId`) are one
atomic unit and move together everywhere — a fold or group never orphans a result.
Graduated units are partitioned into maximal contiguous runs bounded by hot, held,
protected, or grouped "buoy" units; a run shorter than `minRunUnits` stays merely folded,
never becoming a stratum.

**Bounded, re-compressible deep zone.** The total tokens held in strata are capped at
`ceilingFrac` of budget. When a new stratum would overflow the ceiling, the oldest strata
merge into a coarser super-stratum (graded forgetting); the hard floor drops the oldest
stratum (`digest: null`) when the budget is still not met. This keeps the deep zone
constant in size regardless of session length. Immutable strata were rejected: they
accumulate without bound and break the budget invariant over long sessions.

**Recoverable LLM digests.** Every fold/stratum digest is prefixed with
`{#<foldCode(id)> FOLDED}`, copied byte-for-byte from the engine's `digest.ts`. The
agent can call `unfold` or `recall` on any L2 block exactly as a normal fold. `recall`
on a stratum group returns members' original `.text` regardless of the group summary —
strata are recall-able by construction.

**Size is first-class.** Within each coldness tier, units are sorted biggest-cold-first
(tokens saved descending) so the fewest commits achieve the most headroom. Units whose
saving is below `minFoldTokens` are skipped — not worth a cache slot.

**Persistence across reconnect.** The deep zone (strata + their actual LLM summary text)
and the dwell/everWarm graduation state are written to
`~/.accordion/conductors/thermocline-state-<sessionKey>.json` after each commit. On
reconnect the deep zone is restored with no new LLM call needed.

## Run

**Prerequisites:** Node.js, and the `attention-folder` Python venv set up (the probe is
shared — see [`../attention-folder/README.md`](../attention-folder/README.md) for the
Python/venv install steps). No separate API key needed for summaries: they run on the
agent's own model via `host.complete`.

```bash
cd conductors/thermocline
npm install       # only ws
npm start         # node thermocline.mjs — listens on ws://127.0.0.1:7703
```

The conductor advertises a heartbeat file at `~/.accordion/conductors/thermocline.json`
and is auto-discovered by the Accordion desktop app (not the browser dev server — live
discovery requires the native layer). Open the desktop app, load a session, and pick
**Thermocline** from the conductor dropdown in the map header.

```bash
npm test          # node --test — the pure policy (no GPU, no Python, no WS)
```

The unit tests cover `policy.mjs` exclusively and require no probe, no GPU, and no
running Accordion instance.

## Config

The port and all tuning knobs can be overridden via environment variables. Defaults from
`policy.mjs DEFAULT_CFG`:

| Variable | Default | What it does |
|---|---|---|
| `THERMO_PORT` | `7703` | WebSocket port |
| `THERMO_HIGH_WATER` | `0.9` | a planned epoch must have finished before this fraction of cap |
| `THERMO_LOW_WATER` | `0.7` | `planEpoch` composes moves until projected tokens ≤ this fraction of cap |
| `THERMO_WARM_WATER` | `0.8` | begin PREPARE around this fraction of cap |
| `THERMO_CEILING_FRAC` | `0.2` | stratum tokens may not exceed this fraction of cap |
| `THERMO_COLD_THRESHOLD` | `0.35` | temperature below which a unit counts as cold (0..1, higher = hotter) |
| `THERMO_K` | `3` | dwell epochs a unit must stay cold+untouched before graduating to a stratum (2K if ever-warm) |
| `THERMO_MIN_RUN_UNITS` | `3` | a run shorter than this stays merely folded, never becomes a stratum |
| `THERMO_MIN_FOLD_TOKENS` | `200` | a fold whose saving is below this is skipped (not worth a cache slot) |

## Files

- `thermocline.mjs` — WS server: epoch machine, HOLD/PREPARE/COMMIT/EMERGENCY, cap/request bridge, persistence, heartbeat. `node thermocline.mjs --smoke` runs an inline, dependency-free smoke harness (no `ws`, no probe) covering the budget-at-commit top-up and per-epoch dwell.
- `policy.mjs` — pure policy core: `planEpoch`, `updateGraduation`, `sedimentRuns`, `emitCommands`, prompt builders, deterministic fallbacks. No I/O, no `Date.now()`, fully unit-testable.
- `scorer.mjs` — thin re-export shim: delegates to `../attention-folder/scorer.mjs` so the probe path is always correct regardless of invocation cwd.
- `policy.test.mjs` — unit tests for the pure policy (`node --test`, no GPU, no Python, no WS).
- `package.json` — `start` / `test` scripts; single dep: `ws`.
- `launch.json` — VS Code launch config.

## Governance

Thermocline locks **`human-steering`** (strata + dwell bookkeeping need a single owner to
stay wire-valid — the same reason `compaction-naive` locks it; consent gate on attach).
**`agent-unfold` is deliberately kept open**: the agent's `unfold` is gate ② of the
double-gate, a real compaction veto. Locking the agent out (as `compaction-naive` does)
would defeat that veto. **`recall` always works** — ADR 0011 floor; `recall` on a stratum
exhumes original block text even from a compacted group.
