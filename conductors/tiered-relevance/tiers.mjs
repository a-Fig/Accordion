// tiers.mjs — the relevance-driven level-of-detail equilibrium (pure, no I/O).
//
// The whole conductor in one idea: every block continuously sits at the fidelity TIER its
// relevance earns, and the token budget decides how generous the tiers are. Fold, unfold,
// and anti-thrash all fall out of one re-tiering computation.
//
//   Tiers:  0 Full · 1 Trim · 2 Digest · 3 Group member
//   Score:  unified relevance r(unit) = max over its blocks of relevanceOf(block)
//           (the caller passes r already combined from goal-match and trajectory-match)
//
// Hysteresis band [lowWater, highWater] of the cap (min(budget, contextWindow)):
//   • COMPRESS — when rendered > highWater·cap: deepen the COLDEST units first (depth-first
//     to Digest, marginal unit stops at the shallowest tier that reaches lowWater); then, if
//     still over, collapse contiguous Digest runs into Groups.
//   • FLOAT-UP — when there's headroom: raise folded units that are CLEARLY relevant now
//     (r ≥ floatFloor + margin), most-relevant first, one tier per pass, while staying under
//     highWater. Cold units are NOT re-inflated just because budget allows — only blocks the
//     agent is veering toward come back. This is anticipatory unfold, and the margin deadband
//     + "compress folds coldest first" make it structurally thrash-free (no pins, no timers).
//   • HOLD otherwise.
//
// Pure: a function of (view, relevanceOf, summaryFor, prev, cfg). The server owns the caches,
// the embeddings, and turning the returned tiers into wire commands.

import { buildFoldUnits, unitTokensAtLevel } from "./units.mjs";
import { trimEligible } from "./trim.mjs";
import { parseRiskFlags, textHash } from "./salience.mjs";
import { deterministicDigest, digestContent } from "./digest.mjs";

export const DEFAULT_CFG = {
	highWater: 0.9, // cross this fraction of cap → compress
	lowWater: 0.6, // compress down to roughly here
	floatFloor: 0.3, // absolute cosine floor to float a folded block back up
	floatMargin: 0.05, // deadband above the floor — block must be CLEARLY relevant to float
	groupMinUnits: 3, // min contiguous Digest units to form a Group
	riskFloorBonus: 0.1, // each risk category lowers the float floor by this
	riskFloorMin: 0.1, // floor never drops below this
};

/**
 * @param view  { blocks, budget, contextWindow, liveTokens, protectedFromIndex }
 * @param relevanceOf  (block) => number   unified relevance in ~[0,1]
 * @param summaryFor   (block) => string|undefined   cached L2 summary (for sizing)
 * @param prev  { levels: Map<unitId, 0|1|2>, grouped: Set<unitId> }  our last desired state
 * @param cfg   band + float config
 * @returns { units, candidates, levels:Map, groups:[{unitIds,blockIds,headId}], action, rendered, cap, fullness }
 */
export function computeTiers(view, relevanceOf, summaryFor, prev, cfg = DEFAULT_CFG) {
	const C = { ...DEFAULT_CFG, ...cfg };
	const blocks = view.blocks;
	const cap = Math.min(view.budget || Infinity, view.contextWindow ?? Infinity);
	const highTok = C.highWater * cap;
	const lowTok = C.lowWater * cap;

	const units = buildFoldUnits(blocks);

	// A unit is a candidate iff it is foldable, the host lets us touch it, and the agent
	// hasn't explicitly pulled it live (keepLive — an M3 self-unfold we must respect).
	const keepLive = C.keepLive ?? new Set();
	const isFree = (u) =>
		u.foldable &&
		u.blocks.every((b) => !b.held && !b.protected && !b.grouped && !b.folded && !keepLive.has(b.id));
	const candidates = units.filter(isFree);
	const candById = new Map(candidates.map((u) => [u.id, u]));

	// Fixed cost: every block we won't touch (held / protected / host-folded / non-candidate),
	// at the cost the host currently renders it (the raw baseline already cleared OUR folds).
	const candBlockIds = new Set(candidates.flatMap((u) => u.blockIds));
	let fixedTokens = 0;
	for (const b of blocks) {
		if (candBlockIds.has(b.id)) continue;
		fixedTokens += b.folded ? b.foldedTokens : b.tokens;
	}

	// Relevance per candidate unit (most-relevant member keeps the unit).
	const rel = new Map();
	for (const u of candidates) rel.set(u.id, Math.max(...u.blocks.map((b) => relevanceOf(b))));

	// Seed desired levels from prev (pruned to current candidates); grouped seeds → Digest.
	const levels = new Map();
	for (const u of candidates) {
		let lvl = prev?.levels?.get(u.id) ?? 0;
		if (prev?.grouped?.has(u.id)) lvl = 2;
		levels.set(u.id, clampLevel(lvl));
	}

	const cost = (u, lvl) => unitTokensAtLevel(u, lvl, summaryFor);
	const renderedNow = () => {
		let t = fixedTokens;
		for (const u of candidates) t += cost(u, levels.get(u.id));
		return t;
	};

	let groups = [];
	let rendered = renderedNow();
	let action = "hold";

	if (rendered > highTok) {
		action = "compress";
		// Deepen COLDEST units first, depth-first to Digest. The coldest reach L2; the marginal
		// unit (where we cross lowTok) stops at the shallowest tier that gets there (stays Trim).
		const coldFirst = [...candidates].sort(
			(a, b) => rel.get(a.id) - rel.get(b.id) || b.tokens - a.tokens || a.order - b.order,
		);
		for (const u of coldFirst) {
			if (rendered <= lowTok) break;
			let lvl = levels.get(u.id);
			while (lvl < 2 && rendered > lowTok) {
				const next = lvl < 1 && trimEligible(u.blocks[0]) && u.blocks.length === 1 ? 1 : 2;
				const saving = cost(u, lvl) - cost(u, next);
				if (saving <= 0) {
					if (next < 2) { lvl = next; continue; } // Trim was no-op; try Digest
					break; // Digest also can't save (oversized digest); leave at current level
				}
				lvl = next;
				levels.set(u.id, lvl);
				rendered -= saving;
			}
		}

		// Still over? Collapse contiguous runs of ≥groupMinUnits Digest units into Groups.
		if (rendered > lowTok) {
			groups = formGroups(blocks, candidates, levels, C.groupMinUnits, (u, lvl) => cost(u, lvl), () => rendered, (delta) => { rendered -= delta; }, lowTok);
		}
	} else {
		// Headroom. Float a folded unit up ONE tier only when it now OUT-RANKS something live —
		// i.e. its relevance rose above the least-relevant currently-full block (anticipatory
		// unfold as the trajectory shifts). We deliberately do NOT fill the budget back to the
		// ceiling: right after a relevance-sorted compression the folded units are the least
		// relevant, so nothing floats and the tiers are stable (no cache-thrashing oscillation).
		// Only a genuine relevance rise brings a block back. Cold units stay folded.
		const liveRels = candidates.filter((u) => levels.get(u.id) === 0).map((u) => rel.get(u.id));
		const minLiveRel = liveRels.length ? Math.min(...liveRels) : Infinity;
		const foldedUnits = candidates.filter((u) => levels.get(u.id) > 0);
		const warmFirst = foldedUnits.sort((a, b) => rel.get(b.id) - rel.get(a.id));
		for (const u of warmFirst) {
			const r = rel.get(u.id);
			const floor = effectiveFloor(u, summaryFor, C);
			if (r < floor + C.floatMargin) continue; // not relevant enough in absolute terms
			if (r <= minLiveRel + C.floatMargin) continue; // doesn't out-rank the live set → leave folded
			const lvl = levels.get(u.id);
			const up = lvl - 1;
			const delta = cost(u, up) - cost(u, lvl); // tokens ADDED by floating up
			if (rendered + delta > highTok) continue; // never breach the ceiling
			levels.set(u.id, up);
			rendered += delta;
			action = "floatup";
		}
	}

	return { units, candidates, levels, groups, action, rendered, cap, fullness: cap ? rendered / cap : 0, rel };
}

