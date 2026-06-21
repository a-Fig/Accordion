# The Conductor v2 — recoverable `the_conductor` strategy

> A self-calibrating, relevance-driven context conductor for Accordion. It keeps
> [`the_conductor`](https://github.com/)'s **strategy** intact — the TCP-like fold-target
> calibrator, graduated Full/Trim/Digest/Group fold levels, three-stage relevance
> (keyword → embeddings → cross-encoder rerank), and risk-aware unfold floors — and re-expresses
> only its **I/O** against Accordion's `conduct(view) → Command[]` contract. V2 keeps v1
> available and adds recoverable custom digests, host-native summaries, structured telemetry,
> and stricter host-valid grouping.

This is an external WebSocket conductor (like [`../tiered-relevance`](../tiered-relevance),
[`../attention-folder`](../attention-folder), [`../recency-folder`](../recency-folder)): it hosts
a WS server, advertises under `~/.accordion/conductors/` for desktop auto-discovery, and Accordion
dials in. Pick **The Conductor** from the header conductor switcher once it's running.

It advertises as **`the-conductor-v2`** / **The Conductor v2** on port **7704** by default.
It is **collaborative** — it declares no involvement locks, so human and agent overrides always
win and the host's protected working tail is absolute.

## Why this exists (vs. `tiered-relevance`)

`the_conductor` began as a fork of a much older Accordion and diverged into a standalone pi
extension (`runConductor(messages) → rewritten messages`) carrying a rich context strategy.
Accordion meanwhile grew a clean conductor contract. There is already a
[`tiered-relevance`](../tiered-relevance) conductor that *reinterprets* the_conductor's idea as a
unified-relevance level-of-detail equilibrium — deliberately simpler. **The Conductor is the
opposite choice: a faithful port.** It vendors the_conductor's actual strategy code
(`strategy.ts`) and changes only the two ends:

| | the_conductor | The Conductor |
| --- | --- | --- |
| Input | `parseMessages(rawMessages)` | host-supplied `ViewBlock[]` → `ParsedContext` (`adapter.ts`) |
| Output | mutates message content, returns messages | `fold` / `replace` / `group` commands (`commands.ts`) |
| Protected tail | recomputed token-walk | host's `protected` flag (host owns it) |
| Pins / overrides | own state | host's `held` flag + `host/event` corrections |
| State | pi session entries | per-connection instance memory |

The strategy core (`strategy.ts`) is byte-for-byte the_conductor's `runConductor` middle —
`computeFoldPlan` is the same Stages 2–6, only its input adapter and return value differ.

## The model

**Fold levels** (graduated, not binary):

| Level | Name | What the agent sees | Command |
| --- | --- | --- | --- |
| 0 | Full | original text | — |
| 1 | Trim | `{#code FOLDED}` + query-aware extractive excerpt (~25%) | `replace{ content }` |
| 2 | Digest | `{#code FOLDED}` + salience digest, cached host summary, or own-key summary | `fold{ digest }` |
| 3 | Group | `{#code FOLDED}` + a host-valid contiguous run collapsed to one head summary | one `group{ ids, digest }` |

**Self-calibrating fold target** — a band `[0.60, 0.92]` that rises fast on corrections
(a human/agent unfold means it folded something needed) and decays slowly under quiet,
within-budget pressure. Like TCP congestion control: back off quickly, re-tighten slowly.

**Three-stage relevance** — keyword overlap → bi-encoder cosine (embeddings) → cross-encoder
rerank of the folded shortlist. Each stage is optional and degrades gracefully to the one below.

**Risk-aware unfold floors** — blocks whose digests carry `commands`/`paths`/`exact_values`/
`decisions` markers get a lower effective unfold cutoff: they re-surface on a weaker relevance
match, because they're the ones most likely to cause a wrong answer if left folded.

## What the contract changes (honest casualties)

This is a *faithful* port that **balances fidelity with clean integration**, so a few pieces of
the_conductor can't survive Accordion's command vocabulary unchanged:

1. **Semantic (non-contiguous) grouping is cut.** Accordion's `group` command requires a
   contiguous run (the host snaps it to whole messages). the_conductor's second pass clustered
   *non-adjacent* blocks by digest overlap — that can't be one command. Those blocks simply stay
   at Level 2 digest. The contiguous grouping pass is preserved.
2. **The agent-facing context header is cut.** the_conductor prepended a context-awareness note +
   **fact ledger** + **relevance TOC** to the agent's first message. Commands can only edit
   *existing* blocks — there is no synthetic-insert — so this can't reach the agent through the
   contract. Its main job (teaching the agent that folds are recoverable) is already done by the
   host's `{#code FOLDED}` tags + recall/unfold tools. **The ledger / TOC / folded-turn ranges
   are instead surfaced to the human** via `conductor/status` metrics. Restoring them for the
   agent would need a future contract "annotation" command.
3. **Conductor-initiated pins** are *not* invented. In this version of the_conductor the strategy
   never generated pin decisions (only the agent/app pin tools did, which Accordion handles host-
   side as `held`). The real anti-thrash — the one-pass **grace period** and the **calibrator** —
   is preserved and fed from `host/event` (`humanOverride` / `agentUnfold`).

## Run

```bash
npm install        # ws (required). @huggingface/transformers is OPTIONAL (embeddings + rerank).
npm start          # node the-conductor.ts   (Node ≥ 23.6, or ≥ 22.18 with --experimental-strip-types)
npm test           # node --test  (deterministic core, semantic path, calibration, WS round-trip)
```

Three capability tiers, each degrading gracefully:

1. **Host summaries** — Accordion supplies `cap/request complete` from the user's live model link;
   deterministic digests are shown until summaries return.
2. **Own-key summaries** — explicitly set `ACCORDION_SUMMARY_PROVIDER=anthropic|gemini|ollama`.
3. **Deterministic** — no host completion, disabled summaries, or provider failure → keyword relevance + deterministic digests. Still defends
   the budget band correctly; the relevance signal is just coarser.

See [`.env.example`](.env.example) for every knob. Defaults are deterministic-only so a bare
`npm start` works with zero configuration.

## Files

- `the-conductor.ts` — the WS server: discovery heartbeat, protocol lifecycle, async warm,
  change-gated emit (holds when the desired state is unchanged so the prompt cache stays warm),
  `host/event` corrections, and the human-facing `conductor/status` surface.
- `strategy.ts` — the vendored strategy core from `the_conductor/src/conductor.ts`; `runConductor`
  refactored into `computeFoldPlan` (pure: `ParsedContext` → fold levels + groups). All scoring,
  calibration, trim, digest, salience, relevance, embedding/rerank, and provider code is verbatim.
- `adapter.ts` — `ViewBlock` ↔ `ContextBlock`, the host-owned off-limits set, plan persistence.
- `commands.ts` — fold levels + groups → `fold` / `replace` / `group` commands.
- `*.test.ts` — `strategy` (deterministic core), `relevance` (semantic path via a fake embedder),
  `calibration` (corrections lift the target), `smoke` (a real WS round-trip).
- `scripts-check-providers.mjs` — a manual end-to-end check of the REAL embedding + rerank models
  (not part of `node --test`; needs network to download weights). `node scripts-check-providers.mjs`.

See [`../../docs/conductor-protocol.md`](../../docs/conductor-protocol.md) for the wire reference
and [`../contract/conductor.ts`](../contract/conductor.ts) for the `ConductorView` / `Command` shapes.
