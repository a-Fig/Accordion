# CLAUDE.md — Accordion

Guidance for AI coding sessions. [VISION.md](VISION.md) = product north star · [README.md](README.md) = short pitch.

## Key URLs

- **Marketing site:** https://get-accordion.dev/
- **Public repo:** https://github.com/a-Fig/Accordion

## Terminology

- **pi** — the CLI AI coding harness whose context window Accordion visualizes. Not an Accordion product; it's the tool the user runs. `extension/accordion.ts` is a pi plugin that hooks into pi's `context` hook (fires before each model call).
- **block** — atomic unit of context: one chunk of a single kind (`user`, `text`, `thinking`, `tool_call`, or `tool_result`). See `core/types.ts → Block` (`app/src/lib/engine/types.ts` is a re-export shim).
- **turn** — one user message plus all assistant content (thinking, text, tool calls, tool results) that follows it before the next user message.
- **fold / folding** — replacing a block's content in-place with something shorter, like a summary; the block stays on the wire to the LLM in compressed form. Always reversible.
- **Truth** — `core/truth.ts`'s `Truth` class: the canonical, framework-free context state — block log, per-block overlay (`override`/`autoFolded`/`subst`/`by`), multiblock groups, the protected working tail, involvement locks, budget/context-window dials, and a monotonic `rev` that bumps on every change and rides every emitted `TruthEvent`. One instance lives **authoritatively inside the pi extension** per live session (ADR 0021); the app's Svelte store and any conductor are thin mirrors over it, never a second source of truth.
- **replica** — a `Truth` hydrated from a host's `snapshot` (`core/replica.ts → hydrateSnapshot`) and kept in lockstep by replaying `WireEvent`s; it asserts its `rev` matches the host's after every replay and requests a fresh `snapshot` on any mismatch rather than patching around a gap. The GUI is always a replica in live mode; a spawned conductor is a replica too (`core/conductor/remote.ts`).
- **held** — a block carrying a human override (manual pin, fold, or unfold): a non-null `Block.override`. Held state always wins over a strategy's proposed ops — the one exception is an involvement lock: while a conductor holds `human-steering`, the human steering mutators are refused outright (no override is ever created) until the lock releases or the conductor is detached (see **freeze**, below, and the Conductors section).
- **conductor** — a pluggable, *evented* context-management strategy (`core/conductor/contract.ts`'s frozen v2 `Conductor` interface) that attaches to a host, subscribes to `HostEvent`s (`blocks-appended`/`turn-committed`/`state-changed`/`wire-departing`/`resync`), and **proposes** diff-op transactions between turns rather than being polled every pass. Never a privileged write path — every proposed op is clamped by the exact same `Truth.apply` a human hand action or the agent's own tools go through. Four ship today: `compaction-naive`, `handoff`, `doorman` (in-process, bundled into the extension) and `thermocline` (out-of-process, spawned as its own Node process). See the Conductors section.
- **transaction / propose** — a conductor's unit of write: `host.propose({ baseRev, ops }): Promise<TxnResult>` (`core/conductor/contract.ts`). Async by contract — an in-process host applies the ops synchronously and resolves on a microtask; an out-of-process host resolves after a `propose`/`proposeResult` wire round trip. A conductor cannot tell the two hosts apart, which is the whole portability point.
- **birth-fold** — the exemption (ADR 0018, restored as [ADR 0023](docs/adr/0023-birth-fold-restored.md)) letting a strategy fold a block that sits inside the protected tail but has **never yet reached the model whole** (`Truth.canFold`'s `if (this.isProtected(b)) return !this.sent(b)` branch). Such a fold is tracked in `Truth`'s sticky `birthFolded` set so the tail growing over it later doesn't heal it back open. `doorman` is the shipped demonstration — it skeletonizes or folds a giant fresh `tool_result` before it ever rides the wire.
- **hold / `holdWireUpToMs`** — a conductor may declare `holdWireUpToMs` (ms, default 0) to ask the host to pause the departing wire briefly on the `wire-departing` event, giving it one last chance to `propose` a last-moment fold before the model call actually leaves. The hold ends when the conductor's wire-departing **handler settles** — in-process, the returned promise resolving/rejecting; a remote conductor sends a dedicated `holdRelease { holdId }` the instant its handler settles (protocol v14; the host correlates by the `holdId` it minted per hold and ignores a stale/unknown one). A `propose` never releases the hold, so a concurrent background-tick propose (e.g. thermocline's prepare epoch) can't race it out from under the handler. Bounded: a timeout releases the wire unchanged and counts against `holdTimeouts`. Surfaced live as `MapHeader`'s HOLD chip and in telemetry's `lastHoldMs`/`holdTimeouts`.
- **freeze** — the conductor-detach kill switch (`{ kind: "freeze" }`, `core/ops.ts`): converts every currently strategy-owned fold/group into a human-owned one (the substituted content preserved byte-identical) BEFORE the host releases the conductor's locks, so work an exclusive conductor did survives its own detach instead of reverting or vanishing.
- **the wire** — the messages array sent to the LLM provider. "Wire-valid" = the outgoing array is well-formed. Distinct from the WebSocket between the app and the pi extension (that's the live link / accordion protocol).
- **browser-served** — mode where the pi extension HTTP-serves the SvelteKit UI on the same ephemeral port as the WS. Multi-session-aware (the served extension lists every live session over `/__accordion/sessions`); no Tauri desktop app required.
- **CC** — Claude Code (as in "CC transcript", "CC browsing"). Read-only mode; sessions loaded from `~/.claude/projects/`.
- **controller / lease** — the global, machine-wide right to send mutating steering commands ([ADR 0024](docs/adr/0024-single-controller-and-stable-door.md), issue #66). Exactly one surface (a desktop app instance, a browser tab) holds it at a time, tracked as a `ControllerLease` blackboard at `~/.accordion/controller.json` (`app/src/lib/live/registry.ts`); every other connected surface is a live, strictly zero-write READ-ONLY mirror. Claiming (`claimController`) is silent when uncontested and never refused when contested — the human is always the authority, last write wins. Enforced at the extension's WS `command` ingress (a synthesized `"read-only"` `ClampReason`, never produced by `Truth.apply` itself), so conductor `propose` and the agent's own `unfold`/`recall` are completely unaffected.
- **door / surface** — the door is the fixed, well-known loopback port (`DOOR_PORT = 24317`, `core/protocol.ts`) exactly one extension binds at a time, as an *additional* listener alongside its own per-session ephemeral server, so `/accordion` can print one stable URL that survives any single session's death (first-bind-wins, automatic takeover on the holder's exit). A surface is a connecting client's persistent identity (a `localStorage` UUID + a human label like "Desktop app"/"Browser tab") — what the controller lease is actually granted to.
- **READ-ONLY** — the one term for "this view cannot write," covering two distinct situations: a Claude Code transcript (plain badge, no wire, no escape) and a live session currently steered from another surface (`READ-ONLY · <WHO> STEERS` chip + a `TAKE CONTROL` button). Both share the exact same guarantee (see the RULE below); "view-only" is deliberately never used as a second term for either.

## Codebase map

| path | what |
|------|------|
| `core/` | Framework-free shared model: `Truth` (canonical context state, `truth.ts`), the v16 wire protocol (`protocol.ts`), replica (de)serialization (`replica.ts`), agent unfold/recall resolution (`agentView.ts`). Imported by the extension (relative `../core`) and the app (`$core` alias) — no Svelte, no Node-only deps |
| `core/conductor/` | The conductor-v2 contract (`contract.ts`), the in-extension host (`liveHost.ts`), the shipped-conductor catalog (`registry.ts`), the out-of-process remote SDK (`remote.ts`), test scaffolding (`testhost.ts`, `hostAdapter.ts`, the `ViewConductor` adapter in `view.ts`) |
| `core/conductors/` | The three in-process shipped conductors — `compaction-naive/`, `handoff/`, `doorman/` — each with its own README |
| `conductors/thermocline/` | The one out-of-process shipped conductor: policy/epoch engine, Python attention probe, the spawned `runner.mjs`, and the committed `remote-sdk.mjs` bundle |
| `app/` | Tauri 2 + SvelteKit desktop app — the active surface |
| `app/src/lib/engine/` | App-side Svelte adapter over `core/truth.ts`: `store.svelte.ts` (reactive mirror), `parse.ts` (transcript → blocks), `display.ts` (grid render rows). `types.ts`/`tokens.ts`/`digest.ts`/`locks.ts` are re-export shims to `core/` |
| `app/src/lib/live/` | WS client (replica + remote control over protocol v16), session discovery, CC transcript browsing |
| `app/src-tauri/src/lib.rs` | Native Rust: session discovery + `~/.claude` reads |
| `extension/accordion.ts` | The live pi extension — hosts the authoritative `Truth` + `LiveConductorHost` per session, the WS server (roles `gui`/`conductor`), the HTTP server (browser-served mode), and (ADR 0024) the global controller-lease blackboard + the fixed-port door listener |
| `docs/` | ADRs + developer references |
| `brand/accordion-brand-kit/brand.md` | Brand colors + typography source of truth |

**App structure.** One route (`routes/+page.svelte`), the **Map** shell: `SessionsSidebar` (source switcher — live pi sessions or read-only Claude Code transcripts) + `MapHeader` (composition strip + budget + the conductor picker/consent gate + STATUS/LATENCY/HOLD telemetry chips) + `ContextMap` + `Inspector`. `ContextMap` has a 2-way toggle: **Map** (uniform dice-square grid) | **Transcript** (scrollable full-chat; blocks as cards, kind-colored left spine; live blocks show full text, folded blocks show the exact `{#code FOLDED}` digest the agent sees; double-click to fold, single click = inspect). Arrow keys traverse blocks (←/→ = prev/next, ↑/↓ = ±one row).

## Engine — single source of truth

`core/truth.ts`'s `Truth` class is the model — framework-free, dependency-free TypeScript, no Svelte. One instance runs **authoritatively inside the pi extension** per live session (ADR 0021); `app/src/lib/engine/store.svelte.ts`'s `AccordionStore` is a **thin reactive mirror** over it (Svelte runes, exposed as `window.__store`) — a local `Truth` for demo/CC/file sessions, a replica `Truth` fed by the wire in live mode. **The UI only renders and calls store actions — never reach around it, and the store itself never re-implements what `Truth` already decides.**

- `core/types.ts` — `Block { id, kind, turn, order, text, tokens, toolName?, callId?, override, autoFolded, by, subst }`. Kinds: `user · text · thinking · tool_call · tool_result`. (`app/src/lib/engine/types.ts` re-exports this.)
- `app/src/lib/engine/parse.ts` — pi / Claude Code JSONL → typed blocks (still app-side, unmoved). `tool_call` and `tool_result` are separate blocks sharing a `callId`. An assistant message's thinking/text/call blocks share an `id` prefix before `:`
- `core/truth.ts` — owns fold/unfold/pin/group/reset via the single write path `apply(ops, by, baseRev?)`, and the **protected working tail** (`protectTokens`, default `20_000`): `protectedFromIndex()` marks the first block in the tail; a human `fold()` is refused inside it (`canFold`), and a fold the tail later grows over heals back to live (`healProtected`) — **unless** it's a birth-fold (see Terminology), which healing skips because the model never saw it whole. `pin()` remains allowed anywhere. `setProtect(n)` resizes and re-folds; the store wires it to the on-bar draggable handle (or forwards it to the wire as a command in live mode)
- `core/tokens.ts` — chars/4 estimate · `core/digest.ts` — what a kind collapses to when folded, plus the `{#code FOLDED}` recovery tag
- `app/src/lib/engine/display.ts` — pure grid-row transform for `ContextMap` (collapsed / peek / unfolded group display states, ADR 0006 §3)

**Folding is content substitution, never removal** — provider-safe and fully reversible.

**Agent self-unfold / recall.** Every folded block's digest is prefixed `{#<code> FOLDED}` (a short stateless hash of the block id; only foldable kinds — `text/thinking/tool_result` — are tagged). `core/agentView.ts`'s `resolveUnfold`/`resolveRecall` resolve **locally against the authoritative Truth, in-process in the extension** (ADR 0021 §4) — no wire round trip, no GUI dependency, so both tools work even with zero clients connected. The extension registers two pi tools on top of them: `unfold` (agent passes codes; matching blocks become standing-open, sticky, provenance `"agent"`; the agent can only unfold a block that is actually folded — it cannot downgrade a human pin; lockable under `agent-unfold`) and `recall` (reads a folded block's content as a tool result without mutating the view — **never lockable**, analogous to `read_file`; broadcasts a non-mutating `RecallObservationMessage` so an attached client/conductor can observe the read). See [ADR 0005](docs/adr/0005-agent-unfold.md).

## Live link

`app/src/lib/live/` + `extension/accordion.ts`, over `core/protocol.ts` (protocol **v16**; app code imports `$core/protocol` directly). **The extension is authoritative, the client is a replica + remote control** (ADR 0021) — the inverse of the pre-Phase-B "GUI drives" model. The extension hosts one `Truth` per live session, and pi's `context` hook is a **local, synchronous, sub-millisecond** operation against it: no IPC, no round trip, no timeout to tune. `message_end` appends each finished assistant/tool message to the Truth **immediately** — the old one-turn view lag is gone; `agent_end` reconciles the full array as a backstop for anything `message_end` missed.

A connecting client declares a **role** (`?role=gui`, the default, or `?role=conductor`) and, for a `gui` socket, a sanitized surface identity (`?surface`/`?label` — see **controller** in Terminology). It receives `hello` (protocol version, session meta, the host's advertised conductor catalog, and the current global **controller** lease, if any) → a full `snapshot` (a rev-stamped `SnapshotState` the client builds a rev-aligned replica `Truth` from) → a stream of `event` messages (replayable `WireEvent`s — `appended`/`ops`/`config`/`locks`/`sent`/`reset` — each stamped with the host's post-mutation `rev`). The client replays each event through its own replica and asserts a matching `rev`; a mismatch (or a `reset` event) triggers a `resnapshot` request rather than patching around the gap. Human steering (fold/unfold/pin/setBudget/setProtect/the folding arm/`selectConductor`) is sent as a `command`; the host applies it to the authoritative Truth (which emits the resulting events to **every** connected client, including the sender) and replies `commandResult` for clamp UX only — **there is no optimistic apply**, the replica only ever moves via the echoed event. A mutating `command` from a `gui` socket that is not the current fresh controller (ADR 0024) is refused before it touches the Truth at all (`commandResult.refused: "read-only"`) — `claimController` and `resnapshot` are the two client messages exempt from that gate.

**Conductor sockets.** An in-process conductor (`compaction-naive`/`handoff`/`doorman`) runs directly inside `LiveConductorHost` (`core/conductor/liveHost.ts`) — no socket involved. The one out-of-process conductor, `thermocline`, is spawned as its own Node process (`node conductors/thermocline/runner.mjs`) and dials back in as an ordinary WebSocket client at `?role=conductor&token=<single-use>` — the token is minted once per attach and consumed on first use; **role confers no privilege on its own**, only that token does (a stray client guessing `?role=conductor` gets nothing without it). A `conductor`-role client additionally receives `wireDeparting` (the bounded hold window, carrying a `holdId` — see **hold** in Terminology) and `turnCommitted`, and sends `propose`/`completeRequest`/`setConductorStatus`/`holdRelease`/`cancelComplete` in place of a GUI's plain `command`s (`holdRelease { holdId }` ends a wire-departing hold on handler-settle; `cancelComplete { reqId }` forwards a `complete()` abort so the host stops the in-flight model call).

**Single controller + the stable door** ([ADR 0024](docs/adr/0024-single-controller-and-stable-door.md), issue #66). Exactly one surface controls machine-wide across every live session at a time — the **controller** lease — tracked in `~/.accordion/controller.json` (atomic write-rename, ~2s heartbeat from whichever extension the controlling surface is connected to, ~1s mtime poll for every other extension to observe a change, 6s staleness window). A connecting surface auto-claims silently when uncontested; taking control from another fresh holder is never refused (last write wins) but is fronted by a one-time confirmation on the client. Every non-controller `gui` socket is a strict zero-write READ-ONLY mirror — see **READ-ONLY** in Terminology. Separately, `/accordion` now prints a stable URL by default: one extension at a time binds the **door**, a fixed loopback port (`DOOR_PORT = 24317` — deliberately not 4317, the standard OTLP/gRPC collector port) as an *additional* listener beside its own per-session ephemeral server, with first-bind-wins claiming and automatic takeover when the holder's process exits. Every extension accepts a shared bearer secret (`~/.accordion/door-secret`, created once via exclusive-create — **not** write-rename, since it must stay byte-stable once cached rather than be replaced on change) wherever a per-session `webToken` is already accepted, which is what makes the door URL session-independent; the security posture is unchanged (same-user local processes could already read this data, hostile web pages still cannot read files, and the Origin/token WS-upgrade gate is untouched).

Multi-session discovery (the Sessions list / switcher) works in both desktop and browser-served mode; only Claude Code transcript browsing (reading `~/.claude` off disk) is **desktop-only**, since that still needs the Tauri Rust layer.

**Telemetry.** `hookCount`/`lastHookMs`/`maxHookMs`/`p95HookMs`/`rebuilds`/`hookErrors`/`foldingEnabled` are surfaced over the ungated `GET /__accordion/meta` HTTP endpoint; the WS `telemetry` message streamed after every hook additionally carries `lastHoldMs`/`holdTimeouts` (the attached conductor's most recent wire-departing hold, and how many times that hold has timed out this connection). `MapHeader`'s LATENCY badge re-keys its amber (≥250ms) / red (≥1000ms) thresholds off `lastHookMs − lastHoldMs` (a declared hold isn't a slow hook), with its own neutral HOLD chip (no amber/red tint) showing the hold separately. `rebuilds` counts structural-divergence Truth rebuilds (tree-nav, compaction, another extension rewriting `event.messages`) — `Truth.rebuildFrom` carries over every surviving block's overlay, `birthFolded` membership, and the scalar dials, so a rebuild never silently drops a human's fold state or budget/protect settings (ADR 0021 §5). `hookErrors` should stay 0: any throw inside the hook is caught and falls back to passthrough rather than breaking the model call.

**Browser-served mode.** The extension also HTTP-serves the SvelteKit build on the same ephemeral WS port. `/accordion` prints the browser URL; the page auto-connects to that session. A browser tab can't read `~/.accordion/` itself, but the extension process CAN (it's Node, not sandboxed) — so it exposes every live session's registry entry over `GET /__accordion/sessions` (token-gated, unlike the ungated `/__accordion/meta`), and the browser polls that endpoint the same way the desktop app polls `list_sessions` (`app/src/lib/live/browserDiscovery.svelte.ts`, feeding the same `discovery.sessions` state as `discovery.svelte.ts`). The result: one browser tab shows every pi session on the machine in the left rail and can switch between them (`connectLive` just dials a different session's port) — no desktop app required. `SessionsSidebar`'s `browserServed` prop now only hides the pi/Claude-Code source switcher, not the session list. The live link binds loopback (`127.0.0.1`) only, on an ephemeral port — a same-machine surface, no remote/off-loopback bind mode. Static serving is token-gated. WebSocket upgrades additionally enforce Origin/token authorization to prevent a hostile web page from hijacking loopback: native no-Origin clients and fixed Tauri origins are trusted; the served browser uses its explicit bearer or exact-origin cookie; and a cross-session dial is accepted only after the source Origin proves it is a live, registry-matching Accordion loopback server. `/__accordion/sessions` is token-gated (unlike the ungated `/meta`) since it reveals every session's cwd/title/model, not just this one — a deliberate, accepted tradeoff: a leaked token exposes every live session's port, not just the one it was minted for. The endpoint also opportunistically reaps stale registry files it encounters (a browser-only user has no desktop app ever running to do that cleanup). Known limitation, narrowed by the door (ADR 0024): `browserDiscovery.svelte.ts`'s poll is a relative fetch, so it targets whichever origin served the page — for a page served via the **door**'s stable URL (the default `/accordion` output whenever a door is up), that origin now survives any *single* session's extension exiting, since another extension takes over the fixed port within a few seconds and serves the identical `/__accordion/sessions` handler; the old failure mode (polling goes permanently silent once the serving session dies) only still applies to a page reached through a specific session's own per-session ephemeral URL (manual connect, or the door-occupied-by-foreign-software fallback). See that file's banner comment for the full poll-failure-handling rationale and the `localFallback()` mitigation, which is unaffected by the door either way. Resolve order is `extension/dist/client` first, then `../app/build`. In npm package installs `../app/build` does not exist, so `dist/client` is required. **Dev footgun:** a stale `extension/dist/client` shadows `../app/build` — delete `extension/dist` after any local `build:client` experiment when you want repo-dev fallback behavior.

## npm / pi package

`extension/` is also the npm package root for `@a-fig/accordion`, installed by users with:

```bash
pi install npm:@a-fig/accordion
```

`extension/package.json` is the package manifest. `pi.extensions` points at `./accordion.js`; `files` must include `accordion.js`, `dist`, `skills`, and `README.md`.

Generated package artifacts (do not edit by hand):

| artifact | source | purpose | tracked in git? |
|---|---|---|---|
| `extension/accordion.js` | bundled from `extension/accordion.ts` by `build-extension.mjs` | pi extension entrypoint loaded from npm | **no** — gitignored (`extension/.gitignore`) |
| `extension/dist/client/` | copied from `app/build` by `build-client.mjs` | browser-served Accordion UI for npm installs | **no** — gitignored (root `.gitignore`'s `dist/`) |
| `app/build/` | generated by SvelteKit `npm run build` in `app/` | source copied into `extension/dist/client` | **no** — gitignored |
| `conductors/thermocline/remote-sdk.mjs` | bundled from `core/conductor/remote.ts` + `thermocline.ts` (+ their `core/` graph) by `build-remote-sdk.mjs` | the out-of-process conductor SDK the thermocline runner imports | **yes** — committed |

`remote-sdk.mjs` is the one generated artifact that IS committed: `conductors/thermocline/` ships with the repo/desktop build, not with the npm package (the tarball's `files` list below has no `conductors/` entry), so the bundle has to already exist on disk rather than being produced by `npm run build`/`prepack`. Regenerate it by hand after touching `core/conductor/remote.ts`, `thermocline.ts`, or their `core/` graph — see the Conductors section.

Package dependency rules:

- `ws` is a real runtime dependency and stays in `dependencies`.
- `typebox` and `@earendil-works/*` stay in `peerDependencies` with `"*"`; pi provides/aliases them at runtime.
- `build-extension.mjs` should externalize `ws`, `typebox`, and `@earendil-works/*` rather than bundling pi core packages.

Publishing / package verification:

```bash
cd extension
npm pack --dry-run
```

`npm pack` and `npm publish` run `prepack`, which must build the app, copy `app/build` to `extension/dist/client`, bundle `accordion.js`, and run the smoke suite (`npm run smoke` = `smoke.mjs` + `smoke-conductor.mjs`, the real out-of-process conductor spawn e2e). Do not publish unless the dry-run tarball contains `accordion.js`, `dist/client/index.html`, `skills/accordion-context-folding/SKILL.md`, `skills/accordion-context-recall/SKILL.md`, `README.md`, and `package.json` — deliberately no `conductors/` directory (thermocline is not part of the npm surface; `files` above has no `conductors` entry — see the Conductors section). Remember that npm packages generated files from disk: stale `accordion.js` or `dist/client` means a stale public release even if source files are correct.

README surfaces:

- Root `README.md` is the GitHub/project README.
- `extension/README.md` is the npm package README shown on npmjs.com; use absolute GitHub image URLs there.
- If install instructions or package behavior change, update both surfaces where relevant.

**Shared contract** (dependency-free, no Svelte — imported by both sides):
- `core/protocol.ts` — the v16 wire messages (`hello`/`snapshot`/`event`/`telemetry`/`commandResult`/`stream`/`conductorState`/`conductorStatus`/`wireDeparting`/`turnCommitted`/`proposeResult`/`completeResult`/`controller` server→client; `command`/`resnapshot`/`propose`/`completeRequest`/`setConductorStatus`/`holdRelease`/`cancelComplete`/`claimController` client→server), `WireBlock`, `FoldOp`/`GroupOp`, `PROTOCOL_VERSION`, `DOOR_PORT`, and the `sanitizeCommand`/`sanitizeOps`/`sanitizeSurfaceId`/`sanitizeSurfaceLabel` ingress validators (v15 added `SnapshotState.carriedSent` — per-id sent-state carried across rebuilds — and per-id `OpResult.perId` outcomes so replicas replay only the ids that actually applied; v16 added the `controller` lease field on `hello`, `claimController`/`controller`, and `CommandResultMessage.refused: "read-only"` — see [ADR 0024](docs/adr/0024-single-controller-and-stable-door.md))
- `core/wire.ts` — `linearize(messages)` and pure `applyPlan(messages, ops)`. `tool_call` is never folded — can never orphan its result. The role-validity floor (`computeDegradedDropRuns`) degrades any drop that would produce a leading non-user or same-role-adjacent wire to a tagged recap; `Truth`'s accounting consumes the same function so the readout can't diverge from the wire
- `app/src/lib/live/registry.ts` — the **session-discovery** registry: `~/.accordion/` layout and session/focus shapes, plus (ADR 0024) `ControllerLease`/`CONTROLLER_FILE`/`DOOR_SECRET_FILE`/`CONTROLLER_STALE_AFTER_MS`. Not to be confused with `core/conductor/registry.ts` (the conductor catalog) — same filename, two unrelated files. **The Tauri Rust layer mirrors `SESSIONS_SUBDIR`/`FOCUS_FILE` and their constants — change those in lockstep.** `CONTROLLER_FILE`/`DOOR_SECRET_FILE` deliberately have **no** Rust mirror: the controller lease reaches every client over the WS (not read by Tauri directly), and the door secret is used only by the Node extension.

**Invariants (don't break):**
- Discovery I/O is best-effort; **never blocks or alters a model call**
- The `context` hook is a **local, synchronous, no-IPC** operation against the extension's own authoritative Truth (ADR 0021) — no GUI round trip, no timeout, no cached-plan fallback (that whole machinery, plan-outcome taxonomy included, was retired wholesale). Passthrough is gated **only** on `foldingEnabled` — the Truth is built and maintained regardless of whether any client is connected, and fold/pin/group/budget/protect state persists across a client disconnect exactly as it does across a reconnect; folding disabled → messages pass through untouched, folding enabled → the hook serializes the wire from whatever the Truth currently holds, with or without a client attached. Every hook is counted and timed; see `/__accordion/meta`'s `telemetry` (`hookCount`/`lastHookMs`/`maxHookMs`/`p95HookMs`/`rebuilds`/`hookErrors`)
- No disk I/O on the `context` (pre-model-call) hook
- The completion relay (`completeRequest` / `completeResult`) runs out-of-band — **never on the `context` hook path** — and never blocks the agent's own model call
- Folding the live agent is OPT-IN and OFF by default (`folding.enabled`, a header toggle)

**The one-turn view lag is gone.** `message_end` streams a finished assistant/tool message into the Truth the instant it exists, not at the next `context` hook (ADR 0021).

**Claude Code browsing.** `list_claude_sessions` and `read_claude_session` are Rust commands — the JS `fs` plugin cannot reach `~/.claude` programmatically, so Rust owns that access. App side: `live/claude.ts` (type + guard) + `live/claudeDiscovery.svelte.ts` (3 s poll, CC tab only). CC sessions load through the engine normally but `session.readOnly` is set — `MapHeader` shows a READ-ONLY badge, and there is no wire to steer.

---

**RULE — preview/read-only is NOT a more permissive mode.**

Demo, preview, and read-only Claude Code sessions obey EVERY rule the steering path does — same foldability predicate, same UI affordances, same token accounting, same group constraints. The *only* difference from steering is that no plan is written to the agent's wire. The UI must **never** render a fold, group, or state that the steering path could not itself produce.

---

## Conductors

**Redesigned and shipped on this branch** ([ADR 0022](docs/adr/0022-conductor-contract-v2.md)) — a ground-up rebuild of the strategy layer excised earlier, now built directly on the Phase B `Truth`/wire architecture ([ADR 0021](docs/adr/0021-truth-in-the-extension.md)) instead of the old GUI-side, per-turn `conduct(view) → Command[]` round trip.

**The contract** (`core/conductor/contract.ts`, frozen v2). A `Conductor` is `{ id, label, description?, locks?, tailTokens?, holdWireUpToMs?, attach(host), detach() }` — resident and evented, not polled: it subscribes to `host.on(fn)` for `HostEvent`s (`blocks-appended`/`turn-committed`/`state-changed`/`wire-departing`/`resync`) and reacts by `await`ing `host.propose({ baseRev, ops }): Promise<TxnResult>` whenever it has something to say. `ops` is the same `core/ops.ts` vocabulary (`fold`/`unfold`/`pin`/`unpin`/`auto`/`replace`/`group`/`ungroup`/`foldGroup`/`unfoldGroup`/`resetAll`) a human hand action or the agent's tools use — `propose` forwards straight to `Truth.apply(ops, "auto", baseRev)`, so a conductor is clamped by exactly the same predicate (`canFold`, the protected-tail check, the human-override check, the birth-fold exemption) and can never write with more authority than a human. `ConductorHost` also exposes `get`/`blocks`/`groups`/`textOf`/`stats`/`countTokens`/`digestOf`/`complete` (an out-of-band model call, never on a hot path) and `setStatus` (display-only). `core/conductor/view.ts`'s `ViewConductor` is a thin adapter that reintroduces the old `conduct(view) → Command[] | null` per-pass authoring shape on top of the new contract, for a strategy that doesn't need the finer-grained event stream.

**The host.** `LiveConductorHost` (`core/conductor/liveHost.ts`) lives inside `extension/accordion.ts` and is the only thing that ever attaches a conductor to a live session. `select(id)` (the `selectConductor` wire command) detaches whatever is currently attached (freeze → `clearLocks` → teardown), then — for the new pick — **eagerly acquires its declared `locks`** (`Truth.setLocks(entry.locks, entry.label, entry.tailTokens)`, ADR 0011 consent→baseline) before instantiating an in-process conductor (`create()` + `attach(this)`) or spawning an out-of-process one (mint a single-use token, launch the runner, arm a 10s pending-attach timeout). `core/conductor/registry.ts`'s `ENTRIES` is the single catalog the host and the GUI's `hello.conductors` both read from — in-process entries source their `locks`/`tailTokens`/`holdWireUpToMs` straight off a sample instance so the catalog can never drift from what the conductor actually declares; `thermocline`'s metadata is mirrored by hand (its class can't be imported extension-side without pulling in its Python-probe spawn) and kept in lockstep by a comment in `registry.ts`.

**The four shipped conductors:**

- **`compaction-naive`** (`core/conductors/compaction-naive/`) — a deliberately-lossy LLM-summarization foil (ADR 0014): past 90% of budget, summarizes the aged region into one literal, non-recoverable summary group; recursive on later passes. Locks `human-steering`/`agent-unfold`.
- **`handoff`** (`core/conductors/handoff/`) — simulates a manual handoff (ADR 0017): writes a real handoff document via an out-of-band model call, folds the whole prior session into one untagged group, and keeps a zero-token protected tail (`tailTokens: 0`) so nothing but the handoff plus new work is ever visible. Locks all three (`human-steering`/`agent-unfold`/`tail-size`).
- **`doorman`** (`core/conductors/doorman/`) — the birth-fold demonstration: a raw (non-`ViewConductor`) `Conductor` subscribing directly to `wire-departing` (`holdWireUpToMs: 150`) that skeletonizes or folds a giant fresh `tool_result` before it ever reaches the model, one turn after it lands. Declares no locks — fully collaborative.
- **`thermocline`** (`conductors/thermocline/`) — attention-gated, LLM-quality compression under a hard budget invariant: a Python attention-probe temperature signal (age-based fallback if the probe is unavailable) orders what to compress; a deterministic HOLD/PREPARE/COMMIT/EMERGENCY epoch machine with a cheapest-first budget ladder guarantees the session never exceeds budget. Locks `human-steering` only (`agent-unfold` stays free — the agent's own unfold is one of its graduation gates). **Runs out of process**: the extension spawns `node conductors/thermocline/runner.mjs`, which imports the committed `remote-sdk.mjs` bundle and dials back in as `?role=conductor&token=<single-use>`. Regenerate the bundle after touching `core/conductor/remote.ts`, `thermocline.ts`, or their `core/` graph:
  ```bash
  node extension/build-remote-sdk.mjs        # or: npm --prefix extension run build:remote-sdk
  ```
  `remote-sdk.mjs` is a **committed, repo-checkout-only** artifact (not in the npm tarball — see the npm package section) that dials with Node 22's global `WebSocket`, no `node_modules` required to run the runner itself.

**Locks, consent, and freeze.** The `human-steering`/`agent-unfold`/`tail-size` vocabulary (`core/locks.ts`, ADR 0011) is applied **eagerly** the instant a conductor attaches — `LiveConductorHost.select` calls `Truth.setLocks` before the conductor's own `attach`/spawn even starts. On the GUI side, picking a **collaborative** (lock-free) conductor sends `selectConductor` immediately; picking an **exclusive** one first opens `ConsentDialog` (client-side, `app/src/lib/ui/map/ConsentDialog.svelte`, driven by `ConductorMenu.svelte`) — a lock table showing which of the three steering controls the conductor takes over vs. leaves to the human, plus the sacred tier (observation, budget, `recall`, detach) that is never lockable — and only sends `selectConductor` on Confirm. Detaching (picking "None", or the runner exiting/crashing) runs the **freeze** kill switch first: every currently strategy-owned fold/group becomes human-owned (substitution preserved byte-identical) before `clearLocks()` releases the controls, so an exclusive conductor's work outlives its own detachment.

**Invariants (don't break):**
- Folding the live agent is OPT-IN and OFF by default (`folding.enabled`, the header toggle) — a conductor being attached does not change this.
- No disk I/O on the `context` (pre-model-call) hook — a conductor's own I/O (an LLM call, the attention probe) always happens off that path (`host.complete`, the probe's own child process).
- **No conductor attached is not a special code path** — it just means no strategy is proposing ops; `serializeWire` folds whatever the current Truth state says (human folds included) exactly the same way whether or not a conductor is attached.
- **Role confers no privilege.** A `?role=conductor` socket is authorized *solely* by the single-use token minted for that specific spawn; a message from any socket other than the currently-accepted one is ignored regardless of the role it claims.

`docs/adr/` retains the pre-redesign strategy layer's design history (0007–0020). Several describe designs the new contract absorbed rather than replaced: 0010's attention probe and 0014's naive-compaction design are the two lineages `thermocline` synthesizes; 0013's `ConductorHost.complete` pattern, 0016's code-skeleton compression, and 0017's handoff conductor were ported onto the v2 contract close to verbatim (only the transport/lifecycle — per-turn full-recompute, GUI-side hosting — is superseded). 0011 (involvement locks) was never removed. 0018 (birth-fold) and 0019 (conductor recall) were excised in the same simplification pass as the rest of the old layer; 0018 is restored here as [ADR 0023](docs/adr/0023-birth-fold-restored.md), 0019 remains deliberately deferred (issue #78). 0020 (plan-applied-ack) is retired wholesale by [ADR 0021](docs/adr/0021-truth-in-the-extension.md). [ADR 0021](docs/adr/0021-truth-in-the-extension.md) / [0022](docs/adr/0022-conductor-contract-v2.md) / [0023](docs/adr/0023-birth-fold-restored.md) cover this redesign itself.

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
cd extension && node smoke.mjs              # extension smoke test
cd extension && node smoke-conductor.mjs    # real out-of-process conductor spawn e2e (thermocline)
cd extension && npm pack --dry-run          # package readiness: app build → client copy → bundle → smoke (both above) → tarball listing
cd app/src-tauri && cargo check              # Rust layer — run from PowerShell (see below)
```

For package or browser-served UI changes, prefer `cd extension && npm pack --dry-run` over only `node smoke.mjs`: the dry run exercises the generated artifacts that npm users actually receive, and its `prepack` step runs both smoke scripts anyway (`npm run smoke`).

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
