// trim.mjs — Level-1 query-aware extractive trim (coarse-to-fine, à la LongLLMLingua).
//
// Ported from the_conductor/src/conductor.ts and decoupled from any embedding cache: the
// query-relevance term is supplied as an optional `relevanceFn(segmentText) -> number` in
// [0,1]. With no relevanceFn it degrades to a deterministic salience+position selection
// (used for query-independent SIZING via trimTokens). A block is segmented, each segment
// scored by relevance + intrinsic salience + serial position, and the highest selected under
// ~TRIM_TARGET_RATIO of the original; risk-bearing segments are kept unconditionally.

import { clip, tokensOf, categorizeSalienceMarkers } from "./salience.mjs";

export const TRIM_TARGET_RATIO = 0.25;
export const TRIM_MIN_TOKENS = 240;

export function segmentForTrim(text, maxSegments = 200) {
	const segments = [];
	for (const rawLine of (text || "").split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.length > 240 && /[.!?]\s/.test(line)) {
			for (const sentence of line.split(/(?<=[.!?])\s+/)) {
				const s = sentence.trim();
				if (s) segments.push(s);
				if (segments.length >= maxSegments) return segments;
			}
		} else {
			segments.push(line);
		}
		if (segments.length >= maxSegments) return segments;
	}
	return segments;
}

/** A segment is risk-bearing when it carries a dormant-but-critical marker; those are kept
 *  unconditionally. Returns {score: categories present /5, hasRisk}. */
function segmentSalience(seg) {
	const cats = categorizeSalienceMarkers(seg);
	const present = [cats.paths, cats.commands, cats.errors, cats.exact_values, cats.decisions]
		.filter((bucket) => bucket.length > 0).length;
	const hasRisk =
		cats.commands.length > 0 || cats.exact_values.length > 0 || cats.errors.length > 0 || cats.decisions.length > 0;
	return { score: present / 5, hasRisk };
}

export function trimmedText(block, relevanceFn) {
	const text = block.text || "";
	const budgetChars = Math.max(240, Math.floor(text.length * TRIM_TARGET_RATIO));
	const segments = segmentForTrim(text);
	const n = segments.length;
	if (n <= 4) return clip(text, budgetChars);

	const useQuery = typeof relevanceFn === "function";
	const scored = segments.map((seg, i) => {
		const rel = useQuery ? relevanceFn(seg) : 0;
		const { score: sal, hasRisk } = segmentSalience(seg);
		const pos = i < 2 || i >= n - 2 ? 1 : 0; // serial-position anchor head & tail
		const combined = (useQuery ? 0.5 * rel : 0) + 0.35 * sal + 0.15 * pos;
		return { seg, i, combined, hasRisk, len: seg.length };
	});

	const selected = new Set();
	let used = 0;
	const tryAdd = (item) => {
		if (selected.has(item.i)) return;
		if (selected.size > 0 && used + item.len + 1 > budgetChars) return;
		selected.add(item.i);
		used += item.len + 1;
	};
	for (const item of scored.filter((s) => s.hasRisk)) tryAdd(item);
	tryAdd(scored[0]);
	tryAdd(scored[n - 1]);
	for (const item of [...scored].sort((a, b) => b.combined - a.combined)) {
		if (used >= budgetChars) break;
		tryAdd(item);
	}

	const order = [...selected].sort((a, b) => a - b);
	const parts = [];
	let prev = -1;
	for (const i of order) {
		if (prev >= 0 && i > prev + 1) parts.push(`⟪… ${i - prev - 1} more …⟫`);
		parts.push(segments[i]);
		prev = i;
	}
	if (prev >= 0 && prev < n - 1) parts.push("⟪…⟫");
	const body = parts.join("\n");
	const capped = body.length > budgetChars ? body.slice(0, budgetChars - 3).trimEnd() + "..." : body;
	return `⟦trim t${block.turn}⟧ ${capped}`;
}

/** Query-independent sizing for the tier projection (stable across passes). */
export function trimTokens(block) {
	return tokensOf(trimmedText(block));
}

/** A block is worth trimming only if it is big enough and trim saves ≥50%. */
export function trimEligible(block) {
	return block.tokens >= TRIM_MIN_TOKENS && trimTokens(block) <= Math.floor(block.tokens * 0.5);
}
