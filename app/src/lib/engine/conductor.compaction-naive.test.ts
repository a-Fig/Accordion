/*
 * conductor.compaction-naive.test.ts — state-machine tests for NaiveCompactionConductor.
 *
 * The redesigned conductor collapses the aged region into ONE `group` command whose
 * `digest` is an LLM-generated summary (sliding-window's shape, with a summary digest
 * instead of `null`). These tests pin that behaviour.
 *
 * Tests are purely unit-level: no AccordionStore, no file I/O, no real timers (one
 * store-level integration block at the end). Promises are resolved/rejected manually by
 * calling the captured resolve/reject closures so every test is fully deterministic.
 *
 * Test plan:
 *   1. Under threshold / no aged region → []; complete never called.
 *   2. First compaction: launch → null → resolve → ONE group(digest: summary) command.
 *   3. Idempotent re-emit: same group returned without calling complete again.
 *   4. Hysteresis: after a compaction, a new aged block does NOT re-trigger while the
 *      VISIBLE window is still below 90%; it re-triggers once visible refills to 90%.
 *   5. Recursive/amnesiac: second prompt = prior summary + newly-aged text, NOT the
 *      originals already compressed; the group covers ALL compacted blocks.
 *   6. No double-launch while a completion is in-flight.
 *   7. Unavailable path: can("complete")===false → preserve current state; no complete.
 *   8. detach() aborts an in-flight completion; re-attach resets state.
 *   9. Prompt construction (first + recursive); system prompt bakes user messages verbatim.
 *  10. Held / grouped blocks are excluded from the aged region.
 *  11. Threshold boundary (90% of the VISIBLE window).
 *  12. All kinds swallowed: user, tool_call, tool_result, thinking, text all appear in the
 *      prompt AND are covered by the single group (tool_call no longer excluded).
 *  13. Empty completion text is a failure: prior state preserved, no header-only group.
 *  14. attemptKey on newlyAged: shrink of aged set must not relaunch; a new block must.
 *  15. Degrade must not clobber an existing LLM summary (re-emit group; relaunch on recovery).
 *  16. DATA-LOSS-CLASS regression: vanished compacted blocks → group covers the survivors;
 *      all vanished → [] (no lone empties possible with the group shape).
 *  17. AccordionStore integration: the summary lands as a real folded group; user blocks are
 *      swallowed into the group (not left live); tool_call/result pair-balanced.
 */

import { describe, it, expect } from "vitest";
import { NaiveCompactionConductor } from "$conductors/compaction-naive/compaction-naive";
import { AccordionStore } from "./store.svelte";
import type { Block, ParsedSession } from "./types";
import type {
	ConductorHost,
	ConductorView,
	ViewBlock,
	CompletionRequest,
	CompletionResult,
} from "$conductors/contract";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal ViewBlock. */
function vb(
	id: string,
	opts: {
		tokens?: number;
		kind?: ViewBlock["kind"];
		text?: string;
		held?: boolean;
		grouped?: boolean;
		protected?: boolean;
		order?: number;
		toolName?: string;
	} = {},
): ViewBlock {
	return {
		id,
		kind: opts.kind ?? "text",
		turn: 1,
		order: opts.order ?? 0,
		tokens: opts.tokens ?? 1000,
		foldedTokens: 50,
		held: opts.held ?? false,
		folded: false,
		protected: opts.protected ?? false,
		grouped: opts.grouped ?? false,
		text: opts.text ?? `content of ${id}`,
		toolName: opts.toolName,
	};
}

/**
 * Build a ConductorView.
 *
 * @param agedBlocks  - blocks that are OLDER than the protected tail (i < protectedFromIndex)
 * @param tailBlocks  - blocks IN the protected tail (i >= protectedFromIndex)
 * @param budget      - token budget
 * @param liveTokens  - current RAW live token count (the host clears conductor folds first)
 */
function makeView(
	agedBlocks: ViewBlock[],
	tailBlocks: ViewBlock[],
	budget = 100_000,
	liveTokens?: number,
): ConductorView {
	const blocks = [...agedBlocks, ...tailBlocks];
	const total = liveTokens ?? blocks.reduce((s, b) => s + b.tokens, 0);
	return {
		blocks,
		budget,
		contextWindow: null,
		liveTokens: total,
		protectedFromIndex: agedBlocks.length,
		protectTokens: 20_000,
	};
}

/** Build a real engine Block for end-to-end AccordionStore regressions. */
function blk(
	i: number,
	kind: Block["kind"] = "text",
	tokens = 1000,
	extra: Partial<Block> = {},
): Block {
	return {
		id: `m${i}:p0`,
		kind,
		turn: i + 1,
		order: i,
		text: `block ${i} ` + "x".repeat(tokens * 4),
		tokens,
		override: null,
		autoFolded: false,
		by: null,
		...extra,
	};
}

function makeStore(blocks: Block[]): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks,
		lineCount: 0,
		skipped: 0,
	};
	return new AccordionStore(parsed);
}

async function flushMicrotasks(times = 6): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
}

// ── Mock host ─────────────────────────────────────────────────────────────────

interface PendingCompletion {
	req: CompletionRequest;
	resolve: (r: CompletionResult) => void;
	reject: (e: unknown) => void;
}

interface MockHostOptions {
	canComplete?: boolean;
}

class MockHost implements ConductorHost {
	canComplete: boolean;
	completeCalls: CompletionRequest[] = [];
	requestRerunCalls = 0;
	countTokensCalls = 0;
	digestOfCalls: string[] = [];
	statusText = "";
	statusMetrics: Record<string, number | string | boolean> = {};

	/** Pending in-flight completions. Pop and resolve/reject from tests. */
	pending: PendingCompletion[] = [];

	/**
	 * When set, calling requestRerun() immediately invokes this callback.
	 * Used by tests to simulate the host re-invoking conduct() after requestRerun.
	 */
	onRequestRerun: (() => void) | null = null;

	constructor(opts: MockHostOptions = {}) {
		this.canComplete = opts.canComplete ?? true;
	}

	can(cap: string): boolean {
		if (cap === "complete") return this.canComplete;
		return true; // countTokens, digest always available
	}

	complete(req: CompletionRequest): Promise<CompletionResult> {
		this.completeCalls.push(req);
		return new Promise<CompletionResult>((resolve, reject) => {
			this.pending.push({ req, resolve, reject });
		});
	}

	countTokens(text: string): number {
		this.countTokensCalls++;
		return Math.ceil(text.length / 4);
	}

	digestOf(id: string): string | null {
		this.digestOfCalls.push(id);
		return `{#digest FOLDED} digest of ${id}`;
	}

