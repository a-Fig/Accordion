# The Conductor — Master Plan

> **Partly superseded by [ADR 0007](adr/0007-conductor-protocol.md).** This plan's
> framing of the built-in auto-folder as a permanent privileged backstop no longer holds:
> under ADR 0007 the built-in is just the *default* conductor — detachable and swappable —
> and "no conductor attached" means raw context, not auto-folded context. The milestone
> roadmap below (richer strategies: summaries, relevance, hierarchy) still stands.

> The last major feature before Accordion reaches its final form. This document turns
> VISION.md's one-paragraph definition into five cumulative milestones, each with a
> detailed work plan, the tools and data it needs, and measurable exit criteria.
> Companion to [VISION.md](../VISION.md); architectural decisions land as ADRs
> (0007+) as each milestone starts.

## What "the Conductor" means

VISION.md defines it in one sentence: *"Between every turn it reads what the agent is
doing, folds the sections that have gone cold, and unfolds the ones becoming relevant
again — keeping the most useful context in view and within budget on its own. It never
pins."*

That sentence hides four distinct capabilities, and they stack:

1. A **policy** for deciding what is cold and what is warming (today: kind-rank + age,
   fold-only, fires only when over budget).
2. **Summaries worth folding to** — a fold is only as safe as the residue it leaves.
3. **Reading what the agent is doing** — relevance, not just recency.
4. **Operating at scale and unattended** — hierarchy for long sessions, a runtime that
   doesn't die with the window, and a record that proves it can be trusted.

The milestones below build these in order. Each one is shippable on its own and none
is thrown away by the next.

## Where the codebase actually is (June 2026)

An honest inventory, because the plan must start from the real ground:

- **The auto-folder is a budget clamp, not a conductor.** `store.refold()` fires only
  when `liveTokens > budget`, sorts candidates by `FOLD_RANK` (kind) then age, and
  folds oldest-first until under budget. It never unfolds anything. There is no notion
  of relevance, warmth, or what the agent is currently doing.
- **Folds collapse to deterministic digests** (`digest.ts`) — skeletal, kind-shaped
  stubs prefixed with `{#code FOLDED}`. They tell the agent *that* something was here,
  not *what*. No LLM summaries exist anywhere.
- **The live loop works end-to-end** (ADRs 0001–0004): the extension syncs on pi's
  `context` hook, the GUI replies with a plan (`FoldOp[]` + `GroupOp[]`), and applying
  it to the live agent is opt-in (`folding.enabled`). All safety guards are
  double-enforced (`plan.ts` and `applyPlan`).
- **Agent self-unfold works** (ADR 0005, protocol v3): the agent calls
  `unfold({codes})` against `{#code FOLDED}` tags; `resolveUnfold` restores blocks with
  provenance `"agent"`. This matters enormously for the plan: **every agent unfold is a
  recorded conductor miss** — free ground truth for milestone C3.
- **Groups exist and collapse on the wire** (ADR 0006, protocol v4): manual, flat,
  contiguous ranges collapse to one synthetic summary message via `GroupOp`. The README
  understates this. What's missing is *nesting* and *conductor-built* groups — not the
  range-collapse machinery itself.
