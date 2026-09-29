# keel-lite

A deterministic, collaborative, in-process conductor. It makes no model calls, declares no locks,
and every edit it makes can be recovered. It is a small, deterministic subset of the
[Keel plan](../../../docs/keel-conductor-plan.md).

## Why

We profiled SlopCode runs of DeepSeek V4 Flash under pi. By token mass, the context was:

| content | share |
|---|---|
| thinking | 55–58% |
| bash results | 18–23% |
| `edit` / `bash` / `write` call args | 6% / 6% / 4% |
| read results | 5–8% |
| assistant text | <1% |

DeepSeek re-sends all prior reasoning on every call, so old thinking is both the largest and the
least valuable content.

A DeepSeek cache read costs about 2% of fresh input. Every edit to an early block re-bills the
whole suffix, so edits have to come in rare, large batches.

The spec is the one thing an agent must never lose. It reaches the context through:

- `AGENT_BRIEFING.md`;
- the `platform_client.py guide` output;
- one `spec_<problem>_checkpoint_<N>.md` read per checkpoint.

## How

**Roots are never touched.** These are:

- every `system` and `user` block;
- the newest read of `AGENT_BRIEFING.md`;
- the newest read of each of the two newest distinct `spec_*.md` paths.

Older duplicate reads of the same path count as stale reads. The newest read of an older spec path
is a *demoted* root, and only the last per-block rung (R6) compacts it. A clean `cat <file>` in bash
counts as a read of that file.

**Hysteresis.** While projected live tokens stay under `HIGH × budget`, keel-lite proposes nothing.

Once the projection crosses that line, keel-lite runs one epoch:

1. It plans the epoch synchronously, inside the same `turn-committed` or `blocks-appended` handler
   that saw the crossing.
2. It commits the whole epoch as a single transaction.
3. The epoch walks the ladder until the projection is at or below `LOW × budget`, or until no
   eligible block is left.

If no block is eligible, the status line reports `saturated`.

Nothing is deferred. A single DeepSeek step can add about 15k tokens, and lagging behind that is how
async summarizers overshoot.

**Eligible blocks** must:

- sit before the protected tail;
- not be a root;
- not be held (a human or agent override);
- not be in any group;
- not be a `tool_call`, `system` or `user` block.

Keel-lite never fights a held block and never counts one toward its savings.

**The ladder.** Each rung runs across the whole eligible region, oldest block first. Each epoch
starts again at R1, but skips blocks it has already decided on. As a result, newer thinking is
always spent before older bash output.

| rung | target | action |
|---|---|---|
| R0 | one of keel-lite's own decisions that has lapsed (e.g. healed by the tail) | re-assert it at its recorded form |
| R1 | `thinking` | plain fold |
| R2 | stale reads (the path is later re-read in full, or written/edited) | plain fold |
| R3 | bash results > 150 tok | recoverable `replace`: first 3 + last 12 lines (≤200 chars each) around a `… N lines / ~T tok elided — unfold to see full output …` marker; skipped unless it saves ≥40% |
| R4 | remaining `read` results | doorman's code skeleton (recoverable, same worth-it gate); otherwise a plain fold if > 300 tok |
| R5 | anything still > 200 tok (text, other results, the guide, trims, skeletons) | deeper plain fold |
| R6 | demoted spec reads | plain fold |
| R7 | the oldest runs of whole assistant steps | default-recap groups of about 8 steps each |

R3 does not trim the `platform_client.py guide` output. A trimmed manual reads like a complete but
wrong one, so that output stays whole until R5 folds it.

R7 stops at any root, held block or existing group. Before proposing a group, keel-lite snaps it
with `snapToMessageAtoms` and vets it with `collapsibleMessageKeys`, the same check `Truth.opGroup`
runs. It proposes the group only if every member collapses.

**Monotone.** Keel-lite only ever proposes `fold`, `replace` (on a still-live block) and `group`. It
never proposes `unfold`, `auto` or `ungroup`. It records only the ops that `Truth.apply` actually
applied.

On `resync`, it rebuilds its state from truth. It treats a folded, un-held block, or a `by: "auto"`
group, as its own. A block that has vanished is forgotten.

**Why a raw `Conductor`.** `ViewConductor` proposes `auto` for folds swept into a desired group. If
that group op clamps, the folds reopen. It also re-proposes clamped ops on every pass. Keel-lite's
decisions are add-only, so it proposes exactly the new decisions and nothing else.

## Knobs

Constructor options (`KeelLiteOptions`, defaults in `KEEL_LITE_DEFAULTS`):

| option | default | meaning |
|---|---|---|
| `high` | 0.85 | start an epoch at this fraction of the budget |
| `low` | 0.65 | an epoch stops at this fraction |
| `bashTrimMinTokens` | 150 | R3 threshold |
| `trimHeadLines` / `trimTailLines` / `trimLineChars` | 3 / 12 / 200 | R3 trim shape |
| `trimMinSavings` | 0.4 | R3 minimum saving |
| `readFoldMinTokens` | 300 | R4 fold threshold for a non-skeletonizable read |
| `deepFoldMinTokens` | 200 | R5 threshold |
| `groupChunkSteps` | 8 | R7 steps per group |
| `rootSpecPaths` | 2 | how many newest spec paths stay roots |
| `wholeBashCommand` | `/platform_client\.py["']?\s+guide\b/` | bash commands R3 must not trim (`null` disables the exemption) |

For benchmark sweeps, the registry factory (`core/conductor/registry.ts`) reads the band from the
environment:

- `ACCORDION_KEEL_LITE_HIGH`
- `ACCORDION_KEEL_LITE_LOW`

Each must be a fraction in (0, 1], with LOW < HIGH. A value that is invalid on its own is ignored.
If the resulting pair has LOW ≥ HIGH, both fall back to 0.85 / 0.65. The class itself stays pure and
takes its settings only from the constructor.

## Status

After each epoch, `setStatus` reports the epoch count, the rungs used, tokens saved in that epoch and
in total, groups made, and the live tokens before and after.
