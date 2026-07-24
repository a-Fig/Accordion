# Handoff (fresh start) conductor

Ported from the deleted `conductors/handoff/handoff.ts` (ADR 0017, git rev `dc037bc`) onto the
conductor-v2 contract (`core/conductor/contract.ts` + `core/conductor/view.ts`'s `ViewConductor`
adapter). See `handoff.ts`'s top-of-file comment for the full PORT FIDELITY notes.

PR #82 factored the machinery this conductor shared near-verbatim with the sibling
`compaction-naive` conductor into `../agedSummaryConductor.ts`'s `AgedSummaryConductor` base class
— see that file's doc comment and "Shared base (PR #82)" below. This conductor's own file now owns
only `HANDOFF_SYSTEM`, its two `buildPrompt` instruction strings, its count-preamble format, its
three status messages (this one is the only one of the two that surfaces the provider's real error
text), and the `tail-size` lock / `HANDOFF_TAIL_TOKENS = 0` declaration.

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

**The Phase-C host now applies these locks.** `LiveConductorHost.select` (`core/conductor/liveHost.ts`)
eagerly calls `Truth.setLocks(entry.locks, entry.label, entry.tailTokens)` the instant this
conductor attaches to a live session, and reverses it (the freeze kill switch, then
`clearLocks`) on detach — this conductor's `locks`/`tailTokens` declaration is no longer
aspirational. `handoff.test.ts` still drives `Truth.setLocks` directly in its own unit-test
setup — that exercises the conductor in isolation against `TestHost`, not the live host, but
it is the same real enforcement path either way.

## User messages are folded into the handoff too (same as `compaction-naive`)

Both this conductor and the sibling `compaction-naive` swallow every kind — including `user` —
into their respective groups; neither overrides `AgedSummaryConductor.includeInGroup` (its default:
every kind). An earlier revision of `compaction-naive`'s port (PR #82) briefly excluded `user`
blocks there, on the theory that its "reproduce verbatim" prompt promise was mechanically
unenforceable — that override has since been removed (main parity, restored; see
`compaction-naive`'s own README), so there is no remaining behavioral fork between the two
conductors on this point.

For `handoff` specifically, folding user blocks in has always been the right call: `HANDOFF_SYSTEM`
never promises verbatim preservation of anything — a handoff document is explicitly a paraphrased
briefing for a fresh agent, the same way the human-run `handoff` skill it mirrors produces a
paraphrased document, not a transcript. And this conductor requires ALL THREE involvement locks
(`human-steering`, `agent-unfold`, `tail-size`) — the strongest consent gate the codebase has —
specifically because its whole product is "collapse the ENTIRE prior session, including what the
human asked for, into one prose document." A human attaching `handoff` has explicitly signed up
for exactly this.

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

## Shared base (PR #82)

`HandoffConductor` and `NaiveCompactionConductor` were ~90% duplicated: the same aged-region
derivation, foreign-grouped-id exclusion, group-emission run-walk, completion launch/inflight/
attempt-key/sticky-status lifecycle, and output-token reservation math. `../agedSummaryConductor.ts`'s
`AgedSummaryConductor` now owns all of that; this file owns only what is genuinely different for a
"fold the whole session, all-locks-consented" conductor (documented in its own top-of-file PORT
FIDELITY notes) — mainly the prompt text, the four status messages, and the `tail-size` lock.

## Group persistence (the one real port hazard)

The old host reset this conductor's own prior folds/groups back to raw before recomputing the view
on every `conduct()` pass, so `ViewBlock.grouped` reliably meant "some OTHER (human) group already
owns this." The new `Truth`/`ViewConductor` engine persists a `group` op across passes instead — so
naively porting the old `!b.grouped` checks made the handoff's own group look owned-by-someone-else
on the very next pass and get diffed away (`ungroup`), destroying the fresh start immediately after
creating it. The fix — `foreignGroupedIds()`, keyed on group provenance (`by !== "auto"`) rather
than the blanket `grouped` flag — and the matching raw-baseline trigger-math adjustment now live
once in `AgedSummaryConductor` (`../agedSummaryConductor.ts`). This was the fix pattern this
conductor's port established first; the sibling `compaction-naive` port followed it, and PR #82
merged both onto the one shared implementation.

## Unavailable model link

There is no `host.can("complete")` pre-check in the new contract — a rejected `complete()` call IS
the "unavailable" signal. `AgedSummaryConductor.isUnavailableError` classifies that rejection,
keyed on the exact `"no model available"` message `extension/accordion.ts`'s `runCompletion` throws
when the session has no live model. On a match, the conductor shows the calm, main-parity status
("Handoff unavailable — waiting for live model link") and clears the retry gate (`lastAttemptKey`)
so the very next pass retries the same newly-aged set automatically once the link returns — mirroring
main's `host.can("complete")` pre-check exactly, which never recorded a failed attempt for this case
either. Any OTHER rejection (a real provider error, a timeout, a malformed request) still shows the
sticky failure status carrying the real error text (`rejectMessage`) and still waits for genuinely
new content to age in before retrying — inventing a deterministic substitute is deliberately not
on the table either way.

## Selecting it

Wired into `core/conductor/registry.ts`'s shipped catalog — pick "Handoff (fresh start)" from
the GUI's Conductor menu on a live session. Because it declares all three locks, attaching it
goes through the consent dialog first.

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