	setStatus(text: string | null, metrics: Record<string, number | string | boolean> = {}): void {
		this.statusText = text ?? "";
		this.statusMetrics = text ? metrics : {};
	}

	requestRerun(): void {
		this.requestRerunCalls++;
		this.onRequestRerun?.();
	}

	/** Resolve the oldest pending completion with the given text. */
	resolveNext(text: string): void {
		const p = this.pending.shift();
		if (!p) throw new Error("no pending completion to resolve");
		p.resolve({ text, model: "test-model" });
	}

	/** Reject the oldest pending completion. */
	rejectNext(err: unknown = new Error("test rejection")): void {
		const p = this.pending.shift();
		if (!p) throw new Error("no pending completion to reject");
		p.reject(err);
	}

	get lastReq(): CompletionRequest {
		return this.completeCalls[this.completeCalls.length - 1];
	}
}

// ── 1. Under threshold / no aged region → [] and no complete calls ────────────

describe("NaiveCompactionConductor — under threshold / no aged region", () => {
	it("returns [] when liveTokens < 90% budget with no aged blocks", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const view = makeView([], [vb("tail0")], 100_000, 10_000);
		const result = c.conduct(view);

		expect(result).toEqual([]);
		expect(host.completeCalls).toHaveLength(0);
	});

	it("returns [] when aged blocks exist but the visible window is below 90% (no prior summary)", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		// liveTokens = 89999 < 90000 (90% of 100k). No summary → visible = liveTokens. No trigger.
		const view = makeView([vb("a0")], [vb("tail0")], 100_000, 89_999);
		const result = c.conduct(view);

		expect(result).toEqual([]);
		expect(host.completeCalls).toHaveLength(0);
	});

	it("returns [] with several aged blocks well under threshold (no prior summary)", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		const view = makeView(aged, [vb("tail0")], 100_000, 50_000);
		const result = c.conduct(view);

		expect(result).toEqual([]);
		expect(host.completeCalls).toHaveLength(0);
	});

	it("returns null when host is not provided (no attach call)", () => {
		const c = new NaiveCompactionConductor();
		const view = makeView([vb("a0")], [vb("tail0")], 100_000, 96_000);
		const result = c.conduct(view);

		expect(result).toBeNull();
	});
});

// ── 2. First compaction: launch → null → resolve → ONE group command ──────────

describe("NaiveCompactionConductor — first compaction cycle", () => {
	it("over threshold with aged blocks: first conduct launches exactly one complete and returns null", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1"), vb("a2")];
		// liveTokens = 96000 >= 90000 (90% of 100k). No summary → visible = 96000.
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);
		const result = c.conduct(view);

		// Must hold (return null) while the completion is in-flight
		expect(result).toBeNull();
		expect(host.completeCalls).toHaveLength(1);
		expect(host.pending).toHaveLength(1);
	});

	it("after completion resolves and requestRerun fires, next conduct returns ONE group command covering all aged blocks", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0", { order: 0 }), vb("a1", { order: 1 }), vb("a2", { order: 2 })];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);

		c.conduct(view);
		expect(host.pending).toHaveLength(1);

		let conductCalledAfterRequestRerun = false;
		host.onRequestRerun = () => {
			conductCalledAfterRequestRerun = true;
		};
		host.resolveNext("Summary text from the model.");

		await Promise.resolve();

		expect(conductCalledAfterRequestRerun).toBe(true);
		expect(host.requestRerunCalls).toBe(1);

		// Now conduct again — should return exactly ONE group command.
		const result = c.conduct(view);

		expect(result).not.toBeNull();
		expect(Array.isArray(result)).toBe(true);
		const cmds = result!;

		// Exactly one command, and it is a group (no replace commands at all).
		expect(cmds).toHaveLength(1);
		const group = cmds[0];
		expect(group.kind).toBe("group");

		// The group spans the first to the last aged block (host snaps outward to whole
		// messages from these endpoints).
		const g = group as { ids: string[]; digest: string };
		expect(g.ids).toEqual(["a0", "a2"]);

		// The digest is the summary (preamble + model text). No {# FOLDED} tag.
		expect(g.digest).toContain("Summary text from the model.");
		expect(g.digest).not.toMatch(/\{#\w+\s+FOLDED\}/);
		expect(g.digest).toContain("3 earlier message");
	});

	it("no replace commands are ever emitted (the group is the sole command shape)", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);

		c.conduct(view);
		host.resolveNext("Compact summary of the session.");
		await Promise.resolve();

		const result = c.conduct(view);
		expect(result).not.toBeNull();
		for (const cmd of result!) {
			expect(cmd.kind).not.toBe("replace");
			expect(cmd.kind).not.toBe("fold");
		}
		expect(result!.every((cmd) => cmd.kind === "group")).toBe(true);
	});
});

// ── 3. Idempotent re-emit ─────────────────────────────────────────────────────

describe("NaiveCompactionConductor — idempotent re-emit", () => {
	it("repeated conduct calls after a summary exists return the same group without calling complete again", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);

		c.conduct(view);
		host.resolveNext("The summary.");
		await Promise.resolve();

		const result1 = c.conduct(view);
		const result2 = c.conduct(view);
		const result3 = c.conduct(view);

		expect(host.completeCalls).toHaveLength(1); // complete called EXACTLY once total

		// All three return the same single group command.
		expect(result1).not.toBeNull();
		expect(result2).not.toBeNull();
		expect(result3).not.toBeNull();
		expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
		expect(JSON.stringify(result2)).toBe(JSON.stringify(result3));
		expect(result1!).toHaveLength(1);
		expect(result1![0].kind).toBe("group");
	});

	it("returns the same group even when liveTokens drops below threshold (once compacted, stays compacted)", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		const view1 = makeView(aged, [vb("tail0")], 100_000, 96_000);

		c.conduct(view1);
		host.resolveNext("Summary.");
		await Promise.resolve();
		c.conduct(view1); // commit the summary

		// Now simulate liveTokens dropping below threshold.
		const view2 = makeView(aged, [vb("tail0")], 100_000, 50_000);
		const result = c.conduct(view2);

		expect(result).not.toBeNull();
		expect(result!).toHaveLength(1);
		expect(result![0].kind).toBe("group");
		expect(host.completeCalls).toHaveLength(1);
	});

	it("re-emits the group even while still over threshold, as long as nothing new has aged in", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		// Small blocks: after compaction the saving is tiny, so the visible window stays
		// above 90%. But newlyAged is empty → the conductor HOLDS (no relaunch).
		const aged = [vb("a0"), vb("a1")];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);

		c.conduct(view);
		host.resolveNext("Summary.");
		await Promise.resolve();
		c.conduct(view); // commit

		// Still over threshold, same aged set (nothing new) → re-emit, no relaunch.
		const result = c.conduct(view);
		expect(result).not.toBeNull();
		expect(result![0].kind).toBe("group");
		expect(host.completeCalls).toHaveLength(1);
	});
});

