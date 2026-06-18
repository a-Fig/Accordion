import { describe, it, expect } from "vitest";
import { AccordionStore } from "../engine/store.svelte";
import { computeGroupOps } from "./plan";
import { estTokens, BLOCK_OVERHEAD } from "../engine/tokens";
import { groupDigestTokens } from "../engine/digest";
import type { Block, Group, ParsedSession } from "../engine/types";

function b(id: string, kind: Block["kind"], turn: number, order: number, tokens: number, callId?: string): Block {
	return { id, kind, turn, order, text: id + " " + "x".repeat(40), tokens, callId, override: null, autoFolded: false, by: null };
}
function makeStore(): AccordionStore {
	const blocks: Block[] = [
		b("u:1", "user", 1, 0, 500),
		b("a:r1:p0", "thinking", 1, 1, 800),
		b("a:r1:p1", "text", 1, 2, 600),
		b("a:r1:p2", "tool_call", 1, 3, 100, "c1"),
		b("r:c1", "tool_result", 1, 4, 3000, "c1"),
		b("u:2", "user", 2, 5, 400),
		b("a:r2:p0", "text", 2, 6, 5000),
		b("u:3", "user", 3, 7, 100),
	];
	const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks, lineCount: 0, skipped: 0 };
	const s = new AccordionStore(parsed);
	s.setBudget(1_000_000);
	s.setProtect(0);
	return s;
}

describe("isDropGroup", () => {
	it("returns true for null digest", () => {
		const s = makeStore();
		const g: Group = { id: "g:u:1", memberIds: ["u:1"], folded: true, by: "auto", digest: null };
		expect(s.isDropGroup(g)).toBe(true);
	});

	it("returns true for empty-string digest", () => {
		const s = makeStore();
		const g: Group = { id: "g:u:1", memberIds: ["u:1"], folded: true, by: "auto", digest: "" };
		expect(s.isDropGroup(g)).toBe(true);
	});

	it("returns false for undefined digest", () => {
		const s = makeStore();
		const g: Group = { id: "g:u:1", memberIds: ["u:1"], folded: true, by: "auto" };
		expect(s.isDropGroup(g)).toBe(false);
	});

	it("returns false for a non-empty string digest", () => {
		const s = makeStore();
		const g: Group = { id: "g:u:1", memberIds: ["u:1"], folded: true, by: "auto", digest: "custom summary" };
		expect(s.isDropGroup(g)).toBe(false);
	});
});

describe("groupLiveTokens — drop group has 0 carrier cost", () => {
	it("a drop group (digest:null) folds to 0 carrier tokens (plus any stragglers)", () => {
		const s = makeStore();
		// Inject a drop group over a balanced range (a:r1:p0..r:c1); no stragglers.
		s.groups = [{ id: "g:a:r1:p0", memberIds: ["a:r1:p0", "a:r1:p1", "a:r1:p2", "r:c1"], folded: true, by: "auto", digest: null }];
		const g = s.groups[0];
		expect(s.isDropGroup(g)).toBe(true);
		expect(s.groupLiveTokens(g)).toBe(0); // carrier = 0; no stragglers
	});

	it("a drop group with a straggler — straggler stays live at full tokens", () => {
		// r:c1 .. u:2: r:c1's call (a:r1:p2) is outside → straggler. u:2 collapses → carrier 0.
		// With digest:null the carrier is 0, but the straggler adds its full tokens (stays live).
		const s = makeStore();
		s.groups = [{ id: "g:r:c1", memberIds: ["r:c1", "u:2"], folded: true, by: "auto", digest: null }];
		const g = s.groups[0];
		// r:c1 is a straggler (call a:r1:p2 is outside), u:2 collapses (no tool pair).
		// carrier (u:2, the only collapsing block) costs 0 (drop), straggler (r:c1) costs 3000.
		const live = s.groupLiveTokens(g);
		expect(live).toBe(3000); // straggler r:c1 full tokens
	});
});

describe("groupLiveTokens — custom digest uses its own token cost", () => {
	it("a custom-digest group's live tokens equal the digest string's token cost", () => {
		const s = makeStore();
		const customDigest = "{#abc FOLDED} custom summary text";
		s.groups = [{ id: "g:a:r1:p0", memberIds: ["a:r1:p0", "a:r1:p1", "a:r1:p2", "r:c1"], folded: true, by: "auto", digest: customDigest }];
		const g = s.groups[0];
		const expected = estTokens(customDigest) + BLOCK_OVERHEAD;
		expect(s.groupLiveTokens(g)).toBe(expected);
	});
});

describe("groupLiveTokens — undefined digest uses recap cost (regression guard)", () => {
	it("an undefined-digest group's live tokens equal groupDigestTokens of the collapsed members", () => {
		const s = makeStore();
		// Create a group the standard way (no digest argument → undefined).
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		expect(g.digest).toBeUndefined();
		// The classic recap cost: classifyGroup gives collapsedMembers = [a:r1:p0..r:c1]
		const members = s.groupMembers(g);
		const expected = groupDigestTokens(g, members); // all 4 collapse (balanced), no stragglers
		expect(s.groupLiveTokens(g)).toBe(expected);
	});
});

describe("computeGroupOps — drop group emits summaryText: null", () => {
	it("emits summaryText: null for a drop group (digest: null)", () => {
		const s = makeStore();
		// Inject a drop group directly
		s.groups = [{ id: "g:a:r1:p0", memberIds: ["a:r1:p0", "a:r1:p1", "a:r1:p2", "r:c1"], folded: true, by: "auto", digest: null }];
		const ops = computeGroupOps(s);
		expect(ops.length).toBe(1);
		expect(ops[0].summaryText).toBe(null);
		expect(ops[0].memberIds).toEqual(["a:r1:p0", "a:r1:p1", "a:r1:p2", "r:c1"]);
	});

	it("does NOT skip a drop group — it is valid and must be emitted", () => {
		const s = makeStore();
		s.groups = [{ id: "g:u:2", memberIds: ["u:2", "a:r2:p0"], folded: true, by: "auto", digest: null }];
		const ops = computeGroupOps(s);
		expect(ops.length).toBe(1);
		expect(ops[0].summaryText).toBeNull();
	});

	it("empty-string digest IS a drop — emits summaryText: null (not skipped)", () => {
		const s = makeStore();
		// "" is a drop (isDropGroup covers null || ""), so computeGroupOps emits null, not skip.
		s.groups = [{ id: "g:u:2", memberIds: ["u:2", "a:r2:p0"], folded: true, by: "auto", digest: "" }];
		const ops = computeGroupOps(s);
		// isDropGroup("") = true → summaryText = null → emitted (not skipped)
		expect(ops.length).toBe(1);
		expect(ops[0].summaryText).toBeNull();
	});

	it("a custom non-empty digest emits that string as summaryText", () => {
		const s = makeStore();
		s.groups = [{ id: "g:u:2", memberIds: ["u:2", "a:r2:p0"], folded: true, by: "auto", digest: "{#xyz FOLDED} my summary" }];
		const ops = computeGroupOps(s);
		expect(ops.length).toBe(1);
		expect(ops[0].summaryText).toBe("{#xyz FOLDED} my summary");
	});

	it("undefined digest emits the standard groupDigest recap (byte-identical to before)", () => {
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		const ops = computeGroupOps(s);
		expect(ops.length).toBe(1);
		expect(ops[0].summaryText).toBeTruthy();
		expect(typeof ops[0].summaryText).toBe("string");
		expect(ops[0].summaryText!.startsWith("{#")).toBe(true); // carries the FOLDED tag
	});
});
