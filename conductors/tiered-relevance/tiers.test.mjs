// tiers.test.mjs — the core proof for the LOD equilibrium (pure, no models, no I/O).
//
// Note on block shapes: a tool_result is only foldable as part of a valid tool_call/tool_result
// PAIR (a lone tool block is "malformed" and kept full, mirroring the_conductor). So the
// single-block relevance/compress/float tests use `text` blocks; tool folding is exercised via
// a real pair.
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeTiers, tierSignature, DEFAULT_CFG } from "./tiers.mjs";
import { buildCommands, snapshotState } from "./commands.mjs";
import { tokensOf } from "./salience.mjs";

let order = 0;
let turn = 0;
function words(n) { return Array(n).fill("alpha").join(" "); }
function block(id, kind, rel, wordCount, extra = {}) {
	const text = words(wordCount);
	return {
		id, kind, turn: ++turn, order: order++, text,
		tokens: tokensOf(text), foldedTokens: 8,
		held: false, folded: false, protected: false, grouped: false,
		_rel: rel, ...extra,
	};
}
const relOf = (b) => b._rel ?? 0;
const noSummary = () => undefined;

function view(blocks, budget, contextWindow = null) {
	return {
		blocks, budget, contextWindow,
		liveTokens: blocks.reduce((s, b) => s + b.tokens, 0),
		protectedFromIndex: blocks.length, protectTokens: 0,
	};
}

test("under budget → hold, nothing folded", () => {
	order = turn = 0;
	const blocks = [block("a", "text", 0.1, 30), block("b", "text", 0.2, 30)];
	const r = computeTiers(view(blocks, 100_000), relOf, noSummary, null, DEFAULT_CFG);
	assert.equal(r.action, "hold");
	assert.equal([...r.levels.values()].filter((l) => l > 0).length, 0);
	assert.equal(r.groups.length, 0);
	assert.equal(buildCommands(r, {}).length, 0);
});

test("over 90% → compress defends the band, coldest folds first, most-relevant stays full", () => {
	order = turn = 0;
	const blocks = [];
	for (let i = 0; i < 10; i++) blocks.push(block(`t${i}`, "text", i / 10, 200));
	blocks.push(block("u", "user", 0.0, 40)); // user never folds
	const budget = 1500; // high=1350, low=900
	const r = computeTiers(view(blocks, budget), relOf, noSummary, null, DEFAULT_CFG);

	assert.equal(r.action, "compress");
	assert.ok(r.rendered <= DEFAULT_CFG.highWater * budget, `rendered ${r.rendered} <= ${DEFAULT_CFG.highWater * budget}`);
	assert.equal(r.levels.get("t9"), 0, "most relevant kept full");
	assert.ok((r.levels.get("t0") ?? 0) >= 1 || r.groups.some((g) => g.unitIds.includes("t0")), "coldest folded");
	assert.ok(!r.candidates.some((u) => u.id === "u"), "user is not a fold candidate");
});

test("stability — re-running on the same view with prev state reproduces tiers (no oscillation)", () => {
	order = turn = 0;
	const blocks = [];
	for (let i = 0; i < 10; i++) blocks.push(block(`t${i}`, "text", i / 10, 200));
	const v = view(blocks, 1500);
	const r1 = computeTiers(v, relOf, noSummary, null, DEFAULT_CFG);
	const sig1 = tierSignature(r1);
	assert.ok([...r1.levels.values()].some((l) => l > 0), "first pass actually folds something");
	const r2 = computeTiers(v, relOf, noSummary, snapshotState(r1), DEFAULT_CFG);
	assert.equal(tierSignature(r2), sig1, "second pass reproduces the same tiers");
});

test("float-up — a clearly-relevant folded block returns; a cold one stays folded", () => {
	order = turn = 0;
	const hot = block("hot", "text", 0.9, 200);
	const cold = block("cold", "text", 0.05, 200);
	const filler = block("fill", "text", 0.5, 30);
	const v = view([hot, cold, filler], 100_000); // headroom → no compression
	const prev = { levels: new Map([["hot", 2], ["cold", 2]]), grouped: new Set() };
	const r = computeTiers(v, relOf, noSummary, prev, DEFAULT_CFG);
	assert.equal(r.action, "floatup");
	assert.equal(r.levels.get("hot"), 1, "hot floats up one tier (2→1)");
	assert.equal(r.levels.get("cold"), 2, "cold stays folded");
});

test("float-up never breaches the 90% ceiling", () => {
	order = turn = 0;
	const hot = block("hot", "text", 0.95, 400);
	const big = block("big", "text", 0.1, 400);
	const v = view([hot, big], Math.round((hot.tokens + big.tokens) / 0.88));
	const prev = { levels: new Map([["hot", 2]]), grouped: new Set() };
	const r = computeTiers(v, relOf, noSummary, prev, DEFAULT_CFG);
	assert.ok(r.rendered <= DEFAULT_CFG.highWater * r.cap + 1, `rendered ${r.rendered} <= high ${DEFAULT_CFG.highWater * r.cap}`);
});

