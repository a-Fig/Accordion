# skeleton-lab — findings

Research question: **what is the best deterministic way to turn a code file into a
skeleton** — ~90% of content removed, load-bearing structure kept — for a future
Accordion conductor that folds stale code reads in a long-running agent's context?

Setup: 3 candidates × 21 real/adversarial ts/tsx/js/py files × 3 aggressiveness
levels, scored on token reduction, signature recall vs parser ground truth, parse
validity, byte-determinism, speed, and a blind LLM comprehension probe. Method
details in [README.md](README.md); raw numbers in `results/results.json`
(regenerate with `npm run bench`).

## Headline results (typical files, mean)

| candidate | level | removed % | recall (all) | recall (exported) | parse-valid | valid-lenient | ms |
|---|---|---|---|---|---|---|---|
| ast-exact | L1 | 45.5 | 0.99 | 1.00 | 100% | 100% | 21 |
| ast-exact | **L2** | **78.0** | **0.99** | **1.00** | **100%** | 100% | 18 |
| ast-exact | L3 | 94.9 | 0.45¹ | 0.92 | 63% | 63% | 18 |
| topline | L1 | 75.6 | 0.88 | 0.93 | 0% | 0% | 1.6 |
| topline | L2 | 87.9 | 0.89 | 0.97 | 0% | 0% | 1.2 |
| topline | L3 | 92.8 | 0.55¹ | 0.89 | 13% | 13% | 0.9 |
| tree-sitter | L1 | 62.0 | 1.00 | 1.00 | 31% | 94% | 9 |
| tree-sitter | L2 | 79.8 | 1.00 | 1.00 | 31% | 100% | 7 |
| tree-sitter | L3 | 85.5 | 0.69¹ | 0.98 | 19% | 44% | 8 |

¹ L3 drops private/non-exported symbols **by design** — recall-all is expected to
crater; recall-exported is the honest L3 metric.

Every candidate: **0 failures and 100% byte-determinism** across the whole corpus,
including all five adversarial files (truncated mid-expression TS, 10.6KB
single-line minified JS, brace/template string bombs, decorator/nested-class maze
with fake `def`s inside docstrings, mixed CRLF+tabs).

## Comprehension probe (the metric that actually matters downstream)

24 questions over 3 files — 15 answerable from a good interface view
("structural"), 9 answerable only from elided bodies ("body-only") — answered by
blind subagents shown ONLY the L1 skeleton (`probes/`):

| candidate | structural correct | body-only honest abstention | hallucinations |
|---|---|---|---|
| ast-exact | **15/15** | 9/9 | **0** |
| tree-sitter | **15/15** | 9/9 | **0** |
| topline | 10/15² | 9/9 | **0** |

² The 5 misses were abstentions, not wrong answers: topline's budget had dropped
interface fields, two top-level consts, and a `__all__` line.

