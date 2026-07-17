# Thermocline

An **out-of-process** context-management conductor for Accordion: attention-gated, LLM-quality
compression staged in deliberate double-buffered epochs, under a **hard budget invariant** — the
agent is *never* over budget.

Thermocline is the synthesis of two earlier conductors:

- **attention-folder** — a small Qwen2.5-0.5B "probe" scores each block's *temperature* (how much
  the current working tail attends back to it). Cold = unattended = safe to compress. This gives
  compression an *order*.
- **compaction-naive** — real LLM prose summaries via `host.complete`, with user messages kept
  verbatim. This gives compression *depth* and a way to always free tokens.

…combined under a deterministic budget ladder whose last rung is a hard delete, so the planner
provably terminates at "protected tail + one minimal stratum" and can never outgrow the budget.

## Layout

| file | what |
|------|------|
| `policy.ts` | The PURE policy core — `buildUnits`, the L0–L4 fidelity ladder, `planEpoch`'s cheapest-first budget ladder, double-gate graduation, age-based safety net, hard-cap floor, deterministic tiers, prompt builders, and `emitOps`. No I/O, no host, no probe — a function of its arguments. |
| `thermocline.ts` | The epoch machine as a conductor-v2 `Conductor`, written against `ConductorHost`: HOLD / PREPARE / COMMIT / EMERGENCY, persistence, and the scoring loop. |
| `scorer.ts` | The temperature signal — spawns the Python probe as a child process; JSON-file I/O; graceful degradation when the probe is unavailable. |
| `probe/` | The vendored attention probe (`probe.py` + `requirements.txt`). |
| `runner.mjs` | The Phase-C out-of-process entry point (a documented stub until the remote SDK lands). |

## The fidelity ladder

Every block sits at the highest fidelity budget pressure and attention allow:

- **L0 Full** — original text (the protected tail and any attended block).
- **L1 Trim** — deterministic extractive excerpt (~head + tail + salient lines). Instant; the no-LLM
  placeholder / emergency fallback.
- **L2 Digest** — a faithful 1–3 line LLM summary, content-cached. Emitted as a `replace` op with
  `recoverable:true`; the **engine** prepends the canonical `{#code FOLDED}` tag.
- **L3 Stratum** — a contiguous cold *run* summarized holistically into one `group`. User messages
  reproduced verbatim. Recall-able by construction.
- **L4 Merged / drop** — graded forgetting of the deep zone; `group(summary:null)` is the floor.

## How the probe works

`scorer.ts` spawns `python3 probe/probe.py --in in.json --out out.json` as a **child process**
(never on any hook path). Input is `{ tail, blocks:[{id,text}] }` — the protected-tail text plus the
candidate blocks (tail capped at ~12k chars, each block head+tail capped at ~3k). The probe loads
Qwen2.5-0.5B, reads how much attention the final readout token pays to each earlier block, and
writes `{ scores:{id:0..1}, meta:{…} }`. Higher = hotter = keep live longer; the policy folds the
**coldest** first. Install the probe's deps with `pip install -r probe/requirements.txt` (a CUDA
GPU is ideal; CPU works, slower).

## Graceful degradation (mandatory)

If the probe binary, `python3`, or `torch`/`transformers` is absent — or the spawn fails, or it
times out — the scoring promise **rejects**, the conductor catches it, and the score map simply
stays empty. The policy's **age-based rung 3.5** and the **hard-cap floor** are probe-independent,
so the hard budget invariant still holds; the strategy just compacts by age instead of by attention.
This is a first-class path, unit-tested, not an afterthought.

## The epoch lifecycle

- **HOLD** (below `warmWater`≈80%) — re-derive the committed plan against the current view; propose
  only the delta. No LLM.
- **PREPARE** (crossing `warmWater`) — plan the next epoch and fire every L2/L3 `host.complete` in
  parallel, off to the side. A `prepareToken` generation guard discards a superseded prepare.
- **COMMIT** — reconcile against agent recalls/unfolds during prepare, substitute the *real* summary
  token counts, top up deterministically to ≤ cap, and propose **one** transaction.
- **EMERGENCY** (over the hard cap) — a deterministic plan (no LLM), proposed immediately. Also
  enforced on the `wire-departing` hook as the last-line guarantee (strictly deterministic).

### Governance

`locks: ["human-steering"]` only. `agent-unfold` is deliberately **unlocked** — the agent's `unfold`
IS graduation gate ②: a folded block the agent chose *not* to pull back is a signal it is safe to
compress. `recall` is never lockable.

## Double-gate graduation

A unit descends to a stratum only when **both** gates hold for K consecutive compaction epochs
(2K if it was ever warm): ① the probe temperature is cold, re-scored fresh, AND ② the agent did not
`recall`/`unfold` it while it sat folded. Any re-warm resets the dwell clock.

## Persistence

After each commit (deferred off every hook path), the deep zone (strata + their LLM summary text)
and graduation state (dwell + everWarm) are written atomically to
`<persistDir>/thermocline-state-<sessionKey>.json` (default `persistDir` = `~/.accordion/conductors`).
On attach the state is restored and validated against the live block ids; any stratum whose members
vanished is dropped.

## How Phase C launches it (out of process)

The owner's decision: **Thermocline runs in its own Node process.** In Phase C the pi extension
spawns `runner.mjs` with `ACCORDION_PORT` / `ACCORDION_TOKEN` (and optionally `ACCORDION_HOME`,
`ACCORDION_SESSION_KEY`). A remote SDK (`core/conductor/remote`, not yet built) mirrors the live
session's Truth into a local `ConductorHost` inside that process and calls `attach(host)`. Because
`ThermoclineConductor` is written only against `ConductorHost`, the exact same class is what today's
in-process unit tests drive against `TestHost` — no local/remote branch in the conductor itself.

See `runner.mjs` for the precise SDK surface, spawn env, and lifecycle Phase C must provide.
