import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccordionStore } from "../engine/store.svelte";
import type { Block, BlockKind, ParsedSession } from "../engine/types";
import { foldAlarm, runFoldCheck } from "./foldAlarm.svelte";

// foldAlarm is the BACKSTOP that watches for view↔wire fold divergence after the
// engine's foldability gates. These tests lock the three layers: the universal kind
// gate (all modes), the live-only symmetric-difference of view folds vs emitted wire
// folds, and that a clean demo/live store stays inactive. The alarm never mutates the
// store and never throws — it only flips `foldAlarm.active`/`.detail`.

interface BlkOpts {
	id: string;
	kind?: BlockKind;
	tokens?: number;
	text?: string;
	toolName?: string;
	callId?: string;
}

let order = 0;
function blk(o: BlkOpts): Block {
	const i = order++;
	return {
		id: o.id,
		kind: o.kind ?? "text",
		turn: i + 1,
		order: i,
		text: o.text ?? `block ${i} ` + "lorem ipsum dolor sit amet ".repeat(8),
		tokens: o.tokens ?? 8000,
		toolName: o.toolName,
		callId: o.callId,
		override: null,
		autoFolded: false,
		by: null,
	};
}

function makeStore(blocks: Block[]): AccordionStore {
	order = 0;
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks,
		lineCount: 0,
		skipped: 0,
	};
	return new AccordionStore(parsed);
}

// import.meta.env.DEV is true under vitest, so a mismatch fires a console.error by design.
// Silence it so the test output stays clean (we assert on foldAlarm state, not the log).
beforeEach(() => {
	foldAlarm.active = false;
	foldAlarm.detail = "";
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runFoldCheck — universal kind gate (all modes)", () => {
	it("stays inactive for a demo-style store (non-durable ids) with a folded tool_result", () => {
		order = 0;
		const blocks = [
			blk({ id: "evt1:r", kind: "tool_result", tokens: 8000, toolName: "grep", callId: "c1" }),
			blk({ id: "evt2:0", kind: "text", tokens: 8000 }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		s.setBudget(1000); // auto-fold the old foldable blocks (foldable kinds only)
		expect(s.foldedCount).toBeGreaterThan(0);

		// off-wire (isLive=false): only the universal kind gate runs; everything folded is a
		// foldable kind, so no lie → inactive.
		runFoldCheck(s, false);
		expect(foldAlarm.active).toBe(false);
		expect(foldAlarm.detail).toBe("");
	});

	it("fires when a non-foldable kind (tool_call) is folded in the view (injected regression)", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "tool_call", tokens: 8000, toolName: "read", callId: "c1" }),
			blk({ id: "a:resp1:p1", kind: "text", tokens: 8000 }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);

		// Bypass the gate: set autoFolded DIRECTLY on the tool_call, simulating a regression
		// where the fold door let a non-foldable kind through. store.fold() would refuse it.
		const b = s.get("a:resp1:p0")!;
		b.autoFolded = true;
		expect(s.isFolded(b)).toBe(true);

		runFoldCheck(s, false);
		expect(foldAlarm.active).toBe(true);
		expect(foldAlarm.detail).toContain("a:resp1:p0");
		expect(foldAlarm.detail).toContain("tool_call");
	});

	it("clears again once the injected fold is removed", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "tool_call", tokens: 8000, toolName: "read", callId: "c1" }),
			blk({ id: "a:resp1:p1", kind: "text", tokens: 8000 }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		const b = s.get("a:resp1:p0")!;

		b.autoFolded = true;
		runFoldCheck(s, false);
		expect(foldAlarm.active).toBe(true);

		b.autoFolded = false;
		runFoldCheck(s, false);
		expect(foldAlarm.active).toBe(false);
		expect(foldAlarm.detail).toBe("");
	});
});

