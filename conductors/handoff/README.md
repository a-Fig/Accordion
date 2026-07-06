# Handoff (fresh start) conductor

This conductor automatically simulates the user's manual handoff workflow:

1. Ask the current agent to write a handoff document.
2. Clear / kill the current session.
3. Start a fresh session that receives only that handoff document.

The conductor does not create a file. It calls the live model out-of-band with a prompt that
mirrors the local `handoff` skill, except the `mktemp` / save-to-file instruction is replaced by
"output inline" because Accordion inserts the returned text directly into the successor context.

## What it does

- **Writes a real handoff.** The model is asked to summarize the current conversation so a fresh
  agent can continue, suggest useful skills, and reference existing artifacts (PRDs, plans, ADRs,
  issues, commits, diffs) instead of duplicating them.
- **Drops the old session from the agent's perspective.** The handoff is inserted as one folded
  group with a literal digest and no `{#code FOLDED}` recovery tag, so the continuing agent cannot
  `unfold` the killed transcript.
- **Keeps no old-session tail.** The conductor holds the `tail-size` lock with
  `HANDOFF_TAIL_TOKENS = 0`, so every current block is eligible to be folded into the handoff.
  The continuing agent sees the handoff plus only future post-handoff turns.
- **Chains like real handoffs.** Later handoffs are written from the prior handoff plus new work
  only; the raw transcript behind earlier handoffs is intentionally absent.

## How it works

The conductor emits one folded `group` whose digest is the model-written handoff document. It
re-runs when the visible context refills past the high-water mark and there is new work to fold
into an updated handoff.

It holds all three steering locks:

- `human-steering` and `agent-unfold` keep the handoff region from being fought over while the
  conductor is attached.
- `tail-size` with `tailTokens = 0` prevents any verbatim old-session tail from leaking into the
  simulated fresh session.

Because it is exclusive, selecting it triggers the ADR 0011 consent gate. The human's escape hatch
is **detach**, which freezes the current view and returns controls to the user.

## Unavailable model link

If `host.can("complete")` is false (browser dev mode, read-only Claude Code transcript, extension
disconnected), the conductor does not invent a deterministic substitute. It preserves any existing
handoff, leaves new blocks live, and surfaces a "waiting for live model link" status until a model
completion is available.

## Selecting it

Open the Accordion desktop app, load a session, and pick **Handoff (fresh start)** from the
conductor dropdown in the map header. Selection is global — it applies to whatever session is
currently active.

## Limitations

- The agent cannot self-unfold handed-off blocks; that is the point of simulating a killed old
  session. The human can still detach in Accordion to recover the full history.
- Each later handoff depends on the previous handoff plus new work, so omissions can compound.
- Depends on `host.can("complete")`.
- It does not track its own model spend.
