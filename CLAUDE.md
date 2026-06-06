# CLAUDE.md — Accordion

Guidance for AI coding sessions in this repo. Read [VISION.md](VISION.md) for the
product north star and [README.md](README.md) for the short pitch. This file is
about **how to work in the code**, not what the product is.

## Where the live work is

The active surface is the **desktop app** in `app/` — a Tauri 2 + SvelteKit window
that visualizes an agent's context window. A **single route** (`routes/+page.svelte`):
the **Map** app, an abstraction-first view. In the desktop app it's a shell — a
**`SessionsSidebar`** (live pi sessions via the pull model, minimizable to a slim icon
rail, plus a pinned **Demo session** that loads the bundled sample) + the session view:
`MapHeader` (composition strip + budget) + `ContextMap` + `Inspector` (on-demand text
panel). The old **Classic** view (summary/timeline of `BlockCard`s) was removed; its
components (`ContextSummary` / `ContextTimeline` / `Timeline` / `BlockCard`) are gone.

The current pi extension is **`extension/accordion.ts`** (the live link — see below).
`src/` (repo root) and `visualizer/` are the *older* pi-extension POC and the
standalone HTML visualizer — not the focus; touch only if asked. Don't confuse
`src/accordion.ts` (old POC) with `extension/accordion.ts` (current).

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
  `log`, `meta`, and `appendBlocks(blocks)` (used by the live link to stream new
  blocks in). Exposed as `window.__store` for debugging.
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

## The live link (`app/src/lib/live/` + `extension/`)

How the app attaches to a *running* pi session and (eventually) steers its context.
Two halves talk over a loopback WebSocket; **"GUI drives, extension is thin"** — the
extension makes no folding decisions, it streams pi's messages and applies whatever
plan the app returns. Decisions live in ADRs: [0001](docs/adr/0001-pi-live-integration.md)
(the loop) and [0002](docs/adr/0002-pull-connection-model.md) (how they find each other).

- **Shared contract — imported by *both* sides** (extension via relative path, app via
  `$lib`), so the wire and safety rules have one home. Keep these dependency-free /
  Node-safe (no Svelte, no `$state`):
  - `protocol.ts` — wire messages (`hello` / `sync` / `plan`), `WireBlock`, `FoldOp`,
    `PROTOCOL_VERSION`. Block ids encode message location (`m<i>:p<j>`, `m<i>:r`, …).
  - `mapping.ts` — `linearize(messages)` (mirrors `engine/parse`) and the **pure,
    kind-checked** `applyPlan(messages, ops)` (a `tool_call` is never folded → never
    orphans its result; recent messages are backstopped).
  - `registry.ts` — the **discovery** contract: `SessionEntry`, `FocusRequest`,
    `isLiveEntry`, and the `~/.accordion/` layout. The Tauri Rust layer mirrors these
    constants — change them in lockstep.
- **App side (Svelte):** `liveClient.svelte.ts` (WS *client* → builds the live store),
  `discovery.svelte.ts` (polls native discovery, reaps stale sessions, handles focus),
  rendered by `ui/live/SessionsSidebar.svelte` on the `/map` shell.
- **Extension side (Node):** `extension/accordion.ts` hosts the WS *server* on an
  **ephemeral** port and advertises the session in `~/.accordion/sessions/<id>.json`
  (5 s heartbeat; deleted on shutdown). `/accordion` writes `~/.accordion/focus.json`.
- **Native discovery (Rust):** `app/src-tauri/src/lib.rs` — `list_sessions`,
  `reap_session`, `take_focus_request`, `focus_window`. A browser tab can't read the
  registry, which is why discovery is desktop-only (browser dev has a manual-port box).

**Invariants (don't break):** discovery I/O is best-effort and **never blocks or alters
a model call**; no GUI / reply timeout / empty plan ⇒ messages pass through untouched;
no disk I/O on the `context` (pre-model-call) hook. **Today the app returns an empty
plan** — the loop and the live view are proven, but no model call is changed yet.

**Known characteristic:** the view syncs on pi's `context` hook, which fires *before*
each model call — so an assistant reply is only seen at the *next* model call (i.e. the
next user turn for a plain reply; immediately for tool-using turns). Closing that gap
(a post-turn view sync) is a planned follow-up.

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
- **Scroll perf on the tile grid:** the win came from killing hover repaints during
  scroll, not from culling. `ContextMap` sets `class:scrolling` on the stage while a
  scroll is in flight and clears it ~140 ms after it stops; `.stage.scrolling .grid`
  drops `pointer-events: none` so the cursor can't trigger per-tile hover repaints
  mid-scroll. The `.boxes` get GPU layer promotion (`transform: translateZ(0)`) and
  hover is instant (no `transition`). `content-visibility`/`contain-intrinsic-size`
  were **removed** from `.cell` (they hurt more than helped here). Keep tile
  decorations **inset** (the selection ring is inset-only) — outset box-shadows clip.

## Running & verifying

```bash
cd app
npm run dev          # browser dev server → http://localhost:1420 (UI iteration only)
npm run tauri dev    # native desktop window — REQUIRED for live session discovery
npm run check        # svelte-check / typecheck — keep it 0 errors / 0 warnings
npm run test         # vitest — unit tests for the risky live/mapping logic
```

```bash
cd extension && node smoke.mjs   # drives the extension via jiti + a real WS client
cd app/src-tauri && cargo check  # the native discovery layer (PowerShell — see below)
```

Live discovery (the Sessions sidebar) only works in the **desktop** app — the browser
build can't read `~/.accordion/`, so it falls back to a manual-port Connect box.

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
