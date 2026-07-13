import { describe, it, expect } from "vitest";
import { applyPlan, type PiMessage, type AppliedCounts } from "./mapping";
import type { FoldOp, GroupOp } from "./protocol";

// ─────────────────────────────────────────────────────────────────────────────
// applyPlan's optional `appliedOut` param (issue #60 follow-up, ADR 0020): the
// extension's plan-applied ack must count what was ACTUALLY substituted onto the
// wire, not what the plan merely SUBMITTED. A shape-valid op/group whose id(s)
// match nothing live in `messages` (e.g. a stale plan re-applied after the
// conversation moved on) has zero wire effect and must not be counted.
//
// Purely additive: every pre-existing call site omits the appliedOut arg and is
// unaffected (covered by every other mapping*.test.ts file passing unchanged).
// ─────────────────────────────────────────────────────────────────────────────

function msgs(): PiMessage[] {
	return [
		{ role: "user", content: "fix the bug", timestamp: 1000 }, // m0  u:1000
		{
			role: "assistant",
			responseId: "resp_a",
			timestamp: 1001,
			content: [
				{ type: "thinking", thinking: "let me look" },
				{ type: "text", text: "reading the file" },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
			],
		}, // m1  a:resp_a:p0..p2
		{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: "file body" }, // m2  r:call_1
		{ role: "user", content: "now refactor it", timestamp: 2000 }, // m3  u:2000
	];
}

function counts(): AppliedCounts {
	return { ops: -1, groups: -1 }; // sentinel so an un-set field is obvious
}

describe("applyPlan — appliedOut counts (actually-applied, not submitted)", () => {
	it("omitting appliedOut changes nothing — same return value as before", () => {
		const out = applyPlan(msgs(), [{ id: "a:resp_a:p1", digestText: "FOLDED" }]);
		expect(Array.isArray(out)).toBe(true);
		expect((out[1].content as any[])[1].text).toBe("FOLDED");
	});

	it("a matched FoldOp on a text part is counted as applied", () => {
		const out = counts();
		applyPlan(msgs(), [{ id: "a:resp_a:p1", digestText: "FOLDED" }], [], out);
		expect(out.ops).toBe(1);
		expect(out.groups).toBe(0);
	});

	it("a matched FoldOp on a tool_result is counted as applied", () => {
		const out = counts();
		applyPlan(msgs(), [{ id: "r:call_1", digestText: "folded read" }], [], out);
		expect(out.ops).toBe(1);
	});

	it("a shape-valid FoldOp whose id matches NOTHING in messages is NOT counted (the stale-plan case)", () => {
		const out = counts();
		const src = msgs();
		const staleOps: FoldOp[] = [{ id: "a:resp_zzz:p0", digestText: "FOLDED" }]; // durable id, no such block
		const result = applyPlan(src, staleOps, [], out);
		expect(out.ops).toBe(0);
		expect(result).toBe(src); // identity passthrough — nothing actually changed
	});

	it("a FoldOp id that resolves to a tool_call part is never applied and is NOT counted", () => {
		// a:resp_a:p2 is the toolCall part — foldOne deliberately never folds it (would orphan
		// the tool_result). The id is present in `byId` but never substituted.
		const out = counts();
		applyPlan(msgs(), [{ id: "a:resp_a:p2", digestText: "FOLDED" }], [], out);
		expect(out.ops).toBe(0);
	});

	it("mixed matched + unmatched ops: only the matched one is counted", () => {
		const out = counts();
		applyPlan(
			msgs(),
			[
				{ id: "a:resp_a:p1", digestText: "FOLDED" }, // matches → applied
				{ id: "u:9999999", digestText: "FOLDED" }, // durable shape, no such message → not applied
			],
			[],
			out,
		);
		expect(out.ops).toBe(1);
	});

	it("a GroupOp whose members fully match is counted as one applied group", () => {
		const out = counts();
		const group: GroupOp = {
			id: "g:1",
			memberIds: ["a:resp_a:p0", "a:resp_a:p1", "a:resp_a:p2", "r:call_1"],
			summaryText: "{#g FOLDED} read the file",
		};
		applyPlan(msgs(), [], [group], out);
		expect(out.groups).toBe(1);
		expect(out.ops).toBe(0);
	});

	it("a shape-valid GroupOp whose members match NOTHING live is NOT counted", () => {
		const out = counts();
		const staleGroup: GroupOp = {
			id: "g:stale",
			memberIds: ["a:resp_zzz:p0", "a:resp_zzz:p1"],
			summaryText: "{#g FOLDED} nothing here",
		};
		applyPlan(msgs(), [], [staleGroup], out);
		expect(out.groups).toBe(0);
		// Passthrough: nothing durable matched, so applyPlan returns the identity (no change).
		const src = msgs();
		expect(applyPlan(src, [], [staleGroup])).toBe(src);
	});

	it("a GroupOp demoted to straggler by the tool-pair fixpoint is NOT counted", () => {
		// Only the tool_result member is listed; its call (m1) is outside the group, so the
		// fixpoint demotes this to a straggler — nothing is actually removed.
		const out = counts();
		const straggler: GroupOp = { id: "g:2", memberIds: ["r:call_1"], summaryText: null };
		applyPlan(msgs(), [], [straggler], out);
		expect(out.groups).toBe(0);
	});

	it("two groups submitted, only one matches live messages — exactly one counted", () => {
		const out = counts();
		const real: GroupOp = {
			id: "g:real",
			memberIds: ["a:resp_a:p0", "a:resp_a:p1", "a:resp_a:p2", "r:call_1"],
			summaryText: "{#g FOLDED} done",
		};
		const stale: GroupOp = { id: "g:stale", memberIds: ["a:resp_zzz:p0"], summaryText: "{#g FOLDED} stale" };
		applyPlan(msgs(), [], [real, stale], out);
		expect(out.groups).toBe(1);
	});

	it("everything empty/omitted → all-zero counts, no crash on the early-return path", () => {
		const out = counts();
		applyPlan(msgs(), [], [], out);
		expect(out).toEqual({ ops: 0, groups: 0 });
	});

	it("combined plan: matched op + matched group — counted independently", () => {
		const out = counts();
		const ops: FoldOp[] = [{ id: "u:2000", digestText: "FOLDED-USER" }]; // user role never folds → not applied
		const group: GroupOp = {
			id: "g:1",
			memberIds: ["a:resp_a:p0", "a:resp_a:p1", "a:resp_a:p2", "r:call_1"],
			summaryText: "{#g FOLDED} read the file",
		};
		applyPlan(msgs(), ops, [group], out);
		expect(out.ops).toBe(0); // user messages are never folded by foldOne
		expect(out.groups).toBe(1);
	});
});
