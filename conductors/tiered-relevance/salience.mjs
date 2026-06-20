// salience.mjs — shared text utilities + structured salience extraction.
//
// Ported (faithfully, JS/ESM) from the_conductor/src/conductor.ts. These are the pure,
// dependency-free building blocks the digest/trim modules and the deterministic task-summary
// fallback share. No I/O, no model calls — string in, string/number out.
//
// "Salience" = the dormant-but-critical markers (commands, exact values, errors, decisions,
// file paths) that get near-zero attention yet are essential at generation time. We extract
// them deterministically so a folded block's digest can still carry them, and so the unfold
// path can give risk-bearing blocks a lower relevance floor.

import { createHash } from "node:crypto";

export const CHARS_PER_TOKEN = 4;
export const BLOCK_OVERHEAD = 4;

/** Lower rank = lower durable value = folded sooner. Used only as a fallback ordering when
 *  a semantic relevance score is unavailable (mirrors the built-in's FOLD_RANK). */
export const FOLD_RANK = { tool_result: 0, thinking: 1, text: 2, tool_call: 3, user: 4 };

/** Kinds that may be folded to a digest. tool_call / user are never folded to a digest;
 *  a tool_call only ever moves as part of its atomic pair. */
export const FOLDABLE_KINDS = new Set(["text", "thinking", "tool_result"]);

export const STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have",
	"i", "in", "is", "it", "me", "of", "on", "or", "our", "that", "the", "this", "to",
	"we", "with", "you", "your",
]);

export function estTokens(s) {
	if (!s) return 0;
	return Math.ceil(s.length / CHARS_PER_TOKEN);
}

export function tokensOf(s) {
	return estTokens(s) + BLOCK_OVERHEAD;
}

