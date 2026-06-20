# The Distilled Conductor — the D-track

> Companion to [conductor-plan.md](conductor-plan.md). The C-ladder ships the
> Conductor; this track makes it **fast, cheap, and eventually local** by using a
> large LLM as a slow, intelligent teacher, saving every decision as training data,
> and training a small student model to mimic it. Imitation learning, not RL — and
> mostly not even fine-tuning until the data says it's needed.

## The idea in one paragraph

C3's attentive tick is already a policy: *(tail, summary index, budget) → (fold set,
unfold set)*. Run that policy with a big model, generously — full summaries, a long
tail window, no cost pressure — and it becomes a **teacher** whose every decision is
a labeled example. The agent's own `unfold` calls grade the teacher for free (every
miss is a correction). Accumulate the examples, then train a **student** — not a
generative mimic but a small *relevance ranker* that scores each index entry against
the tail — and plug it into the slot the deterministic layer already exposes. The
student runs in milliseconds at zero marginal cost; the teacher remains on call for
the cases the student is unsure about, and every teacher consultation is new
training data. The conductor gets cheaper and faster forever while the safety story
doesn't change at all: learned components *propose scores*; the deterministic engine
— clamp, hysteresis, pins, tail, kind/durable-id guards — still *disposes*.

## Why this is the right shape (and what it is not)

**The student is a ranker, not a chat model.** Mimicking the teacher's full JSON
output with a small generative model is brittle and hard to evaluate. Scoring one
index entry at a time — "how relevant is this block/episode to what the agent is
doing right now?" — is a pointwise prediction problem: easy to train, easy to
measure, easy to bound. The fold/unfold *sets* are then derived deterministically
from scores + thresholds + budget, exactly how C1's cold-score already works. The
student literally replaces one term in `score.ts`.

**Distillation amplifies the teacher; it cannot exceed it** — except where the
miss-corrections (agent unfolds the teacher failed to predict) inject ground truth
the teacher never had. So the order of operations is fixed: make the teacher good
(C3), *then* distill. Distilling a mediocre teacher bakes in mediocrity.

**Not RL.** No reward propagation, no policy gradients, no rollouts. Episodes are
hours long, credit assignment across 300 turns is brutal, and a black-box policy
undercuts the product's thesis that every move is visible and explainable. Supervised
imitation on logged decisions keeps training offline, evaluation on replay, and
behavior auditable.

**The strategic payoff is bigger than cost savings.** A trained student small enough
to run locally means a conductor with **no API key, no per-turn cost, and no content
leaving the machine**. For a tool whose pitch is trust, "the automatic mode is fully
local" is a headline feature, not an optimization.

## Position in the roadmap

