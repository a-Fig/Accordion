/*
 * birth-fold-demo.ts — minimal demonstration of the birth-fold exemption (#43, ADR 0017).
 *
 * Without the exemption, a huge `tool_result` that streams in while it is already inside the
 * protected working tail is UNFOLDABLE on its first model call — no conductor without the
 * `tail-size` lock can touch it, because `substOne` refuses every protected block. This
 * conductor exists only to exercise `ViewBlock.fresh`: it folds a fresh, protected,
 * oversized `tool_result` immediately, something no pre-#43 conductor could do without
 * claiming the `tail-size` lock over the whole tail.
 *
 * Collaborative (no locks) — a human pin or manual unfold still wins, and this only ever
 * reaches for blocks the model has not yet seen, so there is nothing to override.
 */
import type { Conductor, ConductorView, Command } from "../contract";

/** Above this size a fresh protected tool_result gets birth-folded on sight. */
const FRESH_FOLD_THRESHOLD = 4000;

export class BirthFoldDemoConductor implements Conductor {
	readonly id = "birth-fold-demo";
	readonly label = "Birth-fold demo";

	conduct(view: ConductorView): Command[] {
		const ids = view.blocks
			// `!b.held`: skip a block the human has already touched (pin / manual fold / manual
			// unfold). Without this, re-issuing `fold` on a human-held block every pass is a
			// harmless no-op to the wire (the host's human-override clamp always wins), but it
			// spams a "clamped · human-override" report on every single refold — recurring log
			// noise for a state that will never change.
			.filter((b) => b.fresh && b.protected && !b.held && b.kind === "tool_result" && b.tokens > FRESH_FOLD_THRESHOLD)
			.map((b) => b.id);
		return ids.length ? [{ kind: "fold", ids }] : [];
	}
}
