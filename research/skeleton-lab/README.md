# skeleton-lab

Research harness for **deterministic code-skeleton extraction**: turning a source file
into a drastically smaller stand-in that keeps the load-bearing structure (imports,
exports, types, signatures, docstrings) and elides implementation bodies. Target
consumer: a future Accordion conductor that folds stale code reads in a long-running
agent's context down to a navigable interface view.

This is a **greenfield research project** — it deliberately does not reuse the shipped
doorman skeletonizer (ADR 0016); that design is one point in the space, this lab maps
the space.

## Layout

```
src/contract.mjs        the candidate interface + level definitions (read this first)
src/candidates/         one module per competing approach
src/harness/            corpus ground truth, metrics, matrix runner, gallery generator
corpus/                 real + adversarial source files, manifest, parser ground truth
results/                results.json + smell-check galleries (galleries gitignored)
RESULTS.md              the research report — findings, curves, recommendation
```

## Candidates

| id | approach | deps |
|---|---|---|
| `ast-exact` | TypeScript compiler API for ts/tsx/js; CPython `ast` (subprocess) for py. Full-fidelity parse, emit from AST source slices. The precision ceiling. | `typescript`, system `python3` |
| `tree-sitter` | One uniform keep/elide tree walk over wasm grammars (what repomix/aider-class tools use). Error-tolerant by construction. | `web-tree-sitter`, `tree-sitter-wasms` |
| `topline` | Dependency-free line *ranking*: structural-signal score per line, threshold per level, plus a smooth `skeletonizeToBudget` dial no threshold scheme has. | none |

All candidates implement three aggressiveness levels — L1 interface view (sigs +
docstrings + types), L2 signatures only, L3 compact public "API card" — so the output
of the lab is a fidelity-vs-compression curve per candidate, not a single number.

## Running

```bash
npm install
node src/harness/groundtruth.mjs   # regenerate corpus/groundtruth.json
npm run bench                      # full matrix → results/results.json + stdout tables
npm run gallery                    # side-by-side smell-check files → results/gallery/
```

## Scoring

- **removedPct** — token reduction (chars/4 estimate)
- **signature recall** — fraction of parser-ground-truth symbols still present (all / exported-only)
- **validity** — does the skeleton still parse in its own language (strict + lenient after stripping elision markers)
- **determinism** — byte-identical on rerun (hard requirement)
- **speed / totality** — ms per file; throwing on any input is a hard failure
- plus human smell-checks of the galleries and skeleton-only LLM comprehension probes

See `RESULTS.md` for findings.
