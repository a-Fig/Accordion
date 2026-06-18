import { describe, it, expect } from "vitest";
import { applyPlan, type PiMessage } from "./mapping";
import type { GroupOp } from "./protocol";

// ─────────────────────────────────────────────────────────────────────────────
// applyPlan — DROP GroupOp (summaryText === null): the run is removed and
// NO replacement message is inserted.
// ─────────────────────────────────────────────────────────────────────────────

function msgs(): PiMessage[] {
	return [
		{ role: "user", content: "fix the bug", timestamp: 1000 }, // m0  u:1000
		{
			role: "assistant",
			responseId: "resp_a",
			timestamp: 1001,
			content: [
				{ type: "thinking", thinking: "let me look" },
				{ type: "text", text: "reading the file" },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
			],
		}, // m1  a:resp_a:p0..p2
		{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: "file body" }, // m2  r:call_1
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
		{ role: "toolResult", toolCallId: "call_2", toolName: "edit", content: "done" }, // m5  r:call_2
		{ role: "user", content: "thanks", timestamp: 3000 }, // m6
	];
}

/** Build a drop GroupOp (summaryText: null). */
const G = (memberIds: string[]): GroupOp => ({ id: "g:" + memberIds[0], memberIds, summaryText: null });

function toolBalance(arr: PiMessage[]): { calls: Set<string>; results: Set<string>; balanced: boolean } {
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const m of arr) {
		if (m.role === "assistant" && Array.isArray(m.content))
			for (const p of m.content as any[]) if (p?.type === "toolCall") calls.add(p.id);
		if (m.role === "toolResult" && m.toolCallId) results.add(m.toolCallId);
	}
	const balanced = calls.size === results.size && [...calls].every((c) => results.has(c));
	return { calls, results, balanced };
}

describe("applyPlan — drop group (summaryText: null)", () => {
	it("removes the run entirely — no replacement message inserted; surrounding messages intact", () => {
		// Drop the balanced m1+m2 run (2 messages). Message count drops from 7 to 5.
		const out = applyPlan(msgs(), [], [G(["a:resp_a:p0", "a:resp_a:p1", "a:resp_a:p2", "r:call_1"])]);
		expect(out.length).toBe(5); // 7 - 2 = 5
		// m0 and m3..m6 are untouched
		expect(out[0]).toMatchObject({ role: "user" });
		expect((out[0].content as string)).toBe("fix the bug");
		// The run's content must not appear anywhere
		const flat = JSON.stringify(out);
		expect(flat).not.toContain("reading the file");
		expect(flat).not.toContain("file body");
		// No summary message with that text either — nothing inserted
		expect(out.some((m) => Array.isArray(m.content) && (m.content as any[]).some((p: any) => p?.text?.includes("FOLDED")))).toBe(false);
		// Surrounding messages are intact
		expect(toolBalance(out).balanced).toBe(true);
		// call_1 is gone entirely; call_2 remains
		expect(toolBalance(out).calls).toEqual(new Set(["call_2"]));
	});

	it("removes exactly the run length worth of messages", () => {
		const before = msgs().length; // 7
		const out = applyPlan(msgs(), [], [G(["u:1000", "a:resp_a:p0", "a:resp_a:p1", "a:resp_a:p2", "r:call_1"])]);
		// m0+m1+m2 = 3 messages removed
		expect(out.length).toBe(before - 3);
	});

	it("a tool_call+result pair fully inside the run — both removed, no orphan", () => {
		// Drop m1+m2: a:resp_a contains call_1 and r:call_1 is its result — both go.
		const out = applyPlan(msgs(), [], [G(["a:resp_a:p0", "a:resp_a:p1", "a:resp_a:p2", "r:call_1"])]);
		expect(toolBalance(out).balanced).toBe(true);
		expect(toolBalance(out).calls.has("call_1")).toBe(false);
		expect(toolBalance(out).results).not.toContain("call_1");
	});

	it("a pair split across the run boundary — the unbalanced half stays live (straggler), not dropped", () => {
		// Drop just the tool_result (r:call_1) whose call (in m1) is OUTSIDE the drop run.
		// m2 stays live (straggler) since removing it would orphan call_1.
		const src = msgs();
		const out = applyPlan(src, [], [G(["r:call_1"])]);
		// r:call_1 message stays because its call is outside → nothing dropped
		expect(out.length).toBe(src.length);
		expect(out).toBe(src); // identity passthrough when nothing removable (same reference)
		expect(toolBalance(out).balanced).toBe(true);
	});

	it("a 1-member drop group — that single message is removed", () => {
		// Drop the standalone user message m3 (u:2000). It has no tool pairs.
		const out = applyPlan(msgs(), [], [G(["u:2000"])]);
		expect(out.length).toBe(msgs().length - 1);
		const flat = JSON.stringify(out);
		expect(flat).not.toContain("now refactor it");
		expect(toolBalance(out).balanced).toBe(true);
	});

	it("is pure — never mutates the caller's messages", () => {
		const src = msgs();
		const before = JSON.parse(JSON.stringify(src));
		applyPlan(src, [], [G(["a:resp_a:p0", "a:resp_a:p1", "a:resp_a:p2", "r:call_1"])]);
		expect(src).toEqual(before);
	});

	it("drop group and regular group together — both apply correctly", () => {
		// Drop m1+m2; replace m4+m5 with a summary.
		const dropOp: GroupOp = G(["a:resp_a:p0", "a:resp_a:p1", "a:resp_a:p2", "r:call_1"]);
		const summaryOp: GroupOp = {
			id: "g:a:resp_b:p0",
			memberIds: ["a:resp_b:p0", "a:resp_b:p1", "r:call_2"],
			summaryText: "{#abc FOLDED} refactor done",
		};
		const out = applyPlan(msgs(), [], [dropOp, summaryOp]);
		// m0, [m1+m2 dropped], m3, [m4+m5 → one summary], m6 → 4 messages
		expect(out.length).toBe(4);
		const flat = JSON.stringify(out);
		expect(flat).not.toContain("reading the file");
		expect(flat).not.toContain("file body");
		expect(out.some((m) => Array.isArray(m.content) && (m.content as any[]).some((p: any) => p?.text === "{#abc FOLDED} refactor done"))).toBe(true);
		expect(toolBalance(out).balanced).toBe(true);
	});

	it("empty string summaryText is NOT a valid drop op — treated as invalid and skipped", () => {
		// An empty string is not null — it's a malformed non-drop op; the filter rejects it.
		const src = msgs();
		const badOp: GroupOp = { id: "g:u:1000", memberIds: ["u:1000"], summaryText: "" };
		expect(applyPlan(src, [], [badOp])).toBe(src); // passthrough (rejected by safeGroups)
	});

	it("null summaryText with non-durable member ids — nothing durably removable → identity", () => {
		const src = msgs();
		const op: GroupOp = { id: "g:m99:u", memberIds: ["m99:u"], summaryText: null };
		expect(applyPlan(src, [], [op])).toBe(src);
	});
});
