# ADR 0016 — Code-skeleton conductor: structural compression of code-file reads (reversible "interface view")

**Status:** accepted
**Date:** 2026-06-21
**Builds on:** [ADR 0005](0005-agent-unfold.md) (the `{#code FOLDED}` tag + agent `unfold`),
[ADR 0007](0007-conductor-protocol.md) (the conductor seam — `conduct → Command[]`, the
`replace` command), [ADR 0008](0008-conductor-first-party-one-view.md) (first-party
conductors, one public `ConductorView`), [ADR 0011](0011-conductor-involvement-locks.md)
(collaborative vs exclusive, the `recall` read), [ADR 0014](0014-naive-compaction-conductor.md)
(the lossy compaction foil this conductor is the reversible answer to).

## Context

A large code file an agent **read** is the single most compressible thing in its context,
and the worst thing to compress badly. The agent rarely needs every line of a 5,000-token
file it opened forty turns ago — it needs the file's *shape*: imports/exports, types, class
and function **signatures**, docstrings. But the file's API surface is exactly what it might
still need, so the two existing ways to shrink it are both unsatisfying:

- **A generic digest** (the built-in / cold-score / GC path) folds the read to a one-line
  recap — `Read → 412 lines, ~5000 tok · <first line>`. Cheap and reversible, but it throws
  away the entire interface: the agent can no longer see what functions the file defines.
- **An LLM summary** (naive compaction, ADR 0014) burns tokens, is non-deterministic (so the
  folded prefix changes between passes and breaks the inference cache), and — fatally — is
  **irreversible**: the original is discarded, so the agent can never get the real code back.

There is a third option that fits Accordion's founding rule ("folding is content substitution,
never removal — provider-safe and fully reversible"): replace the file body with a structural
**skeleton** — the file's interface, implementation bodies elided — and keep the original one
`unfold` away. The agent sees the full API surface at roughly a fifth of the tokens, can
reference and navigate it, and can pull any body back on demand. This is the **interface view**
of stale code: `*.ts → *.d.ts`, `*.py → signatures + docstrings`. It is a genuinely new digest
*modality* in the conductor zoo — not recency, not attention, not reachability, not LLM
compaction, but **structural compression that preserves the contract** — and it is the
reversible counterpart to ADR 0014's deliberately-lossy foil.

We grounded the design in real session data (`~/.claude/projects` + pi sessions + the bundled
`sample-session.jsonl`): large code-file reads are a real but *minority* slice of big blocks —
in Claude Code, ~16% of `Read` results and ~25% of `Write` calls exceed 2k tokens, capping
around 10–14k — and they are easy to confuse with the *other* big blocks (grep/find dumps,
base64 images, README markdown, JSON API responses, directory listings). A naive "skeletonize
the biggest blocks" conductor would mostly skeletonize the wrong things, which is destructive.
Precision in *classification* is therefore as load-bearing as the skeletonizer itself.

## Decision

### 1. A new collaborative in-process conductor, additive

`CodeSkeletonConductor` (`id: "code-skeleton"`, label "Code skeleton") is registered in
`IN_PROCESS_CONDUCTORS` (`conductors/index.ts`) alongside the existing conductors. It is
**collaborative** — it declares no involvement locks (ADR 0011): skeletonizing is a relevance
call, not a claim of authority, so a human pin keeps a file open, a manual unfold restores it,
and the next pass leaves that held block alone. No consent gate. The built-in golden test is
untouched; this is purely additive.

### 2. Classification is precision-first (`conductors/code-skeleton/classify.ts`)

`classifyCodeRead(block, callById)` decides whether a `tool_result` is a large code-file read
and recovers the path + cleaned source. The gates are **reject-biased** — a block must clear
every one:

1. **kind / error** — a non-error `tool_result` with content.
2. **tool family** — a direct file read (`read`/`view`/`cat`/…) OR a single-file shell dump
   (`cat`/`head`/`tail`/`sed -n`/`Get-Content` naming exactly one file). Pipes, command
   chaining, redirection, substitution, search (`grep`/`rg`/`find`), listing (`ls`/`dir`/
   `Get-ChildItem`/`tree`), `git` subcommands, multi-file dumps, globs, **directory targets**
   (trailing `/`), and **follow streams** (`tail -f`/`--follow`/`-Wait`) are all rejected.
