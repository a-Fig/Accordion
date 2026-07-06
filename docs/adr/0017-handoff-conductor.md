# ADR 0017 — Handoff conductor: simulating a fresh start with a handoff

**Status:** accepted
**Date:** 2026-07-05
**Builds on:** [ADR 0007](0007-conductor-protocol.md) (the conductor seam), [ADR
0008](0008-conductor-first-party-one-view.md) (first-party conductors, one public
`ConductorView`), [ADR 0011](0011-conductor-involvement-locks.md) (involvement locks — the
`tail-size` lock this conductor holds), [ADR 0013](0013-conductor-host-capabilities.md)
(`ConductorHost.complete` — the model call this conductor depends on).

## Context

Developers often recover from an overgrown coding session with a simple manual workflow:

1. Ask the current agent to write a handoff document.
2. Kill / clear the current session.
3. Open a fresh session and paste in the handoff document.
4. Continue from that handoff and nothing else.

Issue #24 asks for a conductor that simulates that workflow automatically. The fidelity test is
straightforward: after the handoff, the continuing agent must not see a verbatim tail from the old
session. It should see the handoff document plus only future post-handoff turns.

## Decision

Ship a first-party in-process conductor, `conductors/handoff/handoff.ts` (`HandoffConductor`,
label "Handoff (fresh start)"), that automates the manual handoff workflow.

### 1. The conductor owns a zero inherited tail

The conductor declares `locks = ["human-steering", "agent-unfold", "tail-size"]` and
`tailTokens = HANDOFF_TAIL_TOKENS` (`0`). Under the `tail-size` lock (ADR 0011 §7), the host
drives `protectedFromIndex` from the conductor's `tailTokens` instead of the human's
`protectTokens`. With `target === 0`, the host protects nothing (`protectedFromIndex =
blocks.length`), so the whole current conversation is eligible for the handoff group.

This is required for fidelity. Any non-zero tail would leak raw old-session context into the
supposed fresh session.

### 2. The model is prompted like the local `handoff` skill

The conductor uses `ConductorHost.complete` to ask the live model to write the handoff document.
The prompt mirrors the local `handoff` skill:

- write a handoff document summarising the current conversation so a fresh agent can continue;
- suggest skills to use in the next session;
- do not duplicate content already captured in artifacts such as PRDs, plans, ADRs, issues,
  commits, or diffs; reference those artifacts by path or URL instead;
- if focus arguments exist, use them to tailor the handoff.

The only adaptation is that the conductor asks for inline output instead of saving to a
`mktemp` path, because Accordion inserts the returned text directly into the successor context.

### 3. The handoff is non-recoverable to the agent

The returned handoff document is applied as one folded group digest. The digest does not include a
`{#code FOLDED}` recovery tag, so the continuing agent cannot unfold the killed transcript. That
matches the manual workflow: the fresh session has no access to the old session.

The human can still **detach** in Accordion to recover the full history. That is Accordion's UI
escape hatch, not part of the simulated agent workflow.

### 4. Repeated handoffs chain like real handoffs

After a handoff exists, later handoffs are written from the prior handoff plus newly accumulated
work only. The original raw transcript behind earlier handoffs is intentionally absent, matching a
real chain of handoff documents.

## Consequences

- **Faithful fresh-start behavior.** The continuing agent sees the handoff document and future
  turns, not a protected tail from the old session.
- **First in-process `tail-size` user.** This exercises the `tail-size` lock / `tailTokens`
  plumbing in a shipped conductor. Tests assert the zero-tail boundary, that the human tail dial
  is inert while attached, and that the happy path avoids protected / invalid-group / not-foldable
  clamps.
- **Exclusive, so it gates.** Locking all three steering controls triggers the ADR 0011 consent
  gate. The human's recourse is detach.
- **Model-link dependent.** If `host.can("complete")` is false, the conductor waits visibly rather
  than inventing a deterministic substitute for a handoff written by the agent.

## Scope

- No file is created; the handoff text is inline because it becomes the replacement context.
- No model-spend accounting (`inputTokens` / `outputTokens` are ignored).
- `tailTokens` is intentionally fixed at `0`; a non-zero tuning knob would simulate a different
  small-tail workflow rather than this handoff workflow.