/** Short stable hash of normalized text — cache key for embeddings + summaries. */
export function textHash(text) {
	return createHash("sha256").update((text || "").replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

export function clip(s, n) {
	const m = Math.max(1, n);
	const t = (s || "").replace(/\s+/g, " ").trim();
	return t.length <= m ? t : t.slice(0, m - 3).trimEnd() + "...";
}

export function firstLine(s, n = 100) {
	const line = ((s || "").split("\n").find((l) => l.trim()) ?? "").trim();
	return clip(line, n);
}

export function decisionSentence(text, maxChars = 180) {
	const sentences = (text || "")
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	const selected = sentences.find((sentence) =>
		/\b(?:actual|belongs to|blamed|came from|command we kept|decision|decided|exact command|favou?rite|favou?red|final|liked|preferred|selected|chosen|wanted|we chose|we will)\b/i.test(sentence),
	);
	return selected ? clip(selected, maxChars) : "";
}

export function salienceTokens(text, maxItems = 5, maxChars = 120) {
	const seen = new Set();
	const result = [];
	let totalChars = 0;
	const add = (s) => {
		const t = (s || "").trim();
		if (!t || seen.has(t) || result.length >= maxItems || totalChars + t.length > maxChars) return;
		seen.add(t); result.push(t); totalChars += t.length;
	};
	for (const m of text.matchAll(/[A-Z]{2,}(?:-[A-Z0-9]+)+/g)) add(m[0]);
	for (const m of text.matchAll(/\b(\w[\w.-]*)[ \t]*[:=][ \t]*(\S+)/g)) {
		const key = m[1], val = m[2];
		if (!STOPWORDS.has(key.toLowerCase()) && val.length > 2) add(`${key}=${val}`);
	}
	for (const m of text.matchAll(/\b[\w.-]+\.\w{1,6}\b/g)) add(m[0]);
	for (const m of text.matchAll(/\bv?\d+\.\d+[\d.]*\b|\b0x[0-9a-fA-F]+\b/g)) add(m[0]);
	for (const m of text.matchAll(/\b(?:error|exception|failed|panic)[: ]+\S+/gi)) add(m[0].slice(0, 30));
	for (const m of text.matchAll(/\b(?:DELETE|GET|PATCH|POST|PUT)\s+\/[A-Za-z0-9_./:*-]+/g)) add(m[0]);
	for (const m of text.matchAll(/\b(?:bun|cargo|deno|docker|gh|git|go|kubectl|make|node|npm|npx|pnpm|pytest|python3?|uv|yarn)\b[^\n.!?;]*/g)) add(m[0]);
	return result.join(" · ");
}

/** Categorize text into salience buckets for structured digest suffixes. */
export function categorizeSalienceMarkers(text) {
	const result = { paths: [], commands: [], errors: [], exact_values: [], decisions: [] };
	const seen = new Set();
	const add = (bucket, val) => {
		const t = (val || "").trim().slice(0, 80);
		if (!t || seen.has(t) || bucket.length >= 3) return;
		seen.add(t); bucket.push(t);
	};
	for (const m of text.matchAll(/\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|svelte|rs|py|go|java|rb|yml|yaml|toml|sh|env|log|conf|cfg|txt|sql|proto|lock)\b/g)) add(result.paths, m[0]);
	for (const m of text.matchAll(/(?:^|\s)((?:\.{1,2}|src|lib|app|dist|build|test|scripts?)\/[\w./-]+)/gm)) add(result.paths, m[1]);
	for (const m of text.matchAll(/^\s*\$\s+(.+)/gm)) add(result.commands, m[1].slice(0, 80));
	for (const m of text.matchAll(/\b(?:npm|npx|pnpm|yarn|bun|node|git|docker|kubectl|make|cargo|go|python3?|pytest|deno|uv|gh)\s+\S[^\n.!?;]{0,60}/g)) add(result.commands, m[0].trim());
	for (const m of text.matchAll(/\b(?:Error|FAIL|FAILED|error|exception|panic|ENOENT|ECONNREFUSED)[: ]+[^\n]{0,60}/g)) add(result.errors, m[0].slice(0, 60));
	if (/\s+at\s+\S+\s*\(/.test(text)) add(result.errors, "stack trace");
	for (const m of text.matchAll(/\b(\w[\w.-]*)[ \t]*[:=][ \t]*(\S+)/g)) {
		const key = m[1], val = m[2];
		if (!STOPWORDS.has(key.toLowerCase()) && val.length > 2 && val.length < 60) add(result.exact_values, `${key}=${val}`);
	}
	for (const m of text.matchAll(/[^.!?\n]{0,200}\b(?:decided|chose|standardized on|going with|will use|selected|picked)\b[^.!?\n]{0,200}/gi)) {
		add(result.decisions, m[0].trim().slice(0, 80));
	}
	return result;
}

export function buildSalienceSuffix(text) {
	const cats = categorizeSalienceMarkers(text);
	const parts = [];
	if (cats.paths.length) parts.push(`paths: ${cats.paths.slice(0, 3).join(", ")}`);
	if (cats.commands.length) parts.push(`commands: ${cats.commands.slice(0, 2).join(", ")}`);
	if (cats.errors.length) parts.push(`errors: ${cats.errors.slice(0, 2).join(", ")}`);
	if (cats.exact_values.length) parts.push(`exact_values: ${cats.exact_values.slice(0, 3).join(", ")}`);
	if (cats.decisions.length) parts.push(`decisions: ${cats.decisions.slice(0, 1).join(", ")}`);
	if (!parts.length) return "";
	return ` ⟦${parts.join(" ∣ ")}⟧`;
}

/** The risk category names present in a digest's salience suffix (commands/paths/exact_values/decisions). */
export function parseRiskFlags(digestText) {
	const match = (digestText || "").match(/⟦([^⟧]+)⟧\s*$/);
	if (!match) return [];
	const suffix = match[1];
	if (/^(?:group|trim)\b/.test(suffix.trim())) return [];
	const riskCategories = ["commands", "paths", "exact_values", "decisions"];
	return riskCategories.filter((cat) => suffix.includes(`${cat}:`));
}

export function tokenizeForRelevance(text) {
	const matches = (text || "").toLowerCase().match(/[a-z0-9]+(?:[._:/\\-][a-z0-9]+)*/g) ?? [];
	return matches.filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** Normalized prompt-token overlap — the keyword relevance fallback when embeddings miss. */
export function keywordOverlap(blockText, prompt) {
	const promptTokens = new Set(tokenizeForRelevance(prompt));
	if (promptTokens.size === 0) return 0;
	const blockTokens = new Set(tokenizeForRelevance(blockText));
	let shared = 0;
	for (const token of promptTokens) if (blockTokens.has(token)) shared++;
	return shared / promptTokens.size;
}
