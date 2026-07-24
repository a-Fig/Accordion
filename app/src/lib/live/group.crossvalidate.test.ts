import { describe, it, expect } from "vitest";
import { applyPlan, linearize, wireToBlock, type PiMessage } from "$core/wire";
import { AccordionStore } from "../engine/store.svelte";
import type { ParsedSession } from "../engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-VALIDATION — the engine VIEW must mirror the WIRE byte-for-byte.
//
// The cardinal invariant (CLAUDE.md): the GUI's claimed savings must equal what
// the agent's context actually changes by. The engine keeps a re-implementation
// of the wire's group-collapse algorithm (classifyGroup / groupLiveTokens) and it
// had drifted in two ways (PR #66) plus a residual in live sessions (issue #13):
//   1. a SINGLE-PASS removable set (vs. the wire's message-level fixpoint cascade)
//      → wrongly collapsed a parallel-tool-call group the wire leaves whole;
//   2. ONE summary charged per group (vs. the wire's one summary PER contiguous run)
//      → undercounted live tokens when an interior straggler split the group;
//   3. (#13) durability-AGNOSTIC collapse in a LIVE session: a non-durable-id
//      interior member is collapsed-through by the view, but the wire (computeGroupOps
//      → applyPlan) strips it, keeping that message live and splitting the run around it.
//      The view over-counted savings the agent never received. Fixed by making
//      classifyGroup durability-aware when `wireAttached` is true.
//
// These tests build the SAME source as both a `PiMessage[]` (the wire's input) and
// an `AccordionStore` (the engine's view) — by linearizing the messages into wire
// blocks and converting them to engine blocks, the durable ids are IDENTICAL on
// both sides. We then assert the engine's claimed group savings EQUALS the wire's
// measured token delta after `applyPlan`.
// ─────────────────────────────────────────────────────────────────────────────

/** Total estimated tokens of a message array, measured exactly as the engine/wire do. */
function wireTokens(messages: PiMessage[]): number {
	return linearize(messages).reduce((n, b) => n + b.tokens, 0);
}

/** Build an AccordionStore whose blocks share the EXACT durable ids `linearize(messages)` emits. */
function storeFrom(messages: PiMessage[]): AccordionStore {
	const blocks = linearize(messages).map(wireToBlock);
	const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks, lineCount: 0, skipped: 0 };
	const s = new AccordionStore(parsed);
	// No conductor / auto-folder exists on this branch, so nothing folds under budget pressure —
	// isolate pure group behavior with no auto-folds to confound the delta.
	s.setBudget(1_000_000);
	s.setProtect(0); // disable the protected tail — every block is groupable
	return s;
}

/** Apply the engine's CURRENT plan (folds + groups) to the messages and measure the wire delta. */
function wireDelta(store: AccordionStore, messages: PiMessage[]): number {
	const before = wireTokens(messages);
	const after = wireTokens(applyPlan(messages, store.computeFoldOps(), store.computeGroupOps()));
	return before - after;
}

