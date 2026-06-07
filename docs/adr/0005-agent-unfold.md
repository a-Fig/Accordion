# ADR 0005 — Agent self-unfold: fold tags, the unfold tool, and the context-folding skill

**Status:** accepted (Milestone 3, first cut)
**Date:** 2026-06-06
**Builds on:** [ADR 0004](0004-engine-on-fold-toggle.md) (engine-on toggle / opt-in live
folding), [ADR 0003](0003-responsive-block-streaming.md) (durable ids — the block id
scheme `unfold` depends on entirely).

## Context

M2 (ADR 0004) turned the engine on: Accordion can fold a live agent's context, and the
human can see the fold state in the GUI. The agent, however, is passive — it receives
folded content but has no way to signal it needs something back. If the agent needs an
exact value or decision that is now folded, it either hallucinates or asks the human to
intervene.

M3 closes that gap. The agent gains two things: a reliable way to *recognize* that a
block has been folded (the fold tag, in `digest()`), and a tool to request restoration
(`unfold`). Together these let the agent recover specific blocks by its own judgment,
without breaking the human's oversight or the engine's single-source-of-truth property.

## Decision

### 1. Fold tag in `digest()` — one source of truth

Every folded block's digest begins with:

```
{#<code> FOLDED}
```

where `<code>` is a short stable handle for the block (e.g. `{#3f9a FOLDED}`, `{#0a2c
FOLDED}`). The tag is produced by the engine's `digest()`, which is already the single
function computing what a folded block collapses to. A short human-readable summary
follows the tag on the same line.

This placement has two consequences. First, the GUI renders exactly the same string the
agent receives — there is no separate "agent wire" representation. Second, token
accounting includes the tag: the tokens saved by folding are measured against the actual
digest the agent sees, including the tag overhead (~4 tokens per block). Both properties
are structural — they cannot drift because there is only one code path.

**Caveat (the armed/disarmed distinction):** "the GUI shows exactly what the agent sees"
holds in the *armed* (steering) path. When folding is *disarmed* (preview — ADR 0004),
`computePlan` returns an empty plan, so the agent receives full content while the GUI
still renders the previewed digest *with* its `{#… FOLDED}` tag. That is the intended
meaning of preview ("here is what we would send"), not a source-of-truth violation — but
note the tag in the disarmed view is a what-if, not a fact about the current model call.

**Rejected: wire-only tag** (insert the tag only when serializing messages to the
`context` hook, not in `digest()`). This would make the GUI show a digest without the
tag while the agent receives one with it — Accordion's on-screen view would diverge from
what the model actually sees, which is exactly what "source of truth" must prevent. Token
savings would also be miscounted (the GUI would omit the ~10 tag tokens from its
estimate).

### 2. The handle is a short *hash* of the durable id — stateless, readable

`<code>` is a 4-char base36 hash of the block's durable id (FNV-1a → base36, last 4
chars), computed by `foldCode(id)` in `digest.ts`. It is a **pure function of the id**:
no counter, no per-session map, no reset wiring, and globally stable (the same block
yields the same code in every session). `unfold` resolves a code back to the block(s)
that hash to it.

This decision was made *after* the raw-id version was tried live. A durable id is a UUID
or millisecond timestamp — `{#a:f2965ed9-323d-4c24-b489-d93e8c55c59e:p0 FOLDED}` — ~50
characters of line-noise repeated on every folded block. Unusable. The hash keeps the
single-source-of-truth property (still derived in `digest()`, still what the GUI shows
and token-accounts) while being short and readable.

