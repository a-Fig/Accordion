/*
 * triptych.test.ts — golden tests for the TriptychConductor's banding, gating, and fold shapes,
 * driven by TestHost (core/conductor/testhost.ts) + canned completions + a FAKE skeletonizer
 * (the real tree-sitter engine has its own suite in skeleton.test.ts; this file tests the
 * conductor's logic, which is engine-agnostic by construction — the engine is injected).
 *
 * Fixture geometry (budget 6000 → TRIGGER high-water mark 5400; thirds of the cap = 2000):
 *   28 blocks, 6000 raw tokens total:
 *     0-9    text, 200 tok each ("OLD-i")            — 2000 tok → the TOP band [0, 10)
 *     10     tool_call c1, 50 tok  (read /proj/src/big.ts)
 *     11     tool_result c1, 800 tok — REAL-shaped code carrying BODY_SENTINEL_A
 *     12     tool_call c2, 50 tok  (read /proj/src/small.ts)
 *     13     tool_result c2, 300 tok — code carrying BODY_SENTINEL_B, below MIN_SKELETON_TOKENS
 *     14-17  text, 200 tok each ("MID-i")            — the MIDDLE band is [10, 18)
 *     18-27  text, 200 tok each ("NEW-i")            — 2000 tok → the BOTTOM band [18, 28)
 *   Walking raw tokens from the tip: cumulative hits 2000 exactly at index 18 (bottomStart) and
 *   4000 exactly at index 10 (topEnd) — so the bands land on clean block edges by construction.
 *   protect 250 keeps protectedFromIndex far above bottomStart, so the tail never interferes.
 */
import { describe, expect, it } from "vitest";
import { TestHost } from "../../../core/conductor/testhost";
import type { Block, BlockKind } from "../../../core/types";
import { TriptychConductor, COMPACTION_SYSTEM, type Skeletonizer } from "./triptych";
import { OVERSHOOT_COOLDOWN_MS } from "../../in-process/agedSummaryConductor";

const BUDGET = 6000; // TRIGGER (0.9) high-water mark = 5400
const PROTECT = 250;

const FOLD_TAG_RE = /\{#[0-9a-z]{6} FOLDED\}/;
const SUMMARY_A = "Alpha summary body.";
const SUMMARY_B = "Beta summary body, updated.";

/** Flush the microtask queue enough for a complete() chain (+ its rerun/propose) to settle. */
async function flush(times = 6): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
}

function mkBlock(id: string, order: number, kind: BlockKind, tokens: number, text: string, extra: Partial<Block> = {}): Block {
	return { id, kind, turn: order + 1, order, text, tokens, override: null, autoFolded: false, by: null, ...extra };
}

const idOf = (idx: number): string => `a:b${idx}:p0`;

/** Real-shaped TS so doorman's classifyCodeRead accepts it (keyword + punctuation + indent) —
 *  and BIG: the conductor's shrink gate compares the labeled skeleton against the block's actual
 *  text, so the fixture needs a genuinely large body for a fold to be worth it. */
const BIG_SOURCE = [
	"import { helper } from './helper';",
	"",
	"export function alpha(a: number, b: number): number {",
	"  const BODY_SENTINEL_A = helper(a) * b;",
	...Array.from({ length: 40 }, (_, i) => `  const step${i} = helper(BODY_SENTINEL_A + ${i});`),
	"  return BODY_SENTINEL_A + 1;",
	"}",
	"",
	"export class Widget {",
	"  render(): string {",
	"    return 'BODY_SENTINEL_A';",
	"  }",
	"}",
].join("\n");

const SMALL_SOURCE = [
	"import { tiny } from './tiny';",
	"export function beta(): number {",
	"  const BODY_SENTINEL_B = tiny();",
	"  return BODY_SENTINEL_B;",
	"}",
].join("\n");

function buildBlocks(): Block[] {
	const blocks: Block[] = [];
	for (let i = 0; i <= 9; i++) blocks.push(mkBlock(idOf(i), i, "text", 200, `OLD-${i}`));
	blocks.push(mkBlock(idOf(10), 10, "tool_call", 50, 'read {"file_path":"/proj/src/big.ts"}', { toolName: "read", callId: "c1" }));
	blocks.push(mkBlock(idOf(11), 11, "tool_result", 800, BIG_SOURCE, { toolName: "read", callId: "c1" }));
	blocks.push(mkBlock(idOf(12), 12, "tool_call", 50, 'read {"file_path":"/proj/src/small.ts"}', { toolName: "read", callId: "c2" }));
	blocks.push(mkBlock(idOf(13), 13, "tool_result", 300, SMALL_SOURCE, { toolName: "read", callId: "c2" }));
	for (let i = 14; i <= 17; i++) blocks.push(mkBlock(idOf(i), i, "text", 200, `MID-${i}`));
	for (let i = 18; i <= 27; i++) blocks.push(mkBlock(idOf(i), i, "text", 200, `NEW-${i}`));
	return blocks;
}

