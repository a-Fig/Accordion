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
	s.setProtect(1); // protect only the newest block (u:3): target=1, newest=100 ≥ 1
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

	it("snaps a mid-message selection outward to whole messages (start pulls in sibling parts)", () => {
		const s = makeStore();
		// select from the assistant's TEXT part through its tool result; the START must snap
		// outward to the whole assistant message (pull in the sibling thinking + tool_call).
		const g = s.createGroup("a:r1:p1", "r:c1")!;
		expect(g.memberIds).toEqual(["a:r1:p0", "a:r1:p1", "a:r1:p2", "r:c1"]);
	});

	it("snaps whole assistant messages for LOADED/parsed id shapes (<eid>:<i>, no `p`)", () => {
		// parse.ts emits assistant parts as `<eid>:<i>` (bare numeric index, no `p`). messageKey
		// must still group them, or the Demo/loaded session snaps each part as its own message.
		const blocks: Block[] = [
			b("u:1", "user", 1, 0, 500),
			b("evt9:0", "thinking", 1, 1, 800),
			b("evt9:1", "text", 1, 2, 600),
			b("evt9:2", "tool_call", 1, 3, 100, "c1"),
			b("evt9:r", "tool_result", 1, 4, 3000, "c1"),
			b("u:2", "user", 2, 5, 400),
			b("u:3", "user", 3, 6, 100),
		];
		const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks, lineCount: 0, skipped: 0 };
		const s = new AccordionStore(parsed);
		s.setBudget(1_000_000);
		s.setProtect(0);
		// selecting the middle text part through the result must snap the START outward to the
		// whole assistant message — proving messageKey groups the bare-index `<eid>:<i>` parts.
		const g = s.createGroup("evt9:1", "evt9:r")!;
		expect(g).not.toBeNull();
		expect(g.memberIds).toEqual(["evt9:0", "evt9:1", "evt9:2", "evt9:r"]);
	});

	it("refuses a range that reaches into the protected tail", () => {
		const s = makeStore(); // protectedFromIndex = 7 (u:3)
		expect(s.createGroup("a:r2:p0", "u:3")).toBeNull();
		expect(s.groups.length).toBe(0);
	});

	// ── Reviewer-flagged claim (PR review): "if the selection ENDS on a block whose
	// message extends into the protected tail, the hi-snap pushes hi >= protectedFromIndex
	// and the group is rejected even though the user's original selection was entirely in
	// the older slice." Proposed fix: stop the snap at `protectedFromIndex - 1`.
	//
	// These two tests establish the governing model fact and show the proposed fix is wrong:
	// whenever the hi-snap crosses the boundary it is because the SNAPPED MESSAGE STRADDLES
	// it (has at least one part at index >= protectedFromIndex, hence partly protected). A
	// group must snap to WHOLE messages (ADR 0006 §1/§4: never collapse a message's parts in
	// half), so the only group that could contain that message must include its protected
	// part — there is NO fully-valid (whole-message, no-protected-part) selection there.
	// Rejecting is therefore CORRECT, not a bug. Stopping at `protectedFromIndex - 1` would
	// instead admit a HALF-message group (older parts grouped, the protected tail-half left
	// out) — exactly the invariant the snap exists to prevent.
	describe("reviewer claim — boundary-crossing snap always means a partly-protected message", () => {
		// A multi-part assistant message that STRADDLES the protected boundary.
		//   0 u:1        user        500
		//   1 a:rX:p0    thinking    800   ┐
		//   2 a:rX:p1    text        600   │ one assistant message (key a:rX), 3 parts
		//   3 a:rX:p2    text       8000   ┘  ← this part sits inside the protected tail
		//   4 u:2        user         100  (newest)
		// With protectTokens = 8000, the protected tail walks back summing full tokens:
		// u:2 (100) + a:rX:p2 (8000) reaches 8000 at index 3 → protectedFromIndex = 3.
		// So a:rX:p2 (index 3) is PROTECTED while a:rX:p0/p1 (indices 1,2) are older.
		function straddleStore(): AccordionStore {
			const blocks: Block[] = [
				b("u:1", "user", 1, 0, 500),
				b("a:rX:p0", "thinking", 1, 1, 800),
				b("a:rX:p1", "text", 1, 2, 600),
				b("a:rX:p2", "text", 1, 3, 8000),
				b("u:2", "user", 2, 4, 100),
			];
			const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks, lineCount: 0, skipped: 0 };
			const s = new AccordionStore(parsed);
			s.setBudget(1_000_000);
			s.setProtect(8000);
			return s;
		}

		it("the straddling message genuinely has a protected part (the model fact)", () => {
			const s = straddleStore();
			expect(s.protectedFromIndex).toBe(3); // index 3 (a:rX:p2) and later are protected
			expect(s.isProtected(s.get("a:rX:p2")!)).toBe(true); // the message's last part IS protected
			expect(s.isProtected(s.get("a:rX:p0")!)).toBe(false); // its earlier parts are older
			expect(s.isProtected(s.get("a:rX:p1")!)).toBe(false);
		});

		it("a selection ending mid-straddling-message is REJECTED — and that is correct", () => {
			const s = straddleStore();
			// The "entirely in the older slice" selection the reviewer describes: u:1 .. a:rX:p1
			// (indices 0..2, all older than the boundary at 3). The hi-snap pulls a:rX:p1's
			// sibling a:rX:p2 (index 3) into the range — but a:rX:p2 IS protected, so the only
			// whole-message group here would include protected content. Refuse it.
			expect(s.createGroup("u:1", "a:rX:p1")).toBeNull();
			expect(s.groups.length).toBe(0);
			// There is NO valid group that touches this message without reaching protection:
			// snapping to the whole message always pulls in the protected part.
			expect(s.createGroup("a:rX:p0", "a:rX:p1")).toBeNull();
		});

		it("a selection on a WHOLE non-straddling message older than the tail still groups fine", () => {
			// Sanity: the rejection above is specific to the straddle, not a blanket block on
			// groups near the tail. Give the message that ends just before the boundary a
			// clean partner so a real, fully-older group exists and is accepted.
			//   0 u:1     user      500
			//   1 a:rA:p0 text      600
			//   2 u:2     user      600
			//   3 a:rB:p0 text      400
			//   4 u:3     user     8000  ← protected tail (protectedFromIndex = 4)
			const blocks: Block[] = [
				b("u:1", "user", 1, 0, 500),
				b("a:rA:p0", "text", 1, 1, 600),
				b("u:2", "user", 2, 2, 600),
				b("a:rB:p0", "text", 2, 3, 400),
				b("u:3", "user", 3, 4, 8000),
			];
			const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks, lineCount: 0, skipped: 0 };
			const s = new AccordionStore(parsed);
			s.setBudget(1_000_000);
			s.setProtect(8000);
			expect(s.protectedFromIndex).toBe(4); // only u:3 protected
			// u:2 .. a:rB:p0 (indices 2..3) — whole messages, entirely older than index 4.
			const g = s.createGroup("u:2", "a:rB:p0");
			expect(g).not.toBeNull();
			expect(g!.memberIds).toEqual(["u:2", "a:rB:p0"]);
		});
	});

	it("refuses a group that would collapse NOTHING (every member a split tool-pair half)", () => {
		const blocks: Block[] = [
			b("u:1", "user", 1, 0, 500),
			b("a:rA:p0", "tool_call", 1, 1, 100, "c1"), // call c1 — its result is OUTSIDE the range
			b("a:rB:p0", "tool_call", 1, 2, 100, "c2"), // call c2 — its result is OUTSIDE the range
			b("r:c1", "tool_result", 1, 3, 500, "c1"),
			b("r:c2", "tool_result", 1, 4, 500, "c2"),
			b("u:2", "user", 2, 5, 100),
		];
		const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks, lineCount: 0, skipped: 0 };
		const s = new AccordionStore(parsed);
		s.setBudget(1_000_000);
		s.setProtect(0);
		// Both members are tool_calls whose results sit after the range → all stragglers, nothing
		// collapses → a folder tile that hides live blocks for zero savings. Refused.
		expect(s.createGroup("a:rA:p0", "a:rB:p0")).toBeNull();
		expect(s.groups.length).toBe(0);
	});

	it("allows a 1-member group (≥1 rule relaxed from ≥2) and refuses an overlapping one", () => {
		const s = makeStore();
		// A single-block group is now valid (minimum is ≥1 since the drop-group feature landed).
		// u:1 is a user block with no tool-pair dependency, so it has a carrier and collapses.
		const single = s.createGroup("u:1", "u:1");
		expect(single).not.toBeNull();
		expect(single!.memberIds).toEqual(["u:1"]);
		s.deleteGroup(single!.id); // clean up so we can test the overlap case independently
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

	it("a folded group controls its members — pin/fold/unfold on a member is refused (no silent swallow)", () => {
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1")!; // folded by default
		const before = s.liveTokens;
		// A human pin on a collapsed member used to be RECORDED but ignored by the group's
		// wire state (the override was a lie). It must now be refused outright.
		s.pin("r:c1");
		expect(s.get("r:c1")!.override).toBeNull();
		expect(s.blocks.filter((b) => b.override === "pinned" && !s.isFolded(b)).length).toBe(0);
		// fold/unfold likewise no-op while the group owns the block.
		s.fold("a:r1:p1");
		s.unfold("a:r1:p0");
		expect(s.get("a:r1:p1")!.override).toBeNull();
		expect(s.get("a:r1:p0")!.override).toBeNull();
		expect(s.liveTokens).toBe(before); // accounting untouched by the refused actions
		// Unfolding the group hands control back: per-block overrides apply again.
		s.unfoldGroup(g.id);
		s.pin("r:c1");
		expect(s.get("r:c1")!.override).toBe("pinned");
	});

	it("auto() is also refused on a collapsed member — a pre-existing override is preserved", () => {
		const s = makeStore();
		s.pin("a:r1:p1"); // pin BEFORE grouping (allowed; members keep their override)
		s.createGroup("a:r1:p0", "r:c1"); // folds the group over the pinned block
		s.auto("a:r1:p1"); // would normally clear the override — must be a no-op while folded
		expect(s.get("a:r1:p1")!.override).toBe("pinned");
	});

	it("a member pinned before grouping is not counted as pinned when collapsed (it reads folded)", () => {
		const s = makeStore();
		s.pin("a:r1:p1");
		// Before grouping: the pinned block is visible as pinned.
		expect(s.blocks.filter((b) => b.override === "pinned" && !s.isFolded(b)).length).toBe(1);
		s.createGroup("a:r1:p0", "r:c1"); // the pinned block is now collapsed inside the folder
		expect(s.isFolded(s.get("a:r1:p1")!)).toBe(true);
		// After grouping: the block reads folded (collapsed in group), so it should not be counted as pinned.
		expect(s.blocks.filter((b) => b.override === "pinned" && !s.isFolded(b)).length).toBe(0); // header must not contradict what the user sees
	});

	it("dissolves a group if the protected tail later grows over it (ADR 0006 watch item)", () => {
		const s = makeStore();
		const full = s.liveTokens;
		s.createGroup("a:r1:p0", "r:c1");
		expect(s.groups.length).toBe(1);
		expect(s.liveTokens).toBeLessThan(full);
		// Widen the protected tail past the whole session → the group is now protected.
		s.setProtect(1_000_000);
		expect(s.protectedFromIndex).toBe(0); // everything protected
		expect(s.groups.length).toBe(0); // group dissolved, not silently collapsing protected content
		expect(s.liveTokens).toBe(full); // accounting restored
	});
});
