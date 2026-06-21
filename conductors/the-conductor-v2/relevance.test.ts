/*
 * relevance.test.ts — Phase 2: prove the SEMANTIC (embedding) relevance path works end-to-end
 * without @huggingface/transformers, by injecting a deterministic fake embedding provider.
 * A block that was folded last pass but is semantically matched by the new prompt must be
 * proactively unfolded (cosine relevance pulling it shallower). `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAccordionState, computeFoldPlan, warmEmbeddings, type EmbeddingProvider } from "./strategy.ts";
import { viewToParsed, offLimitsIds, type ViewBlock } from "./adapter.ts";

/** Deterministic 2-D embeddings: anything mentioning the needle points one way, everything
 *  else the orthogonal way. L2-normalized, so dot product == cosine (1.0 vs 0.0). */
function fakeEmbedder(needle: string): EmbeddingProvider {
	return async (texts: string[]) =>
		texts.map((t) => (t.toLowerCase().includes(needle) ? [1, 0] : [0, 1]));
}

function makeBlocks(): ViewBlock[] {
	const blocks: ViewBlock[] = [];
	let order = 0;
	const mk = (kind: ViewBlock["kind"], text: string, extra: Partial<ViewBlock> = {}): ViewBlock => {
		const tokens = Math.max(40, Math.ceil(text.length / 4));
		return {
			id: `b${order}`, kind, turn: order + 1, order: order++, tokens, foldedTokens: Math.ceil(tokens / 4),
			held: false, folded: false, protected: false, grouped: false, text, ...extra,
		};
	};
	// An early result mentioning the needle (semantically relevant to the future prompt) …
	blocks.push(mk("user", "set up the project"));
	blocks.push(mk("tool_result", "config: the MANGO endpoint lives at https://mango.example/api ".repeat(20), { toolName: "readFile", callId: "c1" }));
	// … several unrelated middle turns …
	for (let i = 0; i < 6; i++) blocks.push(mk("tool_result", "unrelated build log line ".repeat(20), { toolName: "build", callId: `c${i + 2}` }));
	// … and a recent (protected) tail asking about the needle.
	blocks.push(mk("user", "what is the MANGO endpoint again?"));
	blocks[blocks.length - 1].protected = true;
	return blocks;
}

test("embedding cosine relevance proactively unfolds a semantically-matched folded block", async () => {
	const blocks = makeBlocks();
	const needleId = blocks[1].id; // the MANGO config result
	const parsed = viewToParsed(blocks);
	const prompt = "what is the MANGO endpoint again?";

	const state = createAccordionState();
	// Pretend the conductor folded the MANGO block on a prior (cold) pass.
	state.foldLevels = { [needleId]: 2 };
	state.foldedBlockIds = [needleId];

	// Warm the embedding cache with the fake provider → relevance() now uses cosine.
	await warmEmbeddings(parsed.blocks, prompt, fakeEmbedder("mango"), state);
	assert.ok(Object.keys(state.embeddingCache).length > 0, "embedding cache populated");

	const plan = computeFoldPlan(
		{ parsed, incomingPrompt: prompt, budgetTokens: 1_000_000, state, offLimitsIds: offLimitsIds(blocks) },
		{ embeddingProvider: fakeEmbedder("mango") },
	);

	assert.ok(
		plan.proactiveUnfolds.includes(needleId),
		`expected the MANGO block to be proactively unfolded; got ${JSON.stringify(plan.proactiveUnfolds)}`,
	);
	assert.equal(plan.levels.get(needleId) ?? 0, 0, "matched block returns to full");
});

test("keyword fallback (no embeddings) does not crash and still plans", () => {
	const blocks = makeBlocks();
	const parsed = viewToParsed(blocks);
	const state = createAccordionState();
	const plan = computeFoldPlan(
		{ parsed, incomingPrompt: "MANGO endpoint", budgetTokens: 200, state, offLimitsIds: offLimitsIds(blocks) },
		{},
	);
	assert.ok(plan.assembledTokens > 0);
});
