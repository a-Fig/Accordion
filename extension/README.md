<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/a-Fig/Accordion/main/docs/assets/logo-lockup-white.png">
  <img alt="Accordion" src="https://raw.githubusercontent.com/a-Fig/Accordion/main/docs/assets/logo-lockup-black.png" width="440">
</picture>

### /compact is the naive solution. Accordion is the intelligent one.

**See everything your AI agent holds in context — and fold it like an accordion instead.**

<img src="https://raw.githubusercontent.com/a-Fig/Accordion/main/docs/assets/accordion-hero.gif" alt="Accordion — the context map demo: blocks folding and unfolding while the protected tail stays intact" width="820">

</div>

---

Accordion is a [pi](https://github.com/earendil-works/pi) extension that shows you your
agent's entire context window at a glance and lets you manage it — manually or with
intelligence through a **conductor**.

This package ships the **pi extension** (it holds your session's context state and is the
live link to it) plus a **browser-served UI**, so you can run Accordion with `pi install`
alone — no Rust, no desktop app required.

## Install

```bash
pi install npm:@a-fig/accordion
```

That adds the package to `~/.pi/agent/settings.json`. Restart pi, then in any project:

```bash
/accordion
```

The extension HTTP-serves the Accordion UI and prints the URL (also opens it) — a single
stable link (`http://127.0.0.1:24317/...`) that one extension holds at a time and that
survives any one pi session ending, so you don't need to re-copy a fresh URL out of pi's
output every time. The page auto-connects to the running session. Folding is **off by
default** — flip the **Folding** toggle in the header to start steering what the agent
sees.

Only one surface steers at a time. Opening Accordion from a second tab/window while
another is already driving prompts you once to take control; every other surface is a
live, strictly read-only mirror — a **READ-ONLY** chip with a **TAKE CONTROL** button,
never two surfaces silently racing to steer the same session.

> **Multi-session, browser-served — no desktop app required.** The extension serves the UI
> in your browser and exposes every live pi session on the machine over a token-gated
> endpoint; the browser polls it and lists them all in the sidebar, so you can switch
> between sessions the same way the desktop app does. The one thing that's still
> desktop-only is browsing **Claude Code** transcripts (`~/.claude`), since that needs the
> native Rust layer. For that, conductors that need local model resources, or the native
> window, build the [desktop app](https://github.com/a-Fig/Accordion) from source.

## How it works

The **context Map** is the whole window at a glance: one square per block, sized by token
weight (a dice face, 1–6), colored by kind — **user** messages, **assistant** responses,
**thinking**, **tool calls**, and **tool results** each get their own hue. Bright = live;
recessed and hatched = folded.

Three hands share the controls:

- **You** — fold, unfold, pin, and peek by hand. Your overrides always win.
- **The agent** — reaches back to unfold or pin context it needs mid-task, or **recall**
  a folded block as a tool result (like `read_file`) without changing what's standing in
  context.
- **The Conductor** — an automatic strategy that, between turns, folds what's gone cold
  and unfolds what's becoming relevant. Collaborative by default; an *exclusive*
  conductor you approve can take over specific controls, and **detach** is always your
  kill switch.

Every block is **Full**, **Folded** (shown as a short tagged summary), or **Pinned**
(locked open). Folds are **content substitution, never removal** — provider-safe and
fully reversible. The most recent ~20k tokens are a **protected working tail** the agent
reasons over at full fidelity.

**Conductors are opt-in, same as folding itself** — pick one from the header's Conductor
menu, or leave it on "None" for fully manual steering. `compaction-naive`, `handoff`, and
`doorman` run right inside this extension, no extra setup. The fourth, `thermocline`
(attention-gated compression under a hard budget invariant), runs as its own out-of-process
Node program; its runner ships with the full [GitHub repo](https://github.com/a-Fig/Accordion),
not with this npm package, so it only shows up in the picker when Accordion is running from a
repo checkout (e.g. the desktop app build) rather than a bare `pi install`. Picking a
conductor that takes over any steering control shows you a consent screen first — cancel or
detach anytime and your own edits are preserved.

<div align="center">
<img src="https://raw.githubusercontent.com/a-Fig/Accordion/main/docs/assets/attention-conductor.png" alt="Attention conductor view — each block tinted by how much the working tail still attends back to it" width="600">
</div>

## How the live link works

The extension holds the **authoritative** context state for your session — every fold,
pin, and group lives there, not in the browser tab. The GUI connects as a **replica**: it
hydrates from a full snapshot on connect, then stays in sync over a stream of small,
replayable events — no polling, and no round trip on the model-call path. Steering actions
(fold, pin, group, the budget/tail dials) are sent to the extension as commands; the
extension applies them to its own state and echoes the result back to every connected
client, so there's never more than one copy of the truth to disagree with. Only the one
surface currently holding control may send a command that actually changes anything —
every other connected client is a live mirror, so multiple open tabs/windows can never
silently race each other to steer the same session.

Folding is **opt-in and off by default** — flip the **Folding** toggle in the header to
start steering what the agent sees. When it's off, pi's `context` hook is a no-op and your
messages reach the model untouched. When it's on, the hook applies your **current** fold
state locally, in-process, immediately before the model call: there's no GUI round trip and
no timeout to tune, because the state the extension already holds *is* the state applied,
synchronously, every time.

## Skills included

This package registers two pi skills the agent uses to interact with folded context:

- **accordion-context-folding** — the `unfold` tool: restore a folded block into standing
  context (sticky, attributed to the agent).
- **accordion-context-recall** — the `recall` tool: read a folded block's full content as
  a tool result *without* mutating the view, like `read_file`. Never lockable.

## What works today

- ✅ Browser-served UI — no desktop app required
- ✅ Live link to a running pi session
- ✅ Opt-in live steering — apply your fold plan to what the agent is shown
- ✅ Reversible, provider-safe folding with deterministic `{#code FOLDED}` digests
- ✅ Agent-driven unfold + `recall`, involvement locks
- ✅ The Conductor — automatic fold/unfold between turns
- ✅ LLM-generated summaries, computed once and cached

## Links

- **Source & full docs:** [github.com/a-Fig/Accordion](https://github.com/a-Fig/Accordion)
- **Vision:** [VISION.md](https://github.com/a-Fig/Accordion/blob/main/VISION.md)
- **pi (the harness):** [github.com/earendil-works/pi](https://github.com/earendil-works/pi)

---

<div align="center">

🏆 &nbsp;Built at the **AI Hackathon 2026 @ UC Berkeley** — a winning project.

🪗

</div>
