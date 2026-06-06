# Backlog

Parked ideas with enough context to pick up cold. Newest first.

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
