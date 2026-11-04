/**
 * regret.ts — pure parsing + summarising of the extension's `/__accordion/meta` `regret` object
 * (PR #152). Framework-free so it is unit-testable without Svelte.
 *
 * The signal is a PROXY, not ground truth: it counts how often the agent reached back into folded
 * content (`unfold`/`recall`), attributed to the conductor attached AT THE MOMENT OF THE CALL. An
 * agent may unfold out of curiosity because the tag invites it, and under an `agent-unfold` lock
 * the refused attempts land in `missingCodes`, so a lock-holder reading 0 means "can't tell", not
 * "no regret". `foldedBlocks` is a point-in-time gauge (what is folded NOW), not a rate denominator.
 */

export interface RegretCounts {
	unfoldCalls: number;
	unfoldBlocks: number;
	recallCalls: number;
	recallBlocks: number;
	missingCodes: number;
	byKind: Record<string, number>;
}

export interface RegretMeta {
	foldedBlocks: number;
	byConductor: Record<string, RegretCounts>;
}

/** What the `/__accordion/meta` body must look like for us to trust its `regret` field. */
export interface MetaBody {
	sessionId?: unknown;
	regret?: unknown;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

function parseCounts(v: unknown): RegretCounts | null {
	if (!v || typeof v !== "object") return null;
	const o = v as Record<string, unknown>;
	const byKind: Record<string, number> = {};
	if (o.byKind && typeof o.byKind === "object") {
		for (const [k, n] of Object.entries(o.byKind as Record<string, unknown>)) byKind[k] = num(n);
	}
	return {
		unfoldCalls: num(o.unfoldCalls),
		unfoldBlocks: num(o.unfoldBlocks),
		recallCalls: num(o.recallCalls),
		recallBlocks: num(o.recallBlocks),
		missingCodes: num(o.missingCodes),
		byKind,
	};
}

/**
 * Parse a `/meta` body into a `RegretMeta`, or `null` when it is not usable: no `regret` field (an
 * older extension), a malformed one, or — the important case — a body from a DIFFERENT session than
 * the one this tab is connected to. A relative `fetch("/__accordion/meta")` targets whichever origin
 * served the page (the door, after a session switch), so `sessionId` is the only way to know the
 * counts describe the session the user is looking at.
 */
export function parseRegret(body: unknown, connectedSessionId: string | null): RegretMeta | null {
	if (!body || typeof body !== "object" || connectedSessionId === null) return null;
	const b = body as MetaBody;
	if (b.sessionId !== connectedSessionId) return null;
	if (!b.regret || typeof b.regret !== "object") return null;
	const r = b.regret as Record<string, unknown>;
	if (!r.byConductor || typeof r.byConductor !== "object") return null;
	const byConductor: Record<string, RegretCounts> = {};
	for (const [id, v] of Object.entries(r.byConductor as Record<string, unknown>)) {
		const c = parseCounts(v);
		if (c) byConductor[id] = c;
	}
	return { foldedBlocks: num(r.foldedBlocks), byConductor };
}

/** Agent reach-backs (unfold + recall CALLS) in one bucket. `missingCodes` is deliberately excluded. */
export function reachBackCalls(c: RegretCounts | undefined): number {
	return c ? c.unfoldCalls + c.recallCalls : 0;
}

/** The bucket id the extension files a call under when no conductor is attached. */
export const NO_CONDUCTOR = "none";

/** The one-line tooltip body: per-conductor breakdown plus the gauge, with the proxy caveat. */
export function regretTooltip(r: RegretMeta, activeId: string | null): string {
	const lines = [
		"Agent reach-backs into folded context (unfold + recall calls)",
		"A proxy, not ground truth: attributed to the conductor attached at call time.",
	];
	const ids = Object.keys(r.byConductor).sort();
	if (ids.length === 0) lines.push("none yet this session");
	for (const id of ids) {
		const c = r.byConductor[id];
		const kinds = Object.entries(c.byKind)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, n]) => `${k} ${n}`)
			.join(", ");
		lines.push(
			`${id === activeId || (id === NO_CONDUCTOR && activeId === null) ? "▸ " : ""}${id}: ${c.unfoldCalls} unfold · ${c.recallCalls} recall` +
				` · ${c.missingCodes} missing/refused` +
				(kinds ? ` (${kinds})` : ""),
		);
	}
	lines.push(`blocks folded right now: ${r.foldedBlocks} (a gauge, not a rate denominator)`);
	lines.push("missing/refused includes agent-unfold lock refusals, so a locked conductor can read 0 here.");
	return lines.join("\n");
}
