/*
 * commands.ts — translate a `FoldPlan` (per-block fold levels + contiguous groups) into the
 * Accordion command batch. This is the output adapter; it is where the_conductor's graduated
 * fold LEVELS become the contract's content-substitution commands:
 *
 *   Level 1 Trim   → replace{ id, content: <query-aware excerpt> }     (foldable kinds only)
 *   Level 2 Digest → fold{ ids:[id], digest: <⟦t…⟧ digest / summary> } (foldable kinds only)
 *   Level 3 Group  → one group{ ids: <run>, digest: <group head text> } per contiguous run
 *   Level 0 Full   → nothing (host's raw baseline)
 *
 * The reply is the conductor's COMPLETE desired state — the host resets to baseline then
 * applies this whole batch — so we emit one command per non-full block every pass.
 *
 * Only `text` / `thinking` / `tool_result` fold on the wire; `user` and `tool_call` are
 * skipped (the host would clamp them `not-foldable`). A folded tool PAIR therefore folds only
 * its `tool_result` — the `tool_call` stays live so the pair never orphans. `blockTokensAtLevel`
 * already models that, so the budget projection matches what we emit.
 */
import type { Command, ContextBlock, AccordionState, FoldPlan, ConductorDependencies } from "./strategy.ts";
import { contentForLevel } from "./strategy.ts";

const FOLDABLE_KINDS = new Set(["text", "thinking", "tool_result"]);

export function buildCommands(
	plan: FoldPlan,
	blocks: ContextBlock[],
	state: AccordionState,
	deps: ConductorDependencies,
	prompt: string,
): Command[] {
	const byId = new Map<string, ContextBlock>();
	for (const b of blocks) byId.set(b.id, b);

	const commands: Command[] = [];
	const groupedIds = new Set<string>();

	// 1. Contiguous groups → one `group` command each. The host snaps the named run outward to
	//    whole messages, keeps the summary on the head, and empties the rest — so we hand it the
	//    run's block ids plus the group-prefixed head digest as the verbatim summary.
	for (const [headId, meta] of plan.groups) {
		const head = byId.get(headId);
		if (!head) continue;
		for (const id of meta.blockIds) groupedIds.add(id);
		commands.push({
			kind: "group",
			ids: meta.blockIds,
			digest: contentForLevel(head, 2, state, deps, meta, prompt),
		});
	}

	// 2. Per-block trim / digest for everything not swept into a group.
	for (const [id, level] of plan.levels) {
		if (level <= 0 || groupedIds.has(id)) continue;
		const block = byId.get(id);
		if (!block || !FOLDABLE_KINDS.has(block.kind)) continue;
		if (level === 1) {
			commands.push({ kind: "replace", id, content: contentForLevel(block, 1, state, deps, undefined, prompt) });
		} else {
			// Levels 2 and any stray 3 (no group head) both render as a single-block digest.
			commands.push({ kind: "fold", ids: [id], digest: contentForLevel(block, 2, state, deps, undefined, prompt) });
		}
	}

	return commands;
}

/** A cheap stable signature of the desired state, used to HOLD (emit nothing) when nothing
 *  changed so the agent's prompt prefix stays cache-warm between real moves. Built from levels
 *  + group membership only (digest text can lag behind async summaries without changing intent). */
export function planSignature(plan: FoldPlan): string {
	const levels = [...plan.levels.entries()]
		.filter(([, l]) => l > 0)
		.sort((a, b) => (a[0] < b[0] ? -1 : 1))
		.map(([id, l]) => `${id}:${l}`);
	const groups = [...plan.groups.values()].map((g) => `g[${[...g.blockIds].sort().join(",")}]`).sort();
	return levels.join("|") + "##" + groups.join("|");
}
