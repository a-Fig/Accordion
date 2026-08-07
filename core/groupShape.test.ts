/*
 * groupShape.test.ts — the collapse fixpoint, pinned directly.
 *
 * `collapsibleMessageKeys` was extracted VERBATIM out of `Truth.classifyGroup` (#90 review) so a
 * conductor can ask the same question before proposing a group instead of re-deriving the rule.
 * `Truth`'s own suites already cover it through `classifyGroup` — `core/truth.test.ts`'s group
 * accounting, `app/src/lib/live/group.crossvalidate.test.ts`'s leading/trailing/interior-straggler
 * cases cross-validated against `applyPlan`, `app/src/lib/engine/store.groups.test.ts`'s
 * assistant-part message-key grouping — all unchanged by the extraction. What none of them covered
 * is the branch the conductor now depends on: NOTHING removable, i.e. `carrier === null`, the
 * condition `Truth.opGroup` clamps with `"nothing collapses (all stragglers)"`.
 */
import { describe, expect, it } from "vitest";
import { collapsibleMessageKeys, hasCollapsibleCarrier, messageKey, type GroupMemberShape } from "./groupShape";

const text = (id: string): GroupMemberShape => ({ id, kind: "text" });
const call = (id: string, callId: string): GroupMemberShape => ({ id, kind: "tool_call", callId });
const result = (callId: string): GroupMemberShape => ({ id: `r:${callId}`, kind: "tool_result", callId });

describe("messageKey", () => {
	it("strips a live assistant part suffix, keeps scalar durable ids whole", () => {
		expect(messageKey("a:resp1:p0")).toBe("a:resp1");
		expect(messageKey("a:resp1:p2")).toBe("a:resp1");
		expect(messageKey("u:1000")).toBe("u:1000");
		expect(messageKey("r:call_1")).toBe("r:call_1");
		expect(messageKey("s:1000")).toBe("s:1000");
	});
});

describe("collapsibleMessageKeys", () => {
	it("collapses a run with no tool pairs at all", () => {
		const members = [text("a:r1:p0"), text("u:1000"), text("a:r2:p0")];
		expect([...collapsibleMessageKeys(members, true)]).toEqual(["a:r1", "u:1000", "a:r2"]);
		expect(hasCollapsibleCarrier(members, true)).toBe(true);
	});

	it("collapses a tool_call and its result when BOTH halves are inside", () => {
		const members = [call("a:r1:p0", "c1"), result("c1")];
		expect(collapsibleMessageKeys(members, true).size).toBe(2);
		expect(hasCollapsibleCarrier(members, true)).toBe(true);
	});

	it("NO CARRIER: a lone tool_call whose result is outside — the exact shape opGroup rejects", () => {
		expect(hasCollapsibleCarrier([call("a:r1:p0", "c1")], true)).toBe(false);
	});

	it("NO CARRIER: a lone tool_result whose call is outside", () => {
		expect(hasCollapsibleCarrier([result("c1")], true)).toBe(false);
	});

	it("an unbalanced message is demoted while its balanced neighbours still collapse", () => {
		const members = [call("a:r1:p0", "c1"), result("c1"), call("a:r2:p0", "c2")];
		expect([...collapsibleMessageKeys(members, true)]).toEqual(["a:r1", "r:c1"]);
	});

	it("every part of one assistant message shares its verdict: an orphaned call keeps its sibling text live too", () => {
		const members = [call("a:r1:p0", "c1"), text("a:r1:p1"), text("u:1000")];
		expect([...collapsibleMessageKeys(members, true)]).toEqual(["u:1000"]);
	});

	it("the fixpoint cascades: demoting one message can orphan another's pair half", () => {
		// r1 calls c1 (answered inside) — but the message answering c1 ALSO calls c2, whose result is
		// outside. That message is demoted first, which orphans c1 and demotes r1 on the next round.
		const members: GroupMemberShape[] = [
			call("a:r1:p0", "c1"),
			{ id: "a:r2:p0", kind: "tool_result", callId: "c1" },
			call("a:r2:p1", "c2"),
		];
		expect(hasCollapsibleCarrier(members, true)).toBe(false);
	});

	it("requireDurable gates a positional id — and only when asked (a non-wire session has no wire to diverge from)", () => {
		const members = [text("m0:p0"), text("a:r1:p0")];
		expect([...collapsibleMessageKeys(members, true)]).toEqual(["a:r1"]);
		expect([...collapsibleMessageKeys(members, false)]).toEqual(["m0", "a:r1"]);
	});

	it("no members at all → no carrier", () => {
		expect(hasCollapsibleCarrier([], true)).toBe(false);
	});
});
