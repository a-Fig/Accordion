import { describe, it, expect } from "vitest";
import { AccordionStore } from "../engine/store.svelte";
import type { Block, BlockKind, ParsedSession } from "../engine/types";
import type { Conductor, ConductorView, Command, LockName } from "$conductors/contract";
import { computeFoldOps, computeGroupOps, resolveUnfold, resolveRecall } from "./plan";
import { isDurableId, applyPlan, type PiMessage } from "./mapping";
import { foldCode } from "../engine/digest";

/** A test conductor that folds a configurable command batch and declares a lock-set. */
class LockingConductor implements Conductor {
	readonly id = "locking";
	readonly label = "Locking";
	readonly locks: readonly LockName[];
	cmds: Command[] | null = [];
	constructor(locks: readonly LockName[] = []) {
		this.locks = locks;
	}
	conduct(_view: ConductorView): Command[] | null {
		return this.cmds;
	}
}

// computeFoldOps mirrors the engine's LOCAL fold decisions into provider-safe wire
// ops. These tests lock the kind filter, the durable-id guard, and the empty-digest
// skip — the defense-in-depth that keeps a fold from orphaning a tool_call, folding
// user intent, or instructing a fold against an id we can't durably re-identify.

interface BlkOpts {
	id: string;
	kind?: BlockKind;
	tokens?: number;
	text?: string;
	toolName?: string;
	callId?: string;
}

let order = 0;
function blk(o: BlkOpts): Block {
	const i = order++;
	return {
		id: o.id,
		kind: o.kind ?? "text",
		turn: i + 1,
		order: i,
		text: o.text ?? `block ${i} ` + "lorem ipsum dolor sit amet ".repeat(8),
		tokens: o.tokens ?? 8000,
		toolName: o.toolName,
		callId: o.callId,
		override: null,
		autoFolded: false,
		by: null,
	};
}

function makeStore(blocks: Block[]): AccordionStore {
	order = 0;
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks,
		lineCount: 0,
		skipped: 0,
	};
	return new AccordionStore(parsed);
}

describe("computeFoldOps", () => {
	it("emits ops for folded text/thinking/tool_result blocks with durable ids", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "a:resp1:p1", kind: "thinking", tokens: 8000 }),
			blk({ id: "r:call1", kind: "tool_result", tokens: 8000, toolName: "grep", callId: "call1" }),
			// small recent tail (protected)
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
			blk({ id: "a:resp2:p0", kind: "text", tokens: 50, text: "ok" }),
		];
		const s = makeStore(blocks);
		s.setProtect(80); // protect only the tiny recent tail
		s.setBudget(1000); // force auto-folds on the old large blocks

		// sanity: fixtures actually fold something
		expect(s.foldedCount).toBeGreaterThan(0);

		const ops = computeFoldOps(s);
		// the three foldable old blocks should appear, in block order
		expect(ops.map((o) => o.id)).toEqual(["a:resp1:p0", "a:resp1:p1", "r:call1"]);
		for (const op of ops) {
			const b = s.get(op.id)!;
			expect(s.isFolded(b)).toBe(true);
			expect(op.digestText).toBe(s.digestOf(b));
			expect(op.digestText.length).toBeGreaterThan(0);
		}
	});

	it("excludes a folded tool_call (folding it would orphan its result)", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "tool_call", tokens: 8000, toolName: "read", callId: "c1" }),
			blk({ id: "a:resp1:p1", kind: "text", tokens: 8000 }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		// The store's fold() now refuses non-foldable kinds at the door (the shared
		// `wireFoldable` gate), so inject the folded view-state DIRECTLY to exercise
		// computeFoldOps's OWN defense-in-depth kind filter independently of the store gate.
		s.get("a:resp1:p0")!.override = "folded";
		expect(s.isFolded(s.get("a:resp1:p0")!)).toBe(true);

		const ops = computeFoldOps(s);
		expect(ops.map((o) => o.id)).not.toContain("a:resp1:p0");
	});

	it("excludes a folded user block (intent is never folded)", () => {
		order = 0;
		const blocks = [
			blk({ id: "u:500", kind: "user", tokens: 8000 }),
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		// fold() now refuses a user block at the door (shared `wireFoldable` gate); inject the
		// folded view-state DIRECTLY to test computeFoldOps's own defense-in-depth kind filter.
		s.get("u:500")!.override = "folded";
		expect(s.isFolded(s.get("u:500")!)).toBe(true);

		const ops = computeFoldOps(s);
		expect(ops.map((o) => o.id)).not.toContain("u:500");
	});

	it("excludes a folded block with a positional/fallback id (durable-id guard)", () => {
		order = 0;
		const blocks = [
			blk({ id: "m9:p0", kind: "text", tokens: 8000 }), // positional fallback id
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		s.setBudget(1000); // auto-fold the old blocks

		expect(s.isFolded(s.get("m9:p0")!)).toBe(true); // it IS folded by the engine
		const ops = computeFoldOps(s);
		expect(ops.map((o) => o.id)).not.toContain("m9:p0"); // but never emitted
		expect(ops.map((o) => o.id)).toContain("a:resp1:p0"); // the durable one is
	});

	it("returns [] when nothing is folded", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 50, text: "a" }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(0);
		s.setBudget(1_000_000); // far above live size → nothing folds
		expect(s.foldedCount).toBe(0);
		expect(computeFoldOps(s)).toEqual([]);
	});

	it("tags each op's digestText with the block's own fold code so the agent can unfold it", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "r:call1", kind: "tool_result", tokens: 8000, toolName: "grep", callId: "call1" }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		s.setBudget(1000);

		const ops = computeFoldOps(s);
		expect(ops.length).toBeGreaterThan(0);
		for (const op of ops) {
			// the agent reads `{#<code> FOLDED}` and passes <code> back — so the op MUST carry
			// THIS block's code in its tag, not the raw id and not another block's code.
			expect(op.digestText.startsWith(`{#${foldCode(op.id)} FOLDED} `)).toBe(true);
			expect(op.digestText).not.toContain(op.id); // the ugly raw id never ships
		}
	});
});

