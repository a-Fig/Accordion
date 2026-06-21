/*
 * adapter.ts — the I/O boundary between Accordion's contract and the_conductor's strategy.
 *
 * Accordion hands the conductor a pure `ConductorView` (linearized `ViewBlock`s + budget +
 * protected-tail policy). the_conductor's strategy reasons over its own `ContextBlock` /
 * `ParsedContext` shapes. The two are field-identical for everything that matters
 * (`id/kind/turn/order/text/tokens/toolName/callId/isError`), so this adapter is thin: it
 * rebuilds a `ParsedContext` from the view (no `parseMessages` needed — the host already
 * linearized), derives the host-owned "off-limits" set, and persists the chosen fold levels
 * back into the strategy's `AccordionState` so cross-pass hysteresis/diffing still works.
 */
import type { ContextBlock, ParsedContext, Turn, AccordionState, FoldPlan, FoldLevel } from "./strategy.ts";

/** One block as Accordion sends it on the wire. Mirrors `conductors/contract/conductor.ts`. */
export interface ViewBlock {
	id: string;
	messageKey?: string;
	kind: "user" | "text" | "thinking" | "tool_call" | "tool_result";
	turn: number;
	order: number;
	tokens: number;
	foldedTokens: number;
	toolName?: string;
	callId?: string;
	isError?: boolean;
	held: boolean;
	folded: boolean;
	protected: boolean;
	grouped: boolean;
	text?: string;
	preview?: string;
}

/** Convert a single wire block to the strategy's `ContextBlock`. `source` is vestigial here
 *  (it drove message mutation, which the host now owns) so we stub it. */
function toContextBlock(b: ViewBlock): ContextBlock {
	return {
		id: b.id,
		messageKey: b.messageKey,
		kind: b.kind,
		turn: b.turn,
		order: b.order,
		text: b.text ?? "",
		tokens: b.tokens,
		toolName: b.toolName,
		callId: b.callId,
		isError: b.isError,
		// `source` drove message mutation, which the host now owns — vestigial here. We still set
		// the required `field` so the type is satisfied (no message is ever indexed by it).
		source: { messageIndex: -1, field: "content" },
	};
}

/** Build a `ParsedContext` directly from the view's blocks — the input adapter that replaces
 *  `parseMessages`. Turns are reconstructed from the blocks' `turn` field (already assigned by
 *  the host), in ascending order, which is all `computeFoldPlan` reads from them. */
export function viewToParsed(blocks: ViewBlock[]): ParsedContext {
	const ctxBlocks = blocks.map(toContextBlock);
	const turnsByIndex = new Map<number, Turn>();
	for (const b of ctxBlocks) {
		let t = turnsByIndex.get(b.turn);
		if (!t) {
			t = { index: b.turn, messageIndexes: [], tokens: 0 };
			turnsByIndex.set(b.turn, t);
		}
		t.tokens += b.tokens;
	}
	const turns = [...turnsByIndex.values()].sort((a, b) => a.index - b.index);
	return { preamble: [], turns, blocks: ctxBlocks };
}

/** Blocks the host owns and the conductor must never fold: the protected working tail, any
 *  human-held block (pin / manual fold / manual unfold — the human's choice always wins), and
 *  any block already inside a host-managed folded group. `computeFoldPlan` treats these as
 *  unfoldable; the host would clamp them anyway, but excluding them up front keeps the
 *  projection honest and avoids needless clamp churn. */
export function offLimitsIds(blocks: ViewBlock[]): Set<string> {
	const ids = new Set<string>();
	for (const b of blocks) if (b.protected || b.held || b.grouped) ids.add(b.id);
	return ids;
}

/** The latest user prompt = text of the last `user`-kind block (the incoming turn). */
export function latestPrompt(blocks: ViewBlock[]): string {
	for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind === "user") return blocks[i].text ?? "";
	return "";
}

/** Persist the plan's desired levels back into the strategy state so the NEXT pass sees them
 *  as `initialLevels` — the basis for proactive-unfold diffing, grace periods, and hysteresis.
 *  Mirrors what `applyDecisionsToState` did from decisions, but straight from the level map. */
export function applyPlanToState(state: AccordionState, plan: FoldPlan): void {
	const foldLevels: Record<string, FoldLevel> = {};
	for (const [id, level] of plan.levels) if (level > 0) foldLevels[id] = level;
	state.foldLevels = foldLevels;
	state.foldedBlockIds = Object.keys(foldLevels);
}
