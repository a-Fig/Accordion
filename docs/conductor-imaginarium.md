# The Conductor Imaginarium — architectures off the beaten path

> Companion to [conductor-plan.md](conductor-plan.md) (the build plan) and
> [conductor-distillation.md](conductor-distillation.md) (the D-track). This document
> is different: it's the answer to *"if the budget were unlimited, what would we
> build?"* — a catalog of genuinely different architectures for the Conductor, from
> things we could start tomorrow to things that need a model provider as a partner.
> Researched June 2026; citations are real papers, not vibes.

## How to read this

Every conductor architecture is an answer to one question: **how do you know which
context the agent will need next?** There are only three honest answers, and they
sort everything below:

1. **Guess it** — from structure: recency, kind, what's mentioned, what's linked.
   (The C-ladder lives here.)
2. **Measure it** — from the model itself: where it actually looks, what actually
   changes its behavior. (Needs access nobody's API gives you today — or a clever
   stand-in.)
3. **Train for it** — make the model and the conductor grow up together, so folding
   isn't a prosthetic but an organ. (Needs a provider, a fleet, and patience.)

The architectures get more powerful and less buildable in roughly that order. The
last section says which pieces feed back into the C-ladder cheaply.

## The toolbox, in plain words

Quick translations for the technologies in play, one breath each:

- **Language model (LM/LLM):** a next-word predictor so large that predicting well
  requires understanding. Everything below either prompts one, trains one, or peeks
  inside one.
- **Embeddings / vectors:** a way to turn a piece of text into a list of numbers
  (a *vector*) such that similar meanings land near each other. "Where did we
  configure the socket?" and "WebSocket setup in main.rs" end up close, even though
  they share almost no words.
- **Vector search:** finding the stored vectors nearest to a query vector — i.e.,
  "fetch me the chunks that *mean* something like this." Fast, cheap, fuzzy.
- **RAG (retrieval-augmented generation):** the standard pattern built on vector
  search — store chunks outside the context, retrieve a few relevant ones, paste
  them in. Accordion is deliberately *not* RAG (nothing leaves the context; folding
  is substitution) — but RAG's retrieval machinery can serve as a conductor's
  relevance signal.
- **grep / keyword:** exact text matching. Dumb, instant, and unreasonably
  effective when the query is a file path or a function name — which, in coding
  agents, it usually is. C1's lexical pass is this.
- **ML (machine learning):** fitting a function to examples instead of writing it
  by hand. The D-track's student is ML: examples in, scoring function out.
- **RL (reinforcement learning):** learning by trial and reward rather than from
  labeled examples. Powerful, expensive, hard to aim. Appears exactly once below,
  in the unlimited-budget section, on purpose.
- **Attention:** inside a transformer, every generated token "looks back" at prior
  tokens with measurable weights. Attention is the model's eye movements — and the
  single most interesting thing nobody's API will show you.
- **KV cache:** the model's internal scratch representation of everything in
  context. Folding *that* instead of text is the deep end of this document.

---

# Part I — Buildable now, no one's permission needed

## 1. The Activation Engine — a conductor with 30 years of receipts

**The idea.** Stop inventing a cold-score; adopt the one cognitive science already
validated. ACT-R — the standard computational model of human memory — scores every
memory chunk as `A = B + S`: **base-level activation** `B = ln(Σ t_j^-d)` (every
past *use* of the chunk contributes, decaying as a power law of time since) plus
**spreading activation** `S` (relevance pumped in from what's currently in working
memory). Retrieval below threshold fails — that's forgetting.

The kicker is *why* this equation is right. Anderson & Schooler (1991) analyzed
real-world demand statistics — newspaper headlines, speech, email — and found the
probability an item is needed again follows exactly this power law. Human forgetting
isn't a flaw; it's an **optimal Bayesian policy tuned to the statistics of what the
environment actually asks for again**. That result is the Conductor's theoretical
license: folding isn't destroying context, it's betting correctly against the odds
of need — and unlike the brain, we keep a perfect undo.

