/*
 * conductor.garbagecollector.test.ts — behavioural tests for
 * GarbageCollectorConductor (conductor-imaginarium.md, architecture #3).
 *
 * Two layers, mirroring conductor.autopilot.test.ts (direct `conduct()` calls with
 * synthetic views) and conductor.coldscore.test.ts (end-to-end through AccordionStore):
 *
 *   A. Direct: under-budget → []; budget guarantee; never folds forbidden blocks;
 *      reachability ordering (the GC's distinguishing behaviour) for entity / causal /
 *      first-user roots; reachable-fallback under the budget guarantee.
 *   B. End-to-end: budget guarantee, never folds protected, never emits groups, and the
 *      reachability-keeps-live behaviour driven through the real engine view.
 */
import { describe, it, expect } from "vitest";
import { GarbageCollectorConductor } from "$conductors/garbage-collector/garbage-collector";
import { IN_PROCESS_CONDUCTORS } from "$conductors";
import type { ConductorView, ViewBlock } from "$conductors/contract";
import { AccordionStore } from "./store.svelte";
import type { Block, ParsedSession } from "./types";

// ── Direct-call helpers ───────────────────────────────────────────────────────

function vb(
	id: string,
	kind: ViewBlock["kind"],
	order: number,
	tokens: number,
	foldedTokens: number,
	opts: { held?: boolean; protected?: boolean; grouped?: boolean; callId?: string; text?: string } = {},
): ViewBlock {
	return {
		id,
		kind,
		turn: order + 1,
		order,
		tokens,
		foldedTokens,
		held: opts.held ?? false,
		folded: false,
		protected: opts.protected ?? false,
		grouped: opts.grouped ?? false,
		callId: opts.callId,
		text: opts.text,
	};
}

function makeView(blocks: ViewBlock[], budget: number, liveTokens: number): ConductorView {
	const pfi = blocks.findIndex((b) => b.protected);
	return {
		blocks,
		budget,
		liveTokens,
		contextWindow: null,
		protectedFromIndex: pfi < 0 ? blocks.length : pfi,
		protectTokens: 0,
	};
}

function foldIdsOf(result: Command[] | null | undefined): Set<string> {
	if (!result || !result.length || result[0].kind !== "fold") return new Set();
	return new Set((result[0] as { kind: "fold"; ids: string[] }).ids);
}

// Import the Command type only for the helper annotation above.
import type { Command } from "$conductors/contract";

/** Projected live tokens after applying a conduct() result to `view.liveTokens`. */
function projected(view: ConductorView, result: Command[] | null): number {
	let live = view.liveTokens;
	const ids = foldIdsOf(result);
	for (const b of view.blocks) {
		if (ids.has(b.id)) live += b.foldedTokens - b.tokens;
	}
	return live;
}

// ── End-to-end store helpers (mirror conductor.coldscore.test.ts) ─────────────

function blk(i: number, kind: Block["kind"] = "text", tokens = 1000, extra: Partial<Block> = {}): Block {
	return {
		id: `m${i}:p0`,
		kind,
		turn: i + 1,
		order: i,
		text: `block ${i} ` + "x".repeat(tokens * 4),
		tokens,
		override: null,
		autoFolded: false,
		by: null,
		...extra,
	};
}

function makeStore(blocks: Block[], budget = 70_000, protect = 20_000): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks,
		lineCount: 0,
		skipped: 0,
	};
	const s = new AccordionStore(parsed);
	s.setProtect(protect);
	s.setBudget(budget);
	return s;
}

// ── 1. Registry & declaration ─────────────────────────────────────────────────

describe("GarbageCollectorConductor — registry & declaration", () => {
	it("id and label are stable", () => {
		const c = new GarbageCollectorConductor();
		expect(c.id).toBe("garbage-collector");
		expect(c.label).toBe("Garbage collector");
	});

	it("is collaborative — the registry declares no involvement locks (no consent gate)", () => {
		const entry = IN_PROCESS_CONDUCTORS.find((c) => c.id === "garbage-collector");
		expect(entry).toBeDefined();
		expect(entry!.locks).toBeUndefined();
	});
});

// ── 2. Under budget → raw ─────────────────────────────────────────────────────

