# testdata/

Fixtures used by `../skeleton.test.ts`. Ported from the skeleton-lab research corpus
(branch `claude/code-skeleton-extraction-rv0ovo`), which built and scored several
candidate skeletonization strategies before `skeleton.mjs` (the "tree-sitter" candidate,
pinned at its L2 level) was ported into this conductor.

Provenance:

- `reprlib.py`, `textwrap.py` — CPython 3.11 standard library (PSF License).
- `lib.es2015.collection.d.ts` — the `typescript` npm package (Apache-2.0).
- `agentView.ts`, `wire.ts` — copied from this repo's `core/` at the time the corpus was
  assembled (Accordion-derived; typical real-world TS fixtures).
- `decorator_maze.py`, `string-hell.ts`, `mixed-eol-indent.ts`, `ops_truncated.ts`,
  `mock-server.min.js` — synthesized adversarial fixtures (decorator stacks with
  docstring-embedded fake definitions, string/template literals shaped like code,
  mixed EOL/indentation, a truncated/malformed file, and a minified single-line file).