**What it looks like in Accordion.** C1's cold-score, upgraded from heuristic to
theory: every reference to a block (agent unfold, lexical hit, tail proximity at
model-call time) is a "retrieval" appended to its history; `B` falls out of the
equation; per-kind decay exponents `d` are *fit from our own corpus* (Anderson &
Schooler found different domains genuinely have different decay rates — tool results
vs. decisions should differ, and now there's a principled way to measure by how
much). The fold threshold becomes a likelihood cutoff on P(need), tied directly to
budget pressure.

**Needs:** nothing. It's arithmetic plus the corpus we're already collecting. This
is less a moonshot than C1's final form — and the strongest single idea in this
document per unit of effort.

## 2. The Spreading-Activation Graph — relevance without asking a model

**The idea.** The `S` term above, taken seriously. Conversations aren't linear —
they're a graph wearing a linear costume. Every block mentions *entities*: files,
functions, decisions, error strings, names. Blocks sharing entities are linked.
Pump activation from the protected tail into the graph; let it spread, decaying per
hop; accumulate where paths converge. A block three hops from everything current
goes cold *by graph distance*. A block that suddenly shares two entities with the
tail lights up — **before any LLM is consulted**.

This is how ACT-R models association, and 2024–25 knowledge-graph-RAG work found the
same trick beats flat vector similarity for retrieval precision. It also gives the
Map view something new to show: the *shape* of the session — which old episode is
still wired into the present work, which is an island.

