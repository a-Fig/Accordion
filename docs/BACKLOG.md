# Backlog

Parked ideas with enough context to pick up cold. Newest first.

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

## Read-only visibility into Claude Code chats (pinned 2026-06-05)

**Goal:** first-class, browsable visibility into the user's Claude Code chats inside
Accordion — not just "Open a file", but the chats listed and selectable the way live pi
sessions are. Folding/steering does **not** need to work; read-only viewing is enough for
the initial ship. It must be **visually unmistakable that the view is read-only** (a clear
badge/label on the session and/or header).

**Why it's worth shipping early:** the parser already handles Claude Code JSONL
(`app/src/lib/engine/parse.ts → parseClaude`), so the rendering path is free. The gap is
*discovery + presentation*: enumerate sessions under `~/.claude/projects/<project>/*.jsonl`
and surface them in the sidebar.

**Sketch:**
- A Rust command to list Claude Code transcripts (walk `~/.claude/projects`, newest first,
  with title/cwd/mtime) — mirrors `list_sessions` but for static files, not the live
  `~/.accordion/` registry.
- A sidebar section ("Claude Code", collapsible) listing them; selecting one loads the file
  read-only (reuse `openFile`'s load path, skip the live socket).
- A persistent **read-only** badge in the header + sidebar row so it's never mistaken for a
  steerable live session.
- Consider the same for saved pi sessions under `~/.pi/agent/sessions`.

**Partial today:** `Open…` already opens these files read-only and defaults its dialog to
`~/.pi/agent/sessions` then `~/.claude/projects`. This backlog item is the *browse-don't-
hunt* upgrade on top of that.
