# ADR 0017 — Handoff conductor: simulating a fresh start with a handoff

**Status:** accepted
**Date:** 2026-07-05
**Builds on:** [ADR 0007](0007-conductor-protocol.md) (the conductor seam), [ADR
0008](0008-conductor-first-party-one-view.md) (first-party conductors, one public
`ConductorView`), [ADR 0011](0011-conductor-involvement-locks.md) (involvement locks —
the `tail-size` lock this conductor holds), [ADR 0013](0013-conductor-host-capabilities.md)
(`ConductorHost.complete` — the model call this conductor depends on), [ADR
0014](0014-naive-compaction-conductor.md) (the naive compaction foil this one is a sibling of).

## Context

[ADR 0014](0014-naive-compaction-conductor.md) added a faithful foil for one thing mainstream
tools do when a session runs long: **`/compact`** — summarize the aged history in place and
keep working in the same session. But developers do a *second* thing just as often, and it
is meaningfully different: the **hard reset**. Write a handoff document, `/clear` the session
(or open a brand-new one), and paste the handoff into a fresh agent that has no memory of the
conversation. The new agent continues from the handoff and *nothing else*.

These are not the same strategy:

- **Compaction keeps a large live working tail.** After a `/compact` the agent still has its
  most recent ~20k tokens of raw tool output and reasoning verbatim, *plus* a summary of the
  older stuff. The summary is a prefix; live context follows it.
- **A fresh start throws the working tail away.** When you `/clear` and reseed, you do not
  carry over your last 20k of live context — you carry over only what the handoff author chose
  to write down. The handoff *is* the whole context at the moment of reset; there is no
  verbatim tail behind it.

That difference — *does the recent working tail survive, or not?* — is the whole reason this
is a distinct conductor rather than a re-prompt of naive compaction. Issue #24 asks for a
conductor that "simulates starting from scratch with a handoff"; the fidelity test is whether
it actually discards the tail the way a real `/clear` does.

## Decision

Ship a first-party in-process conductor, `conductors/handoff/handoff.ts` (`HandoffConductor`,
label "Handoff (fresh start)"), that reuses naive compaction's proven state machine and changes
exactly the two things that make it a fresh-start rather than an in-place compaction.

### 1. It owns a zero inherited tail via the `tail-size` lock

This is the mechanical heart of the ADR. The conductor declares
`locks = ["human-steering", "agent-unfold", "tail-size"]` and `tailTokens = HANDOFF_TAIL_TOKENS`
(`0`). Under the `tail-size` lock (ADR 0011 §7) the host drives `protectedFromIndex` from the
conductor's `tailTokens` instead of the human's `protectTokens`. With `target === 0`, the host
protects nothing (`protectedFromIndex = blocks.length`), so **the whole current conversation is
foldable into the handoff**. Naive compaction pointedly does the opposite — it leaves
`tail-size` unlocked so the human keeps a big ~20k verbatim tail. Here, owning a zero tail is
not a power grab; it *is* the simulation. Without it the human's 20k tail would leak verbatim
old-session context into the supposed fresh start and the two conductors would be
indistinguishable.

Consequence: the visible window collapses to the handoff document itself after each handoff,
then rebuilds only with new post-handoff turns before the next reset — a hard-reset sawtooth,
versus naive compaction's gentle curve. `tailTokens > 0` was rejected for fidelity: even a small
8k tail means the continuing agent sees the handoff plus raw recent context from the killed
session, which is not the workflow this conductor is meant to simulate.

### 2. The completion is a handoff document, not a compaction summary

Same `host.complete` mechanism, different voice. `HANDOFF_SYSTEM` addresses the model as the
*author* of a briefing for a successor that will have nothing but this document ("a fresh AI
coding agent … has NO memory … will see ONLY this document"). The sections are handoff-shaped —
`## Original request` (verbatim), `## Task`, `## Current state`, `## Next steps`,
`## Key files & locations`, `## Gotchas & constraints`, `## How to resume / verify` — rather
than the compaction template's Goal/Progress/Key decisions/Critical context/Relevant files. As
in `/compact`, **user messages are reproduced verbatim** so the human's real ask survives every
handoff; only assistant reasoning degrades.

### 3. Everything else is inherited from naive compaction

The single-`group(digest: handoff)`-over-the-aged-run shape (ADR 0014 §4), the visible-window
90% hysteresis (§2), the aged region = all unprotected blocks (the whole current session while
`tailTokens = 0`) (§3), the recursive amnesiac prompt built from `<previous-handoff>` + only the
newly-aged blocks (§5), the in-flight / stale-completion / attempt-key guards (§6), and the
"wait visibly, no deterministic fallback" degrade path when `can("complete")` is false (§7) are
all reproduced. The handoff is **non-recoverable** (no `{#code FOLDED}` tag) for the same honest
reason: a fresh agent genuinely does not have the originals. The human's recourse remains
**detach**, which freezes the view and inherits the conductor's zero tail into the human's
`protectTokens` so the boundary is stable (ADR 0011 §6).

## Consequences

- **Faithful.** A real fresh-start-with-handoff chain has the same two failure modes as
  `/compact` — lossy (the successor only has what was written down) and recursive-amnesiac (each
  handoff is written from the prior handoff, never the raw sessions behind it) — and the
  conductor reproduces both. It is a stronger case for reversible folding precisely because it
  degrades *despite* best-effort preservation, not from weak prompting.
- **First in-process `tail-size` user.** No shipped in-process conductor previously exercised
  the `tail-size` lock / `tailTokens` plumbing (only test doubles did). The end-to-end
  AccordionStore test asserts the conductor owns no inherited tail while the human baseline
  would keep a 20k tail — differentially, on identical blocks — that `setProtect` is inert
  while attached, and that no `protected` / `invalid-group` / `not-foldable` clamp fires on
  the happy path.
- **Exclusive, so it gates.** Locking all three steering controls triggers the one-time ADR 0011
  consent dialog (which already renders `tail-size` generically — no UI change needed). Some
  users will find the consent + tail-dial takeover heavier than naive compaction's; that is the
  correct, honest cost of a strategy that must own the tail.
- **One registration line.** As with every in-process conductor, the only wiring is the entry in
  `IN_PROCESS_CONDUCTORS` (`conductors/index.ts`), whose `locks` field lets the switcher and
  consent gate read the lock table without instantiating the conductor.

## Scope (this cut)

- Reuses naive compaction's mechanics verbatim rather than extracting a shared base class. The
  two are independent foils and the duplication keeps each readable on its own; a shared
  "LLM-summary conductor" base is a possible later refactor, not a prerequisite.
- No model-spend accounting (`inputTokens`/`outputTokens` are ignored) — a baseline, not a
  production system.
- `tailTokens` is intentionally fixed at `0` for fidelity. A non-zero tuning knob would
  simulate a different, small-tail handoff approximation rather than a literal fresh start.
