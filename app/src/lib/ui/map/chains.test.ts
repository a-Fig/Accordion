import { describe, it, expect } from "vitest";
import { chainsOf } from "./chains";
import type { Block } from "../../engine/types";

function b(id: string, kind: Block["kind"], order: number, callId?: string): Block {
	return { id, kind, turn: 1, order, text: id, tokens: 100, callId, override: null, autoFolded: false, by: null };
}

const ids = (chains: Block[][]) => chains.map((chain) => chain.map((block) => block.id));

describe("chainsOf", () => {
	it("keeps separate live assistant messages separate", () => {
		const chains = chainsOf([
			b("u:1", "user", 0),
			b("a:r1:p0", "thinking", 1),
			b("a:r1:p1", "text", 2),
			b("a:r2:p0", "text", 3),
		]);

		expect(ids(chains)).toEqual([["u:1"], ["a:r1:p0", "a:r1:p1"], ["a:r2:p0"]]);
	});

	it("also groups loaded transcript assistant part ids", () => {
		const chains = chainsOf([
			b("evt9:0", "thinking", 0),
			b("evt9:1", "text", 1),
			b("evt10:0", "text", 2),
		]);

		expect(ids(chains)).toEqual([["evt9:0", "evt9:1"], ["evt10:0"]]);
	});

	it("attaches tool results to the active chain", () => {
		const chains = chainsOf([
			b("a:r1:p0", "tool_call", 0, "c1"),
			b("r:c1", "tool_result", 1, "c1"),
			b("u:2", "user", 2),
		]);

		expect(ids(chains)).toEqual([["a:r1:p0", "r:c1"], ["u:2"]]);
	});
});
