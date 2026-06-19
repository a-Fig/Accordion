// commands.mjs — turn a tier result into the wire command batch (pure given renderers).
//
// Tier → command mapping (every command edits an EXISTING block; nothing is inserted):
//   Trim   (1) → replace{ id, content: <query-aware excerpt> }   per block
//   Digest (2) → fold{ ids:[id], digest: <LLM summary or deterministic digest> }   per block
//   Group  (3) → group{ ids: <contiguous run's block ids> }      one per run (host owns head)
//   Full   (0) → nothing (raw baseline)
//
// The conductor's reply is its COMPLETE desired state — the host resets to baseline then
// applies this batch — so we emit one command per non-full block every time we send.

import { digestContent } from "./digest.mjs";
import { trimmedText } from "./trim.mjs";
import { FOLDABLE_KINDS } from "./salience.mjs";

export function buildCommands(result, { summaryFor, segmentRelevanceFn }) {
	const grouped = new Set(result.groups.flatMap((g) => g.unitIds));
	const relFn = segmentRelevanceFn?.();
	const commands = [];

	for (const u of result.candidates) {
		if (grouped.has(u.id)) continue;
		const lvl = result.levels.get(u.id);
		if (!lvl) continue;
		if (lvl === 1) {
			for (const b of u.blocks) if (FOLDABLE_KINDS.has(b.kind)) commands.push({ kind: "replace", id: b.id, content: trimmedText(b, relFn) });
		} else if (lvl === 2) {
			for (const b of u.blocks) if (FOLDABLE_KINDS.has(b.kind)) commands.push({ kind: "fold", ids: [b.id], digest: digestContent(b, summaryFor?.(b)) });
		}
	}
	for (const g of result.groups) commands.push({ kind: "group", ids: g.blockIds });
	return commands;
}

/** The desired state we must remember for the next pass (seeds hysteresis). */
export function snapshotState(result) {
	const grouped = new Set(result.groups.flatMap((g) => g.unitIds));
	const levels = new Map();
	for (const u of result.candidates) {
		if (grouped.has(u.id)) continue;
		const lvl = result.levels.get(u.id);
		if (lvl > 0) levels.set(u.id, lvl);
	}
	return { levels, grouped };
}
