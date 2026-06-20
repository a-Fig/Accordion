/*
 * coldscore.lexical.test.ts — unit tests for identifier extraction and block matching.
 *
 * Adapted from PR #19's lexical.test.ts to operate on ViewBlock instead of engine Block.
 * The block matching logic reads b.text, which ViewBlock carries as an optional field.
 *
 * Covers: paths, symbols, quoted strings, stopwords, 200-cap (longest-first), rarity
 * guard, punctuation stripping, and absence of text on a ViewBlock.
 */
import { describe, it, expect } from "vitest";
import { extractIdentifiers, matchBlocks } from "$conductors/cold-score/lexical";
import type { ViewBlock } from "$conductors/contract";

function makeViewBlock(id: string, text: string | undefined): ViewBlock {
	return {
		id,
		kind: "text",
		turn: 1,
		order: 0,
		tokens: 100,
		foldedTokens: 10,
		held: false,
		folded: false,
		protected: false,
		grouped: false,
		text,
	};
}

// ── extractIdentifiers — file paths ─────────────────────────────────────────

describe("extractIdentifiers — file paths", () => {
	it("extracts unix file paths", () => {
		const ids = extractIdentifiers("edited app/src/lib/engine/store.ts today");
		expect(ids.has("app/src/lib/engine/store.ts")).toBe(true);
	});

	it("extracts relative paths with ./ prefix", () => {
		const ids = extractIdentifiers("import foo from ./components/Button.svelte");
		expect(ids.has("./components/Button.svelte")).toBe(true);
	});

	it("extracts paths with @scope/package format", () => {
		const ids = extractIdentifiers("installed @anthropic-ai/sdk/core");
		expect(ids.has("@anthropic-ai/sdk/core")).toBe(true);
	});

	it("strips trailing punctuation from paths", () => {
		const ids = extractIdentifiers("see app/src/engine/score.ts, and also foo/bar.ts.");
		expect(ids.has("app/src/engine/score.ts")).toBe(true);
		expect(ids.has("foo/bar.ts")).toBe(true);
	});

	it("extracts Windows-style backslash paths", () => {
		const ids = extractIdentifiers("file at app\\src\\lib\\store.ts is broken");
		const found = [...ids].some((id) => id.includes("store.ts"));
		expect(found).toBe(true);
	});
});

// ── extractIdentifiers — code symbols ───────────────────────────────────────

describe("extractIdentifiers — code symbols", () => {
	it("extracts camelCase identifiers", () => {
		const ids = extractIdentifiers("calling parseBlocks and buildContext functions");
		expect(ids.has("parseBlocks")).toBe(true);
		expect(ids.has("buildContext")).toBe(true);
	});

	it("extracts PascalCase identifiers", () => {
		const ids = extractIdentifiers("class AccordionStore extends BaseStore");
		expect(ids.has("AccordionStore")).toBe(true);
		expect(ids.has("BaseStore")).toBe(true);
	});

	it("extracts SCREAMING_CASE identifiers", () => {
		const ids = extractIdentifiers("FOLD_RANK and PROTECT_OVERFLOW_CAP constants");
		expect(ids.has("FOLD_RANK")).toBe(true);
		expect(ids.has("PROTECT_OVERFLOW_CAP")).toBe(true);
	});

	it("extracts snake_case identifiers", () => {
		const ids = extractIdentifiers("the fold_rank and cold_score functions");
		expect(ids.has("fold_rank")).toBe(true);
		expect(ids.has("cold_score")).toBe(true);
	});

	it("does NOT extract plain lowercase words", () => {
		const ids = extractIdentifiers("the quick brown foxes are jumping over lazy dogs today");
		expect(ids.has("quick")).toBe(false);
		expect(ids.has("brown")).toBe(false);
		expect(ids.has("jumping")).toBe(false);
	});

	it("does NOT extract short tokens under 4 chars", () => {
		const ids = extractIdentifiers("var foo = bar in baz");
		expect(ids.has("foo")).toBe(false);
		expect(ids.has("bar")).toBe(false);
		expect(ids.has("baz")).toBe(false);
	});

	it("extracts identifiers with digits", () => {
		const ids = extractIdentifiers("variable block2Items and step3Result");
		expect(ids.has("block2Items")).toBe(true);
		expect(ids.has("step3Result")).toBe(true);
	});
});

