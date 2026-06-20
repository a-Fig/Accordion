/*
 * tokens.ts — crude, uniform token estimation.
 *
 * Bare-bones: ~4 chars per token. Good enough to drive the budget bar and the
 * fold boundary. A real per-model tokenizer is deferred (see VISION roadmap);
 * everything downstream reads from estTokens so swapping it is a one-line change.
 */

const CHARS_PER_TOKEN = 4;
/** Per-block structural overhead (role tags, delimiters). */
export const BLOCK_OVERHEAD = 4;

export function estTokens(s: string): number {
	if (!s) return 0;
	return Math.ceil(s.length / CHARS_PER_TOKEN);
}

export function clip(s: string, n: number): string {
	const m = Math.max(1, n);
	const t = s.replace(/\s+/g, " ").trim();
	return t.length <= m ? t : t.slice(0, m - 1).trimEnd() + "…";
}

export function firstLine(s: string, n = 100): string {
	const line = (s.split("\n").find((l) => l.trim()) ?? "").trim();
	return clip(line, n);
}
