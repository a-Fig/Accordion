// policy.mjs — the periodic hysteresis-band fold policy (pure, testable, no I/O).
//
// This is the heart of the attention conductor and the part that satisfies the one hard
// product constraint: fold PERIODICALLY, not per-block. Re-folding on every new block
// rewrites the inference prompt prefix every turn, so the model's prompt cache never hits
// and inference cost jumps ~10x. Instead we hold a STABLE fold set between "epochs" and
// only change it occasionally.
//
// The mechanism (see docs/adr/0010-attention-conductor.md for the full rationale):
//
//   • We keep the rendered context inside a hysteresis band [lowWater, highWater] of the
//     model's context window (default 70%–90%).
//   • While rendered fullness < highWater we HOLD — emit no new command. The host keeps the
//     last applied fold set untouched (RemoteRunner returns its last `desired`), so the
//     prompt prefix is byte-stable and the cache hits. New blocks just append live at the
//     tail (after the folded region), which never disturbs the cached prefix.
//   • When rendered fullness crosses highWater we run ONE epoch: expand the fold set,
//     folding the LOWEST-attention blocks first, until rendered fullness drops back to
//     lowWater. This is a single, deliberate cache-miss event, after which the context is
//     stable again until it refills to highWater.
//
// Folds are MONOTONIC within a session (the set only grows at epochs) except for blocks a
// human or the agent has pulled back to live — those are respected and never re-folded.
// Monotonicity keeps the folded prefix stable and growing, which is maximally cache-friendly.
//
// This module is intentionally dependency-free and pure: `decideFolds()` is a function of
// (view, scores, appliedFoldSet, respectLive, cfg) with no I/O, no Date.now(), no mutation
// of its inputs. The server (attention-folder.mjs) owns the WebSocket, the scorer, and the
// applied-set memory; this file owns exactly one thing: which blocks to fold, and when.

/** Kinds that may be folded to a digest — tool_call / user are never folded (mirrors the
 *  engine's durable-id guard and the built-in's intent). */
export const FOLDABLE_KINDS = new Set(["text", "thinking", "tool_result"]);

/** Fallback fold order when an attention score is unavailable: lowest value folds first.
 *  Identical to the built-in's FOLD_RANK so degradation lands on known-good behavior. */
const FOLD_RANK = { tool_result: 0, thinking: 1, text: 2, tool_call: 3, user: 4 };

/** Default hysteresis band, as fractions of the model's context window. */
export const DEFAULT_CFG = {
	highWater: 0.9, // cross this (rendered fullness) → run a fold epoch
	lowWater: 0.7, // an epoch folds down to roughly here
};

/**
 * Effective rendered token cost of the context if `foldSet` were applied on top of the
 * host's own folds. A block contributes its `foldedTokens` when it is rendered folded
 * (`b.folded` — the host sets this for human folds AND for collapsed group members; the view
 * is cleared of OUR folds) or is in `foldSet`; otherwise its full `tokens`.
 *
 * We deliberately do NOT discount on `b.grouped` alone. A *straggler* — a member of a folded
 * group whose tool-pair partner sits outside the group — is `grouped:true` but renders LIVE at
 * full tokens on the host (store.svelte.ts `groupWire`). Discounting it would make us read a
 * lower fullness than the host's real one and HOLD past the high-water mark — the exact band
 * violation this conductor exists to prevent. Collapsed members already carry `folded:true`, so
 * they are accounted without the `grouped` term.
 */
export function renderedTokens(blocks, foldSet) {
	let t = 0;
	for (const b of blocks) {
		const folded = b.folded || foldSet.has(b.id);
		t += folded ? b.foldedTokens : b.tokens;
	}
	return t;
}

/**
 * The blocks we are allowed to fold: foldable kind, would actually shrink, not human-held,
 * not protected, not already folded/grouped, and not explicitly kept live by a human or the
 * agent (`respectLive`).
 */
export function foldCandidates(blocks, respectLive) {
	return blocks.filter(
		(b) =>
			!b.held &&
			!b.protected &&
			!b.grouped &&
			!b.folded &&
			b.foldedTokens < b.tokens &&
			FOLDABLE_KINDS.has(b.kind) &&
			!respectLive.has(b.id),
	);
}

