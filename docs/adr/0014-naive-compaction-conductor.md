# ADR 0014 — Naive compaction conductor: a deliberate lossy baseline

**Status:** accepted
**Date:** 2026-06-15 (revised 2026-06-19 — single-group shape)
**Builds on:** [ADR 0007](0007-conductor-protocol.md) (the conductor seam), [ADR
0008](0008-conductor-first-party-one-view.md) (first-party conductors, one public
`ConductorView`), [ADR 0013](0013-conductor-host-capabilities.md) (`ConductorHost.complete`
— the mechanism this conductor depends on for its model call).

## Context

Accordion's reversible folding — content substitution with `{#code FOLDED}` tags, full
agent self-unfold, human-lens folds that the agent never sees permanently — is designed as
an alternative to a different approach that almost every mainstream AI coding tool takes
today: **compaction**, also called context compression.

The compaction approach: when the context approaches capacity, call an LLM to summarize the
old conversation into a prose blob; present the agent the summary in place of the history;
and keep building from there. Cursor's composer, Claude Code's `/compact` command, and
similar tools all do some version of this.

It has two well-understood failure modes:

1. **Lossy by construction.** The agent cannot recover from the summary what the summary
   omitted. If the summarizer dropped a constraint, a file path, or an intermediate result,
   the agent simply does not have it anymore — it will either hallucinate or ask the human
   to re-supply it.
2. **Recursive amnesia.** The second compaction summarizes `[first summary + new history]`
   — it cannot read what the first summary elided. Each successive compaction compounds the
   quality loss; the agent's effective memory degrades monotonically over a long session.

Accordion's folding avoids both: the original blocks are retained in the store; the agent
gets the `{#code FOLDED}` digest and can call `unfold` to restore any block it needs. The
human can also see and restore anything. Nothing is thrown away.

To make that advantage legible — and to have a calibration point for measuring it — the
conductor suite needs a faithful implementation of the approach it is designed to beat.
That is what the naive compaction conductor is for. It reproduces the mainstream behaviour
as closely as possible within the conductor contract, so:

- A developer evaluating context strategies can attach it and observe the failure modes
  directly, in the same UI, at the same session.
- Future quality benchmarks have a concrete "industry baseline" to compare against, rather
  than a vague claim about what other tools do.
- The implementation itself demonstrates what *cannot* be done with reversible folding:
  a conductor that is lossy by design, whose substitutions the agent cannot reverse through
  the `unfold` tool.

## Decision

### 1. Placement: a first-party in-process conductor, not the built-in

`NaiveCompactionConductor` (`conductors/compaction-naive/compaction-naive.ts`) implements
`Conductor` and is registered in `IN_PROCESS_CONDUCTORS` (`conductors/index.ts`) alongside
the built-in and cold-score conductors. It appears in the header switcher automatically.

It uses `attach(host)` and `detach()` from ADR 0013 — `host.complete()` for the model call
and `host.requestRerun()` to re-enter after the async result arrives. No Svelte, no `$state`,
no engine imports; types only from `../contract`.

### 2. Trigger: 90% of the VISIBLE window, sliding-window-style hysteresis

`conduct()` fires on every context change. The conductor only acts when the **visible**
window crosses 90% of budget AND there are newly-aged blocks to fold in. The visible window
is the raw `liveTokens` (the host clears conductor folds before every pass, so it is the
fully-unfolded size — which only grows) minus the token saving the current summary group
provides: `visible = liveTokens − (Σ survivor tokens − summary token cost)`.

