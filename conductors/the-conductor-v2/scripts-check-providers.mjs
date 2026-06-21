// Manual end-to-end check of the REAL ML providers (not run by `node --test` — needs network
// to download model weights on first use). Run: node scripts-check-providers.mjs
import {
	createTransformersEmbeddingProvider,
	createTransformersRerankProvider,
	createAccordionState,
	warmEmbeddings,
	warmRerank,
	computeFoldPlan,
} from "./strategy.ts";
import { viewToParsed, offLimitsIds } from "./adapter.ts";

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

console.log("loading embedding provider…");
const embed = await createTransformersEmbeddingProvider();
const [vCat, vDog, vFinance] = await embed(["a cat sat on the mat", "a dog ran in the park", "quarterly revenue and EBITDA margins"]);
console.log("embedding dims:", vCat.length, "| |v|^2:", dot(vCat, vCat).toFixed(3), "(≈1 ⇒ normalized)");
console.log("cos(cat,dog):", dot(vCat, vDog).toFixed(3), "  cos(cat,finance):", dot(vCat, vFinance).toFixed(3));
if (!(dot(vCat, vDog) > dot(vCat, vFinance))) throw new Error("expected cat↔dog more similar than cat↔finance");

console.log("\nloading rerank provider…");
const rerank = await createTransformersRerankProvider();
const scores = await rerank("how do I configure the deploy endpoint?", [
	"the deploy endpoint is set in config/deploy.ts via DEPLOY_URL",
	"my favourite colour is blue and the sky is nice today",
]);
console.log("rerank scores:", scores.map((s) => s.toFixed(3)));
if (!(scores[0] > scores[1])) throw new Error("expected the relevant candidate to outrank the irrelevant one");

console.log("\nfull pipeline with real embeddings…");
const blocks = [];
let order = 0;
const mk = (kind, text, extra = {}) => {
	const tokens = Math.max(40, Math.ceil(text.length / 4));
	return { id: `b${order}`, kind, turn: order + 1, order: order++, tokens, foldedTokens: Math.ceil(tokens / 4),
		held: false, folded: false, protected: false, grouped: false, text, ...extra };
};
blocks.push(mk("user", "set up the project"));
blocks.push(mk("tool_result", "config: the deploy endpoint is https://deploy.example/api ".repeat(20), { toolName: "readFile", callId: "c1" }));
for (let i = 0; i < 6; i++) blocks.push(mk("tool_result", "unrelated build log line ".repeat(20), { toolName: "build", callId: `c${i + 2}` }));
blocks.push(mk("user", "what is the deploy endpoint again?"));
blocks[blocks.length - 1].protected = true;

const parsed = viewToParsed(blocks);
const prompt = "what is the deploy endpoint again?";
const state = createAccordionState();
state.foldLevels = { b1: 2 };
state.foldedBlockIds = ["b1"];
await warmEmbeddings(parsed.blocks, prompt, embed, state, 30_000);
await warmRerank(prompt, parsed.blocks.filter((b) => state.foldedBlockIds.includes(b.id)).map((b) => b.text), rerank, state);
const plan = computeFoldPlan({ parsed, incomingPrompt: prompt, budgetTokens: 1_000_000, state, offLimitsIds: offLimitsIds(blocks) }, { embeddingProvider: embed });
console.log("proactiveUnfolds:", plan.proactiveUnfolds, "| deploy block level:", plan.levels.get("b1") ?? 0);
if (!plan.proactiveUnfolds.includes("b1")) throw new Error("expected the deploy-config block to be proactively unfolded by real relevance");

console.log("\n✅ real embedding + rerank providers work end-to-end");
