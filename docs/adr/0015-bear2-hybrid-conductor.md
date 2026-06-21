# ADR 0015 — Bear-2 hybrid conductor: a recency-graded compression gradient

**Status:** accepted (implemented — PR #70)
**Date:** 2026-06-20
**Builds on:** [ADR 0007](0007-conductor-protocol.md) (the conductor seam), [ADR
0008](0008-conductor-first-party-one-view.md) (one public `ConductorView`), [ADR
0011](0011-conductor-involvement-locks.md) (involvement locks), [ADR
0013](0013-conductor-host-capabilities.md) (`ConductorHost` capabilities — the
`complete` pattern this conductor copies for a second capability), [ADR
0014](0014-naive-compaction-conductor.md) (the naive-compaction conductor this one forks).

## Context

[Bear-2](https://thetokencompany.com) (The Token Company) is an **extractive, discriminative**
token-deletion model: a small classifier scores each token's keep-probability and deletes the
low-signal ones. The output is always a strict subsequence of the original tokens — never
generated text. It is **deterministic** (same input + same aggressiveness → byte-identical
output) and tunable by an aggressiveness knob `τ ∈ [0,1]`.

Live API testing (scripts in `~/Desktop/Claude Work Space/ttc-test/`) established:

- **τ=0.2** yields ~10–15% token savings on prose (thinking, assistant text, prose tool
  results) while staying **coherent and readable** — the agent can read the compressed text
  directly, no unfolding needed.
- **τ=0.5** yields ~45% but the output becomes choppy/telegraphic — too aggressive to hand an
  agent as-is.
- Bear-2 **naturally no-ops on pure structured content** (JSON, code) — it returns ~0% savings,
  so it does not need a separate "is this code?" detector. (It *can* nick whitespace inside
  mixed prose+code blocks, but never enough to matter at τ=0.2.)

This is a different tool from LLM compaction. Compaction (ADR 0014) is **generative and lossy**
— an LLM rewrites the history into a prose summary the agent can't recover from. Bear-2 is
**extractive and lite** — it shaves redundant tokens out of otherwise-intact prose. The two are
complementary: Bear-2 is cheap and preserves readability; compaction is expensive and destroys
it but achieves far higher reduction.

The PoC question this conductor exists to answer: **does inserting a lite, readable Bear-2 band
between the live tail and the destroyed (summarized) oldest region buy useful headroom while
keeping more of the recent-but-aged context legible than pure compaction would?**

## Decision

Ship `bear2-hybrid` ("Bear-2 hybrid"), an **in-process fork of the naive-compaction conductor**
that applies a **recency-graded compression gradient** across the aged region:

```
   ┌─────────────── protected working tail ───────────────┐  ← raw, untouched (host floor)
   │  newest reasoning, never folded                       │
   ├─────────────── newer half of aged region ────────────┤  ← Bear-2 replace, τ=0.2 (lite, legible)
   │  aged but recent: lightly shaved, still readable      │
   ├─────────────── older half of aged region ────────────┤  ← LLM summary group (naive compaction)
   │  oldest: collapsed to one prose summary (lossy)       │
   └───────────────────────────────────────────────────────┘
```

The older half is **naive compaction, verbatim** (same prompt, same recursive/amnesiac merge).
The newer half is the only genuinely new machinery: per-block Bear-2 `replace` at τ=0.2.

### Trigger and split

- **Single trigger:** the *visible* window crossing **90%** of budget — naive-compaction's
  exact hysteresis band. No special "first pass."
- **Visible-tokens accounting** (must subtract both savings sources, or it re-fires every pass
  since `view.liveTokens` is raw/unfolded):
  ```
  visible       = liveTokens − summarySaving − bear2Saving
  summarySaving = Σ(original tokens of summarized blocks) − summaryTokenCost
  bear2Saving   = Σ(original − compressed tokens, per Bear-2'd newer-half block)
  ```
- **Split point:** the **token midpoint** of the aged region (walk oldest→newest summing
  `tokens`; older half = up to 50% of aged tokens, newer half = the rest). Token midpoint, not
  block-count midpoint — blocks vary 30→5000 tokens, so a count split lopsides the token mass.
  Recomputed every trigger; blocks migrate newer→older naturally as the line marches forward.
- Each `conduct()` recomputes membership by index and emits **`replace` for current-newer-half
  blocks only, `group` for the older half only** — never both on one block, so no command
  conflict.

### Bear-2 newer half

- **Command:** `replace` per block, content = Bear-2 output. **One-way**: no `{#code FOLDED}`
  tag, no agent `unfold`/`recall`. The agent reads the compressed prose as-is; recovery is by
  **human detach only** (same recovery model as naive compaction).
- **Eligibility:** `text` / `thinking` / `tool_result` ≥ **400 tokens**. `user` and `tool_call`
  are skipped automatically — the host clamps `replace` on them `not-foldable`. No JSON
  pre-filter: "send everything we can"; Bear-2 no-ops on structured content on its own.
- **Aggressiveness:** **τ=0.2, fixed.** Baked into the app-side transport, not exposed on the
  conductor or the `compress` host method (keeps the contract surface tiny; easy to widen later).

### Older half

Naive compaction unchanged: fork `COMPACTION_SYSTEM` + the recursive `buildPrompt` path
verbatim. Originals are fed for newly-aged blocks (the `ConductorView` always carries full
`text`); the prior summary is preserved near word-for-word via the PRESERVE/MERGE wording;
recursive/amnesiac merge (prior summary + newly-aged only) for cost. User messages stay verbatim.

### Async orchestration

`conduct()` stays synchronous. Both transports are fire-and-forget → `requestRerun()`:

- **Cache by block id** — `Map<blockId, string>` of Bear-2 output. Bear-2 is deterministic, so
  a cached result is valid forever; each block is compressed **once**. Steady-state, only
  *newly-aged* blocks hit the API.
- **Concurrency ~8 in flight** (a more generous tier is available). Will check for a Bear-2
  **batch endpoint** (one call, many texts) at build time — if present, use it and the per-block
  rate-limit pressure largely evaporates.
- **Incremental emit** (full-state model makes this clean): each pass emits `replace` for every
  block already in the cache + the `group` once the summary resolves; uncached blocks stay raw
  and get compressed on a later pass.
- Both treatments **launch concurrently** on trigger; each applies as it resolves.

### Transport (the one additive interface change)

The Bear-2 API key lives in **Accordion's Settings** (webview), so the HTTP call originates
**app-side** — *not* through the pi extension (which would force the key across the loopback WS).

- New `settings.svelte.ts` field `bear2ApiKey` (localStorage-persisted) + a text-input row in
  `SettingsPanel.svelte`.
- **Additive** capability, mirroring how `complete`/`completer` were added (ADR 0013):
  - `HostCapabilityId` gains `"compress"`.
  - `ConductorHost` gains `compress(text: string): Promise<string>` (τ=0.2 baked app-side).
  - `AccordionStore` gains a `compressor` slot (parallel to `completer`).
  - A Tauri Rust command `compress_text` makes the actual HTTPS call to
    `api.thetokencompany.com/v1/compress` (bypasses browser CORS; keeps the key out of any
    committed source). Reads the key from the app's settings.
- **Not a break:** every existing conductor is untouched (none calls `can("compress")`); the
  built-in golden test stays byte-identical. The LLM summary still uses the existing
  `host.complete` (wire) path — so this conductor uses **two transports**, one per service.
- **Browser-dev caveat:** under `npm run dev` (no Tauri) a direct fetch may hit CORS. Acceptable
  — live steering is desktop-only anyway.

### Involvement locks (ADR 0011)

`["human-steering", "agent-unfold"]` — identical to naive compaction; `tail-size` stays
collaborative.

- `human-steering` is load-bearing twice over: it keeps the older-half region contiguous (so the
  one `group` is always a valid run) **and** prevents the human from fighting the per-block
  `replace` on the newer half.
- `agent-unfold`: neither half carries fold tags, so the agent has nothing to unfold; the lock is
  the honest declaration of intent.
- **Not** `tail-size`: locking it erases the protected tail and would let the conductor compact
  the live working tail.

### Failure behavior

A Bear-2 failure **is a full conductor failure** — the user must be unmistakably alerted, never
silently degraded (silent degrade would violate Accordion's source-of-truth principle for a
conductor whose entire identity is Bear-2).

| State | Behavior |
|---|---|
| **No key set** (not configured) | Idle. Actionable prompt: `setStatus("Bear-2 needs an API key — set it in Settings")`. Not the FAILED alarm. |
| **Transient network timeout** | Exactly **one** retry — but it fires on the very next pass (microtask), so it only guards an *instantaneous* blip. Any sustained failure (network/429/5xx lasting longer than a tick) exhausts the retry and trips the hard freeze below — by design. |
| **Hard runtime error** (401/429/5xx, or retry exhausted) | **Freeze hard**: hold last state, emit nothing new (no `replace`, no `group`), raise a loud persistent `setStatus("⛔ Bear-2 FAILED — conductor halted")` with a failure count. |
| **LLM summary `complete` failure** | Inherit naive compaction's handling (hold prior state, don't hammer). |

The freeze-hard choice accepts that context can overflow while Bear-2 is down — an explicit,
owner-approved tradeoff: the failure must be total and visible, not papered over by a
still-running compaction layer.

### Metrics (PoC must be falsifiable)

Continuous `setStatus` reporting the split so the headroom question is answerable at a glance,
e.g.:

```
Bear-2: 12 blocks · 8.4k saved (12%)  |  Summary: 47 blocks · 91k saved
```

Per-block Bear-2 events also land in the existing activity log. Uses `setStatus(text, metrics)`
as-is — **no interface change for metrics.**

## Build checklist

1. **Additive `compress` capability** — `HostCapabilityId` + `ConductorHost.compress` (contract),
   `AccordionStore.compressor` slot + `buildHost` wiring (store), Tauri `compress_text` command
   (Rust). Mirror the `complete`/`completer` plumbing exactly.
2. **Settings** — `bear2ApiKey` field in `settings.svelte.ts` + a row in `SettingsPanel.svelte`.
3. **Conductor** — `conductors/bear2-hybrid/bear2-hybrid.ts`: fork `compaction-naive`, add the
   token-midpoint split, the Bear-2 newer-half cache/emit loop, the dual-savings trigger math,
   and the failure state machine.
4. **Register** — one line in `conductors/index.ts` (`{ id: "bear2-hybrid", label: "Bear-2
   hybrid", locks: ["human-steering","agent-unfold"], create: () => new Bear2HybridConductor() }`).
5. **Verify** — `npm run check` (0 errors/0 warnings) + `npm run test` from the worktree `app/`;
   an end-to-end test through `AccordionStore.applyCommands` (per repo rule: MockHost unit tests
   miss host clamps). Confirm the built-in golden test still passes byte-identically.

## Consequences

- **New external dependency + cost surface.** Every newly-aged prose block ≥400 tok costs one
  Bear-2 API call (once, cached). Network/key failures now have blast radius — mitigated by
  freeze-hard + loud alerting, not by hiding them.
- **Prompt-cache churn.** A `replace` rewrites the prefix → busts the provider prompt cache for
  that block, and again when it later ages into the summary. Accepted for a PoC; a cache-stable
  variant (epoch-batched like `cold-epoch`) is a possible follow-up if the PoC validates Bear-2's
  value.
- **Two transports in one conductor** (app-side Tauri HTTP for Bear-2, wire `complete` for the
  summary) — first conductor to do so; sets the pattern for future app-side host capabilities.
- **Lite + heavy gradient is novel** among the conductors: every existing one applies a single
  strategy uniformly. If it validates, the gradient idea generalizes (e.g. Bear-2 → cold-score →
  summary as a three-tier gradient).