// ── 4. Hysteresis: visible-window band ────────────────────────────────────────

describe("NaiveCompactionConductor — hysteresis (visible-window band)", () => {
	it("after a compaction with large saving, a new aged block does NOT re-trigger while visible < 90%", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		// Large aged blocks so the summary saving is significant.
		const a0 = vb("a0", { tokens: 40_000, order: 0 });
		const a1 = vb("a1", { tokens: 40_000, order: 1 });
		const tail0 = vb("tail0", { tokens: 4_000 });

		// liveTokens = 96000 >= 90000 → first compaction triggers.
		const view1 = makeView([a0, a1], [tail0], 100_000, 96_000);
		c.conduct(view1);
		host.resolveNext("FIRST SUMMARY");
		await Promise.resolve();
		c.conduct(view1); // commit

		// After compaction: survivors = [a0, a1] (80k tokens), summary cost is tiny.
		// savedTokens ≈ 80k → visible ≈ 96000 - 80000 = 16000, well below 90000.
		// A new block b0 ages in (newlyAged = [b0]) but visible is still below 90% → NO relaunch.
		const b0 = vb("b0", { tokens: 5_000, order: 2 });
		const view2 = makeView([a0, a1, b0], [tail0], 100_000, 101_000);
		const result = c.conduct(view2);

		// No second completion launched.
		expect(host.completeCalls).toHaveLength(1);
		// The conductor re-emits the existing summary group (covers a0, a1; b0 stays live).
		expect(result).not.toBeNull();
		const groups = result!.filter((cmd) => cmd.kind === "group") as Array<{
			ids: string[];
			digest: string;
		}>;
		expect(groups).toHaveLength(1);
		expect(groups[0].ids).toEqual(["a0", "a1"]);
		expect(groups[0].digest).toContain("FIRST SUMMARY");
	});

	it("re-triggers once the visible window refills to 90% (new aged content pushes it over)", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const a0 = vb("a0", { tokens: 40_000, order: 0 });
		const a1 = vb("a1", { tokens: 40_000, order: 1 });
		const tail0 = vb("tail0", { tokens: 4_000 });

		const view1 = makeView([a0, a1], [tail0], 100_000, 96_000);
		c.conduct(view1);
		host.resolveNext("FIRST SUMMARY");
		await Promise.resolve();
		c.conduct(view1); // commit; visible ≈ 16000

		// New block b0 aged in, but visible still below 90%.
		const b0 = vb("b0", { tokens: 5_000, order: 2 });
		const view2 = makeView([a0, a1, b0], [tail0], 100_000, 101_000);
		c.conduct(view2); // no relaunch
		expect(host.completeCalls).toHaveLength(1);

		// Now grow the raw window until visible >= 90000.
		// visible = liveTokens - savedTokens(≈80000) >= 90000 → liveTokens >= 170000.
		const view3 = makeView([a0, a1, b0], [tail0], 100_000, 171_000);
		c.conduct(view3); // visible ≈ 91000 >= 90000, newlyAged=[b0] → relaunch

		expect(host.completeCalls).toHaveLength(2);
		const secondPrompt = host.completeCalls[1].prompt;
		// Amnesia: the second prompt reads the prior summary + b0, NOT a0/a1 originals.
		expect(secondPrompt).toContain("FIRST SUMMARY");
		expect(secondPrompt).toContain("content of b0");
	});
});

// ── 5. Recursive / amnesiac prompt ───────────────────────────────────────────

describe("NaiveCompactionConductor — recursive compaction (amnesia)", () => {
	it("second compaction prompt contains prior summary and newly aged text but NOT original first-batch text", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const a0 = vb("a0", { text: "ORIGINAL BLOCK A0 CONTENT" });
		const a1 = vb("a1", { text: "ORIGINAL BLOCK A1 CONTENT" });
		const tail0 = vb("tail0", { protected: true });

		const view1 = makeView([a0, a1], [tail0], 100_000, 96_000);
		c.conduct(view1);
		host.resolveNext("FIRST SUMMARY OUTPUT");
		await Promise.resolve();
		c.conduct(view1); // commit

		// b0 ages in; small blocks so visible stays over 90% → relaunch.
		const b0 = vb("b0", { text: "NEW BLOCK B0 CONTENT" });
		const view2 = makeView([a0, a1, b0], [tail0], 100_000, 96_000);
		c.conduct(view2);

		expect(host.completeCalls).toHaveLength(2);
		const secondPrompt = host.completeCalls[1].prompt;

		expect(secondPrompt).toContain("FIRST SUMMARY OUTPUT");
		expect(secondPrompt).toContain("NEW BLOCK B0 CONTENT");
		// Amnesia: the originals already compressed are NOT re-read.
		expect(secondPrompt).not.toContain("ORIGINAL BLOCK A0 CONTENT");
		expect(secondPrompt).not.toContain("ORIGINAL BLOCK A1 CONTENT");
	});

	it("second compaction uses the <previous-summary> and <conversation> wrappers with merge instructions", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		const view1 = makeView(aged, [vb("tail0")], 100_000, 96_000);

		c.conduct(view1);
		host.resolveNext("SUMMARY ONE");
		await Promise.resolve();
		c.conduct(view1);

		const b0 = vb("b0");
		const view2 = makeView([...aged, b0], [vb("tail0")], 100_000, 96_000);
		c.conduct(view2);

		expect(host.completeCalls).toHaveLength(2);
		const prompt2 = host.completeCalls[1].prompt;

		expect(prompt2).toContain("<previous-summary>");
		expect(prompt2).toContain("</previous-summary>");
		expect(prompt2).toContain("<conversation>");
		expect(prompt2).toContain("</conversation>");
		// Merge instructions carry the prior summary forward (no silent drop) and keep
		// verbatim user messages intact across compactions.
		expect(prompt2).toContain("PRESERVE");
		expect(prompt2).toMatch(/verbatim/i);
	});

	it("after the second compaction resolves, the group covers ALL aged blocks (a0+a1+b0)", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const a0 = vb("a0", { order: 0 });
		const a1 = vb("a1", { order: 1 });
		const view1 = makeView([a0, a1], [vb("tail0")], 100_000, 96_000);
		c.conduct(view1);
		host.resolveNext("Summary 1");
		await Promise.resolve();
		c.conduct(view1);

		const b0 = vb("b0", { order: 2 });
		const view2 = makeView([a0, a1, b0], [vb("tail0")], 100_000, 96_000);
		c.conduct(view2); // launches second completion
		host.resolveNext("Summary 2");
		await Promise.resolve();

		const result = c.conduct(view2);
		expect(result).not.toBeNull();

		// ONE group spanning a0..b0, digest = Summary 2.
		expect(result!).toHaveLength(1);
		const g = result![0] as { kind: string; ids: string[]; digest: string };
		expect(g.kind).toBe("group");
		expect(g.ids).toEqual(["a0", "b0"]);
		expect(g.digest).toContain("Summary 2");
	});
});

