/*
 * digest.ts — what a folded block collapses to.
 *
 * Deterministic, per-kind. The point of typed blocks is that each kind keeps a
 * different essence when folded: a tool_call keeps WHAT it did, a tool_result
 * keeps only its shape and a taste of WHAT it saw. No LLM here yet — these are
 * structured digests so behaviour is reproducible and debuggable.
 */
import type { Block } from "./types";
import { estTokens, clip, firstLine, BLOCK_OVERHEAD } from "./tokens";

export function digest(b: Block): string {
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
