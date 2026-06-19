// units.mjs — fold UNITS (tool-pair atomicity) + per-level token projection.
//
// A "unit" is what moves between fold tiers atomically. A valid tool_call/tool_result pair
// is ONE unit (folding the call without its result would orphan the pair); every other block
// is its own unit. Malformed/unpaired tool blocks are non-foldable and stay full. Ported from
// the_conductor's buildFoldUnits and blockTokensAtLevel, operating on ViewBlocks.

import { FOLDABLE_KINDS, tokensOf } from "./salience.mjs";
import { digestTokens, groupMemberText } from "./digest.mjs";
import { trimTokens } from "./trim.mjs";

/** Group blocks into atomic fold units, preserving conversation order by first block. */
export function buildFoldUnits(blocks) {
	const calls = new Map();
	const results = new Map();
	for (const b of blocks) {
		if (!b.callId) continue;
		if (b.kind === "tool_call") calls.set(b.callId, [...(calls.get(b.callId) ?? []), b]);
		if (b.kind === "tool_result") results.set(b.callId, [...(results.get(b.callId) ?? []), b]);
	}

	const paired = new Set();
	const units = [];
	const makeUnit = (id, us, foldable) => {
		units.push({
			id,
			blocks: us,
			blockIds: us.map((b) => b.id),
			foldable,
			kind: us[0].kind,
			order: Math.min(...us.map((b) => b.order)),
			tokens: us.reduce((s, b) => s + b.tokens, 0),
		});
	};

	for (const b of blocks) {
		if ((b.kind === "tool_call" || b.kind === "tool_result") && !b.callId) {
			makeUnit(`malformed:${b.id}`, [b], false);
			continue;
		}
		if (b.callId && (b.kind === "tool_call" || b.kind === "tool_result")) {
			if (paired.has(b.id)) continue;
			const call = b.kind === "tool_call" ? b : calls.get(b.callId)?.[0];
			const result = b.kind === "tool_result" ? b : results.get(b.callId)?.[0];
			if (call && result && calls.get(b.callId)?.length === 1 && results.get(b.callId)?.length === 1) {
				paired.add(call.id); paired.add(result.id);
				makeUnit(`pair:${b.callId}`, [call, result], true);
			} else {
				paired.add(b.id);
				makeUnit(`malformed:${b.id}`, [b], false);
			}
			continue;
		}
		makeUnit(b.id, [b], FOLDABLE_KINDS.has(b.kind));
	}
	return units;
}

/** Token cost of a single block rendered at a fold level. `summaries` maps content hash →
 *  LLM summary (for L2 digests); absent → deterministic digest cost. */
export function blockTokensAtLevel(block, level, summaryFor) {
	if (level <= 0) return block.tokens;
	if (level === 3) return tokensOf(groupMemberText(block));
	if (!FOLDABLE_KINDS.has(block.kind)) return block.tokens;
	if (level === 1) return trimTokens(block);
	return digestTokens(block, summaryFor ? summaryFor(block) : undefined);
}

export function unitTokensAtLevel(unit, level, summaryFor) {
	return unit.blocks.reduce((s, b) => s + blockTokensAtLevel(b, level, summaryFor), 0);
}
