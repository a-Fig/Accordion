# Conductor rework roadmap — C2 / C3 / C4

This document tracks the remaining slices of the PR #19 / PR #20 re-implementation onto
the current pluggable-conductor contract ([ADR 0007](adr/0007-conductor-protocol.md) /
[ADR 0008](adr/0008-conductor-first-party-one-view.md)). The re-implementation is
porting logic from those PRs — not rebasing them, since they predate the merged conductor
refactor.

## Status

| slice | what | state |
|-------|------|-------|
| **C1** — deterministic cold-score | ACT-R ranking + lexical pre-unfold + hysteresis | **Done** — `conductors/cold-score/`; [ADR 0009](adr/0009-cold-score-conductor.md) |
| **C1.5** — auto-coalesce | group long cold runs into a single stub | deferred — see below |
| **C2** — LLM summaries | folded blocks carry a real LLM-generated summary instead of a deterministic digest | deferred |
| **C3** — attentive tick | LLM proposes fold/unfold ops per turn; C1 cold-score pass as budget floor | deferred |
| **C4** — nested groups / eras | multi-level group collapse; era formation | deferred; gated on C1–C3 |

---

## C1.5 — Auto-coalesce (near-term cleanup, pairs with C2)

**Goal.** Group maximal contiguous runs of already-folded cold blocks into a single `group`
command — one carrier stub instead of N individual digest lines. The pure candidate-finding
logic (`findCoalesceRuns`) was written in PR #19 and is recoverable verbatim:

```bash
git show claude/busy-bose-bd815d:app/src/lib/engine/coalesce.ts
```

**Why it was deferred.** Emitting `group` commands is non-trivial under the current contract
because the host snaps a group's `ids` range **outward** to whole messages (`snappedRange`
in `store.svelte.ts`). After snapping, `classifyGroup` marks any block that creates a
tool-pair imbalance or falls outside a complete message boundary as a full-cost "straggler"
— it is included in the group's membership but counted at its original token cost, not the
compressed carrier cost. This means a naively emitted `group` can *increase* `liveTokens`
relative to the individual-stub baseline, causing a budget violation.

A conductor emitting group commands must therefore:

1. **Align run boundaries to whole messages** and keep `tool_call`/`tool_result` pairs
   intact within a chunk — so the snapped range matches the intended range exactly and
   straggler cost is zero.
2. **Re-project `liveTokens`** using the host's real group cost model: one carrier digest
   per group plus full-cost stragglers, then run a top-up fold pass when the net savings are
   negative.

Alternatively, the host could expose a **message-id per `ViewBlock`** so conductors can
align runs to message boundaries without guessing. That is the cleaner fix but requires a
`ConductorView` extension.

**Recommended path.** Port `findCoalesceRuns` into `conductors/cold-score/coalesce.ts`,
restrict eligible run starts/ends to whole-message boundaries (align to the block where
`order === 0`), and add a post-group budget re-check that top-up-folds if `liveTokens`
regresses. This pairs naturally with the C2 work: once C2 can produce real LLM summaries,
the group carrier digest can be an actual summary rather than a template stub.

---

## C2 — LLM (Gemini) summaries

**Goal.** Replace the deterministic per-kind digest for folded blocks with a real
LLM-generated summary. The agent receives a concise, human-readable synopsis of each folded
block rather than a template stub — better signal, lower re-unfold pressure.

**How it fits the contract.** The conductor emits `{ kind: "fold", ids: [X], digest: "<summary>" }`.
This already works end-to-end: `computeFoldOps` in `live/plan.ts` sends `store.digestOf(b)`
verbatim as `FoldOp.digestText`, and `digestOf` returns `b.subst` when set, which is the
conductor's custom digest. No contract changes needed for the fold itself.

Two requirements:

1. **Recovery tag.** The custom digest must include the `{#<code> FOLDED}` tag so the agent
   can still call `unfold({codes: [...]})`. The conductor prepends `foldCode(id)` (exported
   from `app/src/lib/engine/digest.ts`) before the LLM summary text.

