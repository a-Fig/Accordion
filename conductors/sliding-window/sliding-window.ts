/*
 * sliding-window.ts — delete the oldest non-user blocks to keep the live window under budget.
 *
 * Strategy (high-water / low-water hysteresis band):
 *  - Trigger (high-water): the AGENT-VISIBLE live window climbs above budget * 0.90.
 *  - Target  (low-water):  bring the visible window back down to ~70% of budget.
 *  - Between the two it HOLDS — once dropped to 70% the agent's context is allowed to grow
 *    back up to 90% (≈20% of fresh turns) before the next deletion. It does NOT re-act on
 *    every pass; it waits for the window to refill to the high-water mark.
 *  - Eligible region: only blocks OLDER than the protected tail (slice(0, protectedFromIndex)).
 *  - Walk eligible oldest-first. Skip `user` blocks — they express intent and must stay
 *    visible. Every other not-yet-dropped block is added to the committed drop-set until the
 *    running removed-token total reaches the remove target.
 *  - A run may be a single block (1-member group); the `GroupCommand` contract allows it.
 *  - tool_call/tool_result pair-balance is delegated entirely to the host's `applyPlan`
 *    Phase A, which guarantees a call and its result are deleted together or neither.
 *    Caveat (deliberate, bounded): the conductor credits a dropped block's FULL tokens toward
 *    the target even when the host keeps it LIVE as a straggler (a tool pair straddling the run
 *    boundary, or the run snapping outward to a whole message). So the visible window can sit a
 *    little above the 70% target for one episode; the next grow pass extends the run to balance
 *    the pair and the overshoot closes. The host owns deletion granularity too: `createGroup`
 *    snaps a run outward to whole messages, so a run ending mid-message deletes the rest of it.
 *
 *  - WHY internal state: the host clears conductor-owned folds before every pass, so
 *    `view.liveTokens` is ALWAYS the raw, fully-unfolded size — which only grows. A stateless
 *    conductor that compares `liveTokens` to 90% would therefore re-trigger on every pass once
 *    the raw size first crossed 90%, pinning the agent's view at 70% forever. To implement the
 *    band we must remember what we have already deleted: `dropped` is the committed drop-set
 *    (block ids). The visible window = `liveTokens − Σ(tokens of dropped blocks still eligible)`,
 *    and the trigger is evaluated against THAT, not the raw baseline. The set is MONOTONIC —
 *    a deleted block is gone (per the "the block is gone" design); we only ever ADD to it,
 *    never release — and it is re-emitted as `group(digest:null)` commands every pass so the
 *    host (which rebuilds conductor groups each pass) keeps them applied.
 *
 * Locks: "human-steering" + "agent-unfold" (collaborative on tail-size — the human keeps
 * the protected-tail dial). The conductor never touches blocks inside the protected tail.
 */
import type { Conductor, ConductorView, ViewBlock, Command } from "../contract";

/** Fraction of budget that triggers deletion (high-water mark). */
const TRIGGER = 0.9;
/** Fraction of budget the visible window is brought back down to (low-water mark). */
const TARGET = 0.7;

export class SlidingWindowConductor implements Conductor {
	readonly id = "sliding-window";
	readonly label = "Sliding window";

	/**
	 * Locks human steering and agent unfold; tail-size is left to the human so the
	 * protected-tail dial stays interactive. The conductor never reaches into the tail.
	 */
	readonly locks = ["human-steering", "agent-unfold"] as const;

	/**
	 * The committed drop-set: ids of blocks we have decided to delete from the wire. Monotonic
	 * within a session (deleted = gone); pruned only of ids no longer present in the view.
	 */
	private dropped = new Set<string>();

	/**
	 * Grow the committed drop-set when the agent-visible window crosses the high-water mark,
	 * then re-emit the whole set as `group(digest:null)` deletes every pass. Below the mark it
	 * holds: the set is unchanged and simply re-emitted (the window refills toward 90%).
	 */
	conduct(view: ConductorView): Command[] {
		if (view.budget <= 0 || view.blocks.length === 0) {
			// No budget / nothing to manage → forget any prior commitments and clear to raw.
			this.dropped.clear();
			return [];
		}

		// Forget committed ids that are no longer present (defensive — live sessions are
		// append-only, but a reset / new session would invalidate them).
		const present = new Set(view.blocks.map((b) => b.id));
		for (const id of this.dropped) if (!present.has(id)) this.dropped.delete(id);

		// Only blocks older than the protected tail are eligible for deletion.
		const eligible = view.blocks.slice(0, view.protectedFromIndex);

		// Agent-visible live window = raw baseline minus what we are already deleting. Count
		// only dropped blocks that are still eligible: one that slid into the protected tail
		// (the human widened the dial) is no longer being deleted, so it counts as live again.
		let droppedTokens = 0;
		for (const b of eligible) if (this.dropped.has(b.id)) droppedTokens += b.tokens;
		const visible = view.liveTokens - droppedTokens;

		// HYSTERESIS: only GROW the drop-set when the visible window is above the high-water
		// mark. Otherwise hold the current set (re-emitted below) and let the window refill.
		if (visible > view.budget * TRIGGER) {
			const removeTarget = visible - view.budget * TARGET;
			let removed = 0;
			for (const b of eligible) {
				if (b.kind === "user") continue; // user intent stays visible
				if (this.dropped.has(b.id)) continue; // already committed
				this.dropped.add(b.id);
				removed += b.tokens;
				if (removed >= removeTarget) break;
			}
		}

		// Re-emit the committed drop-set as contiguous group(digest:null) runs. The host clears
		// conductor groups each pass, so re-emitting IS how the deletes are held in place.
		return this.emitRuns(eligible);
	}

	/**
	 * Collapse the committed drop-set into contiguous `group(digest:null)` commands over the
	 * eligible region. Any non-dropped block (a `user` block, a not-yet-dropped block, or the
	 * protected boundary) flushes the current run, so a run is always a contiguous span of
	 * deleted blocks — `user` blocks split runs into separate commands.
	 */
	private emitRuns(eligible: ViewBlock[]): Command[] {
		const cmds: Command[] = [];
		let runStart = -1;
		let runEnd = -1;

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
			if (this.dropped.has(eligible[i].id)) {
				if (runStart === -1) runStart = i;
				runEnd = i;
			} else {
				flush();
			}
		}
		flush();

		return cmds;
	}
}
