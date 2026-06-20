# Naive compaction conductor

**An intentional baseline / foil — not a recommendation.**

This conductor reproduces the context-management strategy that most AI coding tools use
today (Cursor composer, Claude Code `/compact`, and similar): when the context approaches
capacity, call an LLM to produce a structured prose summary of the aged history, and
present the agent that single summary IN PLACE of the whole aged region. It exists in
Accordion so the behaviour can be observed, measured, and compared directly against
reversible folding.

## What it is (and is not)

`compaction-naive` is **deliberately lossy and recursive**. It is the foil that Accordion's
reversible folding is designed to beat — not a conductor to reach for in practice.

- **Lossy.** The aged blocks are collapsed into ONE group whose digest is the generated
  summary. There is no `{#code FOLDED}` tag on the summary, so the agent cannot call
  `unfold` to recover the originals. From the agent's perspective the history is gone —
  faithfully reproducing mainstream tool behaviour. The human can detach this conductor and
  see the full history again (that is Accordion being Accordion), but the agent cannot.

- **Recursive / amnesiac.** Each subsequent compaction summarizes the **prior summary** plus
  only the newly aged blocks. The original blocks already compressed into a prior summary are
  deliberately *not* re-read. This compounds quality loss over a session: turn 3's summary
  cannot undo information lost in turn 1's summary, so errors and omissions accumulate. This
  is the exact failure mode that reversible folding avoids.

See [ADR 0013](../../docs/adr/0013-conductor-host-capabilities.md) (host capabilities) and
[ADR 0014](../../docs/adr/0014-naive-compaction-conductor.md) (the foil rationale) for background.

## How it works

This conductor is a close cousin of the **sliding-window** conductor. Where sliding-window
emits `group(digest: null)` (DROP the aged run from the wire) to keep a live window under
budget, naive compaction emits `group(digest: <LLM summary>)` (REPLACE the aged run with one
summary message). Same single-group-over-the-aged-run shape; only the digest differs.

**Trigger — sliding-window-style hysteresis.** `view.liveTokens` is the RAW, fully-unfolded
size (the host clears conductor folds before every pass), so it only grows; a naive
`liveTokens >= 90%` test would re-trigger on every pass once first crossed. Instead the
conductor tracks the token SAVING its summary group provides and triggers on the VISIBLE
window: `visible = liveTokens − (Σ survivor tokens − summary token cost)`. Compaction fires
when `visible >= 90%` of budget AND there are newly-aged blocks to fold in; otherwise it
HOLDS, re-emitting the existing summary group. Compacting the newly-aged blocks drops
`visible` well below 90%, and the conductor waits for the window to refill before acting
again — the same high-water band sliding-window uses.

**Aged region.** Every block older than the host's protected working tail
(`protectedFromIndex`) that is not human-held and not already inside a group. **All kinds**
are included — `user`, `text`, `thinking`, `tool_call`, `tool_result` — because the single
summary group swallows the whole region and the host's whole-message snap + pair-balance
keeps the result wire-valid (a tool call is never orphaned from its result). The protected
tail always passes through verbatim — compacting live reasoning would destroy the agent's
current work.

**Compaction pass (model available):**

1. The conductor detects newly-aged blocks (not yet summarized) and launches a background
   `host.complete()` call with a structured compaction system prompt and the aged content as
   the user-role message. `conduct()` returns immediately — it never blocks.
2. When the completion resolves, the conductor stores the summary (prefixed by a count tag:
   `[Compacted summary of N earlier messages]`) and the monotonic `compactedIds` set of
   blocks it now represents, then calls `host.requestRerun()`.
3. The next `conduct()` pass emits ONE `group` command spanning the first to the last
   compacted survivor, with the summary as its `digest`. The host collapses that run into a
   single summary message on the wire. No `replace`/`fold` commands are emitted — the group
   is the sole command shape.

**Recursive path:** if a prior summary already exists, the compaction prompt wraps the two
inputs in XML tags and gives explicit merge instructions:

```
<previous-summary>
<prior summary text>
</previous-summary>

<conversation>
<newly aged blocks>
</conversation>

Update the summary in <previous-summary> using the new conversation history in
<conversation>. PRESERVE all still-relevant details …; remove stale ones; merge in new
facts. … Carry forward every verbatim user message from the previous summary and append
the new user messages from the conversation — all still reproduced word-for-word in
"## User messages".
```

The originals already compressed into the prior summary are intentionally absent — the
conductor only sees what was previously fed to the LLM, not the raw history. This is the
recursive amnesia at the centre of the baseline. The merge instructions do NOT mitigate
that amnesia (the originals are gone, unfixable by any prompt); they only stop the model
from silently dropping the prior summary — a prompt defect, not the structural loss the
foil demonstrates.

**User messages are preserved verbatim.** The system prompt instructs the model to reproduce
every user message word-for-word in a dedicated `## User messages` section (Claude-Code
`/compact` behaviour). Human intent and instructions therefore survive compaction intact
across the whole session; only assistant reasoning degrades. This is the faithful foil:
mainstream tools lose assistant reasoning to compounding amnesia, while user intent is kept.

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

The compaction system prompt opens with a "do NOT continue the conversation" guard (so the
model summarizes rather than answers), then states its sacred rule first — **user messages
reproduced verbatim** — followed by the structured sections: **User messages**, **Goal**,
**Progress**, **Key decisions**, **Next steps**, **Critical context**, and **Relevant
files**. Empty sections are kept with a `(none)` placeholder so the structure stays
parseable. The shape mirrors what mainstream tools converge on (pi, OpenCode, Claude Code
`/compact`), keeping the foil faithful rather than a strawman. Output is capped at 8 000
tokens (`MAX_SUMMARY_TOKENS`) — sized for the 20k–200k-token spans this conductor compacts.
The extension clamps the request to the model's own max-output ceiling, and the model
enforces it as a hard cap (over-long output is truncated, not rejected).

## Limitations (by design)

- The agent **cannot self-unfold** any compacted block — the `group` carries a literal
  digest, no fold codes are emitted.
- **Compounding amnesia** — each compaction only reads the prior summary + new content; errors
  introduced in an early summary persist and compound. (User messages are the exception: they
  are baked verbatim into the summary and so survive.)
- Depends on **`host.can("complete")`** — unavailable in browser dev mode and read-only sessions.
- All block kinds (including `user` and `tool_call`) are swallowed by the summary group. The
  host's whole-message snap + tool-call/result pair-balance keeps the outgoing message
  provider-valid; a group whose every member is a split tool-pair half is refused and those
  blocks stay live that pass (the same boundary straggler caveat sliding-window documents).
- A human-held or grouped block splitting the aged region yields one summary group per side
  (each carrying the digest) rather than a single tile — an edge case the `human-steering`
  lock prevents during normal operation.
- The conductor is **exclusive**: it declares `human-steering` and `agent-unfold` locks while
  attached, so the normal ADR 0011 consent gate and detach freeze/kill-switch behaviour apply.
  `human-steering` is load-bearing for the single-group shape: under the lock the human cannot
  pin or group a block inside the aged region, so the region stays contiguous and the one
  `group` command covering it is always valid.
- The conductor **does not track its own model spend** (no `inputTokens`/`outputTokens`
  accounting) — this is a baseline, not a production system.