**Collisions** are handled by resolution, not avoidance: `resolveUnfold` restores EVERY
folded block whose code matches the requested one. A 4-char base36 space (~1.68M) makes
collisions rare (birthday ≈1% even at ~200 folded blocks), and the consequence of one is
merely that two blocks restore together — harmless, since unfolding only ever shows the
model more of its own content. This keeps `foldCode` a pure function (no "codes already
issued" registry).

**Rejected: the raw durable id as the handle.** Correct and absolutely stable, but the
id is a UUID/timestamp — far too long and noisy to repeat on every folded block (tried
live; rejected on sight).
**Rejected: a short ordinal map** (`#1 → <id>`, assigned on first fold). Clean numbers,
but needs per-session state, careful assignment across re-folds, and reset-on-attach
wiring — and the numbering isn't globally stable. The hash gets the brevity with none of
the state.
**Rejected: a raw id *suffix*** (last N chars). Stateless too, but for `u:`/`s:` blocks
the id tail is a timestamp whose low digits cluster, so suffixes collide unevenly; a hash
spreads uniformly across all id kinds and lets us tune the length.

### 3. `unfold` tool — state change only, content returns next turn

The Accordion extension registers a pi tool named `unfold`. Signature:

```
unfold({ids: string[]})   // each entry is a fold code from a {#<code> FOLDED} tag
```

The agent passes code(s) read from the `{#<code> FOLDED}` tags (a purely numeric code may
be passed as a number; the tool coerces it). "GUI drives, extension is thin": the
extension relays the request over the wire (`unfoldRequest{codes}`); the **GUI** resolves
each code to its folded block(s) and marks them unfolded with provenance `"agent"` and
override `"unfolded"` (sticky — protected from auto-refold), then replies
(`unfoldResult`). The tool result is a confirmation of what was scheduled; it does NOT
echo the full block content back in the tool result.

The restored content returns to the agent on its **next turn** via the normal mechanism:
its past context changes (the block drops out of the fold plan), so the next `context`
hook delivers the unfolded content in place of the digest. The agent must take another
step to see the content — this is the design under test.

**Rationale for state-change-only:** simplest mechanism consistent with the existing
fold/unfold model. Past context changes are already what folding produces in reverse;
this is the natural inverse. Echoing the full content in the tool result would mean two
copies of a potentially large block in the same turn (the restored past context plus the
tool result), which is wasteful and inconsistent with how unfolding already works in the
GUI.

**Deferred fallback:** if testing shows that next-turn restoration is insufficient in
practice (e.g. the agent's current reasoning cannot continue without the content in the
same turn), the fallback is to echo the full content in the `unfold` tool result. This is
a defined escape hatch, not the first cut.

**Human oversight:** agent unfolds are visible in the GUI's activity log ("agent unfolded
…"). The human can see them and re-fold any block. The human remains the decision-maker;
the agent can request, not force.

**Rejected: echo full content in the tool result (first cut)** — two copies, wasteful,
inconsistent with the fold model. Retained as the deferred fallback.

### 4. `accordion-context-folding` skill — standalone, auto-exposed

The agent needs to know (a) that `{#<code> FOLDED}` markers are Accordion fold tags, (b)
how to call `unfold`, and (c) what to expect (next-turn restoration). This is captured in
a standalone pi skill at `extension/skills/accordion-context-folding/SKILL.md`.

The skill is auto-exposed by the extension via pi's `resources_discover` hook — the user
never loads it manually. Its description is written so an agent recognizes it as
relevant when it notices the markers in its context. The skill body is intentionally
concise: it is a mid-task reference, not documentation.

The skill is always available (once the extension is running), not conditionally injected
when steering is armed. True only-when-armed injection would require the GUI to signal
arm-state to the extension mid-session — additional state and wiring for modest gain, since
the skill is harmless when no tags are present. The tags only appear when folding is
armed and the engine has folded something, so the skill's advice is only actionable in
exactly the cases where the markers appear.

**Deferred: only-when-armed skill injection.** If the extension-GUI protocol gains a
reliable arm-state signal, the skill can be injected conditionally. Not warranted for the
first cut.

### 5. Protocol bumped to v3

`unfoldRequest{codes}` / `unfoldResult{restored, missing}` are new wire message types.
`PROTOCOL_VERSION` → 3.
Extension and app share `protocol.ts`; a mismatched pair detects the version mismatch via
the `hello` handshake.

## Safety invariants

1. All ADR 0004 invariants hold: no GUI / disarmed / no reply ⇒ messages pass through
   unmodified. The `unfold` tool operates only on fold state, not on the message array
   directly.
2. `tool_call` and `user` blocks are never folded and thus never have fold tags — the
   agent cannot request to unfold something that was never folded.
3. Agent unfolds are sticky (`override: "unfolded"`) and visible to the human in the
   activity log. The human can re-fold any block. No action the agent takes is
   irreversible.
4. Folding is still content substitution, never removal — `unfold` is simply scheduling
   the content back. The engine's reversibility guarantee is unchanged.
5. The `unfold` tool does not alter the message array mid-turn. Restoration happens at
   the next `context` hook, consistent with the protocol rule that message array changes
   only apply at `context` (ADR 0001).

## Watch item: agent context regrowth

Agent unfolds are sticky and protected from auto-refold. A chatty agent that unfolds many
blocks could grow its own context back faster than the budget allows, creating an
unwinnable loop. The human retains control (re-fold via the GUI), and the activity log
names every agent-initiated unfold. This is a known characteristic to monitor in practice;
no automatic mitigation is included in this cut.

## Scope / limitations (this change)

- **Next-turn only.** The agent cannot get unfolded content in the current turn without
  a separate step. Same-turn echo is the defined fallback if this proves insufficient.
- **Skill always available.** No conditional injection based on arm state; the skill is
  harmless when no tags are present.
- **Single-block granularity.** `unfold` takes a list of ids; there is no "unfold all"
  or "unfold this turn's folds." The agent selects specific blocks.
- **No automatic re-fold of agent unfolds.** The engine's budget-driven auto-folder
  skips blocks with `override: "unfolded"`. If the human wants them re-folded, they
  act in the GUI.

## Verification

Extension `smoke.mjs`: the `unfold` round-trip (no-codes and detached guards, a numeric
code coerced to a string, then an attached request → `unfoldRequest{codes}` → mock-GUI
`unfoldResult` → confirmation result) and `resources_discover` skill exposure. Unit tests
(`vitest`): `foldCode` shape/determinism, the `{#<code> FOLDED}` tag, and tag-aware token
accounting (`digest.test.ts`); the GUI's `resolveUnfold` (restores by code sticky/
agent-provenance, **refuses a human-pinned or already-full block** → reports missing,
**unfolds all blocks sharing a colliding code**, drops from the next fold plan) and the
code-tagged `digestText` (`plan.test.ts`); the `isDurableId` guard (already covered). Full
gate: `svelte-check` 0/0/0, `vitest` (66), `npm run build`, extension smoke.
