/*
 * lexical.ts — extract identifiers from the protected tail and match them against
 * older folded blocks to detect relevance (the "pre-unfold" step of the Cold-score
 * conductor; ported from PR #19's C1 layer).
 *
 * The goal: if the agent is currently working with a file path, symbol, or quoted
 * string that appears in a folded older block, that block is probably relevant and
 * should be unfolded before the context is trimmed.
 *
 * Adapted to the conductor contract: matchBlocks operates on `ViewBlock` candidates and
 * reads `b.text` (full content; absent for wire-shape views — those blocks simply never
 * match). Pure, dependency-free, Node-safe — types only from `../contract`.
 */
import type { ViewBlock } from "../contract";

/**
 * Common code tokens that appear everywhere and carry no signal.
 * Deliberately small — false negatives (missing a stopword) are cheap; false
 * positives (treating a signal word as a stopword) are expensive.
 */
const STOPWORDS = new Set([
	"true", "false", "null", "undefined", "return", "const", "import", "export",
	"async", "await", "function", "string", "number", "boolean", "object", "array",
	"void", "never", "type", "interface", "class", "extends", "implements",
	"this", "self", "super", "new", "throw", "catch", "error", "from", "with",
]);

/** Minimum identifier length to care about (single-char and two-char tokens are noise). */
const MIN_SYMBOL_LEN = 4;

/** Quoted string length limits: ignore very short strings (likely punctuation) and huge ones. */
const QUOTED_MIN = 3;
const QUOTED_MAX = 80;

/** Maximum extracted identifiers (keep longest first to prefer specificity). */
const MAX_IDENTIFIERS = 200;

/**
 * Extract a set of identifiers from a tail text string.
 *
 * Targets:
 *   1. File paths — tokens containing a path separator or looking like `foo/bar.ts`,
 *      `./src/file.ts`, `C:\Users\foo\bar`, `@scope/package`, etc.
 *   2. Snake_case, camelCase, PascalCase, SCREAMING_CASE symbols — ≥4 chars and
 *      contains at least one internal capital letter, underscore, dot, slash, or digit
 *      (plain lowercase English words like "with" are excluded to avoid noise).
 *   3. Quoted strings (double, single, backtick) of 3–80 chars — store the inner text.
 *
 * Stopwords are excluded. Result is capped at MAX_IDENTIFIERS, keeping longest first.
 */
export function extractIdentifiers(tailText: string): Set<string> {
	const candidates = new Map<string, number>(); // value → length (for sorting)

	// ── 1. Quoted strings (backtick, double-quote, single-quote) ────────────────
	// Backtick-quoted: `foo/bar.ts`, `SomeSymbol`, etc.
	// Double/single-quoted: "foo/bar.ts", 'foo/bar.ts'
	// We handle them separately to avoid catastrophic backtracking on unterminated quotes.
	const quotedRe = /`([^`]{3,80})`|"([^"\n]{3,80})"|'([^'\n]{3,80})'/g;
	let m: RegExpExecArray | null;
	while ((m = quotedRe.exec(tailText)) !== null) {
		const inner = (m[1] ?? m[2] ?? m[3]).trim();
		if (inner.length >= QUOTED_MIN && inner.length <= QUOTED_MAX && !STOPWORDS.has(inner.toLowerCase())) {
			candidates.set(inner, inner.length);
		}
	}

	// ── 2. File paths ─────────────────────────────────────────────────────────
	// Match tokens that look like paths: contain / or \ or start with ./ or ../
	// Also match Windows absolute paths: C:\... or D:/...
	// Also match @scope/package patterns.
	// Strip leading/trailing punctuation like ( ) , ; : " ' ` [ ]
	const pathRe = /(?:[A-Za-z]:[\\/]|\.\.?[\\/]|[\\/])?[\w@.-]+(?:[\\/][\w.@-]+)+/g;
	while ((m = pathRe.exec(tailText)) !== null) {
		const raw = m[0].replace(/^[^\w@./\\A-Z]+|[^)\w/\\]+$/g, "").replace(/[.,;:'"`)]+$/, "");
		if (raw.length >= QUOTED_MIN && !STOPWORDS.has(raw.toLowerCase())) {
			candidates.set(raw, raw.length);
		}
	}

	// ── 3. Code identifiers (camelCase, snake_case, PascalCase, SCREAMING_CASE) ─
	// Must be ≥4 chars and contain at least one internal capital, underscore, or digit
	// (after the first char) to exclude plain lowercase words.
	// Pattern: word characters, at least MIN_SYMBOL_LEN chars, with a qualifying internal char.
	const symbolRe = /\b[A-Za-z_$][\w$]{3,}\b/g;
	while ((m = symbolRe.exec(tailText)) !== null) {
		const tok = m[0];
		if (tok.length < MIN_SYMBOL_LEN) continue;
		if (STOPWORDS.has(tok.toLowerCase())) continue;
		// Qualify: must have an internal capital, underscore, or digit (not just lowercase)
		// "internal" = any char except the first
		const rest = tok.slice(1);
		if (!/[A-Z_$0-9]/.test(rest)) continue; // plain lowercase word → skip
		candidates.set(tok, tok.length);
	}

	// ── Trim to MAX_IDENTIFIERS, preferring longest (most specific) ─────────────
	const sorted = [...candidates.entries()].sort((a, b) => b[1] - a[1]);
	return new Set(sorted.slice(0, MAX_IDENTIFIERS).map(([k]) => k));
}

/**
 * Match extracted identifiers against a list of candidate blocks.
 *
 * Returns a Map from block.id → first matching identifier (case-sensitive substring
 * match against b.text). A candidate without `text` (wire-shape view) never matches.
 *
 * RARITY GUARD: an identifier that matches more than max(3, 25% of candidates) is
 * dropped before assignment (it's a common token, not a specific signal).
 */
export function matchBlocks(ids: Set<string>, candidates: ViewBlock[]): Map<string, string> {
	if (!ids.size || !candidates.length) return new Map();
	const threshold = Math.max(3, Math.floor(candidates.length * 0.25));

	// Build match map: identifier → set of matching block ids
	const idToBlocks = new Map<string, string[]>();
	for (const id of ids) {
		const matched: string[] = [];
		for (const b of candidates) {
			if (b.text !== undefined && b.text.includes(id)) {
				matched.push(b.id);
			}
		}
		if (matched.length > 0 && matched.length <= threshold) {
			idToBlocks.set(id, matched);
		}
	}

	// Assign: block id → FIRST matching identifier (by insertion order = longest-first from extractIdentifiers)
	const result = new Map<string, string>();
	for (const [identifier, blockIds] of idToBlocks) {
		for (const bid of blockIds) {
			if (!result.has(bid)) {
				result.set(bid, identifier);
			}
		}
	}
	return result;
}
