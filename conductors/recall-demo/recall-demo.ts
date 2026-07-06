/*
 * recall-demo.ts — minimal demonstration of the conductor `recall` command (ADR 0018).
 *
 * Recall is the conductor analog of the agent's `recall` tool: a folded block STAYS folded (its
 * `{#code FOLDED}` digest keeps costing only the digest), but the host ALSO injects the block's
 * ORIGINAL full text at a stable tail anchor — so the agent sees the detail again WITHOUT the
 * prompt-cache miss an unfold would cause (unfold substitutes full text back mid-history).
 *
 * This conductor folds every large, older `tool_result`, then recalls the SINGLE most recent of
 * those folds to the tail. It shows the two commands composing: the same block reads folded in the
 * map (digest cost) yet its full content rides the tail (recall cost on top). The `fold` for a
 * block MUST precede its `recall` in the batch — `recall` requires the block to be folded at the
 * instant the host processes the command.
 *
 * Collaborative (no locks) — a human pin/unfold still wins; unfolding a recalled block drops its
 * recall automatically (the tail injection would then duplicate content already standing in place).
 *
 * Note: in a live session recalls ACCUMULATE monotonically — recalls are sticky (ADR 0018 §2) and
 * this demo never issues `restore`, so each new "most recent fold" adds a recall without releasing
 * the prior one. Intentional for a demo; a real strategy would `restore` recalls it is done with.
 */
import type { Conductor, ConductorView, Command } from "../contract";

/** Fold + consider for recall any older tool_result larger than this. */
const FOLD_THRESHOLD = 2000;

export class RecallDemoConductor implements Conductor {
	readonly id = "recall-demo";
	readonly label = "Recall demo";

	conduct(view: ConductorView): Command[] {
		// Foldable, older (not protected / not held) tool_results above the size threshold.
		const targets = view.blocks.filter(
			(b) => b.kind === "tool_result" && !b.protected && !b.held && !b.grouped && b.tokens > FOLD_THRESHOLD,
		);
		if (!targets.length) return [];
		const ids = targets.map((b) => b.id);
		// Recall the most recent of the folded results (largest order) to the tail.
		const newest = targets.reduce((a, b) => (b.order > a.order ? b : a));
		// fold FIRST (so the block is folded when the recall is processed), then recall.
		return [{ kind: "fold", ids }, { kind: "recall", ids: [newest.id] }];
	}
}