test("tool-pair atomicity — a call/result pair is one unit that moves together", () => {
	order = turn = 0;
	const call = block("c1", "tool_call", 0.1, 10, { callId: "x1" });
	const res = block("r1", "tool_result", 0.1, 300, { callId: "x1" });
	const keep = block("k", "text", 0.99, 300);
	const blocks = [call, res, keep];
	const budget = Math.round(blocks.reduce((s, b) => s + b.tokens, 0) / 1.5);
	const r = computeTiers(view(blocks, budget), relOf, noSummary, null, DEFAULT_CFG);
	const pair = r.candidates.find((u) => u.id === "pair:x1");
	assert.ok(pair, "call+result form one unit");
	assert.equal(pair.blockIds.length, 2, "both blocks move as a unit");
});

test("command mapping — tool_call half of a pair is never emitted as fold/replace", () => {
	order = turn = 0;
	const call = block("c1", "tool_call", 0.01, 10, { callId: "x1" });
	const res = block("r1", "tool_result", 0.01, 300, { callId: "x1" });
	const keep = block("k", "text", 0.99, 300);
	const blocks = [call, res, keep];
	const r = computeTiers(view(blocks, 350), relOf, noSummary, null, DEFAULT_CFG);
	assert.ok((r.levels.get("pair:x1") ?? 0) > 0, "pair is selected for compression");

	const cmds = buildCommands(r, { summaryFor: noSummary, segmentRelevanceFn: () => null });
	assert.ok(cmds.some((c) => c.kind === "fold" && c.ids.includes("r1")), "folds the foldable tool_result");
	assert.ok(!cmds.some((c) => c.kind === "fold" && c.ids.includes("c1")), "does not fold the non-foldable tool_call");
	assert.ok(!cmds.some((c) => c.kind === "replace" && c.id === "c1"), "does not replace the non-foldable tool_call");
});

test("tier signature includes upgraded digest text for stable L2 blocks", () => {
	order = turn = 0;
	const b = block("d1", "text", 0.05, 200);
	const prev = { levels: new Map([["d1", 2]]), grouped: new Set() };
	const r = computeTiers(view([b], 100_000), relOf, noSummary, prev, DEFAULT_CFG);
	assert.equal(r.levels.get("d1"), 2, "block remains at digest tier");

	const before = tierSignature(r, () => undefined);
	const after = tierSignature(r, () => "LLM summary landed later");
	assert.notEqual(after, before, "summary cache upgrade changes the send signature");
});

test("group does not sweep interleaved non-candidate blocks (user turns, held blocks)", () => {
	order = turn = 0;
	const t0 = block("t0", "text", 0.01, 200);
	const t1 = block("t1", "text", 0.01, 200);
	const uMid = block("uMid", "user", 0.0, 20); // user block between two cold L2 candidates
	const t2 = block("t2", "text", 0.01, 200);
	const t3 = block("t3", "text", 0.01, 200);
	const budget = 200; // brutal — compress everything, then group
	const r = computeTiers(view([t0, t1, uMid, t2, t3], budget), relOf, noSummary, null, { ...DEFAULT_CFG, groupMinUnits: 2 });
	for (const g of r.groups) {
		assert.ok(!g.blockIds.includes("uMid"), `group must not include user block (got ${JSON.stringify(g.blockIds)})`);
	}
});

test("compress saving<=0 skips a unit whose digest is larger than the original", () => {
	order = turn = 0;
	// A tiny block (5 words) whose foldedTokens > tokens represents an oversized digest.
	const tiny = block("tiny", "text", 0.01, 5, { foldedTokens: 999 });
	const big = block("big", "text", 0.01, 400);
	const budget = Math.round((tiny.tokens + big.tokens) / 2);
	const r = computeTiers(view([tiny, big], budget), relOf, noSummary, null, DEFAULT_CFG);
	// tiny should NOT be set to L2 (folded would cost more)
	assert.ok((r.levels.get("tiny") ?? 0) < 2, "tiny block with oversized digest is not set to Digest");
});

test("protected + held blocks are never candidates", () => {
	order = turn = 0;
	const prot = block("p", "text", 0.0, 300, { protected: true });
	const held = block("h", "text", 0.0, 300, { held: true });
	const free = block("f", "text", 0.0, 300);
	const r = computeTiers(view([prot, held, free], 200), relOf, noSummary, null, DEFAULT_CFG);
	const ids = r.candidates.map((u) => u.id);
	assert.ok(!ids.includes("p") && !ids.includes("h"), "protected/held excluded");
	assert.ok(ids.includes("f"), "free block is a candidate");
});

test("command mapping — fold+digest and group under deep pressure", () => {
	order = turn = 0;
	const blocks = [];
	for (let i = 0; i < 6; i++) blocks.push(block(`g${i}`, "text", 0.01 * i, 250));
	const r = computeTiers(view(blocks, 400), relOf, noSummary, null, DEFAULT_CFG); // brutal
	const cmds = buildCommands(r, { summaryFor: noSummary, segmentRelevanceFn: () => null });
	const kinds = new Set(cmds.map((c) => c.kind));
	assert.ok(kinds.has("fold") || kinds.has("group"), "emits fold/group under deep pressure");
	for (const c of cmds) {
		if (c.kind === "fold") assert.ok(Array.isArray(c.ids) && typeof c.digest === "string");
		if (c.kind === "replace") assert.ok(typeof c.id === "string" && typeof c.content === "string");
		if (c.kind === "group") assert.ok(Array.isArray(c.ids) && c.ids.length >= 2);
	}
});
