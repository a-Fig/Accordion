import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import { isBolted, wireFoldable } from "./digest";
import { parse } from "./parse";
import { SYSTEM_BLOCK_ID } from "./types";
import { computeFoldOps, computeGroupOps } from "../live/plan";
import { linearize, applyPlan, type PiMessage } from "../live/mapping";
import type { Conductor, ConductorView, Command } from "$conductors/contract";
// `Command` is referenced by CapturingConductor's return type below.
import type { Block, ParsedSession } from "./types";

/*
 * The BOLTED gate (issue #106) — the system prompt is structural context Accordion shows but
 * does not own. It is present, counted, and inspectable, but NO actor may fold, group, or pin
 * it: not the human, not a conductor, not the agent.
 *
 * The floor is defense-in-depth, so this file asserts it at EVERY layer independently rather
 * than trusting that one gate covers the rest:
 *   engine predicate → store (human paths) → conductor host (clamps) → wire emit
 *   (`computeFoldOps` / `computeGroupOps`) → wire apply (`applyPlan`).
 *
 * It also pins the two decisions that are easy to regress silently: the system block's tokens
 * COUNT toward `liveTokens` (the budget readout must not understate real window usage), and a
 * source with no system prompt produces NO block at all (silent absence — the sample session
 * and every Claude Code transcript must be byte-for-byte unchanged).
 */

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

class CapturingConductor implements Conductor {
	readonly id = "capture";
	readonly label = "Capture";
	lastView: ConductorView | null = null;
	conduct(view: ConductorView): Command[] {
		this.lastView = view;
		return [];
	}
}

/*
 * A session whose FIRST block is the bolted system prompt, mirroring the live shape.
 *   0 sys:0     system      turn0  2000  (bolted)
 *   1 u:1       user        turn1  1000
 *   2 a:r1:p0   thinking    turn1  1000
 *   3 a:r1:p1   text        turn1  1000
 *   4 a:r1:p2   tool_call   turn1  1000  callId c1
 *   5 r:c1      tool_result turn1  1000  callId c1
 *   6 u:2       user        turn2  1000  (newest)
 */
function session(): Block[] {
	return [
		blk(SYSTEM_BLOCK_ID, "system", 0, 0, 2000),
		blk("u:1", "user", 1, 1, 1000),
		blk("a:r1:p0", "thinking", 1, 2, 1000),
		blk("a:r1:p1", "text", 1, 3, 1000),
		blk("a:r1:p2", "tool_call", 1, 4, 1000, "c1"),
		blk("r:c1", "tool_result", 1, 5, 1000, "c1"),
		blk("u:2", "user", 2, 6, 1000),
	];
}

describe("bolted — the engine predicate", () => {
	it("marks only the system kind as bolted, and never as wire-foldable", () => {
		const blocks = session();
		for (const b of blocks) {
			expect(isBolted(b)).toBe(b.kind === "system");
			// A bolted block must never pass the foldability gate — that is what makes
			// per-block folding refuse it without needing a check of its own.
			if (isBolted(b)) expect(wireFoldable(b)).toBe(false);
		}
	});
});

describe("bolted — the human paths (store)", () => {
	it("never offers a fold for the system block", () => {
		const s = makeStore(session());
		expect(s.canFold(s.get(SYSTEM_BLOCK_ID)!)).toBe(false);
	});

	it("refuses a hand-fold and leaves the block live", () => {
		const s = makeStore(session());
		s.fold(SYSTEM_BLOCK_ID);
		const b = s.get(SYSTEM_BLOCK_ID)!;
		expect(s.isFolded(b)).toBe(false);
		expect(b.override).toBeNull();
	});

	it("refuses a pin (a bolted block is already permanently live)", () => {
		const s = makeStore(session());
		s.pin(SYSTEM_BLOCK_ID);
		expect(s.get(SYSTEM_BLOCK_ID)!.override).toBeNull();
	});

	it("refuses a group whose range would swallow the system block", () => {
		const s = makeStore(session());
		s.setProtect(1); // shrink the tail so the range is otherwise legal
		// Range spans block 0 (bolted) through block 2 — must be refused WHOLE, not trimmed.
		expect(s.createGroup(SYSTEM_BLOCK_ID, "a:r1:p0")).toBeNull();
		expect(s.groups.length).toBe(0);
	});

	it("still allows a group that starts AFTER the system block", () => {
		const s = makeStore(session());
		s.setProtect(1);
		// Guards against over-broad refusal: only ranges CONTAINING the bolted block are invalid.
		const g = s.createGroup("u:1", "a:r1:p0");
		expect(g).not.toBeNull();
		expect(g!.memberIds).not.toContain(SYSTEM_BLOCK_ID);
	});
});

