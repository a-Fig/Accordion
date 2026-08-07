# CLAUDE.md — Accordion

Guidance for AI coding sessions. [VISION.md](VISION.md) = product north star · [README.md](README.md) = short pitch.

## Key URLs

- **Marketing site:** https://get-accordion.dev/
- **Public repo:** https://github.com/a-Fig/Accordion

## Terminology

- **pi** — the CLI AI coding harness whose context window Accordion visualizes. Not an Accordion product; it's the tool the user runs. `extension/accordion.ts` is a pi plugin that hooks into pi's `context` hook (fires before each model call).
- **block** — atomic unit of context: one chunk of a single kind (`user`, `text`, `thinking`, `tool_call`, or `tool_result`). See `engine/types.ts → Block`.
- **turn** — one user message plus all assistant content (thinking, text, tool calls, tool results) that follows it before the next user message.
- **fold / folding** — replacing a block's content in-place with something shorter, like a summary; the block stays on the wire to the LLM in compressed form. Always reversible.
- **held** — a block carrying a human override (manual pin, fold, or unfold): a non-null `Block.override` (see `engine/types.ts → Block`). *(The `human-steering` involvement lock can now gate whether a human hold can be created — see the Conductors section; the ADR-0011 lock system is back as an engine capability, though nothing holds a lock yet.)*
- **conductor** — *(removed on this branch, pending a ground-up redesign)* a pluggable context-management strategy that decided which blocks to fold/group between turns. The strategy layer and its contract are gone; the fold/group engine it drove stays, now human-operated only. See the Conductors section.
- **the wire** — the messages array sent to the LLM provider. "Wire-valid" = the outgoing array is well-formed. Distinct from the WebSocket between the app and the pi extension (that's the live link / accordion protocol).
- **browser-served** — mode where the pi extension HTTP-serves the SvelteKit UI on the same ephemeral port as the WS. Multi-session-aware (the served extension lists every live session over `/__accordion/sessions`); no Tauri desktop app required.
- **CC** — Claude Code (as in "CC transcript", "CC browsing"). Read-only mode; sessions loaded from `~/.claude/projects/`.

## Codebase map

| path | what |
|------|------|
| `app/` | Tauri 2 + SvelteKit desktop app — the active surface |
| `app/src/lib/engine/` | The model: types, parser, store — single source of truth |
| `app/src/lib/live/` | WS client, session discovery, CC transcript browsing |
| `app/src-tauri/src/lib.rs` | Native Rust: session discovery + `~/.claude` reads |
| `extension/accordion.ts` | Live pi extension — WS server + HTTP server (browser-served mode) |
| `docs/` | ADRs + developer references |
| `brand/accordion-brand-kit/brand.md` | Brand colors + typography source of truth |

**App structure.** One route (`routes/+page.svelte`), the **Map** shell: `SessionsSidebar` (source switcher — live pi sessions or read-only Claude Code transcripts) + `MapHeader` (composition strip + budget) + `ContextMap` + `Inspector`. `ContextMap` has a 2-way toggle: **Map** (uniform dice-square grid) | **Transcript** (scrollable full-chat; blocks as cards, kind-colored left spine; live blocks show full text, folded blocks show the exact `{#code FOLDED}` digest the agent sees; double-click to fold, single click = inspect). Arrow keys traverse blocks (←/→ = prev/next, ↑/↓ = ±one row).

## Engine — single source of truth

`app/src/lib/engine/` owns the model. **The UI only renders and calls its actions — never reach around it.**

- `types.ts` — `Block { id, kind, turn, order, text, tokens, toolName?, callId?, override, autoFolded, by }`. Kinds: `user · text · thinking · tool_call · tool_result`
- `parse.ts` — pi / Claude Code JSONL → typed blocks. `tool_call` and `tool_result` are separate blocks sharing a `callId`. An assistant message's thinking/text/call blocks share an `id` prefix before `:`
- `store.svelte.ts` — `AccordionStore` (Svelte runes); exposed as `window.__store`. `appendBlocks(blocks)` is the streaming seam used by the live link to add new blocks. **Protected working tail** (`protectTokens`, default `20_000`): `protectedFromIndex` marks the first block in the tail; manual `fold()` is refused inside it, and a fold the tail later grows over heals back to live; `pin()` remains allowed. `setProtect(n)` resizes and re-folds, wired to an on-bar draggable handle
- `tokens.ts` — chars/4 estimate · `digest.ts` — what a kind collapses to when folded

**Folding is content substitution, never removal** — provider-safe and fully reversible.

**Agent self-unfold / recall.** Every folded block's digest is prefixed `{#<code> FOLDED}` (a short stateless hash of the block id; only foldable kinds — `text/thinking/tool_result` — are tagged). The extension registers two pi tools: `unfold` (agent passes codes; matching blocks become standing-open, sticky, provenance `"agent"`; the agent can only unfold a block that is actually folded — it cannot downgrade a human pin; lockable under `agent-unfold`) and `recall` (reads a folded block's content as a tool result without mutating the view — **never lockable**, analogous to `read_file`). See [ADR 0005](docs/adr/0005-agent-unfold.md).