describe("resolveUnfold", () => {
	it("restores a known code (sticky, provenance agent) and reports unknown codes as missing", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "r:call1", kind: "tool_result", tokens: 8000, toolName: "grep", callId: "call1" }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		s.setBudget(1000); // fold the old blocks
		expect(s.isFolded(s.get("a:resp1:p0")!)).toBe(true);

		const code = foldCode("a:resp1:p0");
		const { restored, missing } = resolveUnfold(s, [code, "zzzz"]);

		// the known block is now held open, with agent provenance
		const b = s.get("a:resp1:p0")!;
		expect(s.isFolded(b)).toBe(false);
		expect(b.override).toBe("unfolded");
		expect(b.by).toBe("agent");
		// returned record carries code + kind + a label, NO content (state-change-only)
		expect(restored.map((r) => r.code)).toEqual([code]);
		expect(restored[0].kind).toBe("text");
		expect(restored[0].label).toContain("text");
		expect("text" in restored[0]).toBe(false);
		// the unknown code is reported, not silently dropped
		expect(missing).toEqual(["zzzz"]);
	});

	it("restores ALL folded blocks sharing a code (collision → unfold both)", () => {
		// Brute-force two distinct durable ids that hash to the same 4-char code (FNV
		// collides within a couple thousand tries — fast and deterministic).
		let idA = "", idB = "";
		const seen = new Map<string, string>();
		for (let i = 0; i < 500000; i++) {
			const id = `a:c${i}:p0`;
			const c = foldCode(id);
			const prev = seen.get(c);
			if (prev) { idA = prev; idB = id; break; }
			seen.set(c, id);
		}
		expect(idA && idB).toBeTruthy();
		expect(foldCode(idA)).toBe(foldCode(idB));

		order = 0;
		const blocks = [
			blk({ id: idA, kind: "text", tokens: 8000 }),
			blk({ id: idB, kind: "text", tokens: 8000 }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		s.setBudget(1000);
		expect(s.isFolded(s.get(idA)!)).toBe(true);
		expect(s.isFolded(s.get(idB)!)).toBe(true);

		const { restored, missing } = resolveUnfold(s, [foldCode(idA)]);
		// both colliding blocks restored from the single code
		expect(restored.length).toBe(2);
		expect(s.isFolded(s.get(idA)!)).toBe(false);
		expect(s.isFolded(s.get(idB)!)).toBe(false);
		expect(missing).toEqual([]);
	});

	it("refuses to touch a human-pinned block — reports it missing, pin survives", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "r:call1", kind: "tool_result", tokens: 8000, toolName: "grep", callId: "call1" }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		s.setBudget(1000);
		s.pin("a:resp1:p0"); // human pins it open
		expect(s.get("a:resp1:p0")!.override).toBe("pinned");

		// the agent must NOT be able to convert a pin into an agent-unfold (it can request,
		// never force). The pinned block's code resolves to no FOLDED block → missing.
		const code = foldCode("a:resp1:p0");
		const { restored, missing } = resolveUnfold(s, [code]);
		expect(restored).toEqual([]);
		expect(missing).toEqual([code]);
		expect(s.get("a:resp1:p0")!.override).toBe("pinned"); // pin intact
		expect(s.get("a:resp1:p0")!.by).toBe("you");
	});

	it("refuses an already-full (never-folded) block — reports missing, leaves it auto", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 50, text: "small" }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setBudget(1_000_000); // nothing folds
		expect(s.isFolded(s.get("a:resp1:p0")!)).toBe(false);

		const code = foldCode("a:resp1:p0");
		const { restored, missing } = resolveUnfold(s, [code]);
		expect(restored).toEqual([]);
		expect(missing).toEqual([code]);
		// it must NOT have been flipped to a sticky agent-unfold override
		expect(s.get("a:resp1:p0")!.override).toBe(null);
	});

	it("single-block unfold populates ids with [b.id] (never empty)", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "r:call1", kind: "tool_result", tokens: 8000, toolName: "grep", callId: "call1" }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		s.setBudget(1000);
		expect(s.isFolded(s.get("a:resp1:p0")!)).toBe(true);

		const code = foldCode("a:resp1:p0");
		const { restored } = resolveUnfold(s, [code]);
		expect(restored.length).toBeGreaterThanOrEqual(1);
		// Every restored entry must carry a non-empty ids array with the block id
		const entry = restored.find((r) => r.code === code)!;
		expect(entry.ids).toEqual(["a:resp1:p0"]);
	});

	it("an unfolded block no longer appears in the fold plan (restores at next context)", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "r:call1", kind: "tool_result", tokens: 8000, toolName: "grep", callId: "call1" }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		s.setBudget(1000);
		expect(computeFoldOps(s).map((o) => o.id)).toContain("a:resp1:p0");

		resolveUnfold(s, [foldCode("a:resp1:p0")]);
		// next plan omits it → the extension sends it full → agent's past context changes
		expect(computeFoldOps(s).map((o) => o.id)).not.toContain("a:resp1:p0");
	});

	// ── ADR 0011 — agent-unfold lock: a refused unfold reports "missing", not "restored" (FIX 3)
	it("under the agent-unfold lock a folded block resolves to MISSING and stays folded", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "r:call1", kind: "tool_result", tokens: 8000, toolName: "grep", callId: "call1" }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		// A conductor folds the durable block AND locks agent-unfold.
		const c = new LockingConductor(["agent-unfold"]);
		c.cmds = [{ kind: "fold", ids: ["a:resp1:p0"] }];
		s.attach(c);
		const b = s.get("a:resp1:p0")!;
		expect(s.isFolded(b)).toBe(true);

		const code = foldCode("a:resp1:p0");
		const { restored, missing } = resolveUnfold(s, [code]);

		// the refused agent unfold is reported missing, NOT a false "restored"
		expect(restored).toEqual([]);
		expect(missing).toEqual([code]);
		// and the block really did stay folded — the agent was not lied to
		expect(s.isFolded(b)).toBe(true);
		expect(b.override).toBe(null);
	});

	it("under the agent-unfold lock a folded GROUP code resolves to MISSING and stays folded (FIX 2/3)", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "a:resp2:p0", kind: "text", tokens: 8000 }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		const c = new LockingConductor(["agent-unfold"]);
		c.cmds = [{ kind: "group", ids: ["a:resp1:p0", "a:resp2:p0"] }];
		s.attach(c);
		const g = s.groups[0];
		expect(g.folded).toBe(true);

		const code = foldCode(g.id);
		const { restored, missing } = resolveUnfold(s, [code]);

		expect(restored).toEqual([]);
		expect(missing).toEqual([code]);
		expect(s.groupById(g.id)!.folded).toBe(true); // group never unfolded through the lock
	});
});

