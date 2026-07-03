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


/**
 * Remaining percentage of a fold: the whole-percent of tokens STILL on the
 * wire (live / full x 100). Pure - no store access; callers supply the full and
 * live token counts. Returns 100 for a zero-token block (divide-by-zero guard ->
 * reads as "fully intact", since there was nothing to remove). The Map header
 * already reports "saves X tok", so "% remains" reads as how much of the
 * original content the human can still see and stays consistent with that
 * existing copy.
 */
export function remainingPct(full: number, live: number): number {
	if (full <= 0) return 100;
	// Clamp to [0, 100]: a conductor substitution can be LARGER than the original
	// block, which would otherwise yield a >100% remaining value. 100 = nothing
	// removed (fully intact), 0 = fully gone.
	const pct = Math.round((live / full) * 100);
	return Math.max(0, Math.min(100, pct));
}

/**
 * Remaining percentage bucketed into 6 discrete bands (0-5), used to size the
 * corner-bracket "erosion border" stamped directly on a folded tile — a
 * coarser, glanceable signal than the precise "X% remains" text shown in
 * tooltips/Transcript/Inspector. Band 5 (>=90%) renders as a nearly-complete
 * border; band 0 (<10%) renders no border at all.
 */
export function remainingBand(pct: number): number {
	if (pct >= 90) return 5;
	if (pct >= 75) return 4;
	if (pct >= 50) return 3;
	if (pct >= 25) return 2;
	if (pct >= 10) return 1;
	return 0;
}
