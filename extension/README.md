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

This package ships the **pi extension** (the live link that streams context and applies
your fold plan) plus a **browser-served UI**, so you can run Accordion with `pi install`
alone — no Rust, no desktop app required.

## Install

```bash
pi install npm:@a-fig/accordion
```

That adds the package to `~/.pi/agent/settings.json`. Restart pi, then in any project:

```bash
/accordion
```

The extension HTTP-serves the Accordion UI on a local ephemeral port and prints the URL
(also opens it). The page auto-connects to the running session. Folding is **off by
default** — flip the **Folding** toggle in the header to start steering what the agent
sees.

> **Single session, browser only.** This package serves the UI in your browser for the
> current pi session. For multi-session discovery, conductors that need local model
> resources, and the native window, build the
> [desktop app](https://github.com/a-Fig/Accordion) from source.

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

<div align="center">
<img src="https://raw.githubusercontent.com/a-Fig/Accordion/main/docs/assets/attention-conductor.png" alt="Attention conductor view — each block tinted by how much the working tail still attends back to it" width="600">
</div>

## Configuration

Advanced knobs, read from the environment once when the extension loads. Defaults are
tuned for interactive use. Whether the extension **blocks** on the plan is no longer an env
flag — it follows the attached client's **armed** state, learned over the wire (see
[Armed state](#armed-state-over-the-wire) below); the deadline knob matters mainly for a
blocking session (interactive steering, or a benchmark harness that must enforce a hard
context budget).

| Env var | Default | Effect |
|---|---|---|
| `ACCORDION_PLAN_TIMEOUT_MS` | `250` | How long a model request waits for the GUI's fold plan before falling back **while the attached client is disarmed** (the fast path). On a miss the extension re-applies the **last known plan** rather than shipping the conversation unfolded (a one-turn-stale plan is strictly better than none), and logs the fallback — it is never silent. |
| `ACCORDION_PLAN_DEADLINE_MS` | `10000` | The plan wait used **while the attached client is armed**: a hard **deadline** instead of the short timeout, so a run whose cap must hold actually holds it. A missed deadline is logged loudly (`console.error`) and still falls back to the last known plan. It never blocks when no client is attached, and a mid-wait disconnect resolves immediately. **Caution:** a hung-but-connected client (socket open, not replying) stalls *every* model request by the full deadline (10s by default) **while armed** — there is deliberately no circuit breaker yet; a consecutive-miss breaker is tracked as follow-up work. |

Invalid values (non-numeric, `NaN`, `≤0`, or non-integer such as `"250.5"`) fall back to
the default. Values are parsed with `Number()`, so scientific notation (`"1e3"`) and hex
(`"0x10"`) are also accepted as long as they resolve to a positive integer.

### Armed state over the wire

Blocking is driven by the attached client, not the environment. The client sends
`{ "type": "armed", "armed": <boolean> }` on the live WebSocket to declare whether it is
steering; the extension adopts that state for subsequent model requests (armed → wait the
deadline; disarmed → the short timeout) and replies `{ "type": "armedAck", "armed": <boolean> }`
to confirm it understood. Every fresh attach starts **disarmed**, and the GUI re-declares its
state on connect, so a stale arming can never carry across sessions.

For the interactive GUI this is simply the wire form of the **arm toggle** (the FOLDING
`preview` / `steering` button) — one steering concept for both the UI and headless hosts,
replacing the former benchmark-only `ACCORDION_STEERING` env flag. A headless benchmark host
declares `armed:true` the same way; the `armedAck` lets it detect an old extension (which
would silently drop the unknown message and run non-blocking) and fail loudly instead. These
messages are **additive** — an old peer ignores an unknown type — so the wire
`PROTOCOL_VERSION` is intentionally not bumped.

Each request also records the plan round-trip time it waited, stamped onto the assistant
message it produced as `usage.rttMs` (integer milliseconds) in the session file.

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
