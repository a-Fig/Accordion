# Handoff (fresh start) conductor

**An intentional baseline / foil — not a recommendation.**

This conductor simulates the *other* thing a developer does when a coding session runs long.
The [naive compaction](../compaction-naive/) foil reproduces `/compact` — summarize the aged
history in place and keep working. This one reproduces the **hard reset**: write a handoff
document, `/clear` the session, and paste the handoff into a **brand-new agent** that has no
memory of the conversation. The fresh agent continues from the handoff and *nothing else*.

## What it is (and is not)

Like naive compaction, `handoff` is **deliberately lossy and recursive** — and for the same
honest reasons, because a real handoff chain has the same failure modes.

- **Lossy.** The folded blocks collapse into ONE group whose digest is the handoff document.
  There is no `{#code FOLDED}` tag, so the agent cannot `unfold` to recover the originals — a
  fresh agent genuinely does not have them. (The human can always **detach** to recover the
  full history in Accordion's UI — that asymmetry is Accordion being Accordion.)
- **Recursive / amnesiac.** Each subsequent handoff is written from the **prior handoff** plus
  only the new work since — never the originals already discarded. Successive handoffs compound
  loss exactly the way successive `/compact`s do, because a real fresh-start chain also only
  ever carries the last handoff forward, never the raw sessions behind it.

## The one thing that makes it distinct from naive compaction

Naive compaction keeps a **large** rolling working tail — the human's protected tail, ~20k
tokens — verbatim, and only summarizes the aged prefix. A fresh start throws the working tail
**away**: when you `/clear` and reseed, you carry over only what the handoff author wrote down,
not your last 20k of live tool output and reasoning.

So this conductor **owns a deliberately small tail** (`HANDOFF_TAIL_TOKENS` targets ~8k — the
host walk-back keeps the newest whole block(s) up to a 25% overflow cap, so the live tail is one
block at minimum and never more than ~10k; the "fresh
agent's initial working room") by holding the **`tail-size`** involvement lock (ADR 0011), and
folds nearly the *whole* conversation into the single handoff. The visible window collapses hard
at each handoff and rebuilds — a deep sawtooth, not naive compaction's gentle curve. Locking
`tail-size` is not a power grab: it **is** the simulation. Without it, the human's 20k tail
would defeat the "fresh start" entirely and this conductor would be indistinguishable from
naive compaction (which pointedly leaves `tail-size` unlocked).

## How it works

A close cousin of naive compaction (itself a cousin of [sliding-window](../sliding-window/)).
Same single-`group`-over-the-aged-run mechanism, same visible-window hysteresis, same in-flight
/ stale-completion / attempt-key guards. Two things differ:

1. **It holds all three steering locks** — `human-steering` + `agent-unfold` (same rationale as
   naive compaction: keep the aged region contiguous and un-fought-over while the handoff is
   rewritten) **and `tail-size`** with `tailTokens ≈ 8k`. Being exclusive over all three
   triggers the one-time ADR 0011 consent gate; the human's recourse is always **detach**, which
   freezes the current view and inherits this conductor's tail into the human's `protectTokens`.

2. **The completion is a handoff document**, not a compaction summary. The system prompt
   addresses the model as the *author* of a briefing for a successor that will have nothing but
   this document, with handoff-shaped sections:

   - `## Original request` — every user message reproduced **verbatim** (the human's real ask
     must survive every handoff; only assistant reasoning degrades)
   - `## Task`
   - `## Current state`
   - `## Next steps`
   - `## Key files & locations`
   - `## Gotchas & constraints`
   - `## How to resume / verify`

**Trigger — visible-window hysteresis.** `view.liveTokens` is the RAW, fully-unfolded size (the
host clears conductor folds every pass), so it only grows; a naive `liveTokens ≥ 90%` test would
re-trigger forever once first crossed. Instead the conductor tracks the token saving its handoff
group provides and triggers on the VISIBLE window: `visible = liveTokens − (Σ survivor tokens −
handoff token cost)`. A fresh handoff is written when `visible ≥ 90%` of budget AND there are
newly-aged blocks to fold in; otherwise it HOLDS, re-emitting the existing handoff group.

**Recursive path.** With a prior handoff, the prompt wraps `<previous-handoff>` + `<conversation>`
(new blocks only) with merge instructions that preserve still-relevant details, move finished
work into "Current state", and carry every verbatim user message forward. The originals already
folded are intentionally absent — the recursive amnesia at the centre of the foil.

**Unavailable model link.** If `host.can("complete")` is false (browser dev mode, read-only
Claude Code transcript, extension disconnected), the conductor does not fall back to deterministic
grouping. It preserves any existing handoff, leaves newly-aged blocks live, and surfaces a
"waiting for live model link" status until completion is available again.

## Selecting it

Open the Accordion desktop app, load a session, and pick **Handoff (fresh start)** from the
conductor dropdown in the map header. Because it locks all three steering controls, a one-time
consent dialog appears; **detach** at any time to freeze the view and hand the controls back.
Selection is global — it applies to whatever session is currently active.

## Limitations (by design)

- The agent **cannot self-unfold** any handed-off block — the `group` carries a literal digest,
  no fold codes are emitted.
- **Compounding amnesia** — each handoff reads only the prior handoff + new work; errors in an
  early handoff persist and compound. (User messages are the exception: reproduced verbatim, so
  they survive.)
- Depends on **`host.can("complete")`** — unavailable in browser dev mode and read-only sessions.
- All block kinds (including `user` and `tool_call`) are swallowed by the handoff group. The
  host's whole-message snap + tool-call/result pair-balance keeps the outgoing message
  provider-valid; a group whose every member is a split tool-pair half is refused and those
  blocks stay live that pass (the same boundary straggler caveat sliding-window documents).
- The conductor is **exclusive over all three locks**, so the consent gate and detach
  freeze/kill-switch apply. `human-steering` keeps the aged region contiguous (one handoff tile);
  `tail-size` hands it the small owned tail; the human's tail dial is inert while attached.
- It **does not track its own model spend** — this is a baseline, not a production system.