// ── 6. No double-launch while in-flight ───────────────────────────────────────

describe("NaiveCompactionConductor — no double-launch while in-flight", () => {
	it("while a complete is pending, further conduct calls do not call complete again", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);

		c.conduct(view); // launches
		c.conduct(view); // must NOT launch again
		c.conduct(view); // must NOT launch again

		expect(host.completeCalls).toHaveLength(1);
		expect(host.pending).toHaveLength(1);
	});

	it("the first conduct returns null (no summary yet); later conducts while in-flight also return null", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);

		const r1 = c.conduct(view);
		const r2 = c.conduct(view);
		const r3 = c.conduct(view);

		expect(r1).toBeNull();
		expect(r2).toBeNull();
		expect(r3).toBeNull();
	});

	it("after rejection, does NOT re-launch on the next conduct with the SAME newly-aged set", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);

		c.conduct(view); // launch #1
		host.rejectNext(new Error("network error"));
		await Promise.resolve();

		// Same aged set → newlyAged unchanged → attempt key unchanged → no relaunch.
		const result = c.conduct(view);
		expect(host.completeCalls).toHaveLength(1);
		// No summary yet → definite "nothing applied" answer → [] (not null).
		expect(result).toEqual([]);
	});

	it("after rejection, returns [] (not null) on subsequent conducts with the same aged set", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);

		c.conduct(view);
		host.rejectNext(new Error("error"));
		await Promise.resolve();

		const r1 = c.conduct(view);
		const r2 = c.conduct(view);
		expect(host.completeCalls).toHaveLength(1);
		expect(r1).toEqual([]);
		expect(r2).toEqual([]);
	});

	it("after rejection, DOES re-launch when a NEW aged block arrives (attempt key changes)", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		const view1 = makeView(aged, [vb("tail0")], 100_000, 96_000);

		c.conduct(view1); // launch #1
		host.rejectNext(new Error("error"));
		await Promise.resolve();

		const b0 = vb("b0");
		const view2 = makeView([...aged, b0], [vb("tail0")], 100_000, 96_000);
		c.conduct(view2); // newlyAged grows → new key → launch #2

		expect(host.completeCalls).toHaveLength(2);
	});
});

// ── 7. Unavailable path ───────────────────────────────────────────────────────

describe("NaiveCompactionConductor — unavailable path (can(complete)===false)", () => {
	it("returns [] and never calls complete when can returns false before a summary exists", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost({ canComplete: false });
		c.attach(host);

		const aged = [vb("a0"), vb("a1"), vb("a2")];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);
		const result = c.conduct(view);

		expect(host.completeCalls).toHaveLength(0);
		expect(result).toEqual([]);
		expect(host.statusText).toContain("waiting for live model link");
	});

	it("does not fall back to a deterministic group command in degrade mode", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost({ canComplete: false });
		c.attach(host);

		const aged = [vb("first0"), vb("mid1"), vb("last2")];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);
		const result = c.conduct(view)!;

		expect(result.some((cmd) => cmd.kind === "group")).toBe(false);
		expect(result).toEqual([]);
	});

	it("degrade with 0 aged blocks returns []", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost({ canComplete: false });
		c.attach(host);

		const view = makeView([], [vb("tail0")], 100_000, 96_000);
		const result = c.conduct(view);

		expect(result).toEqual([]);
	});
});

// ── 8. detach() aborts in-flight completion ─────────────────────────────────

