/*
 * conductor.autopilot.test.ts — behavioural tests for AutopilotConductor.
 *
 * Tests are driven directly against the conductor's `conduct()` method using
 * synthetic `ConductorView` fixtures (no AccordionStore needed). This mirrors the
 * direct-call pattern in conductor.coldscore.test.ts.
 *
 * What we test:
 *   1. `.locks` deep-equals the full exclusive set.
 *   2. Under-budget → returns [] (nothing to do).
 *   3. Over-budget → fold command brings projected live tokens to ≤ budget.
 *   4. Willing to fold a RECENT (last) block when needed — proving no self-imposed tail.
 *   5. Respects held / grouped blocks (never folds them).
 */
import { describe, it, expect } from "vitest";
import { AutopilotConductor } from "$conductors/autopilot/autopilot";
import { IN_PROCESS_CONDUCTORS } from "$conductors";
import type { ConductorView, ViewBlock } from "$conductors/contract";

// ── Helpers ───────────────────────────────────────────────────────────────────

function vb(
	id: string,
	kind: ViewBlock["kind"],
	order: number,
	tokens: number,
	foldedTokens: number,
	opts: { held?: boolean; protected?: boolean; grouped?: boolean } = {},
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
	};
}

function makeView(
	blocks: ViewBlock[],
	budget: number,
	liveTokens: number,
): ConductorView {
	return {
		blocks,
		budget,
		liveTokens,
		contextWindow: null,
		// Under tail-size lock the host sets protectedFromIndex = blocks.length (no tail).
		protectedFromIndex: blocks.length,
		protectTokens: 0,
	};
}

// ── 1. Lock declaration ───────────────────────────────────────────────────────

describe("AutopilotConductor — lock declaration", () => {
	it("locks all three steering controls", () => {
		const c = new AutopilotConductor();
		expect(c.locks).toEqual(["human-steering", "agent-unfold", "tail-size"]);
	});

	it("id and label are stable", () => {
		const c = new AutopilotConductor();
		expect(c.id).toBe("autopilot");
		expect(c.label).toBe("Autopilot");
	});

	it("registry entry locks deep-equal instance locks (drift guard)", () => {
		// The registry declares locks WITHOUT instantiating the conductor (so the UI
		// can show a consent gate before attaching). If they drift — e.g. registry says
		// collaborative but the instance locks "human-steering" — the gate is silently
		// skipped. This test catches that silent drift.
		const entry = IN_PROCESS_CONDUCTORS.find((c) => c.id === "autopilot");
		expect(entry).toBeDefined();
		const instance = new AutopilotConductor();
		expect(entry!.locks).toEqual([...instance.locks]);
	});
});

// ── 2. Under budget → raw ─────────────────────────────────────────────────────

describe("AutopilotConductor — under budget returns raw", () => {
	it("returns [] when liveTokens ≤ budget", () => {
		const blocks = [
			vb("m0:p0", "text", 0, 1000, 50),
			vb("m1:p0", "text", 1, 1000, 50),
			vb("m2:p0", "text", 2, 1000, 50),
		];
		const view = makeView(blocks, 10_000, 3_000);
		const result = new AutopilotConductor().conduct(view);
		expect(result).toEqual([]);
	});

	it("returns [] when liveTokens equals budget exactly", () => {
		const blocks = [vb("m0:p0", "text", 0, 5000, 100)];
		const view = makeView(blocks, 5_000, 5_000);
		expect(new AutopilotConductor().conduct(view)).toEqual([]);
	});
});

// ── 3. Over budget → fold to fit ─────────────────────────────────────────────

describe("AutopilotConductor — budget guarantee", () => {
	it("folds enough blocks to bring projected live tokens ≤ budget", () => {
		// 10 text blocks × 1000 tokens each = 10k live; budget = 5k
		// Each folded block costs 50 tokens, so folding 5 saves 5×950 = 4750 → fits.
		const blocks = Array.from({ length: 10 }, (_, i) =>
			vb(`m${i}:p0`, "text", i, 1000, 50),
		);
		const view = makeView(blocks, 5_000, 10_000);
		const result = new AutopilotConductor().conduct(view);

		expect(result).toHaveLength(1);
		expect(result[0].kind).toBe("fold");
		const foldIds = (result[0] as { kind: "fold"; ids: string[] }).ids;

		// Verify projected tokens after folding fit the budget.
		let projected = view.liveTokens;
		for (const id of foldIds) {
			const b = blocks.find((x) => x.id === id)!;
			projected += b.foldedTokens - b.tokens;
		}
		expect(projected).toBeLessThanOrEqual(view.budget);
	});

	it("folds in kind-rank order (tool_result before thinking before text)", () => {
		// 3 blocks of different kinds, all foldable; only need to fold 1 to fit.
		const blocks = [
			vb("m0:p0", "text", 0, 1000, 50),       // rank 2
			vb("m1:r", "tool_result", 1, 1000, 50),  // rank 0 → folded first
			vb("m2:p0", "thinking", 2, 1000, 50),    // rank 1
		];
		// liveTokens = 3000, budget = 2500 → need to fold ~500 tokens
		const view = makeView(blocks, 2_500, 3_000);
		const result = new AutopilotConductor().conduct(view);

		expect(result).toHaveLength(1);
		expect(result[0].kind).toBe("fold");
		const foldIds = (result[0] as { kind: "fold"; ids: string[] }).ids;
		// tool_result has the lowest rank → must be in the fold set first
		expect(foldIds[0]).toBe("m1:r");
	});
});

