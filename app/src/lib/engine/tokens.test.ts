import { describe, it, expect } from "vitest";
import { estTokens, BLOCK_OVERHEAD, clip, firstLine, remainingPct, remainingBand } from "./tokens";

// ---------------------------------------------------------------------------
// remainingPct — how much of a fold's original content is still on the wire
// ---------------------------------------------------------------------------

describe("remainingPct", () => {
	it("returns the rounded whole-percent of tokens still live", () => {
		// 1000 full, 250 live -> 25%
		expect(remainingPct(1000, 250)).toBe(25);
	});

	it("rounds to the nearest whole percent", () => {
		// 1000 full, 333 live -> 33.3% -> 33%
		expect(remainingPct(1000, 333)).toBe(33);
		// 1000 full, 334 live -> 33.4% -> 33%
		expect(remainingPct(1000, 334)).toBe(33);
		// 1000 full, 336 live -> 33.6% -> 34%
		expect(remainingPct(1000, 336)).toBe(34);
	});

	it("returns 0 when everything was removed (drop group / empty digest)", () => {
		expect(remainingPct(500, 0)).toBe(0);
	});

	it("returns 100 when nothing was removed (live == full)", () => {
		expect(remainingPct(500, 500)).toBe(100);
	});

	it("returns 100 for a zero-token block (divide-by-zero guard)", () => {
		expect(remainingPct(0, 0)).toBe(100);
		expect(remainingPct(0, 5)).toBe(100);
	});

	it("clamps to 100 if live exceeds full (oversized substitution)", () => {
		// A conductor replacement larger than the original must never render as a
		// >100% remaining value; clamp to the documented [0, 100] range.
		expect(remainingPct(100, 150)).toBe(100);
		expect(remainingPct(100, 101)).toBe(100);
	});

	it("clamps to 0 (drop group / fully removed)", () => {
		expect(remainingPct(100, 0)).toBe(0);
		expect(remainingPct(100, -5)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// remainingBand — 6-band bucket (0-5) for the on-tile erosion border
// ---------------------------------------------------------------------------

describe("remainingBand", () => {
	it("bands >=90% as 5 (full)", () => {
		expect(remainingBand(100)).toBe(5);
		expect(remainingBand(90)).toBe(5);
	});

	it("bands 75-89% as 4", () => {
		expect(remainingBand(89)).toBe(4);
		expect(remainingBand(75)).toBe(4);
	});

	it("bands 50-74% as 3", () => {
		expect(remainingBand(74)).toBe(3);
		expect(remainingBand(50)).toBe(3);
	});

	it("bands 25-49% as 2", () => {
		expect(remainingBand(49)).toBe(2);
		expect(remainingBand(25)).toBe(2);
	});

	it("bands 10-24% as 1", () => {
		expect(remainingBand(24)).toBe(1);
		expect(remainingBand(10)).toBe(1);
	});

	it("bands <10% as 0 (empty — no border)", () => {
		expect(remainingBand(9)).toBe(0);
		expect(remainingBand(0)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// estTokens — smoke-check the existing exports still work (regression guard)
// ---------------------------------------------------------------------------

describe("estTokens (regression)", () => {
	it("estimates ~4 chars per token with overhead-aware ceil", () => {
		expect(estTokens("")).toBe(0);
		expect(estTokens("abcd")).toBe(1);
		expect(estTokens("abcde")).toBe(2); // ceil(5/4)
	});
	it("exports BLOCK_OVERHEAD", () => {
		expect(BLOCK_OVERHEAD).toBe(4);
	});
});

describe("clip / firstLine (regression)", () => {
	it("clip trims and ellipsizes", () => {
		expect(clip("hello world", 5)).toBe("hell…");
		expect(clip("hi", 5)).toBe("hi");
	});
	it("firstLine returns the first non-blank line, clipped", () => {
		expect(firstLine("\n\n  hello world\nsecond", 5)).toBe("hell…");
	});
});