3. **extension** — the recovered path's extension must be in a CODE set and not a PROSE/DATA
   set (`md`/`json`/`yaml`/`html`/images/… rejected). When there is **no** recognized code
   extension, the shape gate is tightened: the content must contain a real code keyword **and**
   must not parse as JSON — so a no-extension JSON/YAML/directory dump can't slip through on
   punctuation density alone.
4. **clean** — strip Claude-Code `cat -n` line-number prefixes (only when the numbers are
   monotonic, the cat -n shape — so a real tabular file isn't mangled) and the pi
   `exec_command` header block (only when a strong pi marker like `Wall time:`/`Chunk ID:` is
   present — so a source file that merely opens with `Command:` isn't truncated).
5. **content shape** — ≥2 of {code keyword, structural-punctuation density, indented lines};
   css is special-cased to a braces check.

The danger this guards against is a **false positive**: replacing non-code content with a
nonsensical "code skeleton" is destructive, so the bar to accept is deliberately high. A false
negative (missing a real code read) just forgoes an opportunity and is far less bad.

### 3. Skeletonization is deterministic and dependency-free (`skeletonize.ts`)

`skeletonize(src, lang)` produces the structural skeleton with no LLM, no parser dependency
(no tree-sitter / TS compiler API), no I/O — pure string→string, **byte-identical for the same
input**. The core is a *mask*: a parallel copy of the source where string/comment **contents**
are blanked to spaces (positions preserved 1:1), so brace-depth and indent analysis can't be
fooled by a `{` inside a string or a `}` inside a comment. Per language:

- **Brace languages** (ts/js, rust, go, java, c) — a frame stack distinguishes *container*
  bodies (class/interface/struct/enum — keep member signatures) from *callable* bodies
  (function/method/arrow — elide to `signature { /* … N lines */ }`). `import`/`export`,
  top-level `interface`/`type`, decorators, and leading comments are kept whole.
- **Python** — indentation-based: keep `import`s, module statements, `class`/`def` signatures,
  decorators, and the first docstring; elide each body to a `...` stub (valid Python).
- **Svelte** skeletonizes `<script>` as ts and collapses template/style to one-line markers;
  **css** keeps selectors and collapses rule bodies; **json** keeps the shape one level deep;
  a **generic** head/tail fallback covers genuinely unrecognized content.

Determinism is the point: a skeletonized prefix is byte-stable across passes, so it stays
cache-warm (the same property cold-epoch and thermocline pay for explicitly). The skeletonizer
**never drops a top-level declaration or signature** (the cardinal sin — it would mislead the
agent about the file's API) and **never hangs or throws** (it runs synchronously inside a
conductor pass that must not block a model call); both properties are pinned by regression
tests (barrel/`.d.ts`/interface preservation, truncated-file flush, long-line performance).

### 4. Reversibility via a new, engine-owned `ReplaceCommand.recoverable`

The skeleton's headline property — the agent can get the full source back — requires the
substitution to carry the `{#code FOLDED}` tag (ADR 0005), the handle `unfold`/`recall` resolve
a block by. A custom `replace` content is otherwise sent **untagged**, so a skeleton would be a
one-way fold the agent couldn't recover.

Rather than re-implement the tag conductor-side (off-brand — the engine is the single source of
truth for the tag, and a conductor can't reach `$lib`), this ADR adds one **additive, optional**
field to the contract: `ReplaceCommand.recoverable?: boolean`. When `true`, the engine bakes
`foldTag(id)` into the substitution in `store.substOne` (stripping any tag the conductor
mistakenly supplied, so the engine is the *sole* author and a wrong-id/double tag can never
reach the agent). `digestOf` then returns the tagged skeleton verbatim, `effTokens` counts the
tag so the saving stays honest, and `resolveUnfold`/`resolveRecall` match it by `foldCode(id)`
exactly as for an engine digest. The change is additive — `recoverable` defaults `false`, so
the built-in (and every existing conductor) is byte-identical, and naive compaction stays
deliberately irreversible (it must *not* tag a summary whose original it discarded). The
capability generalizes: any conductor wanting a lossy-by-display, lossless-by-reference
substitution (e.g. thermocline's "recoverable LLM-Digest") can now opt in.

This is the crux that separates code-skeleton from naive compaction: **the same view, but
lossless-by-reference instead of lossy** — navigate by skeleton, drill into a body when you
actually need it.

### 5. Budget discipline: best-effort, never worse than the built-in

`conduct(view)` returns `[]` under budget (raw, the shipped convention). Over budget, three
passes:

1. **skeletonize** eligible code reads oldest-first (`replace` + `recoverable: true`) — the
   preferred, contract-preserving fold — until live ≤ budget;
2. if still over, **generic-fold** the remaining foldable blocks (the built-in's
   `FOLD_RANK` order, engine digest — also reversible);
3. if STILL over, **downgrade** the oldest skeletons to plain digests for the extra saving — a
   skeleton (signatures) costs more than a one-line digest, so this is the only lever left once
   every other foldable block is folded, and it guarantees the conductor never leaves more on
   the table than the built-in would.

Skeleton sizing uses `host.countTokens` (the engine's own tokenizer, synchronous) with a
chars/4 fallback; the estimate is deliberately conservative (it never *under*-counts the
substitution), so a single pass can't stop folding while the real applied tokens exceed budget.
The conductor keeps a per-id skeleton memo (block text is immutable) so the many passes a
session triggers stay cheap; it holds no other cross-pass state and re-emits its complete
desired state every pass. Host use is light and synchronous — `countTokens` + `setStatus`; no
`host.complete`, so `conduct()` is free and never blocks.

### 6. Scope: reads, not writes

Only `tool_result` blocks are skeletonized. A file **write** lives in a `tool_call`, which is
never wire-foldable (folding it would orphan its result), so the content an agent writes can't
be `replace`d — the host clamps it. This is a real limitation, honestly bounded: the win is on
reads and re-reads (the dominant case in the data — the bundled sample reads the same 5.3k-token
Python file twice), and a write-heavy session keeps a non-foldable floor no conductor can
reduce. Group-based write skeletonization is possible (a `group` may swallow a `tool_call`) and
is left to future work.

## Consequences

- **A new digest modality is selectable in the header switcher**, composing with the existing
  conductors via the one-line `store.attach`. Whole conductor output is reversible — skeletons
  *and* fallback digests both carry the `{#code FOLDED}` tag.
- **`replace` gets its first real use for a structural (non-summary) digest.** Until now custom
  `replace`/`group` content was either a naive summary (ADR 0014) or unused; this is the first
  conductor to substitute a *navigable* representation the agent is meant to read and partially
  expand.
- **`recoverable` is a small, reusable framework capability.** It turns "a conductor's custom
  substitution can be agent-recoverable" from a per-conductor hack into one engine-owned flag,
  available to any future conductor.
- **Writes can't be skeletonized** (§6) — documented, not hidden.
- **Granular unfold is whole-file.** `unfold` restores the entire block (the whole file), not
  the single method body the agent asked about; sub-block addressing is future work.

## Prior art

This conductor was built before surveying the field; a follow-up prior-art pass (aider,
repomix, tree-sitter, ctags, LSP/SCIP, the academic literature, and how Cursor / Cline /
Claude Code manage code context) confirmed the technique and sharpened where it sits.

- **The technique is established, not novel.** A "signature skeleton" — keep imports /
  declarations / signatures / docstrings, elide bodies — is a named, mainstream approach:
  **repomix `--compress`** does exactly this via tree-sitter (~70% reduction); **aider's
  repo-map** and **Cline / Roo's `list_code_definition_names`** extract the same signature
  view; the literature calls it "skeleton compression." What is genuinely new here is the
  **reversibility**: repomix's compression is one-way and aider's "recovery" is re-adding the
  whole file, whereas this conductor's `{#code FOLDED}` tag makes every skeleton individually
  `unfold`/`recall`-able. On that axis the conductor is ahead of the named tools, not behind.
- **The real gap is the parser, not the idea.** Every serious implementation uses
  **tree-sitter**, not the hand-rolled regex / brace-masking here. Tree-sitter would dissolve
  the exact bug classes the adversarial review found (string/comment masking, brace miscounts,
  dropped declarations, catastrophic backtracking) and is error-tolerant on truncated files. It
  is a sturdier *implementation of the same technique*, not a better technique — the output is
  the same skeleton — and it is recorded as deferred future work because its costs collide with
  this repo's constraints (a runtime dependency vs the dependency-free-conductor rule, several
  MB of per-language grammar WASM, a one-time async init, undocumented-though-real determinism).
- **The niche fits a structural skeleton.** For a file the agent *already read and chose*, now
  aging out of context, a cheap-but-reversible structural stand-in beats the alternatives:
  embeddings/RAG solve a different problem (finding *unread* code — and Claude Code and Cline
  both reject RAG for the agentic case); LLM summarization is lossy, costly, non-deterministic,
  and irreversible; token-level prompt compression (LLMLingua) damages code syntactically and is
  query-conditioned (uncacheable). The one honest competitor is plain **on-demand re-read** (zero
  standing cost), which wins when a file won't be touched again — exactly the case the
  precision-first classifier + downgrade-to-digest pass already route away from a skeleton.

## Rejected alternatives

- **LLM summarization of code files.** Rejected for the core: non-deterministic (cache-breaking),
  costs tokens, lossy, and irreversible. Deterministic structural extraction is free, cache-warm,
  and reversible. An optional LLM-enhancement layer atop the deterministic skeleton is possible
  future work, not the foundation.
- **Re-implementing `foldCode`/`foldTag` inside the conductor.** Rejected: the engine is the
  single source of truth for the tag (CLAUDE.md is emphatic — "not bolted on at the wire" or
  anywhere else), and a conductor can't import `$lib`. The additive `recoverable` flag keeps the
  tag engine-owned.
- **Merging into the built-in.** Rejected: the built-in is golden-pinned and deliberately
  minimal. This is additive.
- **Proactive skeletonization under budget.** Rejected: every shipped conductor returns `[]`
  under budget; skeletonizing stale code before there's pressure would be surprisingly
  meddlesome. The modality shows under pressure, where it matters. A proactive "code hygiene"
  toggle is possible future work.
- **Skeletonizing writes by collapsing the write `tool_call`+result into a `group`.** Deferred:
  it changes block structure (a group), and v1's clean `replace`-on-tool_result path is the
  robust, reversible foundation. Noted in §6.
- **Token-level prompt compression (LLMLingua / LongLLMLingua).** Rejected: it drops tokens by
  perplexity, which breaks code syntactically (a removed bracket or keyword); it is
  query-conditioned, so the compressed prefix changes per turn and can't be prompt-cached; and
  it is irreversible. All three collide with this conductor's requirements (the code-specific
  damage is documented in LongCodeZip and "Compressing Code Context for LLM Issue Resolution").
- **Embeddings / RAG retrieval.** Rejected for this niche: RAG answers "find relevant code in a
  repo I haven't read," not "keep a file the agent already read cheaply present and reversible."
  Claude Code and Cline both reject RAG for the agentic case for the same reason.

## Future work

- **Writes via group-based skeletonization** (§6).
- **Granular unfold** — restore one method body rather than the whole file (needs sub-block
  addressing).
- **Optional LLM-enhanced skeletons** — a deterministic skeleton first, optionally enriched by
  an off-path `host.complete` (e.g. a one-line purpose per method), held behind the same
  `recoverable` reversibility.
- **A "proactive" mode** — skeletonize stale large code reads before budget pressure, behind a
  toggle, for cache-warmth and context hygiene.
- **A tree-sitter skeletonizer** (the engine every serious peer uses), if language coverage
  grows or the regex parser proves fragile in practice — weighed against the real cost in this
  environment: a runtime dependency (vs the "dependency-free conductor" rule), several MB of
  per-language grammar WASM, a one-time async init (so `conduct()` gains a not-ready state),
  undocumented-though-real determinism with a grammar-version cache-bust risk, and per-language
  queries still to maintain. A robustness/maintainability upgrade, not a capability one.
- **Intra-file ranking for overflow** (borrowed from aider's PageRank, done deterministically as
  an in-file reference-count proxy): when a single skeleton still overruns the budget, keep the
  exported / most-referenced signatures and collapse the rest to a `// + N more` line, rather
  than declining the block or downgrading it wholesale to a one-line digest.
