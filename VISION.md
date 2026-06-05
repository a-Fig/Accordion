<div align="center">

# 🪗 Accordion

**See everything your AI agent is holding in context — and fold, unfold, and pin any part of it, by hand or automatically.**

</div>

> This document describes the finished product: our north star. We design it fully here, then build to it.

---

## The problem

An agent's context window is a fixed size. During a long task it fills up, and something has to go to make room. Today that removal is invisible and permanent: old conversation gets summarized into a lossy blob or silently dropped. You don't see it happen, and you can't undo it. The agent quietly forgets — and you find out the hard way.

## What Accordion is

Accordion shows the agent's whole context as a list of **sections** — one per turn of the conversation — and treats that context as something you can resize, not a buffer that has to be flushed. Any section can shrink to a short summary and expand back to full detail, instantly, as many times as you like. Nothing is ever thrown away: folding changes only what the agent is *shown*, never what is *stored*.

## The states a section can be in

- **Full** — the agent sees it in complete detail.
- **Folded** — the agent sees a short summary in its place.
- **Pinned** — a lock added to a Full section so it can never be folded automatically.

Full and Folded are the two real states. Pinned is a protection you put on top of Full.

## The four actions

- **Fold** — replace a section with its summary to free up room.
- **Unfold** — bring a folded section back to full detail in the agent's context. It is live again — and, unless pinned, the Conductor may fold it later if it goes cold.
- **Pin / Unpin** — lock a Full section open so nothing can fold it automatically, or release that lock.
- **Peek** — read a folded section's full detail *in the window only*, without changing what the agent sees.

The distinction that matters most: **Unfold and Pin change the agent's context; Peek does not.** Peek is for you to look; the rest are for steering.

## Who controls it

Three parties operate the same accordion. Not all of them can do everything — by design:

| Action | You | The agent | The Conductor |
|---|:---:|:---:|:---:|
| Fold | ✅ | — | ✅ |
| Unfold | ✅ | ✅ | ✅ |
| Pin | ✅ | ✅ | — |
| Peek | ✅ | — | — |

- **You** can do everything: fold what's become noise, unfold what you want back, pin what must stay, and peek at anything without disturbing the agent.
- **The agent** can reach for context it needs — unfold a past section mid-task, or pin one it wants to keep — but it never decides what to throw away, and it has no reason to peek (it isn't looking at a window; it simply receives context).
- **The Conductor** is Accordion's automatic mode. Between every turn it reads what the agent is doing, folds the sections that have gone cold, and unfolds the ones becoming relevant again — keeping the most useful context in view and within budget on its own. It never pins, because a pin exists precisely to overrule it.

## The protected working tail

One slice of context is special: the most recent stretch of the conversation. The agent's latest reasoning, the tool results it just saw, the turn it's mid-way through — this is its working memory, and silently summarizing any of it would undercut the work in progress and the trust the whole tool depends on.

So Accordion reserves a **protected working tail**: the newest ~20k tokens of context (configurable) are **never auto-folded**. Both the automatic folder and the Conductor are held back from this window — they only ever operate on context older than it. The guarantee is token-based, not turn-based: it always covers a real, recent slice of the conversation regardless of how the turns happen to divide.

This is a constraint on *automation only*. You and the agent may still fold something inside the tail by hand if you choose; the promise is specifically that nothing automatic will reach in and collapse recent context behind your back. Recent reasoning stays intact, always.

## Folding the folds

A single summary per turn is enough for a normal session. A session that runs for days is not — you would end up with a long wall of summaries, which is just a smaller wall.

So folds nest. Several adjacent folded sections can be folded together into one higher-level summary — a **group**. A group can fold into a larger group, and so on. The result isn't a flat list but a tree you can open to any depth:

- Zoomed all the way out: a handful of broad summaries — *"set up the project," "built the parser," "chased the race condition."*
- One level in: each of those opens into the folded turns it covers.
- All the way in: any single turn, in full detail.

The four actions work the same at every level. Folding a group collapses it to one line; unfolding it reveals its members; pinning a group protects the whole branch; peeking opens it in the window without touching the agent's context. The Conductor builds these groups as runs of turns go cold, so the further back something is, the more coarsely it's summarized, and the closer it is, the more detail it keeps. Recent work stays sharp; ancient history compresses to a sentence you can always expand.

This is what lets a session of thousands of turns stay both small enough to fit and complete enough to recover: resolution that shrinks with distance and expands the moment you reach back.

## What you see in the window

The window is how you watch and steer. It shows:

- The full context as a readable document, in order.
- Folded sections and groups collapsed to their summaries, visually distinct from full ones — open them level by level, down to any single turn.
- Each section's size in tokens, and a running total against the window's budget — so you can see exactly where your context is being spent.
- Who last changed each section — you, the agent, or the Conductor — and why.
- Every fold and unfold as it happens, live, including the Conductor's moves between turns.
- A timeline you can scrub to replay how the context evolved across the whole session.

## What it looks like in practice

A long debugging session, an hour in:

1. The early setup turns have gone cold. The Conductor folded them a while ago and the budget bar is comfortable; you can still read their summaries in the window.
2. The agent realizes the bug traces back to a config decision made early on. It unfolds that section itself — you watch it expand, tagged *agent*.
3. That config is now central, so you pin it. It stays full for the rest of the session, untouched by the Conductor.
4. You want to re-check something in a section from twenty minutes ago without disturbing the agent's working set, so you peek — it opens in the window only; the agent's context is unchanged.
5. The session runs for three more hours and never overflows the window, because the Conductor keeps folding what's cold while you and the agent keep the few things that matter unfolded and pinned.

## Why it works this way

**Context is a view, not a store.** Accordion never edits your real history — it keeps the full, original record untouched and only changes the *view* the agent is given each turn. That is why folding and unfolding are instant and perfectly reversible, and why there is no database or search index to maintain. Resizing context is just rewriting a view.

**Visibility is what makes automation safe.** Because every move is shown and attributed, handing control to the Conductor is not a leap of faith. You can watch it work, overrule it with a pin, or close the window and let it run. Open it when you want to see; close it when you don't.

---

**The north star: your agent's memory should be something you can see and steer — not a black box that silently forgets.**

🪗
