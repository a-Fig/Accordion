import { describe, it, expect } from "vitest";
import { estTokens, clip, firstLine, BLOCK_OVERHEAD } from "./tokens";

// tokens.ts is the engine's single (deliberately crude) token model: ~4 chars per
// token plus a flat per-block overhead. Everything downstream — budget bar, fold
// boundary, digest accounting — reads these numbers, so we pin the exact arithmetic.

describe("estTokens", () => {
	it("returns 0 for the empty string", () => {
		expect(estTokens("")).toBe(0);
	});

	it("estimates ceil(length / 4)", () => {
		expect(estTokens("abcd")).toBe(1); // exactly one 4-char token
		expect(estTokens("abcde")).toBe(2); // 5 chars rounds UP, never down
		expect(estTokens("x".repeat(400))).toBe(100);
		expect(estTokens("x".repeat(401))).toBe(101);
	});

	it("counts raw characters, not words (whitespace costs too)", () => {
		expect(estTokens("        ")).toBe(2); // 8 spaces / 4
	});
});

describe("BLOCK_OVERHEAD", () => {
	it("is the flat 4-token per-block structural cost", () => {
		expect(BLOCK_OVERHEAD).toBe(4);
	});
});

describe("clip", () => {
	it("collapses all internal whitespace runs (incl. newlines/tabs) to single spaces and trims", () => {
		expect(clip("  a   b\n\tc  ", 100)).toBe("a b c");
	});

	it("returns the normalized string untouched when it fits within n", () => {
		expect(clip("hello", 5)).toBe("hello"); // length === n → no ellipsis
	});

	it("clips to at most n chars, ending in a single ellipsis", () => {
		const out = clip("abcdefghij", 6);
		expect(out).toBe("abcde…"); // slice(0, n-1) + "…"
		expect(out.length).toBe(6);
	});

	it("trims trailing whitespace before appending the ellipsis (no 'word …')", () => {
		expect(clip("abcd efgh", 6)).toBe("abcd…"); // 5th char is a space → trimmed off
	});

	it("guards n = 0 (and n = 1) to a floor of 1, yielding a lone ellipsis for long input", () => {
		expect(clip("hello", 0)).toBe("…");
		expect(clip("hello", 1)).toBe("…");
		expect(clip("h", 0)).toBe("h"); // 1-char input fits the floored budget of 1
	});
});

describe("firstLine", () => {
	it("returns the first NON-BLANK line, trimmed", () => {
		expect(firstLine("\n   \n  hello world  \nsecond line")).toBe("hello world");
	});

	it("returns the empty string when every line is blank (or input is empty)", () => {
		expect(firstLine("")).toBe("");
		expect(firstLine("\n  \n\t\n")).toBe("");
	});

	it("clips the chosen line to the given max length with an ellipsis", () => {
		const out = firstLine("abcdefghijklmnop\nrest", 10);
		expect(out).toBe("abcdefghi…");
		expect(out.length).toBe(10);
	});

	it("defaults the max length to 100", () => {
		const long = "z".repeat(150);
		const out = firstLine(long);
		expect(out.length).toBe(100);
		expect(out.endsWith("…")).toBe(true);
		// and a 100-char line passes through whole
		expect(firstLine("y".repeat(100))).toBe("y".repeat(100));
	});
});
