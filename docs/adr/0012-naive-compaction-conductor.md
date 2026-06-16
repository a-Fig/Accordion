# ADR 0012 — Naive compaction conductor: a deliberate lossy baseline

**Status:** accepted
**Date:** 2026-06-15
**Builds on:** [ADR 0007](0007-conductor-protocol.md) (the conductor seam), [ADR
0008](0008-conductor-first-party-one-view.md) (first-party conductors, one public
`ConductorView`), [ADR 0011](0011-conductor-host-capabilities.md) (`ConductorHost.complete`
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

It uses `init(host)` and `dispose()` from ADR 0011 — `host.complete()` for the model call
and `host.invalidate()` to re-enter after the async result arrives. No Svelte, no `$state`,
no engine imports; types only from `../contract`.

### 2. Trigger: 95% of the token budget

`conduct()` fires on every context change. The conductor only acts when
`liveTokens >= 0.95 * view.budget`. Below that threshold it re-emits whatever commands are
already committed (the `currentCommands()` helper) or returns `[]` if nothing has been
compacted yet. This matches the "context is almost full — summarize now" semantics that
tools like Cursor use, and avoids unnecessary model calls during normal turns.

### 3. Aged region: everything older than the protected tail, not held, not grouped

```
for (let i = 0; i < view.protectedFromIndex && i < view.blocks.length; i++) {
    if (!b.held && !b.grouped) agedBlocks.push(b);
}
```

The protected working tail passes through verbatim — its blocks receive no `replace` command.
Compacting into the protected tail would destroy the agent's live reasoning, which the
conductor has no business touching. Human-held blocks (`b.held`) are also skipped, honouring
the "human overrides always win" rule (ADR 0007).

### 4. Commands: `replace`, not `fold`

The conductor emits **`replace`** commands, not `fold`:

- The oldest aged block (the "head") gets `replace(headId, summaryText)` — it carries the
  summary prose.
- Every other aged block gets `replace(id, "")` — it stays structurally in place (no
  block is ever removed; `tool_call`/`tool_result` pairing is intact) but contributes
  (almost) nothing to the token count.

This is deliberate. A `fold` command would produce a `{#code FOLDED}` tag that the agent
could pass to the `unfold` tool. Using `replace` instead means **the agent cannot
self-unfold**. The replaced content is gone from the agent's perspective; the summary is
what it sees. The human can always detach this conductor (context returns to raw) or switch
to the built-in to recover, but the agent cannot do it through normal means. That asymmetry
faithfully reproduces what mainstream compaction tools do.

**Provider-validity note.** Emptying a `tool_call` block via `replace(id, "")` may trip
the host's provider-validity floor (some providers require a `tool_call` to have a
matching `tool_result`). The host clamps those commands to a safe form and returns
`ClampReport`s. This is expected and safe for this baseline — the conductor does not track
clamp reports, and the host's clamping is the documented safety net (ADR 0007).

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
`conduct()` returns `this.currentCommands()` (null on the first trip — hold/raw) while
inflight is set, preventing a second model call from launching before the first resolves.

After a failed completion (the promise rejects), `lastLaunchedAgedIds` is NOT cleared. On
the next `conduct()` call, `newlyAged.filter(b => !compactedIds.has(b.id))` will only be
non-empty if genuinely new blocks have been added since the failure. This prevents a tight
model-hammering loop on a persistent failure — the conductor only retries when there is
new work to do, not just because the context is still over budget.

`dispose()` aborts any in-flight completion so stale results do not call `host.invalidate()`
after the conductor is detached.

### 7. Degradation when `can("complete")` is false

When there is no live model link (`host.can("complete")` returns false), the conductor
behaviour depends on whether a prior LLM summary exists:

- **If `this.summary !== null`:** the existing summary commands are re-emitted unchanged.
  Clobbering a successful LLM summary with a host-generated group digest on a transient
  model-link drop would replace richer prose with a lower-quality fallback and leave
  internal state inconsistent. Instead the conductor preserves the summary and waits for
  the link to recover; newly-aged blocks stay live in the meantime.
- **If `this.summary === null` (no prior summary):** the conductor falls back to a
  deterministic `group` command spanning the first-to-last aged block:

  ```typescript
  return [{ kind: "group", ids: [firstId, lastId] }];
  ```

  This collapses the aged region into a host-generated group digest without any LLM call,
  keeping the conductor useful in read-only contexts, browser dev mode, and Claude Code
  transcript sessions.

**Edge case.** The group fallback emits a command only when `agedBlocks.length >= 2`
(groups require at least two members) and no interleaved grouped block sits between the
first and last aged block (which would cause an `invalid-group` clamp). With fewer than
two aged blocks, or with interleaved grouped blocks, the conductor returns `[]`.

### 8. System prompt for the compaction call

The model is given a structured `COMPACTION_SYSTEM` prompt asking for output in exactly
five sections: Goal, Progress, Key decisions, Next steps, Critical context. This mirrors
the summary format that Cursor and similar tools have converged on. The output is capped at `MAX_SUMMARY_TOKENS = 1500` tokens. The extension clamps the
requested max to the model's own max-output ceiling before sending; the model enforces it
as a hard generation cap. If the summary would exceed that ceiling, the output is truncated
(finish-reason "length") and used as-is — acceptable for a lossy baseline.

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

- **Provider-validity clamps on `tool_call` empties.** When the conductor empties a
  `tool_call` block's content, the host's provider-validity floor may clamp the op and
  return a `ClampReport`. The conductor does not track these. This is expected and safe —
  the clamp ensures the message stays sendable, and the summary on the head block still
  represents the overall aged region adequately for the baseline.
- **First compaction holds state (returns `null`).** Before the first summary completes,
  `currentCommands()` returns `null` (no summary, no head). The host holds the last
  applied state, which is raw. The aged region remains live until the first summary
  commits. This is correct: the conductor cannot produce a summary it hasn't computed yet.
- **The degrade-path group range may widen.** On a second degrade call, `agedBlocks`
  (blocks not held and not grouped) may include blocks that the *first* degrade call's
  `group` command put into a group overlay — those blocks now appear `grouped: true` in the
  view, so they are excluded from `agedBlocks`, narrowing the degrade group. This can leave
  a gap between the group's span and the new agedBlocks span. Documented but not fixed; the
  degrade path is best-effort.
- **No self-unfold path.** The agent cannot call `unfold` to recover a compacted block.
  The `replace` content does not carry a `{#code FOLDED}` tag. This is the entire point of
  the conductor's existence as a foil.

## Scope (this cut)

- No streaming of the summary as it generates — the host receives the full text on
  completion.
- No per-section quality heuristics or re-summarization on failure.
- No automatic re-attach after a persistent model error; the human must re-select the
  conductor.
- The degrade path produces a host-generated group digest, not a model-generated summary —
  it is a structural fallback, not a quality-preserving one.