The D-track **requires C3** (the teacher is C3's tick) and the C1 corpus/replay/
metrics infrastructure. It runs *alongside* C4/C5, not instead of them — and it
feeds C5 directly: a near-free per-turn policy is what makes an always-on headless
daemon economically trivial. Nothing in the C-ladder waits for the D-track; the
Conductor announcement (end of C3) does not depend on it.

D0 (instrumentation) should land **inside C3**, because retrofitting logging after
months of dogfooding throws away exactly the data this track lives on.

---

# Phase D0 — Instrument the teacher, capture everything

## Goal

Make C3's tick produce training data as a side effect of normal operation, and build
the offline labeler that can generate teacher decisions in bulk without live
sessions. Data before models, always.

## Design

**Teacher mode.** The C3 tick gains a model knob: `haiku` (the cheap live default) or
`teacher` — a frontier-class model with a longer tail window, the full summary index,
and a prompt that also asks for calibrated per-entry relevance scores (0–1), not just
the fold/unfold sets. Teacher mode is for dogfooding sessions and offline labeling;
it is allowed to be slow because the conductor is structurally one turn behind
anyway, and allowed to be expensive because every call is an investment in data.

**The example schema.** One record per (tick × index entry), JSONL at
`~/.accordion/distill/<sessionId>.jsonl`:

- *Input features:* the tail text (truncated, hashed for dedup), the entry's summary
  text, kind, turn-distance from tail, token count, folded/pinned state, warmth.
- *Label:* the teacher's relevance score and its fold/unfold decision for that entry.
- *Correction channel:* when the agent later unfolds a block the teacher had left
  folded (a miss), the corresponding records are re-labeled relevant-at-that-tick —
  retroactively, by walking back from the unfold event. Agent behavior is the only
  ground truth in the system; it outranks the teacher.

**The offline labeler.** The replay driver (built in C1) runs teacher ticks over the
recorded corpus turn-by-turn in batch. This is the volume engine: a 300-turn session
with a 400-entry index yields ~120k pointwise examples per pass. Twenty corpus
sessions → millions of examples without a single live session. Batch API pricing
makes this cheap; run it overnight.

**Volume & dedup.** Adjacent ticks share most of their index; near-duplicate
(tail, entry) pairs are deduped by feature hash so the dataset measures decisions,
not turn count.

## Tools & data needed

- Frontier-model API access for teacher mode and the batch labeler (this phase's main
  cost — budget an explicit labeling allowance; batch-tier pricing applies).
- The C1 corpus, which becomes the seed dataset; keep collecting sessions throughout.
- A `distill/` directory in the repo for schemas and the labeler script (Node, reusing
  the replay driver) — no training stack yet.

## Exit criteria

- Teacher mode runs live and in batch; records validate against the schema; the
  miss-correction backfill works on real agent-unfold events.
- ≥1M deduped pointwise examples banked from the corpus, with a held-out session
  split (whole sessions, never random rows — rows within a session are correlated
  and random splits would leak).

---

# Phase D1 — The free baseline: embeddings, no training

## Goal

Establish the floor before training anything: an off-the-shelf embedding model
scoring entries by similarity to the tail. If this baseline gets close to the
teacher, the trained student only has to clear a low bar — and if it *beats* C1's
lexical pass decisively, it can ship as an interim improvement on its own.

## Design

Embed each entry's summary once (cache alongside C2's summary cache — same
content-addressed discipline); embed the tail once per tick; score = cosine
similarity blended with C1's deterministic terms (recency, kind, warmth). Evaluate on
the held-out split: agreement with teacher decisions (top-k overlap), and replayed
miss rate vs. both C1-lexical and the teacher. No training run, one new dependency
(a local embedding model — a small sentence-transformers-class model via ONNX, or an
embeddings API as a stopgap with the local path as the goal).

## Exit criteria

- A scored comparison table on held-out sessions: C1-lexical vs. embedding baseline
  vs. teacher, on miss rate, top-k agreement, and churn. This table is the decision
  gate for D2: it says how much headroom training can actually buy.

---

# Phase D2 — Train the student

## Goal

A small trained ranker that matches the teacher's decisions within a defined margin,
at <100 ms per tick on CPU, at zero marginal cost.

## Design

**Architecture ladder — climb only as far as the eval demands:**

1. **Bi-encoder** (recommended start): the D1 embedding model fine-tuned with a
   pairwise/contrastive objective on teacher labels — tail and entries embed
   independently, so per-tick cost is one tail embedding + cached entry dot-products.
   Fast, simple, probably sufficient.
2. **Cross-encoder reranker**: tail+entry scored jointly for the top-N ambiguous
   entries only, on top of the bi-encoder's cut. More accurate, costlier; add only
   if the bi-encoder plateaus below the gate.
3. **Small generative student** (a LoRA-tuned ~1–3B model emitting the structured
   decision): the escalation of last resort. Strictly harder to train, evaluate, and
   bound. The plan's bet is that this rung is never needed; revisit only with
   evidence.

**Training pipeline.** A separate `distill/train/` workspace — Python, PyTorch, a
single consumer GPU or rented hours; deliberately quarantined from the app's plain
JS/TS world. Models are versioned like prompts (`studentVersion` in every journal
entry and cache key). Class imbalance is real (most entries are irrelevant most of
the time): weight or subsample negatives; calibrate output scores (the deterministic
layer consumes thresholds, so calibration matters more than raw AUC).

**Evaluation = the same replay harness.** Held-out sessions, same three metrics
(miss rate, teacher agreement, churn) plus latency. The promotion gate is written
down before training starts: *student ships when its replayed miss rate is within an
agreed margin of the teacher's and beats the D1 baseline significantly, with churn
under the C1 threshold and tick latency <100 ms CPU.*

## Tools & data needed

- Python training stack (quarantined), one GPU's worth of compute (own or ~tens of
  dollars rented per run), experiment tracking can be a spreadsheet — resist MLOps.
- The D0 dataset with session-level splits; the D1 baseline as the control.
- ONNX export path verified *early* — a model that can't run in Node is a model
  that doesn't exist for this product.