## Live link

`app/src/lib/live/` + `extension/accordion.ts`. **GUI drives, extension is thin** — the extension streams pi's messages and applies whatever plan the app sends; it makes no folding decisions. Multi-session discovery (the Sessions list / switcher) works in both desktop and browser-served mode; only Claude Code transcript browsing (reading `~/.claude` off disk) is **desktop-only**, since that still needs the Tauri Rust layer.

**Browser-served mode.** The extension also HTTP-serves the SvelteKit build on the same ephemeral WS port. `/accordion` prints the browser URL; the page auto-connects to that session. A browser tab can't read `~/.accordion/` itself, but the extension process CAN (it's Node, not sandboxed) — so it exposes every live session's registry entry over `GET /__accordion/sessions` (token-gated, unlike the ungated `/__accordion/meta`), and the browser polls that endpoint the same way the desktop app polls `list_sessions` (`app/src/lib/live/browserDiscovery.svelte.ts`, feeding the same `discovery.sessions` state as `discovery.svelte.ts`). The result: one browser tab shows every pi session on the machine in the left rail and can switch between them (`connectLive` just dials a different session's port) — no desktop app required. `SessionsSidebar`'s `browserServed` prop now only hides the pi/Claude-Code source switcher, not the session list. The live link binds loopback (`127.0.0.1`) only, on an ephemeral port — a same-machine surface, no remote/off-loopback bind mode. Static serving is token-gated. WebSocket upgrades additionally enforce Origin/token authorization to prevent a hostile web page from hijacking loopback: native no-Origin clients and fixed Tauri origins are trusted; the served browser uses its explicit bearer or exact-origin cookie; and a cross-session dial is accepted only after the source Origin proves it is a live, registry-matching Accordion loopback server. `/__accordion/sessions` is token-gated (unlike the ungated `/meta`) since it reveals every session's cwd/title/model, not just this one — a deliberate, accepted tradeoff: a leaked token exposes every live session's port, not just the one it was minted for. The endpoint also opportunistically reaps stale registry files it encounters (a browser-only user has no desktop app ever running to do that cleanup). Known limitation: `browserDiscovery.svelte.ts`'s poll is pinned to whichever session's origin served the page — see that file's banner comment for the full rationale and the `connectedFallback()` mitigation. Resolve order is `extension/dist/client` first, then `../app/build`. In npm package installs `../app/build` does not exist, so `dist/client` is required. **Dev footgun:** a stale `extension/dist/client` shadows `../app/build` — delete `extension/dist` after any local `build:client` experiment when you want repo-dev fallback behavior.

## npm / pi package

`extension/` is also the npm package root for `@a-fig/accordion`, installed by users with:

```bash
pi install npm:@a-fig/accordion
```

`extension/package.json` is the package manifest. `pi.extensions` points at `./accordion.js`; `files` must include `accordion.js`, `dist`, `skills`, and `README.md`.

Generated package artifacts (do not edit by hand):

| artifact | source | purpose |
|---|---|---|
| `extension/accordion.js` | bundled from `extension/accordion.ts` by `build-extension.mjs` | pi extension entrypoint loaded from npm |
| `extension/dist/client/` | copied from `app/build` by `build-client.mjs` | browser-served Accordion UI for npm installs |
| `app/build/` | generated by SvelteKit `npm run build` in `app/` | source copied into `extension/dist/client` |

Package dependency rules:

- `ws` is a real runtime dependency and stays in `dependencies`.
- `typebox` and `@earendil-works/*` stay in `peerDependencies` with `"*"`; pi provides/aliases them at runtime.
- `build-extension.mjs` should externalize `ws`, `typebox`, and `@earendil-works/*` rather than bundling pi core packages.

