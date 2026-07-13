
<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-lockup-white.png">
  <img alt="Accordion" src="docs/assets/logo-lockup-black.png" width="440">
</picture>

### /compact is the naive solution, Accordion is the intelligent one.

**See everything your AI agent holds in context — and fold it like an accordion instead.**

<img src="docs/assets/accordion-hero.gif" alt="Accordion — the context map demo: blocks folding and unfolding while the protected tail stays intact" width="820">

<sub>Your whole context window split in 2 sections. The lower section represents your agent's most recent context and is protected against any interference</sub>
</div>

---

Accordion is a [pi](https://github.com/earendil-works/pi) extension that shows you
your agent's entire context window at a glance and lets you manage it manually or with intelligence through a conductor.

<div align="center">

<a href="docs/assets/accordion-demo.mp4"><img src="docs/assets/map-hero.png" alt="Accordion's context Map — a live pi session rendered as a grid of colored blocks" width="860"></a>

</div>

## Why it's different

#### 1. No blocking calls for compaction 
> your context window is automatically managed for you in the background, keeping you below your limit

#### 2. longer more useful sessions
> The relevance of each block is ranked so we only fold bloat, and keep what's important. 

#### 3. Cheaper inference costs
> Accordion keeps your context window lean, with cache optimizations in mind.

Every long-running agent hits the same wall: the context fills up, and something has to
go. Today's answers are dumb and dumber:

- **Compaction** blasts your whole history into one lossy summary — slow, destructive,
  all-or-nothing.
- **Sliding windows** just drop the oldest tokens — the agent simply forgets.

| | Sliding window | `/compact` | skills & memory | 🪗 Accordion |
|---|:---:|:---:|:---:|:---:|
| Keeps old context usable | ❌ | ⚠️ lossy | ⚠️ if retrieved | ✅ |
| **Reversible** to full detail | ❌ | ❌ | ❌ | ✅ |
| No mid-task stall | ✅ | ❌ | ✅ | ✅ |
| Per-section, not all-or-nothing | ❌ | ❌ | ⚠️ | ✅ |
| You can see and steer it | ❌ | ❌ | ❌ | ✅ |
| No extra infra (no vector DB) | ✅ | ✅ | ❌ | ✅ |

## The proof — early, but pointed

Accordion ships with a catalog of interchangeable **Conductors**. The strongest so far,
**[Thermocline](conductors/thermocline/)**, scores each block relevance to the most recent context using the attention from a 500M parameter model as a proxy.

In a test run on **SlopCodeBench** (a long-horizon coding benchmark), Thermocline at a
100k-token budget outperformed naive compaction with the same constrained context budget. Both used deepseekV4Pro.

| Conductor | Context Budget | Score | Checkpoints reached |
|---|:---:|:---:|:---:|
| **Thermocline** | 100k | **83.3%** | 5 / 6 |
| naive compaction | 100k | 33.3% | 2 / 6 |

> ⚠️ **Read this as a signal, not a guarantee.** It's a single hackathon-scale run on a
> subset of the problems — not a published benchmark. Broader, repeatable evaluation is on the roadmap.

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

## Quick start

### Part 1 — Browser (no Rust, no desktop app)

```bash
pi install npm:@a-fig/accordion
```
restart pi if it is already running, then inside of pi run:                                      
 ```bash
    /accordion                                                                       
 ```
That's it, assuming you have [pi](https://github.com/earendil-works/pi)

---

### Part 2 — Desktop app (Optional - full feature set)

The desktop app adds **multi-session discovery** (switch between running pi sessions from
a sidebar), conductors that require local model resources, and the `/accordion` command
that foregrounds the right session automatically. It requires Node 20+ and Rust.

> **Don't double-register the extension.** Part 1's `pi install npm:@a-fig/accordion`
> already registered the extension (the `/accordion` command, the `unfold`/`recall`
> tools, and the skills all come from the npm package). That same extension is what the
> local `extension/accordion.ts` builds into. **Adding `extension/accordion.ts` to
> `extensions` while the npm package is still installed loads it twice** — a duplicate
> `/accordion` command, duplicate tool registration, and a duplicate context hook. Pick
> **one** of the two paths below; don't do both.

**Prerequisites:** install [Node 20 LTS](https://nodejs.org) and
[Rust via rustup](https://rustup.rs), then follow the one-time platform setup at
**https://v2.tauri.app/start/prerequisites/** (WebView2 + MSVC on Windows, Xcode CLT on
macOS).

#### Path A — Place a built binary (recommended; keeps the npm package)

`/accordion` launches a **pre-built binary** from disk — it does not connect to a dev
server. So all you need is a built `app` binary in one of the locations the extension
scans. If you already ran Part 1, this is the only step: no `settings.json` edit, no
duplicate extension.

```bash
git clone https://github.com/a-Fig/accordion.git
cd accordion/app && npm install
npm run tauri build -- --no-bundle   # builds target/release/app(.exe); --no-bundle
                                     # skips the slower MSI/NSIS/.dmg installers
```

Then drop the binary where the extension looks for an installed bundle:

| OS | Path |
|---|---|
| **Windows** | `%LOCALAPPDATA%\Programs\Accordion\Accordion.exe` |
| **macOS** | `/Applications/Accordion.app` |
| **Linux** | `~/.local/share/Accordion/accordion` |

(Without an installed bundle, `/accordion` falls back to the repo build outputs
`app/src-tauri/target/release/app` then `…/debug/app`.) Run `/accordion` in any pi
session and it launches (or focuses, via single-instance) the desktop app on that session.

#### Path B — Register the local extension (for extension development)

Only choose this if you'll edit the extension itself. Remove the npm package first, then
point pi at your checkout instead. From `~/.pi/agent/settings.json`, drop
`"npm:@a-fig/accordion"` from `packages` and add to `extensions`:

```json
{ "extensions": ["<absolute-path-to-repo>/extension/accordion.ts"] }
```

The extension has its own runtime deps, so install them too:

```bash
cd accordion/extension && npm install
```

#### Run the app + live session

```bash
npm run tauri dev   # opens the native window; hot-reloads on save
```

> `npm run tauri dev` is a Vite dev server for UI iteration. It is **not** what
> `/accordion` connects to — `/accordion` always launches a built binary
> (`target/release/app`). To produce that binary, run
> `npm run tauri build -- --no-bundle`. Both `npm run dev` and `npm run tauri dev` want
> **port 1420**; run only one at a time.

Run pi in any project. It advertises itself in `~/.accordion/sessions/` and appears in
Accordion's **Sessions** sidebar within ~1s. Click it (or run `/accordion` in that
terminal) and its context populates live. Folding is preview-only by default; use the
header's **Folding** toggle to opt in to steering the live agent's context.

To refresh the binary after `main` moves (close any open Accordion window first so the
file isn't locked, then `git pull`, `npm install`, and rebuild): see
**[CONTRIBUTING.md](CONTRIBUTING.md)**.

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