## Exit criteria

- The promotion gate, met on held-out replay, documented with the comparison table.
- Exported ONNX artifact loading and scoring in Node at target latency.

---

# Phase D3 — Integration: the cascade

## Goal

Ship the student into the live conductor with the teacher as its supervisor — and
keep the trust story intact.

## Design

**The cascade.** Every tick, the student scores the index (free, instant). The
deterministic layer turns scores into ops as usual. The teacher is consulted only
when routed: student uncertainty (scores clustered near thresholds), periodic
spot-checks (every Nth tick), or high-stakes moments (budget pressure forcing large
folds). Teacher consultations are journaled *and logged as fresh D0 data* — the
flywheel: disagreements between student and teacher are exactly the examples the
next training run needs.

**Modes in the conductor panel:** `deterministic` (C1) / `attentive` (C3, LLM each
tick) / `distilled` (student + teacher cascade) / `local-only` (student alone, no API
key, fully local — the headline mode). Default stays conservative; `local-only` is
the long-term default candidate once the gate numbers justify it.

**Attribution honesty.** A teacher reason is a sentence; a student reason is a
score. The journal entry for a student decision carries the score, the nearest
matched summary snippet, and the `studentVersion` — auditable, if less narrative.
The activity log renders both without pretending one is the other.

**Runtime.** ONNX Runtime in Node — in `accordiond` (C5) or behind a Tauri command
pre-C5. Model file shipped beside the app (~tens of MB), hash-pinned.

## Exit criteria

- A week of dogfooding in `distilled` mode: miss rate within gate of `attentive`
  mode, per-session API cost down >90%, no invariant violations (pins/tail/kinds —
  same tests as C3).
- `local-only` mode demonstrably functional end-to-end with no key configured.

---

# Phase D4 — The flywheel, made routine

## Goal

Re-distillation as a habit, not a project: the corpus grows, the miss log and
cascade disagreements accumulate, retraining is a scripted run with a gate, and
model versions roll forward like prompt versions.

## Design

A retraining cadence (monthly, or triggered when accumulated corrections exceed a
threshold); the gate re-run on the *current* held-out set every time; rollback is
trivial because models are versioned artifacts and the deterministic layer never
changed. Periodically re-run the teacher over fresh corpus to keep labels tracking
the teacher's own improvements (better frontier models = better teachers = free
student upgrades at the next distillation).

**Distribution-shift candor:** the dataset is one person's sessions; the student
will fit Fig's work style. For a personal tool that is a feature. If Accordion grows
users, per-user fine-tuning from each user's own miss log is the natural extension —
the pipeline built here is exactly that pipeline.

## Exit criteria

- Two consecutive scheduled retrains executed end-to-end (data → train → gate →
  promote/rollback) without manual surgery.

---

# Risks, in order of likelihood

1. **The teacher isn't good enough to be worth copying.** If C3's miss rate
   plateaus mediocre even in teacher mode, distillation faithfully reproduces
   mediocrity at lower cost. Mitigation: the D1 gate table exposes this before any
   training spend; fix the teacher (prompt, index quality, tail window) first.
2. **The baseline is good enough.** If D1 embeddings land within a hair of the
   teacher, training buys little — ship the baseline, bank the win, stop. This is a
   success outcome; treat it as one.
3. **Calibration churn.** A student whose scores drift across versions makes the
   deterministic thresholds flap. Mitigation: calibration is a first-class gate
   metric; thresholds re-fit per `studentVersion` on held-out replay.
4. **Scope creep into MLOps.** One schema, one labeler, one training script, one
   gate. The moment this track needs a feature store, it has failed its design
   review.

# Cost sketch

D0 labeling: one overnight batch pass over a 20-session corpus at frontier batch
pricing — low tens of dollars, repeatable. D2 training: small-model fine-tuning,
tens of dollars of rented GPU per run. D3 onward: the point is that the marginal
cost goes to ~zero. The whole track costs less than one month of C3 running an
expensive model live — that comparison is the budget argument for doing it.

---

**The shape of the bet:** C3 proves the conductor's intelligence with rented brains;
the D-track makes that intelligence a local reflex. Slow expert → logged decisions →
fast apprentice → expert on call. If it works, Accordion's automatic mode becomes
free, instant, and private — and the journal proves it earned the trust at every
step.