2. **Async bridge.** `conduct()` is synchronous; an LLM call is async. The pattern: the
   conductor queues the LLM call off-thread, returns `null` (hold last state) while the call
   is in flight, then triggers a re-run when the result lands. The result is stored in a local
   cache keyed by content-hash (so the same block text never calls the LLM twice across turns).

**Reusable from PR #19 nearly verbatim** (all of it is store-independent):

- Rust `llm_generate` command + key/Vertex fallback chain (`app/src-tauri/src/lib.rs`).
- `llm/gateway.ts` — the TS → Rust call wrapper.
- `llm/prompts.ts` — summarisation prompt templates.
- `engine/summaryCache.ts` — content-addressed disk cache under `~/.accordion/summaries/`.

**What is new.** The async re-run hook (see "Host/contract extensions" below).

**Rough effort.** ~1–2 days: mostly async hook wiring + cache integration. The LLM call
itself and the fallback chain are already written.

---

## C3 — attentive tick (LLM proposes fold/unfold)

**Goal.** Once per turn an LLM reviewer ("the tick") reads the current context — the block
index + the protected tail — and proposes a fold/unfold plan. This goes beyond the C1
cold-score heuristic: the LLM can recognise semantic coherence, notice that a folded block
is explicitly referenced by concept (not just by identifier), and make judgement calls that
a pure relevance model cannot.

**Port from PR #19.** The logic to port is `conductor/tick.ts` in the `claude/busy-bose-bd815d`
branch:

```bash
git show claude/busy-bose-bd815d:app/src/lib/conductor/tick.ts
```