- **Known gaps that bite this plan:** the view syncs only on the `context` hook (an
  assistant's plain reply is invisible until the next user turn); the GUI is the brain,
  so nothing conducts when the window is closed; actively-tailed Claude Code sessions
  rebuild the store and drop folds.

## Invariants that hold across every milestone

These are non-negotiable and every milestone is designed around them:

- **No conductor work ever blocks or alters a model call beyond the returned plan.**
  The `context` hook stays I/O-free; any LLM call the conductor makes is async and its
  output applies to the *next* plan. The conductor is therefore structurally **one turn
  behind** — acceptable for folding, mostly acceptable for unfolding, and honest to
  document rather than hide.
- **The protected working tail is absolute.** No conductor at any milestone touches it.
- **Only durable-id `text` / `thinking` / `tool_result` blocks fold on the wire**;
  `tool_call` and `user` never do. Both sides keep enforcing this independently.
- **Pins overrule the conductor, always.** The conductor never pins (a pin exists to
  overrule it) and can never downgrade one.
- **Every conductor action is attributed and reversible.** New provenance value
  `"conductor"` joins `user | agent | auto`, shown in the activity log with a reason.
- **The deterministic budget clamp is the permanent backstop.** Whatever a smarter
  layer proposes, the C1 scoring pass runs last and guarantees the budget. A confused
  LLM conductor can waste tokens; it must never overflow the window.

## The ladder at a glance

| # | Name | One line | New capability | Depends on | Rough size |
|---|------|----------|----------------|-----------|------------|
| C1 | Cold-Score | Deterministic policy, bidirectional | Warmth scoring + lexical pre-unfold | — | 1–2 weeks |
| C2 | Summarizer | Folds carry meaning | Cached LLM summaries | — (parallel to C1) | 2–3 weeks |
| C2.5 | Auto-Coalesce | Fold the folds, flat | Conductor-built (deterministic) groups | C1 + C2 | 1–2 weeks |
| C3 | Attentive | The VISION.md sentence | Between-turn relevance model | C1 + C2 (C2.5 first, strongly) | 4–6 weeks |
| C4 | Archivist | Resolution decays with distance | Nested groups, era-level hierarchy | C2.5 (C3 helps) | ~6 weeks |
| C5 | Second Agent | Trustworthy and unattended | Headless runtime, journal, replay, benchmark | C3 (+C4) | 1 quarter+ |

C1 and C2 are independent of each other and can be built in either order or in
parallel. C2.5 is a thin policy milestone riding directly on both — the grouping
*machinery* already ships (ADR 0006); this adds only the decision of when to use it.
C3 needs C1 + C2 and gets a materially cheaper, sharper index if C2.5 lands first.
C4 builds upward from C2.5. C5 caps the stack.

---

# Milestone C1 — Cold-Score: the deterministic conductor

## Goal

Replace the budget clamp with a real policy: a continuous **cold-score** per block, a
**warmth memory** of what the agent has reached back for, and a **lexical relevance
pass** that pre-unfolds folded blocks the agent is about to need. No LLM, no cost, no
latency, every decision explainable in one line of arithmetic. After C1, the agent's
`unfold` tool is a backstop, not the only recall path.

## Design

**Scoring.** A new pure module `app/src/lib/engine/score.ts` exports
`coldScore(block, ctx): number` where `ctx` carries the current turn, budget pressure,
and the warmth map. Inputs, roughly in weight order:

- *Kind prior* — generalizes today's `FOLD_RANK`: `tool_result` decays fastest, then
  `thinking`, then `text`. (`user` and `tool_call` are never candidates — unchanged.)
- *Recency decay* — exponential in turns-since, not raw order, so a burst of tool
  spam ages faster than ten slow conversational turns.
- *Pair warmth* — a `tool_result` whose `callId` partner sits near the protected tail
  stays warm; the call/result pair ages together.
- *Recall warmth* — any block the agent has unfolded (provenance `"agent"` exists
  today) gets a warmth boost that decays over subsequent turns. Things the agent
  needed once, it tends to need again.
- *Size pressure* — at equal coldness, folding a 5k-token block buys more than a
  200-token one; only applies as a tiebreaker so small-but-dead blocks still fold.

**Lexical pre-unfold.** Each pass, tokenize the protected tail's text for *identifiers*:
file paths, `snake_case`/`camelCase` symbols, quoted strings, numbers with units. Any
**auto-folded** block whose full text matches an identifier (the engine has the full
text — folding is substitution, not removal) gets unfolded this pass with provenance
`"conductor"` and reason `matched "<identifier>"`. Manual (human) folds are respected
and never relevance-unfolded.

**Hysteresis.** Fold and unfold thresholds are separated, and a relevance-unfolded
block is immune to refolding for N turns (default ~5). Without this the view churns —
and on the live wire churn means the agent's context flickers between turns, which is
worse than a suboptimal but stable view.

**Where it runs.** Entirely inside `refold()`'s existing call sites — the engine stays
the single brain, `computeFoldOps` keeps mirroring it to the wire unchanged. Unfolding
on the live path is free: the plan is recomputed every sync, so an unfold is simply a
fold op that stops being emitted.

## Work plan

1. Extract today's candidate selection from `refold()` into `score.ts`; reproduce
   current behavior exactly behind the new interface (golden tests on the sample
   session: same folds in, same folds out).
2. Add the warmth map to `AccordionStore` (id → last-recall-turn), fed by the existing
   agent-unfold path and by manual unfolds.
3. Implement the scoring inputs; tune weights against the sample session and recorded
   real sessions (see *Data*).
4. Implement the identifier extractor (pure function, heavily unit-tested — this regex
   set will be wrong twice before it's right) and the relevance-unfold pass with
   hysteresis.
5. Add `"conductor"` to the provenance union (`Block.by`, activity log, Transcript
   role chips) — small but touches types everywhere; do it here so C2–C5 inherit it.
6. A churn metric in tests: per simulated turn, count fold-state flips; assert under
   threshold on the corpus.

## Tools & data needed

- **No new dependencies, no API keys, no protocol changes.** Vitest (already in place)
  carries the whole milestone.
- **A session corpus.** This is the real acquisition cost of C1 — and of C3's evals
  later, so start now: collect 10–20 real pi session JSONLs (`~/.pi/agent/sessions`)
  of varied shape (tool-heavy, conversation-heavy, long debugging), *including
  sessions where the agent used `unfold`*. Check them for secrets before committing
  (the repo is public — the sample-session key incident already proved why), or keep
  the corpus local with a small fetch script.
- **A replay driver for tests**: a utility that feeds a JSONL through the store
  turn-by-turn (advancing the protected tail) so scoring/churn can be asserted over a
  whole session, not just end-state. ~100 lines, reused by every later milestone.

## Exit criteria

- Golden tests prove no regression vs. the old clamp; scoring and hysteresis unit
  tests pass; `svelte-check` stays at 0/0.
- On the corpus replay: budget always respected; fold-state churn under threshold;
  at least one recorded agent-unfold in the corpus is *pre-empted* by the lexical pass
  (the block was already unfolded when the agent would have asked).
- Live demo: mention a filename from twenty turns ago in a live session and watch the
  conductor unfold the matching block, attributed and logged, before the agent reaches.

## Risks & candor

Heuristics cannot know that "the config decision" matters — only that `config.ts` was
mentioned. Expect the lexical pass to have good precision and mediocre recall. That is
fine: C1's job is the skeleton (scoring, warmth, hysteresis, provenance, corpus,
replay driver) that C3 swaps its brain into. Don't gold-plate the regexes.

---

# Milestone C2 — Summarizer: folds that carry meaning

## Goal

Replace skeletal digests with **LLM-generated summaries, computed once and cached
forever**. This is the highest-leverage upgrade per unit of effort on the whole
ladder, and it raises the ceiling of every conductor after it: when a 5k-token tool
result folds to 60 tokens that genuinely carry its content, folding stops being
information loss in practice, so the conductor can fold far more aggressively — and
the agent's self-unfolds get accurate, because each `{#code FOLDED}` tag now sits next
to text that says what's behind it.

## Design

**Pipeline.** A `summaryQueue` in the app (GUI drives — the architecture holds).
Candidates: blocks older than the protected tail, of foldable kind, larger than a
floor (~300 tokens; below that the deterministic digest is already a fine summary),
not yet cached. Summarize ahead of need whenever the session passes ~50% of budget, so
folds never wait on a network call — **the digest remains the instant fallback while a
summary is pending**, and the swap from digest to summary is just the next plan.

**Cache.** Content-addressed and immutable: key = `hash(blockText + kind + promptVersion
+ model)`. Blocks never change, so a summary is computed once *ever* — across sessions,
re-opens, and re-folds. Storage at `~/.accordion/summaries/` (JSONL shards to start;
SQLite only if scale demands). The registry dir already exists; same best-effort I/O
rules apply (never on the `context` hook path).

**Model access.** Three options, one recommendation:

1. **Rust-side HTTP via the Tauri layer** (recommended) — a `summarize` command in
   `lib.rs` using a Rust HTTP client; the key never enters the webview; works under the
   app's existing security posture. Mirrors how `~/.claude` reads already went to Rust.
2. Direct `fetch` from the webview with Anthropic's CORS opt-in header — fastest to
   build, but puts the key in webview-land; acceptable for a dev flag, not the default.
3. A Node sidecar — overkill until C5 forces the runtime question anyway.

Model: the cheapest current Haiku-class model. Per-kind prompt templates with a
`promptVersion` constant baked into the cache key: `tool_result` → "what was asked,
what came back, key values/paths/errors verbatim"; `thinking` → "decisions reached and
why"; `text` → "claims, commitments, answers given". Summary length capped relative to
source (e.g. `min(120 tokens, 10%)`) so token accounting stays meaningful.

**Engine integration.** `digestOf()` consults the cache first and falls back to
`digest()`. The `{#code FOLDED}` prefix is preserved verbatim — ADR 0005's single
source of truth survives untouched, and `effTokens` automatically accounts the real
summary length. `groupSummary()` upgrades the same way: a group's recap becomes a
summary-of-member-summaries (one cheap call over text that's already small).

## Work plan

1. ADR 0007: summary pipeline, cache key scheme, model access decision.
2. Rust `summarize` command + key handling (env var `ANTHROPIC_API_KEY` first;
   OS keychain via a Tauri plugin as a fast follow) + a settings row in the GUI.
3. Cache module (Node-safe, shared-style like `protocol.ts` — C5 will want to read it
   from outside the GUI).
4. Queue + scheduling in the app; wire `digestOf`/`groupSummary` to prefer cache.
5. Prompt templates per kind; cap + verbatim-identifier instructions (summaries must
   keep exact paths/symbols — that's what C1's lexical pass and the agent grep for).
6. Cost guardrails: per-session token budget for summarization, rate limit, and a
   visible running cost counter in the header (trust is the product).
7. Quality eval harness: sample ~100 blocks from the corpus, generate summaries,
   LLM-as-judge scoring "could a reader answer X from this summary?" with a small
   hand-graded calibration set.

## Tools & data needed

- **An Anthropic API key** (user-supplied) and a settings/storage story for it —
  the first time the app itself calls a model. Env var first, keychain follow-up.
- **A Rust HTTP client** (e.g. `reqwest`) added to `src-tauri`, or the Tauri HTTP
  plugin — the only new dependency of consequence.
- **The C1 corpus** for the eval set; ~1–2 hours of human grading to calibrate the
  judge.
- **Cost model:** a 130k-token session like the bundled sample has ~982 blocks but
  only a few hundred above the size floor; at Haiku-class pricing a full session
  summarization is cents, not dollars. Verify with the counter, publish the number in
  the README — it's a selling point.

## Exit criteria

- Folds on a live session carry informative summaries; re-folding anything is a cache
  hit; the fallback digest appears only for never-yet-summarized blocks.
- Judge-scored summary quality above an agreed bar on the eval set; verbatim
  identifiers preserved in ≥95% of summaries that contain them.
- Cost per full session summarization measured and documented; no `context`-hook-path
  I/O introduced (the invariant holds).
- A scripted retrieval test: agent asked about folded content answers correctly from
  the summary, or unfolds the right code on the first try, measurably more often
  than with digests.

## Risks & candor

A summary can be subtly wrong, and a wrong summary is worse than a skeletal digest
because the agent *trusts* it. Mitigations: verbatim-identifier instructions, the
judge eval, the size floor (small blocks keep deterministic digests), and the
architecture itself — nothing is lost, the full text is always one unfold away, and
the `{#code FOLDED}` tag keeps signaling "this is a residue, not the thing." Accept
the residual risk; measure it; don't pretend it's zero.

---

# Milestone C2.5 — Auto-Coalesce: fold the folds, flat

## Goal

The conductor starts building **flat groups on its own**: runs of adjacent, long-cold,
auto-folded blocks coalesce into one group with one summary line and one fold code.
No nesting, no LLM in the *decision* (only in the recap, via C2's cache). This is the
second compression stage, and it's nearly free: a deeply folded session carries one
`{#code FOLDED}` stub per block — hundreds of stubs, easily 1–2k tokens of pure
residue plus message-count clutter. Coalescing collapses fifty stubs into one
readable episode line, shrinks the Map's tile count, and — most importantly — gives
C3 a shorter, sharper summary index, since ancient history becomes a handful of
episode entries instead of hundreds of block entries.

## Design

**Why now and not in C1:** pre-summaries, a group recap is a concatenation of
deterministic digests — grouping would erase even the per-block granularity that the
lexical pass and the agent's own reading depend on, saving stub overhead while making
old context *more* opaque. With C2's cache, the recap is a summary-of-summaries
(`groupSummary`, already in C2's plan) and grouping becomes a genuine win. Hence:
immediately after C2, before C3.

**The coalescing rule — deterministic, no model call:** a run of ≥N (default ~8)
contiguous auto-folded, durable blocks, all older than K turns, bounded by
user-message seams (user blocks never fold, so runs between them are the natural
unit), never containing a pin or a manual fold, never reaching the protected tail
(`pruneProtectedGroups` already enforces this), and capped in size — both member
count and total full-text tokens — because of the blast radius below.

**Blast radius is the design problem.** Until C4's level-by-level unfold exists, a
group is all-or-nothing: if the lexical pass (or the agent) hits one identifier
inside a 50-block group, the whole range comes back at full text — a sudden
multi-k-token spike. Mitigations baked in from day one:

- *Size caps* — keep groups small enough that a full restore is survivable (default
  cap ~10–15 members / ~15k full-text tokens, tuned on the corpus).
- *Age floor* — only genuinely ancient runs coalesce; warm-ish blocks stay
  individually folded where the lexical pass can restore them one at a time.
- *Re-coalesce with hysteresis* — on a partial-relevance restore, the group unfolds,
  the matched blocks stay live, and the cold remainder re-groups after a cooldown
  (several turns), so the view never oscillates.
- *Stronger churn protection than blocks* — groups are the only op that changes
  message count; a forming/dissolving group flickers the agent's context. Group
  decisions get their own, longer hysteresis window.

## Work plan

1. ADR 0008: the coalescing rule, caps, restore/re-coalesce semantics.
2. The policy pass in the engine, running after C1's scoring (it only ever considers
   blocks the clamp already folded); provenance `"conductor"`, reasons logged.
3. Partial-restore + re-coalesce flow through the existing `resolveUnfold` and
   lexical-unfold paths; group-level hysteresis.
4. Corpus replay: measure net savings (stub tokens reclaimed minus restore spikes)
   and group churn; tune N, K, and the caps.
5. Map/Transcript already render manual groups — verify conductor-built ones need no
   UI work beyond attribution.

## Tools & data needed

Nothing new. The wire (`GroupOp`), safety re-derivation (`applyPlan`), group fold
codes, and agent group-unfold all ship today; C2 provides recaps; C1 provides the
corpus, replay driver, and hysteresis machinery. This milestone is pure policy plus
tests — which is exactly why it's worth pulling forward.

## Exit criteria

- On corpus replay: positive net token savings after restore spikes; group churn
  (form/dissolve cycles per session) under an agreed threshold; no provider 400s.
- A live session shows ancient history as a few episode lines, each unfoldable by
  the agent with one code, re-coalescing cleanly after.
- C3's summary index size measurably reduced on long sessions (record the number —
  it feeds C3's cost story).

## Risks & candor

The risk is churn, not safety — the provider-safety net is already double-enforced.
If tuning can't get the restore-spike cost below the stub savings on real sessions,
the caps are too generous or the age floor too low; in the worst case, ship it
default-off and let C4's level-by-level unfold fix the blast radius properly. Also
honest scope-keeping: this milestone makes "the Conductor builds groups" true in the
flat sense; VISION.md's *tree* is still C4's job.

---

# Milestone C3 — The Attentive Conductor

## Goal

The VISION.md sentence, delivered literally: between turns, the conductor **reads what
the agent is doing** and emits a plan — fold what went cold, unfold what's becoming
relevant — before the agent has to ask. The demo moment: the agent says *"wait, how
did we configure the WebSocket?"* and the section is already open, tagged
**conductor**, in the activity log. After C3, the feature called "the Conductor" in
VISION.md exists. This is the recommended final-form finish line.

## Design

**Prerequisite: close the view-sync gap.** Today the extension syncs only on the
`context` hook, so a plain assistant reply isn't seen until the next user turn — the
conductor would reason about a stale tail. Add a post-turn sync to the extension
(pi's turn-end event), as a `sync` that expects no plan (additive protocol field, or a
plan the extension ignores when no model call is pending). This is the already-planned
follow-up from the live-link work; C3 makes it mandatory.

**The tick.** On each sync settling, schedule a debounced `conductorTick` (one
in-flight at a time; a newer tick supersedes a pending one). Input — deliberately
small and cheap:

- The protected tail's text, truncated to a fixed window (~8k tokens).
- The **summary index**: for every block older than the tail — id, kind, turn, token
  count, folded?, pinned?, and its cached summary (or digest) — with C2.5's groups
  appearing as single episode entries, which is what keeps the index small on long
  sessions. This is why C2 is a hard prerequisite: relevance ranking needs an index
  that *means* something.
- Budget state: live tokens, budget, headroom.

Output — strict JSON: `{ fold: [{id, reason}], unfold: [{id, reason}] }`. Reasons are
short strings; they go straight into the activity log. The model is the cheapest
Haiku-class; the prompt frames it as a librarian, not an author — it never generates
content, only selects ids from the index it was shown.

**Applying the plan.** Conductor decisions write through the same engine actions with
provenance `"conductor"` (built in C1). Then the deterministic layer runs **last**, as
always: C1's scoring clamps the budget if the conductor under-folded, and hysteresis
suppresses churn if it flip-flops. The LLM proposes; the engine disposes. Hard rules
enforced *outside* the model: never touch pins, the protected tail, agent-sticky
unfolds (for a configurable cooldown), or non-durable ids.

**The miss metric.** Every agent `unfoldRequest` is a conductor miss — the agent had
to reach because the conductor failed to predict. Log every one:
`{turn, code, blockId, wasInIndex, conductorHadUnfolded}` to
`~/.accordion/metrics.jsonl`. Surface hit/miss counts in the header. This single
number is how C3 gets tuned, and later how C5 proves itself.

**One turn behind, by design.** The tick runs async after a sync; its output applies
to the *next* plan. Folding late by one turn costs a little headroom; unfolding late
by one turn is usually still ahead of the agent's need (the lexical pass from C1
catches same-turn mentions). Document it; don't fight the invariant.

## Work plan

1. ADR 0009: the tick, its inputs/outputs, the miss metric, the layering with C1.
2. Post-turn sync in `extension/accordion.ts` + protocol additive change + smoke test
   coverage (`extension/smoke.mjs`).
3. **Offline replay eval first, before any live tokens burn:** extend C1's replay
   driver to run the conductor turn-by-turn over the recorded corpus, scoring
   would-have-been misses against the sessions' real agent-unfold events. Iterate the
   prompt here — it's 100× cheaper than live testing and reproducible.
4. The tick itself: `app/src/lib/live/conductor.ts` (pure planning) + scheduling in
   `liveClient.svelte.ts`; reuse C2's model-access path.
5. Guardrails + layering: conductor ops feed the engine, C1 clamp runs last, churn
   hysteresis applies to conductor ops too.
6. Metrics logging + header surface; a session-end "conductor report" (hits, misses,
   tokens spent, cost) in the activity log.
7. Config surface: the `folding.enabled` arm toggle grows into a small conductor
   panel — off / deterministic-only (C1) / attentive (C3), plus per-turn cost cap.

## Tools & data needed

- **Model access from C2** (same path, same key) plus a per-turn cost cap; expected
  steady-state cost is one small Haiku call per turn (the index is summaries, not full
  text — a few k tokens in, a few hundred out).
- **The corpus with agent-unfold events** collected since C1 — this is the eval set,
  and its quality decides how well C3 can be tuned. If the corpus is thin on unfold
  events, run a few deliberate long sessions to generate them before starting step 3.
- **No embeddings initially.** Anthropic has no embeddings API; a Voyage-style
  embedding index or local BM25 is a cost optimization to consider only if the
  LLM-rank tick proves too expensive. Start simple; the index is small.
- pi's turn-end hook (verify the exact event the extension can subscribe to; if pi
  lacks one, the fallback is syncing on the message-complete event already used for
  ghost streaming).

## Exit criteria

- On the replay corpus: the conductor pre-unfolds ≥50% of what the agent historically
  asked for (miss rate halved vs. C1's lexical pass alone), with churn under the C1
  threshold and per-turn cost under the cap.
- Live: the demo moment is reproducible on demand; every conductor move shows in the
  activity log with its reason; pins and the tail are provably untouchable (tests).
- The view-sync gap is closed (assistant replies appear without waiting for the next
  user turn) — verified in the smoke test.
- A week of dogfooding on real work sessions without a provider 400, a budget
  overflow, or a "why did it fold that" moment that the log couldn't answer.

## Risks & candor

The failure mode isn't catastrophe — the deterministic layer guarantees the budget and
the wire guards guarantee provider safety. The failure mode is *mediocrity*: a
conductor that unfolds the wrong things, wastes its cost, and gets turned off. That's
why the replay eval comes before the live loop, and why the miss metric is
non-negotiable. If after honest tuning the attentive tick can't beat C1's lexical
pass by a clear margin, ship C1+C2 as the conductor and say so publicly — that result
would itself be worth writing up.

---

# Milestone C4 — The Archivist: hierarchical folding

## Goal

VISION.md's "folding the folds": resolution that decays with distance. Without it, a
multi-day session becomes a wall of summaries — a smaller wall. With it, the conductor
maintains a living tree: turns fold into episodes (*"built the parser," "chased the
race condition"*), episodes into eras, and any level opens back down to full detail.
This is what makes "thousands of turns, small enough to fit, complete enough to
recover" a true sentence, and it is the genuinely novel artifact — a navigable,
reversible, hierarchical context tree on a live agent.

## Design

**The wire stays flat — that's the key simplification.** ADR 0006 already collapses a
contiguous range of whole messages into one synthetic summary message (`GroupOp` with
leaf `memberIds`). A *nested* group's wire form is just a `GroupOp` whose `memberIds`
are the union of its descendants' leaf block ids. Nesting is a GUI/engine concept;
the extension and protocol need little or nothing new. This containment of risk —
plus C2.5 having already shipped and battle-tested the flat coalescing policy — is
why C4 is ~six weeks and not four months.

**Engine: groups become a tree.** `Group.memberIds` may include group ids (or a
parallel `children` field — decide in the ADR). Token accounting generalizes: a folded
group contributes its summary's tokens; an unfolded group contributes its children's
effective tokens, recursively. `pruneProtectedGroups` generalizes to "no group may
reach into the tail at any depth." Unfolding is **level-by-level** (VISION.md): one
unfold reveals member summaries, not full text.

**Summaries-of-summaries.** A group's recap is one cheap call over its members'
already-cached summaries (C2's cache makes this near-free); cached under the same
content-addressed scheme (key = hash of child summary hashes), so reorganizing the
tree never recomputes leaves.

**The coalescing policy extends upward.** C2.5 already builds episodes; C4 adds the
next rungs of the same deterministic schedule: ≥4 adjacent folded episodes older than
~300 turns → an era, and so on. The size caps that bounded C2.5's blast radius can
relax here, because level-by-level unfold means restoring an era reveals member
*summaries*, not full text — the spike problem this milestone properly fixes. C3's
tick optionally gains "group/ungroup" outputs; without it, the schedule alone works.

**UI.** Map view: the older box renders the tree's *current cut* — an episode is one
tile (visually distinct, e.g. a stacked/bordered square), opening on click into its
members. Transcript view: disclosure rows. The 982-tile performance rules apply
double at 10k+ blocks; hierarchy actually *helps* here (the collapsed cut keeps tile
count low), but the fully-opened case needs virtualization or a depth cap.

## Work plan

1. ADR 0010: tree model, accounting, level-by-level semantics, the upward coalescing
   schedule, wire flattening.
2. Engine tree refactor + exhaustive accounting tests (this is the riskiest token
   math in the codebase — golden tests against hand-computed totals).
3. Wire flattening in `computeGroupOps` (descend to leaf ids) + `applyPlan`
   re-verification; smoke test with nested collapse.
4. Recursive `groupSummary` over the C2 cache.
5. Upward coalescing schedule (episodes → eras), relaxing C2.5's caps behind
   level-by-level unfold.
6. Map + Transcript tree UI, then performance pass at 10k+ blocks.
7. Mega-session test data (see below) and an end-to-end recovery test: fold a
   million-token session to a handful of era summaries, then drill back to one
   specific tool result and verify byte-identical full text.

## Tools & data needed

- **Mega-session data.** Real multi-day sessions are scarce; build a generator that
  concatenates corpus sessions (fixing turn numbers) into synthetic 500k–1M-token
  JSONLs, plus keep one *real* long session as ground truth.
- **C2's summary cache and model access** (group recaps); no new external services.
- **Profiling tools already in use** (the scroll-perf playbook in CLAUDE.md) for the
  10k-tile pass.
- Possibly a virtualized-list approach for the fully-expanded transcript at extreme
  sizes — evaluate before adding any dependency.

## Exit criteria

- The 1M-token synthetic session holds under a 150k budget as a 3-level tree, stays
  interactive (scroll/hover within the existing perf bar), and any leaf is recoverable
  byte-identical through level-by-level unfolds.
- Accounting invariants proven by tests at every depth; `svelte-check` 0/0; smoke
  test covers nested wire collapse; no provider 400s across the corpus replay.
- The README comparison-table claims become demonstrably true in a recorded demo.

## Risks & candor

The danger is the engine refactor quietly breaking flat-group behavior that already
ships — hence golden tests before the refactor, not after. The UI can also balloon:
resist building a full tree explorer; the Map's "current cut + click to descend" is
enough for final form. And note the dependency honestly: VISION.md lists hierarchy as
part of the finished product, but the README roadmap lists it as its own line item
*after* the Conductor — C4 can ship after the "conductor done" announcement without
moving the goalposts, as long as that's said out loud.

---

# Milestone C5 — The Second Agent

## Goal

The conductor becomes a peer with standing, not a policy: it runs **headless**
(surviving the window closing), keeps a **decision journal** (every fold/unfold with
its reason, replayable), **measures itself** (miss rate, headroom, summary fidelity),
and is **benchmarked publicly** — "long-horizon tasks with the Accordion conductor
vs. `/compact`, n=50." This is the version that makes the project legible to the
outside world, and it fixes the architectural truth the earlier milestones paper
over: today, nothing conducts unless the GUI is open.

## Design

**Where the conductor lives — the ADR-worthy reversal.** "GUI drives, extension is
thin" becomes "**conductor drives, GUI watches**." Two candidate homes:

1. **A standalone daemon (`accordiond`)** — recommended. A small Node process that
   discovers sessions through the same `~/.accordion/` registry, connects as a WS
   client exactly like the GUI does, runs the same engine + C3 tick (the engine is
   already plain TS; the runes-free parts extract cleanly), and writes the journal.
   The GUI becomes a pure viewer that reads the journal and can override (pins,
   manual folds) through the same wire.
2. In-extension — fewer moving parts, but it makes the extension thick, couples the
   conductor's lifecycle to pi's, and puts LLM calls inside the process hosting the
   model loop. Rejected unless the daemon proves too heavy.

This requires the extension to accept **multiple concurrent clients** (daemon + GUI)
with a defined precedence: exactly one *driver* (the daemon when present, else the
GUI), any number of viewers. Protocol bump; the registry entry advertises which
driver is attached.

**Decision journal.** Append-only JSONL per session at
`~/.accordion/journal/<sessionId>.jsonl`: every sync digest, every op with provenance
and reason, every agent unfold, every human override, with turn and timestamp. The
activity feed becomes a *view of the journal* — and so does **replay**: the roadmap's
"scrub how the context evolved" feature is event-sourced reconstruction from journal
+ synced blocks, no extra recording machinery.

**Self-evaluation.** Rolling miss rate (C3's metric), budget headroom over time,
summary-fidelity spot checks (sample a folded block, judge its summary — C2's judge,
run sparsely). Shown in a small conductor scorecard; used to gate any auto-tuning.
Tune knobs manually first; an auto-tuner is a follow-up, not a prerequisite.

**The benchmark.** A harness of scripted long-horizon tasks (multi-hour repo work:
implement-then-extend-then-debug chains, each later step depending on details from
earlier steps). Arms: Accordion conductor / `/compact` / sliding window. Metrics:
task success, recall probes ("what did we decide in step 3 and why"), total tokens,
wall-clock, interventions. n large enough to mean something (≥30 runs/arm).

## Work plan

1. ADR 0011 (conductor runtime + multi-client protocol) and ADR 0012 (journal format
   + replay).
2. Extract the engine's runes-free core so daemon and GUI share it (the store's
   reactive shell stays in the app; scoring, mapping, planning, cache are already
   Node-safe or close).
3. Multi-client support + driver precedence in `extension/accordion.ts`; protocol
   bump; smoke tests for GUI+daemon attached simultaneously.
4. `accordiond`: discovery, attach, tick loop, journal writing; packaging (a `npx`
   script first, OS service later if ever).
5. Journal + activity-feed-as-view + replay scrubber UI (timeline slider over
   event-sourced state — the store can already be rebuilt from blocks + ops).
6. Scorecard + spot-check sampling.
7. Benchmark harness, task suite (~10 tasks), baseline runs, write-up.

## Tools & data needed

- **A Node runtime decision** for the daemon (plain Node + the existing TS toolchain;
  jiti already drives the extension's smoke test the same way).
- **Multi-client WS** work in the extension — the one piece of today's code whose
  single-client assumption must be verified and likely rebuilt.
- **Benchmark compute**: this is the expensive line item — ≥90 long-horizon agent
  runs across arms, at real model prices. Budget it explicitly (likely hundreds of
  dollars of API spend) and design tasks to be as short as validity allows.
- **A task suite** — the hardest *data* artifact on the whole ladder. Look at
  long-horizon agent benchmarks for inspiration, but the tasks must specifically
  stress *recall of distant context*, which most public benchmarks don't isolate.
- Storage: journals are append-only JSONL — no database, in keeping with the "no
  extra infra" pitch.

## Exit criteria

- A session conducted end-to-end with the GUI closed; opening the window mid-session
  shows the full attributed history from the journal; replay scrubs the whole session.
- Driver precedence proven: daemon + GUI attached, exactly one driver, human
  overrides always win and are journaled.
- The benchmark table exists with honest error bars, whatever it shows — a null
  result is publishable for this project; a fabricated-feeling one is fatal to it.

## Risks & candor

This milestone renegotiates the project's central architectural slogan, and it's the
first one whose scope can genuinely run away. The journal and headless runtime are
well-bounded; the benchmark is not — task design will eat as much time as it is
given. Timebox it. Also accept now: if C3's miss rate plateaus mediocre, C5's
benchmark may show the conductor matters less than the architecture (visibility +
reversibility) does. That is still a strong result for Accordion; let the data say
what it says.

---

# Cross-cutting concerns

**Provenance and trust.** From C1 on, every actor is one of `user | agent | auto |
conductor`, every action carries a reason, and the activity log (later the journal)
is the single account of record. The product's thesis is that visibility makes
automation safe — the conductor must be the best-behaved citizen of that regime, not
an exception to it.

**Configuration surface.** One conductor panel, growing by milestone: arm/disarm
(exists) → deterministic/attentive mode + cost cap (C3) → coalescing schedule (C4) →
daemon attach + scorecard (C5). Defaults stay conservative: off by default on live
sessions, exactly as `folding.enabled` is today.

**Cost story.** C2 is cents per session, once ever per block. C3 adds one small call
per turn. C4 adds near-free recap calls. Publish real numbers in the README as each
ships; cheapness is a feature and silence about cost reads as having something to
hide.

**Sequencing.** The recommended order is C1 → C2 → C2.5 → C3 (final form, announce
the Conductor) → C4 → C5. C2 can start in parallel with C1 — they share no files;
C2.5 is the thin policy layer that joins them. The corpus collection starts on day
one of C1 because C3's eval quality depends on its accumulation time.

**ML posture.** No training anywhere in the C-ladder: heuristics plus prompted
inference, tuned by humans against replay. The one learned-model direction worth
pursuing is distillation — run C3's tick with a frontier model as a slow teacher,
log every decision as training data, and train a small local ranker to mimic it —
planned separately in [conductor-distillation.md](conductor-distillation.md) (the
D-track). It requires C3 and changes nothing about this ladder's sequencing, but its
instrumentation phase (D0) should land inside C3 so dogfooding data is captured from
day one. RL is explicitly off the table: episode cost, credit assignment across
hundreds of turns, and an unexplainable policy all cut against the product's thesis.

**What each milestone needs, in one table.**

| | New dependencies | External services | Data artifacts | Codebase surface |
|---|---|---|---|---|
| C1 | none | none | session corpus + replay driver | `engine/score.ts` (new), `store.svelte.ts`, types/provenance |
| C2 | Rust HTTP client (reqwest / tauri-http) | Anthropic API (Haiku) + key storage | summary cache `~/.accordion/summaries/`, eval set + judge | `lib.rs`, `digest.ts`, new cache + queue modules, settings UI |
| C2.5 | none | same API (group recaps via C2) | corpus replay: savings vs. restore-spike + churn numbers | engine coalescing pass, group hysteresis, `resolveUnfold` re-coalesce flow |
| C3 | none beyond C2 | same API, per-turn | miss-metric log, corpus replay eval | `extension/accordion.ts` (post-turn sync), `protocol.ts` (additive), `live/conductor.ts` (new), `liveClient.svelte.ts` |
| C4 | possibly list virtualization | same API (recaps) | mega-session generator + 1M-token fixtures | engine group model, `computeGroupOps`, `applyPlan` re-verify, Map/Transcript UI |
| C5 | Node daemon packaging | same API; benchmark compute budget | journal format, task suite, baseline runs | extension multi-client + protocol bump, engine core extraction, `accordiond` (new), replay UI |

**The finish line, restated.** "The Conductor" as VISION.md defines it is done at the
end of C3. C4 and C5 are real and on the roadmap as their own line items — building
them under the conductor's name would quietly move the goalposts. Ship C3, update the
roadmap checkboxes, and let C4/C5 be the next chapters rather than scope creep on
this one.

