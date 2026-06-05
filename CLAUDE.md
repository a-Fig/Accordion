# CLAUDE.md — Accordion

Guidance for AI coding sessions in this repo. Read [VISION.md](VISION.md) for the
product north star and [README.md](README.md) for the short pitch. This file is
about **how to work in the code**, not what the product is.

## Where the live work is

The active surface is the **desktop app** in `app/` — a Tauri 2 + SvelteKit window
that visualizes an agent's context window. Two routes:

- `/`  — **Classic** view (`routes/+page.svelte`): `ContextSummary` / `ContextTimeline`
  toggle on top, a scrollable `Timeline` of `BlockCard`s, activity feed.
- `/map` — **Map** app (`routes/map/+page.svelte`): an abstraction-first view.
  `MapHeader` (composition strip + budget) + `ContextMap` + `Inspector` (on-demand
  text panel). This is where most recent design iteration lives.

`src/` (repo root) and `visualizer/` are the older pi-extension POC and the
standalone HTML visualizer — not the focus; touch only if asked.

## The engine is the source of truth — use it, don't change it

`app/src/lib/engine/` owns the model. The UI only renders it and calls its actions.

- `types.ts` — `Block { id, kind, turn, order, text, tokens, toolName?, callId?, override, autoFolded, by }`.
  Kinds: `user · text · thinking · tool_call · tool_result`.
- `parse.ts` — pi / Claude Code JSONL → typed blocks. **`tool_call` and `tool_result`
  are separate blocks sharing a `callId`** (call = durable "what it did"; result =
  "what it saw", decays fast). An assistant message's thinking/text/call share an
  `id` prefix before `:`.
- `store.svelte.ts` — `AccordionStore` (Svelte runes). API: `blocks`, `budget`/`setBudget`,
  `isFolded(b)`, `effTokens(b)`, `digestOf(b)`, `toggle/fold/unfold/pin/unpin(id)`,
  `resetAll()`, `liveTokens`, `fullTokens`, `savedTokens`, `foldedCount`, `overBudget`,
  `log`, `meta`. Exposed as `window.__store` for debugging.
  - **Protected working tail:** `protectTokens` (default `20_000`) reserves the newest
    ~N tokens of context so the auto-folder never touches recent reasoning. `protectedFromIndex`
    walks back from the newest block summing full `tokens` and returns the index where the
    sum first reaches `protectTokens` (blocks at that index and later are protected; always
    at least the newest block; `0` if the whole session is smaller than the window).
    `isProtected(b)` and `protectedTokens` are the reads. `refold()` only builds fold
    candidates from blocks with `i < protectedFromIndex` — i.e. older than the tail. Manual
    `fold()`/`pin()` are unaffected; protection constrains the automatic folder only.
    `setProtect(n)` resizes the tail and re-folds — wired to a header slider (0–60k).
- `tokens.ts` (chars/4 estimate) · `digest.ts` (what a kind collapses to when folded).

Folding is **content substitution, never removal** — provider-safe and fully reversible.

## Visual grammar (consistent across ALL views)

- **kind = color** — `user #6ea8fe · text #aab2c2 · thinking #b483e0 · tool_call #34d3c2 · tool_result #f0a35e` (vars `--k-*` in `app.css`).
- **live = solid / folded = recessed** (dim + faint hatch, never a heavy dark hatch).
- In the **Map Grid**: every block is the **same-size square**, laid out in strict
  conversation order (uniform size ⇒ no reflow holes ⇒ linearity is free). Token
  **weight is read as a dice face 1–6** (more pips = heavier block). Current
  thresholds in `ContextMap.svelte → faceFor()`: ≥500→2, ≥1500→3, ≥5000→4, ≥10000→5,
  ≥50000→6, else 1. Arrow keys traverse blocks (←/→ = prev/next, ↑/↓ = ± one row).
  The grid is split into **two rounded boxes stacked like paragraphs**, divided at
  `store.protectedFromIndex`: the top box holds older/foldable blocks (thin border);
  the bottom box holds the protected tail and has a **meaningfully thicker, accented
  border** to signal protection (`.box.prot`). No text labels — the border does the
  talking. Each box holds its own uniform grid; order is continuous across both.

## Conventions

- **Svelte 5 runes** (`$state`, `$derived`, `$derived.by`, `$effect`, `$props`).
  `ssr = false`, adapter-static SPA fallback (so `/map` direct-loads). Vite port 1420.
- **Plain JS/TS** — no fancy build steps beyond SvelteKit.
- `{@const}` must be an immediate child of `{#if}`/`{#each}` — otherwise use a `$derived`.
- This Svelte's `svelte-ignore` only honors the **first** code in a multi-code comment.
- **Performance: do not paint many live gradients/filters across the 982-tile grid.**
  Radial gradients and per-element `filter` re-rasterize on every repaint and tank
  interaction. The dice pips are **one cached SVG data-URI per face** (decoded once,
  blitted) — keep that pattern for anything tile-dense.
- **Scroll perf on the tile grid:** `.cell` uses `content-visibility: auto` +
  `contain-intrinsic-size: var(--cell)` to cull off-screen tiles, and hover is
  instant (no `transition`) so scrolling past tiles doesn't animate a repaint storm.
  Because `content-visibility` implies paint containment, keep tile decorations
  **inset** (the selection ring is inset-only) — outset box-shadows get clipped.
  (Scroll smoothness is still under active investigation — see handoff.)

## Running & verifying

```bash
cd app
npm run dev          # browser dev server → http://localhost:1420
npm run tauri dev    # native desktop window (needs Rust toolchain)
npm run check        # svelte-check / typecheck — keep it 0 errors / 0 warnings
```

Environment gotchas (Windows, this repo's usual setup):

- **cargo is not on the Bash tool's PATH.** Run `npm run tauri dev` from PowerShell
  with `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:USERPROFILE\.rustup\bin;$env:PATH"`.
- The dev server and `tauri dev` both want **port 1420** — only one at a time. Free it
  with `Get-NetTCPConnection -LocalPort 1420 | Stop-Process` before swapping.
- The preview/screenshot MCP has been **flaky** here (captures time out even when the
  page is healthy); verify via `preview_eval` / `preview_inspect` and `svelte-check`.
- Always `npx svelte-check --tsconfig ./tsconfig.json` before declaring done.

## Data & security

- Dev sample: `app/static/sample-session.jsonl` — a real ~130k-token / ~982-block pi
  session. Most blocks are small (<500 tok); the largest is ~5k, so dice faces 5–6
  won't appear on this sample.
- **This repo is public.** The sample once contained a live API key (redacted to
  `REDACTED_API_KEY`). **Never commit real keys** — scan sample data before pushing.

## Working style

Be candid — no undue praise, no overselling. The owner reviews by screenshot and
makes the design calls; surface tradeoffs plainly and let them decide. Only commit /
push when explicitly asked.
