import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import type { Block, ParsedSession } from "./types";

// A protected block is NEVER folded — by the auto-folder OR the user. This is the
// safety pillar; these tests lock it so it can't silently regress.

function blk(i: number, tokens: number): Block {
	return {
		id: `m${i}:p0`,
		kind: "text",
		turn: i + 1,
		order: i,
		text: `block ${i} ` + "x".repeat(160),
		tokens,
		override: null,
		autoFolded: false,
		by: null,
	};
}
function makeStore(n: number, tokens = 1000): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks: Array.from({ length: n }, (_, i) => blk(i, tokens)),
		lineCount: 0,
		skipped: 0,
	};
	return new AccordionStore(parsed);
}

describe("protected working tail is never folded", () => {
	it("auto-folder folds old blocks but never a protected one", () => {
		const s = makeStore(5); // 5×1000 tok
		s.setProtect(2000); // protects the newest two (indices 3,4)
		s.setBudget(2500); // 5000 live > budget → must auto-fold

		expect(s.protectedFromIndex).toBe(3);
		expect(s.foldedCount).toBeGreaterThan(0); // it actually folded something (regression guard)
		// none of the protected tail is folded
		expect(s.isFolded(s.blocks[3])).toBe(false);
		expect(s.isFolded(s.blocks[4])).toBe(false);
		// the folded ones are all older than the protected boundary
		s.blocks.forEach((b, i) => {
			if (s.isFolded(b)) expect(i).toBeLessThan(s.protectedFromIndex);
		});
	});

	it("manual fold() is refused on a protected block", () => {
		const s = makeStore(5);
		s.setProtect(2000); // protects indices 3,4
		s.fold(s.blocks[4].id); // explicit user fold on a protected block
		expect(s.isFolded(s.blocks[4])).toBe(false);
		expect(s.blocks[4].override).toBe(null);
	});

	it("manual fold() still works on a non-protected block (folding isn't broken)", () => {
		const s = makeStore(5);
		s.setProtect(2000); // protects indices 3,4
		s.fold(s.blocks[0].id);
		expect(s.isFolded(s.blocks[0])).toBe(true);
		expect(s.blocks[0].override).toBe("folded");
	});

	it("a folded block that later becomes protected heals back to live", () => {
		const s = makeStore(5);
		s.setProtect(0); // nothing protected yet
		s.fold(s.blocks[1].id); // legitimately fold an old block
		expect(s.isFolded(s.blocks[1])).toBe(true);

		s.setProtect(1_000_000); // widen the tail to cover the whole session
		expect(s.protectedFromIndex).toBe(0); // everything protected now
		expect(s.isFolded(s.blocks[1])).toBe(false); // healed
		expect(s.blocks[1].override).toBe(null);
	});
});

// appendBlocks must be idempotent by id: a block can arrive twice (streamed early
// at message_end, then again in the next context reconcile). The source of truth
// must never hold two blocks with one id, and a resend must not clobber fold state.
describe("appendBlocks is idempotent by id", () => {
	it("drops a re-sent id and preserves its existing fold state", () => {
		const s = makeStore(3);
		s.setProtect(0); // blocks 0,1 foldable (newest is always protected)
		s.fold(s.blocks[0].id); // user folds block m0:p0
		expect(s.isFolded(s.blocks[0])).toBe(true);

		const before = s.blocks.length;
		s.appendBlocks([blk(0, 1000)]); // reconcile re-sends the same id, override:null
		expect(s.blocks.length).toBe(before); // not appended again
		expect(s.blocks[0].override).toBe("folded"); // fold state NOT reset by the resend
	});

	it("dedups a duplicate id within a single batch", () => {
		const s = makeStore(2);
		const before = s.blocks.length;
		s.appendBlocks([blk(99, 500), blk(99, 500)]); // same new id twice
		expect(s.blocks.length).toBe(before + 1); // only one added
		expect(s.blocks.filter((b) => b.id === "m99:p0").length).toBe(1);
	});

	it("still appends genuinely-new ids", () => {
		const s = makeStore(2);
		const before = s.blocks.length;
		s.appendBlocks([blk(5, 500), blk(6, 500)]); // two fresh ids
		expect(s.blocks.length).toBe(before + 2);
	});
});