describe("GarbageCollectorConductor — under budget returns raw", () => {
	it("returns [] when liveTokens ≤ budget", () => {
		const blocks = [
			vb("m0:p0", "text", 0, 1000, 50),
			vb("m1:p0", "text", 1, 1000, 50),
		];
		const view = makeView(blocks, 10_000, 2_000);
		expect(new GarbageCollectorConductor().conduct(view)).toEqual([]);
	});

	it("returns [] when liveTokens equals budget exactly", () => {
		const blocks = [vb("m0:p0", "text", 0, 5000, 100)];
		const view = makeView(blocks, 5_000, 5_000);
		expect(new GarbageCollectorConductor().conduct(view)).toEqual([]);
	});
});

// ── 3. Budget guarantee ───────────────────────────────────────────────────────

describe("GarbageCollectorConductor — budget guarantee", () => {
	it("folds enough blocks to bring projected live tokens ≤ budget", () => {
		// 10 text blocks × 1000 = 10k live; budget 5k. Each fold saves 950.
		const blocks = Array.from({ length: 10 }, (_, i) => vb(`m${i}:p0`, "text", i, 1000, 50));
		const view = makeView(blocks, 5_000, 10_000);
		const result = new GarbageCollectorConductor().conduct(view);
		expect(projected(view, result)).toBeLessThanOrEqual(view.budget);
	});

	it("budget guarantee holds across multiple refold passes (end-to-end)", () => {
		const blocks = Array.from({ length: 20 }, (_, i) => blk(i, "text", 1000));
		const s = makeStore(blocks, 10_000, 0);
		s.attach(new GarbageCollectorConductor());
		for (let i = 0; i < 5; i++) {
			s.refold();
			expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
		}
	});
});

// ── 4. Never folds forbidden blocks ───────────────────────────────────────────

describe("GarbageCollectorConductor — never folds forbidden blocks", () => {
	it("never folds a tool_call block", () => {
		const blocks: ViewBlock[] = [
			vb("m0:p0", "tool_call", 0, 500, 500, { callId: "c0" }),
			vb("m1:r", "tool_result", 1, 500, 30, { callId: "c0" }),
			vb("m2:p0", "tool_call", 2, 500, 500, { callId: "c1" }),
			vb("m3:r", "tool_result", 3, 500, 30, { callId: "c1" }),
		];
		// 2000 live, budget 800 → must fold both tool_results; tool_calls must stay live.
		const view = makeView(blocks, 800, 2_000);
		const folded = foldIdsOf(new GarbageCollectorConductor().conduct(view));
		for (const b of blocks) {
			if (b.kind === "tool_call") expect(folded.has(b.id)).toBe(false);
		}
	});

	it("never folds a user block", () => {
		const blocks: ViewBlock[] = [
			vb("m0:p0", "user", 0, 1000, 1000),
			...Array.from({ length: 5 }, (_, i) => vb(`m${i + 1}:p0`, "text", i + 1, 1000, 50)),
		];
		// 6000 live, budget 3000 → must fold; user must stay live.
		const view = makeView(blocks, 3_000, 6_000);
		const folded = foldIdsOf(new GarbageCollectorConductor().conduct(view));
		expect(folded.has("m0:p0")).toBe(false);
	});

	it("never folds a held block", () => {
		const blocks: ViewBlock[] = [
			vb("m0:p0", "text", 0, 3000, 50, { held: true }),
			vb("m1:p0", "text", 1, 3000, 50),
		];
		const view = makeView(blocks, 4_000, 6_000);
		const folded = foldIdsOf(new GarbageCollectorConductor().conduct(view));
		expect(folded.has("m0:p0")).toBe(false);
		expect(folded.has("m1:p0")).toBe(true);
	});

	it("never folds a protected-tail block (end-to-end)", () => {
		// 20 blocks × 1000 = 20k; budget 10k; protect 5k → last 5 blocks protected.
		const blocks = Array.from({ length: 20 }, (_, i) => blk(i, "text", 1000));
		const s = makeStore(blocks, 10_000, 5_000);
		s.attach(new GarbageCollectorConductor());
		const pf = s.protectedFromIndex;
		expect(pf).toBeGreaterThan(0);
		s.blocks.forEach((b, i) => {
			if (i >= pf) expect(s.isFolded(b)).toBe(false);
		});
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
	});

	it("never folds a grouped block", () => {
		const blocks: ViewBlock[] = [
			vb("m0:p0", "text", 0, 3000, 50, { grouped: true }),
			vb("m1:p0", "text", 1, 3000, 50),
		];
		const view = makeView(blocks, 4_000, 6_000);
		const folded = foldIdsOf(new GarbageCollectorConductor().conduct(view));
		expect(folded.has("m0:p0")).toBe(false);
	});
});

