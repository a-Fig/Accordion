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

## The actions

- **Fold** — replace a section with its summary to free up room.
- **Unfold** — bring a folded section back to full detail in the agent's context. It is live again — and, unless pinned, the Conductor may fold it later if it goes cold.
- **Pin / Unpin** — lock a Full section open so nothing can fold it automatically, or release that lock.
- **Peek** — *your* read of a folded section's full detail *in the window only*, without changing what the agent sees.
- **Recall** — the *agent's* read of a folded section. It returns that section's full content to the agent as a tool result — exactly like reading a file — without changing its standing context: the section stays folded, no override is created.

The distinction that matters most: **Unfold and Pin change the agent's context; Peek and Recall do not.** Peek is yours and Recall is the agent's, and they are mirror images — **Peek : You :: Recall : The agent** — both look at folded content without disturbing the standing view. Unfold and Pin are for steering.

## Who controls it

Three parties operate the same accordion. Not all of them can do everything — by design:

| Action | You | The agent | The Conductor |
|---|:---:|:---:|:---:|
| Fold | ✅ | — | ✅ |
| Unfold | ✅ | ✅ | ✅ |
| Pin | ✅ | ✅ | — |
| Peek | ✅ | — | — |
| Recall | — | ✅ | — |

- **You** can do everything: fold what's become noise, unfold what you want back, pin what must stay, and peek at anything without disturbing the agent.
- **The agent** can reach for context it needs — unfold a past section mid-task, or pin one it wants to keep — but it never decides what to throw away, and it has no reason to peek (it isn't looking at a window; it simply receives context). When a section it wants is folded, it can recall the full content as a tool result without forcing the section back open.
- **The Conductor** is Accordion's automatic mode. Between every turn it reads what the agent is doing, folds the sections that have gone cold, and unfolds the ones becoming relevant again — keeping the most useful context in view and within budget on its own. A Conductor comes in one of two postures. A **collaborative** Conductor — the default — steers alongside you exactly as the matrix shows: it never pins, because a pin exists precisely to overrule it, and you can always reach in. An **exclusive** Conductor, with your approval, locks specific controls and takes uncontested command of them — including, if it claims your hand-steering, your pins; you approved that when you attached it, and detaching is how you overrule it then.

The matrix above shows the **collaborative default**. Exclusivity — when and how a Conductor takes some of these controls off the table — is covered next.

## Collaborative and exclusive conductors

A Conductor is either a **co-pilot** or an **autopilot**, and you choose which when you pick one. This is a property of the Conductor itself — its author declares it, and you shop on it the same way you'd shop on any other thing a context manager promises.

A **collaborative** Conductor (co-pilot) locks nothing. It's the default, and it's everything above: you steer alongside it, your hand always wins, and your only reason to walk away is preference.

An **exclusive** Conductor (autopilot) asks to take uncontested command of a declared subset of the controls — so its strategy can reason about a context state it knows won't be fought mid-run. There are exactly three controls it can claim: **your hand-steering** (fold, unfold, and pin by hand), **the agent's unfold**, and **the tail size** (the protected-tail dial and its no-fold floor). It can claim any combination, up to all three.

Some things are **sacred** — never lockable, by any Conductor, ever:

- **Observation** — peek, the live map, the activity log, the budget readout. *You can always see; you just can't always touch.* Even under a fully exclusive Conductor you watch every move it makes, attributed, the whole time.
- **The budget** — the dial that says how large the window may grow stays yours, always. (The tail is a strategy's working assumption and can be handed over; the budget is your statement of the limit and can't.)
- **The agent's recall** — the agent can always read its own folded history.
- **Detach** — the kill switch. Always yours, always.

Attaching a co-pilot changes nothing and needs no ceremony. Attaching an autopilot is a **deliberate handover**: Accordion shows you exactly which controls it will take over — a short table of checks and x's — and asks you to confirm before anything is locked. Nothing leaves your hands until you say yes.

And the handover is never a trap, because the **kill switch is always yours**. Detaching freezes the context exactly as it stands — every section keeps its current fold state — and returns every control to you. It deliberately does *not* dump everything back to full: that could blow your budget the instant you leave. Instead the folds it leaves behind become ordinary, individually reversible folds, with no Conductor running, and you take it from there. No lock can touch detach and no Conductor can refuse it.

This is why handing the agent's controls to an autopilot doesn't blind it. Even under total lockdown, the agent can always **recall** — read the full content of anything folded, as a tool result, without forcing it back open. Locking the agent's *unfold* only stops it from overruling the strategy's standing view; it never costs the agent access to its own history. **"No silent forgetting" survives even the most exclusive Conductor.**

That is the whole shift. The old promise was *you can always overrule it*. The new promise is larger and simpler: **you can always see it, and you can always leave it.** Trust moves from override to revocability.

| Control | Collaborative | Exclusive |
|---|:---:|:---:|
| Your steering (fold / unfold / pin) | yours | can be locked |
| The agent's unfold | agent's | can be locked |
| The tail size + tail floor | yours / host | can be locked |
| Peek · live map · activity log | always yours | always yours |
| The agent's recall | always the agent's | always the agent's |
| The budget | always yours | always yours |
| Detach (the kill switch) | always yours | always yours |

## The protected working tail

One slice of context is special: the most recent stretch of the conversation. The agent's latest reasoning, the tool results it just saw, the turn it's mid-way through — this is its working memory, and silently summarizing any of it would undercut the work in progress and the trust the whole tool depends on.

So Accordion reserves a **protected working tail**: by default, the newest ~20k tokens of context (configurable) are never folded. The automatic folder, the Conductor, manual folds, and groups are all held back from this window — they only ever operate on context older than it. The guarantee is token-based, not turn-based: it always covers a real, recent slice of the conversation regardless of how the turns happen to divide.

Under a collaborative Conductor — the default — this protection is absolute. Recent reasoning stays intact, always. The tail is one control an exclusive Conductor can ask to take over: if you approve a Conductor that claims the tail size, you've delegated this assumption to it — it sizes the tail, and may manage or even shrink it to nothing, because deciding what must stay verbatim is exactly the judgment you handed over. Most Conductors keep a tail anyway, for the same reason it exists; but it's now the strategy's working assumption rather than a host rule, absolute only while you keep it yours.

## Folding the folds

A single summary per turn is enough for a normal session. A session that runs for days is not — you would end up with a long wall of summaries, which is just a smaller wall.

So folds nest. Several adjacent folded sections can be folded together into one higher-level summary — a **group**. A group can fold into a larger group, and so on. The result isn't a flat list but a tree you can open to any depth:

- Zoomed all the way out: a handful of broad summaries — *"set up the project," "built the parser," "chased the race condition."*
- One level in: each of those opens into the folded turns it covers.
- All the way in: any single turn, in full detail.

These actions work the same at every level. Folding a group collapses it to one line; unfolding it reveals its members; pinning a group protects the whole branch; peeking opens it in the window without touching the agent's context. The Conductor builds these groups as runs of turns go cold, so the further back something is, the more coarsely it's summarized, and the closer it is, the more detail it keeps. Recent work stays sharp; ancient history compresses to a sentence you can always expand.

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

Or run it on autopilot. You attach an exclusive Conductor, confirm the handover it shows you, and let it manage the context end to end. You don't reach in — but you watch the map fold and unfold in real time, and when the agent needs that early config it recalls the full text as a tool result, reads it, and keeps going, all without disturbing the standing view. If you ever dislike where it's taking things, you detach: the context freezes where it is and the controls are yours again.

## Why it works this way

**Context is a view, not a store.** Accordion never edits your real history — it keeps the full, original record untouched and only changes the *view* the agent is given each turn. That is why folding and unfolding are instant and perfectly reversible, and why there is no database or search index to maintain. Resizing context is just rewriting a view.

**Visibility and revocability are what make automation safe.** Every move is shown and attributed — observation is sacred, so no Conductor, however exclusive, can ever take your eyes off it. And you can always revoke: detach freezes the view and hands every control back to you. With a collaborative Conductor you also reach in surgically — overrule it with a pin, fold what you don't want, unfold what you do. With an exclusive one you've chosen to let it drive, and revocability is your guarantee instead: the keys are always yours to take back. Surgical override is the collaborative mode; being able to *leave* is the universal one — it holds no matter how much control a Conductor has. You can always see, and you can always leave.

---

**The north star: your agent's memory should be something you can see and steer — not a black box that silently forgets.**

🪗
