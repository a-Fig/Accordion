/*
 * drop-oldest.ts — delete the oldest non-user blocks to keep the live window under budget.
 *
 * Strategy:
 *  - Trigger: liveTokens > budget * 0.90
 *  - Target:  bring live tokens back down to ~70% of budget
 *  - Eligible region: only blocks OLDER than the protected tail (slice(0, protectedFromIndex)).
 *  - Walk eligible oldest-first. Skip `user` blocks — they express intent and must stay
 *    visible. Every other block is accumulated into the current contiguous run. When a
 *    `user` block is hit (or the loop ends), the accumulated run is flushed as a single
 *    `group` command with `digest: null`, which signals the host to DELETE those messages
 *    from the wire entirely — the agent never sees them. Accumulation stops as soon as the
 *    running removed-token total reaches the remove target.
 *  - A run may be a single block (1-member group); the `GroupCommand` contract allows it.
 *  - Note: tool_call/tool_result pair-balance is delegated entirely to the host's `applyPlan`
 *    Phase A, which guarantees a call and its result are deleted together or neither (an
 *    unbalanced half is left as a straggler). No pairing logic is needed here.
 *  - State: none. Recomputed from the raw baseline every pass (the host clears prior
 *    conductor state before each call, so `liveTokens` is always the unfolded size). Once
 *    live tokens fall back below the trigger threshold, it clears to raw.
 *
 * Locks: "human-steering" + "agent-unfold" (collaborative on tail-size — the human keeps
 * the protected-tail dial). The conductor never touches blocks inside the protected tail.
 */
import type { Conductor, ConductorView, Command } from "../contract";

/** Fraction of budget that triggers deletion. */
const TRIGGER = 0.9;
/** Fraction of budget the live window is brought back down to. */
const TARGET = 0.7;

export class DropOldestConductor implements Conductor {
	readonly id = "drop-oldest";
	readonly label = "Sliding window";

	/**
	 * Locks human steering and agent unfold; tail-size is left to the human so the
	 * protected-tail dial stays interactive. The conductor never reaches into the tail.
	 */
	readonly locks = ["human-steering", "agent-unfold"] as const;

	/**
	 * Emit `group(digest: null)` commands over the oldest non-user runs until the live
	 * window is projected back to ~70% of budget. `user` blocks are skipped in place and
	 * split the run; each run is emitted as one drop command.
	 */
	conduct(view: ConductorView): Command[] {
		if (view.budget <= 0 || view.blocks.length === 0) return [];

		// Under the threshold → nothing to do (clear to raw).
		if (view.liveTokens <= view.budget * TRIGGER) return [];

		// Only the blocks older than the protected tail are eligible.
		const eligible = view.blocks.slice(0, view.protectedFromIndex);
		if (eligible.length === 0) return [];

		const removeTarget = view.liveTokens - view.budget * TARGET;
		const cmds: Command[] = [];
		let removed = 0;
		let runStart = -1; // index of the first block in the current run
		let runEnd = -1;   // index of the last block in the current run

		const flush = () => {
			if (runStart === -1) return;
			cmds.push({
				kind: "group",
				ids: [eligible[runStart].id, eligible[runEnd].id],
				digest: null,
			});
			runStart = -1;
			runEnd = -1;
		};

		for (let i = 0; i < eligible.length; i++) {
			const b = eligible[i];

			if (b.kind === "user") {
				// User blocks split runs; flush whatever we have.
				flush();
				continue;
			}

			// Extend the current run to include this block.
			if (runStart === -1) runStart = i;
			runEnd = i;
			removed += b.tokens;

			if (removed >= removeTarget) {
				// We've removed enough — flush and stop.
				flush();
				break;
			}
		}

		// Flush any open run at end of loop (target not yet hit but we've exhausted eligible).
		flush();

		return cmds;
	}
}
