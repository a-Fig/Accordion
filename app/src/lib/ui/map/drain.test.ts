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

	it("resyncs to no holes when the tail widens (boundary moves back)", () => {
		expect(nextVacated(4, 20, 15, 10, 10)).toBe(0);
	});

	it("never loops or returns negative when cols is zero", () => {
		// degenerate pre-layout state: cols=0, a departure — must terminate.
		expect(nextVacated(0, 5, 6, 0, 0)).toBe(1);
	});
});
