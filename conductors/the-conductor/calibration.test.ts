/*
 * calibration.test.ts — Phase 3: the self-calibrating fold target reacts to corrections.
 * A human/agent UNFOLD in the feedback window means the conductor folded something the
 * conversation needed → the target rises (fold less). Quiet, within-budget pressure decays it
 * back down (fold more). This is the signal the server feeds via `host/event` → `manualChanges`.
 * `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
	createAccordionState,
	calibrateFoldTarget,
	computeFoldPlan,
	liveTokensAtLevels,
	FOLD_TARGET_INITIAL,
} from "./strategy.ts";
import { viewToParsed, offLimitsIds, type ViewBlock } from "./adapter.ts";

test("a manual unfold correction raises the calibrated fold target; quiet pressure decays it", () => {
	const state = createAccordionState();
	assert.equal(state.foldTargetCalibrated ?? FOLD_TARGET_INITIAL, FOLD_TARGET_INITIAL);

	// Human unfolded a block at turn 5 (a correction): the conductor folded something needed.
	state.manualChanges.push({ blockId: "x", action: "unfold", actor: "you", turn: 5 });
	const raised = calibrateFoldTarget(state, 6);
	assert.ok(raised > FOLD_TARGET_INITIAL, `correction should raise target; got ${raised}`);

	// A later quiet, within-budget pressure tick decays the target back down.
	state.lastRunHadPressure = true;
	state.lastRunWithinBudget = true;
	const decayed = calibrateFoldTarget(state, 7);
	assert.ok(decayed < raised, `quiet pressure should decay target; got ${decayed} vs ${raised}`);
});

test("computeFoldPlan surfaces the calibrated target, lifted by an in-window correction", () => {
	const blocks: ViewBlock[] = [];
	let order = 0;
	const fat = "lorem ipsum dolor sit amet ".repeat(80);
	for (let t = 1; t <= 10; t++) {
		const mk = (kind: ViewBlock["kind"], text: string, extra: Partial<ViewBlock> = {}): ViewBlock => {
			const tokens = Math.max(1, Math.ceil(text.length / 4));
			return {
				id: `m${t}:${order}`, kind, turn: t, order: order++, tokens, foldedTokens: tokens,
				held: false, folded: false, protected: false, grouped: false, text, ...extra,
			};
		};
		blocks.push(mk("user", `turn ${t} request`));
		blocks.push(mk("tool_result", `log ${t}: ${fat}`, { toolName: "run", callId: `c${t}` }));
	}
	const parsed = viewToParsed(blocks);
	const budget = Math.floor(liveTokensAtLevels(parsed.blocks, new Map()) * 0.5);

	const base = createAccordionState();
	const planBase = computeFoldPlan(
		{ parsed, incomingPrompt: "continue the work", budgetTokens: budget, state: base, offLimitsIds: offLimitsIds(blocks) },
		{},
	);

	const corrected = createAccordionState();
	corrected.manualChanges.push({ blockId: blocks[1].id, action: "unfold", actor: "agent", turn: 9 });
	const planCorr = computeFoldPlan(
		{ parsed, incomingPrompt: "continue the work", budgetTokens: budget, state: corrected, offLimitsIds: offLimitsIds(blocks) },
		{},
	);

	assert.ok(
		planCorr.foldTarget > planBase.foldTarget,
		`correction should lift foldTarget: ${planCorr.foldTarget} vs ${planBase.foldTarget}`,
	);
});
