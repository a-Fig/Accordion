# Naive compaction conductor

**An intentional baseline / foil — not a recommendation.**

This conductor reproduces the context-management strategy that most AI coding tools use
today (Cursor composer, Claude Code `/compact`, and similar): when the context approaches
capacity, call an LLM to produce a structured prose summary of the aged history, and
present the agent that summary instead of the real conversation. It exists in Accordion so
the behaviour can be observed, measured, and compared directly against reversible folding.

## What it is (and is not)

`compaction-naive` is **deliberately lossy and recursive**. It is the foil that Accordion's
reversible folding is designed to beat — not a conductor to reach for in practice.

- **Lossy.** The original blocks are replaced by generated text. There is no `{#code FOLDED}`
  tag on the summary, so the agent cannot call `unfold` to recover the originals. From the
  agent's perspective the history is gone — faithfully reproducing mainstream tool behaviour.
  The human can detach this conductor and see the full history again (that is Accordion being
  Accordion), but the agent cannot.

- **Recursive / amnesiac.** Each subsequent compaction summarizes the **prior summary** plus
  only the newly aged blocks. The original blocks already compressed into a prior summary are
  deliberately *not* re-read. This compounds quality loss over a session: turn 3's summary
  cannot undo information lost in turn 1's summary, so errors and omissions accumulate. This
  is the exact failure mode that reversible folding avoids.

See [ADR 0013](../../docs/adr/0013-conductor-host-capabilities.md) (host capabilities) and
[ADR 0014](../../docs/adr/0014-naive-compaction-conductor.md) (the foil rationale) for background.

## How it works

**Trigger:** when `liveTokens ≥ 95 %` of the token budget.

**Aged region:** blocks older than the host's protected working tail (`protectedFromIndex`)
that are not human-held, not already inside a conductor group, and not `tool_call`. `user`
blocks may be included in the summary prompt for context, but remain live because they are not
wire-foldable replace targets. The protected tail always passes through verbatim — compacting
live reasoning would destroy the agent's current work.

**Compaction pass (model available):**

1. The conductor detects new aged blocks (not yet summarized) and launches a background
   `host.complete()` call with a structured compaction system prompt and the aged content as
   the user-role message.
2. `conduct()` returns immediately with the last applied commands (or `null` on the very
   first call) — it never blocks.
3. When the completion resolves, the conductor:
   - Replaces the **oldest wire-foldable aged block** (the "head": `text`, `thinking`, or
     `tool_result`) with the summary text, prefixed by a count tag:
     `[Compacted summary of N earlier messages]`.
   - Replaces every other wire-foldable aged block with `""` (empty content — structurally in
     place, so pairing is intact). `user` and `tool_call` blocks are never replace targets;
     they stay live. The host also clamps such commands as `not-foldable`, but the conductor
     avoids emitting them so the summary head cannot be clamped away while other empty
     replaces apply.
   - Calls `host.requestRerun()` to schedule a fresh `conduct()` pass that emits those
     commands immediately.

**Recursive path:** if a prior summary already exists, the compaction prompt is:

```
=== PRIOR SUMMARY (previous compaction output) ===
<prior summary text>

=== NEWLY ADDED MESSAGES (append to the above) ===
<newly aged blocks>
```

The originals already compressed into the prior summary are intentionally absent — the
conductor only sees what was previously fed to the LLM, not the raw history. This is the
recursive amnesia at the centre of the baseline.

**Unavailable model link:** if `host.can("complete")` returns `false` (browser dev mode,
read-only Claude Code transcript session, or extension disconnected), the conductor does
**not** fall back to deterministic grouping. It preserves any existing LLM summary, leaves
newly-aged blocks live, and surfaces a visible "waiting for live model link" status until
completion is available again.

## Selecting it

Open the Accordion desktop app, load a session, and pick **Naive compaction** from the
conductor dropdown in the map header. Selection is **global** — it applies to whatever
session is currently active. Switch back to **Built-in** (or any other conductor) at any
time to return to reversible folding and recover the full visible history in Accordion's UI.

## The system prompt

The compaction system prompt asks for a structured briefing in five sections: **Goal**,
**Progress**, **Key decisions**, **Next steps**, and **Critical context**. Output is capped
at 8 000 tokens (`MAX_SUMMARY_TOKENS`) — sized for the 20k–200k-token spans this conductor
compacts. The extension clamps the request to the model's own max-output ceiling, and the
model enforces it as a hard cap (over-long output is truncated, not rejected).

## Limitations (by design)

- The agent **cannot self-unfold** any compacted block — no fold codes are emitted.
- **Compounding amnesia** — each compaction only reads the prior summary + new content; errors
  introduced in an early summary persist and compound.
- Depends on **`host.can("complete")`** — unavailable in browser dev mode and read-only sessions.
- `user` and `tool_call` blocks are left live and are never targeted by a replace command.
  The host's apply layer independently clamps them as `not-foldable`; the conductor avoids
  them so a clamped summary head cannot cause data loss.
- The conductor is **exclusive**: it declares `human-steering` and `agent-unfold` locks while
  attached, so the normal ADR 0011 consent gate and detach freeze/kill-switch behaviour apply.
- The conductor **does not track its own model spend** (no `inputTokens`/`outputTokens`
  accounting) — this is a baseline, not a production system.