// ── 5. Reachability ordering — the GC's distinguishing behaviour ──────────────
//
// The built-in folds OLDEST-first; the GC folds UNREACHABLE-first. These tests build
// fixtures where the OLDER block is REACHABLE (linked to the protected tail) and a
// NEWER block is UNREACHABLE, then assert the GC folds the unreachable one and keeps
// the reachable one live — the opposite of what oldest-first would do.

describe("GarbageCollectorConductor — reachability ordering", () => {
	it("folds an UNREACHABLE block before a REACHABLE one (entity edge to the tail)", () => {
		const PATH = "src/parse.ts";
		const blocks: ViewBlock[] = [
			// A: older tool_result, shares PATH with the protected tail → reachable.
			vb("m0:r", "tool_result", 0, 1500, 30, { text: `reading \`${PATH}\` for analysis` }),
			// B: newer tool_result, mentions an unrelated path → unreachable (singleton).
			vb("m1:r", "tool_result", 1, 1500, 30, { text: `reading \`src/other.ts\` instead` }),
			// Tail: protected, shares PATH with A → roots A.
			vb("m2:p0", "text", 2, 2000, 100, { protected: true, text: `now editing \`${PATH}\` entry point` }),
		];
		// liveTokens = 1500 + 1500 + 2000 = 5000; budget 4000 → fold exactly one (saves 1470).
		const view = makeView(blocks, 4_000, 5_000);
		const folded = foldIdsOf(new GarbageCollectorConductor().conduct(view));

		expect(folded.has("m1:r"), "unreachable B should be folded first").toBe(true);
		expect(folded.has("m0:r"), "reachable A should stay live").toBe(false);
		expect(folded.size).toBe(1);
		expect(projected(view, new GarbageCollectorConductor().conduct(view))).toBeLessThanOrEqual(view.budget);
	});

	it("keeps a tool_result reachable via its tool_call in the protected tail (causal edge)", () => {
		// C: tool_call in the protected tail → root.
		// R: its tool_result partner (callId c1) → reachable via the causal edge.
		// U: an unrelated tool_result → unreachable.
		const blocks: ViewBlock[] = [
			vb("m0:r", "tool_result", 0, 1500, 30, { callId: "c1" }), // R — reachable
			vb("m1:r", "tool_result", 1, 1500, 30, { callId: "c2" }), // U — unreachable
			vb("m2:p0", "tool_call", 2, 200, 200, { callId: "c1", protected: true }), // C — root
		];
		// liveTokens = 1500 + 1500 + 200 = 3200; budget 2500 → fold one (saves 1470 → 1730).
		const view = makeView(blocks, 2_500, 3_200);
		const folded = foldIdsOf(new GarbageCollectorConductor().conduct(view));

		expect(folded.has("m1:r"), "unreachable U should be folded").toBe(true);
		expect(folded.has("m0:r"), "R (paired with the tail's tool_call) should stay live").toBe(false);
	});

	it("treats the FIRST user message as a root (original task statement)", () => {
		const PATH = "src/auth.ts";
		const blocks: ViewBlock[] = [
			// First user message — a root — mentions PATH.
			vb("m0:p0", "user", 0, 800, 800, { text: `please fix the login in \`${PATH}\`` }),
			// T: tool_result sharing PATH with the first user → reachable.
			vb("m1:r", "tool_result", 1, 1500, 30, { text: `grep \`${PATH}\` found 3 hits` }),
			// X: unrelated tool_result → unreachable.
			vb("m2:r", "tool_result", 2, 1500, 30, { text: `reading \`src/other.ts\` instead` }),
		];
		// No protected tail; roots = {first user}. liveTokens = 800+1500+1500 = 3800; budget 3000.
		// Fold one tool_result (saves 1470 → 2330). X is unreachable → folds first; T stays live.
		const view = makeView(blocks, 3_000, 3_800);
		const folded = foldIdsOf(new GarbageCollectorConductor().conduct(view));

		expect(folded.has("m2:r"), "unreachable X should be folded").toBe(true);
		expect(folded.has("m1:r"), "T (reachable via the first user message) should stay live").toBe(false);
	});

	it("does NOT treat a mid-session user message (outside the tail) as a root", () => {
		// If every user message were a root, an old user mention would keep old blocks
		// reachable forever. Only the FIRST user is a root; a later user that has aged out
		// of the tail does not anchor reachability.
		const PATH = "src/legacy.ts";
		const blocks: ViewBlock[] = [
			vb("m0:p0", "user", 0, 500, 500, { text: "begin the project" }), // first user (root)
			// Mid-session user mentions PATH, but is NOT the first user and NOT protected.
			vb("m1:p0", "user", 1, 500, 500, { text: `also touch \`${PATH}\` later` }),
			// T: tool_result sharing PATH only with the mid-session user (not a root) → unreachable.
			vb("m2:r", "tool_result", 2, 1500, 30, { text: `reading \`${PATH}\`` }),
			// U: unrelated tool_result → unreachable.
			vb("m3:r", "tool_result", 3, 1500, 30, { text: `reading \`src/other.ts\`` }),
			// Tail (root) mentions nothing shared.
			vb("m4:p0", "text", 4, 1500, 100, { protected: true, text: "current work continues" }),
		];
		// liveTokens = 500+500+1500+1500+1500 = 5500; budget 4500 → fold one (saves 1470 → 4030).
		// Both T and U are unreachable; tie broken by kind-rank (both tool_result) then order:
		// T (order 2) folds before U (order 3). The mid-session user does not rescue T.
		const view = makeView(blocks, 4_500, 5_500);
		const folded = foldIdsOf(new GarbageCollectorConductor().conduct(view));

		expect(folded.has("m2:r"), "T should fold — the mid-session user is not a root").toBe(true);
		expect(folded.size).toBe(1);
	});

	it("mid-session user must NOT become a root when the first user is HELD", () => {
		// Regression: when the first user block is held (human-pinned), the root-selection
		// loop must still set firstUserSeen so later user blocks don't become roots.
		// Without the fix, held first-user → firstUserSeen stays false → next user becomes
		// a root → blocks reachable only from that mid-session user wrongly stay live.
		const PATH = "src/legacy.ts";
		const blocks: ViewBlock[] = [
			// First user — HELD (human pinned the original task). Shares nothing with PATH.
			vb("m0:p0", "user", 0, 500, 500, { held: true, text: "begin the project" }),
			// Mid-session user mentions PATH. Must NOT be a root.
			vb("m1:p0", "user", 1, 500, 500, { text: `also touch \`${PATH}\` later` }),
			// T: tool_result sharing PATH only with the mid-session user → unreachable.
			vb("m2:r", "tool_result", 2, 1500, 30, { text: `reading \`${PATH}\`` }),
			// U: unrelated tool_result → unreachable.
			vb("m3:r", "tool_result", 3, 1500, 30, { text: "reading `src/other.ts`" }),
			// Tail (root) mentions nothing shared.
			vb("m4:p0", "text", 4, 1500, 100, { protected: true, text: "current work continues" }),
		];
		// liveTokens 5500; budget 4500 → fold one. T and U are both unreachable; T folds
		// first (order 2 < 3). If the mid-session user were wrongly a root, T would stay
		// live and U would fold instead.
		const view = makeView(blocks, 4_500, 5_500);
		const folded = foldIdsOf(new GarbageCollectorConductor().conduct(view));

		expect(folded.has("m2:r"), "T should fold — mid-session user is not a root even when first user is held").toBe(true);
		expect(folded.size).toBe(1);
	});
});