Publishing / package verification:

```bash
cd extension
npm pack --dry-run
```

`npm pack` and `npm publish` run `prepack`, which must build the app, copy `app/build` to `extension/dist/client`, bundle `accordion.js`, and run `smoke.mjs`. Do not publish unless the dry-run tarball contains `accordion.js`, `dist/client/index.html`, `skills/accordion-context-folding/SKILL.md`, `skills/accordion-context-recall/SKILL.md`, `README.md`, and `package.json`. Remember that npm packages generated files from disk: stale `accordion.js` or `dist/client` means a stale public release even if source files are correct.

README surfaces:

- Root `README.md` is the GitHub/project README.
- `extension/README.md` is the npm package README shown on npmjs.com; use absolute GitHub image URLs there.
- If install instructions or package behavior change, update both surfaces where relevant.

**Shared contract** (dependency-free, no Svelte — imported by both sides):
- `protocol.ts` — wire messages (`hello / sync / plan`), `WireBlock`, `FoldOp`, `PROTOCOL_VERSION`
- `mapping.ts` — `linearize(messages)` and pure `applyPlan(messages, ops)`. `tool_call` is never folded — can never orphan its result
- `registry.ts` — `~/.accordion/` layout and session/focus shapes. **The Tauri Rust layer mirrors these constants — change them in lockstep**

