/*
 * conductor.slidingwindow.test.ts — behavioural tests for SlidingWindowConductor.
 *
 * Driven directly against `conduct()` using synthetic `ConductorView` fixtures,
 * mirroring the direct-call pattern used across the conductor tests.
 *
 * What we test:
 *   1. Under 90% of budget → returns [] (clear to raw).
 *   2. Over 90% → emits group commands with digest: null over oldest non-user blocks.
 *   3. User blocks are NOT included and split runs into separate group commands.
 *   4. Stops accumulating once the remove target is met (~70% of budget).
 *   5. A single non-user block between two user blocks → 1-member group (ids[0] === ids[1]).
 *   6. Empty block list and zero budget → returns [].
 *   7. Lock declaration is stable and matches registry entry.
 *   8. Hysteresis band — once dropped to ~70% it HOLDS (does not re-drop every pass) until
 *      the agent-visible window refills past 90%; the drop-set is monotonic.
 */
import { describe, it, expect } from "vitest";
import { SlidingWindowConductor } from "$conductors/sliding-window/sliding-window";
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

describe("SlidingWindowConductor — under budget returns raw", () => {
	it("returns [] when liveTokens ≤ budget * 0.90", () => {
		const blocks = [
			vb("m0:p0", "text", 0, 1000),
			vb("m1:p0", "text", 1, 1000),
			vb("m2:p0", "text", 2, 1000),
		];
		const view = makeView(blocks, 10_000, 8_999); // 8999 < 9000 = 90%
		expect(new SlidingWindowConductor().conduct(view)).toEqual([]);
	});

	it("returns [] when liveTokens equals exactly 90% of budget", () => {
		const blocks = [vb("m0:p0", "text", 0, 9_000)];
		const view = makeView(blocks, 10_000, 9_000); // exactly 90%
		expect(new SlidingWindowConductor().conduct(view)).toEqual([]);
	});
});

// ── 2. Over 90% → emit group commands with digest: null ──────────────────────

