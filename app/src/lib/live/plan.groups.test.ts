import { describe, it, expect } from "vitest";
import { AccordionStore } from "../engine/store.svelte";
import { foldCode } from "../engine/digest";
import { computeGroupOps, resolveUnfold, resolveRecall } from "./plan";
import type { Block, ParsedSession } from "../engine/types";

function b(id: string, kind: Block["kind"], turn: number, order: number, tokens: number, callId?: string): Block {
	return { id, kind, turn, order, text: id + " " + "x".repeat(40), tokens, callId, override: null, autoFolded: false, by: null };
}
function makeStore(): AccordionStore {
	const blocks: Block[] = [
		b("u:1", "user", 1, 0, 500),
		b("a:r1:p0", "thinking", 1, 1, 800),
		b("a:r1:p1", "text", 1, 2, 600),
		b("a:r1:p2", "tool_call", 1, 3, 100, "c1"),
		b("r:c1", "tool_result", 1, 4, 3000, "c1"),
		b("u:2", "user", 2, 5, 400),
		b("a:r2:p0", "text", 2, 6, 5000),
		b("u:3", "user", 3, 7, 100),
	];
	const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks, lineCount: 0, skipped: 0 };
	const s = new AccordionStore(parsed);
	s.setBudget(1_000_000);
	s.setProtect(0);
	return s;
}

describe("computeGroupOps", () => {
	it("emits one GroupOp per FOLDED group, with durable members and the group-tagged summary", () => {
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		const ops = computeGroupOps(s);
		expect(ops.length).toBe(1);
		expect(ops[0].id).toBe(g.id);
		expect(ops[0].memberIds).toEqual(["a:r1:p0", "a:r1:p1", "a:r1:p2", "r:c1"]);
		expect(ops[0].summaryText!.startsWith(`{#${foldCode(g.id)} FOLDED} group ·`)).toBe(true);
	});

	it("preserves conductor custom group summaries with recovery tags", () => {
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1", "you", `{#${foldCode("g:a:r1:p0")} FOLDED} conductor group summary`)!;
		const ops = computeGroupOps(s);
		expect(ops.length).toBe(1);
		expect(ops[0].summaryText).toBe(`{#${foldCode(g.id)} FOLDED} conductor group summary`);

		const recalled = resolveRecall(s, [foldCode(g.id)]);
		expect(recalled.missing).toEqual([]);
		expect(recalled.restored[0].ids).toEqual(g.memberIds);

		const unfolded = resolveUnfold(s, [foldCode(g.id)]);
		expect(unfolded.missing).toEqual([]);
		expect(unfolded.restored[0].ids).toEqual(g.memberIds);
		expect(s.groupById(g.id)!.folded).toBe(false);
	});

	it("emits nothing for an UNFOLDED group (open groups are wire-invisible)", () => {
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		s.unfoldGroup(g.id);
		expect(computeGroupOps(s)).toEqual([]);
	});

	it("drops non-durable member ids (positional ids are never collapsed on the wire)", () => {
		const s = makeStore();
		// Force a group with a positional member id by constructing it directly.
		s.groups = [{ id: "g:m9:p0", memberIds: ["m9:p0", "a:r1:p0"], folded: true }];
		const ops = computeGroupOps(s);
		expect(ops[0].memberIds).toEqual(["a:r1:p0"]); // m9:p0 filtered out
	});
});

describe("resolveUnfold — group code", () => {
	it("a group's code unfolds the WHOLE group and reports it restored", () => {
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		expect(g.folded).toBe(true);
		const { restored, missing } = resolveUnfold(s, [foldCode(g.id)]);
		expect(missing).toEqual([]);
		expect(restored.length).toBe(1);
		expect(restored[0].label).toContain("group");
		expect(s.groupById(g.id)!.folded).toBe(false); // group is now open → drops from computeGroupOps
		expect(computeGroupOps(s)).toEqual([]);
	});

	it("group unfold populates ids with the group's memberIds (not empty)", () => {
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		// The group covers: a:r1:p0, a:r1:p1, a:r1:p2, r:c1 (snapped to whole messages)
		const { restored } = resolveUnfold(s, [foldCode(g.id)]);
		expect(restored.length).toBe(1);
		// ids must be the group's memberIds — never empty — so the conductor notification
		// for agentUnfold carries the actual block ids rather than []
		expect(restored[0].ids).toEqual(g.memberIds);
		expect(restored[0].ids.length).toBeGreaterThan(0);
	});

	it("reports an unknown code as missing and changes nothing", () => {
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		const { restored, missing } = resolveUnfold(s, ["zzzzzz"]);
		expect(restored).toEqual([]);
		expect(missing).toEqual(["zzzzzz"]);
		expect(s.groupById(g.id)!.folded).toBe(true); // untouched
	});
});
