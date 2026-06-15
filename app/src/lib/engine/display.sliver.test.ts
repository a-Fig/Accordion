/**
 * display.sliver.test.ts — unit tests for buildLane (sliver mode lane items).
 *
 * The corrected model (no merging of adjacent folds):
 *   • live block        → { kind: "tile" }
 *   • ungrouped folded  → { kind: "fold" }  (ONE per block — never merged with neighbours)
 *   • collapsed group   → { kind: "group" } (one cocoa summary + N member slivers)
 * A shared summary only ever comes from an explicit group; adjacency is not grouping.
 */

import { describe, it, expect } from "vitest";
import { buildLane } from "./display";
import type { Block, Group } from "./types";
import type { DisplayRow } from "./display";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let _idCounter = 0;

function makeBlock(kind: Block["kind"] = "text", tokens = 100): Block {
	return {
		id: `b${++_idCounter}`,
		kind,
		turn: _idCounter,
		order: _idCounter,
		text: "test",
		tokens,
		override: null,
		autoFolded: false,
		by: null,
	};
}

function makeGroup(memberIds: string[]): Group {
	return { id: `g${++_idCounter}`, memberIds, folded: true, by: "auto" };
}

function blockRow(block: Block): DisplayRow {
	return { type: "block", block };
}

function groupRow(group: Group, members: Block[]): DisplayRow {
	return { type: "group", group, members };
}

const neverFolded = (_b: Block) => false;
const alwaysFolded = (_b: Block) => true;
const foldedSet =
	(ids: Set<string>) =>
	(b: Block) =>
		ids.has(b.id);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildLane", () => {
	it("all-live → all tiles", () => {
		const blocks = [makeBlock(), makeBlock(), makeBlock()];
		const items = buildLane(blocks.map(blockRow), neverFolded);

		expect(items.map((i) => i.kind)).toEqual(["tile", "tile", "tile"]);
		expect(items[0]).toEqual({ kind: "tile", block: blocks[0] });
	});

	it("one folded block → one fold item (not a cluster)", () => {
		const b1 = makeBlock();
		const items = buildLane([blockRow(b1)], alwaysFolded);

		expect(items).toHaveLength(1);
		expect(items[0]).toEqual({ kind: "fold", block: b1 });
	});

	it("FOUR adjacent folded blocks → FOUR separate fold items (never merged)", () => {
		const blocks = [makeBlock(), makeBlock(), makeBlock(), makeBlock()];
		const items = buildLane(blocks.map(blockRow), alwaysFolded);

		// The core of the corrected model: adjacency does NOT merge folds.
		expect(items).toHaveLength(4);
		expect(items.every((i) => i.kind === "fold")).toBe(true);
		expect(items.map((i) => (i.kind === "fold" ? i.block : null))).toEqual(blocks);
	});

	it("live / folded mix → tiles and folds interleaved, one fold per folded block", () => {
		const b1 = makeBlock(); // folded
		const b2 = makeBlock(); // folded
		const b3 = makeBlock(); // live
		const b4 = makeBlock(); // folded
		const items = buildLane(
			[b1, b2, b3, b4].map(blockRow),
			foldedSet(new Set([b1.id, b2.id, b4.id])),
		);

		expect(items.map((i) => i.kind)).toEqual(["fold", "fold", "tile", "fold"]);
		expect(items[0]).toEqual({ kind: "fold", block: b1 });
		expect(items[1]).toEqual({ kind: "fold", block: b2 });
		expect(items[2]).toEqual({ kind: "tile", block: b3 });
		expect(items[3]).toEqual({ kind: "fold", block: b4 });
	});

	it("all folded → one fold item per block (N folds, not one shared cluster)", () => {
		const blocks = [makeBlock(), makeBlock(), makeBlock()];
		const items = buildLane(blocks.map(blockRow), alwaysFolded);

		expect(items).toHaveLength(3);
		expect(items.map((i) => (i.kind === "fold" ? i.block : null))).toEqual(blocks);
	});

	it("a collapsed group → a single group item (shared cocoa + its members)", () => {
		const m1 = makeBlock();
		const m2 = makeBlock();
		const g = makeGroup([m1.id, m2.id]);
		const items = buildLane([groupRow(g, [m1, m2])], neverFolded);

		expect(items).toHaveLength(1);
		expect(items[0].kind).toBe("group");
		if (items[0].kind === "group") {
			expect(items[0].group).toBe(g);
			expect(items[0].members).toEqual([m1, m2]);
		}
	});

	it("a group between folded blocks → fold, group, fold (group never merges with folds)", () => {
		const b1 = makeBlock(); // folded
		const m = makeBlock(); // group member
		const b3 = makeBlock(); // folded
		const g = makeGroup([m.id]);
		const items = buildLane(
			[blockRow(b1), groupRow(g, [m]), blockRow(b3)],
			foldedSet(new Set([b1.id, b3.id])),
		);

		expect(items.map((i) => i.kind)).toEqual(["fold", "group", "fold"]);
		expect(items[0]).toEqual({ kind: "fold", block: b1 });
		expect(items[2]).toEqual({ kind: "fold", block: b3 });
		if (items[1].kind === "group") {
			expect(items[1].group).toBe(g);
			expect(items[1].members).toEqual([m]);
		}
	});

	it("[group, folded, folded, group] → group, fold, fold, group", () => {
		const m1 = makeBlock();
		const m2 = makeBlock();
		const g1 = makeGroup([m1.id]);
		const g2 = makeGroup([m2.id]);
		const f1 = makeBlock();
		const f2 = makeBlock();
		const items = buildLane(
			[groupRow(g1, [m1]), blockRow(f1), blockRow(f2), groupRow(g2, [m2])],
			foldedSet(new Set([f1.id, f2.id])),
		);

		expect(items.map((i) => i.kind)).toEqual(["group", "fold", "fold", "group"]);
		expect(items[1]).toEqual({ kind: "fold", block: f1 });
		expect(items[2]).toEqual({ kind: "fold", block: f2 });
	});

	it("order is preserved (conversation order)", () => {
		const blocks = [makeBlock(), makeBlock(), makeBlock(), makeBlock(), makeBlock()];
		const items = buildLane(blocks.map(blockRow), alwaysFolded);

		expect(items.map((i) => (i.kind === "fold" ? i.block.id : null))).toEqual(
			blocks.map((b) => b.id),
		);
	});

	it("empty rows → empty items", () => {
		expect(buildLane([], neverFolded)).toHaveLength(0);
	});
});
