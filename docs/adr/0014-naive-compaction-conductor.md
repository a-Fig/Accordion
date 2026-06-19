# ADR 0014 — Naive compaction conductor: a deliberate lossy baseline

**Status:** accepted
**Date:** 2026-06-15
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

### 2. Trigger: 95% of the token budget

`conduct()` fires on every context change. The conductor only acts when
`liveTokens >= 0.95 * view.budget`. Below that threshold it re-emits whatever commands are
already committed (via `buildCommands(view)`) or returns `[]` if nothing has been
compacted yet. This matches the "context is almost full — summarize now" semantics that
tools like Cursor use, and avoids unnecessary model calls during normal turns.

### 3. Aged region: everything older than the protected tail, not held, not grouped

```
for (let i = 0; i < view.protectedFromIndex && i < view.blocks.length; i++) {
    const b = view.blocks[i];
    if (b.kind !== "tool_call" && !b.held && !b.grouped) agedBlocks.push(b);
}
```

The protected working tail passes through verbatim — its blocks receive no `replace` command.
Compacting into the protected tail would destroy the agent's live reasoning, which the
conductor has no business touching. Human-held blocks (`b.held`) are also skipped, honouring
the "human overrides always win" rule (ADR 0007). `tool_call` blocks are skipped so tool
invocations are never summarized away from their results. `user` blocks may be prompt context,
but they remain live and are never `replace` targets because per-block user folds are not
wire-representable.

### 4. Commands: `replace`, not `fold`

The conductor emits **`replace`** commands, not `fold`:

- The oldest wire-foldable aged block (the "head": `text`, `thinking`, or `tool_result`)
  gets `replace(headId, summaryText)` — it carries the summary prose.
- Every other wire-foldable aged block gets `replace(id, "")` — it stays structurally in
  place (no block is ever removed; `tool_call`/`tool_result` pairing is intact) but
  contributes (almost) nothing to the token count. `user` and `tool_call` blocks stay live.

This is deliberate. A `fold` command would produce a `{#code FOLDED}` tag that the agent
could pass to the `unfold` tool. Using `replace` instead means **the agent cannot
self-unfold**. The replaced content is gone from the agent's perspective; the summary is
what it sees. The human can always detach this conductor (context returns to raw) or switch
to the built-in to recover, but the agent cannot do it through normal means. That asymmetry
faithfully reproduces what mainstream compaction tools do.

**Provider-validity note.** The host's substitution path kind-checks `replace` exactly like
`fold`: `user` and `tool_call` targets are clamped as `not-foldable`. The conductor still
self-enforces the same target set instead of relying on that clamp, because a clamped summary
head plus successfully applied empty replaces would lose the summary. Matching `tool_result`
blocks may still be compacted when safe.

**Exclusive conductor note.** Naive compaction declares `locks: ["human-steering", "agent-unfold"]`.
Selection therefore goes through the ADR 0011 consent gate, and detaching uses the normal
freeze/kill-switch path so the compacted summary view remains in place for budget safety.

### 5. Recursive amnesia: the compaction prompt is built from the summary, not the originals

On the first compaction, `buildPrompt(newlyAged)` concatenates the text of every aged block
labeled by role/kind, under `=== CONVERSATION HISTORY TO SUMMARIZE ===`.

On subsequent compactions, `buildPrompt` includes:

```
=== PRIOR SUMMARY (previous compaction output) ===
<this.summary>

=== NEWLY ADDED MESSAGES (append to the above) ===
<newlyAged blocks>
```

The original blocks already compressed into the prior summary are **never re-read**. The
conductor uses `compactedIds` to track which ids are already represented and only passes
`newlyAged` (blocks not in `compactedIds`) to the prompt. Each compaction sees only
`[prior summary + newly aged]` — exactly the compounding quality decay the design comment
calls "recursive amnesia." This is the point: it faithfully reproduces the failure mode
that Accordion's reversible approach is designed to avoid.