/** A deterministic fake engine. `holdInit` keeps `ready()` false until `releaseInit()`. */
function fakeSkeletonizer(opts: { holdInit?: boolean; skeletonOf?: (path: string | undefined, source: string) => string | null } = {}): {
	skel: Skeletonizer;
	releaseInit: () => void;
} {
	let ready = false;
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const skel: Skeletonizer = {
		init: async () => {
			if (opts.holdInit) await gate;
			ready = true;
		},
		ready: () => ready,
		skeletonize: (path, source) =>
			opts.skeletonOf ? opts.skeletonOf(path, source) : `// SKEL of ${path}\nexport function alpha(a: number, b: number): number { /* ... 3 lines */ }`,
	};
	return { skel, releaseInit: release };
}

function setup(opts: Parameters<typeof fakeSkeletonizer>[0] & { blocks?: Block[]; now?: () => number } = {}): {
	host: TestHost;
	conductor: TriptychConductor;
	releaseInit: () => void;
} {
	const host = new TestHost();
	host.setBudget(BUDGET);
	host.setProtect(PROTECT);
	host.appendBlocks(opts.blocks ?? buildBlocks());
	const { skel, releaseInit } = fakeSkeletonizer(opts);
	const conductor = new TriptychConductor(skel, { now: opts.now });
	conductor.attach(host);
	return { host, conductor, releaseInit };
}

