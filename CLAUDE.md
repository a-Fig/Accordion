# CLAUDE.md — Accordion

Guidance for AI coding sessions. [VISION.md](VISION.md) = product north star · [README.md](README.md) = short pitch.

## Key URLs

- **Marketing site:** https://get-accordion.dev/
- **Public repo:** https://github.com/a-Fig/Accordion
- **Private repo:** https://github.com/a-Fig/accordion-private

## Terminology

- **pi** — the CLI AI coding harness whose context window Accordion visualizes. Not an Accordion product; it's the tool the user runs. `extension/accordion.ts` is a pi plugin that hooks into pi's `context` hook (fires before each model call).
- **block** — atomic unit of context: one chunk of a single kind (`user`, `text`, `thinking`, `tool_call`, or `tool_result`). See `engine/types.ts → Block`.
- **turn** — one user message plus all assistant content (thinking, text, tool calls, tool results) that follows it before the next user message.
- **fold / folding** — replacing a block's content in-place with something shorter, like a summary; the block stays on the wire to the LLM in compressed form. Always reversible.
- **held** — a block carrying a human override (manual pin, fold, or unfold). `ViewBlock.held = true`; the host refuses conductor commands on held blocks unless the conductor holds a `human-steering` involvement lock.
- **conductor** — a pluggable context-management strategy (`conduct(view) → Command[]`). Decides which blocks to fold, group, replace, pin, etc. between turns.
- **the wire** — the messages array sent to the LLM provider. "Wire-valid" = the outgoing array is well-formed. Distinct from the WebSocket between the app and the pi extension (that's the live link / accordion protocol).
- **browser-served** — mode where the pi extension HTTP-serves the SvelteKit UI on the same ephemeral port as the WS. Single-session; no Tauri desktop app required.
- **CC** — Claude Code (as in "CC transcript", "CC browsing"). Read-only mode; sessions loaded from `~/.claude/projects/`.

## Codebase map

| path | what |
|------|------|
| `app/` | Tauri 2 + SvelteKit desktop app — the active surface |
| `app/src/lib/engine/` | The model: types, parser, store — single source of truth |
| `app/src/lib/live/` | WS client, session discovery, CC transcript browsing |
| `app/src-tauri/src/lib.rs` | Native Rust: session discovery + `~/.claude` reads |
| `extension/accordion.ts` | Live pi extension — WS server + HTTP server (browser-served mode) |
| `conductors/` | All context strategies — see [conductors/README.md](conductors/README.md) |
| `conductors/contract/` | Shared conductor contract (dependency-free) |
| `docs/` | ADRs + developer references |
| `brand/accordion-brand-kit/brand.md` | Brand colors + typography source of truth |

**App structure.** One route (`routes/+page.svelte`), the **Map** shell: `SessionsSidebar` (source switcher — live pi sessions or read-only Claude Code transcripts) + `MapHeader` (composition strip + budget) + `ContextMap` + `Inspector`. `ContextMap` has a 2-way toggle: **Map** (uniform dice-square grid) | **Transcript** (scrollable full-chat; blocks as cards, kind-colored left spine; live blocks show full text, folded blocks show the exact `{#code FOLDED}` digest the agent sees; double-click to fold, single click = inspect). Arrow keys traverse blocks (←/→ = prev/next, ↑/↓ = ±one row).

## Engine — single source of truth

`app/src/lib/engine/` owns the model. **The UI only renders and calls its actions — never reach around it.**

- `types.ts` — `Block { id, kind, turn, order, text, tokens, toolName?, callId?, override, autoFolded, by }`. Kinds: `user · text · thinking · tool_call · tool_result`
- `parse.ts` — pi / Claude Code JSONL → typed blocks. `tool_call` and `tool_result` are separate blocks sharing a `callId`. An assistant message's thinking/text/call blocks share an `id` prefix before `:`
- `store.svelte.ts` — `AccordionStore` (Svelte runes); exposed as `window.__store`. `appendBlocks(blocks)` is the streaming seam used by the live link to add new blocks. **Protected working tail** (`protectTokens`, default `20_000`): `protectedFromIndex` marks the first block in the tail; both auto- and manual-`fold()` are refused inside it; a block that was auto-folded before entering the tail heals back to live; `pin()` remains allowed. `setProtect(n)` resizes and re-folds, wired to an on-bar draggable handle. Under the `tail-size` involvement lock (ADR 0011), the tail floor is lifted — the conductor may fold any block
- `tokens.ts` — chars/4 estimate · `digest.ts` — what a kind collapses to when folded

**Folding is content substitution, never removal** — provider-safe and fully reversible.

**Agent self-unfold / recall.** Every folded block's digest is prefixed `{#<code> FOLDED}` (a short stateless hash of the block id; only foldable kinds — `text/thinking/tool_result` — are tagged). The extension registers two pi tools: `unfold` (agent passes codes; matching blocks become standing-open, sticky, provenance `"agent"`; the agent can only unfold a block that is actually folded — it cannot downgrade a human pin; lockable under `agent-unfold`) and `recall` (reads a folded block's content as a tool result without mutating the view — **never lockable**, analogous to `read_file`). See [ADR 0005](docs/adr/0005-agent-unfold.md).

