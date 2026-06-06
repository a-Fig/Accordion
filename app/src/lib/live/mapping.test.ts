import { describe, it, expect } from "vitest";
import { linearize, applyPlan, blockId, type PiMessage } from "./mapping";
import type { FoldOp } from "./protocol";

// A small but representative pi context: a user turn, an assistant turn that
// thinks + replies + calls a tool, and the tool's result.
// Messages carry stable timestamps/responseId so ids are durable.
function sample(): PiMessage[] {
	return [
		{ role: "user", content: "fix the bug", timestamp: 1000 },
		{
			role: "assistant",
			model: "kimi",
			responseId: "resp_abc",
			timestamp: 1001,
			content: [
				{ type: "thinking", thinking: "let me look at the file and reason about it" },
				{ type: "text", text: "I'll read the file." },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
			],
		},
		{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: "line1\nline2\nline3", isError: false },
	];
}

describe("linearize", () => {
	it("splits an assistant message into its parts and ids are durable (content-anchored)", () => {
		const blocks = linearize(sample());
		expect(blocks.map((b) => [b.id, b.kind])).toEqual([
			["u:1000", "user"],
			["a:resp_abc:p0", "thinking"],
			["a:resp_abc:p1", "text"],
			["a:resp_abc:p2", "tool_call"],
			["r:call_1", "tool_result"],
		]);
	});

	it("links a tool_call to its result by callId", () => {
		const blocks = linearize(sample());
		const call = blocks.find((b) => b.kind === "tool_call")!;
		const result = blocks.find((b) => b.kind === "tool_result")!;
		expect(call.callId).toBe("call_1");
		expect(result.callId).toBe("call_1");
	});

	it("increments turn on user messages and assigns dense order", () => {
		const blocks = linearize(sample());
		expect(blocks.every((b) => b.turn === 1)).toBe(true);
		expect(blocks.map((b) => b.order)).toEqual([0, 1, 2, 3, 4]);
	});

	it("drops empty non-result parts but keeps empty tool results", () => {
		const msgs: PiMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "" }] },
			{ role: "toolResult", toolCallId: "c", toolName: "t", content: "" },
		];
		const blocks = linearize(msgs);
		expect(blocks.map((b) => b.kind)).toEqual(["tool_result"]);
	});

	it("falls back to positional ids when anchor fields are missing", () => {
		const msgs: PiMessage[] = [
			{ role: "user", content: "no timestamp" },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			{ role: "toolResult", toolCallId: undefined, toolName: "t", content: "res" },
		];
		const blocks = linearize(msgs);
		expect(blocks[0].id).toBe("m0:u");
		expect(blocks[1].id).toBe("m1:p0");
		expect(blocks[2].id).toBe("m2:r");
	});

	it("uses timestamp-based fallback for assistant when no responseId", () => {
		const msgs: PiMessage[] = [
			{ role: "assistant", timestamp: 9999, content: [{ type: "text", text: "hello" }] },
		];
		const blocks = linearize(msgs);
		expect(blocks[0].id).toBe("a:t9999:p0");
	});
});