describe("group accounting cross-validates against the wire (applyPlan)", () => {
	// One assistant message with ONE tool call + its result. Grouping the whole turn is the
	// clean, no-straggler case: the wire collapses both messages into one summary.
	function oneCall(): PiMessage[] {
		return [
			{ role: "user", content: "u0 " + "x".repeat(40), timestamp: 1000 }, // m0 u:1000
			{
				role: "assistant",
				responseId: "resp_a",
				timestamp: 1001,
				content: [
					{ type: "text", text: "reading " + "y".repeat(200) },
					{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
				],
			}, // m1 a:resp_a:p0 (text), a:resp_a:p1 (call_1)
			{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: "file body " + "z".repeat(400) }, // m2 r:call_1
			{ role: "user", content: "u1 newest " + "x".repeat(40), timestamp: 2000 }, // m3 u:2000
		];
	}

	it("NO straggler (one run): engine savings == wire delta", () => {
		const messages = oneCall();
		const store = storeFrom(messages);
		// group the assistant message + its tool result — balanced, nothing straggles.
		const g = store.createGroup("a:resp_a:p0", "r:call_1")!;
		expect(g).not.toBeNull();
		expect(store.groupStragglerCount(g)).toBe(0);
		const delta = wireDelta(store, messages);
		expect(store.groupSavedTokens(g)).toBe(delta);
		// and the global view agrees (only this group folded)
		expect(store.savedTokens).toBe(delta);
	});

	// A LEADING straggler: a tool_result whose call is OUTSIDE the group sits at the FRONT,
	// then a clean collapsible tail. One contiguous run after the straggler.
	function leadingStraggler(): PiMessage[] {
		return [
			{ role: "user", content: "u0 " + "x".repeat(40), timestamp: 1000 }, // m0 u:1000
			{
				role: "assistant",
				responseId: "resp_a",
				timestamp: 1001,
				content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
			}, // m1 a:resp_a:p0 (call_1) — OUTSIDE the group below
			{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: "body " + "z".repeat(300) }, // m2 r:call_1 — group starts here (straggler)
			{ role: "user", content: "u1 " + "x".repeat(80), timestamp: 2000 }, // m3 u:2000 — collapses
			{ role: "assistant", responseId: "resp_b", timestamp: 2001, content: [{ type: "text", text: "ok " + "y".repeat(200) }] }, // m4 a:resp_b:p0 — collapses
			{ role: "user", content: "u2 newest", timestamp: 3000 }, // m5 u:3000
		];
	}

	it("LEADING straggler (one run): engine savings == wire delta", () => {
		const messages = leadingStraggler();
		const store = storeFrom(messages);
		// group r:call_1 .. a:resp_b:p0 — r:call_1's CALL (m1) is OUTSIDE → straggler; u:2000+resp_b collapse.
		const g = store.createGroup("r:call_1", "a:resp_b:p0")!;
		expect(g).not.toBeNull();
		expect(store.groupStragglerCount(g)).toBe(1);
		const delta = wireDelta(store, messages);
		expect(store.groupSavedTokens(g)).toBe(delta);
		expect(store.savedTokens).toBe(delta);
	});

	// A TRAILING straggler: a clean collapsible head, then a tool_call whose result is OUTSIDE
	// at the END. One contiguous run before the straggler.
	function trailingStraggler(): PiMessage[] {
		return [
			{ role: "user", content: "u0 " + "x".repeat(80), timestamp: 1000 }, // m0 u:1000 — collapses
			{ role: "assistant", responseId: "resp_a", timestamp: 1001, content: [{ type: "text", text: "thinking " + "y".repeat(200) }] }, // m1 a:resp_a:p0 — collapses
			{
				role: "assistant",
				responseId: "resp_b",
				timestamp: 1002,
				content: [{ type: "toolCall", id: "call_2", name: "edit", arguments: {} }],
			}, // m2 a:resp_b:p0 (call_2) — its result m3 is OUTSIDE → straggler
			{ role: "toolResult", toolCallId: "call_2", toolName: "edit", content: "done " + "z".repeat(300) }, // m3 r:call_2 — OUTSIDE the group
			{ role: "user", content: "u1 newest", timestamp: 2000 }, // m4 u:2000
		];
	}

	it("TRAILING straggler (one run): engine savings == wire delta", () => {
		const messages = trailingStraggler();
		const store = storeFrom(messages);
		// group u:1000 .. a:resp_b:p0 — resp_b holds call_2 whose result is OUTSIDE → straggler; u:1000+resp_a collapse.
		const g = store.createGroup("u:1000", "a:resp_b:p0")!;
		expect(g).not.toBeNull();
		expect(store.groupStragglerCount(g)).toBe(1);
		const delta = wireDelta(store, messages);
		expect(store.groupSavedTokens(g)).toBe(delta);
		expect(store.savedTokens).toBe(delta);
	});

	// An INTERIOR straggler: collapsible head, a straggler in the MIDDLE, collapsible tail.
	// This SPLITS the group into TWO contiguous runs → the wire inserts TWO summaries. The old
	// engine charged ONE summary total and overstated savings by (runs-1) × summaryTok.
	function interiorStraggler(): PiMessage[] {
		return [
			{ role: "user", content: "u0 " + "x".repeat(80), timestamp: 1000 }, // m0 u:1000 — run 1
			{ role: "assistant", responseId: "resp_a", timestamp: 1001, content: [{ type: "text", text: "head " + "y".repeat(200) }] }, // m1 a:resp_a:p0 — run 1
			{
				role: "assistant",
				responseId: "resp_b",
				timestamp: 1002,
				content: [{ type: "toolCall", id: "call_2", name: "edit", arguments: {} }],
			}, // m2 a:resp_b:p0 (call_2) — its result m5 is OUTSIDE → interior straggler (splits the runs)
			{ role: "user", content: "u1 " + "x".repeat(80), timestamp: 2000 }, // m3 u:2000 — run 2
			{ role: "assistant", responseId: "resp_c", timestamp: 2001, content: [{ type: "text", text: "tail " + "y".repeat(200) }] }, // m4 a:resp_c:p0 — run 2
			{ role: "toolResult", toolCallId: "call_2", toolName: "edit", content: "done " + "z".repeat(300) }, // m5 r:call_2 — OUTSIDE the group below
			{ role: "user", content: "u2 newest", timestamp: 3000 }, // m6 u:3000
		];
	}

	it("INTERIOR straggler (TWO runs): engine now charges TWO summaries == wire delta", () => {
		const messages = interiorStraggler();
		const store = storeFrom(messages);
		// group u:1000 .. a:resp_c:p0 — m2 (call_2, result outside) is an interior straggler that
		// splits the collapse into {u:1000, resp_a} and {u:2000, resp_c} → TWO summary messages.
		const g = store.createGroup("u:1000", "a:resp_c:p0")!;
		expect(g).not.toBeNull();
		expect(store.groupStragglerCount(g)).toBe(1);
		// The crux: the wire's delta reflects TWO inserted summaries; the engine must agree.
		const delta = wireDelta(store, messages);
		expect(store.groupSavedTokens(g)).toBe(delta);
		expect(store.savedTokens).toBe(delta);
		// And confirm the wire actually inserted two summary messages (sanity on the test fixture).
		const out = applyPlan(messages, store.computeFoldOps(), store.computeGroupOps());
		const summary = store.computeGroupOps()[0].summaryText!;
		const summaryCount = out.filter((m) => Array.isArray(m.content) && (m.content as any[])[0]?.text === summary).length;
		expect(summaryCount).toBe(2);
	});

	// PARALLEL tool calls in ONE assistant message: c1, c2. The group includes c1's RESULT but
	// NOT c2's result. The wire's fixpoint cascade: the assistant message can't be removed (c2's
	// result is outside) → so c1's call stays → so c1's result can't be removed either → NOTHING
	// collapses. The single-pass engine wrongly collapsed c1's result and counted savings.
	function parallelCalls(): PiMessage[] {
		return [
			{ role: "user", content: "u0 " + "x".repeat(40), timestamp: 1000 }, // m0 u:1000
			{
				role: "assistant",
				responseId: "resp_a",
				timestamp: 1001,
				content: [
					{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "b.ts" } },
				],
			}, // m1 a:resp_a:p0 (call_1), a:resp_a:p1 (call_2)
			{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: "body1 " + "z".repeat(400) }, // m2 r:call_1 — INSIDE the group
			{ role: "toolResult", toolCallId: "call_2", toolName: "read", content: "body2 " + "z".repeat(400) }, // m3 r:call_2 — OUTSIDE the group
			{ role: "user", content: "u1 newest", timestamp: 2000 }, // m4 u:2000
		];
	}

	it("PARALLEL calls, one result outside: engine and wire AGREE — NOTHING collapses, 0 saved", () => {
		const messages = parallelCalls();
		const store = storeFrom(messages);
		// Try to group the assistant message + ONLY call_1's result. createGroup must REFUSE it
		// (cascade collapses nothing → carrier null → a group that does nothing is not created).
		const g = store.createGroup("a:resp_a:p0", "r:call_1");
		expect(g).toBeNull();
		expect(store.groups.length).toBe(0);
		// The engine view shows 0 saved, and the wire likewise leaves the messages untouched.
		expect(store.savedTokens).toBe(0);
		expect(wireDelta(store, messages)).toBe(0);
		// Even if the group is FORCED into the store (bypassing createGroup's guard), the engine's
		// classifyGroup cascade still collapses nothing → 0 saved, matching the wire exactly.
		store.groups = [{ id: "g:a:resp_a:p0", memberIds: ["a:resp_a:p0", "a:resp_a:p1", "r:call_1"], folded: true, by: "auto" }];
		expect(store.groupSavedTokens(store.groups[0])).toBe(0);
		expect(store.savedTokens).toBe(0);
		expect(wireDelta(store, messages)).toBe(0);
		// applyPlan returns the messages structurally unchanged (identity).
		expect(wireTokens(applyPlan(messages, [], store.computeGroupOps()))).toBe(wireTokens(messages));
	});

	// A DROP group (summaryText null / digest null) with an INTERIOR straggler: both summaries
	// cost 0, so run-count is irrelevant — the saved tokens are just the collapsed full tokens,
	// and the engine must match the wire (which removes the runs and inserts nothing).
	it("DROP group with interior straggler: carrier cost 0 both sides, engine == wire", () => {
		const messages = interiorStraggler();
		const store = storeFrom(messages);
		// Force a DROP group (digest null) over the same interior-straggler range.
		store.groups = [
			{
				id: "g:u:1000",
				memberIds: ["u:1000", "a:resp_a:p0", "a:resp_b:p0", "u:2000", "a:resp_c:p0"],
				folded: true,
				by: "auto",
				digest: null,
			},
		];
		const g = store.groups[0];
		expect(store.isDropGroup(g)).toBe(true);
		// Two runs, but drop summaries cost 0 → run count does not change the answer.
		expect(store.groupStragglerCount(g)).toBe(1);
		const delta = wireDelta(store, messages);
		expect(store.groupSavedTokens(g)).toBe(delta);
		expect(store.savedTokens).toBe(delta);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// ISSUE #13 — the residual PR #66 deferred: a group with a NON-DURABLE-ID interior
	// member in a LIVE session. The wire (computeGroupOps → applyPlan) strips non-durable ids,
	// so that message stays live and SPLITS the collapsed run around it. Before this fix the
	// engine, being durability-agnostic, collapsed THROUGH it — over-counting savings. Now
	// `classifyGroup` is durability-aware when `wireAttached` is true, mirroring the wire.
	// ─────────────────────────────────────────────────────────────────────────

	// A clean collapsible head (u:1000 + resp_a), then a user message with NO timestamp (→ a
	// POSITIONAL id `m2:u`, non-durable) sitting in the MIDDLE, then a clean collapsible tail
	// (resp_b). The non-durable interior message splits the group into TWO runs on the wire.
	function nonDurableInteriorMember(): PiMessage[] {
		return [
			{ role: "user", content: "u0 " + "x".repeat(80), timestamp: 1000 }, // m0 u:1000 — run 1
			{ role: "assistant", responseId: "resp_a", timestamp: 1001, content: [{ type: "text", text: "head " + "y".repeat(200) }] }, // m1 a:resp_a:p0 — run 1
			{ role: "user", content: "anchorless " + "x".repeat(80) }, // m2 m2:u — NON-DURABLE (no timestamp) → interior straggler in LIVE
			{ role: "assistant", responseId: "resp_b", timestamp: 2001, content: [{ type: "text", text: "tail " + "y".repeat(200) }] }, // m3 a:resp_b:p0 — run 2
			{ role: "user", content: "u2 newest", timestamp: 3000 }, // m4 u:3000
		];
	}

	it("#13 LIVE: non-durable interior member splits the run — engine mirrors wire", () => {
		const messages = nonDurableInteriorMember();
		const store = storeFrom(messages);
		store.wireAttached = true; // a live pi wire is attached → view must mirror the wire

		// The interior member m2:u is non-durable → on the wire it stays live and splits the
		// collapse into {u:1000, resp_a} and {resp_b} → TWO summary messages.
		store.groups = [
			{
				id: "g:u:1000",
				memberIds: ["u:1000", "a:resp_a:p0", "m2:u", "a:resp_b:p0"],
				folded: true,
				by: "auto",
			},
		];
		const g = store.groups[0];
		// The non-durable member is a straggler in the live view (mirrors the wire).
		expect(store.groupStragglerCount(g)).toBe(1);
		const delta = wireDelta(store, messages);
		expect(store.groupSavedTokens(g)).toBe(delta);
		expect(store.savedTokens).toBe(delta);
		// And the wire really did insert TWO summary messages (the run is split around m2:u).
		const out = applyPlan(messages, store.computeFoldOps(), store.computeGroupOps());
		const summary = store.computeGroupOps()[0].summaryText!;
		const summaryCount = out.filter((m) => Array.isArray(m.content) && (m.content as any[])[0]?.text === summary).length;
		expect(summaryCount).toBe(2);
	});

	it("#13 LIVE: non-durable-only members collapse NOTHING — engine == wire (0 saved)", () => {
		// Every member of this group is non-durable (positional ids). The wire strips them all
		// → computeGroupOps emits no memberIds → nothing collapses → 0 saved. The live engine
		// view must agree (every member is a straggler → carrier null → 0 saved).
		const messages: PiMessage[] = [
			{ role: "user", content: "a " + "x".repeat(80) }, // m0 m0:u — non-durable
			{ role: "assistant", content: [{ type: "text", text: "b " + "y".repeat(80) }] }, // m1 m1:p0 — non-durable
		];
		const store = storeFrom(messages);
		store.wireAttached = true;
		store.groups = [{ id: "g:m0:u", memberIds: ["m0:u", "m1:p0"], folded: true, by: "auto" }];
		expect(store.groupSavedTokens(store.groups[0])).toBe(0);
		expect(store.savedTokens).toBe(0);
		expect(wireDelta(store, messages)).toBe(0);
		// The wire emits no group op at all (all memberIds stripped) → messages unchanged.
		expect(wireTokens(applyPlan(messages, [], store.computeGroupOps()))).toBe(wireTokens(messages));
	});

	it("#13 DEMO: same non-durable interior member stays AGNOSTIC (NOT live) — previews logical collapse", () => {
		// The SAME fixture as the live case, but `wireAttached` is false (demo / loaded session:
		// no model receives anything, so the issue explicitly permits durability-agnostic collapse).
		// Here the engine collapses THROUGH the non-durable member → ONE run / ONE summary,
		// showing the logical grouping (this is the accepted "non-durable folds preview in demo"
		// behavior the issue references). There is NO wire delta to match in a demo, so this only
		// asserts the demo behavior is unchanged: a single collapsed run (one carrier), 0 stragglers.
		const messages = nonDurableInteriorMember();
		const store = storeFrom(messages);
		// wireAttached stays false (demo).
		store.groups = [
			{
				id: "g:u:1000",
				memberIds: ["u:1000", "a:resp_a:p0", "m2:u", "a:resp_b:p0"],
				folded: true,
				by: "auto",
			},
		];
		const g = store.groups[0];
		// Demo is durability-agnostic → m2:u collapses too → no straggler, one contiguous run.
		expect(store.groupStragglerCount(g)).toBe(0);
		// Savings are positive (the whole range collapsed into one summary).
		expect(store.groupSavedTokens(g)).toBeGreaterThan(0);
	});
});
