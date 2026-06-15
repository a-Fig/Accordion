# CLAUDE.md — Accordion

Guidance for AI coding sessions in this repo. Read [VISION.md](VISION.md) for the
product north star and [README.md](README.md) for the short pitch. This file is
about **how to work in the code**, not what the product is.

## Where the live work is

The active surface is the **desktop app** in `app/` — a Tauri 2 + SvelteKit window
that visualizes an agent's context window. A **single route** (`routes/+page.svelte`):
the **Map** app, an abstraction-first view. In the desktop app it's a shell — a
**`SessionsSidebar`** (a top **source switcher** — live pi sessions via the pull model,
*or* read-only **Claude Code** transcripts browsed from `~/.claude/projects`; minimizable
to a slim icon rail, plus a pinned **Demo session** that loads the bundled sample) + the
session view:
`MapHeader` (composition strip + budget) + `ContextMap` + `Inspector` (on-demand text
panel). `ContextMap` carries a **2-way segmented control: `Map` | `Transcript`** — **Map**
is the abstraction (the uniform dice-square grid) and **Transcript** is the concretion (a
readable, scrollable full-chat view: blocks as cards in conversation order, each with a
kind-colored left spine and a role label — You / Assistant / Thinking / Tool call / Tool
result; live blocks show full text, folded blocks show the exact `{#code FOLDED}` digest the
agent sees; inline Fold/Unfold per card + double-click to fold, single click = inspect).
The old **Classic** view (summary/timeline of `BlockCard`s) and the earlier 3-way
**Grid / Turns / Chains** zoom switch were both removed; their components
(`ContextSummary` / `ContextTimeline` / `Timeline` / `BlockCard`) and `chains.ts` are gone.

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
    walks back from the newest block summing full `tokens` toward that target, but refuses
    to pull in the next older block if doing so would exceed a strict 25% whole-block
    overflow cap (except the newest block, which is always protected even if it alone
    exceeds the cap; `0` if the whole session fits under the target/cap).
    `isProtected(b)` and `protectedTokens` are the reads. `refold()` only builds fold
    candidates from blocks with `i < protectedFromIndex` — i.e. older than the tail. Manual
    `fold()` is also refused in the protected tail, and a folded block that later becomes
    protected heals back to live; `pin()` remains allowed because it keeps content open.
    `setProtect(n)` resizes the tail and re-folds — wired to an on-bar draggable handle
    on the composition strip (0–60k, step 2k; the real refold is deferred to pointer-release
    so dragging doesn't re-fold continuously).
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

**Read-only Claude Code browsing (separate from the live link).** The source switcher's
*Claude Code* mode lists static transcripts under `~/.claude/projects/<proj>/*.jsonl`.
Two Rust commands own this (`lib.rs`): `list_claude_sessions` (walks the projects dir,
skips nested `subagents/`, newest-50 by mtime, head-reads ≤96 KB to pull a title —
`ai-title`→`summary`→first-user-msg — plus cwd/project) and `read_claude_session` (a
path-confined read used to load **and tail** the file — the JS `fs` plugin's scope does
*not* cover programmatic reads of `~/.claude`, only dialog-picked files, so Rust owns
that access). App side: `live/claude.ts` (the `ClaudeCodeSession` type + guard) and
`live/claudeDiscovery.svelte.ts` (a 3 s poll that runs only while the CC tab is active).
A CC session loads through the engine like the demo, so local fold/unfold/pin/peek all
work as a personal lens — but `session.readOnly` is set (the `MapHeader` shows a
**READ-ONLY** badge) and there is no wire to steer. **Known limitation:** an *actively
appended* CC session re-runs `_load` on each tail tick, which rebuilds the store and
drops manual folds; static transcripts (the common case) never re-load. The durable fix
is an incremental `appendBlocks` tail like the WS path.

**Invariants (don't break):** discovery I/O is best-effort and **never blocks or alters
a model call**; no GUI / reply timeout / empty plan ⇒ messages pass through untouched;
no disk I/O on the `context` (pre-model-call) hook. **The engine is now on (M2, ADR
0004) but folding the live agent is OPT-IN and OFF by default** (`folding.enabled`, a
header toggle). Disarmed, the GUI still replies with an empty plan — M1 behavior, no
model call altered. Armed, `computePlan` mirrors the engine's fold decisions into ops
via `computeFoldOps` (`plan.ts`), guarded so only **durable-id** `text`/`thinking`/
`tool_result` blocks are ever folded (`isDurableId`; `applyPlan` enforces the same).

**M3 — agent self-unfold ([ADR 0005](docs/adr/0005-agent-unfold.md)):** the engine's
`digest()` now prefixes every folded block's digest with `{#<code> FOLDED}`, where
`<code>` is a short stateless hash of the durable block id (`foldCode` — a raw id is a
UUID/timestamp, too noisy to repeat). This is the single source of truth: the GUI renders
the exact string the agent receives, and token accounting includes the tag — no separate
wire representation, no drift (only foldable kinds — text/thinking/tool_result — are tagged,
since only those are ever sent folded). The extension registers an `unfold` pi tool: the
agent calls `unfold({codes: [...]})` with code(s) copied from the tags, the GUI resolves
each code to its folded block(s) (a rare hash collision restores all matches) and marks
them unfolded (sticky, provenance `"agent"`), and the full content returns on the agent's
**next turn** (state-change-only; no content echo this cut). The agent can only unfold a
block that is actually folded — it can't downgrade a human pin. Agent unfolds show in the
activity log; the human can re-fold them. The skill `accordion-context-folding` is
auto-exposed via `resources_discover` — no manual loading.

**Known characteristic:** the view syncs on pi's `context` hook, which fires *before*
each model call — so an assistant reply is only seen at the *next* model call (i.e. the
next user turn for a plain reply; immediately for tool-using turns). Closing that gap
(a post-turn view sync) is a planned follow-up.

## Conductors — pluggable context strategy ([ADR 0007](docs/adr/0007-conductor-protocol.md), [0008](docs/adr/0008-conductor-first-party-one-view.md))

*Which* blocks to fold / replace / group / restore / pin is owned by a **conductor**, an
interchangeable strategy behind one contract: `conduct(view) → Command[] | null` (`Command[]`
= complete desired state, `[]` = clear to raw, `null` = hold last state). Accordion imposes
no strategy of its own — no conductor attached ⇒ raw context. Conductors are **first-party**
(every one ships in this repo or a fork — no sandbox, no trust boundary); the interface
exists to make them cheap to write, with the built-in as the worked example. The contract
lives in the top-level **`conductors/contract/`** (both halves dependency-free / Node-safe,
re-exported by `conductors/contract/index.ts`, imported via the `$conductors` alias):
`conductor.ts` (the in-process shape — `ConductorView`, `ViewBlock`, the `Command` union
`fold·replace·group·restore·pin`, `ClampReport`, the `Conductor` interface) and `protocol.ts`
(the WebSocket messages, `CONDUCTOR_PROTOCOL_VERSION = 2`, which *import* the `Command` /
`ViewBlock` types so there is one definition). The host enforces exactly one floor —
**provider-validity** (the message stays sendable); human overrides always win; an unsafe
command is clamped to nearest-safe and **reported**, never silently dropped (bug/UX rails,
not protection against the conductor).

- **One public view.** Every conductor — built-in included — receives the same pure-data
  `ConductorView`: top-level `budget`, `contextWindow`, `liveTokens`, `protectedFromIndex`,
  `protectTokens`, and `blocks: ViewBlock[]` (`id, kind, turn, order, tokens, foldedTokens,
  toolName?, callId?, isError?, held, folded, protected, grouped, text?, preview?`). The
  store builds it in `buildView`/`runConductor` (`store.svelte.ts`); there is no privileged
  richer in-process snapshot.
- **In-process is the main way.** Drop a TS class implementing `conduct(view)` in
  `conductors/<name>/` and register one line in `conductors/index.ts`
  (`IN_PROCESS_CONDUCTORS`: `{ id, label, create: () => new MyConductor() }`) — it appears in
  the header switcher automatically. The **built-in** folder is the worked reference —
  `conductors/builtin/builtin.ts` (`BuiltinConductor`, a ~15-line `conduct`), attached by
  `AccordionStore` on construction; `store.attach(c)` / `store.detach()` swap it. Folds from
  every conductor are attributed uniformly (`by:"auto"`; no `id === "builtin"` special-case).
  Its byte-identical output is pinned by a golden test (`conductor.builtin.test.ts`) — don't
  break it.
- **WebSocket is a demoted escape hatch** for a separate process / another language. The
  conductor hosts a WS endpoint; Accordion **dials as a client** (the webview can't host a
  server). `context/update` carries the full `ConductorView`. App side:
  `live/conductorClient.svelte.ts` (`RemoteRunner` bridges the async WS ↔ the synchronous
  `conduct()`), `live/conductorDiscovery.svelte.ts` (polls Rust `list_conductors` +
  hand-configured URLs), switched via the header `ui/map/ConductorMenu.svelte` dropdown.
  Local discovery files live at `~/.accordion/conductors/<id>.json` (5 s heartbeat; 15 s stale/reap window).
- **Writing one:** [conductors/README.md](conductors/README.md) leads with the in-process
  path + a minimal example; [docs/conductor-protocol.md](docs/conductor-protocol.md) is the
  full developer reference (the `ConductorView`/`ViewBlock`/`Command` tables first, then the
  WS lifecycle + message shapes as the escape-hatch half). External (WS) implementations live
  in `conductors/<name>/`, any language; `conductors/recency-folder/` is the runnable wire
  starter.
- **All conductors live in `conductors/`** — always check that directory for the full set;
  this doc may not name every one. Current conductors:
  - `builtin/` — the default, in-process. Deterministic oldest-first, lowest-value-first fold.
  - `cold-score/` — in-process. ACT-R power-law scoring + lexical pre-unfold + hysteresis.
  - `attention-folder/` — external (WS). A small LM (Qwen2.5-0.5B probe) scores attention
    relevance; periodic hysteresis-band epochs fold the least-attended blocks. See
    [ADR 0010](docs/adr/0010-attention-conductor.md).
  - `recency-folder/` — external (WS). Minimal wire-protocol starter example.

## Visual grammar (consistent across ALL views)

- **kind = color** — `user #6ea8fe · text #aab2c2 · thinking #b483e0 · tool_call #34d3c2 · tool_result #f0a35e` (vars `--k-*` in `app.css`).
- **live = solid / folded = recessed** (dim + faint hatch, never a heavy dark hatch).
- In the **Map Grid**: every block is the **same-size square**, laid out in strict
  conversation order (uniform size ⇒ no reflow holes ⇒ linearity is free). Token
  **weight is read as a dice face 1–6** (more pips = heavier block). Current
  thresholds in `ContextMap.svelte → faceFor()` (upper bounds, "up to"): ≤100→1, ≤500→2,
  ≤1.5k→3, ≤5k→4, ≤15k→5, >15k→6. Arrow keys traverse blocks (←/→ = prev/next, ↑/↓ = ± one row).
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

## Post-merge routine

After a PR lands on `main`, close any open Accordion window (the running `app.exe` locks the file), then pull main on the registered checkout (the one in `~/.pi/agent/settings.json → extensions`), run `npm install` inside `app/` in case deps changed, and rebuild the binary with `npm run tauri build -- --no-bundle` (cargo must be on PATH). The next `/accordion` call picks up the new binary automatically. If the extension code changed, restart pi so it reloads `accordion.ts`.

## Data & security

- Dev sample: `app/static/sample-session.jsonl` — a real ~130k-token / ~982-block pi
  session. Most blocks are small (<500 tok); the largest is ~5k, so under the current
  faceFor() bounds the sample spans roughly faces 1–4 (face 6 = >15k won't appear).
- **This repo is public.** The sample once contained a live API key (redacted to
  `REDACTED_API_KEY`). **Never commit real keys** — scan sample data before pushing.

## Working style

Be candid — no undue praise, no overselling. The owner reviews by screenshot and
makes the design calls; surface tradeoffs plainly and let them decide.