describe("resolveRecall", () => {
	it("returns the ORIGINAL full text (not the digest) for a folded block and never mutates", () => {
		order = 0;
		const ORIGINAL = "THE ORIGINAL FULL CONTENT " + "padding ".repeat(200);
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000, text: ORIGINAL }),
			blk({ id: "r:call1", kind: "tool_result", tokens: 8000, toolName: "grep", callId: "call1" }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		s.setBudget(1000); // fold the old blocks
		const b = s.get("a:resp1:p0")!;
		expect(s.isFolded(b)).toBe(true);

		const code = foldCode("a:resp1:p0");
		const { restored, missing } = resolveRecall(s, [code]);

		expect(restored.length).toBe(1);
		// the FULL original text comes back — NOT the lossy folded digest
		expect(restored[0].text).toBe(ORIGINAL);
		expect(restored[0].text).not.toBe(s.digestOf(b));
		expect(restored[0].code).toBe(code);
		expect(restored[0].ids).toEqual(["a:resp1:p0"]);
		expect(restored[0].label).toContain("text");
		expect(missing).toEqual([]);

		// READ-ONLY: the block is STILL folded, no override created (vs resolveUnfold)
		expect(s.isFolded(b)).toBe(true);
		expect(b.override).toBe(null);
		expect(b.by).not.toBe("agent");
	});

	it("reports a non-matching code as missing (and returns nothing for it)", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		s.setBudget(1000);

		const { restored, missing } = resolveRecall(s, ["zzzz"]);
		expect(restored).toEqual([]);
		expect(missing).toEqual(["zzzz"]);
	});

	it("reports an already-full (never-folded) block as missing — recall reads only folded content", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 50, text: "small" }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setBudget(1_000_000); // nothing folds
		expect(s.isFolded(s.get("a:resp1:p0")!)).toBe(false);

		const code = foldCode("a:resp1:p0");
		const { restored, missing } = resolveRecall(s, [code]);
		expect(restored).toEqual([]);
		expect(missing).toEqual([code]);
		expect(s.get("a:resp1:p0")!.override).toBe(null); // untouched
	});

	it("recalls a folded GROUP's members' full content joined (by the group code)", () => {
		order = 0;
		const TEXT_A = "FIRST MEMBER ORIGINAL CONTENT";
		const TEXT_B = "SECOND MEMBER ORIGINAL CONTENT";
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000, text: TEXT_A }),
			blk({ id: "a:resp2:p0", kind: "text", tokens: 8000, text: TEXT_B }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		// Human-group the two old text blocks into one folded group (folded:true by default).
		const g = s.createGroup("a:resp1:p0", "a:resp2:p0");
		expect(g).not.toBeNull();
		expect(g!.folded).toBe(true);

		const code = foldCode(g!.id);
		const { restored, missing } = resolveRecall(s, [code]);

		expect(restored.length).toBe(1);
		// the group's members' FULL original text, joined in order
		expect(restored[0].text).toContain(TEXT_A);
		expect(restored[0].text).toContain(TEXT_B);
		expect(restored[0].label).toContain("group");
		expect(restored[0].ids).toEqual(g!.memberIds);
		expect(missing).toEqual([]);

		// READ-ONLY: the group is STILL folded
		expect(s.groupById(g!.id)!.folded).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression guard — the PR #46 divergence (view↔wire mismatch when conductor
// holds a tail-size lock with tailTokens=0).
//
// With tailTokens=0 the engine's protectedFromIndex equals blocks.length, so
// the engine legitimately auto-folds ALL blocks including the newest ones. The
// old PROTECT_RECENT_MSGS=2 backstop in applyPlan would then suppress those ops
// on the wire — the GUI shows the block folded but the agent receives it whole.
// This test reproduces that scenario and proves the divergence is CLOSED after
// removing the backstop.
//
// Covers BOTH individual FoldOps and GroupOps.
// ─────────────────────────────────────────────────────────────────────────────
describe("regression: view↔wire divergence with tailTokens=0 (PR #46)", () => {
	// Build a pair of matching PiMessages + engine Blocks that share durable ids.
	// The newest ASSISTANT message carries a text part — the one that was
	// suppressed by the old backstop when it sat in the last 2 messages.
	const NEWEST_TEXT = "NEWEST ASSISTANT REPLY " + "content ".repeat(200);
	const OLDER_TEXT = "OLDER ASSISTANT REPLY " + "content ".repeat(200);

	function makeSession() {
		order = 0;
		// 3 blocks: an older text block + a newest text block + a user block (untargetable)
		const blocks: Block[] = [
			blk({ id: "a:resp_old:p0", kind: "text", tokens: 8000, text: OLDER_TEXT }),
			blk({ id: "a:resp_new:p0", kind: "text", tokens: 8000, text: NEWEST_TEXT }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		// tailTokens=0 ⟹ protectedFromIndex = blocks.length (all blocks foldable by engine).
		// Budget << liveTokens ⟹ engine auto-folds everything it can.
		const s = makeStore(blocks);
		s.setProtect(0);
		s.setBudget(1000);
		// Sanity: the newest text block IS folded by the engine.
		expect(s.isFolded(s.get("a:resp_new:p0")!)).toBe(true);
		expect(s.isFolded(s.get("a:resp_old:p0")!)).toBe(true);
		return s;
	}

	// Corresponding pi messages (same durable ids, same content).
	const piMessages: PiMessage[] = [
		{
			role: "assistant",
			responseId: "resp_old",
			timestamp: 100,
			content: [{ type: "text", text: OLDER_TEXT }],
		},
		{
			role: "assistant",
			responseId: "resp_new",
			timestamp: 200,
			content: [{ type: "text", text: NEWEST_TEXT }],
		},
		{ role: "user", content: "hi", timestamp: 1000 },
	];

	it("individual FoldOps: applyPlan FOLDS the newest message when the engine folded it (no position backstop)", () => {
		const s = makeSession();
		const ops = computeFoldOps(s);

		// computeFoldOps must emit ops for BOTH old and newest text blocks.
		const opIds = ops.map((o) => o.id);
		expect(opIds).toContain("a:resp_old:p0");
		expect(opIds).toContain("a:resp_new:p0"); // the key one — newest block in the plan

		// The regression: before the fix applyPlan would NOT fold the newest message
		// (it was in the last 2 messages → PROTECT_RECENT_MSGS backstop suppressed it).
		// After the fix it MUST fold it.
		const out = applyPlan(piMessages, ops);
		expect(out).not.toBe(piMessages); // something changed

		// Newest block is folded on the wire — no divergence.
		const newestPart = (out[1].content as any[])[0];
		expect(newestPart.text).not.toBe(NEWEST_TEXT); // not the original
		expect(newestPart.text).toBe(s.digestOf(s.get("a:resp_new:p0")!)); // matches the view's digest

		// Older block folded too.
		const olderPart = (out[0].content as any[])[0];
		expect(olderPart.text).toBe(s.digestOf(s.get("a:resp_old:p0")!));

		// User message never folded (structural guard still holds).
		expect(out[2].content).toBe("hi");
	});

	it("GroupOps: applyPlan COLLAPSES a group spanning the newest messages (no position backstop)", () => {
		order = 0;
		// A group of both text blocks (both durable, both foldable). The conductor has
		// grouped them; computeGroupOps emits one GroupOp covering them.
		const blocks: Block[] = [
			blk({ id: "a:resp_old:p0", kind: "text", tokens: 8000, text: OLDER_TEXT }),
			blk({ id: "a:resp_new:p0", kind: "text", tokens: 8000, text: NEWEST_TEXT }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(0);
		// Create a group spanning both text blocks.
		const g = s.createGroup("a:resp_old:p0", "a:resp_new:p0");
		expect(g).not.toBeNull();
		// Groups are folded by default on creation.
		expect(g!.folded).toBe(true);

		const groupOps = computeGroupOps(s);
		expect(groupOps.length).toBeGreaterThan(0);
		expect(groupOps[0].memberIds).toContain("a:resp_new:p0"); // newest block is in the group op

		const out = applyPlan(piMessages, [], groupOps);
		// The 2 messages (index 0+1) collapse into one summary; user remains.
		// Before the fix the newest message (index 1 in a 3-msg array = last 2) was backstopped.
		expect(out.length).toBe(2); // 2 messages collapsed to 1 + user = 2
		const summaryMsg = out[0];
		expect((summaryMsg.content as any[])[0].text).toBe(groupOps[0].summaryText);
		// User message unchanged.
		expect(out[1].content).toBe("hi");
	});
});

describe("isDurableId", () => {
	it("is true for durable, content-anchored ids", () => {
		expect(isDurableId("u:1")).toBe(true);
		expect(isDurableId("a:resp:p0")).toBe(true);
		expect(isDurableId("r:abc")).toBe(true);
		expect(isDurableId("s:9")).toBe(true);
	});
	it("is false for positional fallback ids", () => {
		expect(isDurableId("m0:u")).toBe(false);
		expect(isDurableId("m5:p0")).toBe(false);
		expect(isDurableId("m3:r")).toBe(false);
		expect(isDurableId("m2:s")).toBe(false);
	});
});
