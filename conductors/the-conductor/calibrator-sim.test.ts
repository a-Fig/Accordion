/*
 * calibrator-sim.test.ts — settles review finding #4 ("does the self-calibrating band one-way
 * ratchet to FOLD_TARGET_MIN and never recover?") by SIMULATING the real multi-turn loop: one
 * persistent state, the turn index advancing each pass, `applyPlanToState` between passes, and a
 * correction recorded the way the server records it (a manual unfold at the just-completed turn,
 * counted on the next calibration tick). `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
	createAccordionState,
	computeFoldPlan,
	liveTokensAtLevels,
	FOLD_TARGET_INITIAL,
	FOLD_TARGET_MIN,
	type AccordionState,
} from "./strategy.ts";
import { viewToParsed, offLimitsIds, applyPlanToState, type ViewBlock } from "./adapter.ts";

/** Build a growing session of `turns` turns (each: user + text + tool_call + fat tool_result),
 *  newest 4 blocks protected, so there's steady budget pressure that folding can satisfy. */
function blocksUpTo(turns: number): ViewBlock[] {
	const blocks: ViewBlock[] = [];
	let order = 0;
	const fat = "lorem ipsum dolor sit amet consectetur ".repeat(60);
	for (let t = 1; t <= turns; t++) {
		const mk = (kind: ViewBlock["kind"], text: string, extra: Partial<ViewBlock> = {}): ViewBlock => {
			const tokens = Math.max(1, Math.ceil(text.length / 4));
			return {
				id: `m${t}:${kind}`, kind, turn: t, order: order++, tokens, foldedTokens: tokens,
				held: false, folded: false, protected: false, grouped: false, text, ...extra,
			};
		};
		blocks.push(mk("user", `turn ${t}: continue the routine work`));
		blocks.push(mk("text", `Acknowledged turn ${t}; proceeding.`));
		blocks.push(mk("tool_call", `run {"step":${t}}`, { toolName: "run", callId: `c${t}` }));
		blocks.push(mk("tool_result", `output ${t}: ${fat}`, { toolName: "run", callId: `c${t}` }));
	}
	for (let i = Math.max(0, blocks.length - 4); i < blocks.length; i++) blocks[i].protected = true;
	return blocks;
}

/** One simulated turn at index `t`: plan under a fixed budget fraction, persist, return the target. */
function runTurn(state: AccordionState, t: number, budgetFrac = 0.5): number {
	const blocks = blocksUpTo(t);
	const parsed = viewToParsed(blocks);
	const budget = Math.floor(liveTokensAtLevels(parsed.blocks, new Map()) * budgetFrac);
	const plan = computeFoldPlan(
		{ parsed, incomingPrompt: `turn ${t}: continue the routine work`, budgetTokens: budget, state, offLimitsIds: offLimitsIds(blocks) },
		{},
	);
	applyPlanToState(state, plan);
	return plan.foldTarget;
}

test("quiet pressure decays the target toward MIN (the reviewer's ratchet-down — confirmed intended)", () => {
	const state = createAccordionState();
	let target = FOLD_TARGET_INITIAL;
	for (let t = 4; t <= 14; t++) target = runTurn(state, t);
	assert.ok(target < FOLD_TARGET_INITIAL, `target should have decayed below the initial ${FOLD_TARGET_INITIAL}; got ${target}`);
	assert.ok(target >= FOLD_TARGET_MIN, `target must stay within the band floor ${FOLD_TARGET_MIN}; got ${target}`);
});

test("a correction RAISES the target mid-session — it is NOT a one-way ratchet", () => {
	const state = createAccordionState();
	// Run quiet turns so the target has decayed and there's headroom to rise.
	let target = 0;
	for (let t = 4; t <= 12; t++) target = runTurn(state, t);
	const beforeCorrection = target;

	// A human unfolds a block at the just-completed turn (turn 12), exactly as the server's
	// recordOverride() writes it. The calibrator counts it on the next tick (turn 13).
	state.manualChanges.push({ blockId: "m3:tool_result", action: "unfold", actor: "you", turn: 12 });
	const afterCorrection = runTurn(state, 13);

	assert.ok(
		afterCorrection > beforeCorrection,
		`correction must raise the target (not inert): before ${beforeCorrection} → after ${afterCorrection}`,
	);

	// And it recovers downward again under renewed quiet — oscillates, not stuck.
	let t = 14;
	let afterRecovery = afterCorrection;
	for (; t <= 17; t++) afterRecovery = runTurn(state, t);
	assert.ok(afterRecovery < afterCorrection, `quiet after a correction should decay again: ${afterCorrection} → ${afterRecovery}`);
});