**What it looks like in Accordion.** An entity extractor at parse time (regex-grade
for code sessions: paths, symbols, quoted strings; an LLM pass only for fuzzy
concepts), an adjacency index in the engine, and an activation pass per tick — pure
computation, milliseconds, fully explainable ("lit up via `parse.ts` →
`linearize()`"). C3's tick then consumes graph activation as a feature instead of
re-deriving relevance from scratch, making the LLM call shorter or unnecessary on
easy turns.

**Needs:** nothing external. The risk is entity extraction quality on non-code
sessions; start code-first where grep-grade extraction is strong.

## 3. The Garbage Collector — context as a managed heap

**The idea.** Steal the most battle-tested resource-reclamation theory in computer
science. In a garbage-collected runtime, you never delete what's *reachable*: start
from **roots**, walk references, reclaim the rest. Map it: roots = the protected
tail + pins + the original task statement; references = entity links (architecture
#2) and causal links (this code block was written *from* that tool result; the
tool_call/tool_result `callId` pair is already such an edge). Mark-and-sweep, every
tick: unreachable blocks fold. And the **generational hypothesis** — most objects
die young, survivors live long — maps perfectly: a *nursery* (the tail), an *old
generation* (folded summaries), a *tenured* store (C4's episodes/eras). Most tool
results die in the nursery; what survives three collections probably matters
forever.

What GC contributes that scoring doesn't: **semantics instead of thresholds**.
"Folded because unreachable from anything live" is a *guarantee-shaped* statement —
auditable, provable, testable — where "folded because score 0.23 < 0.30" is a
shrug. The two compose: reachability decides *eligible*, activation decides *order*.

**What it looks like in Accordion.** A reference-edge model in the engine (entity
edges + causal edges), a mark phase from roots each tick, and fold candidates
restricted to the unmarked set. Plus the best debugging UI in the product's future:
*why is this block still live?* → show the reference chain from the roots, like a
heap profiler's retention path.

**Needs:** nothing external. Pairs with #2 (same edges, two algorithms).

## 4. The Proxy-Eye — reading attention without permission

**The idea.** The thing everyone wants is to watch where the frontier model's
attention actually goes (see Part II) — but no API exposes it. The Sentinel result
(2025) shows the workaround: run a **tiny open-weights model** (0.5B is enough)
over the same context and *read its attention instead*. Small models turn out to
agree with big ones about *where to look* far more than about *what to say* —
"which blocks does the answer draw on" is a much easier question than "what is the
answer." Sentinel got 5× context compression at QA parity using a 0.5B probe to
decide relevance for a 7B answerer.

**What it looks like in Accordion.** A local probe model (runs on CPU/consumer GPU,
ONNX or llama.cpp) that, each tick, ingests the tail plus candidate summaries and
emits per-block attention mass — a *measured* relevance signal at zero marginal
cost, no API key, fully private. It slots into the same scoring interface as
everything else, and it's a natural D-track student alternative: instead of training
a ranker from teacher labels, read a free pretrained model's eyes.

One honest caveat from the literature: raw attention lies a little. Attention
*sinks* (tokens that soak up attention for structural reasons, VATP 2024) mean
"most-attended" ≠ "most-important" — the probe needs the standard corrections
(value-weighting, sink exclusion). Known problem, known fixes.

**Needs:** a local inference dependency and model file (~1GB). No provider, no key.

## 5. The Sleep Pass — consolidation, not just compression

**The idea.** Biology doesn't summarize memories once and forever; it **replays and
rewrites them offline**. During sleep, the hippocampus replays the day's episodes
into the cortex: verbatim detail decays, semantic extracts strengthen, the oft-used
gets reinforced, the never-used gets pruned. The conductor gains a second mode —
not the fast between-turns reflex, but a slow offline pass between sessions:

- **Hindsight rewriting:** a summary written mid-session didn't know how the story
  ended. The sleep pass rewrites old summaries *knowing what mattered* — "this
  config experiment looked incidental; it caused the bug fixed at turn 412."
- **Episodic → semantic:** extract durable facts and decisions into a compact
  semantic store the *next* session loads as a preamble — the session's wisdom
  without its transcript.
- **The testing-effect twist** (this one's counterintuitive and supported): blocks
  the agent has successfully recalled *can take coarser summaries* — it's proven a
  cue suffices — while never-recalled blocks keep verbose ones. Fidelity follows
  demonstrated retrievability, not importance guesses.

**What it looks like in Accordion.** A batch job over the journal + summary cache
(cheap, off-peak, batch-priced), versioned summaries (`promptVersion` discipline
already exists), and a `facts.jsonl` per project that live sessions can opt into.
This is also where C4's era summaries get *good* instead of merely cheap.

**Needs:** only the C2 pipeline plus scheduling. The deep cut — cross-session
memory — is a product-scope decision (Accordion becomes memory *between* agents'
sessions, not just within one), which is exactly why it belongs in this document.

## 6. The Context Market — let the blocks bid

**The idea.** The budget is scarce; scarcity is what markets are for. Give every
block a tiny advocate that bids for its tokens each tick: bids funded by evidence
of usefulness (activation, graph centrality, recent recalls), costs proportional to
size. The conductor stops being a judge and becomes an **auctioneer** running a
knapsack auction under the budget. Pins are sovereign land (not for sale); the tail
is outside the economy entirely.

Why bother with the metaphor? Three real properties fall out: **budget satisfaction
is structural** (an auction cannot oversell the hall — no clamp needed as a
separate pass); **prices are legible** ("folded: bid 0.4, market clearing price
0.7" is a new kind of explanation, and the *price history* of a block is a
relevance chart over time); and **plurality is native** — different bidders (an
activation bidder, a graph bidder, a proxy-eye bidder) compete in one mechanism
instead of being blended into one opaque score. Mechanism design has theory for
making such combinations incentive-coherent.

**What it looks like in Accordion.** Honestly: a refactor of the scoring layer into
bids + a clearing pass, plus delightful UI (the composition strip as a ticker;
block price sparklines in the Inspector). It's the same math wearing better
clothes — and the clothes matter for a product whose thesis is legibility.

**Needs:** nothing external. Ship it as the *presentation* of whichever scoring
stack wins.

## 7. The Parliament — disagreement as a signal

**The idea.** Run several cheap conductors with different philosophies — recency
hawk, graph spreader, proxy-eye, lexical literalist — and let them vote. Where
they agree, act free. Where they *disagree*, that's measured uncertainty: route
exactly those blocks to the expensive teacher (C3's frontier tick), and log the
resolution as D-track training data. Ensembles are the oldest trick in ML for a
reason; the novelty here is using disagreement as the *router* that decides when
intelligence is worth paying for.

**Needs:** two or more of architectures 1–4 existing first. This is the glue, not
the engine — but it's probably how the finished conductor actually runs.

---

# Part II — Needs measurement access (or a provider who picks up the phone)

## 8. The Eye-Tracking Conductor — attention telemetry as an API

**The idea.** The KV-cache eviction literature (H2O, SnapKV, Scissorhands,
PyramidKV, 2023–26) established something remarkable: models concentrate attention
on a small, *stable* set of "heavy hitter" tokens — 5–20% of context carries nearly
all the weight, and importance *persists* across steps. Serving stacks already
exploit this internally to evict 80–95% of the cache with negligible loss. The
model is, in effect, already running a conductor inside the datacenter. **Nobody
will show it to you.** No API — Anthropic, OpenAI, Google, or open-source serving —
exposes per-token or per-block attention today.

The ask, made precise: one number per content block per response — *aggregate
value-weighted attention received during generation*. Value-weighted matters
(VATP, 2024: sink tokens soak attention while contributing nothing; raw attention
lies). With that single field in the API response, the conductor stops guessing
relevance and starts *reading* it: blocks the model genuinely consulted stay warm
by observation; blocks it never looked at across N turns fold with evidence. The
GUI's heat overlay becomes real heat.

One caution from the literature: attention received is *retrospective* — it can't
score what a future turn will need ("Expected Attention," 2025, calls this
future-query blindness). So telemetry replaces the *cold* half of the conductor's
job; the *warming* half (prefetch) still needs prediction. Hybrid, not panacea.

**Needs:** a provider partnership (the unlimited-budget version: Anthropic builds
the field; FlashAttention doesn't materialize the matrix, so it's real kernel work,
not a config flag) — or self-hosted open weights, where this is buildable today and
would make a killer research demo: *Accordion showing a live agent's true attention
over its own foldable context.*

## 9. The Counterfactual Oracle — measure causality, not correlation

**The idea.** Every architecture above estimates relevance by *correlation*. There
is a direct measurement: **remove the block and see what changes.** Run the same
turn with and without a candidate fold; compare output distributions (logprob
delta, or judged divergence). If behavior is identical, the fold was *causally
free*. This is ablation — interpretability's sharpest tool — pointed at context.

Per-turn it's prohibitive (two model calls per candidate). The unlimited-budget
move is to make it the **labeling factory**: offline, over the replay corpus,
ablate thousands of (turn, block) pairs and record true causal impact. That dataset
is strictly better ground truth than the D-track teacher's *opinions* — you'd be
distilling **measured causal relevance** into the student, not a bigger model's
guesses. It's also the audit tool of last resort: "the conductor claims this fold
was safe — prove it" becomes an experiment, not an argument.

**Needs:** API spend (thousands of calls per corpus pass — real money, batch-priced;
trivial under the premise of this document) and careful experimental design
(position effects, sampling noise). No provider cooperation required. Of every idea
in Part II, this one is buildable *soonest* and quietly upgrades the entire D-track.

## 10. Latent Folding — fold to vectors, not sentences

**The idea.** A text summary is a 10–20× compression that costs fidelity. The
compression literature says context can fold *much* further if the residue doesn't
have to be human-readable text: ICAE (2024) compresses 4–16× into "memory slots" a
frozen LLM can read; 500xCompressor (ACL 2025) reaches **480×** while retaining
70–84% QA accuracy; KV-Distill (2025) hits ~100× near-losslessly; and Cartridges
(Stanford, June 2025) trains small standalone KV caches offline that match full
in-context performance at **38.6× less memory** — and they *compose*: independently
trained Cartridges can be stacked at inference. A fold stops being a sentence and
becomes a dense artifact the model reads natively — and Accordion's whole vocabulary
survives intact: fold = compress to latent, unfold = restore text, peek unchanged
(the human still reads the cached *text*; only the agent reads vectors).

**The honest wall:** every one of these needs the model to *accept* non-text input —
embedding injection or KV-cache loading — and **no commercial API does** (the agents
confirmed this across Anthropic/OpenAI/Google: prompt caching is the only KV
primitive exposed, and it's opaque, provider-written, read-only). All published
results run on self-hosted open weights.

**Two real paths:**

1. **Self-hosted lane, today:** run the agent on an open model (pi can), bolt an
   ICAE-style encoder beside it, and Accordion becomes the first *visible* latent
   folder — the Map showing which squares are text and which are dense latent at
   30× the density. Research-grade, publishable, persuasive.
2. **The partnership lane:** the tractable provider ask is not embedding injection
   (deep co-training entanglement) but **client-loadable KV blobs** — Cartridges as
   a service. Prompt caching already stores server-side KV; the extension is
   *client-authored* blobs, version-pinned per checkpoint. The fold/unfold
   vocabulary maps onto it one-to-one. If Anthropic ever ships that primitive,
   Accordion is, that day, the natural front-end for it.

**Needs:** lane 1 — GPU + open weights + adapter training (D-track skills, bigger
model). Lane 2 — Anthropic.

---

# Part III — The unlimited-budget program

If Anthropic — or someone with a national lab's wallet — adopted the thesis, the
program is four tiers. Each tier is independently valuable; together they're an
answer to "what should agent memory *be*?"

**Tier 1 — Instrument (months).** Ship value-weighted per-block attention telemetry
(#8) in the API. Run the counterfactual labeling factory (#9) at scale across
thousands of sessions; publish the corpus. Side effect: the world's first public
dataset of *measured* context relevance in real agentic work — the field is
currently tuning eviction methods on needle-in-a-haystack toys.

**Tier 2 — Compress (quarters).** Productize client-loadable KV folds (#10, lane
2). Train the compression adapters against frontier checkpoints; solve blob
versioning. Accordion's text summaries become the *fallback* tier; dense folds the
default; effective context multiplies ~30–100× with the same window.

**Tier 3 — Co-train (a year).** The native accordion model. Today's models are
trained on contexts that never fold; folding is out-of-distribution. So put it
*in* distribution: train with fold tokens, folded-and-restored histories, and
`{#code FOLDED}` digests in the pretraining mix, so the model has *priors* about
folded content — when to trust a residue, when to reach for the code. Then the
curriculum flip: train the *agent* to thrive with a conductor (RL where the
environment includes foldable memory, reward = task success at minimal live
context). This is the one place RL earns its seat: fleet-scale, simulated
long-horizon tasks, reward signals measured in task outcomes — the thing no
individual can afford and a frontier lab does routinely. The conductor and the
agent stop being tool and user; they're co-evolved.

**Tier 4 — Institutionalize (ongoing).** A public benchmark for *recall under
budget* — long-horizon tasks whose later steps depend on early details, scored on
success × token cost — because the field's memory benchmarks today don't isolate
what conductors do. Whoever defines the benchmark defines the race. It should be
the team whose product's whole premise is that memory must be visible and steerable.

---

# What flows back into the real plan tomorrow

Stripped of the budget fantasy, four pieces are cheap enough to influence the
C-ladder now:

1. **The ACT-R activation equation (#1)** is C1's scoring function. Use the real
   math; fit decay per kind from the corpus. Effort: days, not weeks.
2. **Entity edges (#2/#3)** are an upgrade to C1's lexical pass and the natural
   index structure for C3's tick. Reachability-as-safety (#3) is worth an ADR even
   if it ships later.
3. **The testing-effect fidelity schedule (#5)** is a one-paragraph addition to
   C2: summary length keyed to recall history. Cheap, principled, slightly
   counterintuitive — good product.
4. **Counterfactual labeling (#9)** belongs in the D-track as D0.5: a small ablation
   study (hundreds of pairs, not thousands) to *calibrate the teacher* before
   distilling it. If teacher opinions diverge from measured causal impact, better
   to learn it for $50 than after training.

The proxy-eye (#4) and self-hosted latent folding (#10 lane 1) are the two
"skunkworks" projects — weekends of work away from a demo nobody else has, either
of which would make a strong research write-up for a public repo whose pitch
deserves an audience.

---

**The closing thought.** Every architecture in this document is a different answer
to *where does relevance come from* — statistics (#1), structure (#2, #3), borrowed
eyes (#4), biology (#5), economics (#6), democracy (#7), measurement (#8, #9),
density (#10), or co-evolution (Tier 3). Accordion's bet — visible, reversible,
attributable — is compatible with *all* of them, because it never bet on a
relevance mechanism; it bet on an interface to whatever mechanism wins. That's the
deepest reason to believe the product: conductors will come and go. The accordion
is the keyboard they all play.

🪗