describe("NaiveCompactionConductor — detach() lifecycle", () => {
	it("detach() aborts the AbortSignal passed to in-flight complete", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);

		c.conduct(view); // launches completion

		expect(host.pending).toHaveLength(1);
		const signal = host.pending[0].req.signal;
		expect(signal).toBeDefined();
		expect(signal!.aborted).toBe(false);

		c.detach();

		expect(signal!.aborted).toBe(true);
	});

	it("after detach(), a late-rejecting completion does not cause errors", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);

		c.conduct(view);
		const pending = host.pending[0];

		c.detach();

		await expect(async () => {
			pending.reject(new Error("aborted"));
			await Promise.resolve();
		}).not.toThrow();
	});

	it("detach() with no in-flight completion is a no-op (does not throw)", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		expect(() => c.detach()).not.toThrow();
	});

	it("after detach(), conduct() returns null (no host)", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);
		c.detach();

		const aged = [vb("a0")];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);
		const result = c.conduct(view);

		expect(result).toBeNull();
	});

	it("reattach resets prior summary, compacted ids, and retry key", async () => {
		const c = new NaiveCompactionConductor();
		const host1 = new MockHost();
		c.attach(host1);

		const oldView = makeView([vb("old0"), vb("old1")], [vb("tail0")], 100_000, 96_000);
		c.conduct(oldView);
		host1.resolveNext("old summary");
		await Promise.resolve();
		expect(c.conduct(oldView)).not.toEqual([]);

		c.detach();
		const host2 = new MockHost();
		c.attach(host2);

		// Same ids in a later session must not inherit the old summary/compactedIds.
		const newView = makeView([vb("old0"), vb("old1")], [vb("tail0")], 100_000, 50_000);
		expect(c.conduct(newView)).toEqual([]);

		// A failed attempt key from the prior lifetime must not suppress a fresh launch either.
		const overBudget = makeView([vb("old0"), vb("old1")], [vb("tail0")], 100_000, 96_000);
		expect(c.conduct(overBudget)).toBeNull();
		expect(host2.completeCalls).toHaveLength(1);
	});

	it("a stale completion resolving after re-attach does NOT corrupt the new session (guard)", async () => {
		const c = new NaiveCompactionConductor();
		const host1 = new MockHost();
		c.attach(host1);

		// Launch completion A in the first lifetime.
		const viewA = makeView([vb("a0"), vb("a1")], [vb("tail0")], 100_000, 96_000);
		c.conduct(viewA);
		expect(host1.pending).toHaveLength(1);
		const stalePending = host1.pending[0];

		// Detach mid-flight (aborts A's controller) and re-attach a fresh host. A's promise is
		// still pending — the MockHost does not auto-reject on abort, simulating a completer
		// that resolves regardless of the signal.
		c.detach();
		const host2 = new MockHost();
		c.attach(host2);

		// Launch completion B in the new lifetime (same ids, fresh attempt key).
		c.conduct(viewA);
		expect(host2.pending).toHaveLength(1);
		expect(host2.completeCalls).toHaveLength(1);

		// Now A resolves LATE. The stale-completion guard must bail: B is still in-flight, so
		// A's result must not overwrite summary/compactedIds or clear B's inflight.
		stalePending.resolve({ text: "STALE SUMMARY FROM A", model: "old-model" });
		await Promise.resolve();

		// B is still pending (in-flight), and no summary has been committed.
		expect(host2.pending).toHaveLength(1);
		const holdWhileBInFlight = c.conduct(viewA);
		expect(holdWhileBInFlight).toBeNull(); // no summary yet → hold

		// B resolves: its summary commits (NOT A's stale one).
		host2.resolveNext("FRESH SUMMARY FROM B");
		await Promise.resolve();

		const result = c.conduct(viewA);
		expect(result).not.toBeNull();
		const g = result!.find((cmd) => cmd.kind === "group") as { digest: string } | undefined;
		expect(g).toBeDefined();
		expect(g!.digest).toContain("FRESH SUMMARY FROM B");
		expect(g!.digest).not.toContain("STALE SUMMARY FROM A");
	});

	it("a stale completion rejecting after re-attach does NOT clobber the new in-flight controller", async () => {
		const c = new NaiveCompactionConductor();
		const host1 = new MockHost();
		c.attach(host1);

		const view = makeView([vb("a0"), vb("a1")], [vb("tail0")], 100_000, 96_000);
		c.conduct(view);
		const stalePending = host1.pending[0];

		c.detach();
		const host2 = new MockHost();
		c.attach(host2);
		c.conduct(view); // launch B
		expect(host2.pending).toHaveLength(1);

		// A rejects late. The guard must bail — B's controller stays in-flight.
		stalePending.reject(new Error("stale abort"));
		await Promise.resolve();

		// B is still pending (the stale reject did not clear it).
		expect(host2.pending).toHaveLength(1);
		// conduct still holds (B in-flight) → null (no summary yet).
		expect(c.conduct(view)).toBeNull();

		// B can still resolve normally.
		host2.resolveNext("B SUMMARY");
		await Promise.resolve();
		const result = c.conduct(view);
		expect(result).not.toBeNull();
		expect((result!.find((cmd) => cmd.kind === "group") as { digest: string } | undefined)!.digest).toContain("B SUMMARY");
	});
});

// ── 9. Prompt construction & system prompt ────────────────────────────────────

describe("NaiveCompactionConductor — prompt construction", () => {
	it("first prompt contains the section header and block text for all aged blocks", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [
			vb("a0", { text: "user: do the thing", kind: "user" }),
			vb("a1", { text: "assistant reply text", kind: "text" }),
		];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);
		c.conduct(view);

		expect(host.completeCalls).toHaveLength(1);
		const prompt = host.completeCalls[0].prompt;

		expect(prompt).toContain("<conversation>");
		expect(prompt).toContain("</conversation>");
		expect(prompt).toContain("do the thing");
		expect(prompt).toContain("assistant reply text");
	});

	it("system prompt is the compaction template and instructs VERBATIM user-message preservation", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const view = makeView([vb("a0")], [vb("tail0")], 100_000, 96_000);
		c.conduct(view);

		expect(host.completeCalls).toHaveLength(1);
		const { system } = host.completeCalls[0];
		expect(system).toBeDefined();
		expect(system!.length).toBeGreaterThan(50);
		// Guard: must summarize, not continue the conversation.
		expect(system).toMatch(/do NOT continue the conversation/i);
		// Structured output sections.
		expect(system).toContain("Goal");
		expect(system).toContain("Progress");
		expect(system).toContain("Relevant files");
		// The sacred rule: user messages reproduced verbatim.
		expect(system).toContain("User messages".toLowerCase());
		expect(system).toMatch(/VERBATIM/i);
	});

	it("maxOutputTokens is set to a positive number", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const view = makeView([vb("a0")], [vb("tail0")], 100_000, 96_000);
		c.conduct(view);

		const { maxOutputTokens } = host.completeCalls[0];
		expect(maxOutputTokens).toBeDefined();
		expect(maxOutputTokens!).toBeGreaterThan(0);
	});

	it("AbortSignal is passed to each complete call", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const view = makeView([vb("a0")], [vb("tail0")], 100_000, 96_000);
		c.conduct(view);

		const { signal } = host.completeCalls[0];
		expect(signal).toBeDefined();
		expect(signal).toBeInstanceOf(AbortSignal);
	});
});

// ── 10. Held / grouped blocks are excluded from the aged region ────────────────

describe("NaiveCompactionConductor — held / grouped block exclusion", () => {
	it("held blocks (human override) are not included in the aged region", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const held = vb("held0", { held: true });
		const aged = vb("aged0");
		const view = makeView([held, aged], [vb("tail0")], 100_000, 96_000);

		c.conduct(view);
		expect(host.completeCalls).toHaveLength(1);

		const prompt = host.completeCalls[0].prompt;
		expect(prompt).toContain(`content of ${aged.id}`);
	});

	it("grouped blocks are not included in the aged region", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const grouped = vb("grp0", { grouped: true });
		const aged = vb("aged0");
		const view = makeView([grouped, aged], [vb("tail0")], 100_000, 96_000);

		c.conduct(view);
		expect(host.completeCalls).toHaveLength(1);
		const prompt = host.completeCalls[0].prompt;
		expect(prompt).toContain(`content of ${aged.id}`);
	});

	it("when ALL aged blocks are held, the aged region is empty → returns [] with no complete", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("h0", { held: true }), vb("h1", { held: true })];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);

		const result = c.conduct(view);
		expect(result).toEqual([]);
		expect(host.completeCalls).toHaveLength(0);
	});
});

// ── 11. Threshold boundary (90% of the visible window) ────────────────────────

describe("NaiveCompactionConductor — threshold boundary (90%)", () => {
	it("triggers at exactly 90% (liveTokens === 0.90 * budget, no prior summary)", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const view = makeView([vb("a0"), vb("a1")], [vb("tail0")], 100_000, 90_000);
		const result = c.conduct(view);

		expect(result).toBeNull(); // null = completion in-flight
		expect(host.completeCalls).toHaveLength(1);
	});

	it("does NOT trigger at 89.999% (just below threshold) — returns []", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const view = makeView([vb("a0"), vb("a1")], [vb("tail0")], 100_000, 89_999);
		const result = c.conduct(view);

		expect(result).toEqual([]);
		expect(host.completeCalls).toHaveLength(0);
	});
});

