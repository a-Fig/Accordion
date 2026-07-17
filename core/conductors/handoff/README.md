# Handoff (fresh start) conductor

Ported from the deleted `conductors/handoff/handoff.ts` (ADR 0017, git rev `dc037bc`) onto the
conductor-v2 contract (`core/conductor/contract.ts` + `core/conductor/view.ts`'s `ViewConductor`
adapter). See `handoff.ts`'s top-of-file comment for the full PORT FIDELITY notes.

This conductor automatically simulates the user's manual handoff workflow:

1. Ask the current agent to write a handoff document.
2. Clear / kill the current session.
3. Start a fresh session that receives only that handoff document.

It does not create a file. It calls the live model out-of-band with a prompt that mirrors the
local `handoff` skill, except the `mktemp` / save-to-file instruction is replaced by "output
inline" because Accordion inserts the returned text directly into the successor context.

## What it does

- **Writes a real handoff.** The model is asked to summarize the current conversation so a fresh
  agent can continue, suggest useful skills, and reference existing artifacts (PRDs, plans, ADRs,
  issues, commits, diffs) instead of duplicating them.
- **Drops the old session from the agent's perspective.** The handoff is inserted as one folded
  group with a literal digest and no `{#code FOLDED}` recovery tag, so the continuing agent cannot
  `unfold` the killed transcript.
- **Keeps no old-session tail.** The conductor declares the `tail-size` lock with
  `HANDOFF_TAIL_TOKENS = 0`, so every current block is eligible to be folded into the handoff. The
  continuing agent sees the handoff plus only future post-handoff turns.
- **Chains like real handoffs.** Later handoffs are written from the prior handoff plus new work
  only; the raw transcript behind earlier handoffs is intentionally absent.

## How it works

The conductor emits one folded `group` whose digest is the model-written handoff document. It
re-runs on every `turn-committed` event and re-launches when the visible context refills past the
90% high-water mark and there is new work to fold into an updated handoff.

It declares all three steering locks:

- `human-steering` and `agent-unfold` keep the handoff region from being fought over while the
  conductor is attached.
- `tail-size` with `tailTokens = 0` prevents any verbatim old-session tail from leaking into the
  simulated fresh session.

**Nothing applies these locks today.** The conductor-v2 contract has no host yet that turns a
conductor's declared `locks`/`tailTokens` into a real `Truth.setLocks(...)` call on attach — that
host (referred to as "Phase C" in this port) doesn't exist. This conductor only *declares* the
intent; `handoff.test.ts` drives `Truth.setLocks` directly in test setup to simulate what that
host will eventually do.

## Output-token reservation

The handoff request reserves output room against the model's context window. The host clamp bounds
only max-*output* (the model's own ceiling), not `input + output`, so at the 0.9 trigger — where
input is already ~90% of the window — a blind full-size request would push `input + output` past
the window and the provider would 400. The conductor estimates the prompt's input (chars/4, the
repo convention) and requests `min(MAX_HANDOFF_TOKENS, contextWindow − input − safetyMargin)`. If
that leaves less than a ~1000-token floor, the input alone nearly fills the window: the conductor
**declines** the request and surfaces a "needs a bigger window" status instead of sending a doomed
call. When the window is unknown (`contextWindow == null`), it falls back to the soft cap and
relies on the host's max-output clamp.

## Failure visibility

A handoff completion runs out of band from the model call, so a failure can only reach the human as
a status. When a completion is **rejected** (provider error, network error, or — under the new
contract — simply "no live model link", since there is no separate availability pre-check anymore)
or returns an **empty document**, the conductor sets a sticky status carrying the real error
message. That status survives subsequent `conduct()` passes until a genuine retry launches (new
aged content) or a handoff commits — it is not wiped by the next over-threshold pass.

## Untrusted conversation data

Block text and the prior handoff are interpolated inside `<conversation>` / `<previous-handoff>`
tags when building the prompt. Because the handoff becomes the successor agent's whole context, a
tool result containing a literal `</conversation>` (a web fetch or file read) could otherwise break
out of the data section and inject instructions that persist across the session boundary. The
conductor neutralizes any such closing sentinel in interpolated content and the system prompt
declares everything inside those tags to be untrusted data, not instructions.

## Group persistence (the one real port hazard)

The old host reset this conductor's own prior folds/groups back to raw before recomputing the view
on every `conduct()` pass, so `ViewBlock.grouped` reliably meant "some OTHER (human) group already
owns this." The new `Truth`/`ViewConductor` engine persists a `group` op across passes instead — so
naively porting the old `!b.grouped` checks made the handoff's own group look owned-by-someone-else
on the very next pass and get diffed away (`ungroup`), destroying the fresh start immediately after
creating it. The fix — `foreignGroupedIds()`, keyed on group provenance (`by !== "auto"`) rather
than the blanket `grouped` flag — and the matching raw-baseline trigger-math adjustment are
documented in full in `handoff.ts`'s PORT FIDELITY section (§3/§4). This is the same fix pattern
the sibling `core/conductors/compaction-naive/compaction-naive.ts` port established first; both
conductors solve it the same way on purpose.

## Unavailable model link

Unlike the pre-excision conductor, there is no `host.can("complete")` pre-check in the new contract
— a rejected `complete()` call IS the "unavailable" signal. If the live model link is down (browser
dev mode, read-only Claude Code transcript, extension disconnected), the conductor still always
attempts the call (subject to the same `lastAttemptKey` retry gate) and reports the rejection via
the sticky failure status rather than inventing a deterministic substitute.

## Selecting it

Not wired into any registry yet — this is a standalone port. A future conductor-selection surface
would instantiate `HandoffConductor` and attach it the same way any other `ViewConductor` subclass
is attached.

## Limitations

- The agent cannot self-unfold handed-off blocks; that is the point of simulating a killed old
  session. The human can still detach in Accordion to recover the full history.
- Each later handoff depends on the previous handoff plus new work, so omissions can compound.
- It does not track its own model spend (`inputTokens` / `outputTokens` are ignored).
- **No host tail floor while idle** (accepted residual, ADR 0017, unchanged by this port). The
  `tail-size` lock declares `tailTokens = 0`, required for fidelity — any non-zero tail would clamp
  the handoff group out of the newest blocks and leak raw old-session context. `tailTokens` is a
  static field read once at attach, not a per-`conduct()`-pass input, so the zero tail cannot be
  made to apply "only while a handoff is in effect" from the conductor side; that would need a host
  change (re-reading `tailTokens` per pass), out of scope here and unaffected by the new contract.
  The residual is benign: on every no-handoff path (below trigger, in-flight, decline, empty/failed
  completion) the session ships raw (full content, nothing folded, no data loss). The only
  consequence is that a detach taken while idle inherits a zero protected-tail target.
