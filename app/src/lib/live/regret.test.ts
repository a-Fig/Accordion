import { describe, expect, it } from "vitest";
import { parseRegret, reachBackCalls, regretTooltip } from "./regret";

const counts = { unfoldCalls: 2, unfoldBlocks: 3, recallCalls: 1, recallBlocks: 1, missingCodes: 4, byKind: { tool_result: 3, text: 1 } };
const body = (over: Record<string, unknown> = {}) => ({
	sessionId: "s1",
	regret: { foldedBlocks: 9, byConductor: { thermocline: counts, none: { ...counts, unfoldCalls: 0 } } },
	...over,
});

describe("parseRegret", () => {
	it("parses a well-formed body for the connected session", () => {
		const r = parseRegret(body(), "s1");
		expect(r?.foldedBlocks).toBe(9);
		expect(r?.byConductor.thermocline).toEqual(counts);
	});

	it("rejects a body from a different session (relative fetch hit another origin)", () => {
		expect(parseRegret(body(), "s2")).toBeNull();
	});

	it("rejects when not connected", () => {
		expect(parseRegret(body(), null)).toBeNull();
	});

	it("returns null for an older extension with no regret field", () => {
		expect(parseRegret({ sessionId: "s1" }, "s1")).toBeNull();
	});

	it("returns null for malformed shapes", () => {
		expect(parseRegret(null, "s1")).toBeNull();
		expect(parseRegret("x", "s1")).toBeNull();
		expect(parseRegret({ sessionId: "s1", regret: { foldedBlocks: 1 } }, "s1")).toBeNull();
		expect(parseRegret({ sessionId: "s1", regret: { foldedBlocks: 1, byConductor: 7 } }, "s1")).toBeNull();
	});

	it("coerces bad numbers to 0 and skips non-object buckets", () => {
		const r = parseRegret({ sessionId: "s1", regret: { foldedBlocks: -3, byConductor: { a: { unfoldCalls: "x", byKind: { k: NaN } }, b: 5 } } }, "s1");
		expect(r?.foldedBlocks).toBe(0);
		expect(r?.byConductor.a.unfoldCalls).toBe(0);
		expect(r?.byConductor.a.byKind.k).toBe(0);
		expect(r?.byConductor.b).toBeUndefined();
	});
});

describe("reachBackCalls", () => {
	it("sums unfold + recall calls and ignores missing codes", () => {
		expect(reachBackCalls(counts)).toBe(3);
		expect(reachBackCalls(undefined)).toBe(0);
	});
});

describe("regretTooltip", () => {
	it("marks the active conductor and carries the caveats", () => {
		const r = parseRegret(body(), "s1")!;
		const t = regretTooltip(r, "thermocline");
		expect(t).toContain("▸ thermocline: 2 unfold · 1 recall · 4 missing/refused (text 1, tool_result 3)");
		expect(t).not.toContain("▸ none");
		expect(t).toContain("a gauge, not a rate denominator");
		expect(t).toContain("lock refusals");
	});

	it("treats a null active conductor as the 'none' bucket", () => {
		const r = parseRegret(body(), "s1")!;
		expect(regretTooltip(r, null)).toContain("▸ none:");
	});

	it("says so when nothing has been counted", () => {
		expect(regretTooltip({ foldedBlocks: 0, byConductor: {} }, null)).toContain("none yet this session");
	});
});
