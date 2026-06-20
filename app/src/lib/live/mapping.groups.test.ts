import { describe, it, expect } from "vitest";
import { applyPlan, type PiMessage } from "./mapping";
import type { GroupOp, FoldOp } from "./protocol";

// ─────────────────────────────────────────────────────────────────────────────
// applyPlan GROUP COLLAPSE (ADR 0006) — the provider-safety heart.
//
// A group removes a contiguous run of WHOLE messages and inserts ONE synthetic
// summary message. These tests lock the invariants that keep the model array valid:
// balanced tool pairs, durability, purity — and that the output never orphans a
// tool call/result no matter what range is requested. The wire trusts the engine's
// plan (the engine is the single gate that prevents folding protected blocks).
// ─────────────────────────────────────────────────────────────────────────────

// 8 messages; m6,m7 are the newest (the engine's token-based protected tail would cover them).
function msgs(): PiMessage[] {
	return [
		{ role: "user", content: "fix the bug", timestamp: 1000 }, // m0  u:1000
		{
			role: "assistant",
			responseId: "resp_a",
			timestamp: 1001,
			content: [
				{ type: "thinking", thinking: "let me look at the file" },
				{ type: "text", text: "reading the file now" },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
			],
		}, // m1  a:resp_a:p0..p2
		{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: "the file body here" }, // m2  r:call_1
		{ role: "user", content: "now refactor it", timestamp: 2000 }, // m3  u:2000
		{
			role: "assistant",
			responseId: "resp_b",
			timestamp: 2001,
			content: [
				{ type: "text", text: "editing" },
				{ type: "toolCall", id: "call_2", name: "edit", arguments: {} },
			],
		}, // m4  a:resp_b:p0,p1
		{ role: "toolResult", toolCallId: "call_2", toolName: "edit", content: "done editing" }, // m5  r:call_2
		{ role: "user", content: "thanks", timestamp: 3000 }, // m6  u:3000  (protected)
		{ role: "assistant", responseId: "resp_c", timestamp: 3001, content: [{ type: "text", text: "all set" }] }, // m7 (protected)
	];
}

/** Every tool_call in the array has its tool_result and vice-versa (no orphan → no provider 400). */
function toolBalance(arr: PiMessage[]): { calls: string[]; results: string[]; balanced: boolean } {
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const m of arr) {
		if (m.role === "assistant" && Array.isArray(m.content)) for (const p of m.content as any[]) if (p?.type === "toolCall") calls.add(p.id);
		if (m.role === "toolResult" && m.toolCallId) results.add(m.toolCallId);
	}
	const balanced = calls.size === results.size && [...calls].every((c) => results.has(c));
	return { calls: [...calls], results: [...results], balanced };
}
const G = (memberIds: string[], summaryText = "{#abc123 FOLDED} group recap"): GroupOp => ({ id: "g:" + memberIds[0], memberIds, summaryText });
const summaryText = (m: PiMessage): string | null => (m.role && Array.isArray(m.content) && (m.content as any[])[0]?.type === "text" ? (m.content as any[])[0].text : null);
const hasText = (arr: PiMessage[], text: string) => arr.some((m) => (typeof m.content === "string" ? m.content === text : Array.isArray(m.content) && (m.content as any[]).some((p) => p?.text === text)));