## Live link

`app/src/lib/live/` + `extension/accordion.ts`. **GUI drives, extension is thin** — the extension streams pi's messages and applies whatever plan the app sends; it makes no folding decisions. Multi-session discovery (the Sessions list / switcher) is **desktop-only** — a plain browser can't read `~/.accordion/`.

**Browser-served mode.** The extension also HTTP-serves the SvelteKit build on the same ephemeral WS port. `/accordion` prints the browser URL; the page auto-connects to that one session — single-session, no desktop app needed. Static serving is token-gated; the WS stays unauthenticated so the Tauri app's tokenless dial is unaffected. Left rail is trimmed in browser mode (`browserServed` prop on `SessionsSidebar`). **Dev footgun:** a stale `extension/dist/client` shadows `../app/build` (resolve order prefers it) — delete `extension/dist` after any `build:client`.

**Shared contract** (dependency-free, no Svelte — imported by both sides):
- `protocol.ts` — wire messages (`hello / sync / plan`), `WireBlock`, `FoldOp`, `PROTOCOL_VERSION`
- `mapping.ts` — `linearize(messages)` and pure `applyPlan(messages, ops)`. `tool_call` is never folded — can never orphan its result
- `registry.ts` — `~/.accordion/` layout and session/focus shapes. **The Tauri Rust layer mirrors these constants — change them in lockstep**

