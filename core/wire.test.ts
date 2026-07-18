import { describe, it, expect } from "vitest";
import { linearize, applyPlan, blockId, isDurableId, messageInfo, contentFingerprint, wireToBlock, type PiMessage } from "./wire";
import type { GroupOp } from "./protocol";

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
		const out = applyPlan(ms, [{ id: "a:r1:p2", digestText: "nope" }]);
		const call = (out[1].content as any[]).find((p: any) => p.type === "toolCall");
		expect(call.id).toBe("c1"); // untouched — never substituted
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// applyPlan — role-validity floor (P3, review-confirmed; ADR 0006's open watch item).
//
// A DROP GroupOp (summaryText: null) removes its whole run and pushes NOTHING onto the wire.
// If that hole sits at the very front of the surviving wire, or between two survivors of the
// SAME role, the result is a provider-invalid message array: a non-"user" leading message, or
// two adjacent same-role messages some providers reject/mis-merge. The floor degrades ONLY the
// offending run to a one-message `{#code FOLDED}` recap (same shape a REPLACE run already
// produces) instead of removing it outright — every OTHER drop in the same call, and every drop
// that isn't actually unsafe, still removes verbatim (see the "no-repair-needed" case below).
// ─────────────────────────────────────────────────────────────────────────────

describe("core/wire — applyPlan role-validity floor", () => {
	/** Build a drop GroupOp (summaryText: null). */
	const drop = (memberIds: string[]): GroupOp => ({ id: "g:" + memberIds[0], memberIds, summaryText: null });

	it("leading-drop: dropping the run at the front would leave a non-\"user\" leading message — degraded to a recap", () => {
		const ms: PiMessage[] = [
			{ role: "user", content: "hi", timestamp: 1 }, // m0 u:1 — inside the dropped run
			{ role: "assistant", responseId: "r1", timestamp: 2, content: [{ type: "text", text: "first reply" }] as any }, // m1 a:r1:p0 — inside the dropped run
			{ role: "assistant", responseId: "r2", timestamp: 3, content: [{ type: "text", text: "second reply, no user in between" }] as any }, // m2 — NOT in the group
		];
		const out = applyPlan(ms, [], [drop(["u:1", "a:r1:p0"])]);
		// Without the floor this would collapse to just m2 (role "assistant") — an invalid
		// leading message. The floor must keep the wire starting with "user".
		expect(out[0].role).toBe("user");
		expect(out.length).toBe(2); // [recap, m2] — the run degrades to ONE synthetic message
		const recapText = (out[0].content as any[])[0].text as string;
		expect(recapText).toMatch(/^\{#[0-9a-z]{6} FOLDED\}/); // carries the recovery tag
		expect(recapText).not.toContain("hi");
		expect(recapText).not.toContain("first reply"); // the original content never rides the wire
		expect((out[1].content as any[])[0].text).toBe("second reply, no user in between"); // m2 untouched
	});

	it('interior same-role adjacency: dropping the run would leave "user" directly followed by "user" — degraded to a recap', () => {
		const ms: PiMessage[] = [
			{ role: "user", content: "turn1", timestamp: 1 }, // m0 u:1 — stays live (not a member)
			{ role: "assistant", responseId: "r1", timestamp: 2, content: [{ type: "text", text: "reply1" }] as any }, // m1 a:r1:p0 — the whole dropped run
			{ role: "user", content: "turn2", timestamp: 3 }, // m2 u:3 — stays live (not a member)
		];
		const out = applyPlan(ms, [], [drop(["a:r1:p0"])]);
		// Without the floor: [u:1, u:3] — two adjacent "user" messages. The floor must insert
		// something non-"user" between them instead of letting them weld together.
		expect(out.length).toBe(3);
		expect(out[0].role).toBe("user");
		expect(out[2].role).toBe("user");
		expect(out[1].role).not.toBe("user"); // the recap breaks the adjacency
		const recapText = (out[1].content as any[])[0].text as string;
		expect(recapText).toMatch(/^\{#[0-9a-z]{6} FOLDED\}/);
		expect(recapText).not.toContain("reply1");
	});

	it("cascade: two adjacent drop groups degrade only the FIRST run; the second resolves against the recap's role", () => {
		// Review-caught P1: after degrading a run, the pass must advance prevRole to the recap's
		// role. With the stale pre-degrade role, G2 below was ALSO degraded, and its toolResult
		// recap (role "user") welded against the surviving user turn — the exact same-role
		// adjacency the floor exists to prevent ([user, assistant, user, user] on the wire).
		const ms: PiMessage[] = [
			{ role: "user", content: "q1", timestamp: 1 }, // m0 u:1 — survives
			{ role: "assistant", responseId: "r1", timestamp: 2, content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } }] as any }, // m1 a:r1:p0 — G1's run
			{ role: "toolResult", toolCallId: "c1", toolName: "read", content: "file contents", timestamp: 3 }, // m2 r:c1 — G2's run
			{ role: "user", content: "q2", timestamp: 4 }, // m3 u:4 — survives
		];
		const out = applyPlan(ms, [], [drop(["a:r1:p0"]), drop(["r:c1"])]);
		// G1 must degrade (a full drop of both runs would weld u:1 against u:4); G2 must then
		// resolve against the ASSISTANT recap and drop verbatim.
		expect(out.length).toBe(3);
		expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		const recapText = (out[1].content as any[])[0].text as string;
		expect(recapText).toMatch(/^\{#[0-9a-z]{6} FOLDED\}/);
		expect(JSON.stringify(out)).not.toContain("file contents"); // G2's run truly dropped, no second recap
	});

	it("no-repair-needed: a drop whose surrounding roles are already safe still removes the run verbatim", () => {
		const ms: PiMessage[] = [
			{ role: "user", content: "hi", timestamp: 1 }, // m0 u:1 — dropped
			{ role: "assistant", responseId: "r1", timestamp: 2, content: [{ type: "text", text: "reply" }] as any }, // m1 a:r1:p0 — dropped
			{ role: "user", content: "next question", timestamp: 3 }, // m2 u:3 — survives; ALSO "user" at the front, so leading is already safe
		];
		const out = applyPlan(ms, [], [drop(["u:1", "a:r1:p0"])]);
		// The surviving leading message (m2) is already "user" — no adjacency/leading problem,
		// so the run must drop verbatim: no synthetic recap message inserted anywhere.
		expect(out.length).toBe(1);
		expect(out[0].role).toBe("user");
		expect((out[0].content as string)).toBe("next question");
		const flat = JSON.stringify(out);
		expect(flat).not.toContain("FOLDED");
	});
});