This is the same hysteresis computation the sliding-window conductor uses (it tracks its
`dropped` set's token saving against the raw baseline). Without it, a naive
`liveTokens >= 90%` test would re-trigger on every pass once first crossed, because the raw
size never reflects the summary's saving. Compacting the newly-aged blocks drops `visible`
well below 90%, and the conductor HOLDS — re-emitting the existing summary group every pass
— until the window refills to 90%. The high-water mark is 90%; the low water is implicit
(whatever the summary saves), so there is no separate target the way sliding-window's 70%
works — compaction summarizes whatever has newly aged, not a target amount.

Below the mark, or with nothing new aged in, the conductor re-emits whatever commands are
already committed (the summary group) or returns `[]` if nothing has been compacted yet.

### 3. Aged region: everything older than the protected tail, not held, not grouped — ALL kinds

```
for (let i = 0; i < view.protectedFromIndex && i < view.blocks.length; i++) {
    const b = view.blocks[i];
    if (!b.held && !b.grouped) aged.push(b);
}
```

The protected working tail passes through verbatim — its blocks receive no command.
Compacting into the protected tail would destroy the agent's live reasoning, which the
conductor has no business touching. Human-held blocks (`b.held`) are skipped, honouring the
"human overrides always win" rule (ADR 0007). Grouped blocks are skipped to avoid overlap.

**All block kinds are included** — `user`, `text`, `thinking`, `tool_call`, `tool_result`.
The single summary group swallows the whole region; the host's whole-message snap (a group
never splits an assistant message's parts) and `tool_call`/`tool_result` pair-balance keep
the outgoing message provider-valid (a call is never orphaned from its result). This is a
deliberate change from the earlier per-block `replace` design, which left `user` and
`tool_call` blocks live because per-block folds are not wire-representable for those kinds —
a constraint that does not apply to a whole-region group.

### 4. Commands: ONE `group(digest: summary)`, not `replace`

The conductor emits a single `group` command spanning the first to the last compacted
survivor, with the LLM summary as its `digest`:

```
{ kind: "group", ids: [firstSurvivorId, lastSurvivorId], digest: summaryText }
```

This is the same command shape sliding-window uses, but with a non-empty `digest` (the
summary) instead of `null` (drop). The host collapses that contiguous run — snapped outward
to whole messages — into ONE summary message on the wire; every block inside is replaced by
the summary.

This is deliberate. A `fold` command would produce a `{#code FOLDED}` tag the agent could
pass to `unfold`. Using a `group` with a literal digest means **the agent cannot
self-unfold**: there is no fold code for any compacted block. The replaced content is gone
from the agent's perspective; the summary is what it sees. The human can always detach this
conductor (context returns to raw) or switch to the built-in to recover, but the agent
cannot do it through normal means. That asymmetry faithfully reproduces what mainstream
compaction tools do.

`compactedIds` is the monotonic set of block ids already represented by the summary (the
sliding-window `dropped` set's analog — only ever grows within a session). The group covers
`compactedIds ∩ aged region` — the oldest aged blocks, which (because blocks age in order
and `human-steering` keeps the region contiguous) form a single contiguous run. The command
set is re-derived from the LIVE view on every pass, so it stays valid if blocks shift,
vanish (resync/truncation), or re-home across the protected boundary. If a human-held or
grouped block splits the survivors, the conductor emits one group per side (each carrying
the digest) rather than spanning the held block — spanning it would make the host clamp the
whole group `human-override`, dropping the summary for all survivors that pass.

**Provider-validity.** The host's whole-message snap + pair-balance is the sole guard for
tool structure: a group whose every member is a split tool-pair half (its partner sits
outside the range) is refused and those blocks stay live that pass — the same boundary
straggler caveat sliding-window documents. A run whose snapped range reaches into the
protected tail (the boundary lands mid-message) is likewise refused; its blocks stay live
and rejoin when the boundary clears. No data loss: a refused group's blocks simply remain
raw for that pass.

**Exclusive conductor note.** Naive compaction declares `locks: ["human-steering", "agent-unfold"]`.
Selection therefore goes through the ADR 0011 consent gate, and detaching uses the normal
freeze/kill-switch path so the compacted summary view remains in place for budget safety.
`human-steering` is load-bearing for the single-group shape: under the lock the human cannot
pin or group a block inside the aged region, so the region stays contiguous and the one
`group` command covering it is always valid.

### 5. Recursive amnesia: the compaction prompt is built from the summary, not the originals

On the first compaction, `buildPrompt(newlyAged)` wraps the text of every newly-aged block
(labeled by role/kind) in a `<conversation>` tag, followed by a one-line "Create a
structured summary …" preamble. The format spec itself lives in `COMPACTION_SYSTEM` and is
identical for both passes.

On subsequent compactions, `buildPrompt` emits:

```
<previous-summary>
<this.summary>
</previous-summary>

<conversation>
<newlyAged blocks>
</conversation>

Update the summary in <previous-summary> using the new conversation history in
<conversation>. PRESERVE all still-relevant details …; remove stale ones; merge in new
facts. … Carry forward every verbatim user message from the previous summary and append
the new user messages from the conversation …
```

The original blocks already compressed into the prior summary are **never re-read**. The
conductor uses `compactedIds` to track which ids are already represented and only passes
`newlyAged` (blocks not in `compactedIds`) to the prompt. Each compaction sees only
`[prior summary + newly aged]` — exactly the compounding quality decay the design comment
calls "recursive amnesia." This is the point: it faithfully reproduces the failure mode
that Accordion's reversible approach is designed to avoid.

The explicit PRESERVE/merge instructions do **not** mitigate that amnesia — the originals
are gone and no prompt can recover them. They exist to stop a distinct prompt defect: a
model that, faced with two inputs, summarizes only the new blocks and silently drops the
prior summary. Real tools (pi's `UPDATE_SUMMARIZATION_PROMPT`, OpenCode's update branch)
carry the same preserve/merge wording, so the foil does too. A baseline that degrades
*despite* best-effort preservation is a stronger case for Accordion than one that degrades
from weak prompting.

**User messages are the exception.** The system prompt instructs the model to reproduce
every user message VERBATIM in a dedicated section (Claude-Code `/compact` behaviour). User
intent was baked verbatim into the prior summary, so it survives intact across compactions;
only assistant reasoning compounds loss. This keeps the foil honest about *what* mainstream
compaction loses (assistant reasoning) versus what it preserves (user intent).

### 6. In-flight guard and retry prevention

The conductor holds one `AbortController` in `this.inflight` while a completion is running.
`conduct()` returns `this.emitSummaryGroup(view)` (null/hold on the first trip if there is
no summary yet) while inflight is set, preventing a second model call from launching before
the first resolves.

After a failed completion (the promise rejects), `lastAttemptKey` remains keyed to the set of
newly aged ids that triggered the attempt. On the next `conduct()` call, the conductor only
launches again if that key changes — i.e. genuinely new blocks have aged in. This prevents a
tight model-hammering loop on a persistent failure; the conductor retries when there is new
work to do, not merely because the context is still over budget.

`detach()` aborts any in-flight completion so stale results do not call `host.requestRerun()`
after the conductor is detached.

### 7. Unavailable model link when `can("complete")` is false

When there is no live model link (`host.can("complete")` returns false), the conductor
does not silently switch strategies:

- If `this.summary !== null`, the existing summary group is re-emitted unchanged.
  Newly-aged blocks stay live until the model link recovers.
- If `this.summary === null`, it returns `[]` (raw) and launches no completion.
- In both cases it calls `host.setStatus("Naive compaction unavailable — waiting for live
  model link", ...)` so the limitation is visible in the normal conductor status strip.

There is intentionally no deterministic fallback. Naive compaction is the LLM-summary
baseline; substituting a host-generated group digest would hide that the proving use case is
unavailable and would introduce a second strategy under the same selector.

### 8. System prompt for the compaction call

The model is given a structured `COMPACTION_SYSTEM` prompt. It opens with a "do NOT
continue the conversation" guard (pi's `SUMMARIZATION_SYSTEM_PROMPT` convention) so the
model summarizes rather than answering. Its first, sacred rule — lifted from Claude Code's
`/compact` — is that **user messages are reproduced VERBATIM** in a dedicated `## User
messages` section; only assistant text/thinking/tool calls/tool results are summarized. The
output is then structured into sections: User messages, Goal, Progress, Key decisions, Next
steps, Critical context, and Relevant files (the file section mirrors OpenCode; pi tracks
files via XML tags). Empty sections are kept with a `(none)` placeholder. The output is
capped at `MAX_SUMMARY_TOKENS = 8000` tokens — sized for the ~20k–200k-token spans this
conductor compacts (1.5k was far too tight). The extension clamps the requested max to the
model's own max-output ceiling before sending; the model enforces it as a hard generation
cap. If the summary would exceed that ceiling, the output is truncated (finish-reason
"length") and used as-is — acceptable for a lossy baseline.

## Consequences

**What this adds.** A first-party reference implementation of industry-standard compaction,
slot-compatible with every other conductor in the switcher. A developer can switch from
the built-in to naive compaction mid-session and observe the degradation directly. Future
quality benchmarks have a named, reproducible baseline.

**What it proves about reversibility.** The existence of a conductor that faithfully
reproduces irreversible compaction (via a `group` with a literal digest, no `{#code FOLDED}`
tags, deliberate recursive amnesia) demonstrates that the conductor contract is expressive
enough to represent strategies the host does not endorse. The contract does not force
reversibility — it just keeps the *option* of reversibility available to conductors that
want it.

**The human can always recover.** Detaching the conductor (switching to "none" or the
built-in via the header switcher) returns the context to raw — the original blocks are in
`AccordionStore.blocks`, untouched. The conductor's `group` is host-side overlay state; no
block is ever removed from the store. This is the Accordion safety net, but the agent
itself has no path to it.

**Known characteristics.**

- **All kinds are swallowed.** `user`, `text`, `thinking`, `tool_call`, and `tool_result`
  blocks in the aged region are all covered by the single summary group. The host's
  pair-balance keeps a tool call wired to its result; neither is orphaned.
- **User messages survive verbatim; assistant reasoning compounds loss.** The system prompt
  bakes user messages word-for-word into the summary, so they persist across compactions.
  Assistant text/thinking/tool content is summarized and, on the next compaction, only the
  prior summary is re-read — the amnesia the foil exists to exhibit.
- **First compaction holds state (returns `null`).** Before the first summary completes,
  `emitSummaryGroup(view)` returns `null` (no summary). The host holds the last applied
  state, which is raw. The aged region remains live until the first summary commits. This is
  correct: the conductor cannot produce a summary it hasn't computed yet.
- **Unavailable completion is visible, not hidden.** When `host.can("complete")` is false,
  the conductor preserves any existing LLM summary, leaves newly-aged blocks live, and uses
  `host.setStatus(...)` to tell the human it is waiting for a live model link. It does not
  switch to deterministic grouping under the same selector.
- **No self-unfold path.** The agent cannot call `unfold` to recover a compacted block. The
  `group`'s literal digest carries no `{#code FOLDED}` tag. This is the entire point of the
  conductor's existence as a foil.
- **Boundary stragglers.** A run whose whole-message snap reaches into the protected tail, or
  whose every member is a split tool-pair half, is refused by the host; those blocks stay
  live that pass and rejoin when the boundary clears. No data loss — matches sliding-window.

## Scope (this cut)

- No streaming of the summary as it generates — the host receives the full text on
  completion.
- No per-section quality heuristics or re-summarization on failure.
- No automatic re-attach after a persistent model error; the human must re-select the
  conductor.
- No deterministic fallback: if completion is unavailable, the conductor waits visibly for
  the live model link instead of producing a host-generated group digest.
- No model-spend accounting (`inputTokens`/`outputTokens`) — this is a baseline, not a
  production system.