// ── 6. Reachable fallback — budget guarantee wins over reachability ──────────

describe("GarbageCollectorConductor — reachable fallback under budget pressure", () => {
	it("folds REACHABLE blocks when unreachable ones cannot meet the budget", () => {
		// Every tool_result is reachable (each shares a unique path with the protected tail),
		// so the unreachable tier is empty. Budget pressure must still fold reachable ones.
		const blocks: ViewBlock[] = [
			vb("m0:r", "tool_result", 0, 1500, 30, { text: "reading `a.ts`" }),
			vb("m1:r", "tool_result", 1, 1500, 30, { text: "reading `b.ts`" }),
			vb("m2:r", "tool_result", 2, 1500, 30, { text: "reading `c.ts`" }),
			vb("m3:p0", "text", 3, 2000, 100, {
				protected: true,
				text: "editing `a.ts`, `b.ts`, and `c.ts`",
			}),
		];
		// liveTokens = 1500*3 + 2000 = 6500; budget 4000 → fold 2 (saves 2940 → 3560).
		const view = makeView(blocks, 4_000, 6_500);
		const result = new GarbageCollectorConductor().conduct(view);
		const folded = foldIdsOf(result);

		// All three tool_results are reachable, so the GC folds oldest-first within the
		// reachable tier (kind-rank tie → order): m0 then m1.
		expect(folded.has("m0:r")).toBe(true);
		expect(folded.has("m1:r")).toBe(true);
		expect(folded.has("m2:r")).toBe(false);
		expect(projected(view, result)).toBeLessThanOrEqual(view.budget);
	});

	it("folds every foldable candidate when the budget cannot be met (best-effort)", () => {
		// Protected tail dominates; even folding all candidates can't reach budget —
		// the GC still folds them all (matches the built-in / cold-score best-effort).
		const blocks: ViewBlock[] = [
			vb("m0:r", "tool_result", 0, 1000, 30, { text: "reading `a.ts`" }),
			vb("m1:p0", "text", 1, 100_000, 100, { protected: true, text: "huge protected tail" }),
		];
		const view = makeView(blocks, 5_000, 101_000);
		const folded = foldIdsOf(new GarbageCollectorConductor().conduct(view));
		expect(folded.has("m0:r")).toBe(true); // folded even though it can't meet budget
	});
});

