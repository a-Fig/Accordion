import { describe, it, expect } from "vitest";
import type { Block, BlockKind } from "./types";
import { digest, digestTokens, foldTag, foldCode } from "./digest";
import { estTokens, BLOCK_OVERHEAD } from "./tokens";

// The folded digest carries a leading `{#<code> FOLDED}` tag, where <code> is a short
// stable hash of the durable id. This is the engine's single source of truth: the same
// string is rendered in the GUI, sent on the wire, AND counted by digestTokens. These
// tests lock the tag's presence/shape and that token accounting includes it (so the
// saved-tokens figure never lies).

function blk(o: Partial<Block> & { id: string; kind: BlockKind }): Block {
	return {
		id: o.id,
		kind: o.kind,
		turn: o.turn ?? 1,
		order: o.order ?? 0,
		text: o.text ?? "some content here that is long enough to summarize",
		tokens: o.tokens ?? 500,
		toolName: o.toolName,
		callId: o.callId,
		isError: o.isError,
		override: null,
		autoFolded: false,
		by: null,
	};
}

describe("foldCode", () => {
	it("is a short 4-char base36 code", () => {
		expect(foldCode("a:f2965ed9-323d-4c24-b489-d93e8c55c59e:p0")).toMatch(/^[0-9a-z]{4}$/);
		expect(foldCode("u:1780799122422")).toMatch(/^[0-9a-z]{4}$/);
	});
	it("is deterministic and id-specific (same id → same code, different id → usually different)", () => {
		const a = foldCode("a:resp-abc:p0");
		expect(foldCode("a:resp-abc:p0")).toBe(a); // stable, no state
		expect(foldCode("a:resp-abc:p1")).not.toBe(a); // a neighbouring part differs
		expect(foldCode("r:call-xyz")).not.toBe(a);
	});
});

describe("foldTag", () => {
	it("formats the marker as {#<code> FOLDED} using the hashed code, not the raw id", () => {
		const id = "a:f2965ed9-323d-4c24-b489-d93e8c55c59e:p0";
		expect(foldTag(id)).toBe(`{#${foldCode(id)} FOLDED}`);
		// the ugly raw id never appears in the tag
		expect(foldTag(id)).not.toContain("f2965ed9");
		expect(foldTag(id).length).toBeLessThan(20);
	});
});

describe("digest tag", () => {
	const kinds: BlockKind[] = ["user", "text", "thinking", "tool_call", "tool_result"];

	it("prepends the {#<code> FOLDED} tag for every kind", () => {
		for (const kind of kinds) {
			const id = `a:${kind}:p0`;
			const b = blk({ id, kind, toolName: "grep", callId: "c1" });
			expect(digest(b).startsWith(`{#${foldCode(id)} FOLDED} `)).toBe(true);
		}
	});

	it("keeps the per-kind body after the tag (tag is additive, not a replacement)", () => {
		const b = blk({ id: "a:r1:p0", kind: "text", text: "the assistant concluded the fix is correct" });
		expect(digest(b)).toContain("the assistant concluded");
	});
});

describe("digestTokens includes the tag cost", () => {
	it("accounts for the tag, so token math matches what the agent receives", () => {
		const b = blk({ id: "a:resp-abc:p0", kind: "text", text: "x".repeat(400) });
		// digestTokens must equal estTokens(full tagged digest) + overhead — i.e. it counts
		// the tag, not just the body. (Regression guard against re-introducing a wire-only
		// tag that the engine under-counts.)
		const expected = estTokens(digest(b)) + BLOCK_OVERHEAD;
		expect(digestTokens(b)).toBe(expected);
	});
});