describe("bolted — the conductor host (clamps)", () => {
	it("clamps a fold command with reason 'bolted' and leaves the block live", () => {
		const s = makeStore(session());
		const reports = s.applyCommands([{ kind: "fold", ids: [SYSTEM_BLOCK_ID] }], "auto");
		expect(reports).toHaveLength(1);
		expect(reports[0].reason).toBe("bolted");
		expect(reports[0].ids).toEqual([SYSTEM_BLOCK_ID]);
		expect(s.isFolded(s.get(SYSTEM_BLOCK_ID)!)).toBe(false);
	});

	it("clamps a replace command with reason 'bolted' and writes no substitution", () => {
		const s = makeStore(session());
		const reports = s.applyCommands([{ kind: "replace", id: SYSTEM_BLOCK_ID, content: "nope" }], "auto");
		expect(reports).toHaveLength(1);
		expect(reports[0].reason).toBe("bolted");
		expect(s.get(SYSTEM_BLOCK_ID)!.subst).toBeUndefined();
	});

	it("clamps a group command spanning the system block with reason 'bolted'", () => {
		const s = makeStore(session());
		s.setProtect(1);
		const reports = s.applyCommands([{ kind: "group", ids: [SYSTEM_BLOCK_ID, "a:r1:p0"] }], "auto");
		// Specifically `bolted`, NOT the generic `invalid-group` a null createGroup would give:
		// the conductor should learn this range is permanently ungroupable, not mis-bounded.
		expect(reports.find((x) => x.command === "group")?.reason).toBe("bolted");
		expect(s.groups.length).toBe(0);
	});

	it("clamps pin with reason 'bolted' rather than the incidental 'noop'", () => {
		const s = makeStore(session());
		const reports = s.applyCommands([{ kind: "pin", ids: [SYSTEM_BLOCK_ID] }], "auto");
		expect(reports.find((x) => x.ids.includes(SYSTEM_BLOCK_ID))?.reason).toBe("bolted");
	});

	it("shows the block in the view as unshrinkable, so no conductor picks it as a candidate", () => {
		const s = makeStore(session());
		const c = new CapturingConductor();
		s.attach(c); // attach triggers a pass → the view is captured
		const vb = c.lastView!.blocks.find((b) => b.id === SYSTEM_BLOCK_ID)!;
		expect(vb.kind).toBe("system");
		// `foldedTokens === tokens` is what makes the built-in's `foldedTokens < tokens`
		// candidate filter skip it before FOLD_RANK is ever consulted.
		expect(vb.foldedTokens).toBe(vb.tokens);
		expect(vb.folded).toBe(false);
		// Not `held`: bolted is a property of the KIND, not a human override. Reporting it as
		// held would wrongly imply a human could release it.
		expect(vb.held).toBe(false);
	});
});