// ── 4. Folds recent (last) blocks — no self-imposed tail ────────────────────

describe("AutopilotConductor — folds recent blocks (tail-size lock)", () => {
	it("folds the last (most recent) block when it is the only foldable candidate", () => {
		// Simulate the real scenario under tail-size lock:
		//   protectedFromIndex = blocks.length → all blocks have protected: false.
		// Only the last block is foldable (older ones are held / already folded).
		const blocks = [
			vb("m0:p0", "text", 0, 500, 50, { held: true }),   // held → skip
			vb("m1:p0", "text", 1, 500, 50, { held: true }),   // held → skip
			vb("m2:p0", "text", 2, 2000, 50),                  // foldable, most recent
		];
		// liveTokens = 3000, budget = 1500 → must fold the last block
		const view = makeView(blocks, 1_500, 3_000);
		const result = new AutopilotConductor().conduct(view);

		expect(result).toHaveLength(1);
		expect(result[0].kind).toBe("fold");
		const foldIds = (result[0] as { kind: "fold"; ids: string[] }).ids;
		expect(foldIds).toContain("m2:p0");
	});

	it("folds a mix of old and recent blocks when needed to reach budget", () => {
		// 5 blocks, all unprotected (tail-size lock scenario), budget tight
		const blocks = Array.from({ length: 5 }, (_, i) =>
			vb(`m${i}:p0`, "tool_result", i, 1000, 30),
		);
		// 5000 live, budget 2000 → need to fold at least 3
		const view = makeView(blocks, 2_000, 5_000);
		const result = new AutopilotConductor().conduct(view);

		expect(result).toHaveLength(1);
		expect(result[0].kind).toBe("fold");
		const foldIds = (result[0] as { kind: "fold"; ids: string[] }).ids;

		// Must include the most recent block (index 4) if needed
		let projected = view.liveTokens;
		for (const id of foldIds) {
			const b = blocks.find((x) => x.id === id)!;
			projected += b.foldedTokens - b.tokens;
		}
		expect(projected).toBeLessThanOrEqual(view.budget);
		// Greedy fold from oldest→ newest; with 5 identical blocks we need 3.
		expect(foldIds.length).toBeGreaterThanOrEqual(3);
	});
});

// ── 5. Respects held / grouped blocks ────────────────────────────────────────

describe("AutopilotConductor — respects held and grouped blocks", () => {
	it("never folds a held block", () => {
		const blocks = [
			vb("m0:p0", "text", 0, 3000, 50, { held: true }),  // held → must not fold
			vb("m1:p0", "text", 1, 3000, 50),                  // foldable
		];
		const view = makeView(blocks, 4_000, 6_000);
		const result = new AutopilotConductor().conduct(view);

		expect(result).toHaveLength(1);
		const foldIds = (result[0] as { kind: "fold"; ids: string[] }).ids;
		expect(foldIds).not.toContain("m0:p0");
		expect(foldIds).toContain("m1:p0");
	});

	it("never folds a grouped block", () => {
		const blocks = [
			vb("m0:p0", "text", 0, 3000, 50, { grouped: true }), // grouped → skip
			vb("m1:p0", "text", 1, 3000, 50),                    // foldable
		];
		const view = makeView(blocks, 4_000, 6_000);
		const result = new AutopilotConductor().conduct(view);

		const foldIds = (result[0] as { kind: "fold"; ids: string[] }).ids;
		expect(foldIds).not.toContain("m0:p0");
	});

	it("returns [] when every block is held", () => {
		const blocks = [
			vb("m0:p0", "text", 0, 5000, 50, { held: true }),
			vb("m1:p0", "text", 1, 5000, 50, { held: true }),
		];
		const view = makeView(blocks, 1_000, 10_000);
		const result = new AutopilotConductor().conduct(view);
		expect(result).toEqual([]);
	});
});