**Invariants (don't break):**
- Discovery I/O is best-effort; **never blocks or alters a model call**
- No GUI / reply timeout / empty plan → messages pass through untouched
- No disk I/O on the `context` (pre-model-call) hook
- The completion relay (`completeRequest / completeResult`) runs out-of-band — **never on the `context` hook path** and never blocks the agent's own model call
- Folding the live agent is OPT-IN and OFF by default (`folding.enabled`, a header toggle)

**Known characteristic:** the view syncs on pi's `context` hook (fires *before* each model call) — an assistant reply is only visible at the *next* model call. One-turn lag; closing it is a planned follow-up.

**Claude Code browsing.** `list_claude_sessions` and `read_claude_session` are Rust commands — the JS `fs` plugin cannot reach `~/.claude` programmatically, so Rust owns that access. App side: `live/claude.ts` (type + guard) + `live/claudeDiscovery.svelte.ts` (3 s poll, CC tab only). CC sessions load through the engine normally but `session.readOnly` is set — `MapHeader` shows a READ-ONLY badge, and there is no wire to steer.

---

**RULE — preview/read-only is NOT a more permissive mode.**

Demo, preview, and read-only Claude Code sessions obey EVERY rule the steering path does — same foldability predicate, same UI affordances, same token accounting, same group/conductor constraints. The *only* difference from steering is that no plan is written to the agent's wire. The UI must **never** render a fold, group, or state that the steering path could not itself produce. Involvement locks are locked in every mode — "there's no agent on the other end" is a forbidden line of reasoning.

---

## Conductors

`conduct(view: ConductorView): Command[] | null` — the whole contract. `Command[]` = complete desired state (host resets to raw baseline and re-applies the batch); `[]` = clear to raw; `null` = hold last state. Accordion imposes no strategy of its own — no conductor attached = raw context. All conductors are first-party (this repo or a fork; no sandbox, no trust boundary). Folds from every conductor are attributed uniformly (`by:"auto"`).

**Contract:** `conductors/contract/conductor.ts` (in-process shapes: `ConductorView`, `Command` union, `Conductor`, `ConductorHost`) + `conductors/contract/protocol.ts` (WS wire shapes, which import the same types — one definition). Imported via `$conductors` alias.

**To add an in-process conductor:** drop a TS class in `conductors/<name>/`, register one line in `IN_PROCESS_CONDUCTORS` in `conductors/index.ts` — it appears in the header switcher. The host enforces one unconditional floor: **provider-validity** (the message stays sendable). The built-in (`conductors/builtin/builtin.ts`) is the minimal worked example; its output is pinned by a **golden test** (`conductor.builtin.test.ts`) — don't break it.

**Involvement locks ([ADR 0011](docs/adr/0011-conductor-involvement-locks.md)).** A conductor may lock up to three steering controls: `human-steering` (hand fold/unfold/pin/group/reset), `agent-unfold`, and `tail-size`. A conductor that locks none is *collaborative* (the default). An exclusive conductor requires a one-time consent gate. The human's recourse is always **detach** — freezes the current view in place and unlocks all controls (not reset-to-raw; individual folds remain human-reversible). **Four things are never lockable:** observation (map, log, budget readout), the budget dial, the agent's `recall` tool, and detach itself.

**Full references:** [conductors/README.md](conductors/README.md) — how to write one, worked examples, the full conductor catalog · [docs/conductor-protocol.md](docs/conductor-protocol.md) — ConductorView / ViewBlock / Command tables, WebSocket escape hatch, host capabilities.

## Visual grammar

Colors are brand **Spectrum** identity colors — defined in [brand/accordion-brand-kit/brand.md](brand/accordion-brand-kit/brand.md); CSS vars `--k-*` are in `app/src/app.css`. **Changing them means updating the brand, not just CSS.**

| kind | hex |
|------|-----|
| `user` | `#044EFF` |
| `text` (Smoke) | `#9A9A9A` |
| `thinking` | `#B480DF` |
| `tool_call` | `#21D4C1` |
| `tool_result` | `#E19C7D` |

**`#044EFF` blue is reserved for the user block kind — never a button, never UI chrome.** UI accent is always monochrome/neutral.

- **live = solid / folded = recessed** (dim + faint hatch, never a heavy dark hatch)
- Group and summary tiles are **monochrome recessed**: `--group #2C2C2C · --group-edge #4A4A4A · --group-accent #9A9A9A`
- Dark surfaces: `--bg #0A0A0A`, `--panel #1C1C1C` — no blue tint (blue is reserved for `user` blocks)
- Fonts: **IBM Plex Sans** (`--sans`) / **IBM Plex Mono** (`--mono`) via `@fontsource` in `routes/+layout.svelte`
- **Map grid:** every block is the same-size square in conversation order. Token weight = dice face 1–6. Thresholds in `ContextMap.svelte → faceFor()`: ≤100→1 · ≤500→2 · ≤1.5k→3 · ≤5k→4 · ≤15k→5 · >15k→6
- **Two-box layout:** grid splits at `store.protectedFromIndex` — foldable region above (thin border), protected tail below (thick accented border, `.box.prot`)

## Conventions

- **Svelte 5 runes:** `$state`, `$derived`, `$derived.by`, `$effect`, `$props`. `ssr = false`, adapter-static SPA. Vite port 1420
- **`{@const}` must be an immediate child of `{#if}` / `{#each}`** — otherwise use `$derived`
- **`svelte-ignore`** honors only the **first** code in a multi-code comment
- **No live gradients or `filter` on the 982-tile grid** — they re-rasterize on every repaint and tank interaction. Dice pips are one cached SVG data-URI per face; keep that pattern for anything tile-dense
- **Scroll perf:** `ContextMap` sets `class:scrolling` during scroll and clears it ~140 ms after stop, dropping `pointer-events: none` on the grid to kill hover repaints (that was the bottleneck, not culling). `.boxes` get `transform: translateZ(0)` for GPU layer promotion. Tile decorations must be **inset** — the selection ring is inset-only; outset shadows clip

## Running & verifying

```bash
cd app
npm run dev          # browser dev → http://localhost:1420 (UI only — no live discovery)
npm run tauri dev    # native desktop — REQUIRED for live session discovery
npm run check        # svelte-check — keep 0 errors / 0 warnings
npm run test         # vitest
```

```bash
cd extension && node smoke.mjs     # extension smoke test
cd app/src-tauri && cargo check    # Rust layer — run from PowerShell (see below)
```

**Windows gotchas:**
- **cargo is NOT on the Bash tool's PATH** — use PowerShell: `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:USERPROFILE\.rustup\bin;$env:PATH"`
- **Port 1420** is shared by `npm run dev` and `tauri dev` — only one at a time. Free it: `Get-NetTCPConnection -LocalPort 1420 | Stop-Process`
- **preview/screenshot MCP is flaky** — prefer `preview_eval` / `preview_inspect` for UI verification
- Always `npx svelte-check --tsconfig ./tsconfig.json` before declaring done

## Branching & PR workflow

**`devmain` is the active development branch.** It is the default base for all new work and the default PR target.

- **Branch from `devmain`** — start every feature, fix, or chore branch off the latest `origin/devmain`, not `main`.
- **PRs target `devmain`** — open pull requests against `devmain`, not `main`.
- **`devmain` is merged into `main` periodically** — `main` is a release/stable trunk; do not branch from or PR into it directly. Dev work accumulates on `devmain` and is promoted to `main` in batches.
- **Keep `devmain` green** — branches should be short-lived and rebased onto the latest `devmain` before merge.

## Post-merge routine

After a PR lands on `devmain` (and when `devmain` is periodically promoted to `main`): close any open Accordion window (the running binary locks the file), pull `main` on the registered checkout (`~/.pi/agent/settings.json → extensions`), run `npm install` inside `app/` if deps changed, rebuild with `npm run tauri build -- --no-bundle` (cargo must be on PATH). The next `/accordion` call picks up the new binary. If the extension changed, restart pi.

## Data & security

- Dev sample: `app/static/sample-session.jsonl` — a real ~130k-token / ~982-block pi session
- **This repo is public. Never commit real keys** — scan sample data before pushing (a live API key was once committed; it's now `REDACTED_API_KEY`)

## Working style

The owner reviews UI work by screenshot and makes the design calls. Surface tradeoffs plainly and let them decide.