describe("blockId — position-independence (the durable id invariant)", () => {
	it("A and B keep identical ids when a new message X is prepended", () => {
		const A: PiMessage = {
			role: "user",
			content: "message A",
			timestamp: 2000,
		};
		const B: PiMessage = {
			role: "assistant",
			content: [{ type: "text", text: "reply B" }],
			responseId: "resp_B",
			timestamp: 2001,
		};
		const X: PiMessage = {
			role: "user",
			content: "prepended message X",
			timestamp: 1500,
		};

		// linearize [A, B] then [X, A, B] — A is at index 0 then 1; B is at 1 then 2
		const blocksAB = linearize([A, B]);
		const blocksXAB = linearize([X, A, B]);

		// A's id from [A, B] (index 0) must equal A's id from [X, A, B] (index 1)
		const aIdFrom2 = blocksAB.find((b) => b.id.startsWith("u:"))!.id;
		const aIdFrom3 = blocksXAB.filter((b) => b.id.startsWith("u:")).find((b) => b.id === "u:2000")!.id;
		expect(aIdFrom2).toBe("u:2000");
		expect(aIdFrom3).toBe("u:2000");
		expect(aIdFrom2).toBe(aIdFrom3);

		// B's assistant part ids must be identical across both linearizations
		const bPartsFrom2 = blocksAB.filter((b) => b.id.startsWith("a:resp_B:"));
		const bPartsFrom3 = blocksXAB.filter((b) => b.id.startsWith("a:resp_B:"));
		expect(bPartsFrom2.length).toBe(1);
		expect(bPartsFrom3.length).toBe(1);
		expect(bPartsFrom2[0].id).toBe(bPartsFrom3[0].id);
		expect(bPartsFrom2[0].id).toBe("a:resp_B:p0");
	});

	it("applyPlan resolves a durable id to the correct part after a position shift", () => {
		// The real durable property: a fold op keyed by B's durable id must fold B
		// no matter what index B sits at — and must never touch other messages.
		const A: PiMessage = { role: "user", content: "message A", timestamp: 2000 };
		const B: PiMessage = {
			role: "assistant",
			content: [{ type: "text", text: "reply B" }],
			responseId: "resp_B",
			timestamp: 2001,
		};
		const X: PiMessage = { role: "user", content: "prepended X", timestamp: 1500 };
		// Padding keeps B out of the PROTECT_RECENT_MSGS=2 tail so it stays foldable.
		const P: PiMessage = { role: "user", content: "pad P", timestamp: 3000 };
		const Q: PiMessage = { role: "user", content: "pad Q", timestamp: 3001 };

		const op = { id: "a:resp_B:p0", digestText: "FOLDED_B" };
		const bText = (m: PiMessage) => ((m.content as { text: string }[])[0]).text;

		// B at index 1
		const out1 = applyPlan([A, B, P, Q], [op]);
		expect(bText(out1[1])).toBe("FOLDED_B"); // B folded
		expect(out1[0].content).toBe("message A"); // A untouched

		// B shifted to index 2 — same op, same durable id, must still fold B (not X/A)
		const out2 = applyPlan([X, A, B, P, Q], [op]);
		expect(bText(out2[2])).toBe("FOLDED_B"); // B folded at its new index
		expect(out2[0].content).toBe("prepended X"); // X untouched
		expect(out2[1].content).toBe("message A"); // A untouched
	});
});

