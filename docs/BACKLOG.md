# Backlog

Parked ideas with enough context to pick up cold. Newest first.

## View ↔ wire unification — stricter "single source" finish (deferred 2026-06-16)

**Pointer, not the work.** Full design in
[docs/view-wire-unification.md](view-wire-unification.md).

The UI could lie: "what is folded" was computed twice (the store/view vs. the wire), with
different rules, so the screen could show a fold the agent never received (e.g. folding a
`tool_call`). The **near-term fix (Option A — one shared foldability predicate) and the
alarm** are being done now. **Deferred here is Option C — the single-source projection**:
make the wire projection the only place folded-state exists, so the store becomes a thin
view over it and divergence is *unrepresentable* rather than merely prevented.

**Do C only on a trigger:** the alarm actually fires in real use (proving the shared
predicate alone wasn't enough), OR the render layer is being reworked for another reason and
C can be folded in cheaply. Wide blast radius (every `isFolded`/`effTokens`/`digestOf` reader
across `ContextMap`/`MapHeader`/`Inspector`/transcript). A is the first half of C, so C lands
as a mechanical render-layer migration on top of an already-unified predicate. See the design
doc for specifics.

## Public launch: official website, installer flow, and pi extension distribution (pinned 2026-06-09)

**Goal:** bring Accordion from a local/dev tool to a polished public product that other pi
users can discover, install, understand, and use for their own sessions.

**Product outcome:** a user should be able to land on an official Accordion website,
understand what the app does, install the desktop app, install/enable the pi extension,
run `/accordion`, and see their own pi session live in the app without needing repo
knowledge.

**Scope:**

- **Official website**
  - Build a public landing/docs site for Accordion.
  - Explain the core idea: visual context map, folding, protected tail, live pi
    integration, read-only transcript browsing, and the unfold flow.
  - Include screenshots/GIFs/video of:
    - `/accordion` opening the app;
    - session sidebar;
    - context map;
    - folding/unfolding;
    - saved transcript browsing.
  - Provide clear install/setup instructions.
  - Include troubleshooting for:
    - app does not launch;
    - extension not loaded;
    - no live sessions visible;
    - Windows path/installer issues;
    - `ACCORDION_APP_PATH` / `--accordion-app`.

- **Installable desktop app**
  - Finalize release builds/installers for Windows first.
  - Verify installed executable layout matches `/accordion` launcher defaults.
  - Decide whether app binary should be `Accordion.exe` instead of `app.exe`.
  - Add signing/notarization plan as needed for public trust.
  - Define release artifact naming/versioning.

- **pi extension distribution**
  - Package the Accordion pi extension so users can install it as a pi extension/package,
    not by cloning the repo and manually pointing at `extension/accordion.ts`.
  - Document the install command and settings entry.
  - Decide whether app/extension protocol compatibility should be checked at runtime.
  - Make `/accordion` the primary affordance after install.

- **First-run/user onboarding**
  - If the app opens with no sessions, explain:
    - “Run `/accordion` inside pi.”
    - “Make sure the Accordion extension is installed/enabled.”
  - If the extension runs but the app is not installed/found, show actionable setup
    instructions.
  - Consider an in-app setup checklist.

- **Release/readiness polish**
  - Update README to point users to the website.
  - Add a changelog/release-notes path.
  - Confirm current app/extension protocol versioning is documented.
  - Add a smoke test or manual release checklist for:
    - fresh install;
    - `/accordion` launch;
    - single-instance focus;
    - live session attach;
    - fold/unfold round-trip;
    - saved transcript browsing.

**Likely sequence:**

1. Define public positioning and install story.
2. Stabilize Windows installer/output names.
3. Package/distribute the pi extension.
4. Build the website.
5. Add screenshots/demo assets.
6. Run fresh-machine install smoke.
7. Publish first public release.

**Open questions:**

- Is the website static docs/landing only, or should it also host downloads/releases?
- Where should binaries be hosted first: GitHub Releases, the website, or both?
- Should the public brand be “Accordion for pi” or just “Accordion”?
- Should app and extension ship together as one release, or be separately versioned?
- What is the minimum supported pi version?
- Do we want telemetry/update checks, or fully manual releases for now?

**Non-goals for first public launch:**

- Cloud sync.
- Hosted sessions.
- Multi-machine live attach.
- Browser-only runtime.
- Full macOS/Linux installer polish unless explicitly prioritized.

## Follow-up: harden `/accordion` app launch beyond Windows-first defaults (pinned 2026-06-08)

**Status:** the core one-step behavior is implemented: `/accordion` writes the existing
focus request, best-effort launches/reinvokes the Tauri desktop app when detached, and
the app uses single-instance behavior to focus an existing window instead of duplicating
it. The focus file remains the only session handoff, so the pull model is intact.

**Remaining follow-ups:**
- verify packaged Windows install paths once the installer name/layout is finalized;
- consider macOS/Linux default path searches if/when those builds are distributed;
- add deeper unit coverage for launcher path precedence and spawn-error reporting if the
  launcher grows beyond today's small helper.

**Deferred:** deep links (`accordion://`) and browser/Vite launch remain out of scope.

## Scale the tile grid beyond DOM — virtualize first, canvas/WebGL only if needed (pinned 2026-06-07)

**Goal:** keep the Map grid smooth as sessions grow past today's ~982 tiles. The grid
currently renders every block as its own DOM element; that's near the comfortable ceiling
for plain DOM, which is why `ContextMap.svelte` already carries a pile of repaint-avoidance
tricks (kill hover during scroll, cached dice SVGs, GPU layer promotion, no live gradients).
A 5–50k-tile session, or fluid pan/zoom, would outgrow that.

**Direction (cheapest first — do NOT jump straight to canvas):**
- **Virtualize the DOM** — only render the tiles actually on screen (windowed render keyed
  to scroll position). Smallest change; keeps everything the browser gives for free (hover,
  click, focus, the arrow-key cursor, `title` tooltips, CSS-var theming, accessibility,
  devtools). This is almost certainly enough and should be tried before anything heavier.
  Note: `content-visibility`/`contain-intrinsic-size` were already tried on `.cell` and
  **removed** (hurt more than helped) — so virtualization here means real windowing, not CSS
  containment.
- **Canvas / WebGL** — only if virtualization isn't enough (tens of thousands of tiles, or
  60fps pan/zoom). Paints all tiles onto one surface; scales hugely but you re-own what the
  browser did for free: hit-testing (which tile is under x,y — easy here since tiles are a
  uniform grid), hover/selection/cursor, tooltips, CSS-var theming (colors move into JS),
  accessibility (needs a parallel ARIA layer — the real cost), find-in-page/copy, and
  devicePixelRatio crispness. A **hybrid** (canvas tiles + a thin DOM overlay for the
  hovered/selected tile, tooltip, and a11y) recovers most of those losses.

