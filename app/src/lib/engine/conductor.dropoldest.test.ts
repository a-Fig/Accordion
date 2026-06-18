/*
 * conductor.dropoldest.test.ts — behavioural tests for DropOldestConductor.
 *
 * Driven directly against `conduct()` using synthetic `ConductorView` fixtures,
 * mirroring the pattern in conductor.autopilot.test.ts.
 *
 * What we test:
 *   1. Under 90% of budget → returns [] (clear to raw).
 *   2. Over 90% → emits group commands with digest: null over oldest non-user blocks.
 *   3. User blocks are NOT included and split runs into separate group commands.
 *   4. Stops accumulating once the remove target is met (~70% of budget).
 *   5. A single non-user block between two user blocks → 1-member group (ids[0] === ids[1]).
 *   6. Empty block list and zero budget → returns [].
 *   7. Lock declaration is stable and matches registry entry.
 */
import { describe, it, expect } from "vitest";
import { DropOldestConductor } from "$conductors/drop-oldest/drop-oldest";
import { IN_PROCESS_CONDUCTORS } from "$conductors";
import type { ConductorView, ViewBlock } from "$conductors/contract";

// ── Helpers ───────────────────────────────────────────────────────────────────

function vb(
	id: string,
	kind: ViewBlock["kind"],
	order: number,
	tokens: number,
): ViewBlock {
	return {
		id,
		kind,
		turn: order + 1,
		order,
		tokens,
		foldedTokens: Math.max(10, Math.floor(tokens * 0.05)),
		held: false,
		folded: false,
		protected: false,
		grouped: false,
	};
}

/**
 * Build a view where protectedFromIndex defaults to blocks.length (no protected tail),
 * or a supplied value — giving the conductor its full eligible region.
 */
function makeView(
	blocks: ViewBlock[],
	budget: number,
	liveTokens: number,
	protectedFromIndex?: number,
): ConductorView {
	return {
		blocks,
		budget,
		liveTokens,
		contextWindow: null,
		protectedFromIndex: protectedFromIndex ?? blocks.length,
		protectTokens: 20_000,
	};
}

// ── 1. Under 90% → raw ───────────────────────────────────────────────────────

describe("DropOldestConductor — under budget returns raw", () => {
	it("returns [] when liveTokens ≤ budget * 0.90", () => {
		const blocks = [
			vb("m0:p0", "text", 0, 1000),
			vb("m1:p0", "text", 1, 1000),
			vb("m2:p0", "text", 2, 1000),
		];
		const view = makeView(blocks, 10_000, 8_999); // 8999 < 9000 = 90%
		expect(new DropOldestConductor().conduct(view)).toEqual([]);
	});

	it("returns [] when liveTokens equals exactly 90% of budget", () => {
		const blocks = [vb("m0:p0", "text", 0, 9_000)];
		const view = makeView(blocks, 10_000, 9_000); // exactly 90%
		expect(new DropOldestConductor().conduct(view)).toEqual([]);
	});
});

// ── 2. Over 90% → emit group commands with digest: null ──────────────────────

describe("DropOldestConductor — emits drop groups above trigger", () => {
	it("emits one group command covering the oldest non-user blocks", () => {
		// 10 text blocks × 1000 tokens = 10k live; budget = 10k → 100% → over trigger.
		// removeTarget = 10000 - 7000 = 3000, so we need 3 blocks.
		const blocks = Array.from({ length: 10 }, (_, i) => vb(`m${i}:p0`, "text", i, 1_000));
		const view = makeView(blocks, 10_000, 10_000);

		const result = new DropOldestConductor().conduct(view);

		expect(result.length).toBeGreaterThan(0);
		const cmd = result[0] as { kind: string; ids: string[]; digest: null };
		expect(cmd.kind).toBe("group");
		expect(cmd.digest).toBeNull();
		// First id must be the oldest block.
		expect(cmd.ids[0]).toBe("m0:p0");
	});

	it("group ids span exactly enough blocks to reach the remove target", () => {
		// budget = 10_000, liveTokens = 10_000 → removeTarget = 3_000.
		// Each block = 1000 tokens; need 3 blocks removed (3000 ≥ 3000).
		const blocks = Array.from({ length: 10 }, (_, i) => vb(`m${i}:p0`, "text", i, 1_000));
		const view = makeView(blocks, 10_000, 10_000);

		const [cmd] = new DropOldestConductor().conduct(view) as Array<{
			kind: string;
			ids: string[];
			digest: null;
		}>;

		// ids = [firstId, lastId]. The span is m0 .. m2 (3 blocks → 3000 tokens removed).
		expect(cmd.ids[0]).toBe("m0:p0");
		expect(cmd.ids[1]).toBe("m2:p0");
	});
});

// ── 3. User blocks split runs ─────────────────────────────────────────────────

