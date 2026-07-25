# Plan: a skeleton conductor built on tree-sitter L2

**Decision (owner, 2026-07-25):** build a conductor around the skeleton-lab
**tree-sitter candidate at L2** (signatures only, comments/docstrings dropped —
~80% token removal at recall 1.00, 100% lenient-parse-valid, ~7ms/file,
0 failures on the adversarial corpus). See RESULTS.md for the evidence.

## What to build

A conductor (contract v2, `core/conductor/contract.ts`) that replaces large,
stale code-file `tool_result` reads with tree-sitter L2 skeletons, reversibly.

## Fixed points (from the research + repo invariants)

1. **Engine:** `web-tree-sitter` + `tree-sitter-wasms` grammars (ts/tsx/js/py to
   start). The owner explicitly waived the dependency-free-conductor rule.
   Port the candidate from `research/skeleton-lab/src/candidates/tree-sitter.mjs`.
2. **Output spec upgrades to port from ast-exact** (RESULTS.md recommendation §2):
   parse-valid elision stubs (`{ /* … N lines */ }`, `...  # … N lines` — ASCII
   `...`, not bare U+2026, which is what costs tree-sitter strict validity today),
   line counts in every marker.
3. **Async init constraint:** `Parser.init()` + `Language.load()` are async and
   read wasm from disk. This MUST happen at `attach()` (conductor lifecycle),
   never on the `context` hook (repo invariant: no disk I/O, no async on the
   hook). Until init resolves the conductor simply proposes nothing.
4. **Reversibility:** every skeleton substitution ships as a `replace`-style fold
   op through `host.propose` so it carries the `{#code FOLDED}` tag and stays
   `unfold`/`recall`-able. Skeleton folding must never be one-way.
5. **Classification precision first:** reuse/port doorman's `classify.ts` gating
   (reject-biased: only single-file code reads; never grep dumps, JSON, listings).
   The lab corpus + adversarial files become regression fixtures.
6. **Decline-to-fold gate:** if the skeleton doesn't shrink the block by a real
   margin (all-contract files — see RESULTS.md finding 5), fall back to plain
   digest or leave alone. Never force ratio.
7. **Collaborative posture:** no involvement locks (like doorman). Human pins win;
   agent unfold stays free.

## Open questions to settle when work starts (ask or decide then)

- **Trigger shape:** pressure-driven only (fold when over budget, like the shipped
  convention) vs. also birth-fold giant fresh reads on `wire-departing` (doorman's
  slot)? Or replace/extend doorman itself rather than adding a fifth conductor?
- **Budget dial:** port topline's rank-units-under-budget mechanism now (RESULTS.md
  recommendation §3) or ship fixed-L2 first? Suggest fixed-L2 first, dial later.
- **npm packaging:** the extension bundles in-process conductors; wasm grammar
  files (~1-2MB each) need to ship in the tarball (`files` list) and be resolved
  at runtime — decide layout (`extension/dist/wasm/`?) and whether `pi install`
  size is acceptable. `build-extension.mjs` must externalize or copy them.
- **Where the skeletonizer lives:** `core/` is framework-free but this has a
  runtime dep; likely a new `conductors/in-process/<name>/` with its own vendored
  module, mirroring doorman's layout.
- **Svelte files:** out of scope for v1 (lab never tested them) — classify should
  reject `.svelte` for now.

## Success criteria

- Skeletons byte-deterministic; hook path untouched (init off-path); smoke +
  conductor e2e green; regression tests ported from the lab corpus including all
  five adversarial files; RESULTS.md numbers reproduced by the ported module
  (~80% removal, recall 1.00 on typical files).