// ── 7. End-to-end through the real engine view ────────────────────────────────

describe("GarbageCollectorConductor — end-to-end through AccordionStore", () => {
	it("keeps a tail-referenced block live while folding an unrelated one (entity reachability)", () => {
		const PATH = "src/parse.ts";
		const blocks: Block[] = [
			// Block 0: older tool_result sharing PATH with the protected tail → reachable.
			{ ...blk(0, "tool_result", 1500), text: `reading \`${PATH}\` for analysis` },
			// Block 1: newer tool_result, unrelated path → unreachable.
			{ ...blk(1, "tool_result", 1500), text: `reading \`src/other.ts\` instead` },
			// Block 2: protected tail sharing PATH with block 0.
			{ ...blk(2, "text", 2000), text: `now editing \`${PATH}\` entry point` },
		];
		// Total 5000; budget 4000 → must fold one. protect 2500 → only block 2 protected
		// (2000 < 2500, pulling block 1 would exceed the 25% overflow cap).
		const s = makeStore(blocks, 4_000, 2_500);
		s.attach(new GarbageCollectorConductor());

		expect(s.isFolded(s.get("m0:p0")!), "reachable block 0 stays live").toBe(false);
		expect(s.isFolded(s.get("m1:p0")!), "unreachable block 1 is folded").toBe(true);
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
	});

	it("folds ≥ 1 block when over budget (sanity)", () => {
		const blocks = Array.from({ length: 20 }, (_, i) => blk(i, "text", 1000));
		const s = makeStore(blocks, 10_000, 0);
		s.attach(new GarbageCollectorConductor());
		expect(s.foldedCount).toBeGreaterThan(0);
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
	});

	it("never emits group commands (fold-only, like the built-in / cold-score)", () => {
		const blocks: Block[] = Array.from({ length: 20 }, (_, i) => ({
			...blk(i, "tool_result", 1000),
			turn: 1,
		}));
		blocks.push({ ...blk(20, "text", 3000), turn: 100, text: "tail" });
		const s = makeStore(blocks, 5_000, 2_500);
		s.attach(new GarbageCollectorConductor());
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
		expect(s.groups.filter((g) => g.by === "auto" || g.by === "conductor").length).toBe(0);
	});

	it("detach() freezes the GC view as human-owned folds (kill switch, ADR 0011)", () => {
		const blocks = Array.from({ length: 15 }, (_, i) => blk(i, "text", 1000));
		const s = makeStore(blocks, 8_000, 0);
		s.attach(new GarbageCollectorConductor());
		const foldedBefore = s.foldedCount;
		expect(foldedBefore).toBeGreaterThan(0);

		s.detach();
		expect(s.foldedCount).toBe(foldedBefore); // frozen, not cleared
		expect(s.conductor).toBe(null);
		expect(s.blocks.filter((b) => s.isFolded(b)).every((b) => b.override === "folded" && b.by === "you")).toBe(true);
	});

	it("attach(null) returns to raw even when the GC was active", () => {
		const blocks = Array.from({ length: 15 }, (_, i) => blk(i, "text", 1000));
		const s = makeStore(blocks, 8_000, 0);
		s.attach(new GarbageCollectorConductor());
		expect(s.foldedCount).toBeGreaterThan(0);

		s.attach(null);
		expect(s.foldedCount).toBe(0);
		expect(s.liveTokens).toBe(s.fullTokens);
	});
});
