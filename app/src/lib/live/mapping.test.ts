import { describe, it, expect } from "vitest";
import { linearize, applyPlan, blockId, isDurableId, type PiMessage } from "./mapping";
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
		// Padding ensures we exercise the durable-id path with non-trivial array positions.
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

	it("replaces thinking/text in-place and never folds a tool_call regardless of position", () => {
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

	it("engine-trusting: folds the newest message when the plan names it (no wire-side position backstop)", () => {
		// The wire now trusts the engine's plan. When a durable fold op targets a block in
		// the newest message, applyPlan applies it. Previously the position-based backstop
		// would have suppressed this, creating a view↔wire divergence.
		const msgs = sample(); // 3 messages; tool_result is the last one
		const out = applyPlan(msgs, [{ id: "r:call_1", digestText: "folded!" }]);
		expect(out).not.toBe(msgs); // change applied → new array
		expect(out[2].content).toEqual([{ type: "text", text: "folded!" }]); // newest message folded
		// tool pair fields preserved
		expect((out[2] as any).toolCallId).toBe("call_1");
		expect((out[2] as any).toolName).toBe("read");
	});

	it("folds correctly using durable ids — all targeted blocks fold including the NEWEST message", () => {
		// Exercise the durable path end-to-end AND prove the wire folds a RECENT block: the newest
		// assistant message (index 4 of 5 — inside the old PROTECT_RECENT_MSGS=2 backstop region,
		// protectFrom would have been 3) is targeted and must now fold, because the wire trusts the
		// engine's plan regardless of position. This is the test's teeth: re-adding the position
		// backstop keeps out[4] whole and fails the newest-message assertion below.
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

		// Fold the first assistant turn, the tool result, AND the newest assistant message.
		const ops: FoldOp[] = [
			{ id: "a:resp_1:p0", digestText: "compressed thought" },
			{ id: "a:resp_1:p1", digestText: "compressed text" },
			{ id: "r:call_99", digestText: "compressed result" },
			{ id: "a:resp_2:p0", digestText: "compressed newest" }, // index 4 — the old backstop suppressed this
		];
		const out = applyPlan(sessionMsgs, ops);

		const assistantParts = out[1].content as any[];
		expect(assistantParts[0].thinking).toBe("compressed thought");
		expect(assistantParts[1].text).toBe("compressed text");
		expect(out[2].content).toEqual([{ type: "text", text: "compressed result" }]);
		// The NEWEST message folds too — the teeth: a position backstop would keep it whole.
		expect((out[4].content as any[])[0].text).toBe("compressed newest");
		// The untargeted user message passes through (user kind is never folded anyway).
		expect((out[3].content as string)).toBe("continue");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 0 (ADR 0003) — the ANCHOR-LESS / POSITIONAL path, end to end.
//
// The durable-id tests above prove anchored ids are stable. These prove the
// CONVERSE: a message with no anchor falls back to a positional id (`m<i>:…`),
// that id is UNSTABLE across array shifts, and `applyPlan`'s durable-id filter
// refuses to act on it. This is the property that makes live folding safe even
// when pi hands us a message without timestamp/responseId/toolCallId.
// ─────────────────────────────────────────────────────────────────────────────
describe("positional ids — instability + the applyPlan durable-id guard", () => {
	it("a positional id is position-dependent (unstable), an anchored id is not", () => {
		// The SAME logical assistant message, with NO anchor fields. Its id is
		// derived purely from its array index, so it MUST change when the index does.
		const anchorless: PiMessage = { role: "assistant", content: [{ type: "text", text: "x" }] };

		// Position 0 in a 1-message array → m0:p0.
		const atIndex0 = linearize([anchorless]);
		// Same logical message now at index 2 (two earlier messages push it down).
		const atIndex2 = linearize([
			{ role: "user", content: "earlier 1", timestamp: 1 },
			{ role: "user", content: "earlier 2", timestamp: 2 },
			anchorless,
		]);

		const id0 = atIndex0[0].id;
		const id2 = atIndex2.find((b) => b.kind === "text")!.id;

		// WHY this matters: the positional id literally encoded the wrong location at
		// the new index — proof that a fold op keyed by it could point at a different
		// block after the array shifts. They must differ.
		expect(id0).toBe("m0:p0");
		expect(id2).toBe("m2:p0");
		expect(id0).not.toBe(id2);

		// And BOTH are non-durable, so the guard will refuse a fold op for either.
		expect(isDurableId(id0)).toBe(false);
		expect(isDurableId(id2)).toBe(false);

		// CONTRAST: give the same message a durable anchor (responseId) and its id is
		// identical at index 0 and index 2 — the stability the positional path lacks.
		const anchored: PiMessage = {
			role: "assistant",
			responseId: "resp_stable",
			content: [{ type: "text", text: "x" }],
		};
		const anchoredAt0 = linearize([anchored])[0].id;
		const anchoredAt2 = linearize([
			{ role: "user", content: "earlier 1", timestamp: 1 },
			{ role: "user", content: "earlier 2", timestamp: 2 },
			anchored,
		]).find((b) => b.kind === "text")!.id;
		expect(anchoredAt0).toBe("a:resp_stable:p0");
		expect(anchoredAt2).toBe("a:resp_stable:p0");
		expect(anchoredAt0).toBe(anchoredAt2); // durable: index-independent
		expect(isDurableId(anchoredAt0)).toBe(true);
	});

	it("applyPlan REFUSES a positional-id op but APPLIES the same fold under the durable id", () => {
		// An anchor-less assistant message whose text part WOULD be foldable by content.
		// The durable-id guard refuses the fold regardless of position — the test message
		// sits at index 0 (the oldest possible position) and the guard still applies.
		const target: PiMessage = { role: "assistant", content: [{ type: "text", text: "ORIGINAL" }] };
		const msgs: PiMessage[] = [
			target, // index 0 → positional id m0:p0 (no responseId/timestamp)
			{ role: "user", content: "pad 1", timestamp: 10 },
			{ role: "user", content: "pad 2", timestamp: 11 },
		];

		// The positional id correctly NAMES the foldable part by position…
		expect(blockId(target, 0, 0)).toBe("m0:p0");
		// …but the guard refuses it because it is not durable. Same array back, by ref.
		const refused = applyPlan(msgs, [{ id: "m0:p0", digestText: "FOLDED" }]);
		expect(refused).toBe(msgs); // unchanged — the guard filtered the only op out
		expect((refused[0].content as any[])[0].text).toBe("ORIGINAL");

		// Now express the SAME fold via a DURABLE id by giving the message an anchor.
		// (responseId is the durable anchor; with it the id becomes a:resp_t:p0.)
		const durableTarget: PiMessage = { role: "assistant", responseId: "resp_t", content: [{ type: "text", text: "ORIGINAL" }] };
		const durableMsgs: PiMessage[] = [durableTarget, msgs[1], msgs[2]];
		expect(blockId(durableTarget, 0, 0)).toBe("a:resp_t:p0");
		const applied = applyPlan(durableMsgs, [{ id: "a:resp_t:p0", digestText: "FOLDED" }]);
		// WHY this matters: the guard DISCRIMINATES — it is not refusing all folds,
		// only non-durable ones. The durable fold goes through (content substituted).
		expect(applied).not.toBe(durableMsgs);
		expect((applied[0].content as any[])[0].text).toBe("FOLDED");
	});

	it("applyPlan refuses an empty-digest op even when the id is durable", () => {
		// Durable id, but digestText:"" would BLANK the content part — the second half
		// of the guard (isDurableId(id) && o.digestText) must filter it out.
		const msgs: PiMessage[] = [
			{ role: "assistant", responseId: "resp_e", content: [{ type: "text", text: "KEEP ME" }] },
			{ role: "user", content: "pad 1", timestamp: 10 },
			{ role: "user", content: "pad 2", timestamp: 11 },
		];
		const out = applyPlan(msgs, [{ id: "a:resp_e:p0", digestText: "" }]);
		expect(out).toBe(msgs); // unchanged — empty digest refused
		expect((out[0].content as any[])[0].text).toBe("KEEP ME");
	});

	it("applyPlan never folds a tool_call or a user message, even with a durable id", () => {
		// Both the new durable filter AND the kind checks must hold: a durable id that
		// happens to resolve to a tool_call (orphans its result → provider 400) or to a
		// user message (never folded) must leave the messages untouched.
		const msgs: PiMessage[] = [
			{ role: "user", content: "fold me?", timestamp: 100 }, // durable id u:100
			{
				role: "assistant",
				responseId: "resp_tc",
				content: [
					{ type: "text", text: "calling" },
					{ type: "toolCall", id: "call_z", name: "bash", arguments: { cmd: "ls" } }, // a:resp_tc:p1
				],
			},
			{ role: "user", content: "pad 1", timestamp: 101 },
			{ role: "user", content: "pad 2", timestamp: 102 },
		];
		const ops: FoldOp[] = [
			{ id: "u:100", digestText: "should not fold a user" }, // durable, but kind=user → ignored
			{ id: "a:resp_tc:p1", digestText: "should not fold a tool_call" }, // durable, but kind=tool_call → ignored
		];
		const out = applyPlan(msgs, ops);
		expect(out).toBe(msgs); // nothing applied → original array returned by reference
		expect(msgs[0].content).toBe("fold me?"); // user untouched
		expect((msgs[1].content as any[])[1]).toEqual({ type: "toolCall", id: "call_z", name: "bash", arguments: { cmd: "ls" } });
	});
});
