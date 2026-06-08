import { describe, it, expect } from "vitest";
import { nextVacated } from "./drain";

describe("nextVacated — drain-without-reflow bookkeeping", () => {
	it("holds a hole for each block that leaves the protected tail", () => {
		// cols=10, one block departs (boundary 5→6): one leading hole, no reflow.
		expect(nextVacated(0, 5, 6, 10, 10)).toBe(1);
		// a second departure: two holes.
		expect(nextVacated(1, 6, 7, 10, 10)).toBe(2);
	});

	it("does nothing when the boundary is unchanged", () => {
		expect(nextVacated(3, 7, 7, 10, 10)).toBe(3);
		expect(nextVacated(0, 7, 7, 10, 10)).toBe(0);
	});

	it("reclaims a full leading row in one step (tiles move once per row)", () => {
		// 9 holes already; the 10th departure completes the row → collapse to 0.
		expect(nextVacated(9, 100, 101, 10, 10)).toBe(0);
	});

	it("handles a multi-block jump that crosses a row boundary", () => {
		// 8 holes + 5 departures = 13 → reclaim one row of 10 → 3 holes remain.
		expect(nextVacated(8, 50, 55, 10, 10)).toBe(3);
	});

	it("reclaims multiple rows when the jump is large", () => {
		// 5 holes + 25 departures = 30 → three rows of 10 reclaimed → 0.
		expect(nextVacated(5, 0, 25, 10, 10)).toBe(0);
		// 5 + 27 = 32 → reclaim 30 → 2 remain.
		expect(nextVacated(5, 0, 27, 10, 10)).toBe(2);
	});

	it("drops every hole on resize (cols change) — the grid re-flows anyway", () => {
		expect(nextVacated(7, 40, 41, 10, 12)).toBe(0);
		expect(nextVacated(7, 40, 40, 10, 12)).toBe(0);
		// even a shrink resets
		expect(nextVacated(3, 40, 45, 12, 8)).toBe(0);
	});

	it("refills leading holes one-for-one when the tail widens (no reflow)", () => {
		// Layout model: the protected grid renders `vacated` leading placeholder cells,
		// THEN the protected tiles in conversation order (oldest protected block first).
		// Holes live at the FRONT/oldest end; a returning block (boundary decreases) also
		// re-enters at the FRONT/oldest end — so it must consume an existing hole, leaving
		// `prevVacated + drained` holes (drained < 0). Anything else slides the surviving
		// protected tiles → the reflow drain.ts exists to prevent.
		//
		// Sequence: cols=10, start with 4 accumulated holes from departures (boundary 24),
		// then the tail widens by 2 (boundary 24→22, two blocks return). The two returners
		// fill two of the four holes → 2 holes should remain, NOT 0.
		expect(nextVacated(4, 24, 22, 10, 10)).toBe(2);
		// Widening by exactly the hole count consumes them all → 0 (floored, never negative).
		expect(nextVacated(4, 24, 20, 10, 10)).toBe(0);
		// Widening past the hole count cannot go negative → clamp at 0.
		expect(nextVacated(4, 24, 18, 10, 10)).toBe(0);
		// No holes outstanding, tail widens → still 0.
		expect(nextVacated(0, 24, 22, 10, 10)).toBe(0);
	});

	it("never loops or returns negative when cols is zero", () => {
		// degenerate pre-layout state: cols=0, a departure — must terminate.
		expect(nextVacated(0, 5, 6, 0, 0)).toBe(1);
	});

	it("forceReset drops every hole regardless of the boundary delta", () => {
		// Session swap: boundary jumps from a small session to a large one with the
		// SAME cols — without forceReset this would spray (950-3) mod 40 = 27 holes.
		expect(nextVacated(0, 3, 950, 40, 40, true)).toBe(0);
		// Protect-slider drag: boundary jumps up by many in one tick — clean reflow.
		expect(nextVacated(6, 800, 850, 40, 40, true)).toBe(0);
		// forceReset wins even when cols is unchanged and there are existing holes.
		expect(nextVacated(15, 100, 101, 40, 40, true)).toBe(0);
	});

	it("without forceReset, an unguarded boundary jump still accumulates (regression guard)", () => {
		// Confirms the bug the reset fixes: a big jump on the same cols would spray holes.
		expect(nextVacated(0, 3, 950, 40, 40, false)).toBe((950 - 3) % 40);
	});
});
