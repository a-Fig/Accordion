// digest.mjs — Level-2 deterministic digest (the instant fallback under any LLM summary).
//
// Ported from the_conductor/src/conductor.ts. A digest is the 1–3 line stand-in shown when a
// block is folded to Level 2. It is per-kind, ends with the structured ⟦…⟧ salience suffix
// (so dormant-but-critical facts survive a deep fold), and is addressable by a ⟦t<turn>⟧
// prefix. Operates on a ViewBlock { kind, turn, text, tokens, toolName?, isError? }.

import {
	clip, firstLine, estTokens, tokensOf,
	decisionSentence, salienceTokens, buildSalienceSuffix,
} from "./salience.mjs";

export function deterministicDigest(block) {
	switch (block.kind) {
		case "user": {
			return `"${clip(block.text, 100)}"` + buildSalienceSuffix(block.text);
		}
		case "text": {
			const decision = decisionSentence(block.text);
			const salience = salienceTokens(block.text);
			let base;
			if (decision && salience && !decision.includes(salience)) base = `${decision} | ${salience}`;
			else base = decision || salience || clip(block.text, 120);
			return base + buildSalienceSuffix(block.text);
		}
		case "thinking": {
			const tok = estTokens(block.text);
			const gist = firstLine(block.text, 80);
			return `thought - ~${tok} tok${gist ? " - " + gist : ""}` + buildSalienceSuffix(block.text);
		}
		case "tool_call": {
			return `${block.toolName ?? "tool"}(${clip((block.text || "").replace(/^\S+\s*/, ""), 70)})` + buildSalienceSuffix(block.text);
		}
		case "tool_result": {
			const name = block.toolName ?? "result";
			if (!(block.text || "").trim()) return `${name} -> ${block.isError ? "error" : "empty"}`;
			const lines = block.text.split("\n").filter((l) => l.trim()).length;
			const tag = block.isError ? "error" : `${lines} line${lines === 1 ? "" : "s"}`;
			const peek = salienceTokens(block.text) || firstLine(block.text, 60);
			return `${name} -> ${tag}, ~${block.tokens} tok${peek ? " - " + peek : ""}` + buildSalienceSuffix(block.text);
		}
		default:
			return clip(block.text, 120);
	}
}

/** Address prefix that makes every fold targetable by the agent/human (⟦t7⟧ …). */
export function foldAddress(block) {
	return `⟦t${block.turn}⟧ `;
}

/** The full Level-2 digest content we hand the host (address + digest body). */
export function digestContent(block, summary) {
	const body = summary && summary.trim() ? summary.trim() : deterministicDigest(block);
	return foldAddress(block) + body;
}

export function digestTokens(block, summary) {
	return tokensOf(digestContent(block, summary));
}

/** Level-3 group member: a one-line marker pointing at the group head. */
export function groupMemberText(block) {
	return `· t${block.turn} folded into the group digest above`;
}