function clampLevel(n) {
	const v = Math.round(Number(n) || 0);
	return v < 0 ? 0 : v > 2 ? 2 : v;
}

/** Lower the float floor for risk-bearing digests (kept salience markers). */
function effectiveFloor(unit, summaryFor, C) {
	let riskBonus = 0;
	for (const b of unit.blocks) {
		const flags = parseRiskFlags(deterministicDigest(b));
		if (flags.length > riskBonus) riskBonus = flags.length;
	}
	return Math.max(C.riskFloorMin, C.floatFloor - riskBonus * C.riskFloorBonus);
}

/** Collapse contiguous runs of Digest (L2) candidate units into groups. Contiguity is
 *  checked against the FULL block sequence: any non-candidate block (user turn, held block,
 *  etc.) between two L2 candidates breaks the run. The host's group span is first→last and
 *  sweeps every block between them — so gaps must be detected here, not just in candidates. */
function formGroups(blocks, candidates, levels, minUnits, costFn, getRendered, subtract, lowTok) {
	// Map each block id to its candidate unit if the unit is at L2.
	const blockToUnit = new Map();
	for (const u of candidates) {
		if (levels.get(u.id) === 2) {
			for (const id of u.blockIds) blockToUnit.set(id, u);
		}
	}

	const groups = [];
	let run = [];
	const seen = new Set(); // unit ids already in current run (multi-block units appear once)

	const flush = () => {
		if (run.length >= minUnits && getRendered() > lowTok) {
			const head = run[0];
			let saved = 0;
			for (const m of run.slice(1)) saved += costFn(m, 2) - costFn(m, 3);
			subtract(saved);
			groups.push({
				unitIds: run.map((u) => u.id),
				blockIds: run.flatMap((u) => u.blockIds),
				headId: head.id,
			});
		}
		run = [];
		seen.clear();
	};

	for (const b of blocks) { // walk full conversation order so any gap is visible
		if (getRendered() <= lowTok) break;
		const u = blockToUnit.get(b.id);
		if (u) {
			if (!seen.has(u.id)) { seen.add(u.id); run.push(u); }
		} else {
			flush(); // non-candidate block (user turn, held, protected) interrupts the run
		}
	}
	flush();
	return groups;
}

/** Stable signature of a tier result for change detection (only emit when this changes). */
export function tierSignature(result, summaryFor = null) {
	const grouped = new Set(result.groups.flatMap((g) => g.unitIds));
	const parts = [];
	for (const u of result.candidates) {
		if (grouped.has(u.id)) continue;
		const lvl = result.levels.get(u.id);
		if (lvl > 0) {
			let digestSig = "";
			if (lvl === 2 && summaryFor) {
				digestSig = ":" + textHash(u.blocks.map((b) => digestContent(b, summaryFor(b))).join("\n"));
			}
			parts.push(`${u.id}:${lvl}${digestSig}`);
		}
	}
	parts.sort();
	const groupSig = result.groups.map((g) => `g[${g.blockIds.join(",")}]`).sort();
	return parts.join("|") + "||" + groupSig.join("|");
}