describe("TriptychConductor", () => {
	it("declares the fully-exclusive lock posture (owner decision)", () => {
		const { conductor } = setup();
		expect(conductor.locks).toContain("human-steering");
		expect(conductor.locks).toContain("agent-unfold");
		expect(conductor.locks).not.toContain("tail-size");
	});

	it("is inert below the high-water mark — no folds, no groups, no completions", async () => {
		// Only the first 18 blocks: 4000 raw tokens, well under 5400.
		const { host } = setup({ blocks: buildBlocks().slice(0, 18) });
		await flush();
		await host.commitTurn();
		await flush();
		expect(host.completeLog).toHaveLength(0);
		expect(host.truth.groups).toHaveLength(0);
		for (const b of host.blocks()) expect(b.folded).toBe(false);
	});

	it("first crossing arranges the thirds: lossy top group, labeled skeleton folds in the middle, raw bottom", async () => {
		const { host } = setup();
		host.queueCompletion({ text: SUMMARY_A });
		await flush();
		await host.commitTurn();
		await flush();

		// The summary call: compaction-naive's system prompt VERBATIM; only the top band fed in.
		expect(host.completeLog).toHaveLength(1);
		expect(host.completeLog[0].system).toBe(COMPACTION_SYSTEM);
		const prompt = host.completeLog[0].prompt;
		for (let i = 0; i <= 9; i++) expect(prompt).toContain(`OLD-${i}`);
		expect(prompt).not.toContain("MID-");
		expect(prompt).not.toContain("NEW-");
		expect(prompt).not.toContain("BODY_SENTINEL_A");

		// The top band became ONE lossy group: verbatim digest, count preamble, NO fold tag.
		expect(host.truth.groups).toHaveLength(1);
		const g = host.truth.groups[0];
		expect(g.memberIds).toEqual(Array.from({ length: 10 }, (_, i) => idOf(i)));
		expect(g.digest).toContain("[Compacted summary of 10 earlier messages]");
		expect(g.digest).toContain(SUMMARY_A);
		expect(g.digest).not.toMatch(FOLD_TAG_RE);

		// The big middle-band code read became a TAGGED, labeled skeleton fold.
		const big = host.truth.get(idOf(11))!;
		expect(host.get(idOf(11))!.folded).toBe(true);
		expect(big.subst).toBeDefined();
		expect(big.subst!).toMatch(new RegExp(`^${FOLD_TAG_RE.source}`));
		expect(big.subst!).toContain("[code skeleton of /proj/src/big.ts");
		expect(big.subst!).toContain("SKEL of /proj/src/big.ts");
		expect(big.subst!).not.toContain("BODY_SENTINEL_A");

		// Everything else rides untouched: the small code read (below the size floor), the
		// middle-band prose, and the whole bottom band.
		expect(host.get(idOf(13))!.folded).toBe(false);
		for (let i = 14; i <= 27; i++) expect(host.get(idOf(i))!.folded).toBe(false);
	});

	it("decline-to-fold: a skeleton that doesn't shrink the block leaves it live", async () => {
		const { host } = setup({ skeletonOf: (_path, source) => source }); // "skeleton" = full source
		host.queueCompletion({ text: SUMMARY_A });
		await flush();
		await host.commitTurn();
		await flush();
		expect(host.truth.groups).toHaveLength(1); // the summary still runs
		expect(host.get(idOf(11))!.folded).toBe(false); // but the code read was declined
		expect(host.truth.get(idOf(11))!.subst).toBeUndefined();
	});

	it("engine not ready: summaries-only, then skeletons land when init resolves", async () => {
		const { host, releaseInit } = setup({ holdInit: true });
		host.queueCompletion({ text: SUMMARY_A });
		await flush();
		await host.commitTurn();
		await flush();
		expect(host.truth.groups).toHaveLength(1); // summary machinery unaffected
		expect(host.get(idOf(11))!.folded).toBe(false); // no engine, no skeleton

		releaseInit();
		await flush(10); // init resolve → conductor rerun → propose
		expect(host.get(idOf(11))!.folded).toBe(true);
		expect(host.truth.get(idOf(11))!.subst!).toContain("[code skeleton of /proj/src/big.ts");
	});

	it("recursive pass feeds the summarizer the SKELETON of aged code, never the body", async () => {
		const { host } = setup();
		host.queueCompletion({ text: SUMMARY_A });
		await flush();
		await host.commitTurn();
		await flush();
		expect(host.truth.groups).toHaveLength(1);

		// Age the code reads into the top band: +15 fresh 200-tok blocks (raw total 9000; visible
		// after the group + skeleton savings sits back above the 5400 mark, so a recursive summary
		// launches; the 2/3 boundary lands at index 23, sweeping blocks 10-22 into newlyAged).
		host.appendBlocks(Array.from({ length: 15 }, (_, i) => mkBlock(idOf(28 + i), 28 + i, "text", 200, `NEW2-${28 + i}`)));
		host.queueCompletion({ text: SUMMARY_B });
		await host.commitTurn();
		await flush();

		expect(host.completeLog).toHaveLength(2);
		const prompt = host.completeLog[1].prompt;
		expect(prompt).toContain("<previous-summary>");
		expect(prompt).toContain(SUMMARY_A);
		// The skeletonized read contributes its skeleton; the never-skeletonized small read
		// contributes its full body — proving promptTextOf swaps exactly the folded ones.
		expect(prompt).toContain("[code skeleton of /proj/src/big.ts");
		expect(prompt).not.toContain("BODY_SENTINEL_A");
		expect(prompt).toContain("BODY_SENTINEL_B");

		// After the recursive commit the code read is swallowed into the (still lossy) group.
		const grouped = host.truth.groups.some((g) => g.memberIds.includes(idOf(11)));
		expect(grouped).toBe(true);
		for (const g of host.truth.groups) expect(g.digest ?? "").not.toMatch(FOLD_TAG_RE);
	});

	it("snaps the top-band boundary to a message edge — the lossy group never swallows un-summarized parts", async () => {
		// Adversarial-review regression: 30 blocks × 200 tok (raw 6000 ≥ 5400 trigger); the raw
		// 2·cap/3 crossing lands at index 10, which BISECTS a two-part assistant message (blocks 9
		// and 10 share the message key "a:msplit"). Truth's `group` op snaps outward to whole
		// messages, so an unsnapped boundary would swallow part p1 into the lossy group even though
		// the summarizer never saw it. The fix snaps topEnd down to 9: the whole message stays in
		// the middle band, and neither part is summarized or grouped this round.
		const blocks: Block[] = [];
		for (let i = 0; i <= 8; i++) blocks.push(mkBlock(`a:m${i}:p0`, i, "text", 200, `OLD-${i}`));
		blocks.push(mkBlock("a:msplit:p0", 9, "thinking", 200, "SECRET-THINKING"));
		blocks.push(mkBlock("a:msplit:p1", 10, "text", 200, "SECRET-TEXT"));
		for (let i = 11; i <= 29; i++) blocks.push(mkBlock(`a:m${i}:p0`, i, "text", 200, `NEW-${i}`));

		const host = new TestHost();
		host.setBudget(BUDGET);
		host.setProtect(PROTECT);
		host.appendBlocks(blocks);
		host.queueCompletion({ text: SUMMARY_A });
		const { skel } = fakeSkeletonizer();
		const conductor = new TriptychConductor(skel);
		conductor.attach(host);
		await flush();
		await host.commitTurn();
		await flush();

		expect(host.completeLog).toHaveLength(1);
		const prompt = host.completeLog[0].prompt;
		expect(prompt).toContain("OLD-8");
		expect(prompt).not.toContain("SECRET-THINKING"); // snapped out of the aged region…
		expect(prompt).not.toContain("SECRET-TEXT");
		expect(host.truth.groups).toHaveLength(1);
		const members = host.truth.groups[0].memberIds;
		expect(members).not.toContain("a:msplit:p0"); // …and out of the group
		expect(members).not.toContain("a:msplit:p1");
	});

	it("a skeleton-engine init failure stays sticky on the status bar across idle passes", async () => {
		// Adversarial-review regression: the failure used to be a bare setStatus, wiped by the very
		// next idle pass's surfaceIdleStatus(null). It now joins the base class's sticky
		// failureStatus mechanism.
		const skel: Skeletonizer = {
			init: async () => {
				throw new Error("wasm load exploded");
			},
			ready: () => false,
			skeletonize: () => null,
		};
		const host = new TestHost();
		host.setBudget(BUDGET);
		host.setProtect(PROTECT);
		host.appendBlocks([mkBlock(idOf(0), 0, "text", 200, "hello")]); // far below the trigger
		const conductor = new TriptychConductor(skel);
		conductor.attach(host);
		await flush();
		expect(host.statusLog.some((s) => s.text?.includes("skeleton engine failed to load"))).toBe(true);
		await host.commitTurn(); // idle pass — used to wipe the message
		await flush();
		const last = host.statusLog[host.statusLog.length - 1];
		expect(last.text).toContain("skeleton engine failed to load");
	});
});

