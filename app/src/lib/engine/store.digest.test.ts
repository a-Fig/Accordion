/*
 * store.digest.test.ts — the store actions behind the editable folded digest.
 *
 * `setBlockDigest` and `setGroupSummary` are what the UI's `DigestEditor` calls. The interesting
 * behaviour is at the edges: what an EMPTY box means (different at block vs group granularity),
 * what `null` means (restore the engine's own text), and that a group summary rewrite keeps the
 * group's identity — and therefore any handle an agent is already holding.
 */
import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import { EMPTY_DIGEST, foldCode, hasFoldTag } from "$core/digest";
import type { Block, ParsedSession } from "./types";

function b(id: string, kind: Block["kind"], turn: number, order: number, tokens: number, callId?: string): Block {
	return { id, kind, turn, order, text: `${id} ${"x".repeat(tokens * 4)}`, tokens, callId, override: null, autoFolded: false, by: null };
}

function makeStore(): AccordionStore {
	const blocks: Block[] = [
		b("u:1", "user", 1, 0, 100),
		b("a:r1:p0", "thinking", 1, 1, 800),
		b("a:r1:p1", "text", 1, 2, 600),
		b("a:r1:p2", "tool_call", 1, 3, 100, "c1"),
		b("r:c1", "tool_result", 1, 4, 3000, "c1"),
		b("u:2", "user", 2, 5, 100),
	];
	const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks, lineCount: 0, skipped: 0 };
	const s = new AccordionStore(parsed);
	s.setBudget(1_000_000);
	s.setProtect(0);
	return s;
}

describe("setBlockDigest", () => {
	it("writes the human's text and folds a still-live block in one call", () => {
		const s = makeStore();
		expect(s.isFolded(s.get("r:c1")!)).toBe(false);
		s.setBlockDigest("r:c1", "  ran the tests, all green  ");
		const blk = s.get("r:c1")!;
		expect(s.isFolded(blk)).toBe(true);
		expect(s.digestOf(blk)).toBe("ran the tests, all green"); // trimmed
	});

	it("an empty box saves as the {empty} sentinel, never as nothing", () => {
		const s = makeStore();
		s.setBlockDigest("r:c1", "   \n  ");
		expect(s.digestOf(s.get("r:c1")!)).toBe(EMPTY_DIGEST);
		// A truly empty digestText would be dropped by `applyPlan` and the block would ship WHOLE.
		const op = s.computeFoldOps().find((o) => o.id === "r:c1");
		expect(op?.digestText).toBe(EMPTY_DIGEST);
	});

	it("null restores the engine digest, tag and all", () => {
		const s = makeStore();
		s.setBlockDigest("r:c1", "mine");
		expect(hasFoldTag(s.digestOf(s.get("r:c1")!))).toBe(false);
		s.setBlockDigest("r:c1", null);
		const blk = s.get("r:c1")!;
		expect(blk.subst).toBeUndefined();
		expect(hasFoldTag(s.digestOf(blk))).toBe(true);
		expect(s.isFolded(blk)).toBe(true); // still folded — only the TEXT went back to auto
	});

	it("takes the block over from a conductor that folded it", () => {
		const s = makeStore();
		s.fold("r:c1", "auto", "conductor's summary");
		expect(s.get("r:c1")!.by).toBe("auto");
		expect(s.get("r:c1")!.override).toBeNull();

		s.setBlockDigest("r:c1", "no, mine");
		const blk = s.get("r:c1")!;
		expect(blk.override).toBe("folded");
		expect(blk.by).toBe("you");

		// And the conductor cannot take it back: every strategy write refuses on a human override.
		s.fold("r:c1", "auto", "let me back in");
		expect(s.digestOf(s.get("r:c1")!)).toBe("no, mine");
	});
});

describe("setGroupSummary", () => {
	it("rewrites the summary and KEEPS the group id (so an agent handle survives)", () => {
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		const before = foldCode(g.id);

		s.setGroupSummary(g.id, "the whole investigation, in one line");
		const after = s.groupById(g.id);
		expect(after).toBeDefined();
		expect(foldCode(after!.id)).toBe(before);
		expect(s.groupSummary(after!)).toBe("the whole investigation, in one line");
		expect(after!.memberIds).toEqual(g.memberIds);
		expect(after!.folded).toBe(true);
	});

	it("an empty box is a REAL drop at group granularity", () => {
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		s.setGroupSummary(g.id, "");
		const after = s.groupById(g.id)!;
		expect(s.isDropGroup(after)).toBe(true);
		// A drop emits no message at all — unlike a block, where empty means `{empty}`.
		expect(s.computeGroupOps().find((o) => o.id === g.id)?.summaryText).toBeNull();
	});

	it("null restores the engine's default recap", () => {
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1", "you", "custom")!;
		expect(s.groupSummary(s.groupById(g.id)!)).toBe("custom");

		s.setGroupSummary(g.id, null);
		const summary = s.groupSummary(s.groupById(g.id)!);
		expect(hasFoldTag(summary)).toBe(true);
		expect(summary).toContain("group ·");
	});

	it("un-drops a drop group when text is typed back in", () => {
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		s.setGroupSummary(g.id, "");
		expect(s.isDropGroup(s.groupById(g.id)!)).toBe(true);

		s.setGroupSummary(g.id, "actually, keep a note of this");
		const after = s.groupById(g.id)!;
		expect(s.isDropGroup(after)).toBe(false);
		expect(s.groupSummary(after)).toBe("actually, keep a note of this");
	});

	it("is a no-op on an unknown group id", () => {
		const s = makeStore();
		const before = s.groups.length;
		s.setGroupSummary("g:nope", "hello");
		expect(s.groups.length).toBe(before);
	});
});
