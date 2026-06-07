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
import type { Block } from "./types";
import { estTokens, clip, firstLine, BLOCK_OVERHEAD } from "./tokens";

/**
 * Short, stable handle for a block, derived purely from its durable id (FNV-1a → base36,
 * 4 chars). Stateless and deterministic so the engine, the live link, and the
 * `accordion-context-folding` skill never drift. Not collision-free by construction —
 * `resolveUnfold` resolves a code to ALL folded blocks that carry it.
 */
export function foldCode(id: string): string {
	let h = 0x811c9dc5; // FNV-1a 32-bit
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36).padStart(4, "0").slice(-4);
}

/** The folded-block marker the agent sees and passes back to `unfold`, e.g. `{#3f9a FOLDED}`. */
export function foldTag(id: string): string {
	return `{#${foldCode(id)} FOLDED}`;
}

/** The full folded representation: the `{#<code> FOLDED}` tag followed by the per-kind body. */
export function digest(b: Block): string {
	return `${foldTag(b.id)} ${digestBody(b)}`;
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
	return estTokens(digest(b)) + BLOCK_OVERHEAD;
}
