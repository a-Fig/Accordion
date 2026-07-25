# triptych — pressure-gated thirds

An out-of-process conductor that divides the context into three bands and treats
each differently:

| band | region | treatment |
|---|---|---|
| **bottom** | the most recent ~⅓ of the cap (raw tokens from the tip; never smaller than the protected tail) | untouched |
| **middle** | older than the bottom band, not yet summarized | code-file `tool_result` reads → **tree-sitter L2 skeleton** (signatures kept, bodies elided) as a labeled, recoverable `replace` fold — `{#code FOLDED}`-tagged, so `recall` still reaches the full source. Everything else untouched (code-only v1) |
| **top** | older than ~⅔ of the cap | swept into ONE lossy summary group using compaction-naive's `COMPACTION_SYSTEM` prompt **verbatim** — untagged, agent-unrecoverable, recursive |

**Pressure-gated:** inert until the visible window first crosses the shared 90%
high-water mark (`TRIGGER`). The first crossing arranges the context into thirds;
activation is then sticky — skeletons keep applying as blocks age past the bottom
boundary, summaries re-run at each subsequent 90% crossing.

**Fully exclusive** (ADR 0011): locks `human-steering` + `agent-unfold`. `recall`
is never lockable, so skeletons stay readable in full; the summary group is the
one one-way door (only a human detach — the freeze kill switch — recovers it).

## Layout

| file | what |
|---|---|
| `triptych.ts` | the conductor — `AgedSummaryConductor` subclass: band geometry, sticky activation, skeleton `replace` folds with a decline-to-fold shrink gate, triptych-branded statuses. Engine-agnostic: the skeletonizer is injected (`Skeletonizer` interface) |
| `skeleton.mjs` | the tree-sitter L2 engine, ported from the skeleton-lab research (branch `claude/code-skeleton-extraction-rv0ovo`, `research/skeleton-lab/`): web-tree-sitter + tree-sitter-wasms (ts/tsx/js/py), byte-range splice, ASCII parse-valid elision markers with line counts, error-tolerant. ~80–90% removal on typical files at full signature recall |
| `runner.mjs` | the spawn entry point — imports the committed `triptych-sdk.mjs`, injects `./skeleton.mjs`, dials back as `?role=conductor&token=…` |
| `triptych-sdk.mjs` | **committed generated artifact** (do not edit): the conductor + its `core/` graph, bundled by `extension/build-remote-sdk.mjs`. Regenerate after touching `triptych.ts`, its `conductors/in-process` imports, or `core/conductor/remote.ts` |
| `skeleton.test.ts` / `triptych.test.ts` | engine regression suite (skips cleanly without node_modules) / conductor golden tests (fake engine, no deps) |
| `testdata/` | fixture corpus ported from the research lab (provenance in its README) |

## One-time setup (repo checkouts)

```bash
cd conductors/ws/triptych && npm install   # web-tree-sitter + tree-sitter-wasms (wasm grammars)
```

Without it the spawn fails loudly (clear stderr via `conductorStatus`) and the
conductor degrades to nothing — the extension itself is unaffected. Triptych is
**repo-only** (like thermocline): not part of the npm tarball, catalog-gated on
its runner resolving on disk.

## Design lineage

The engine and its parameters come from the skeleton-lab research
(`research/skeleton-lab/RESULTS.md` on the research branch): tree-sitter L2 was
the Pareto knee — ~80% token removal at signature recall 1.00, 100%
lenient-parse validity, ~7ms/file, zero hallucinations in blind comprehension
probes (losses surface as honest abstention, which is what makes skeleton +
`recall` safe). The decline-to-fold gate exists because all-contract files
(interfaces/types, no bodies) barely shrink — forcing ratio there would destroy
exactly what the skeleton preserves. Summary behavior is deliberately
compaction-naive's, byte-for-byte prompt-wise (owner decision: the top band is a
faithful lossy compaction, not a new strategy).
