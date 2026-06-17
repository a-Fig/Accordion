import { describe, it, expect } from "vitest";
import { AccordionStore } from "../engine/store.svelte";
import type { Block, BlockKind, ParsedSession } from "../engine/types";
import { computeFoldOps, resolveUnfold } from "./plan";
import { isDurableId } from "./mapping";
import { foldCode } from "../engine/digest";

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
