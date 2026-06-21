/*
 * strategy.test.ts — Phase 1 deterministic checks for the ported strategy core + adapters.
 * No WebSocket, no embeddings, no LLM: pure keyword/digest path. `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAccordionState, computeFoldPlan, liveTokensAtLevels } from "./strategy.ts";
import { viewToParsed, offLimitsIds, applyPlanToState, type ViewBlock } from "./adapter.ts";
import { buildCommands } from "./commands.ts";

/** Build a synthetic linearized session: `turns` user/assistant/tool turns, each tool_result
 *  fat enough to create budget pressure. `tailProtected` newest blocks are marked protected. */
function makeBlocks(turns: number, tailProtected = 4): ViewBlock[] {
	const blocks: ViewBlock[] = [];
	let order = 0;
	const fat = "alpha beta gamma delta epsilon ".repeat(80); // ~ 2k chars => ~500 tok
	for (let t = 1; t <= turns; t++) {
		const mk = (kind: ViewBlock["kind"], text: string, extra: Partial<ViewBlock> = {}): ViewBlock => {
			const tokens = Math.max(1, Math.ceil(text.length / 4));
			return {
				id: `m${t}:${kind}:${order}`,
				kind,
				turn: t,
				order: order++,
				tokens,
				foldedTokens: tokens, // host precompute; unused by the strategy path here
				held: false,
				folded: false,
				protected: false,
				grouped: false,
				text,
				...extra,
			};
		};
		blocks.push(mk("user", `please investigate issue number ${t} in the deploy script`));
		blocks.push(mk("text", `Working on turn ${t}. I will inspect the relevant files now.`));
		const callId = `call-${t}`;
		blocks.push(mk("tool_call", `readFile {"path":"src/deploy${t}.ts"}`, { toolName: "readFile", callId }));
		blocks.push(mk("tool_result", `contents of deploy${t}: ${fat}`, { toolName: "readFile", callId }));
	}
	// Mark the newest `tailProtected` blocks as the host's protected working tail.
	for (let i = Math.max(0, blocks.length - tailProtected); i < blocks.length; i++) blocks[i].protected = true;
	return blocks;
}

const FOLDABLE = new Set(["text", "thinking", "tool_result"]);

test("under budget → empty plan, no commands", () => {
	const blocks = makeBlocks(2);
	const live = liveTokensAtLevels(viewToParsed(blocks).blocks, new Map());
	const state = createAccordionState();
	const parsed = viewToParsed(blocks);
	const plan = computeFoldPlan(
		{ parsed, incomingPrompt: "continue", budgetTokens: live + 10_000, state, offLimitsIds: offLimitsIds(blocks) },
		{},
	);
	assert.equal(plan.levels.size, 0);
	assert.equal(buildCommands(plan, parsed.blocks, state, {}, "continue").length, 0);
});

test("over budget → folds, never targets protected / held / user / tool_call", () => {
	const blocks = makeBlocks(12);
	// Hold one foldable block by hand; the conductor must not fold it.
	const heldResult = blocks.find((b) => b.kind === "tool_result" && !b.protected)!;
	heldResult.held = true;

	const parsed = viewToParsed(blocks);
	const full = liveTokensAtLevels(parsed.blocks, new Map());
	const budget = Math.floor(full * 0.5);
	const state = createAccordionState();
	const plan = computeFoldPlan(
		{ parsed, incomingPrompt: "fix the deploy bug", budgetTokens: budget, state, offLimitsIds: offLimitsIds(blocks) },
		{},
	);
	const cmds = buildCommands(plan, parsed.blocks, state, {}, "fix the deploy bug");
	assert.ok(cmds.length > 0, "expected folds under pressure");

	const byId = new Map(blocks.map((b) => [b.id, b]));
	const targeted = (c: any): string[] => (c.kind === "replace" ? [c.id] : c.ids);
	for (const c of cmds) {
		for (const id of targeted(c)) {
			const b = byId.get(id);
			assert.ok(b, `command targets a known block (${id})`);
			if (c.kind !== "group") {
				assert.ok(FOLDABLE.has(b!.kind), `only foldable kinds folded, got ${b!.kind}`);
				assert.ok(!b!.protected, "never fold a protected-tail block");
				assert.ok(!b!.held, "never fold a human-held block");
			}
		}
	}
});

test("budget guarantee: assembled fits when foldable candidates suffice", () => {
	const blocks = makeBlocks(16);
	const parsed = viewToParsed(blocks);
	const full = liveTokensAtLevels(parsed.blocks, new Map());
	const budget = Math.floor(full * 0.45);
	const state = createAccordionState();
	const plan = computeFoldPlan(
		{ parsed, incomingPrompt: "continue", budgetTokens: budget, state, offLimitsIds: offLimitsIds(blocks) },
		{},
	);
	assert.ok(plan.assembledTokens <= budget, `assembled ${plan.assembledTokens} should fit budget ${budget}`);
});

test("state persistence drives prior levels across passes", () => {
	const blocks = makeBlocks(10);
	const parsed = viewToParsed(blocks);
	const full = liveTokensAtLevels(parsed.blocks, new Map());
	const budget = Math.floor(full * 0.5);
	const state = createAccordionState();
	const p1 = computeFoldPlan(
		{ parsed, incomingPrompt: "continue", budgetTokens: budget, state, offLimitsIds: offLimitsIds(blocks) },
		{},
	);
	applyPlanToState(state, p1);
	assert.deepEqual(new Set(state.foldedBlockIds), new Set([...p1.levels].filter(([, l]) => l > 0).map(([id]) => id)));
});
