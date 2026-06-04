# 🪗 Accordion — desktop app

The Accordion window: a Tauri + Svelte desktop app that shows an agent's context
window as a timeline of **typed blocks** and lets you fold, unfold, and pin any
part of it, by hand. This is the bare-bones v0 — deterministic budget folding,
human-driven, over a loaded session. No Conductor, no live agent bridge yet.

## What's here

- **Typed sub-message blocks.** A session is parsed into blocks — `user`,
  `text` (assistant reply), `thinking`, `tool_call`, `tool_result` — each one
  independently foldable. A tool call and its result are *separate* blocks
  (linked by id): the call is the durable record of *what the agent did*; the
  result is *what it saw* and decays far faster.
- **Deterministic, value-aware folder.** To keep the live context under a token
  budget, it folds lowest-value, oldest blocks first:
  `tool_result → thinking → text → tool_call → user`. Pinned blocks and the most
  recent `hotTail` blocks are never auto-folded. Folding is content
  substitution, never removal, so a call/result pair is never orphaned.
- **The context bar.** A canvas minimap: one segment per block, width ∝ its
  *effective* tokens, colored by kind, folded blocks shrink to slivers, with a
  budget marker and over-budget zone. Click to jump to a block.
- **Timeline + activity feed.** Per-block fold/unfold/pin, attributed (you / auto).

## Architecture

```
src/lib/engine/        framework-agnostic model — the single source of truth
  types.ts             Block, kinds, overrides
  tokens.ts            crude chars/4 estimator (swap for a real tokenizer later)
  digest.ts            what each block kind collapses to when folded
  parse.ts             pi / Claude Code JSONL → typed blocks (id-linked pairs)
  store.svelte.ts      fold state + the deterministic budget folder (Svelte runes)
src/lib/ui/            ContextBar (canvas), Timeline, BlockCard
src/routes/+page.svelte   composition; loads static/sample-session.jsonl
src-tauri/             the Rust desktop shell
```

The engine owns the model; the UI only renders it and calls its actions. When the
live bridge lands, the same engine state will be fed by a running pi session over
a localhost socket instead of a loaded file.

## Run

```bash
npm install
npm run dev            # browser dev server at http://localhost:1420
npm run tauri dev      # the actual desktop window (needs Rust toolchain)
npm run build          # static production build → build/
npm run check          # svelte-check / typecheck
```

The dev sample (`static/sample-session.jsonl`) is a real ~130k-token pi session
(~980 blocks). Drag-to-open and a live agent bridge are the next slices.

## Not yet (deferred by design)

- The Conductor (automatic relevance-driven folding between turns)
- The live pi bridge + an agent-facing fold/unfold tool + the teaching skill
- LLM-generated summaries, a real per-model tokenizer, hierarchical grouping