describe("applyPlan", () => {
	it("empty plan returns the same array (identity)", () => {
		const msgs = sample();
		const out = applyPlan(msgs, []);
		expect(out).toBe(msgs);
	});

	it("is pure — never mutates the caller's messages", () => {
		const msgs: PiMessage[] = [
			...sample(),
			{ role: "user", content: "next", timestamp: 2000 },
			{ role: "assistant", content: [{ type: "text", text: "ok" }], responseId: "resp_x", timestamp: 2001 },
		];
		const before = JSON.parse(JSON.stringify(msgs));
		const out = applyPlan(msgs, [{ id: "a:resp_abc:p1", digestText: "text digest" }]);
		expect(msgs).toEqual(before); // input untouched
		expect(out).not.toBe(msgs); // a new array
		expect((out[1].content as any[])[1].text).toBe("text digest"); // fold is in the output
	});

	it("folds a tool_result's content but keeps its pairing fields", () => {
		// add filler messages so the result is outside the recent-message backstop
		const msgs: PiMessage[] = [
			...sample(),
			{ role: "user", content: "next", timestamp: 2000 },
			{ role: "assistant", content: [{ type: "text", text: "ok" }], responseId: "resp_x", timestamp: 2001 },
		];
		const out = applyPlan(msgs, [{ id: "r:call_1", digestText: "read → 3 lines" }]);
		const tr = out[2];
		expect(tr.content).toEqual([{ type: "text", text: "read → 3 lines" }]);
		expect(tr.toolCallId).toBe("call_1"); // pairing preserved
		expect(tr.toolName).toBe("read");
	});

	it("replaces thinking/text and never folds a tool_call", () => {
		const msgs: PiMessage[] = [
			...sample(),
			{ role: "user", content: "next", timestamp: 2000 },
			{ role: "assistant", content: [{ type: "text", text: "ok" }], responseId: "resp_x", timestamp: 2001 },
		];
		const ops: FoldOp[] = [
			{ id: "a:resp_abc:p0", digestText: "thought digest" },
			{ id: "a:resp_abc:p1", digestText: "text digest" },
			{ id: "a:resp_abc:p2", digestText: "SHOULD BE IGNORED" }, // tool_call — must not change
		];
		const out = applyPlan(msgs, ops);
		const parts = out[1].content as any[];
		expect(parts[0].thinking).toBe("thought digest");
		expect(parts[1].text).toBe("text digest");
		expect(parts[2]).toEqual({ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } });
	});

	it("ignores an op whose id maps to a wrong-kind or missing part", () => {
		const msgs: PiMessage[] = [
			...sample(),
			{ role: "user", content: "next", timestamp: 2000 },
			{ role: "assistant", content: [{ type: "text", text: "ok" }], responseId: "resp_x", timestamp: 2001 },
		];
		// a:resp_abc:p2 is a tool_call (wrong kind for a content fold); a:resp_abc:p9 does not exist
		const out = applyPlan(msgs, [
			{ id: "a:resp_abc:p2", digestText: "nope" },
			{ id: "a:resp_abc:p9", digestText: "nope" },
		]);
		expect(out).toBe(msgs); // nothing applied → original array returned
	});

	it("backstop: refuses to fold the most-recent messages", () => {
		// here the tool_result is within the last PROTECT_RECENT_MSGS, so the op is ignored
		const msgs = sample();
		const out = applyPlan(msgs, [{ id: "r:call_1", digestText: "folded!" }]);
		expect(out).toBe(msgs); // no change → identity
		expect(msgs[2].content).toBe("line1\nline2\nline3"); // untouched
	});

	it("folds correctly using durable ids — same as positional for a stable message array", () => {
		// Simulate a more complex session to exercise the durable path end-to-end
		const sessionMsgs: PiMessage[] = [
			{ role: "user", content: "hello", timestamp: 100 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "some deep thought" },
					{ type: "text", text: "I did the thing" },
				],
				responseId: "resp_1",
				timestamp: 101,
			},
			{ role: "toolResult", toolCallId: "call_99", toolName: "bash", content: "output here", isError: false },
			{ role: "user", content: "continue", timestamp: 200 },
			{ role: "assistant", content: [{ type: "text", text: "newest reply" }], responseId: "resp_2", timestamp: 201 },
		];

		// Fold the thinking and text parts of the first assistant turn.
		// The tool_result and the newest messages (protected) should be untouched.
		const ops: FoldOp[] = [
			{ id: "a:resp_1:p0", digestText: "compressed thought" },
			{ id: "a:resp_1:p1", digestText: "compressed text" },
			{ id: "r:call_99", digestText: "compressed result" }, // outside backstop — should fold
		];
		const out = applyPlan(sessionMsgs, ops);

		const assistantParts = out[1].content as any[];
		expect(assistantParts[0].thinking).toBe("compressed thought");
		expect(assistantParts[1].text).toBe("compressed text");

		expect(out[2].content).toEqual([{ type: "text", text: "compressed result" }]);

		// Protected tail: the last 2 messages are never folded
		expect((out[3].content as string)).toBe("continue");
		expect((out[4].content as any[])[0].text).toBe("newest reply");
	});
});
