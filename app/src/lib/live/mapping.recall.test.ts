import { describe, it, expect } from "vitest";
import { applyPlan, type PiMessage } from "./mapping";
import type { GroupOp, RecallOp } from "./protocol";

// ─────────────────────────────────────────────────────────────────────────────
// applyPlan RECALL INJECTION (ADR 0018).
//
// A recall inserts ONE synthetic user message carrying a folded block's full text AFTER its
// frozen anchor message, WITHOUT unfolding the block. It is additive — it never removes or
// edits an existing message, so tool pairing stays balanced. These tests lock: correct
// insertion point, group-swallow fallback, malformed-op skip, and passthrough on empty recalls.
// ─────────────────────────────────────────────────────────────────────────────

// Same 8-message fixture shape used by mapping.groups.test.ts.
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
		{ role: "user", content: "thanks", timestamp: 3000 }, // m6  u:3000
		{ role: "assistant", responseId: "resp_c", timestamp: 3001, content: [{ type: "text", text: "all set" }] }, // m7
	];
}

/** Every tool_call has its tool_result and vice-versa (no orphan → no provider 400). */
function toolBalance(arr: PiMessage[]): boolean {
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const m of arr) {
		if (m.role === "assistant" && Array.isArray(m.content)) for (const p of m.content as any[]) if (p?.type === "toolCall") calls.add(p.id);
		if (m.role === "toolResult" && m.toolCallId) results.add(m.toolCallId);
	}
	return calls.size === results.size && [...calls].every((c) => results.has(c));
}
const textOf = (m: PiMessage): string | null =>
	typeof m.content === "string" ? m.content : Array.isArray(m.content) && (m.content as any[])[0]?.type === "text" ? (m.content as any[])[0].text : null;
const REC = "[recalled tool_result read · turn 1 (#abc123)]\nthe file body here";

describe("applyPlan — recall injection", () => {
	it("inserts exactly one user message immediately AFTER the anchor message", () => {
		const recalls: RecallOp[] = [{ id: "r:call_1", afterId: "r:call_2", text: REC }];
		const out = applyPlan(msgs(), [], [], recalls);
		// One message added (8 → 9), and it is a user-role message carrying the recall text.
		expect(out.length).toBe(9);
		const idx = out.findIndex((m) => textOf(m) === REC);
		expect(idx).toBeGreaterThan(-1);
		expect(out[idx].role).toBe("user");
		// r:call_2 is emitted by m5 (the tool result "done editing"); the injection sits right after it.
		expect(textOf(out[idx - 1])).toBe("done editing");
		expect(toolBalance(out)).toBe(true);
	});

	it("empty recalls (and empty everything) → identical output to today (passthrough)", () => {
		const src = msgs();
		expect(applyPlan(src, [], [], [])).toBe(src); // same reference — untouched
		expect(applyPlan(src, [], [])).toBe(src); // recalls arg omitted entirely
	});

	it("skips a malformed RecallOp (missing text / non-string afterId) but keeps valid ones", () => {
		const recalls = [
			{ id: "x", afterId: "r:call_2", text: "" }, // empty text → skip
			{ id: "y", afterId: 42 as any, text: "z" }, // non-string afterId → skip
			null as any, // null → skip
			{ id: "r:call_1", afterId: "r:call_2", text: REC }, // valid
		];
		const out = applyPlan(msgs(), [], [], recalls);
		expect(out.filter((m) => textOf(m) === REC).length).toBe(1); // exactly the one valid op
		expect(out.length).toBe(9);
		expect(toolBalance(out)).toBe(true);
	});

	it("group swallowing the anchor → injects after the group's summary message (fallback)", () => {
		// Group collapses m4 (a:resp_b:*) + m5 (r:call_2) — the anchor r:call_2's message is gone,
		// replaced by one summary. The recall must fall back to inserting after that summary.
		const group: GroupOp = { id: "g:a:resp_b:p0", memberIds: ["a:resp_b:p0", "a:resp_b:p1", "r:call_2"], summaryText: "{#g FOLDED} edit recap" };
		const recalls: RecallOp[] = [{ id: "r:call_1", afterId: "r:call_2", text: REC }];
		const out = applyPlan(msgs(), [], [group], recalls);
		const summaryIdx = out.findIndex((m) => textOf(m) === "{#g FOLDED} edit recap");
		const recIdx = out.findIndex((m) => textOf(m) === REC);
		expect(summaryIdx).toBeGreaterThan(-1);
		expect(recIdx).toBe(summaryIdx + 1); // recall injected right after the summary
		expect(toolBalance(out)).toBe(true); // call_2 + its result both removed together → balanced
	});

	it("dropped run swallowing the anchor → falls back to the last surviving message before the gap", () => {
		// DROP group over m4+m5 (summaryText null) removes them with no replacement. The anchor
		// r:call_2 is gone AND no summary exists, so the recall lands after the last survivor before
		// the gap — m3 (u:2000, "now refactor it").
		const drop: GroupOp = { id: "g:a:resp_b:p0", memberIds: ["a:resp_b:p0", "a:resp_b:p1", "r:call_2"], summaryText: null };
		const recalls: RecallOp[] = [{ id: "r:call_1", afterId: "r:call_2", text: REC }];
		const out = applyPlan(msgs(), [], [drop], recalls);
		const recIdx = out.findIndex((m) => textOf(m) === REC);
		expect(recIdx).toBeGreaterThan(-1);
		expect(textOf(out[recIdx - 1])).toBe("now refactor it");
		expect(toolBalance(out)).toBe(true);
	});

	it("unknown anchor id → appends at the very end (never throws, never orphans)", () => {
		const recalls: RecallOp[] = [{ id: "r:call_1", afterId: "r:does-not-exist", text: REC }];
		const out = applyPlan(msgs(), [], [], recalls);
		expect(textOf(out[out.length - 1])).toBe(REC); // appended last
		expect(out.length).toBe(9);
		expect(toolBalance(out)).toBe(true);
	});

	it("composes with a fold on the same block: the block folds AND its full text is injected", () => {
		// r:call_1 folded in place (m2 body replaced by a digest), and recalled after r:call_2.
		const out = applyPlan(
			msgs(),
			[{ id: "r:call_1", digestText: "{#abc123 FOLDED} read → 1 line" }],
			[],
			[{ id: "r:call_1", afterId: "r:call_2", text: REC }],
		);
		// The in-place fold replaced the original body…
		expect(out.some((m) => textOf(m) === "{#abc123 FOLDED} read → 1 line")).toBe(true);
		expect(out.some((m) => textOf(m) === "the file body here")).toBe(false);
		// …and the full text rides the tail via the recall injection.
		expect(out.some((m) => textOf(m) === REC)).toBe(true);
		expect(toolBalance(out)).toBe(true);
	});
});
