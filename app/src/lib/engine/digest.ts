/*
 * digest.ts — what a folded block collapses to.
 *
 * Deterministic, per-kind. The point of typed blocks is that each kind keeps a
 * different essence when folded: a tool_call keeps WHAT it did, a tool_result
 * keeps only its shape and a taste of WHAT it saw. No LLM here yet — these are
 * structured digests so behaviour is reproducible and debuggable.
 *
 * Every digest carries a leading `{#<code> FOLDED}` tag. This is the engine's
 * source-of-truth string: it is what the GUI renders for a folded block, what
 * `digestTokens` counts, AND (in live mode) the exact text the agent receives in
 * place of the folded content. The agent reads the short `code` from the tag and
 * calls the `unfold` tool with it to pull the block back to full content. Keeping the
 * tag here — not bolted on at the wire — guarantees the GUI shows precisely what the
 * model sees and the saved-tokens figure includes the tag's real cost.
 *
 * The code is a short HASH of the durable block id, not the id itself: a raw id is a
 * UUID/timestamp (`a:f2965ed9-…-d93e8c55c59e:p0`) — unreadable line-noise repeated on
 * every folded block. The hash is a pure function of the id, so it needs no state and
 * is globally stable (same block → same code, every session). A 4-char base36 space
 * (~1.68M) keeps collisions rare; the rare collision is handled by `resolveUnfold`
 * unfolding every folded block that shares the code (cheap and harmless).
 */
import type { Block, BlockKind } from "./types";
import { estTokens, clip, firstLine, BLOCK_OVERHEAD } from "./tokens";

/**
 * Kinds that the live link can actually fold and send to the agent (mirrored by
 * `computeFoldOps` / `applyPlan`). A `tool_call` is never folded (it would orphan its
 * result) and a `user` block (intent) is never folded. ONLY these kinds get a
 * `{#code FOLDED}` tag — so the agent is never shown a handle for a block it can't
 * actually unfold. Defined here (the engine) so the live layer imports one definition.
 */
export const FOLDABLE_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>(["text", "thinking", "tool_result"]);

/**
 * Short, stable handle for a block, derived purely from its durable id (FNV-1a → base36,
 * 6 chars). Stateless and deterministic so the engine, the live link, and the
 * `accordion-context-folding` skill never drift. Not collision-free by construction, but
 * a 6-char base36 space (~2.2B) makes a collision vanishingly rare even across a
 * thousand-block session (~0.02%); the rare collision is handled by `resolveUnfold`
 * restoring ALL folded blocks that carry the code.
 */
export function foldCode(id: string): string {
	let h = 0x811c9dc5; // FNV-1a 32-bit
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}

/** The folded-block marker the agent sees and passes back to `unfold`, e.g. `{#3f9a2c FOLDED}`. */
export function foldTag(id: string): string {
	return `{#${foldCode(id)} FOLDED}`;
}

/**
 * Per-block memo of the (immutable) digest string and its token cost. `digest(b)` reads
 * only fields fixed at parse time — kind, text, id, toolName, isError, tokens — and folding
 * never touches any of them (it flips override/autoFolded/by). So the result is invariant
 * for a block's lifetime, yet `refold()` recomputes it twice per fold candidate and every
 * `liveTokens` read recomputes it per folded block; each call re-runs the FNV hash plus a
 * couple of text splits. A WeakMap keyed by the block makes those repeats free and is
 * GC-friendly (no cross-session leak: the entry dies with the block).
 *
 * TRIPWIRE: there is no invalidation. This is sound ONLY because a committed block's content
 * fields are never mutated in place (the live resend path drops duplicate ids rather than
 * overwriting; applyPlan clones). If a future feature ever mutates an existing block's
 * `text`/`tokens` (e.g. streaming partial-text growth into a committed block), it MUST clear
 * both caches for that block, or the rendered digest and saved-tokens accounting go stale.
 */
const digestCache = new WeakMap<Block, string>();
const digestTokenCache = new WeakMap<Block, number>();

/**
 * The full folded representation. Foldable kinds get the `{#<code> FOLDED}` tag followed
 * by the per-kind body; non-foldable kinds (user / tool_call) get the body alone — they
 * are never sent folded to the agent, so tagging them would show a handle the agent can
 * never use and make the GUI render diverge from what the model actually sees.
 */
export function digest(b: Block): string {
	const cached = digestCache.get(b);
	if (cached !== undefined) return cached;
	const body = digestBody(b);
	const out = FOLDABLE_KINDS.has(b.kind) ? `${foldTag(b.id)} ${body}` : body;
	digestCache.set(b, out);
	return out;
}

/** The per-kind essence kept when a block is folded (without the tag). */
function digestBody(b: Block): string {
	switch (b.kind) {
		case "user":
			return "“" + clip(b.text, 100) + "”";
		case "text":
			return clip(b.text, 120);
		case "thinking": {
			const tok = estTokens(b.text);
			const gist = firstLine(b.text, 80);
			return `thought · ~${tok} tok${gist ? " · " + gist : ""}`;
		}
		case "tool_call":
			// Tiny and durable — the digest is nearly the whole thing on purpose.
			return `${b.toolName ?? "tool"}(${clip(b.text.replace(/^\S+\s*/, ""), 70)})`;
		case "tool_result": {
			const name = b.toolName ?? "result";
			if (!b.text.trim()) return `${name} → ${b.isError ? "error" : "empty"}`;
			const lines = b.text.split("\n").filter((l) => l.trim()).length;
			const tag = b.isError ? "error" : `${lines} line${lines === 1 ? "" : "s"}`;
			const peek = firstLine(b.text, 60);
			return `${name} → ${tag}, ~${b.tokens} tok${peek ? " · " + peek : ""}`;
		}
		default:
			return clip(b.text, 80); // defensive: an unmodelled kind still gets a sane digest
	}
}

export function digestTokens(b: Block): number {
	const cached = digestTokenCache.get(b);
	if (cached !== undefined) return cached;
	const out = estTokens(digest(b)) + BLOCK_OVERHEAD;
	digestTokenCache.set(b, out);
	return out;
}