**Helps that the tiles are uniform squares with no text** (dice pips are pre-baked SVG
data-URIs), so a canvas port sidesteps text rendering — the hardest part. The interaction
surface (hover, selection ring, arrow-key traversal, tooltips, the on-demand Inspector) is
what you'd be reimplementing.

**Loose end this would reconnect:** `AccordionStore.version` (`store.svelte.ts`) is bumped on
every settled change but currently has **zero readers** — it was added as a coarse "repaint
now" signal for exactly a canvas renderer. Today it's dead (the DOM grid self-updates via
Svelte). A canvas/WebGL view would subscribe to it; until then it's vestigial (delete it, or
relabel its comment as reserved — see the perf review that flagged it).

## Browse saved pi sessions like Claude Code transcripts (pinned 2026-06-05)

**Status/context:** browsable, read-only Claude Code transcript discovery has shipped: the
sidebar has a Claude Code source, Rust lists recent `~/.claude/projects/*/*.jsonl` files,
and the header/sidebar mark the view as **READ-ONLY**. The remaining adjacent idea is to
offer the same browse-don't-hunt flow for saved pi transcripts under
`~/.pi/agent/sessions`.

**Goal:** add a read-only saved-pi source/section to the Sessions sidebar. Selecting a row
loads the transcript through the existing parser and local fold/unfold/pin/peek lens, with
no live socket and no steering.