describe("SlidingWindowConductor — emits drop groups above trigger", () => {
	it("emits one group command covering the oldest non-user blocks", () => {
		// 10 text blocks × 1000 tokens = 10k live; budget = 10k → 100% → over trigger.
		// removeTarget = 10000 - 7000 = 3000, so we need 3 blocks.
		const blocks = Array.from({ length: 10 }, (_, i) => vb(`m${i}:p0`, "text", i, 1_000));
		const view = makeView(blocks, 10_000, 10_000);

		const result = new SlidingWindowConductor().conduct(view);

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

		const [cmd] = new SlidingWindowConductor().conduct(view) as Array<{
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

describe("SlidingWindowConductor — user blocks split runs", () => {
	it("user blocks are NOT included in any group command", () => {
		const blocks = [
			vb("m0:p0", "text", 0, 2_000),   // eligible non-user
			vb("m1:p0", "user", 1, 500),      // user → skip and split
			vb("m2:p0", "text", 2, 2_000),   // next run
			vb("m3:p0", "text", 3, 2_000),
		];
		// budget = 5000, liveTokens = 6500 → 130% > trigger. removeTarget = 6500 - 3500 = 3000.
		const view = makeView(blocks, 5_000, 6_500);

		const result = new SlidingWindowConductor().conduct(view);

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

		const result = new SlidingWindowConductor().conduct(view);

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

		const result = new SlidingWindowConductor().conduct(view);

		expect(result.length).toBeGreaterThanOrEqual(2);
		const ids0 = (result[0] as { ids: string[] }).ids;
		const ids1 = (result[1] as { ids: string[] }).ids;
		expect(ids0[0]).toBe("m0:p0");
		expect(ids1[0]).toBe("m2:p0");
	});
});

// ── 4. Stops near the 70% target ─────────────────────────────────────────────

describe("SlidingWindowConductor — stops at the remove target", () => {
	it("does not accumulate more blocks than needed to reach TARGET", () => {
		// 10 blocks × 1000 tokens, budget = 10_000, live = 10_000.
		// removeTarget = 3_000; should stop after 3 blocks (m0..m2), not consume all 10.
		const blocks = Array.from({ length: 10 }, (_, i) => vb(`m${i}:p0`, "text", i, 1_000));
		const view = makeView(blocks, 10_000, 10_000);

		const [cmd] = new SlidingWindowConductor().conduct(view) as Array<{ ids: string[] }>;

		expect(cmd.ids[1]).toBe("m2:p0");
	});
});

// ── 5. 1-member group (single non-user block between two user blocks) ─────────

describe("SlidingWindowConductor — 1-member group for isolated non-user block", () => {
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

		const result = new SlidingWindowConductor().conduct(view);

		expect(result).toHaveLength(1);
		const cmd = result[0] as { kind: string; ids: string[]; digest: null };
		expect(cmd.kind).toBe("group");
		expect(cmd.digest).toBeNull();
		expect(cmd.ids[0]).toBe("m1:p0");
		expect(cmd.ids[1]).toBe("m1:p0"); // single-member: first === last
	});
});

// ── 6. Empty / zero-budget guards ─────────────────────────────────────────────

describe("SlidingWindowConductor — empty/zero-budget guards", () => {
	it("returns [] for empty block list", () => {
		const view = makeView([], 10_000, 0);
		expect(new SlidingWindowConductor().conduct(view)).toEqual([]);
	});

	it("returns [] when budget is zero", () => {
		const blocks = [vb("m0:p0", "text", 0, 5_000)];
		const view = makeView(blocks, 0, 5_000);
		expect(new SlidingWindowConductor().conduct(view)).toEqual([]);
	});

	it("returns [] when protectedFromIndex = 0 (entire context is protected tail)", () => {
		const blocks = [vb("m0:p0", "text", 0, 5_000)];
		const view = makeView(blocks, 5_000, 9_000, 0); // all protected
		expect(new SlidingWindowConductor().conduct(view)).toEqual([]);
	});
});

// ── 7. Lock declaration ────────────────────────────────────────────────────────

// ── 8. Hysteresis band (high-water 90% / low-water 70%) ──────────────────────

describe("SlidingWindowConductor — hysteresis: holds between 70% and 90%", () => {
	it("does NOT re-drop on a second pass once the visible window is below the trigger", () => {
		// 10 × 1000 = 10k raw, budget 10k. First pass drops to ~70% (m0..m2).
		const blocks = Array.from({ length: 10 }, (_, i) => vb(`m${i}:p0`, "text", i, 1_000));
		const c = new SlidingWindowConductor();

		// Pass 1: raw 10k > 90% → drop m0..m2.
		const first = c.conduct(makeView(blocks, 10_000, 10_000));
		expect(first).toHaveLength(1);
		expect((first[0] as { ids: string[] }).ids).toEqual(["m0:p0", "m2:p0"]);

		// Pass 2: the host clears conductor folds, so liveTokens is the SAME raw 10k. A stateless
		// conductor would drop again; this one sees visible = 10k − 3k = 7k ≤ 90% → HOLDS.
		const second = c.conduct(makeView(blocks, 10_000, 10_000));
		// Byte-identical to pass 1 — the same delete, re-emitted to hold it. No new blocks.
		expect(second).toEqual(first);
	});

	it("re-drops only after the visible window refills past 90% (new turns appended)", () => {
		const c = new SlidingWindowConductor();

		// Pass 1: 10 × 1000 = 10k, budget 10k → drop m0..m2 (visible → 7k).
		const v1 = Array.from({ length: 10 }, (_, i) => vb(`m${i}:p0`, "text", i, 1_000));
		c.conduct(makeView(v1, 10_000, 10_000));

		// Agent adds 3 new turns (≈3k). Raw is now 13k; dropped still {m0,m1,m2} → visible = 10k
		// > 90% → grow the drop-set by another ~3k (m3..m5) back toward 70%.
		const v2 = Array.from({ length: 13 }, (_, i) => vb(`m${i}:p0`, "text", i, 1_000));
		const grown = c.conduct(makeView(v2, 10_000, 13_000));

		const droppedIds = grown.flatMap((cmd) => {
			const ids = (cmd as { ids: string[] }).ids;
			// Expand [first,last] runs over the contiguous block range.
			const start = v2.findIndex((b) => b.id === ids[0]);
			const end = v2.findIndex((b) => b.id === ids[1]);
			return v2.slice(start, end + 1).map((b) => b.id);
		});
		// Original 3 still deleted, plus the next 3 oldest.
		expect(droppedIds).toEqual(["m0:p0", "m1:p0", "m2:p0", "m3:p0", "m4:p0", "m5:p0"]);
	});

	it("holds at the band — visible between 70% and 90% adds nothing", () => {
		const c = new SlidingWindowConductor();
		const v1 = Array.from({ length: 10 }, (_, i) => vb(`m${i}:p0`, "text", i, 1_000));
		c.conduct(makeView(v1, 10_000, 10_000)); // drop m0..m2 → visible 7k

		// One small turn appended (+500). Raw 10.5k, dropped 3k → visible 7.5k (< 90%) → hold.
		const v2 = [...v1, vb("m10:p0", "text", 10, 500)];
		const held = c.conduct(makeView(v2, 10_000, 10_500));
		expect((held[0] as { ids: string[] }).ids).toEqual(["m0:p0", "m2:p0"]); // unchanged
		expect(held).toHaveLength(1);
	});

	it("is monotonic — never restores a deleted block, even far below budget", () => {
		const c = new SlidingWindowConductor();
		const blocks = Array.from({ length: 10 }, (_, i) => vb(`m${i}:p0`, "text", i, 1_000));
		c.conduct(makeView(blocks, 10_000, 10_000)); // drop m0..m2

		// Budget jumps so visible is now far under target — deletes still hold (gone = gone).
		const after = c.conduct(makeView(blocks, 100_000, 10_000));
		expect((after[0] as { ids: string[] }).ids).toEqual(["m0:p0", "m2:p0"]);
	});

	it("clears the committed drop-set when the budget drops to zero", () => {
		const c = new SlidingWindowConductor();
		const blocks = Array.from({ length: 10 }, (_, i) => vb(`m${i}:p0`, "text", i, 1_000));
		c.conduct(makeView(blocks, 10_000, 10_000)); // drop m0..m2
		expect(c.conduct(makeView(blocks, 0, 10_000))).toEqual([]); // zero budget → forget + raw
		// And with budget restored but still under trigger, nothing is re-dropped.
		expect(c.conduct(makeView(blocks, 100_000, 10_000))).toEqual([]);
	});
});

describe("SlidingWindowConductor — lock declaration", () => {
	it("locks human-steering and agent-unfold but NOT tail-size", () => {
		const c = new SlidingWindowConductor();
		expect(c.locks).toEqual(["human-steering", "agent-unfold"]);
		expect(c.locks).not.toContain("tail-size");
	});

	it("id and label are stable", () => {
		const c = new SlidingWindowConductor();
		expect(c.id).toBe("sliding-window");
		expect(c.label).toBe("Sliding window");
	});

	it("registry entry locks deep-equal instance locks (drift guard)", () => {
		const entry = IN_PROCESS_CONDUCTORS.find((c) => c.id === "sliding-window");
		expect(entry).toBeDefined();
		const instance = new SlidingWindowConductor();
		expect(entry!.locks).toEqual([...instance.locks]);
	});
});
