<div align="center">

# 🪗 Accordion

### Your agent's memory shouldn't have to forget to keep going.

**See everything your AI agent is holding in context — and fold, unfold, and pin any part of it, by hand or automatically.**

</div>

---

> 📖 **The full product spec is in [VISION.md](VISION.md). This page is the short version.**

## The problem

Every long-running agent hits the same wall: the context window fills up, and something has to go. Today's answers are both bad — **compaction** blasts your whole history into one lossy summary (slow, destructive, all-or-nothing), and **sliding windows** just drop the oldest tokens (the agent simply forgets). Both treat context as a buffer to flush: the detail is gone, you never saw it go, and you can't get it back.

## The idea

> Context isn't a buffer. It's an accordion.

Accordion shows the agent's context as a list of **sections** — one per turn — and lets you resize it instead of flushing it. Every section is **Full**, **Folded** (shown as a short summary), or **Pinned** (locked open). Four actions move them:

- **Fold** — replace a section with its summary to free up room.
- **Unfold** — bring it back to full detail (still auto-managed, unless pinned).
- **Pin / Unpin** — lock a section open so nothing folds it automatically.
- **Peek** — read a folded section in the window *without* changing the agent's context.

Nothing is ever deleted — folding only changes what the agent is *shown*, never what's *stored* — so every fold is instantly reversible, with no database or search index behind it.

And the recent past is always safe: the most recent ~20k tokens of context are **never auto-folded**, so the agent's working tail — its latest reasoning — stays at full fidelity. You and the agent can still fold inside that window by hand; only the automatic system is held back.

## Three hands on the same controls

- **You** — fold, unfold, pin, and peek, by hand.
- **The agent** — reaches back to unfold or pin context it needs mid-task.
- **The Conductor** — Accordion's automatic mode: between every turn it folds what's gone cold and unfolds what's becoming relevant, on its own.

And folds nest: cold turns fold into **groups**, groups into bigger groups, so a session of thousands of turns stays small enough to fit and complete enough to recover. It all happens in a **separate window** where every change is shown and attributed — open it to watch and steer, close it to let the Conductor run.

→ Full details, capability matrix, and a walkthrough: **[VISION.md](VISION.md)**

## See it: the visualizer

There's a working **[visualizer demo](visualizer/)** — a standalone window that renders a real agent context window and lets you fold, unfold, pin, and peek it, with the automatic **Conductor** keeping the live context inside a token budget. It loads real saved sessions from **Claude Code**, **pi**, or **OMP**.

```bash
cd visualizer && node serve.js   # then open http://localhost:8080
```

Drag any session `.jsonl` onto the window, or use the bundled sample. Everything runs locally — nothing is uploaded. See [visualizer/README.md](visualizer/README.md).

## Why it's different

| | Sliding window | `/compact` | Black-box memory | 🪗 Accordion |
|---|:---:|:---:|:---:|:---:|
| Keeps old context usable | ❌ | ⚠️ lossy | ⚠️ if retrieved | ✅ |
| **Reversible** to full detail | ❌ | ❌ | ❌ | ✅ |
| No mid-task stall | ✅ | ❌ | ✅ | ✅ |
| Per-section, not all-or-nothing | ❌ | ❌ | ⚠️ | ✅ |
| You can see and steer it | ❌ | ❌ | ❌ | ✅ |
| No extra infra (no vector DB) | ✅ | ✅ | ❌ | ✅ |

## Status

[VISION.md](VISION.md) is the north star — the finished product we're building toward. What exists **today**:

- **A desktop app** (`app/`, Tauri + SvelteKit) — the *separate window*. It renders an
  agent's context window as a foldable map, with a token budget and a protected working
  tail. It opens saved `.jsonl` sessions (the Open dialog lands in `~/.pi/agent/sessions`
  or `~/.claude/projects`), and — new — attaches to a **live** pi session.
- **A live link** (`extension/accordion.ts` + `app/src/lib/live/`). A pi extension
  streams a running session's context to the app over a local WebSocket; the app
  **auto-discovers** every running pi (the "pull" model) and shows it in a Sessions
  sidebar — click to watch its context update live.
- Reversible, provider-safe folding in the app (content substitution, never removal),
  with deterministic digest summaries.

Honest about what's **not** there yet: the app currently *reads* a live session but does
**not** yet steer it — it returns an empty fold plan, so the agent's context is unchanged.
No autonomous Conductor on a live session, no agent-driven control, no hierarchical
folding, no LLM-generated summaries, no replay — that's the build ahead. There's also an
older terminal-only POC (`src/accordion.ts`, `/expand` · `/collapse` · `/accordion`) that
predates the app.

### Try it

```bash
cd app && npm install && npm run tauri dev    # opens the desktop window
```

Register the live extension in `~/.pi/agent/settings.json`:

```json
{ "extensions": ["<path-to-repo>/extension/accordion.ts"] }
```

Then run `pi` in any project — it appears in the app's **Sessions** sidebar within a
second. Click it (or run `/accordion` in that terminal to foreground the app on it) and
watch its context populate live.

### Developing

Setting up for development (prerequisites, running the app, the quality gate, the live-link
setup, and platform gotchas) is in **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Roadmap

- [x] Core fold/unfold engine — reversible, tool-pair safe
- [x] Rolling automatic folding + manual expansion, protected working tail
- [x] The separate window — desktop app: Map view, budget, inspector
- [x] Live link to a running pi session + auto-discovery *(view only — empty fold plan)*
- [ ] Steer a live session — apply the fold plan to what the agent is shown
- [ ] LLM-generated summaries, computed once and cached
- [ ] The Conductor — automatic fold/unfold between turns, based on context
- [ ] Hierarchical folding — fold the folds, for million-turn sessions
- [ ] Agent-driven unfold and pin
- [ ] Replay — scrub how the context evolved across a session

---

**The north star: your agent's memory should be something you can see and steer — not a black box that silently forgets.**

🪗

<sub>An experiment in context engineering. Contributions, ideas, and benchmarks welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).</sub>