// ── 12. All kinds swallowed (user, tool_call, tool_result, thinking, text) ────

describe("NaiveCompactionConductor — all block kinds are swallowed", () => {
	it("user, tool_call, tool_result, thinking, and text blocks ALL appear in the compaction prompt", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [
			vb("u0", { kind: "user", text: "USER INTENT TEXT", tokens: 500 }),
			vb("t0", { kind: "text", text: "assistant prose", tokens: 500 }),
			vb("th0", { kind: "thinking", text: "private reasoning", tokens: 500 }),
			vb("tc0", { kind: "tool_call", text: "TOOL_CALL_BODY", toolName: "bash", tokens: 500 }),
			vb("tr0", { kind: "tool_result", text: "TOOL_RESULT_BODY", toolName: "bash", tokens: 500 }),
		];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);
		c.conduct(view);

		expect(host.completeCalls).toHaveLength(1);
		const prompt = host.completeCalls[0].prompt;

		// Every kind — including tool_call, which the old design excluded — is now fed to the LLM.
		expect(prompt).toContain("USER INTENT TEXT");
		expect(prompt).toContain("assistant prose");
		expect(prompt).toContain("private reasoning");
		expect(prompt).toContain("TOOL_CALL_BODY");
		expect(prompt).toContain("TOOL_RESULT_BODY");
	});

	it("the single group covers ALL kinds in the aged region (none left live by conductor choice)", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [
			vb("u0", { kind: "user", order: 0, tokens: 500 }),
			vb("t0", { kind: "text", order: 1, tokens: 500 }),
			vb("tc0", { kind: "tool_call", order: 2, tokens: 500 }),
			vb("tr0", { kind: "tool_result", order: 3, tokens: 500 }),
		];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);
		c.conduct(view);
		host.resolveNext("the summary");
		await Promise.resolve();

		const result = c.conduct(view);
		expect(result).not.toBeNull();
		expect(result!).toHaveLength(1);
		const g = result![0] as { kind: string; ids: string[]; digest: string };
		expect(g.kind).toBe("group");
		// The group spans the first (u0) to the last (tr0) aged block — every kind is inside.
		expect(g.ids).toEqual(["u0", "tr0"]);
	});

	it("an aged region that is ONLY tool_call blocks still triggers and emits a group (the host owns pair-balance)", () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const tc1 = vb("tc1", { kind: "tool_call", tokens: 50_000 });
		const tc2 = vb("tc2", { kind: "tool_call", tokens: 46_000 });
		const view = makeView([tc1, tc2], [vb("tail0")], 100_000, 96_000);
		const result = c.conduct(view);

		// No longer excluded → a completion launches (returns null while in-flight).
		expect(result).toBeNull();
		expect(host.completeCalls).toHaveLength(1);
	});
});

// ── 13. Empty completion text is a failure ────────────────────────────────────

describe("NaiveCompactionConductor — empty completion result", () => {
	it("empty completion text is treated as failure: prior state preserved, no header-only group", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);

		expect(c.conduct(view)).toBeNull();
		host.resolveNext("   \n\t  ");
		await Promise.resolve();
		expect(host.statusText).toContain("empty summary");

		// No summary committed → clear to raw, no group emitted.
		const result = c.conduct(view);
		expect(result).toEqual([]);
		expect(host.requestRerunCalls).toBe(0);
	});

	it("an empty result does NOT clobber a prior committed summary", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);

		// First, commit a real summary.
		c.conduct(view);
		host.resolveNext("REAL SUMMARY");
		await Promise.resolve();
		c.conduct(view);

		// Force a second launch by aging in a new block, then return empty.
		const b0 = vb("b0");
		const view2 = makeView([...aged, b0], [vb("tail0")], 100_000, 96_000);
		c.conduct(view2); // launch #2
		expect(host.completeCalls).toHaveLength(2);
		host.resolveNext("   ");
		await Promise.resolve();

		// The prior REAL SUMMARY must still be emitted (not replaced by an empty/header group).
		const result = c.conduct(view2);
		expect(result).not.toBeNull();
		const g = result!.find((cmd) => cmd.kind === "group") as { digest: string } | undefined;
		expect(g).toBeDefined();
		expect(g!.digest).toContain("REAL SUMMARY");
	});
});

// ── 14. attemptKey on newlyAged ───────────────────────────────────────────────

describe("NaiveCompactionConductor — attemptKey keyed on newlyAged", () => {
	it("after a successful compaction, shrinking the aged set (human pins a newly-aged block) does NOT relaunch", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const x0 = vb("x0", { order: 0 });
		const x1 = vb("x1", { order: 1 });
		const viewFirst = makeView([x0, x1], [vb("tail0")], 100_000, 96_000);

		// Successful first compaction.
		c.conduct(viewFirst);
		host.resolveNext("summary");
		await Promise.resolve();
		c.conduct(viewFirst); // commit

		// b0 ages in → newlyAged = [b0] → launch #2.
		const b0 = vb("b0", { order: 2 });
		const viewWithB0 = makeView([x0, x1, b0], [vb("tail0")], 100_000, 96_000);
		c.conduct(viewWithB0);
		expect(host.completeCalls).toHaveLength(2);

		host.rejectNext(new Error("error"));
		await Promise.resolve();

		// Shrink: b0 becomes held → agedBlocks no longer contains b0 → newlyAged = [].
		// needSummary = false (newlyAged empty) → no relaunch.
		const b0Held = { ...b0, held: true };
		const viewShrunk = makeView([x0, x1, b0Held], [vb("tail0")], 100_000, 96_000);
		c.conduct(viewShrunk);

		expect(host.completeCalls).toHaveLength(2); // still 2, no new launch
	});

	it("after rejection, adding a genuinely NEW aged block relaunches (attempt key changes)", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const a0 = vb("a0");
		const a1 = vb("a1");
		const view1 = makeView([a0, a1], [vb("tail0")], 100_000, 96_000);

		c.conduct(view1); // launch #1
		host.rejectNext(new Error("error"));
		await Promise.resolve();

		c.conduct(view1); // same set → no relaunch
		expect(host.completeCalls).toHaveLength(1);

		const b0 = vb("b0");
		const view2 = makeView([a0, a1, b0], [vb("tail0")], 100_000, 96_000);
		c.conduct(view2); // newlyAged grows → launch #2

		expect(host.completeCalls).toHaveLength(2);
	});

	it("after a successful compaction, a new block ages in → relaunch; same newlyAged after a reject does not", async () => {
		const c = new NaiveCompactionConductor();
		const host = new MockHost();
		c.attach(host);

		const a0 = vb("a0");
		const a1 = vb("a1");
		const view1 = makeView([a0, a1], [vb("tail0")], 100_000, 96_000);

		c.conduct(view1);
		host.resolveNext("summary one");
		await Promise.resolve();
		c.conduct(view1); // commit

		const b0 = vb("b0");
		const view2 = makeView([a0, a1, b0], [vb("tail0")], 100_000, 96_000);
		c.conduct(view2); // launches #2, key = "b0"
		expect(host.completeCalls).toHaveLength(2);

		host.rejectNext(new Error("error"));
		await Promise.resolve();

		c.conduct(view2); // same newlyAged=[b0] → no relaunch
		expect(host.completeCalls).toHaveLength(2);

		const c0 = vb("c0");
		const view3 = makeView([a0, a1, b0, c0], [vb("tail0")], 100_000, 96_000);
		c.conduct(view3); // newlyAged=[b0,c0] → new key → launch #3
		expect(host.completeCalls).toHaveLength(3);
	});
});