**Invariants (don't break):**
- Discovery I/O is best-effort; **never blocks or alters a model call**
- No GUI / empty plan → messages pass through untouched; a reply timeout falls back to the last known plan when one is cached, else passes through raw (issue #58). Every `context` hook outcome is counted and acked to the GUI as a `passthrough` message (issue #60, ADR 0020) — see `/__accordion/meta`'s `planOutcomes`
- No disk I/O on the `context` (pre-model-call) hook
- The completion relay (`completeRequest / completeResult`) runs out-of-band — **never on the `context` hook path** and never blocks the agent's own model call
- Folding the live agent is OPT-IN and OFF by default (`folding.enabled`, a header toggle)

**Known characteristic:** the view syncs on pi's `context` hook (fires *before* each model call) — an assistant reply is only visible at the *next* model call. One-turn lag; closing it is a planned follow-up.

**Claude Code browsing.** `list_claude_sessions` and `read_claude_session` are Rust commands — the JS `fs` plugin cannot reach `~/.claude` programmatically, so Rust owns that access. App side: `live/claude.ts` (type + guard) + `live/claudeDiscovery.svelte.ts` (3 s poll, CC tab only). CC sessions load through the engine normally but `session.readOnly` is set — `MapHeader` shows a READ-ONLY badge, and there is no wire to steer.

---

**RULE — preview/read-only is NOT a more permissive mode.**

Demo, preview, and read-only Claude Code sessions obey EVERY rule the steering path does — same foldability predicate, same UI affordances, same token accounting, same group constraints. The *only* difference from steering is that no plan is written to the agent's wire. The UI must **never** render a fold, group, or state that the steering path could not itself produce.

---

## Conductors

**Removed on this branch, pending a ground-up redesign.** The entire conductor strategy layer and its contract were excised: the `conduct(view) → Command[]` interface, the in-process/remote conductor runners, the built-in folder, attach/detach/consent, the out-of-band completion relay, and the whole `conductors/` tree (contract included). The `$conductors` alias, `docs/conductor-protocol.md`, and `docs/conductor-plan.md` are gone too. Accordion currently ships **no automatic context strategy** — context is raw unless a human folds/groups it by hand.

**Involvement locks (ADR 0011) are RESTORED as an engine capability.** The `human-steering` / `agent-unfold` / `tail-size` lock vocabulary lives in `engine/locks.ts` (`LockName`, `LOCK_NAMES`, `LOCK_LABELS`, `hasLock`, `isExclusive`), and the store holds the lock state behind a clean programmatic API: `setLocks(locks, holder, tailTokens?)` acquires (releasing existing human/agent holds in the newly-locked domains, ADR-0011 consent→baseline) and `clearLocks()` releases (restoring human seniority). `isLocked(name)`, the `locks` getter, and `lockHolder` are the read surface. The engine re-gates every human steering mutator under `human-steering`, the agent's `unfold` under `agent-unfold`, and `setProtect` / the protected-tail walk-back under `tail-size`; `recall` and observation/budget are sacred and never gated. The UI mirrors the gating (disabled affordances + a "locked by …" tooltip) in every mode. **NOTHING holds a lock yet** — locks are set only programmatically by tests today; the conductor redesign's host will drive `setLocks`/`clearLocks` and reinstate the consent flow + kill-switch freeze-on-detach. See [ADR 0011](docs/adr/0011-conductor-involvement-locks.md).

**What stays (the fold/group/protect engine, unchanged):** human fold/unfold/pin/unpin/reset, multiblock groups + wire-accurate `groupWire` accounting, the protected working tail + healing, budget/context-window aggregates, digests, and the agent `unfold` / `recall` tools with their provenance. `Block.autoFolded` and the `"auto"` actor are kept as **dormant plumbing** for the auto-folder the redesign will reintroduce; nothing sets them today. The `docs/adr/` records are retained as design history.

## Visual grammar

Colors are brand **Spectrum** identity colors — defined in [brand/accordion-brand-kit/brand.md](brand/accordion-brand-kit/brand.md); CSS vars `--k-*` are in `app/src/app.css`. **Changing them means updating the brand, not just CSS.**

| kind | hex |
|------|-----|
| `user` | `#044EFF` |
| `text` | `#1AA6E8` |
| `thinking` | `#B480DF` |
| `tool_call` | `#21D4C1` |
| `tool_result` | `#E19C7D` |

**`#044EFF` blue is reserved for the user block kind — never a button, never UI chrome.** UI accent is always monochrome/neutral.

- **live = solid / folded = recessed** (dim + faint hatch, never a heavy dark hatch)
- Group tiles use the current chestnut group palette from `app/src/app.css`: `--group #7C5230 · --group-edge #0A0A0A · --group-accent #E8E8E8`. Summary/sliver tiles stay dark neutral via `--k-summary`.
- Dark surfaces: `--bg #0A0A0A`, `--panel #1C1C1C` — no blue tint (blue is reserved for `user` blocks)
- Fonts: **IBM Plex Sans** (`--sans`) / **IBM Plex Mono** (`--mono`) via `@fontsource` in `routes/+layout.svelte`
- **Map grid:** every block is the same-size square in conversation order. Token weight = dice face 1–6. Thresholds in `ContextMap.svelte → faceFor()`: ≤100→1 · ≤500→2 · ≤1.5k→3 · ≤5k→4 · ≤15k→5 · >15k→6
- **Two-box layout:** grid splits at `store.protectedFromIndex` — foldable region above (thin border), protected tail below (thick accented border, `.box.prot`)

## Pi extension hooks

Pi exposes these hooks through `pi.on(name, handler)`:

For lifecycle ordering, behavior, and examples, read pi's `docs/extensions.md`; for authoritative payload and return types, inspect the exported `ExtensionAPI` and `ExtensionEvent` types from `@earendil-works/pi-coding-agent`.

### Startup and resources

- **`project_trust`** — Fires before pi decides whether to trust a project and load its dynamic configuration, allowing user/global and CLI extensions to return and optionally persist a trust decision.
- **`resources_discover`** — Fires after `session_start` during startup or reload, allowing extensions to contribute additional skill, prompt, and theme paths.

### Sessions

- **`session_start`** — Fires when a session starts, reloads, resumes, or is created by a new-session or fork operation, identifying the reason and, for replacement flows, the previous session file.
- **`session_info_changed`** — Fires when the current session's display name is set or cleared.
- **`session_before_switch`** — Fires before `/new` or `/resume` replaces the current session and allows a handler to cancel the switch.
- **`session_before_fork`** — Fires before `/fork` or `/clone` creates a replacement session from an entry and allows a handler to cancel the operation.
- **`session_before_compact`** — Fires before manual, threshold, or overflow compaction and allows a handler to cancel compaction or supply a custom compaction result.
- **`session_compact`** — Fires after compaction is saved and reports the resulting compaction entry, trigger reason, and whether an extension supplied it.
- **`session_shutdown`** — Fires before a started session runtime is torn down by quit, reload, new session, resume, or fork so extensions can close session-scoped resources.
- **`session_before_tree`** — Fires before navigation to another point in the session tree and allows a handler to cancel navigation or customize the branch summary.
- **`session_tree`** — Fires after session-tree navigation and reports the old and new leaf IDs and any generated summary entry.

### Agent and provider calls

- **`before_agent_start`** — Fires after expanded user input is ready but before the agent loop starts, allowing a handler to inject a persistent custom message and replace the system prompt for that turn.
- **`agent_start`** — Fires when a low-level agent run begins.
- **`agent_end`** — Fires when a low-level agent run ends and includes that run's messages, although automatic retries, compaction retries, or queued continuations may still follow.
- **`agent_settled`** — Fires once pi has no automatic retry, compaction retry, or queued continuation left to process.
- **`turn_start`** — Fires at the start of each LLM turn and reports its index and timestamp.
- **`turn_end`** — Fires after each LLM turn and reports the finalized assistant message and tool results.
- **`context`** — Fires immediately before every LLM call with a deep copy of the messages destined for the model, allowing a handler to return a replacement message array without changing stored session history.
- **`before_provider_headers`** — Fires after request headers are assembled and before the provider call, allowing handlers to mutate them in place or remove a header by assigning `null`.
- **`before_provider_request`** — Fires after pi serializes the provider-specific request payload and immediately before sending it, allowing a handler to inspect or replace the payload.
- **`after_provider_response`** — Fires after the provider responds but before pi consumes the response stream, exposing the HTTP status and any available normalized response headers.

### Messages and tools

- **`message_start`** — Fires when a user, assistant, or tool-result message begins.
- **`message_update`** — Fires for streaming assistant-message updates and includes both the current message and token-level stream event.
- **`message_end`** — Fires when a user, assistant, or tool-result message is finalized, allowing a handler to replace it as long as its role is unchanged.
- **`tool_execution_start`** — Fires when tool execution begins and exposes the tool-call ID, tool name, and arguments.
- **`tool_execution_update`** — Fires when an executing tool publishes partial output and exposes the partial result alongside the original call information.
- **`tool_execution_end`** — Fires when tool execution finishes and reports the final result and error state.
- **`tool_call`** — Fires immediately before a tool executes, allowing a handler to mutate its input arguments in place or block execution with an optional reason.
- **`tool_result`** — Fires after a tool executes but before its final result events and message are emitted, allowing handlers to patch the result's content, details, or error state.

### User input and model settings

- **`input`** — Fires for raw user input after extension commands are checked but before skill and prompt-template expansion, allowing a handler to continue, transform, or fully handle the input.
- **`user_bash`** — Fires when the user runs a `!` or `!!` shell command, allowing a handler to provide a custom execution backend or return a complete replacement result.
- **`model_select`** — Fires when the active model changes through selection, cycling, or session restore and reports the new model, previous model, and change source.
- **`thinking_level_select`** — Fires as a notification-only event when the active thinking level changes, including changes caused by model capability clamping.

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

For live-link testing under `tauri dev`, launch the **pi process** with
`ACCORDION_ALLOW_TAURI_DEV_ORIGIN=1`. The Vite `http://localhost:1420` Origin is intentionally
not trusted by default; production Tauri custom-protocol origins do not need this opt-in.

```bash
cd extension && node smoke.mjs     # extension smoke test
cd extension && npm pack --dry-run # package readiness: app build → client copy → bundle → smoke → tarball listing
cd app/src-tauri && cargo check    # Rust layer — run from PowerShell (see below)
```

For package or browser-served UI changes, prefer `cd extension && npm pack --dry-run` over only `node smoke.mjs`: the dry run exercises the generated artifacts that npm users actually receive.

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

After a PR lands on `devmain` for local testing: close any open Accordion window (the running binary locks the file), pull `devmain` on the development checkout, run `npm install` inside `app/` or `extension/` if deps changed, and run the relevant verification above.

When `devmain` is promoted to `main` for the stable registered checkout (`~/.pi/agent/settings.json → extensions`): pull `main`, run `npm install` inside `app/` if deps changed, rebuild with `npm run tauri build -- --no-bundle` (cargo must be on PATH). The next `/accordion` call picks up the new binary. If the extension changed, restart pi.

When publishing a new npm package version: bump `extension/package.json`, run `cd extension && npm pack --dry-run`, inspect the tarball contents, then `npm publish`. After publish, smoke-test the user path with `pi install npm:@a-fig/accordion` in a fresh pi environment.

## Data & security

- Dev sample: `app/static/sample-session.jsonl` — a real ~130k-token / ~982-block pi session
- **This repo is public. Never commit real keys** — scan sample data before pushing (a live API key was once committed; it's now `REDACTED_API_KEY`)

## Working style

The owner reviews UI work by screenshot and makes the design calls. Surface tradeoffs plainly and let them decide.
