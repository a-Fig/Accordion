/*
 * builtin.ts — Accordion's default conductor.
 *
 * This is the engine's original auto-folder (ADR 0007), lifted verbatim out of
 * `AccordionStore.refold()` into a standalone `Conductor`. It makes no relevance
 * judgement: it folds purely to keep the live context under budget, oldest-first,
 * lowest-value-first — tool_results before thinking before reply text before
 * tool_calls before user intent. Deterministic and explainable; the smarts come from
 * the conductors people plug in over the wire.
 *
 * It is a PURE function of the view — no `$state`, no store reference, no mutation, no
 * engine reach-in. It consumes ONLY the public `ConductorView` (the exact surface any
 * out-of-process conductor gets); that is the whole point — the built-in is the worked
 * example, not a privileged insider. The host owns the reset, the protected-tail policy,
 * and the command application; this file owns exactly one thing: which blocks to fold, and
 * in what order. Keeping that decision byte-identical to the pre-refactor folder is the
 * whole point of M1, pinned by `conductor.builtin.test.ts`.
 */
import type { Conductor, ConductorView, ConductorBlockKind, Command } from "../contract";

/**
 * Lower value → folded sooner. The whole asymmetry the tool is built around. (Was a
 * private const in `store.svelte.ts`; it is the built-in's strategy, so it lives here.)
 * Exported so siblings (e.g. garbage-collector) can share the same ordering without copying.
 */
export const FOLD_RANK: Record<ConductorBlockKind, number> = {
	tool_result: 0, // huge, decays fastest → fold first, hardest
	thinking: 1, // ephemeral reasoning
	text: 2, // conclusions, medium durable value
	tool_call: 3, // tiny + durable record of an action → fold last
	user: 4, // the instruction/intent → fold last of all
};

export class BuiltinConductor implements Conductor {
	readonly id = "builtin";
	readonly label = "Built-in";

	/**
	 * Fold lowest-value, oldest candidates until the live context fits the budget.
	 *
	 * Mirrors the original `refold()` decision body exactly:
	 *  - start from the baseline `liveTokens` (the host has already cleared the prior pass);
	 *  - if already under budget, fold nothing (`[]` → raw);
	 *  - candidates are auto-controlled blocks older than the protected tail that aren't
	 *    inside a folded group and would actually shrink if folded;
	 *  - sort by kind rank then conversation order, and greedily fold until it fits.
	 *
	 * Returns a single fold command carrying the chosen ids (the host stamps them
	 * `autoFolded`/`by:"auto"` — same as before). Never returns `null`: the built-in is
	 * synchronous and always has a definite answer.
	 */
	conduct(view: ConductorView): Command[] {
		let live = view.liveTokens;
		if (live <= view.budget) return [];

		const cand = view.blocks
			.filter((b) => !b.held && !b.protected && !b.grouped && b.foldedTokens < b.tokens)
			.sort((a, b) => FOLD_RANK[a.kind] - FOLD_RANK[b.kind] || a.order - b.order);

		const ids: string[] = [];
		for (const b of cand) {
			if (live <= view.budget) break;
			ids.push(b.id);
			live += b.foldedTokens - b.tokens;
		}
		return ids.length ? [{ kind: "fold", ids }] : [];
	}
}