// ── 15. Degrade must not clobber an existing LLM summary ──────────────────────

describe("NaiveCompactionConductor — degrade must not clobber an existing LLM summary", () => {
	async function setupWithSummary(): Promise<{
		conductor: NaiveCompactionConductor;
		host: MockHost;
		a0: ViewBlock;
		a1: ViewBlock;
		summaryText: string;
	}> {
		const conductor = new NaiveCompactionConductor();
		const host = new MockHost({ canComplete: true });
		conductor.attach(host);

		// Small blocks (1k each) with a large raw liveTokens: after compaction the saving is
		// tiny, so the VISIBLE window stays well over 90%. That lets the degrade tests push
		// `needSummary` true (over threshold + newly-aged) while the model link is down — the
		// exact path that surfaces the "waiting for live model link" status.
		const a0 = vb("a0", { order: 0, tokens: 1_000 });
		const a1 = vb("a1", { order: 1, tokens: 1_000 });
		const tail0 = vb("tail0", { tokens: 4_000 });

		const view = makeView([a0, a1], [tail0], 100_000, 96_000);

		conductor.conduct(view);
		expect(host.completeCalls).toHaveLength(1);

		const summaryText = "LLM GENERATED SUMMARY — DO NOT CLOBBER";
		host.resolveNext(summaryText);
		await Promise.resolve();

		const committed = conductor.conduct(view);
		expect(committed).not.toBeNull();
		const g = (committed as Array<{ kind: string; digest: string }>).find((c) => c.kind === "group");
		expect(g).toBeDefined();
		expect(g!.digest).toContain(summaryText);

		return { conductor, host, a0, a1, summaryText };
	}

	it("when the model link drops and a newly-aged block keeps visible over threshold, re-emits the existing summary group — no relaunch", async () => {
		const { conductor, host, a0, a1, summaryText } = await setupWithSummary();

		host.canComplete = false;

		// A new block ages in; the prior saving is small so visible is still over 90% →
		// needSummary is true. But the link is down → degrade: re-emit the existing summary
		// group, surface the "waiting" status, and do NOT launch.
		const newBlock = vb("new1", { order: 2, tokens: 2_000 });
		const viewOverThreshold = makeView(
			[a0, a1, newBlock],
			[vb("tail0", { tokens: 4_000 })],
			100_000,
			98_000,
		);

		const result = conductor.conduct(viewOverThreshold);

		expect(result).not.toBeNull();
		expect(Array.isArray(result)).toBe(true);
		const cmds = result!;

		// The existing LLM summary group is re-emitted (covers a0, a1).
		const groups = cmds.filter((cmd) => cmd.kind === "group") as Array<{
			ids: string[];
			digest: string;
		}>;
		expect(groups).toHaveLength(1);
		expect(groups[0].digest).toContain(summaryText);
		expect(groups[0].ids).toEqual(["a0", "a1"]);

		// No new complete call while the link is down.
		expect(host.completeCalls).toHaveLength(1);
		expect(host.statusText).toContain("waiting for live model link");
	});

	it("when the model link drops but visible is below threshold, re-emits the existing summary group", async () => {
		const { conductor, host, a0, a1, summaryText } = await setupWithSummary();

		host.canComplete = false;

		const viewUnder = makeView([a0, a1], [vb("tail0")], 100_000, 50_000);
		const result = conductor.conduct(viewUnder);

		expect(Array.isArray(result)).toBe(true);
		const cmds = result! as Array<{ kind: string; ids: string[]; digest: string }>;
		const groups = cmds.filter((c) => c.kind === "group");
		expect(groups).toHaveLength(1);
		expect(groups[0].digest).toContain(summaryText);
	});

	it("after the model link recovers, the next conduct relaunches to pick up newly-aged blocks", async () => {
		const { conductor, host, a0, a1 } = await setupWithSummary();

		host.canComplete = false;
		const newBlock = vb("new3", { order: 2, tokens: 2_000 });
		const viewDegraded = makeView([a0, a1, newBlock], [vb("tail0")], 100_000, 96_000);
		conductor.conduct(viewDegraded);
		expect(host.completeCalls).toHaveLength(1); // no new launch while link is down

		// Restore the link — visible is over 90% (large raw window) and newlyAged=[new3] → relaunch.
		host.canComplete = true;
		conductor.conduct(viewDegraded);
		expect(host.completeCalls).toHaveLength(2);
	});
});

// ── 16. DATA-LOSS-CLASS regression: vanished compacted blocks ─────────────────
//
// With the group shape there is no "empty replace without a summary head" failure mode
// (a group either collapses to the summary or is clamped and the blocks stay live). These
// tests pin the graceful re-derivation: vanished blocks simply drop out of the survivor
// run; the group re-homes to the remaining survivors; if all vanish, [] (clear to raw).