// ── extractIdentifiers — quoted strings ─────────────────────────────────────

describe("extractIdentifiers — quoted strings", () => {
	it("extracts double-quoted strings", () => {
		const ids = extractIdentifiers('the "sample-session.jsonl" file');
		expect(ids.has("sample-session.jsonl")).toBe(true);
	});

	it("extracts single-quoted strings", () => {
		const ids = extractIdentifiers("the 'accordion-context-folding' skill");
		expect(ids.has("accordion-context-folding")).toBe(true);
	});

	it("extracts backtick-quoted strings", () => {
		const ids = extractIdentifiers("call `store.refold()` to refresh");
		expect(ids.has("store.refold()")).toBe(true);
	});

	it("ignores very short quoted strings (under 3 chars)", () => {
		const ids = extractIdentifiers('the "ab" token');
		expect(ids.has("ab")).toBe(false);
	});

	it("ignores very long quoted strings (over 80 chars)", () => {
		const longStr = "a".repeat(81);
		const ids = extractIdentifiers(`the "${longStr}" string`);
		expect(ids.has(longStr)).toBe(false);
	});
});

// ── extractIdentifiers — stopwords ──────────────────────────────────────────

describe("extractIdentifiers — stopwords", () => {
	it("excludes common code stopwords", () => {
		const ids = extractIdentifiers("return await async function import export const true false null undefined");
		for (const word of ["return", "await", "async", "function", "import", "export", "const", "true", "false", "null", "undefined"]) {
			expect(ids.has(word)).toBe(false);
		}
	});

	it("still extracts identifiers that merely START with a stopword prefix", () => {
		const ids = extractIdentifiers("returnValue and asyncHandler functions");
		expect(ids.has("returnValue")).toBe(true);
		expect(ids.has("asyncHandler")).toBe(true);
	});
});

// ── extractIdentifiers — 200-cap, longest-first ────────────────────────────

describe("extractIdentifiers — cap at 200, longest-first", () => {
	it("returns at most 200 identifiers even with a huge input", () => {
		const symbols = Array.from({ length: 500 }, (_, i) => `mySymbol${i}`).join(" ");
		const ids = extractIdentifiers(symbols);
		expect(ids.size).toBeLessThanOrEqual(200);
	});

	it("keeps the longest identifiers first when truncating", () => {
		// Mix short (~6 chars) and long (~35 chars) symbols; all have internal digit/cap
		const short = Array.from({ length: 100 }, (_, i) => `aB${i}xY`).join(" ");
		const long = Array.from({ length: 150 }, (_, i) => `averylongIdentifier${i}WithManyChars`).join(" ");
		const ids = extractIdentifiers(short + " " + long);
		const hasLong = [...ids].some((id) => id.startsWith("averylongIdentifier"));
		expect(hasLong).toBe(true);
	});
});

// ── matchBlocks — basic matching ────────────────────────────────────────────