describe("DropOldestConductor — user blocks split runs", () => {
	it("user blocks are NOT included in any group command", () => {
		const blocks = [
			vb("m0:p0", "text", 0, 2_000),   // eligible non-user
			vb("m1:p0", "user", 1, 500),      // user → skip and split
			vb("m2:p0", "text", 2, 2_000),   // next run
			vb("m3:p0", "text", 3, 2_000),
		];
		// budget = 5000, liveTokens = 6500 → 130% > trigger. removeTarget = 6500 - 3500 = 3000.
		const view = makeView(blocks, 5_000, 6_500);

		const result = new DropOldestConductor().conduct(view);

		const allIds = result.flatMap((c) => (c as { ids: string[] }).ids);
		expect(allIds).not.toContain("m1:p0");
	});

	it("flushes the run before the user block separately", () => {
		// text(3000) | user | text(3000) | text(3000)
		// budget = 10_000, live = 10_000 → removeTarget = 3000.
		// First run: m0 alone gives 3000 ≥ 3000 → flush [m0,m0], stop.
		const blocks = [
			vb("m0:p0", "text", 0, 3_000),
			vb("m1:p0", "user", 1, 500),
			vb("m2:p0", "text", 2, 3_000),
			vb("m3:p0", "text", 3, 3_000),
		];
		const view = makeView(blocks, 10_000, 10_000);

		const result = new DropOldestConductor().conduct(view);

		// Only the first run is needed (3000 ≥ removeTarget of 3000).
		expect(result).toHaveLength(1);
		const cmd = result[0] as { kind: string; ids: string[]; digest: null };
		expect(cmd.ids[0]).toBe("m0:p0");
		expect(cmd.ids[1]).toBe("m0:p0"); // single-member run
	});

	it("emits two groups when both sides of a user block contribute", () => {
		// text(500) | user | text(500) | text(500)
		// budget = 2000, live = 2100 → removeTarget = 2100 - 1400 = 700.
		// Run 1: m0 (500 removed). 500 < 700 → user hit → flush [m0,m0] (500).
		// Run 2: m2 (500) → 500+500=1000 >= 700 → flush [m2,m2], stop (we still need 200 more after first run but m2 covers it).
		const blocks = [
			vb("m0:p0", "text", 0, 500),
			vb("m1:p0", "user", 1, 200),
			vb("m2:p0", "text", 2, 500),
			vb("m3:p0", "text", 3, 500),
		];
		const view = makeView(blocks, 2_000, 2_100);

		const result = new DropOldestConductor().conduct(view);

		expect(result.length).toBeGreaterThanOrEqual(2);
		const ids0 = (result[0] as { ids: string[] }).ids;
		const ids1 = (result[1] as { ids: string[] }).ids;
		expect(ids0[0]).toBe("m0:p0");
		expect(ids1[0]).toBe("m2:p0");
	});
});

// ── 4. Stops near the 70% target ─────────────────────────────────────────────

describe("DropOldestConductor — stops at the remove target", () => {
	it("does not accumulate more blocks than needed to reach TARGET", () => {
		// 10 blocks × 1000 tokens, budget = 10_000, live = 10_000.
		// removeTarget = 3_000; should stop after 3 blocks (m0..m2), not consume all 10.
		const blocks = Array.from({ length: 10 }, (_, i) => vb(`m${i}:p0`, "text", i, 1_000));
		const view = makeView(blocks, 10_000, 10_000);

		const [cmd] = new DropOldestConductor().conduct(view) as Array<{ ids: string[] }>;

		expect(cmd.ids[1]).toBe("m2:p0");
	});
});

// ── 5. 1-member group (single non-user block between two user blocks) ─────────

describe("DropOldestConductor — 1-member group for isolated non-user block", () => {
	it("emits ids[0] === ids[1] for a lone non-user block flanked by user blocks", () => {
		// user | text(5000) | user
		// budget = 5000, live = 5001 → removeTarget = 5001 - 3500 = 1501.
		// The text block gives 5000 ≥ 1501 → flush as 1-member group.
		const blocks = [
			vb("m0:p0", "user", 0, 100),
			vb("m1:p0", "text", 1, 5_000),
			vb("m2:p0", "user", 2, 100),
		];
		const view = makeView(blocks, 5_000, 5_001);

		const result = new DropOldestConductor().conduct(view);

		expect(result).toHaveLength(1);
		const cmd = result[0] as { kind: string; ids: string[]; digest: null };
		expect(cmd.kind).toBe("group");
		expect(cmd.digest).toBeNull();
		expect(cmd.ids[0]).toBe("m1:p0");
		expect(cmd.ids[1]).toBe("m1:p0"); // single-member: first === last
	});
});

// ── 6. Empty / zero-budget guards ─────────────────────────────────────────────

describe("DropOldestConductor — empty/zero-budget guards", () => {
	it("returns [] for empty block list", () => {
		const view = makeView([], 10_000, 0);
		expect(new DropOldestConductor().conduct(view)).toEqual([]);
	});

	it("returns [] when budget is zero", () => {
		const blocks = [vb("m0:p0", "text", 0, 5_000)];
		const view = makeView(blocks, 0, 5_000);
		expect(new DropOldestConductor().conduct(view)).toEqual([]);
	});

	it("returns [] when protectedFromIndex = 0 (entire context is protected tail)", () => {
		const blocks = [vb("m0:p0", "text", 0, 5_000)];
		const view = makeView(blocks, 5_000, 9_000, 0); // all protected
		expect(new DropOldestConductor().conduct(view)).toEqual([]);
	});
});

// ── 7. Lock declaration ────────────────────────────────────────────────────────

describe("DropOldestConductor — lock declaration", () => {
	it("locks human-steering and agent-unfold but NOT tail-size", () => {
		const c = new DropOldestConductor();
		expect(c.locks).toEqual(["human-steering", "agent-unfold"]);
		expect(c.locks).not.toContain("tail-size");
	});

	it("id and label are stable", () => {
		const c = new DropOldestConductor();
		expect(c.id).toBe("drop-oldest");
		expect(c.label).toBe("Drop oldest");
	});

	it("registry entry locks deep-equal instance locks (drift guard)", () => {
		const entry = IN_PROCESS_CONDUCTORS.find((c) => c.id === "drop-oldest");
		expect(entry).toBeDefined();
		const instance = new DropOldestConductor();
		expect(entry!.locks).toEqual([...instance.locks]);
	});
});
