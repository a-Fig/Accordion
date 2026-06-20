/*
 * garbage-collector.ts — the Garbage-collector conductor (conductor-imaginarium.md,
 * architecture #3 — "The Garbage Collector: context as a managed heap").
 *
 * Where the built-in folds oldest-first and cold-score folds coldest-activation-first,
 * this conductor folds UNREACHABLE-first. It steals the most battle-tested
 * resource-reclamation theory in computer science: in a garbage-collected runtime you
 * never delete what's REACHABLE — start from roots, walk references, reclaim the rest.
 *
 *   ROOTS    = protected working tail + human-held blocks + the original task statement
 *              (the first `user` block). These are the things the agent is guaranteed to
 *              still need: the live tail, anything a human pinned, and the founding intent.
 *   EDGES    = entity links (shared file/symbol identifiers) + causal links (a
 *              `tool_call`/`tool_result` `callId` pair) + message links (an assistant
 *              message's parts). Built in `edges.ts`.
 *   MARK     = every block reachable from the roots through those edges.
 *   SWEEP    = fold candidates are partitioned: UNREACHABLE ones fold first (they are
 *              semantically dead — "folded because nothing live references them" is a
 *              guarantee-shaped statement, auditable rather than a threshold shrug),
 *              then — only if the budget still can't be met — REACHABLE ones fold as a
 *              fallback. The budget guarantee is the hard invariant every conductor
 *              honours; reachability is the ordering, not a veto on it.
 *
 * What GC contributes that scoring doesn't: SEMANTICS instead of thresholds. "Folded
 * because unreachable from anything live" is auditable and testable; "folded because
 * score 0.23 < 0.30" is a shrug. The two compose (imaginarium §3): reachability
 * decides eligibility/order, the budget decides how far to go.
 *
 * It is COLLABORATIVE — no involvement locks (ADR 0011). Reachability is a relevance
 * signal, not a claim of authority; human overrides win exactly as they do for the
 * built-in and cold-score. Under budget → returns `[]` (raw), matching the convention
 * of every shipped in-process conductor.
 *
 * It is a PURE function of the view — no `$state`, no store reference, no mutation, no
 * engine reach-in, no instance state. It consumes ONLY the public `ConductorView`,
 * the same surface any out-of-process conductor gets. Types only from `../contract`;
 * the only helper is the dependency-free `edges.ts`. Never returns `null`: this
 * conductor is synchronous and always has a definite answer.
 *
 * The imaginarium's generational refinement (nursery / old gen / tenured — most tool
 * results die young, survivors live long) is deliberately OUT OF SCOPE for this cut;
 * see ADR 0012 for the roadmap. This is plain mark-and-sweep, the worked first slice.
 */
import type { Conductor, ConductorView, ViewBlock, Command } from "../contract";
import { buildGraph, markReachable } from "./edges";
import { FOLDABLE_KINDS } from "../cold-score/score";
import { FOLD_RANK } from "../builtin/builtin";

export class GarbageCollectorConductor implements Conductor {
	readonly id = "garbage-collector";
	readonly label = "Garbage collector";

	/**
	 * Fold unreachable candidates first, then reachable ones as a budget fallback,
	 * until the live context fits the budget. Under budget → `[]` (raw).
	 *
	 *   1. under budget → nothing to do (matches the built-in / cold-score convention);
	 *   2. mark every block reachable from the roots (protected tail + held + first
	 *      `user` block) through the reference graph;
	 *   3. candidates are foldable, non-held, non-protected, non-grouped, would-shrink
	 *      blocks — the same gate every conductor respects;
	 *   4. order candidates by (reachable? → kind-rank → conversation order): unreachable
	 *      first, then the built-in's kind/value ordering within each tier;
	 *   5. greedily fold until live ≤ budget. If unreachable blocks don't suffice, keep
	 *      folding reachable ones — the budget guarantee is the hard invariant.
	 */
	conduct(view: ConductorView): Command[] {
		// Step 1: under budget → raw, nothing to do.
		if (view.liveTokens <= view.budget) return [];

		// Step 2: mark reachable from the roots. Roots = protected tail + human-held
		// blocks + the ORIGINAL task statement (the first `user` block). Only the first
		// user message is a root: mid-session user turns that have aged out of the tail
		// are durable (never folded) but no longer anchor reachability — which is exactly
		// what lets work the agent has moved on from go unreachable and fold.
		const roots: string[] = [];
		let firstUserSeen = false;
		for (const b of view.blocks) {
			const isFirstUser = !firstUserSeen && b.kind === "user";
			if (isFirstUser) firstUserSeen = true;
			if (b.protected || b.held || isFirstUser) roots.push(b.id);
		}
		const marked = markReachable(buildGraph(view.blocks), roots);

		// Step 3: the candidate gate every conductor honours — foldable kind, not
		// human-held, not protected, not inside a folded group, and would actually shrink.
		const candidates = view.blocks.filter(
			(b) =>
				!b.held &&
				!b.protected &&
				!b.grouped &&
				b.foldedTokens < b.tokens &&
				FOLDABLE_KINDS.has(b.kind),
		);

		// Step 4: order. Unreachable (GC-eligible) first; within each tier, the built-in's
		// kind-rank then conversation order — so the reachable fallback behaves like the
		// built-in when the reachability signal is exhausted.
		const sorted = candidates.sort(
			(a, b) =>
				(marked.has(a.id) ? 1 : 0) - (marked.has(b.id) ? 1 : 0) ||
				FOLD_RANK[a.kind] - FOLD_RANK[b.kind] ||
				a.order - b.order,
		);

		// Step 5: greedy fold until the budget is met. Unreachable blocks fold first; if
		// they don't suffice, reachable ones follow — the budget guarantee wins over the
		// reachability preference, exactly as cold-score's relaxed pass wins over hysteresis.
		let live = view.liveTokens;
		const ids: string[] = [];
		for (const b of sorted) {
			if (live <= view.budget) break;
			ids.push(b.id);
			live += b.foldedTokens - b.tokens;
		}
		return ids.length ? [{ kind: "fold", ids }] : [];
	}
}