describe("runFoldCheck — live-only view↔wire symmetric difference", () => {
	it("stays inactive when every folded block is foldable-kind + durable-id", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "a:resp1:p1", kind: "thinking", tokens: 8000 }),
			blk({ id: "r:call1", kind: "tool_result", tokens: 8000, toolName: "grep", callId: "call1" }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
			blk({ id: "a:resp2:p0", kind: "text", tokens: 50, text: "ok" }),
		];
		const s = makeStore(blocks);
		s.setProtect(80);
		s.setBudget(1000); // auto-fold the old durable foldable blocks
		expect(s.foldedCount).toBeGreaterThan(0);

		runFoldCheck(s, true);
		expect(foldAlarm.active).toBe(false);
		expect(foldAlarm.detail).toBe("");
	});

	it("fires when a foldable-kind block is folded in the view but dropped from the wire (non-durable id)", () => {
		order = 0;
		const blocks = [
			// foldable kind (text) but a POSITIONAL/non-durable id → computeFoldOps drops it,
			// yet the view folds it → in viewSet, not in wireSet → mismatch.
			blk({ id: "m9:p0", kind: "text", tokens: 8000 }),
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		s.setBudget(1000); // auto-fold the old blocks (incl. the non-durable one)
		expect(s.isFolded(s.get("m9:p0")!)).toBe(true); // folded in the view

		// off-wire: only Layer 1 runs, and a foldable-kind fold is no lie there → inactive.
		runFoldCheck(s, false);
		expect(foldAlarm.active).toBe(false);

		// live: Layer 2 runs — the non-durable block is in viewSet but not the wire plan → fires.
		runFoldCheck(s, true);
		expect(foldAlarm.active).toBe(true);
		expect(foldAlarm.detail).toContain("m9:p0");
	});
});

describe("runFoldCheck — folded groups are exempt (group collapse is not a per-block lie)", () => {
	// A GROUP collapse (ADR 0006) is structural whole-message removal, NOT per-block content
	// folding — so it may legitimately collapse a tool_call / user member. Such a member reads
	// `isFolded === true` but its KIND is non-foldable; the universal check MUST skip it (via the
	// `!groupOf(b)?.folded` exclusion) or it would false-fire on every legitimate group collapse.
	// This pins that exclusion: remove it and this test goes red. (Group straggler BALANCE is a
	// separate, deliberately-unverified concern — extension structural guard + Slice 2.)
	it("stays inactive when a folded group contains a tool_call member (off-wire AND live)", () => {
		order = 0;
		const blocks = [
			blk({ id: "u:1", kind: "user", tokens: 500, text: "do it" }),
			blk({ id: "a:r1:p0", kind: "thinking", tokens: 800 }),
			blk({ id: "a:r1:p1", kind: "text", tokens: 600 }),
			blk({ id: "a:r1:p2", kind: "tool_call", tokens: 100, toolName: "read", callId: "c1" }),
			blk({ id: "r:c1", kind: "tool_result", tokens: 3000, toolName: "read", callId: "c1" }),
			blk({ id: "u:2", kind: "user", tokens: 400, text: "thanks" }),
		];
		const s = makeStore(blocks);
		s.setBudget(1_000_000); // isolate: no auto-fold, the group is the only fold
		s.setProtect(1); // protect only the newest block (u:2)

		const g = s.createGroup("a:r1:p0", "r:c1")!;
		expect(g.folded).toBe(true);
		expect(g.memberIds).toContain("a:r1:p2"); // the tool_call is swept into the group

		// Precondition that makes this a REAL test of the exclusion: the tool_call member reads
		// folded (collapsed) AND has a non-foldable kind — exactly the shape Layer 1 would flag
		// if it didn't exempt folded-group members.
		const tc = s.get("a:r1:p2")!;
		expect(s.isFolded(tc)).toBe(true);
		expect(s.groupOf(tc)?.folded).toBe(true);

		runFoldCheck(s, false);
		expect(foldAlarm.active).toBe(false);
		runFoldCheck(s, true);
		expect(foldAlarm.active).toBe(false);
		expect(foldAlarm.detail).toBe("");
	});
});
