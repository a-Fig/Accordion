import { describe, it, expect } from "vitest";
import { buildDisplay } from "./display";
import type { Block, Group } from "./types";

function blk(id: string): Block {
	return { id, kind: "text", turn: 1, order: 0, text: "x", tokens: 100, override: null, autoFolded: false, by: null };
}
const ids = (rows: ReturnType<typeof buildDisplay>) =>
	rows.map((r) => (r.type === "block" ? `b:${r.block.id}` : `${r.type}:${r.group.id}(${r.members.length})`));

describe("buildDisplay", () => {
	const blocks = ["a", "b", "c", "d", "e"].map(blk);

	it("maps blocks 1:1 when there are no groups", () => {
		expect(ids(buildDisplay(blocks, []))).toEqual(["b:a", "b:b", "b:c", "b:d", "b:e"]);
	});

	it("a folded group becomes ONE row at its first member and hides the rest of the range", () => {
		const g: Group = { id: "g:b", memberIds: ["b", "c", "d"], folded: true };
		expect(ids(buildDisplay(blocks, [g]))).toEqual(["b:a", "group:g:b(3)", "b:e"]);
	});

	it("an open group becomes a groupOpen row carrying its members (rendered inline)", () => {
		const g: Group = { id: "g:b", memberIds: ["b", "c", "d"], folded: false };
		expect(ids(buildDisplay(blocks, [g]))).toEqual(["b:a", "groupOpen:g:b(3)", "b:e"]);
	});

	it("preserves order across two groups", () => {
		const g1: Group = { id: "g:a", memberIds: ["a", "b"], folded: true };
		const g2: Group = { id: "g:d", memberIds: ["d", "e"], folded: false };
		expect(ids(buildDisplay(blocks, [g1, g2]))).toEqual(["group:g:a(2)", "b:c", "groupOpen:g:d(2)"]);
	});

	it("drops a group whose first member is absent (invariant already broken) rather than emitting strays", () => {
		// 'b' missing from the slice: the group's first member 'a' is present, so it still
		// renders with the members it can resolve. But if the FIRST member is gone, nothing emits.
		const g: Group = { id: "g:x", memberIds: ["x", "c"], folded: true };
		expect(ids(buildDisplay(blocks, [g]))).toEqual(["b:a", "b:b", "b:c", "b:d", "b:e"]);
	});
});
