
<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-lockup-white.png">
  <img alt="Accordion" src="docs/assets/logo-lockup-black.png" width="440">
</picture>

### /compact is the naive solution, Accordion is the intelligent one.

**See everything your AI agent holds in context — and fold it like an accordion instead.**

<img src="docs/assets/accordion-hero.gif" alt="Accordion — the context map demo: blocks folding and unfolding while the protected tail stays intact" width="820">

</div>

---

Accordion is a [pi](https://github.com/earendil-works/pi) extension that shows you
your agent's entire context window at a glance — as a grid of colored blocks — and
lets you **fold**, **unfold**, and **pin** any part of it, by hand or automatically.

Nothing is ever deleted. Folding only changes what the agent is *shown*, never what's
*stored* — so every fold is instantly reversible, with no database or search index
behind it.
<div align="center">

<a href="docs/assets/accordion-demo.mp4"><img src="docs/assets/map-hero.png" alt="Accordion's context Map — a live pi session rendered as a grid of colored blocks" width="860"></a>

<sub>Your whole context window, one square per block — live above, protected working tail below. &nbsp;·&nbsp; ▶ <a href="docs/assets/accordion-demo.mp4">Watch the demo</a></sub>
</div>

> 📖 **[VISION.md](VISION.md)** is the full product north star. This page is the short version.

## Why it's different

Every long-running agent hits the same wall: the context fills up, and something has to
go. Today's answers are both bad:

- **Compaction** blasts your whole history into one lossy summary — slow, destructive,
  all-or-nothing.
- **Sliding windows** just drop the oldest tokens — the agent simply forgets.

Both treat context as a buffer to flush. You never saw it go, and you can't get it back.

| | Sliding window | `/compact` | Black-box memory | 🪗 Accordion |
|---|:---:|:---:|:---:|:---:|
| Keeps old context usable | ❌ | ⚠️ lossy | ⚠️ if retrieved | ✅ |
| **Reversible** to full detail | ❌ | ❌ | ❌ | ✅ |
| No mid-task stall | ✅ | ❌ | ✅ | ✅ |
| Per-section, not all-or-nothing | ❌ | ❌ | ⚠️ | ✅ |
| You can see and steer it | ❌ | ❌ | ❌ | ✅ |
| No extra infra (no vector DB) | ✅ | ✅ | ❌ | ✅ |

Context isn't a buffer. It's an accordion.

## Quick start

Accordion attaches to a **live pi session** and watches its context update in real time.

```bash
cd app && npm install && npm run tauri dev
```

Register the extension in `~/.pi/agent/settings.json`:

```json
{ "extensions": ["<path-to-this-repo>/extension/accordion.ts"] }
```

Now run `pi` in any project. It shows up in Accordion's **Sessions** sidebar within a
second — click it (or run `/accordion` in that terminal) and watch its context populate
live. Folding is **off by default**; flip the header toggle to arm it and start steering
what the agent is shown.

## How it works

The **context Map** is the whole window at a glance: one square per block, sized by token
weight (a dice face, 1–6), colored by kind — **user** messages, **assistant** responses,
**thinking**, **tool calls**, and **tool results** each get their own hue. Bright = live;
recessed and hatched = folded.

Three hands share those controls:

- **You** — fold, unfold, pin, and peek by hand. Your overrides always win.
- **The agent** — reaches back to unfold or pin context it needs mid-task, or **recall**
  a folded block as a tool result (like `read_file`) without changing what's standing in
  context.
- **The Conductor** — an automatic strategy that, between turns, folds what's gone cold
  and unfolds what's becoming relevant. Collaborative by default; an *exclusive*
  conductor you approve can take over specific controls, and **detach** is always your
  kill switch.

Every block is **Full**, **Folded** (shown as a short tagged summary), or **Pinned**
(locked open).

<div align="center">
<img src="docs/assets/attention-conductor.png" alt="Attention conductor view — each block tinted by how much the working tail still attends back to it" width="600">
<br><sub>Folded blocks are shown with dull colors </sub>
</div>

Folds nest: cold turns fold into groups, groups into bigger groups, so a session of
thousands of turns stays small enough to fit and complete enough to recover. And the
recent past is always safe — the most recent ~20k tokens are a protected working tail the
agent reasons over at full fidelity (the thick-bordered box below the fold line).

→ Capability matrix, full walkthrough, and the deep spec: **[VISION.md](VISION.md)**

## The proof — early, but pointed

Accordion ships with a catalog of pluggable **Conductors**. The strongest so far,
**[Thermocline](conductors/thermocline/)**, scores each block's "temperature" with a small
(0.5B-parameter) attention probe and compacts coldest-first under a hard token budget —
attention decides order, the budget decides depth.

In an early run on **SlopCodeBench** (a long-horizon coding benchmark), Thermocline at a
100k-token budget cleared far more of the task than naive compaction at the same budget:

| Conductor | Budget | Score | Checkpoints reached |
|---|:---:|:---:|:---:|
| **Thermocline** | 100k | **83.3%** | 5 / 6 |
| naive compaction | 100k | 33.3% | 2 / 6 |

> ⚠️ **Read this as a signal, not a guarantee.** It's a single hackathon-scale run on one
> problem set — not a published benchmark. Broader, repeatable evaluation is on the roadmap.

## What works today

- ✅ Desktop app (Tauri + SvelteKit): the Map view, token budget, inspector, protected
  working tail.
- ✅ Live link to a running pi session, with auto-discovery.
- ✅ Opt-in live steering — apply your fold plan to what the agent is shown.
- ✅ Reversible, provider-safe folding with deterministic `{#code FOLDED}` digests the
  agent can ask to unfold.
- ✅ Involvement locks — exclusive conductors, the consent gate, freeze-on-detach, and
  agent `recall`.
- ✅ The Conductor — automatic fold/unfold between turns, based on context.
- ✅ LLM-generated summaries, computed once and cached.
- ✅ Read-only browsing of saved Claude Code transcripts.

Honest about what's **not** there yet: no agent-driven pinning, no hierarchical (nested)
groups, no replay. That's the build ahead.

## Roadmap

- [x] Core fold/unfold engine — reversible, tool-pair safe
- [x] The separate window — desktop app: Map view, budget, inspector
- [x] Live link to pi + auto-discovery, opt-in steering
- [x] Agent-driven unfold + `recall`, involvement locks
- [x] LLM-generated summaries, computed once and cached
- [x] The Conductor — automatic fold/unfold between turns
- [ ] Hierarchical folding for million-turn sessions
- [ ] Agent-driven pin
- [ ] Replay — scrub how context evolved across a session
- [ ] Better conductors — research, develop, and test stronger context strategies
- [ ] Expand accordion beyond pi

## Contributing

An experiment in context engineering — contributions, ideas, and benchmarks welcome.
Setup, the quality gate, and platform gotchas are in **[CONTRIBUTING.md](CONTRIBUTING.md)**.

Our main frontier right now is **better conductors**: researching which context actually
matters, developing stronger strategies, and testing them against real sessions. We're not
chasing a long tail of mediocre ones — the goal is one to three conductors that genuinely
hold up. A conductor is a single class with one method — `conduct(view) → Command[]` — and
one registration line to appear in the app. Strategies can range from simple oldest-first
folding to scoring each block's relevance with a small model. If you have a theory about
what an agent should keep and what it can let go, that's the surface to prove it — and the
place where outside help is most valuable right now.

---

**The north star: your agent's memory should be something you can see and steer — not a
black box that silently forgets.**

<div align="center">

🏆 &nbsp;Built at the **AI Hackathon 2026 @ UC Berkeley** — a winning project.

<sub>Tyler Darisme &nbsp;·&nbsp; Aaditya Desai &nbsp;·&nbsp; Sheel Shah &nbsp;·&nbsp; Thy Tang</sub>

🪗

</div>