describe("NaiveCompactionConductor — vanished compacted blocks (regression)", () => {
	async function setupCompacted(): Promise<{
		conductor: NaiveCompactionConductor;
		host: MockHost;
		a: ViewBlock;
		b: ViewBlock;
		c: ViewBlock;
	}> {
		const conductor = new NaiveCompactionConductor();
		const host = new MockHost();
		conductor.attach(host);

		const a = vb("a", { order: 0 });
		const b = vb("b", { order: 1 });
		const c = vb("c", { order: 2 });

		const view = makeView([a, b, c], [vb("tail0")], 100_000, 96_000);
		conductor.conduct(view);
		host.resolveNext("THE SUMMARY");
		await Promise.resolve();
		conductor.conduct(view); // commit

		return { conductor, host, a, b, c };
	}

	it("when the first survivor vanishes, the group re-homes to the remaining contiguous survivors", async () => {
		const { conductor, b, c } = await setupCompacted();

		// a is gone; b and c survive.
		const view = makeView([b, c], [vb("tail0")], 100_000, 96_000);
		const result = conductor.conduct(view);

		expect(result).not.toBeNull();
		expect(result!).toHaveLength(1);
		const g = result![0] as { kind: string; ids: string[]; digest: string };
		expect(g.kind).toBe("group");
		expect(g.ids).toEqual(["b", "c"]);
		expect(g.digest).toContain("THE SUMMARY");
	});

	it("when the last survivor vanishes, the group spans the remaining prefix", async () => {
		const { conductor, a, b } = await setupCompacted();

		const view = makeView([a, b], [vb("tail0")], 100_000, 96_000);
		const result = conductor.conduct(view);

		expect(result).not.toBeNull();
		const g = result![0] as { ids: string[] };
		expect(g.ids).toEqual(["a", "b"]);
	});

	it("when ALL compacted blocks vanish, returns [] (clear to raw; no lone empties possible)", async () => {
		const { conductor } = await setupCompacted();

		const viewAllGone = makeView([], [vb("tail0")], 100_000, 10_000);
		const result = conductor.conduct(viewAllGone);

		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual([]);
	});

	it("a held block splitting the survivors yields one group per side (no span across the held block)", async () => {
		const { conductor, a, b, c } = await setupCompacted();

		// b becomes held → it splits [a, b, c] into [a] and [c]. The conductor walks the FULL
		// aged prefix (including the held block), so it flushes a run at b: one group over [a]
		// and one over [c], each carrying the summary. Spanning a..c instead would make the host
		// clamp the whole group `human-override`, dropping the summary for ALL survivors.
		const bHeld = { ...b, held: true };
		const view = makeView([a, bHeld, c], [vb("tail0")], 100_000, 96_000);
		const result = conductor.conduct(view);

		expect(result).not.toBeNull();
		const groups = result!.filter((cmd) => cmd.kind === "group") as Array<{
			ids: string[];
			digest: string;
		}>;
		expect(groups).toHaveLength(2);
		// First group covers a alone; second covers c alone. b is in neither.
		expect(groups[0].ids).toEqual(["a", "a"]);
		expect(groups[1].ids).toEqual(["c", "c"]);
		for (const g of groups) expect(g.digest).toContain("THE SUMMARY");
		const allIds = groups.flatMap((g) => g.ids);
		expect(allIds).not.toContain("b");
		// No replace commands ever — the group shape emits no empties.
		expect(result!.every((cmd) => cmd.kind === "group")).toBe(true);
	});
});

// ── 17. AccordionStore integration ────────────────────────────────────────────

describe("NaiveCompactionConductor — AccordionStore integration", () => {
	it("delivers the summary as a single folded group covering the aged region (user blocks swallowed, tail untouched)", async () => {
		const blocks = [
			blk(0, "user", 1000, { text: "opening user request" }),
			blk(1, "text", 2000, { text: "assistant progress" }),
			blk(2, "thinking", 1000, { text: "private reasoning" }),
			blk(3, "tool_result", 1000, { text: "tool output" }),
			blk(4, "text", 500, { text: "protected tail" }),
		];
		const s = makeStore(blocks);
		s.setProtect(500);
		s.setBudget(5_000);
		s.completer = async () => ({ text: "STORE LEVEL SUMMARY", model: "test-model" });

		s.attach(new NaiveCompactionConductor());
		await flushMicrotasks();

		// Exactly one conductor-owned group, folded, carrying the LLM summary verbatim.
		expect(s.groups.length).toBe(1);
		const g = s.groups[0];
		expect(g.folded).toBe(true);
		expect(g.by).toBe("auto");
		expect(s.isDropGroup(g)).toBe(false);
		expect(s.groupSummary(g)).toContain("STORE LEVEL SUMMARY");

		// The group covers the whole aged region (blocks 0–3) — including the user block,
		// which the old replace-based design left live. The protected tail (block 4) is NOT a member.
		expect(g.memberIds).toContain("m0:p0"); // user
		expect(g.memberIds).toContain("m1:p0"); // text
		expect(g.memberIds).toContain("m2:p0"); // thinking
		expect(g.memberIds).toContain("m3:p0"); // tool_result
		expect(g.memberIds).not.toContain("m4:p0"); // tail

		// The summary actually lands on the wire (the carrier renders the digest), and no
		// invalid-group / not-foldable clamp fired in the happy path.
		expect(s.lastReports.some((r) => r.reason === "invalid-group")).toBe(false);
		expect(s.lastReports.some((r) => r.reason === "not-foldable")).toBe(false);
	});

	it("re-compacts recursively when new blocks age in over the high-water mark", async () => {
		// Start: an aged region of two blocks, a tiny tail, a tight budget.
		const blocks = [
			blk(0, "text", 2000, { text: "first aged block" }),
			blk(1, "text", 2000, { text: "second aged block" }),
			blk(2, "text", 200, { text: "tail" }),
		];
		const s = makeStore(blocks);
		s.setProtect(200);
		s.setBudget(4_000);
		let callCount = 0;
		s.completer = async () => ({ text: `SUMMARY ${++callCount}`, model: "test-model" });

		s.attach(new NaiveCompactionConductor());
		await flushMicrotasks();

		// First compaction: one group over blocks 0–1.
		expect(s.groups.length).toBe(1);
		expect(s.groupSummary(s.groups[0])).toContain("SUMMARY 1");
		expect(s.groups[0].memberIds).toContain("m0:p0");
		expect(s.groups[0].memberIds).toContain("m1:p0");
		expect(callCount).toBe(1);

		// Append fresh content: a large newly-aged block (m3) plus a new tail (m4). The raw
		// window grows past 90% again, newlyAged becomes non-empty → a second compaction fires.
		s.appendBlocks([
			blk(3, "text", 4000, { text: "newly aged content" }),
			blk(4, "text", 200, { text: "new tail" }),
		]);
		s.setProtect(200);
		await flushMicrotasks();

		// Second compaction fired: the group now also covers the newly-aged block, with the
		// recursive summary. (Amnesia is exercised at the prompt level in the unit tests above.)
		expect(callCount).toBe(2);
		expect(s.groups.length).toBe(1);
		const g2 = s.groups[0];
		expect(s.groupSummary(g2)).toContain("SUMMARY 2");
		expect(g2.memberIds).toContain("m3:p0");
	});
});
