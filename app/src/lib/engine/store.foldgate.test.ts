import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import { computeFoldOps } from "../live/plan";
import type { Conductor, ConductorView, Command } from "$conductors/contract";
import type { Block, ParsedSession } from "./types";

/*
 * The KIND foldability gate (`wireFoldable`): only `text` / `thinking` / `tool_result`
 * may ever be folded — by the human (`fold()`), by a conductor (`applyCommands` →
 * `substOne` for both `fold` and `replace`), or offered by the UI (`canFold`). A
 * `user` (intent) or `tool_call` (folding it orphans its result) block is REFUSED in
 * every path: the manual path silently leaves it live; the conductor path pushes a
 * `ClampReport` with `reason: "not-foldable"` and leaves it live. This pins exactly
 * that — the view can never show a per-block fold the wire would receive whole.
 */

// Durable, message-anchored ids so the fixtures mirror the live id shapes. Big budget +
// no protection by default so the only thing under test is the kind gate.
function blk(id: string, kind: Block["kind"], turn: number, order: number, tokens = 1000, callId?: string): Block {
	return {
		id,
		kind,
		turn,
		order,
		text: `${id} ` + "x".repeat(tokens * 4),
		tokens,
		callId,
		override: null,
		autoFolded: false,
		by: null,
	};
}

function makeStore(blocks: Block[]): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks,
		lineCount: 0,
		skipped: 0,
	};
	return new AccordionStore(parsed);
}

/** A conductor whose desired state the test sets directly — to drive a full pass. */
class StubConductor implements Conductor {
	readonly id = "stub";
	readonly label = "Stub";
	cmds: Command[] | null = [];
	conduct(_view: ConductorView): Command[] | null {
		return this.cmds;
	}
}

// A small mixed session: a user ask, an assistant message (thinking/text/tool_call),
// its tool result, then a newest user turn. callId pairs the call+result so folding the
// result is provider-safe. Big tokens so we can shrink the protected tail to a single
// newest block when we need to test protection.
//   0 u:1       user        turn1  1000
//   1 a:r1:p0   thinking    turn1  1000
//   2 a:r1:p1   text        turn1  1000
//   3 a:r1:p2   tool_call   turn1  1000  callId c1
//   4 r:c1      tool_result turn1  1000  callId c1
//   5 u:2       user        turn2  1000  (newest)
function session(): Block[] {
	return [
		blk("u:1", "user", 1, 0, 1000),
		blk("a:r1:p0", "thinking", 1, 1, 1000),
		blk("a:r1:p1", "text", 1, 2, 1000),
		blk("a:r1:p2", "tool_call", 1, 3, 1000, "c1"),
		blk("r:c1", "tool_result", 1, 4, 1000, "c1"),
		blk("u:2", "user", 2, 5, 1000),
	];
}

describe("fold() — manual kind gate", () => {
	it("refuses to fold a tool_call: stays live, override untouched", () => {
		const s = makeStore(session());
		s.setProtect(0); // nothing protected — isolate the kind gate
		s.fold("a:r1:p2"); // tool_call
		const b = s.get("a:r1:p2")!;
		expect(s.isFolded(b)).toBe(false);
		expect(b.override).toBe(null);
	});

	it("refuses to fold a user block: stays live, override untouched", () => {
		const s = makeStore(session());
		s.setProtect(0);
		s.fold("u:1"); // user
		const b = s.get("u:1")!;
		expect(s.isFolded(b)).toBe(false);
		expect(b.override).toBe(null);
	});

	it("folds text / thinking / tool_result (not protected, not pinned)", () => {
		const s = makeStore(session());
		s.setProtect(0);
		for (const id of ["a:r1:p1", "a:r1:p0", "r:c1"]) {
			s.fold(id);
			const b = s.get(id)!;
			expect(s.isFolded(b)).toBe(true);
			expect(b.override).toBe("folded");
		}
	});
});

describe("conductor path — substOne kind gate (fold & replace)", () => {
	it("a conductor `fold` of a tool_call is clamped 'not-foldable' and not folded", () => {
		const s = makeStore(session());
		s.setProtect(0);
		const reports = s.applyCommands([{ kind: "fold", ids: ["a:r1:p2"] }], "auto");
		expect(reports).toHaveLength(1);
		expect(reports[0].reason).toBe("not-foldable");
		expect(reports[0].ids).toEqual(["a:r1:p2"]);
		const b = s.get("a:r1:p2")!;
		expect(s.isFolded(b)).toBe(false);
		expect(b.subst).toBeUndefined();
	});

	it("a conductor `replace` of a tool_call is clamped 'not-foldable' and not folded", () => {
		const s = makeStore(session());
		s.setProtect(0);
		const reports = s.applyCommands([{ kind: "replace", id: "a:r1:p2", content: "" }], "auto");
		expect(reports).toHaveLength(1);
		expect(reports[0].reason).toBe("not-foldable");
		expect(reports[0].ids).toEqual(["a:r1:p2"]);
		const b = s.get("a:r1:p2")!;
		expect(s.isFolded(b)).toBe(false);
		expect(b.subst).toBeUndefined();
	});

	it("a conductor `fold`/`replace` of a user block is clamped 'not-foldable'", () => {
		const s = makeStore(session());
		s.setProtect(0);
		const r1 = s.applyCommands([{ kind: "fold", ids: ["u:1"] }], "auto");
		expect(r1[0].reason).toBe("not-foldable");
		expect(s.isFolded(s.get("u:1")!)).toBe(false);

		const r2 = s.applyCommands([{ kind: "replace", id: "u:1", content: "x" }], "auto");
		expect(r2[0].reason).toBe("not-foldable");
		expect(s.isFolded(s.get("u:1")!)).toBe(false);
	});

	it("a conductor `fold` of a text block still applies (no clamp, folded)", () => {
		const s = makeStore(session());
		s.setProtect(0);
		const reports = s.applyCommands([{ kind: "fold", ids: ["a:r1:p1"] }], "auto");
		expect(reports).toHaveLength(0);
		expect(s.isFolded(s.get("a:r1:p1")!)).toBe(true);
	});

	it("a conductor `replace` of a text block still applies (no clamp, subst set)", () => {
		const s = makeStore(session());
		s.setProtect(0);
		const reports = s.applyCommands([{ kind: "replace", id: "a:r1:p1", content: "see above" }], "auto");
		expect(reports).toHaveLength(0);
		const b = s.get("a:r1:p1")!;
		expect(s.isFolded(b)).toBe(true);
		expect(b.subst).toBe("see above");
		expect(s.digestOf(b)).toBe("see above");
	});
});