Functions: `buildIndex` (builds a compact block-index for the prompt), `buildTailText`
(the 32 k-char tail), `tickPrompt` (the full system+user prompt), `parseTickDecision`
(parses the LLM's JSON response into fold/unfold id lists). These are store-independent
and port without structural change.

**Architecture.** A C3 conductor runs C1 cold-score at the START of `conduct()` as a budget
floor (ensuring the session is always under budget regardless of LLM latency or failure),
then returns `null` while the tick is in flight. When the LLM result lands the conductor
re-runs, applying the LLM plan on top of the C1 floor. The earlier PR #19 `OFF / AUTO / SMART`
mode collapse maps cleanly: register two distinct in-process conductors (`cold-score` and
`attentive`) rather than a tri-state mode field — simpler registry and switcher behaviour.

**What is new.** Async hook (same as C2) + the tick infra port.

**Rough effort.** ~1–2 days once the async hook (C2's prerequisite) lands.

**Irreducible untestable hop.** The live Gemini call + the native desktop LLM path cannot
be exercised in headless CI. PR #19 itself shipped this gap; it remains unresolved. The
recommended mitigation is a manual smoke test against the sample session before merging.

---

## Host/contract extensions for C2 + C3

C2/C3 depend on the async hook below plus one remaining host-side addition:

### (1) In-process async re-run hook

**Status:** landed — the `Conductor` contract now has optional `attach(host)` / `detach()`
lifecycle hooks, and `ConductorHost.requestRerun()` schedules a debounced fresh store pass
for async in-process conductors. Stale requests from replaced conductors are ignored. The
remaining C2/C3 work can build on this hook.

Previously, only the WS escape-hatch path (`RemoteRunner`) got re-entry — a WS message
arrived and `store.refold()` was called. In-process conductors can now do the same without
becoming a separate process: fire `host.requestRerun()` from a `.then()` after caching the
async result, and the host re-enters `conduct()` without blocking the model-call path.

**Two paths for async conductors:**

- **Recommended — in-process + re-run hook.** Integrated into the registry, the header
  switcher, and the conductor dropdown without extra plumbing. One TS class, same authoring
  model. The hook is now available.
- **WS escape hatch.** Zero host changes; runs out-of-process; the async bridge is already
  there (the WS message → `store.refold()` path). Downside: the conductor must be a
  separate WS server process, complicating the dev loop and ruling out native Rust LLM
  calls from within the conductor itself.

The recommendation is in-process + re-run hook for C2 and C3.

### (2) Telemetry / return channel

A C3 conductor wants to surface: tick count, Gemini cost, cache hit/miss rate, and
whether a turn was evaluated or skipped (rate-limit / budget-not-exceeded shortcut). Today
`conduct() → Command[]` has no return channel for metadata.

**Required change:** a `ConductorPanel` UI slot and a lightweight side-channel — either a
conductor-emitted event (e.g. `conductor.on("telemetry", cb)`) or a `getTelemetry(): Record<string,unknown>` polling method the host calls after `conduct()`. The contract extension
is additive (optional method; old conductors are unaffected). UI work is small: an info row
or tooltip on the existing `ConductorMenu`.

### (3) Recovery tag on custom digests (small)

For C2, the conductor must prefix every custom digest with `foldCode(id)` (from
`app/src/lib/engine/digest.ts`). This is a one-line call at digest construction time, not a
host change. Document it in the conductor authoring guide once C2 lands.

---

## C4 — nested groups / eras (PR #20)

**Goal.** Compress entire topic-era spans into a single collapsible summary node (e.g. "File
exploration era, 12 exchanges") rather than a flat group stub. Two-level unfold: the era
summary opens to individual-block stubs; individual blocks unfold to full content.

**Two separable halves:**

### (a) ENGINE tree-model re-port (conductor-agnostic host infrastructure)

PR #20's engine changes are independent of any conductor strategy. They can be ported onto
the current `store.svelte.ts` / `plan.ts` / `digest.ts` without touching the conductor
contract. Pure function `findEraRuns` is already portable:

```bash
git show claude/busy-bose-bd815d:app/src/lib/engine/coalesce.ts
```

Pieces to port: `Group.children` (nested member list), `groupEraDigest` (the era-level
summary string), level-by-level unfold in `resolveUnfold`, `computeGroupOps` top-level
flattening (flattens nested groups to the wire format), `ancestorChain` helper.

### (b) WHO forms eras — a contract decision

The current `Command` union has no vocabulary for nested groups. `group` collapses a flat
contiguous run (`ids: [startId, endId]`); there is no `era` or `nest` command. Two options:

- **Add `era` to the `Command` union.** The conductor explicitly names era boundaries.
  Requires a protocol bump (`CONDUCTOR_PROTOCOL_VERSION = 3`) and host-side era handling.
  Cleanest long-term but a contract change.
- **Make era formation host-automatic.** The host detects long-lived conductor groups and
  automatically promotes them to eras after a threshold number of turns. Conductors remain
  unaware. Simpler contract but less flexible (a conductor can't choose era boundaries).

Neither path is settled. The call should happen before any C4 implementation starts.

**Gating.** C4 is gated on C1–C3. The two-level unfold UX only makes sense when C3's LLM
tick is producing meaningful era-level summaries.

**Rough effort.** ~2–4 days (engine re-port + contract decision + store integration). The
engine half (a) is the most mechanical and can be parallelised with C2/C3 if desired.

---

## Sequencing and recommendation

```
C1.5 (auto-coalesce)      — ~0.5–1 d — port findCoalesceRuns; pairs with C2
C2 (LLM summaries)        — ~1–2 d — prerequisite: async re-run hook
C3 (attentive tick)       — ~1–2 d — prerequisite: C2 (async hook already done)
C4 (nested eras)          — ~2–4 d — prerequisite: C1–C3 + contract decision
```

**Recommended path for C2/C3:** build in-process with the re-run hook. Stand up the hook
first (a small, focused `store.svelte.ts` + optional `Conductor.attach?` change), then
layer C2 and C3 on top as a single conductor that starts from the C1 cold-score floor and
upgrades with LLM passes. Ship as `conductors/attentive/`. Smoke-test the Gemini call and
the native desktop path manually before merging; do not block on headless CI coverage of
the LLM hop.

**Recommendation on C4:** defer until C2/C3 are stable and real usage reveals whether era
compression is actually needed. The engine half (a) can be ported speculatively if a dev
wants to start early, but the contract decision (b) should not be made under time pressure.