**Zero hallucinations in 72 answers.** A body-elided skeleton degrades into honest
"can't tell from this view", not fabrication. This is the strongest argument that
skeleton-folding is safe for agent context: the failure mode of a *good* skeleton
is a re-read, not a wrong belief. (Caveat: answerers were explicitly instructed to
abstain rather than guess — this measures a well-prompted reader, and the
instruction is cheap to replicate in a conductor's digest preamble.)

## The five findings that should shape the conductor

1. **Comment policy, not body elision, decides the compression ratio on real TS.**
   Per-language split: ast-exact L1 removes only **33%** on this repo's ts/js
   (doc-comment-dense — `truth.ts` is ~38% comments by chars) vs 67% on Python;
   switching to L2 (drop comments) jumps ts/js to 72% at identical recall. Body
   elision is table stakes; the real dial is how many doc comments you keep. A
   production skeletonizer should treat docstrings/JSDoc as a *separately budgeted
   tier* (keep first line, elide the rest) rather than the all-or-nothing L1/L2
   split tested here.

2. **~90% removal with full API fidelity is not achievable on typical files; ~80%
   is.** The Pareto knee is L2: 72-88% removal at recall ≈ 1.0. Pushing past 90%
   (L3) always sacrifices non-exported symbols (recall-all 0.4-0.7) — acceptable
   for a "what does this module offer" card, wrong for "navigate my own codebase"
   (an agent's own private helpers are exactly what it forgets it wrote — the F3/F4
   failure modes in the Keel plan). The 90% number should be treated as the target
   for *prose-heavy* files and ~80% as the honest ceiling for code with recall 1.0.

3. **Parsers win, and the uniform-grammar tradeoff is real but small.** Both
   AST-grade candidates beat line scoring on everything except speed. Between them:
   ast-exact produces the most legible, 100%-parse-valid skeletons and the best
   Python stubs (`.pyi`-style), at the cost of per-language code and a ~38ms
   Python subprocess; tree-sitter gets one uniform walk for all four grammars,
   scored identical comprehension, is error-tolerant by construction, and its main
   losses are cosmetic (bare `…` markers → strict-invalid but 94-100%
   lenient-valid). For a conductor, **tree-sitter is the right engine** (uniform,
   in-process, error-tolerant, wasm grammars already vendored by every serious peer
   tool); ast-exact's output style — parse-valid stubs, `{ /* … N lines */ }`
   markers with line counts — is the right *output spec* to port onto it.

4. **Line scoring is a decoy for quality but the right idea for a budget dial.**
   topline is 5-10× faster and its `skeletonizeToBudget` hits a requested token
   budget within ±0.3pp — a capability neither AST candidate has (their levels are
   coarse steps). But it loses interface fields and top-level consts (the exact
   facts probes showed matter), is never parse-valid, and on minified input
   degrades to an empty marker. Verdict: don't ship line scoring as the
   skeletonizer; **steal the budget mechanism** — rank AST-kept *units* (not raw
   lines) by the same signal bands and drop lowest-value units until the budget
   fits. That combination (AST units + greedy budget fill) is the natural v2 and
   directly serves a conductor's "shallowest level that meets the epoch target"
   routing.

5. **All-contract files don't compress — the conductor must be allowed to decline.**
   On a truncated all-types file (`ops_truncated.ts`, nearly all type decls +
   comments) ast-exact honestly removes only 6.9% at L1: everything is contract,
   nothing is body. Forcing ratio there would destroy exactly what the skeleton
   exists to preserve. The conductor-side classifier needs a "skeleton didn't
   shrink → fall back to plain digest or leave alone" gate (same conclusion
   ADR 0016 reached, independently reproduced from greenfield).

## Adversarial behavior (all candidates, all levels: 0 crashes, 100% deterministic)

- **Truncated TS** (cut mid-expression): TS compiler and tree-sitter both recover
  every declaration before the cut; tree-sitter needed its ERROR-node recursion fix
  (an ERROR root with named children is walked normally, not head/tail-chopped).
- **Minified 10.6KB single line**: tree-sitter parses it fine (50-70ms worst case);
  ast-exact handles it; topline collapses it to a single elision marker — safe but
  content-free.
- **String bombs / fake defs in docstrings / mixed EOL+tabs**: no candidate was
  fooled into keeping or matching fake structure (parser-based candidates are
  immune by construction; the ground-truth extractor confirmed no spurious symbols).

## Recommendation for the future conductor

1. **Engine: tree-sitter (wasm)** — uniform across languages, in-process,
   error-tolerant, ~7-10ms/file. Accept the dependency (~1-2MB wasm per grammar,
   one async init); the dependency-free constraint was explicitly dropped for this
   research.
2. **Output spec: ast-exact's** — parse-valid stubs (`{ /* … N lines */ }`,
   `...  # … N lines`), kept decorators, `.pyi`-style Python, line counts in every
   elision marker (they doubled as useful "how much am I missing" signals in the
   probes).
3. **Levels: replace L1/L2/L3 with a docstring tier + a token budget.** Default =
   L2 + first-docstring-line (≈ the Pareto knee, ~80% removal, recall 1.0);
   under pressure, greedy-drop AST units by topline's signal ranking until the
   epoch budget fits; L3 "API card" only as the last rung before a plain digest.
4. **Always pair with reversibility** (the `{#code FOLDED}` tag / `recoverable`
   flag from ADR 0016) — the probe's honest-abstention result assumes the agent can
   re-read; skeleton + unfold is the combination that makes 0-hallucination hold in
   practice.

## What was NOT tested (honest scope)

- Only chars/4 token estimation (no real tokenizer); ratios are approximate.
- No Svelte/Rust/Go/Java/C — TS/JS + Python per scope decision.
- Comprehension probes used one reader model, one level (L1), 3 files, n=1 per
  cell — directional, not statistical.
- No cache-warmth measurement (byte-determinism is verified, which is the
  prerequisite; actual KV-cache economics not measured here).
- No head-to-head against the shipped doorman skeletonizer (greenfield per scope
  decision).