describe("matchBlocks — basic matching", () => {
	it("matches a block containing the identifier", () => {
		const blocks = [
			makeViewBlock("b1", "fixed the bug in app/src/engine/score.ts"),
			makeViewBlock("b2", "unrelated text about something else"),
		];
		const ids = new Set(["app/src/engine/score.ts"]);
		const result = matchBlocks(ids, blocks);
		expect(result.get("b1")).toBe("app/src/engine/score.ts");
		expect(result.has("b2")).toBe(false);
	});

	it("does not match when identifier is absent from block text", () => {
		const blocks = [makeViewBlock("b1", "no relevant content here at all")];
		const ids = new Set(["AccordionStore"]);
		const result = matchBlocks(ids, blocks);
		expect(result.size).toBe(0);
	});

	it("blocks without text (undefined) never match", () => {
		// ViewBlock.text is optional — undefined means no content to match against
		const blocks = [makeViewBlock("b1", undefined)];
		const ids = new Set(["AccordionStore"]);
		const result = matchBlocks(ids, blocks);
		expect(result.size).toBe(0);
	});

	it("empty ids set returns empty map", () => {
		const blocks = [makeViewBlock("b1", "AccordionStore content")];
		const result = matchBlocks(new Set(), blocks);
		expect(result.size).toBe(0);
	});

	it("empty candidates returns empty map", () => {
		const ids = new Set(["AccordionStore"]);
		const result = matchBlocks(ids, []);
		expect(result.size).toBe(0);
	});
});

// ── matchBlocks — rarity guard ───────────────────────────────────────────────

describe("matchBlocks — rarity guard", () => {
	it("drops identifiers that match more than 25% of candidates (above floor of 3)", () => {
		// 10 blocks, all containing "myVar" → 10 matches > max(3, 10*0.25=2.5)=3 → dropped
		const blocks = Array.from({ length: 10 }, (_, i) =>
			makeViewBlock(`b${i}`, `the variable myVar is used here block${i}`),
		);
		const ids = new Set(["myVar"]);
		const result = matchBlocks(ids, blocks);
		expect(result.size).toBe(0);
	});

	it("keeps identifiers that match at most 25% of candidates", () => {
		// 12 blocks, only 2 contain the identifier → 2 <= max(3, 12*0.25=3) = 3 → kept
		const blocks = [
			makeViewBlock("match1", "AccordionStore is the main class"),
			makeViewBlock("match2", "new AccordionStore() is created"),
			...Array.from({ length: 10 }, (_, i) => makeViewBlock(`other${i}`, `block ${i} about something else`)),
		];
		const ids = new Set(["AccordionStore"]);
		const result = matchBlocks(ids, blocks);
		expect(result.size).toBe(2);
		expect(result.has("match1")).toBe(true);
		expect(result.has("match2")).toBe(true);
	});

	it("respects the hard floor of 3 for the rarity threshold", () => {
		// 4 blocks, 3 match → threshold = max(3, floor(4*0.25)=1) = 3 → exactly at threshold → KEPT
		const blocks = [
			makeViewBlock("m1", "parseBlocks function called"),
			makeViewBlock("m2", "parseBlocks returned value"),
			makeViewBlock("m3", "parseBlocks error occurred"),
			makeViewBlock("m4", "unrelated content here"),
		];
		const ids = new Set(["parseBlocks"]);
		const result = matchBlocks(ids, blocks);
		expect(result.size).toBe(3);
	});
});

// ── matchBlocks — first-match priority ──────────────────────────────────────

describe("matchBlocks — first-match priority", () => {
	it("assigns each block the first matching identifier (insertion order from extractIdentifiers)", () => {
		const block = makeViewBlock("b1", "see app/src/lib/engine/store.svelte.ts for AccordionStore");
		// Both identifiers match; block gets exactly one entry
		const ids = new Set(["app/src/lib/engine/store.svelte.ts", "AccordionStore"]);
		const result = matchBlocks(ids, [block]);
		expect(result.has("b1")).toBe(true);
		expect(result.size).toBe(1);
	});

	it("each block id appears at most once in the result", () => {
		const block = makeViewBlock("b1", "parseBlocks and buildContext both here");
		const ids = new Set(["parseBlocks", "buildContext"]);
		const result = matchBlocks(ids, [block]);
		// b1 appears once only — first matching id wins
		let count = 0;
		for (const [bid] of result) if (bid === "b1") count++;
		expect(count).toBe(1);
	});
});
