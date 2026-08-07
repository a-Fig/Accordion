import { describe, it, expect } from "vitest";
import { linearize, applyPlan, blockId, isDurableId, messageInfo, contentFingerprint, wireToBlock, type PiMessage } from "./wire";

/*
 * core/wire.ts is the moved live/mapping.ts. Its provider-safety behavior is exhaustively covered
 * by the app's mapping.*.test.ts (which now import it through the shim). This file confirms the
 * core path itself resolves and the exported surface (incl. the newly-exported `messageInfo`) works.
 */

function session(): PiMessage[] {
	return [
		{ role: "user", content: "hello", timestamp: 1 },
		{
			role: "assistant",
			timestamp: 2,
			responseId: "r1",
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "here is my reply" },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } },
			] as any,
		},
		{ role: "toolResult", toolCallId: "c1", toolName: "read", content: "file contents", timestamp: 3 },
	];
}

describe("core/wire — durable ids", () => {
	it("blockId derives durable, content-anchored ids", () => {
		const ms = session();
		expect(blockId(ms[0], 0)).toBe("u:1");
		expect(blockId(ms[1], 1, 1)).toBe("a:r1:p1");
		expect(blockId(ms[2], 2)).toBe("r:c1");
	});
	it("isDurableId distinguishes anchored from positional", () => {
		expect(isDurableId("u:1")).toBe(true);
		expect(isDurableId("a:r1:p1")).toBe(true);
		expect(isDurableId("r:c1")).toBe(true);
		expect(isDurableId("m3:p0")).toBe(false);
	});
});

describe("core/wire — linearize", () => {
	it("explodes messages into typed blocks in conversation order", () => {
		const blocks = linearize(session());
		expect(blocks.map((b) => b.kind)).toEqual(["user", "thinking", "text", "tool_call", "tool_result"]);
		expect(blocks[3].callId).toBe("c1");
		expect(blocks[4].callId).toBe("c1");
	});
	it("wireToBlock produces a fresh, auto-controlled engine block", () => {
		const w = linearize(session())[2];
		const b = wireToBlock(w);
		expect(b.override).toBe(null);
		expect(b.autoFolded).toBe(false);
		expect(b.by).toBe(null);
	});
});

describe("core/wire — messageInfo (now exported)", () => {
	it("reports a message's durable ids + tool-pair callIds", () => {
		const ms = session();
		expect(messageInfo(ms[1], 1).calls).toEqual(["c1"]);
		expect(messageInfo(ms[2], 2).results).toEqual(["c1"]);
		expect(messageInfo(ms[0], 0).hasNonDurable).toBe(false);
	});
});

describe("core/wire — contentFingerprint (E1, sol P1)", () => {
	it("is stable for identical messages (a fresh deep copy hashes the same)", () => {
		const ms = session();
		const copy = JSON.parse(JSON.stringify(ms)) as PiMessage[];
		for (let i = 0; i < ms.length; i++) expect(contentFingerprint(copy[i])).toBe(contentFingerprint(ms[i]));
	});

	it("gap #1: a SAME-LENGTH in-place text rewrite changes the fingerprint (redaction is no longer invisible)", () => {
		// "secret" → "******": identical length, so the old length-sum scheme saw no change.
		const a: PiMessage = { role: "assistant", responseId: "r1", timestamp: 2, content: [{ type: "text", text: "secret" }] as any };
		const b: PiMessage = { ...a, content: [{ type: "text", text: "******" }] as any };
		expect(blockId(a, 0, 0)).toBe(blockId(b, 0, 0)); // same durable id — shape identity holds
		expect(contentFingerprint(a)).not.toBe(contentFingerprint(b)); // …but content identity does not
	});

	it("gap #2: a tool_call ARGUMENT rewrite under the same id changes the fingerprint", () => {
		const a: PiMessage = {
			role: "assistant", responseId: "r1", timestamp: 2,
			content: [{ type: "toolCall", id: "c1", name: "shell", arguments: { cmd: "ls" } }] as any,
		};
		const b: PiMessage = { ...a, content: [{ type: "toolCall", id: "c1", name: "shell", arguments: { cmd: "rm -rf /" } }] as any };
		expect(messageInfo(a, 0).ids).toEqual(messageInfo(b, 0).ids); // same emitted id
		expect(contentFingerprint(a)).not.toBe(contentFingerprint(b));
	});

	it("gap #3: a tool_result isError flip with IDENTICAL text changes the fingerprint", () => {
		const a: PiMessage = { role: "toolResult", toolCallId: "c1", toolName: "shell", content: "boom", isError: false, timestamp: 3 };
		const b: PiMessage = { ...a, isError: true };
		expect(blockId(a, 0)).toBe(blockId(b, 0)); // same durable id
		expect(contentFingerprint(a)).not.toBe(contentFingerprint(b));
	});

	it("distinguishes cross-part text shuffles (tag bytes prevent 'ab' == 'a'+'b')", () => {
		const one: PiMessage = { role: "assistant", responseId: "r1", timestamp: 2, content: [{ type: "text", text: "ab" }] as any };
		const two: PiMessage = {
			role: "assistant", responseId: "r1", timestamp: 2,
			content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "b" }] as any,
		};
		expect(contentFingerprint(one)).not.toBe(contentFingerprint(two));
	});
});

describe("core/wire — applyPlan", () => {
	it("folds a tool_result in place (kind-safe substitution)", () => {
		const ms = session();
		const out = applyPlan(ms, [{ id: "r:c1", digestText: "{#abc123 FOLDED} read → 1 line" }]);
		const tr = out[2];
		expect(tr.role).toBe("toolResult");
		expect((tr.content as any)[0].text).toBe("{#abc123 FOLDED} read → 1 line");
		expect(tr.toolCallId).toBe("c1"); // pairing preserved
	});
	it("never folds a tool_call, even if named", () => {
		const ms = session();
		const applied = { ops: 0, groups: 0 };
		applyPlan(ms, [{ id: "a:r1:p2", digestText: "nope" }], [], applied);
		expect(applied.ops).toBe(0);
	});
});