describe("TriptychConductor — sustained OVERSHOOT widens the summarizable band", () => {
	// OVERSHOOT (1.15) x the 6000 cap = 6900. Extra 200-token prose blocks appended after the
	// 28-block fixture; each one moves both band boundaries one block toward the tip.
	const extra = (from: number, n: number): Block[] =>
		Array.from({ length: n }, (_, i) => mkBlock(idOf(from + i), from + i, "text", 200, `NEW-${from + i}`));

	it("at/over OVERSHOOT the boundary falls back to the middle band's end — top + middle summarized, bottom raw", async () => {
		// 34 blocks, 7200 raw: bottom band [24, 34), middle [14, 24), top [0, 14).
		const { host } = setup({ blocks: [...buildBlocks(), ...extra(28, 6)] });
		host.queueCompletion({ text: SUMMARY_A });
		await flush();
		await host.commitTurn();
		await flush();

		expect(host.completeLog).toHaveLength(1);
		const prompt = host.completeLog[0].prompt;
		for (let i = 0; i <= 9; i++) expect(prompt).toContain(`OLD-${i}`);
		for (let i = 14; i <= 17; i++) expect(prompt).toContain(`MID-${i}`); // the middle band…
		for (let i = 18; i <= 23; i++) expect(prompt).toContain(`NEW-${i}`);
		for (let i = 24; i <= 33; i++) expect(prompt).not.toContain(`NEW-${i}`); // …but never the bottom band

		expect(host.truth.groups).toHaveLength(1);
		const members = host.truth.groups[0].memberIds;
		expect(members).toContain(idOf(23));
		expect(members).not.toContain(idOf(24));
		expect(host.truth.groups[0].digest).not.toMatch(FOLD_TAG_RE); // still the one lossy group
	});

	it("just under OVERSHOOT the thirds are untouched — only the top band is summarized", async () => {
		// 31 blocks, 6600 raw: over the 5400 trigger, under the 6900 overshoot mark.
		const { host } = setup({ blocks: [...buildBlocks(), ...extra(28, 3)] });
		host.queueCompletion({ text: SUMMARY_A });
		await flush();
		await host.commitTurn();
		await flush();

		expect(host.completeLog).toHaveLength(1);
		const prompt = host.completeLog[0].prompt;
		for (let i = 0; i <= 9; i++) expect(prompt).toContain(`OLD-${i}`);
		expect(prompt).not.toContain("MID-");
		expect(prompt).not.toContain("NEW-");
		expect(host.truth.groups[0].memberIds).not.toContain(idOf(14));
	});

	it("once widened, the group does not shrink back to the top band when the wire drops under the mark", async () => {
		const { host } = setup({ blocks: [...buildBlocks(), ...extra(28, 6)] });
		host.queueCompletion({ text: SUMMARY_A });
		await flush();
		await host.commitTurn();
		await flush();
		expect(host.truth.groups[0].memberIds).toContain(idOf(23));

		// Well under the trigger now. Plain thirds would put the boundary back at the top band's end
		// (index 14, then 16) and re-emit a group holding only [0, 14) — the middle band's already
		// summarized content would reappear on the wire and the next crossing would summarize it again.
		await host.commitTurn();
		await flush();
		host.appendBlocks(extra(34, 2));
		await host.commitTurn();
		await flush();

		expect(host.truth.liveTokens()).toBeLessThan(BUDGET * 0.9);
		expect(host.completeLog).toHaveLength(1);
		expect(host.truth.groups).toHaveLength(1);
		const members = host.truth.groups[0].memberIds;
		for (let i = 0; i <= 23; i++) expect(members).toContain(idOf(i));
		expect(members).not.toContain(idOf(24));
	});

	it("a latched triptych is freed at OVERSHOOT — by the widened band's refill, then by the cooldown un-latch", async () => {
		const clock = { t: 1_000_000 };
		const oversized = (n: number): string => "S".repeat(n); // an oversized "summary" (≈ n/4 tokens)
		// No skeletons, and a summary BIGGER than the 2000-token top band it replaces: the first pass
		// grows the wire, so the paid-retry back-off latches with a 2000-token refill bar.
		const { host } = setup({ skeletonOf: () => null, now: () => clock.t });
		host.queueCompletion({ text: oversized(8200) });
		await flush();
		await host.commitTurn();
		await flush();
		expect(host.completeLog).toHaveLength(1);
		expect(host.truth.liveTokens()).toBeGreaterThan(6000);

		// One more block: only the 50-token tool_call ages into the top band — latched, and it says so.
		host.appendBlocks(extra(28, 1));
		await host.commitTurn();
		await flush();
		expect(host.completeLog).toHaveLength(1);
		expect(host.statusLog[host.statusLog.length - 1].text).toMatch(
			/^Triptych back-off: last pass grew the wire \d+ tok; waiting for refill \(50\/2000 tok newly aged\)$/,
		);

		// Four more: over 6900. The boundary widens to the bottom band (33 blocks → [0, 23)), which ages
		// in 3000 tokens at once — past the 2000-token bar, so this is an ordinary REFILL launch, with
		// no cooldown involved. (Pre-fix the thirds would have aged in only the 850-token code reads.)
		host.appendBlocks(extra(29, 4));
		expect(host.truth.liveTokens()).toBeGreaterThanOrEqual(6900);
		// Unproductive AGAIN: ≈ 5060 tokens replacing the 5000-token region. The bar is now 5000.
		host.queueCompletion({ text: oversized(20200) });
		await host.commitTurn();
		await flush();
		expect(host.completeLog).toHaveLength(2);
		expect(host.statusLog.some((s) => s.text?.includes("overshoot un-latch"))).toBe(false);
		const widened = host.completeLog[1].prompt;
		expect(widened).toContain("MID-14"); // the widened band reaches past the top third…
		expect(widened).toContain("NEW-22");
		expect(widened).not.toContain("NEW-23"); // …and stops at the bottom band [23, 33)
		expect(host.truth.liveTokens()).toBeGreaterThanOrEqual(6900); // still overshooting

		// Now only 200 tokens age in per block against a 5000-token bar: latched for good — except that
		// past OVERSHOOT it is released once the cooldown since the last settle has run out.
		host.appendBlocks(extra(33, 1));
		await host.commitTurn();
		await flush();
		expect(host.completeLog).toHaveLength(2);
		expect(host.statusLog[host.statusLog.length - 1].text).toMatch(
			/^Triptych back-off: last pass (saved|grew the wire) \d+ tok; waiting for refill \(200\/5000 tok newly aged\) — over 1\.15x cap, overshoot retry in 45s$/,
		);

		clock.t += OVERSHOOT_COOLDOWN_MS;
		host.queueCompletion({ text: SUMMARY_B });
		await host.commitTurn();
		await flush();
		expect(host.completeLog).toHaveLength(3);
		expect(host.statusLog.some((s) => /^Triptych overshoot un-latch: visible \d+ tok ≥ 1\.15x cap 6000; re-summarizing despite back-off$/.test(s.text ?? ""))).toBe(true);
		const prompt = host.completeLog[2].prompt;
		expect(prompt).toContain("<previous-summary>");
		expect(prompt).toContain("NEW-23");
		expect(prompt).not.toContain("NEW-24"); // 34 blocks → bottom band [24, 34)
		expect(host.truth.liveTokens()).toBeLessThan(BUDGET);
	});
});