describe("applyPlan — group collapse", () => {
	it("collapses a balanced run (assistant + its tool result) into ONE summary message", () => {
		const out = applyPlan(msgs(), [], [G(["a:resp_a:p0", "a:resp_a:p1", "a:resp_a:p2", "r:call_1"], "{#g1 FOLDED} group · read")]);
		expect(out.length).toBe(7); // 2 messages removed, 1 inserted
		expect(summaryText(out[1])).toBe("{#g1 FOLDED} group · read"); // the one entry, at the range's start
		expect(out[1].role).toBe("assistant"); // role = first removed message's role
		expect(toolBalance(out).balanced).toBe(true); // call_1 removed with its result → still balanced
		expect(toolBalance(out).calls).toEqual(["call_2"]); // call_1 gone entirely
		expect(hasText(out, "the file body here")).toBe(false); // original content removed from the model
	});

	it("collapses a whole turn INCLUDING the user message (summarize everything)", () => {
		const out = applyPlan(msgs(), [], [G(["u:1000", "a:resp_a:p0", "a:resp_a:p1", "a:resp_a:p2", "r:call_1"], "{#g2 FOLDED} fixed the bug")]);
		expect(out.length).toBe(6); // m0,m1,m2 → one entry
		expect(hasText(out, "fix the bug")).toBe(false); // the user instruction is collapsed away…
		expect(summaryText(out[0])).toBe("{#g2 FOLDED} fixed the bug"); // …into the summary (role user → first slot)
		expect(out[0].role).toBe("user");
		expect(toolBalance(out).balanced).toBe(true);
	});

	it("keeps a split tool-pair half LIVE (straggler) and collapses the rest", () => {
		// group = [r:call_1, u:2000]; call_1's CALL (in m1) is OUTSIDE the group → m2 stays live.
		const out = applyPlan(msgs(), [], [G(["r:call_1", "u:2000"], "{#g3 FOLDED} refactor ask")]);
		expect(hasText(out, "the file body here")).toBe(true); // straggler tool_result kept verbatim
		expect(hasText(out, "now refactor it")).toBe(false); // the user message collapsed
		expect(out.some((m) => summaryText(m) === "{#g3 FOLDED} refactor ask")).toBe(true);
		expect(toolBalance(out).balanced).toBe(true); // call_1 + its result both still present
	});

	it("collapses the newest messages when the plan names them (wire trusts the engine)", () => {
		// The wire no longer has a position-based backstop. When the plan names m6,m7 (the
		// newest messages) via durable ids, the group collapses them — just as it would any
		// earlier messages. The engine is the single gate that prevents folding protected blocks;
		// applyPlan trusts that the plan is already safe (as computeGroupOps ensures).
		const src = msgs();
		const out = applyPlan(src, [], [G(["u:3000", "a:resp_c:p0"], "{#g4 FOLDED} newest folded")]);
		// m6+m7 collapsed into one summary entry; 8 → 7 messages
		expect(out.length).toBe(7);
		expect(out.some((m) => (m.content as any)?.[0]?.text === "{#g4 FOLDED} newest folded")).toBe(true);
		// Tool pairs from earlier turns remain balanced
		expect(toolBalance(out).balanced).toBe(true);
	});

	it("never removes a message with a non-durable (positional) id", () => {
		// m1 has no anchor → its parts are positional (m1:p*), unstable across shifts → never removed.
		const src = msgs();
		src[1] = { role: "assistant", content: (src[1].content as any[]).slice() }; // strip responseId/timestamp
		const out = applyPlan(src, [], [G(["m1:p0", "m1:p1", "m1:p2"], "{#g5 FOLDED} nope")]);
		expect(out).toBe(src); // nothing durably removable → identity
	});

	it("is pure — never mutates the caller's messages", () => {
		const src = msgs();
		const before = JSON.parse(JSON.stringify(src));
		applyPlan(src, [], [G(["a:resp_a:p0", "a:resp_a:p1", "a:resp_a:p2", "r:call_1"])]);
		expect(src).toEqual(before);
	});

	it("applies FoldOps and GroupOps together without conflict", () => {
		const fold: FoldOp = { id: "a:resp_a:p1", digestText: "{#x FOLDED} reading…" };
		const out = applyPlan(msgs(), [fold], [G(["a:resp_b:p0", "a:resp_b:p1", "r:call_2"], "{#g6 FOLDED} edited")]);
		// group m4+m5 collapsed → one entry; m1's text folded in place; both tool pairs stay balanced.
		expect(out.length).toBe(7);
		expect(out.some((m) => summaryText(m) === "{#g6 FOLDED} edited")).toBe(true);
		const m1text = (out[1].content as any[]).find((p: any) => p.type === "text");
		expect(m1text.text).toBe("{#x FOLDED} reading…");
		expect(toolBalance(out).balanced).toBe(true);
	});

	it("empty/unsafe group ⇒ identity passthrough", () => {
		const src = msgs();
		expect(applyPlan(src, [], [])).toBe(src);
		expect(applyPlan(src, [], [{ id: "g:x", memberIds: [], summaryText: "x" }])).toBe(src); // no members
		expect(applyPlan(src, [], [{ id: "g:x", memberIds: ["u:1000"], summaryText: "" }])).toBe(src); // no summary
	});

	it("guards summaryText type/whitespace — a blank or non-string summary never reaches the model", () => {
		// The shared safety boundary can't trust the peer's field types: a whitespace-only,
		// numeric, or object summaryText would emit a provider-invalid text part. All ⇒ passthrough.
		const src = msgs();
		expect(applyPlan(src, [], [{ id: "g:x", memberIds: ["u:1000"], summaryText: "   " }])).toBe(src);
		expect(applyPlan(src, [], [{ id: "g:x", memberIds: ["u:1000"], summaryText: 42 as unknown as string }])).toBe(src);
		expect(applyPlan(src, [], [{ id: "g:x", memberIds: ["u:1000"], summaryText: {} as unknown as string }])).toBe(src);
	});

	it("never throws on malformed peer input — null/typed-wrong ops or member ids ⇒ passthrough", () => {
		// applyPlan is the shared safety boundary on the model-call path: a null op or a
		// non-string id must be DROPPED, not throw inside the context hook (e.g. isDurableId(null)).
		const src = msgs();
		expect(applyPlan(src, [null as unknown as FoldOp, 42 as unknown as FoldOp, { id: 7 as unknown as string, digestText: "x" }], [])).toBe(src);
		expect(applyPlan(src, [], [{ id: "g:x", memberIds: [null as unknown as string, 5 as unknown as string], summaryText: "{#g FOLDED} x" }])).toBe(src);
	});

	it("first-collapsed and all-non-protected-collapsed stay balanced, non-empty, valid-role", () => {
		const validRole = (r: string) => r === "user" || r === "assistant" || r === "toolResult";
		const nonEmpty = (m: PiMessage) => (typeof m.content === "string" ? m.content.length > 0 : Array.isArray(m.content) && m.content.length > 0);
		// The very FIRST message (m0, a user turn) is inside the collapsed run.
		let out = applyPlan(msgs(), [], [G(["u:1000", "a:resp_a:p0", "a:resp_a:p1", "a:resp_a:p2", "r:call_1"], "{#a FOLDED} a")]);
		expect(out.every((m) => validRole(m.role))).toBe(true);
		expect(out.every(nonEmpty)).toBe(true);
		expect(toolBalance(out).balanced).toBe(true);
		// EVERY message in the group (m0..m5) collapses into one entry; m6,m7 pass through (not in group).
		out = applyPlan(
			msgs(),
			[],
			[G(["u:1000", "a:resp_a:p0", "a:resp_a:p1", "a:resp_a:p2", "r:call_1", "u:2000", "a:resp_b:p0", "a:resp_b:p1", "r:call_2"], "{#all FOLDED} everything")],
		);
		expect(out.every((m) => validRole(m.role))).toBe(true);
		expect(out.every(nonEmpty)).toBe(true);
		expect(toolBalance(out).balanced).toBe(true);
		expect(hasText(out, "thanks")).toBe(true); // m6 not a group member → untouched
		// NOTE: role rhythm (same-role adjacency, e.g. summary-user next to non-member m6) is
		// structurally valid here but its provider acceptance is ADR 0006 watch item #1 (verify live).
	});

	it("balanced-in ⇒ balanced-out, no emptied message, for EVERY contiguous range (provider-safety property)", () => {
		// Brute-force every contiguous message range over m0..m5 (m6,m7 are outside this range).
		// The output must NEVER orphan a tool pair or emit an empty message, whatever is grouped.
		const idsByMsg = [
			["u:1000"], // m0
			["a:resp_a:p0", "a:resp_a:p1", "a:resp_a:p2"], // m1 (carries call_1)
			["r:call_1"], // m2
			["u:2000"], // m3
			["a:resp_b:p0", "a:resp_b:p1"], // m4 (carries call_2)
			["r:call_2"], // m5
		]; // m6,m7 are outside this brute-force range; the engine would protect them, not applyPlan
		for (let lo = 0; lo < idsByMsg.length; lo++) {
			for (let hi = lo; hi < idsByMsg.length; hi++) {
				const memberIds = idsByMsg.slice(lo, hi + 1).flat();
				const out = applyPlan(msgs(), [], [G(memberIds, "{#p FOLDED} recap")]);
				expect(toolBalance(out).balanced, `range ${lo}..${hi} orphaned a tool pair`).toBe(true);
				for (const m of out) {
					const nonEmpty = typeof m.content === "string" ? m.content.length > 0 : Array.isArray(m.content) && m.content.length > 0;
					expect(nonEmpty, `range ${lo}..${hi} produced an empty message`).toBe(true);
				}
			}
		}
	});

	it("two adjacent groups each collapse to their own entry (no cross-merge)", () => {
		const out = applyPlan(
			msgs(),
			[],
			[
				G(["u:1000"], "{#A FOLDED} A"), // m0 alone — a 1-message run
				G(["a:resp_a:p0", "a:resp_a:p1", "a:resp_a:p2", "r:call_1"], "{#B FOLDED} B"), // m1+m2
			],
		);
		// distinct summaries, in order, not merged into one
		expect(summaryText(out[0])).toBe("{#A FOLDED} A");
		expect(summaryText(out[1])).toBe("{#B FOLDED} B");
		expect(toolBalance(out).balanced).toBe(true);
	});
});
