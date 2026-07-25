# Plan: `strata` — the thirds conductor (tree-sitter L2 middle band)

**Owner decisions (grilled + settled, 2026-07-25).** The conductor divides the
context into three bands and treats each differently:

| band | region | treatment |
|---|---|---|
| **bottom** | most recent ~⅓ of the cap (raw tokens from the tip; never smaller than the protected tail) | untouched |
| **middle** | older than bottom, not yet summarized | code-file `tool_result` reads → **tree-sitter L2 skeleton** as a labeled, recoverable `replace` fold (`{#code FOLDED}` tag); everything else untouched (code-only v1) |
| **top** | older than ~⅔ of the cap | swept into ONE lossy summary group using **compaction-naive's `COMPACTION_SYSTEM` prompt verbatim** — untagged, agent-unrecoverable, recursive, exactly like the foil |

Settled by the owner:

1. **Pressure-gated**: the conductor does nothing until the visible window
   crosses the 90% high-water mark (compaction-naive's `TRIGGER`). First
   crossing arranges the context into thirds; after that the bands stay
   maintained (skeletons continuously as blocks age past the bottom boundary;
   summaries re-run at each subsequent 90% crossing, recursively).
2. **Top third is lossy, faithful to compaction-naive**: untagged group digest,
   no agent unfold/recall path back; only human detach (freeze) recovers.
3. **Middle third is code-only v1**: only doorman-classified single-file code
   reads are skeletonized; thinking/text/user/non-code results ride untouched
   until they age into the top band.
4. **Fully exclusive**: locks `human-steering` + `agent-unfold` (compaction-naive
   posture). `recall` is never lockable, so tagged skeletons still give the
   agent read-access to elided bodies.
5. **Repo-only v1, thermocline-style**: lives in `conductors/ws/strata/`, spawned
   out of process, absent from the npm tarball. Its wasm deps (`web-tree-sitter`
   + `tree-sitter-wasms`) are ordinary node_modules of that directory
   (`npm install` once, documented) — no committed wasm blobs, no extension
   bundle impact, catalog-gated by the existing runner-resolver check.

Decided by the implementer (flagged to the owner):

- When skeletonized code ages into the summary, the summarizer is fed the
  **skeleton**, not the original — the conversation as the agent experienced it,
  and the owner chose lossy for that band anyway.
- The summary's visible-window trigger math credits skeleton savings (else the
  90% mark would re-fire while the real wire still has room).

## Architecture

- `conductors/ws/strata/skeleton.mjs` — the ported lab candidate
  (`research/skeleton-lab/src/candidates/tree-sitter.mjs` pinned at L2), elision
  markers upgraded to ast-exact's parse-valid ASCII spec
  (`{ /* ... N lines */ }`, `...  # ... N lines`). Async `init()` (wasm load —
  runner process only, never the extension), sync skeletonize after.
- `conductors/ws/strata/strata.ts` — `StrataConductor extends
  AgedSummaryConductor` (which gains three small protected hooks:
  `agedBoundaryIndex(view)`, `extraSavedTokens(view)`, `promptTextOf(b)`).
  Band math + sticky activation + skeleton `replace` commands (with a
  decline-to-fold gate: skeleton must actually shrink the block) live here;
  all summary machinery (trigger, attempt keys, sticky status, injection
  neutralizer, reservation math) is inherited.
- `conductors/ws/strata/runner.mjs` + committed `strata-sdk.mjs` bundle
  (emitted by `extension/build-remote-sdk.mjs`, same pattern as thermocline's
  `remote-sdk.mjs`). The runner injects the skeletonizer module into the
  conductor so the bundle itself stays dependency-free.
- Registry: `spawn` entry with hand-mirrored metadata (lockstep comment, like
  thermocline); `spawn.entryFile` generalized to a dir-relative path so
  `resolveRunnerPath` serves both spawn conductors.

## Success criteria

- Skeletons byte-deterministic; ~80% removal / recall 1.00 reproduced on the
  lab corpus via the ported module; adversarial corpus files never crash it.
- The `context` hook path untouched; all skeleton/summary work in the runner
  process or `host.complete`.
- compaction-naive + handoff behavior byte-identical after the base refactor
  (their tests stay green).
- Extension smoke + thermocline conductor e2e stay green; a manual strata spawn
  attaches, skeletonizes, and summarizes under pressure.

## Research evidence

See [RESULTS.md](RESULTS.md). Tree-sitter L2: ~80% token removal at signature
recall 1.00, 100% lenient parse validity, ~7ms/file, 0 failures and 100%
byte-determinism on the adversarial corpus, zero hallucinations in blind
comprehension probes.