describe("canFold — truth table", () => {
	it("non-foldable kinds are never offered: tool_call → false, user → false", () => {
		const s = makeStore(session());
		s.setProtect(0);
		expect(s.canFold(s.get("a:r1:p2")!)).toBe(false); // tool_call
		expect(s.canFold(s.get("u:1")!)).toBe(false); // user
	});

	it("a foldable kind that is unprotected and unpinned → true", () => {
		const s = makeStore(session());
		s.setProtect(0);
		expect(s.canFold(s.get("a:r1:p1")!)).toBe(true); // text
	});

	it("a pinned text block → false", () => {
		const s = makeStore(session());
		s.setProtect(0);
		s.pin("a:r1:p1");
		const b = s.get("a:r1:p1")!;
		expect(b.override).toBe("pinned");
		expect(s.canFold(b)).toBe(false);
	});

	it("a text block inside the protected tail → false", () => {
		const s = makeStore(session());
		// Protect only the newest block (u:2, 1000 tok): target=1, newest=1000 ≥ 1, so
		// protectedFromIndex lands on the last block.
		s.setProtect(1);
		const newest = s.blocks[s.blocks.length - 1];
		expect(newest.id).toBe("u:2");
		expect(s.protectedFromIndex).toBe(s.blocks.length - 1);
		expect(s.isProtected(newest)).toBe(true);
		// A foldable-kind block dragged into the protected tail must report canFold === false.
		// Pull the tail back to cover the tool_result at index 4 too (2 blocks = 2000 tok;
		// target=2000 ⇒ cap=2500, so adding the second 1000-tok block is allowed).
		s.setProtect(2000);
		const tr = s.get("r:c1")!; // tool_result at index 4
		expect(s.protectedFromIndex).toBe(4);
		expect(s.isProtected(tr)).toBe(true);
		expect(s.canFold(tr)).toBe(false);
		// And below the tail it is foldable again.
		const text = s.get("a:r1:p1")!; // index 2, older than the tail
		expect(s.isProtected(text)).toBe(false);
		expect(s.canFold(text)).toBe(true);
	});

	it("a foldable-kind block inside a FOLDED group → false (the group owns it, not the kind)", () => {
		const s = makeStore(session());
		s.setBudget(1_000_000); // isolate: no auto-fold, the group is the only fold
		s.setProtect(0);
		// Group the whole assistant message + its result; folded by default (ADR 0006).
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		expect(g.folded).toBe(true);
		const text = s.get("a:r1:p1")!; // a FOLDABLE kind, now a collapsed group member
		expect(s.isFolded(text)).toBe(true);
		// canFold is false despite the foldable kind — the folded group controls the member,
		// so offering a per-block Fold would be a dead/duplicate affordance.
		expect(s.canFold(text)).toBe(false);
		// Hand it back: once the group unfolds, a foldable member is individually offerable again.
		s.unfoldGroup(g.id);
		expect(s.canFold(text)).toBe(true);
	});
});

describe("end-to-end — the gate kills the lie on BOTH the view and the wire", () => {
	it("a conductor folding a tool_call is clamped AND the wire still emits the block whole", () => {
		const s = makeStore(session());
		s.setProtect(0);
		const reports = s.applyCommands([{ kind: "fold", ids: ["a:r1:p2"] }], "auto");
		// View side: refused with a named clamp, the tile never recesses.
		expect(reports[0].reason).toBe("not-foldable");
		expect(s.isFolded(s.get("a:r1:p2")!)).toBe(false);
		// Wire side: computeFoldOps never emits the tool_call → the agent receives it whole.
		// View and wire AGREE (both: not folded) — the divergence is gone, not merely hidden.
		expect(computeFoldOps(s).map((o) => o.id)).not.toContain("a:r1:p2");
	});

	it("positive control: folding the paired tool_result DOES round-trip to the wire", () => {
		const s = makeStore(session());
		s.setProtect(0);
		const reports = s.applyCommands([{ kind: "fold", ids: ["r:c1"] }], "auto");
		expect(reports).toHaveLength(0); // foldable kind → no clamp
		expect(s.isFolded(s.get("r:c1")!)).toBe(true); // folded in the view
		expect(computeFoldOps(s).map((o) => o.id)).toContain("r:c1"); // AND emitted to the wire
	});
});