### 6. In-flight guard and retry prevention

The conductor holds one `AbortController` in `this.inflight` while a completion is running.
`conduct()` returns `this.buildCommands(view)` (null/hold on the first trip if there is no
summary yet) while
inflight is set, preventing a second model call from launching before the first resolves.

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

- If `this.summary !== null`, the existing summary commands are re-emitted unchanged.
  Newly-aged blocks stay live until the model link recovers.
- If `this.summary === null`, it returns `[]` (raw) and launches no completion.
- In both cases it calls `host.setStatus("Naive compaction unavailable — waiting for live
  model link", ...)` so the limitation is visible in the normal conductor status strip.

There is intentionally no deterministic `group` fallback. Naive compaction is the LLM
summary baseline; substituting a host-generated group digest would hide that the proving
use case is unavailable and would introduce a second strategy under the same selector.

### 8. System prompt for the compaction call

The model is given a structured `COMPACTION_SYSTEM` prompt asking for output in exactly
five sections: Goal, Progress, Key decisions, Next steps, Critical context. This mirrors
the summary format that Cursor and similar tools have converged on. The output is capped at
`MAX_SUMMARY_TOKENS = 8000` tokens — sized for the ~20k–200k-token spans this conductor
compacts (1.5k was far too tight). The extension clamps the requested max to the model's own
max-output ceiling before sending; the model enforces it as a hard generation cap. If the
summary would exceed that ceiling, the output is truncated (finish-reason "length") and used
as-is — acceptable for a lossy baseline.

## Consequences

**What this adds.** A first-party reference implementation of industry-standard compaction,
slot-compatible with every other conductor in the switcher. A developer can switch from
the built-in to naive compaction mid-session and observe the degradation directly. Future
quality benchmarks have a named, reproducible baseline.

**What it proves about reversibility.** The existence of a conductor that faithfully
reproduces irreversible compaction (via `replace`, no `{#code FOLDED}` tags, deliberate
recursive amnesia) demonstrates that the conductor contract is expressive enough to
represent strategies the host does not endorse. The contract does not force reversibility
— it just keeps the *option* of reversibility available to conductors that want it.

**The human can always recover.** Detaching the conductor (switching to "none" or the
built-in via the header switcher) returns the context to raw — the original blocks are in
`AccordionStore.blocks`, untouched. The conductor's `replace` commands are host-side state;
no block is ever removed from the store. This is the Accordion safety net, but the agent
itself has no path to it.

**Known characteristics.**

- **`tool_call` blocks stay live.** The conductor never emits a `replace` for a
  `tool_call`, because emptying one can orphan the matching `tool_result` for providers
  that validate tool-call structure. This means a very old tool call can remain live while
  surrounding text/thinking/tool-result blocks are compacted.
- **First compaction holds state (returns `null`).** Before the first summary completes,
  `buildCommands(view)` returns `null` (no summary, no head). The host holds the last
  applied state, which is raw. The aged region remains live until the first summary
  commits. This is correct: the conductor cannot produce a summary it hasn't computed yet.
- **Unavailable completion is visible, not hidden.** When `host.can("complete")` is false,
  the conductor preserves any existing LLM summary, leaves newly-aged blocks live, and uses
  `host.setStatus(...)` to tell the human it is waiting for a live model link. It does not
  switch to deterministic grouping under the same selector.
- **No self-unfold path.** The agent cannot call `unfold` to recover a compacted block.
  The `replace` content does not carry a `{#code FOLDED}` tag. This is the entire point of
  the conductor's existence as a foil.

## Scope (this cut)

- No streaming of the summary as it generates — the host receives the full text on
  completion.
- No per-section quality heuristics or re-summarization on failure.
- No automatic re-attach after a persistent model error; the human must re-select the
  conductor.
- No deterministic fallback: if completion is unavailable, the conductor waits visibly for
  the live model link instead of producing a host-generated group digest.