describe("bolted — the wire", () => {
	it("never emits a FoldOp or GroupOp for the system block", () => {
		const s = makeStore(session()); // builtin is attached on construction
		// Force the strongest case: no protected tail and a budget far below the session size,
		// so the built-in folds everything it legally can — the bolted block must survive that.
		s.setProtect(0);
		s.setBudget(1000);
		const ops = computeFoldOps(s);
		expect(ops.find((o) => o.id === SYSTEM_BLOCK_ID)).toBeUndefined();
		expect(ops.length).toBeGreaterThan(0); // the run is meaningful: other blocks DID fold
		for (const g of computeGroupOps(s)) expect(g.memberIds).not.toContain(SYSTEM_BLOCK_ID);
	});

	it("refuses a FoldOp targeting a system message even if one is submitted directly", () => {
		// Defense in depth: `computeFoldOps` never emits this, so the only way here is a
		// hand-rolled/stale plan. `applyPlan` must independently refuse it.
		const msgs: PiMessage[] = [
			{ role: "system", content: "SYSTEM PROMPT BODY", timestamp: 1 },
			{ role: "user", content: "hi", timestamp: 2 },
		];
		const out = applyPlan(msgs, [{ id: SYSTEM_BLOCK_ID, digestText: "{#abc123 FOLDED} squashed" }], []);
		expect(out[0].content).toBe("SYSTEM PROMPT BODY");
	});

	it("refuses a GroupOp that names the system block", () => {
		const msgs: PiMessage[] = [
			{ role: "system", content: "SYSTEM PROMPT BODY", timestamp: 1 },
			{ role: "user", content: "hi", timestamp: 2 },
		];
		const out = applyPlan(msgs, [], [{ id: "g:x", memberIds: [SYSTEM_BLOCK_ID], summaryText: "recap" }]);
		expect(out.length).toBe(2);
		expect(out[0].content).toBe("SYSTEM PROMPT BODY");
	});
});

describe("bolted — linearize / parse sourcing", () => {
	it("emits a bolted first block for a system role message", () => {
		const blocks = linearize([
			{ role: "system", content: "you are a helpful agent", timestamp: 1 },
			{ role: "user", content: "hi", timestamp: 2 },
		]);
		expect(blocks[0].kind).toBe("system");
		expect(blocks[0].id).toBe(SYSTEM_BLOCK_ID);
		expect(blocks[0].order).toBe(0);
		expect(blocks[0].turn).toBe(0); // preamble — never part of a user turn
		expect(blocks[0].text).toBe("you are a helpful agent");
		// The user block still opens turn 1: the system block must not consume a turn number.
		expect(blocks[1].turn).toBe(1);
	});

	it("treats a developer role the same way", () => {
		const blocks = linearize([{ role: "developer", content: "rules", timestamp: 1 }]);
		expect(blocks[0].kind).toBe("system");
		expect(blocks[0].id).toBe(SYSTEM_BLOCK_ID);
	});

	it("emits NOTHING when the source carries no system prompt (silent absence)", () => {
		const blocks = linearize([
			{ role: "user", content: "hi", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "hello" }], responseId: "r1" },
		]);
		expect(blocks.some((b) => b.kind === "system")).toBe(false);
		expect(blocks[0].kind).toBe("user");
	});

	it("parses a system message out of pi JSONL on disk", () => {
		const raw = [
			JSON.stringify({ type: "session", cwd: "/tmp", title: "t" }),
			JSON.stringify({ type: "message", id: "m0", message: { role: "system", content: "standing orders" } }),
			JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hi" } }),
		].join("\n");
		const out = parse(raw);
		expect(out.blocks[0].kind).toBe("system");
		expect(out.blocks[0].id).toBe(SYSTEM_BLOCK_ID);
		expect(out.blocks[0].text).toBe("standing orders");
		expect(out.blocks[1].kind).toBe("user");
	});
});

describe("bolted — token accounting", () => {
	it("counts the system block in liveTokens, and keeps counting it when everything folds", () => {
		const s = makeStore(session());
		const sys = s.get(SYSTEM_BLOCK_ID)!;
		const before = s.liveTokens;
		expect(before).toBeGreaterThanOrEqual(sys.tokens);

		// Squeeze the budget so the built-in folds everything it can. The system block's tokens
		// must survive in the total — they are a fixed floor, not reclaimable headroom.
		s.setProtect(0);
		s.setBudget(1000);
		expect(s.liveTokens).toBeGreaterThanOrEqual(sys.tokens);
		expect(s.effTokens(sys)).toBe(sys.tokens); // never charged at a digest rate
	});
});