/**
 * Decide the conductor's complete desired fold set for this view.
 *
 * @param {object} view   - { blocks, contextWindow, budget, ... } from a context/update.
 * @param {Map<string,number>} scores - attention relevance per block id (higher = keep).
 *                                       May be partial; unscored candidates fold last.
 * @param {Set<string>} appliedFoldSet - ids we currently have folded (the host's held state).
 * @param {Set<string>} respectLive    - ids a human/agent pulled back to live; never re-fold.
 * @param {object} cfg    - { highWater, lowWater } as fractions of the context window.
 * @returns {{action:'hold'|'epoch', foldSet:Set<string>, rendered:number, cap:number, fullness:number}}
 *          On 'epoch' the server SENDS `foldSet` (complete desired state). On 'hold' the
 *          server sends nothing and keeps `foldSet` (pruned) as its applied-set memory.
 */
export function decideFolds(view, scores, appliedFoldSet, respectLive, cfg = DEFAULT_CFG) {
	const blocks = view.blocks;
	const byId = new Map(blocks.map((b) => [b.id, b]));

	// The band is a fraction of the user's budget — not the model's full context window.
	// If the host hasn't reported a context window, budget alone drives the band; if both
	// are known, the tighter of the two wins so we never exceed either ceiling.
	const cap = Math.min(view.budget, view.contextWindow ?? Infinity);
	const highTok = cfg.highWater * cap;
	const lowTok = cfg.lowWater * cap;

	// 1. Prune the applied set: drop ids that vanished, became human-held, protected, grouped,
	//    or no longer shrink. A human/agent unfold therefore silently leaves our set (the host
	//    has already kept that block live; their override always wins). Everything else we
	//    folded stays folded — folds are sticky.
	const applied = new Set();
	for (const id of appliedFoldSet) {
		const b = byId.get(id);
		if (
			b &&
			!b.held &&
			!b.protected &&
			!b.grouped &&
			b.foldedTokens < b.tokens &&
			!respectLive.has(id)
		) {
			applied.add(id);
		}
	}

	const rendered = renderedTokens(blocks, applied);
	const fullness = rendered / cap;

	// 2. HOLD while under the high-water mark. Emit nothing → the host keeps the last applied
	//    state → the prompt prefix is stable → the cache hits. (Pruning above may have shrunk
	//    `applied`, but the host's per-block human-override clamp already reflects that, so we
	//    do not need to resend; `applied` is just our own fullness bookkeeping for next time.)
	if (rendered <= highTok) {
		return { action: "hold", foldSet: applied, rendered, cap, fullness };
	}

	// 3. EPOCH: over the high-water mark. Expand the fold set down to the low-water mark,
	//    folding the LEAST-relevant blocks first (lowest attention score). This is the one
	//    deliberate cache-miss of the cycle.
	const target = new Set(applied);
	let now = rendered;

	const cands = foldCandidates(blocks, respectLive).filter((b) => !target.has(b.id));

	// 3a. Scored candidates first, ascending attention (least gravity folds soonest).
	const scored = cands
		.filter((b) => scores.has(b.id))
		.sort((a, b) => scores.get(a.id) - scores.get(b.id) || a.order - b.order);
	for (const b of scored) {
		if (now <= lowTok) break;
		target.add(b.id);
		now += b.foldedTokens - b.tokens;
	}

	// 3b. Graceful degradation: if scores haven't caught up (the probe is a ~12–18s GPU job
	//     and the context may have filled faster), fold UNSCORED candidates by the built-in's
	//     value/age order so the band is still defended. Better a known-good fallback fold
	//     than to blow past 90%.
	if (now > lowTok) {
		const unscored = cands
			.filter((b) => !scores.has(b.id) && !target.has(b.id))
			.sort((a, b) => FOLD_RANK[a.kind] - FOLD_RANK[b.kind] || a.order - b.order);
		for (const b of unscored) {
			if (now <= lowTok) break;
			target.add(b.id);
			now += b.foldedTokens - b.tokens;
		}
	}

	// If even folding everything can't reach lowTok (the protected tail alone is large),
	// `target` is our best effort — the band is a target, not a hard guarantee. The protected
	// tail is never sacrificed.
	return { action: "epoch", foldSet: target, rendered: now, cap, fullness: now / cap };
}
