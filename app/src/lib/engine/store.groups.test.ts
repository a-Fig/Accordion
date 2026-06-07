import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import type { Block, ParsedSession } from "./types";

// A realistic little session with durable, message-anchored ids so group snapping and
// tool-pair classification behave as they do live. Indices/ids:
//   0 u:1            user      turn1  500
//   1 a:r1:p0        thinking  turn1  800   ┐ one assistant message (shares key a:r1)
//   2 a:r1:p1        text      turn1  600   │
//   3 a:r1:p2        tool_call turn1  100   ┘ callId c1
//   4 r:c1           result    turn1  3000  callId c1
//   5 u:2            user      turn2  400
//   6 a:r2:p0        text      turn2  5000
//   7 u:3            user      turn3  100   (newest)
function b(id: string, kind: Block["kind"], turn: number, order: number, tokens: number, callId?: string): Block {
	return { id, kind, turn, order, text: id + " " + "x".repeat(40), tokens, callId, override: null, autoFolded: false, by: null };
}
function session(): Block[] {
	return [
		b("u:1", "user", 1, 0, 500),
		b("a:r1:p0", "thinking", 1, 1, 800),
		b("a:r1:p1", "text", 1, 2, 600),
		b("a:r1:p2", "tool_call", 1, 3, 100, "c1"),
		b("r:c1", "tool_result", 1, 4, 3000, "c1"),
		b("u:2", "user", 2, 5, 400),
		b("a:r2:p0", "text", 2, 6, 5000),
		b("u:3", "user", 3, 7, 100),
	];
}
function makeStore(): AccordionStore {
	const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks: session(), lineCount: 0, skipped: 0 };
	const s = new AccordionStore(parsed);
	s.setBudget(1_000_000); // never auto-fold — isolate group behavior
	s.setProtect(0); // only the newest block (u:3) is protected
	return s;
}

describe("createGroup — validation & message snapping", () => {
	it("groups a clean range (assistant msg + its tool result) and folds it by default", () => {
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		expect(g).not.toBeNull();
		expect(g.memberIds).toEqual(["a:r1:p0", "a:r1:p1", "a:r1:p2", "r:c1"]);
		expect(g.folded).toBe(true);
		expect(s.groups.length).toBe(1);
	});

	it("snaps a mid-message selection outward to the whole assistant message", () => {
		const s = makeStore();
		// select only the text part of the assistant message; snapping must pull in its
		// sibling thinking + tool_call parts (same a:r1 message key).
		const g = s.createGroup("a:r1:p1", "a:r1:p1")!;
		expect(g.memberIds).toEqual(["a:r1:p0", "a:r1:p1", "a:r1:p2"]);
	});

	it("refuses a range that reaches into the protected tail", () => {
		const s = makeStore(); // protectedFromIndex = 7 (u:3)
		expect(s.createGroup("a:r2:p0", "u:3")).toBeNull();
		expect(s.groups.length).toBe(0);
	});

	it("refuses a <2-member group and an overlapping one", () => {
		const s = makeStore();
		expect(s.createGroup("u:1", "u:1")).toBeNull(); // single user message, 1 block
		s.createGroup("a:r1:p0", "r:c1");
		expect(s.createGroup("a:r1:p1", "u:2")).toBeNull(); // overlaps the existing group
		expect(s.groups.length).toBe(1);
	});
});

describe("folded-group accounting", () => {
	it("collapses a balanced range to one summary; live drops, savings show", () => {
		const s = makeStore();
		const fullBefore = s.liveTokens; // nothing folded
		expect(fullBefore).toBe(500 + 800 + 600 + 100 + 3000 + 400 + 5000 + 100);
		const g = s.createGroup("a:r1:p0", "r:c1")!; // collapses 800+600+100+3000 = 4500 of full
		expect(s.groupFullTokens(g)).toBe(4500);
		expect(s.groupStragglerCount(g)).toBe(0); // c1 call+result both inside → balanced
		// live cost of the group is just the one summary entry (small), so big savings.
		expect(s.groupLiveTokens(g)).toBeLessThan(200);
		expect(s.groupSavedTokens(g)).toBeGreaterThan(4000);
		expect(s.liveTokens).toBe(fullBefore - s.groupSavedTokens(g));
		// the collapsed members read as folded; the summary carries one {#code FOLDED} tag.
		expect(s.isFolded(s.get("r:c1")!)).toBe(true);
		expect(s.groupSummary(g)).toMatch(/^\{#[0-9a-z]{6} FOLDED\} group ·/);
	});

	it("keeps a split tool-pair half LIVE (straggler) while the rest collapses", () => {
		const s = makeStore();
		// range r:c1 .. a:r2:p0 — r:c1's CALL (a:r1:p2) is OUTSIDE the group, so the result
		// is a straggler that must stay live; u:2 + a:r2 collapse.
		const g = s.createGroup("r:c1", "a:r2:p0")!;
		expect(g.memberIds).toEqual(["r:c1", "u:2", "a:r2:p0"]);
		expect(s.groupStragglerCount(g)).toBe(1);
		expect(s.isFolded(s.get("r:c1")!)).toBe(false); // straggler stays live
		expect(s.isFolded(s.get("u:2")!)).toBe(true); // collapsed
		// live cost = one summary (for u:2 + a:r2) + r:c1 kept full (3000).
		expect(s.groupLiveTokens(g)).toBeGreaterThan(3000);
		expect(s.groupLiveTokens(g)).toBeLessThan(3000 + 200);
	});
});

describe("group fold/unfold/delete lifecycle", () => {
	it("unfolding a group returns members to their own state and restores live cost", () => {
		const s = makeStore();
		const full = s.liveTokens;
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		expect(s.liveTokens).toBeLessThan(full);
		s.unfoldGroup(g.id);
		expect(s.groupById(g.id)!.folded).toBe(false);
		// open group is wire-invisible: members are full again (nothing else folded).
		expect(s.liveTokens).toBe(full);
		expect(s.isFolded(s.get("r:c1")!)).toBe(false);
	});

	it("a manual member fold survives a group fold→unfold round trip", () => {
		const s = makeStore();
		s.fold("a:r1:p1"); // user folds one member before grouping
		const g = s.createGroup("a:r1:p0", "r:c1")!; // folds the group (collapses everything)
		expect(s.isFolded(s.get("a:r1:p1")!)).toBe(true);
		s.unfoldGroup(g.id);
		// member override preserved: a:r1:p1 is still individually folded, others live.
		expect(s.get("a:r1:p1")!.override).toBe("folded");
		expect(s.isFolded(s.get("a:r1:p1")!)).toBe(true);
		expect(s.isFolded(s.get("a:r1:p0")!)).toBe(false);
	});

	it("deleteGroup removes the overlay; the range returns to normal", () => {
		const s = makeStore();
		const full = s.liveTokens;
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		s.deleteGroup(g.id);
		expect(s.groups.length).toBe(0);
		expect(s.groupOf(s.get("r:c1")!)).toBeUndefined();
		expect(s.liveTokens).toBe(full);
	});
});
