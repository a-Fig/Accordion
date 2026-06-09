# ADR 0002 — "Pull" connection model (session discovery)

**Status:** accepted
**Date:** 2026-06-05
**Supersedes:** the fixed-port, manual-Connect transport of [ADR 0001](0001-pi-live-integration.md) (the fold loop / wire protocol of 0001 are unchanged).

## Context

ADR 0001 shipped the live link with the extension hosting a WebSocket server on a
**fixed** port (4317) and the GUI dialing it via a manual "Connect" button. Two
problems surfaced once it was real:

1. **One session only.** A second pi session can't bind 4317; it silently falls
   back to headless. Multi-session — the common case for "vibe coders" with several
   terminals — is broken.
2. **Manual and ambiguous.** Start pi → switch to the app → click Connect, with
   nothing telling you *which* session a window is showing.

Two shapes were considered:

- **Push** — `/accordion` makes the extension spawn/focus the app. Gives the
  extension a new power (`child_process`), and in dev it can only "open a tab" if
  the Vite server is already up. Load-bearing infrastructure for a convenience.
- **Pull** — the extension only *advertises*; the app discovers and attaches.

## Decision

**Pull.** Each pi session is self-describing; the app is a persistent control panel
that lists every live session and attaches to the one you pick.

- **Ephemeral port per session.** The extension binds `port: 0` (OS-assigned), so N
  sessions coexist with zero port coordination. Fixes problem 1.
- **Registry files** (`app/src/lib/live/registry.ts` is the single source of truth):
  - `~/.accordion/sessions/<sessionId>.json` — a `SessionEntry` written on start,
    refreshed on a 5 s heartbeat, deleted on shutdown. Carries the ephemeral `port`,
    `cwd`, `model`, and live `tokens`/`contextWindow` (from `ctx.getModel()` /
    `ctx.getContextUsage()`) so the sidebar shows live fullness for *every* session.
  - `~/.accordion/focus.json` — a one-shot `FocusRequest` written by `/accordion`.
- **Native discovery, not browser.** A browser tab can't read the filesystem, so the
  registry is read by a thin Tauri Rust layer (`list_sessions`, `reap_session`,
  `take_focus_request`, `focus_window` in `src-tauri/src/lib.rs`) and surfaced to the
  Svelte sidebar via `invoke`. This is *why* the desktop app — not the browser — is
  the real runtime (browser dev stays a UI-iteration loop with a manual port input).
- **`/accordion` = focus this session; launch is only a convenience.** It writes a
  focus request the app consumes to foreground itself and select that session. The
  focus request remains the sole session handoff. The command may also best-effort
  launch/reinvoke the desktop app so the same one-step affordance works when the
  app is not already visible; the desktop app's single-instance behavior prevents
  duplicate windows. This does **not** change the pull model: the app still
  discovers sessions from the registry and chooses which loopback WebSocket to dial.
  The executable path is resolved from `--accordion-app`, then `ACCORDION_APP_PATH`,
  then well-known Windows install paths and repo-local Tauri build outputs.

## Safety / robustness invariants

1. **Discovery is best-effort and cannot affect a model call.** All registry I/O is
   wrapped and ignored on failure; the fold loop's passthrough guarantees (ADR 0001)
   are untouched. **No disk I/O on the context (pre-model-call) hook** — model/usage
   is refreshed in memory and persisted by the heartbeat.
2. **Liveness = heartbeat freshness.** An entry older than `STALE_AFTER_MS` (15 s,
   vs a 5 s heartbeat) is reaped by the app. A merely-paused session self-heals: its
   next heartbeat rewrites the file. Idle-but-alive sessions keep ticking (the
   heartbeat timer is `unref`'d only so it never *keeps the process alive*).
3. **Atomic writes.** Every registry write is temp-file + `rename` (atomic-replace on
   Windows and POSIX), so the reader never sees a half-written descriptor.
4. **Focus is retried, not lost.** A focus request whose session isn't listed yet is
   held in memory and retried for `FOCUS_TTL_MS`; the window is foregrounded only
   when a session is actually selected.
5. **Path-safety.** `reap_session` rejects any id containing `/`, `\`, or `..`.

## Scope / limitations (this change)

- **One driver per session.** The extension still accepts a single GUI client; a new
  connection supersedes the prior. Two app windows attached to the same session would
  supersede each other (one-shot, no thrash loop). Multi-viewer (N read-only + 1
  driver) is deferred.
- **Same-machine assumption.** Staleness compares the app's `Date.now()` to the
  extension's — valid because both run on one host over loopback.
- **The fold plan is still empty** (Milestone 1 carryover): discovery and attach are
  proven, but no model call is altered yet. Turning the engine on remains M2, whose
  top prerequisite (durable block ids) is recorded in ADR 0001.

## Rejected alternatives

- **Push as the transport model** — rejected: the extension still does not push a
  session into a GUI or start the browser/dev server. A later convenience launcher
  only starts/focuses the installed desktop app; discovery and attach stay pull-based.
- **Keep fixed port 4317** — rejected: caps the tool at one session, the core defect.
- **pid-based liveness in Rust** — rejected: needs a cross-platform process-probe dep
  on an already-fragile Windows toolchain; the heartbeat timestamp is a simpler,
  sufficient signal (and the WS port is the ultimate liveness check on connect).
- **`accordion://` OS deep links for `/accordion`** — deferred: needs scheme
  registration + `tauri-plugin-deep-link`; the focus-request file delivers the same
  "select + foreground" with zero OS integration while the app is open.
