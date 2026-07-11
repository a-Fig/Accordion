import { describe, it, expect, vi, afterEach } from "vitest";
import { KeelConductor } from "$conductors";
import type { ConductorHost, ConductorView, CompletionRequest, CompletionResult } from "$conductors/contract";

/*
 * Keel conductor — Phase 2 (LLM deep-zone digest, ADR 0017 §14 Keel-llm).
 *
 * These tests cover the ASYNC machinery only (the synchronous core is covered by
 * conductor.keel.test.ts). A lightweight ConductorHost stub drives all assertions
 * here — we are testing the async pattern (fire-and-forget, stale guard, abort,
 * retry-storm prevention), not the store's clamp logic. The store-level clamps
 * are already proven by the Phase-1 end-to-end tests.
 *
 * MockHost makes `can("complete")` controllable per test so we can toggle graceful
 * degradation. The `complete()` function is a vi.fn() whose resolution/rejection is
 * controlled manually via a deferred promise helper.
 *
 * Coverage (per spec):
 *   (A) Graceful degradation — host.can("complete")=false → no completion fired, deep
 *       zone uses deterministic digest, behavior identical to Phase 1.
 *   (B) Async apply — complete() resolves a known string → null (hold) while inflight,
 *       then after resolve+rerun the deep digest is applied as a replace with recoverable:true.
 *   (C) Reject path — complete() rejects → no crash, falls back to deterministic digest,
 *       no retry-storm (complete() not called again for same unchanged region).
 *   (D) Stale guard — region changes between fire and resolve → stale result discarded.
 *   (E) detach aborts — detach() during inflight → abort signal fired, post-detach
 *       requestRerun not called.
 *   (F) Determinism of selection — set of deep-region ids is identical across two passes.
 */

// ── shared helpers ────────────────────────────────────────────────────────────

/** A controllable deferred promise (resolve/reject from outside). */
interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Build a MockHost with controllable can("complete") and a vi.fn() complete(). */
function makeMockHost(opts: {
	canComplete: boolean;
	completeFn?: (req: CompletionRequest) => Promise<CompletionResult>;
}): ConductorHost & { rerunCount: number; statusMessages: string[]; abortSignals: AbortSignal[] } {
	const host = {
		rerunCount: 0,
		statusMessages: [] as string[],
		abortSignals: [] as AbortSignal[],

		can(cap: string): boolean {
			if (cap === "complete") return opts.canComplete;
			if (cap === "countTokens") return true;
			if (cap === "digest") return false;
			if (cap === "compress") return false;
			return false;
		},
		complete(req: CompletionRequest): Promise<CompletionResult> {
			if (req.signal) host.abortSignals.push(req.signal);
			if (!opts.canComplete) return Promise.reject(new Error("completion unavailable"));
			if (opts.completeFn) return opts.completeFn(req);
			return Promise.reject(new Error("no completeFn provided"));
		},
		countTokens(text: string): number {
			return Math.ceil(text.length / 4);
		},
		digestOf(_id: string): string | null {
			return null;
		},
		setStatus(text: string | null, _metrics?: Record<string, number | string | boolean>): void {
			if (text) host.statusMessages.push(text);
		},
		requestRerun(): void {
			host.rerunCount++;
		},
	};
	return host;
}

/**
 * Build a synthetic ConductorView with `n` prose blocks over budget.
 * Block 0 is always a user block (permanent root, non-foldable).
 * Remaining blocks are `text` kind with ~1k tokens each.
 *
 * IMPORTANT: blocks have `text: undefined` so that `tryTrim` returns null (no text to trim)
 * and they fall through to `digestLevel`. This ensures the deep-zone path is exercised in
 * tests without needing large token counts. Real sessions exercise trim first; these test-only
 * blocks force the L3/deep-zone path directly.
 */
function makeView(n: number, budget: number): ConductorView {
	const blocks: ConductorView["blocks"] = [];
	for (let i = 0; i < n; i++) {
		blocks.push({
			id: `m${i}:p0`,
			kind: i === 0 ? "user" : "text",
			turn: i + 1,
			order: i,
			tokens: i === 0 ? 200 : 1_000,
			foldedTokens: i === 0 ? 200 : 40,
			held: false,
			folded: false,
			protected: false,
			grouped: false,
			// text is intentionally omitted: tryTrim returns null for text===undefined,
			// so these blocks fall through to digestLevel (deep-zone candidates). This is
			// the test pattern to exercise the Phase-2 LLM async path directly.
			// text: undefined is the default when not specified in the object literal.
		});
	}
	const liveTokens = blocks.reduce((s, b) => s + b.tokens, 0);
	return {
		blocks,
		budget,
		contextWindow: null,
		liveTokens,
		protectedFromIndex: blocks.length, // no protected tail in these tests (simplicity)
		protectTokens: 0,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────────────
// (A) Graceful degradation
// ────────────────────────────────────────────────────────────────────────────

describe("Keel Phase 2 — (A) graceful degradation: host.can('complete')=false", () => {
	it("fires no completion, emits only deterministic folds, no requestRerun", () => {
		const keel = new KeelConductor();
		const completeFn = vi.fn((_req: CompletionRequest): Promise<CompletionResult> =>
			Promise.reject(new Error("should not be called")),
		);
		const host = makeMockHost({ canComplete: false, completeFn });
		keel.attach(host);

		const view = makeView(20, 4_000);
		const cmds = keel.conduct(view);

		// No completion fired.
		expect(completeFn).not.toHaveBeenCalled();
		expect(host.rerunCount).toBe(0);

		// Emits only fold/replace commands (no groups — under this view size).
		expect(cmds).not.toBeNull();
		const foldOrReplace = (cmds ?? []).filter((c) => c.kind === "fold" || c.kind === "replace");
		expect(foldOrReplace.length).toBeGreaterThan(0);

		// No recoverable replace (the LLM path is off) — only plain folds or skeleton/trim replaces.
		// (At this budget with prose blocks there is no code read, so no skeleton. Trim may fire.)
		// The key assertion: no replace is from the LLM cache (which is empty) → all recoverable
		// replaces must be from skeleton/trim (L1/L2), never from a non-existent LLM cache.
		// We cannot distinguish trim-recoverable from llm-recoverable by the command alone, so we just
		// assert complete() was never called.
	});

	it("two passes on the same view with canComplete=false are byte-identical (Phase-1 determinism)", () => {
		const keel = new KeelConductor();
		const host = makeMockHost({ canComplete: false });
		keel.attach(host);

		const view = makeView(20, 4_000);
		const p1 = JSON.stringify(keel.conduct(view));
		const p2 = JSON.stringify(keel.conduct(view));
		expect(p2).toEqual(p1);
	});

	it("a fresh KeelConductor with canComplete=false produces the same plan as one with canComplete=true on pass 1 (both have no cache)", () => {
		// On the FIRST pass, neither instance has a cache — they both fall through to digestLevel.
		// The plans should be identical regardless of whether complete is available.
		const view = makeView(20, 4_000);

		const keelNo = new KeelConductor();
		keelNo.attach(makeMockHost({ canComplete: false }));
		const planNo = JSON.stringify(keelNo.conduct(view));

		const keelYes = new KeelConductor();
		const deferred1 = deferred<CompletionResult>();
		keelYes.attach(makeMockHost({ canComplete: true, completeFn: () => deferred1.promise }));
		const planYes = JSON.stringify(keelYes.conduct(view));

		expect(planYes).toEqual(planNo);
		// Resolve the pending completion so there is no dangling promise after the test.
		deferred1.resolve({ text: "test", model: "test" });
	});
});

// ────────────────────────────────────────────────────────────────────────────
// (B) Async apply
// ────────────────────────────────────────────────────────────────────────────

describe("Keel Phase 2 — (B) async apply: complete() resolves → LLM-summary group on rerun", () => {
	it("first pass: no cached text → plain fold; second pass after resolve: net-win LLM-summary group", async () => {
		// A LARGE digest (~600 tok) only earns its tokens as ONE group head over the whole cold run
		// (Σ foldedTokens ≈ 19×40 ≈ 760 > the ~150-tok group head). The cache hit must therefore emit
		// a `group` carrying the LLM text as its digest — NOT N per-block replaces (a token loss).
		const KNOWN_DIGEST = "## User messages\n(none)\n\n## Key facts\n" +
			Array.from({ length: 40 }, (_, i) => `- path/to/file_${i}.ts config_${i}=true`).join("\n") +
			"\n\n## Summary\nDiscussed many files across the cold region.";

		const d = deferred<CompletionResult>();
		const completeFn = vi.fn((_req: CompletionRequest): Promise<CompletionResult> => d.promise);

		const keel = new KeelConductor();
		const host = makeMockHost({ canComplete: true, completeFn });
		keel.attach(host);

		const view = makeView(20, 4_000);

		// Pass 1: no cache → deep-zone blocks get plain folds; completion is launched.
		const cmds1 = keel.conduct(view);
		expect(cmds1).not.toBeNull();

		// The completion was fired once.
		expect(completeFn).toHaveBeenCalledTimes(1);

		// Check the request: system prompt contains the REVERSIBLE DIGEST framing, not compaction.
		const req = completeFn.mock.calls[0][0] as CompletionRequest;
		expect(req.system).toContain("NAVIGATION AID");
		expect(req.maxOutputTokens).toBe(600);
		expect(req.system).toContain("PRESERVE EXACT IDENTIFIERS");

		// No requestRerun yet (still inflight).
		expect(host.rerunCount).toBe(0);

		// Resolve the completion with a known digest text.
		d.resolve({ text: KNOWN_DIGEST, model: "test-model" });
		// Let the microtask queue flush.
		await new Promise((r) => setTimeout(r, 0));

		// requestRerun was called once.
		expect(host.rerunCount).toBe(1);

		// Pass 2 (simulating rerun): the cached digest is now available → the deep-zone run is
		// collapsed into ONE group whose digest is the LLM text.
		const cmds2 = keel.conduct(view);
		expect(cmds2).not.toBeNull();

		const groups = (cmds2 ?? []).filter((c) => c.kind === "group") as Array<{ kind: "group"; ids: string[]; digest?: string | null }>;
		const llmGroup = groups.find((g) => g.digest === KNOWN_DIGEST);
		expect(llmGroup).toBeDefined();
		// The group covers more than one deep-zone block (a region summary, not a 1:1 substitution).
		expect((llmGroup?.ids.length ?? 0)).toBeGreaterThan(1);

		// No `replace` carries the LLM text (it is a region group, never a per-block replace).
		const llmReplace = (cmds2 ?? []).find((c) => c.kind === "replace" && (c as { content?: string }).content === KNOWN_DIGEST);
		expect(llmReplace).toBeUndefined();

		// completeFn should NOT be called again (the cache is warm).
		expect(completeFn).toHaveBeenCalledTimes(1);
	});

	it("a SMALL deep run is NOT collapsed into an LLM group (net-win gate rejects a token loss)", async () => {
		// Net-win gate: an LLM summary that costs MORE than the deterministic fold of the run it would
		// replace must be rejected — the run keeps its plain folds. Here the digest (~250 tok) exceeds
		// the deterministic fold of the few foldable blocks (a handful × 40 tok), so NO group fires.
		const BIG_DIGEST = "## Summary\n" + "word ".repeat(1_000); // ~1250 chars → ~310 tok group head
		const d = deferred<CompletionResult>();

		const keel = new KeelConductor();
		const host = makeMockHost({ canComplete: true, completeFn: () => d.promise });
		keel.attach(host);

		// Only 4 blocks (1 user root + 3 text). Budget forces folding the 3 text blocks (≈120 tok of
		// deterministic fold) — far cheaper than a ~310-tok LLM group head.
		const view = makeView(4, 2_000);
		keel.conduct(view); // pass 1 → launches completion

		d.resolve({ text: BIG_DIGEST, model: "m" });
		await new Promise((r) => setTimeout(r, 0));

		const cmds2 = keel.conduct(view);
		// No group carries the oversized digest — the gate kept the plain folds.
		const llmGroup = (cmds2 ?? []).find((c) => c.kind === "group" && (c as { digest?: string | null }).digest === BIG_DIGEST);
		expect(llmGroup).toBeUndefined();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// (C) Reject path
// ────────────────────────────────────────────────────────────────────────────

describe("Keel Phase 2 — (C) reject path: complete() rejects → fallback, no retry-storm", () => {
	it("rejection does not crash; subsequent pass with the same region does not re-launch", async () => {
		const d = deferred<CompletionResult>();
		const completeFn = vi.fn((): Promise<CompletionResult> => d.promise);

		const keel = new KeelConductor();
		const host = makeMockHost({ canComplete: true, completeFn });
		keel.attach(host);

		const view = makeView(20, 4_000);

		// Pass 1 → launches completion.
		const cmds1 = keel.conduct(view);
		expect(completeFn).toHaveBeenCalledTimes(1);
		expect(cmds1).not.toBeNull();

		// Reject.
		d.reject(new Error("network error"));
		await new Promise((r) => setTimeout(r, 0));

		// requestRerun was NOT called on rejection.
		expect(host.rerunCount).toBe(0);

		// Pass 2 on the SAME view (same deep-region sig) → must NOT re-launch (retry-storm prevention).
		const cmds2 = keel.conduct(view);
		expect(completeFn).toHaveBeenCalledTimes(1); // still 1, no new call
		expect(cmds2).not.toBeNull();

		// Still gets a plan (deterministic fallback, no crash).
		const hasFolds = (cmds2 ?? []).some((c) => c.kind === "fold" || c.kind === "replace");
		expect(hasFolds).toBe(true);
	});

	it("a CHANGED deep-region sig (new block aged in) DOES allow a retry after rejection", async () => {
		const d1 = deferred<CompletionResult>();
		let callCount = 0;
		const d2 = deferred<CompletionResult>();
		const completeFn = vi.fn((): Promise<CompletionResult> => {
			callCount++;
			return callCount === 1 ? d1.promise : d2.promise;
		});

		const keel = new KeelConductor();
		const host = makeMockHost({ canComplete: true, completeFn });
		keel.attach(host);

		const view1 = makeView(20, 4_000);

		// Pass 1 with view1 → launches, then rejects.
		keel.conduct(view1);
		expect(completeFn).toHaveBeenCalledTimes(1);
		d1.reject(new Error("rejected"));
		await new Promise((r) => setTimeout(r, 0));

		// Pass 2 with an EXTENDED view (new block added) → new deep-region sig → retry allowed.
		const view2 = makeView(21, 4_000); // one more block = different deep zone sig
		keel.conduct(view2);
		// A second completion was launched for the new sig.
		expect(completeFn.mock.calls.length).toBeGreaterThanOrEqual(2);

		// Clean up.
		d2.reject(new Error("cleanup"));
		await new Promise((r) => setTimeout(r, 0));
	});
});

// ────────────────────────────────────────────────────────────────────────────
// (D) Stale guard
// ────────────────────────────────────────────────────────────────────────────

describe("Keel Phase 2 — (D) stale guard: changed region between fire and resolve", () => {
	it("a stale completion (old sig, different current region) does not corrupt the new region's plan", async () => {
		const d = deferred<CompletionResult>();
		const STALE_DIGEST = "## Summary\nThis is STALE and should not appear.";
		let callCount = 0;
		const d2 = deferred<CompletionResult>();
		const completeFn = vi.fn((): Promise<CompletionResult> => {
			callCount++;
			return callCount === 1 ? d.promise : d2.promise;
		});

		const keel = new KeelConductor();
		const host = makeMockHost({ canComplete: true, completeFn });
		keel.attach(host);

		// Pass 1 with view1 (20 blocks) → launches for region A.
		const view1 = makeView(20, 4_000);
		keel.conduct(view1);
		expect(completeFn).toHaveBeenCalledTimes(1);

		// BEFORE the first completion resolves, run pass 2 on a DIFFERENT view (region B).
		// This happens when new blocks age in while the old completion is inflight.
		// BUT: keel only has one inflight at a time. Since pass 1 launched an inflight,
		// pass 2 will NOT launch a new one — it will hold. So the stale scenario is:
		// - inflight fires for region A
		// - region A's completion resolves with stale text
		// - but by then the view has changed to region B
		// - on pass 3 (with view B), the stale sig A key mismatches → no cache hit for B → new launch.

		// Resolve with stale text.
		d.resolve({ text: STALE_DIGEST, model: "test" });
		await new Promise((r) => setTimeout(r, 0));
		// requestRerun was called.
		expect(host.rerunCount).toBeGreaterThanOrEqual(1);

		// Pass 2 on a view with MORE blocks (different deep-region sig B).
		// The stale cached text was stored under sig A — sig B will have no cache hit.
		const view2 = makeView(22, 4_000);
		const cmds2 = keel.conduct(view2);

		// The stale digest should NOT appear in any replace command for view2.
		const staleReplace = (cmds2 ?? []).find(
			(c): c is { kind: "replace"; id: string; content: string } =>
				c.kind === "replace" && (c as { content: string }).content === STALE_DIGEST,
		);
		expect(staleReplace).toBeUndefined();

		// Clean up the second completion that may have launched.
		d2.reject(new Error("cleanup"));
		await new Promise((r) => setTimeout(r, 0));
	});
});

// ────────────────────────────────────────────────────────────────────────────
// (E) detach aborts
// ────────────────────────────────────────────────────────────────────────────

describe("Keel Phase 2 — (E) detach aborts: in-flight completion is cancelled on detach", () => {
	it("detach() fires the abort signal while a completion is inflight", () => {
		const d = deferred<CompletionResult>();
		const completeFn = vi.fn((): Promise<CompletionResult> => d.promise);

		const keel = new KeelConductor();
		const host = makeMockHost({ canComplete: true, completeFn });
		keel.attach(host);

		const view = makeView(20, 4_000);
		keel.conduct(view); // launches completion

		expect(completeFn).toHaveBeenCalledTimes(1);
		expect(host.abortSignals.length).toBe(1);
		const signal = host.abortSignals[0];
		expect(signal.aborted).toBe(false);

		// Detach should abort.
		keel.detach();
		expect(signal.aborted).toBe(true);
	});

	it("requestRerun is NOT called after detach even when the completion resolves later", async () => {
		const d = deferred<CompletionResult>();
		const completeFn = vi.fn((): Promise<CompletionResult> => d.promise);

		const keel = new KeelConductor();
		const host = makeMockHost({ canComplete: true, completeFn });
		keel.attach(host);

		const view = makeView(20, 4_000);
		keel.conduct(view);

		// Detach before the promise resolves.
		keel.detach();

		// Resolve the completion after detach.
		d.resolve({ text: "digest text", model: "test" });
		await new Promise((r) => setTimeout(r, 0));

		// requestRerun must NOT have been called — post-detach stale guard prevents it.
		expect(host.rerunCount).toBe(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// (F) Determinism of selection
// ────────────────────────────────────────────────────────────────────────────

describe("Keel Phase 2 — (F) determinism of deep-region selection", () => {
	it("two passes on the same view target the same deep-region block ids", () => {
		// The SELECTION of which blocks form the deep zone must be deterministic — only the
		// digest TEXT is nondeterministic. We verify this by inspecting the request prompts
		// from two separate instances on the same view and checking the block content passed.
		const prompts: string[] = [];
		const completeFn = vi.fn((req: CompletionRequest): Promise<CompletionResult> => {
			prompts.push(req.prompt);
			return deferred<CompletionResult>().promise; // never resolves; just capture
		});

		const view = makeView(20, 4_000);

		const keelA = new KeelConductor();
		keelA.attach(makeMockHost({ canComplete: true, completeFn }));
		keelA.conduct(view);

		const keelB = new KeelConductor();
		keelB.attach(makeMockHost({ canComplete: true, completeFn }));
		keelB.conduct(view);

		// Both completions fired.
		expect(completeFn).toHaveBeenCalledTimes(2);
		// The prompts should be identical (same block content selection).
		expect(prompts[0]).toEqual(prompts[1]);
	});

	it("two passes on identical views (same instance) do NOT fire a second completion (inflight guard)", () => {
		// After the first completion is launched (inflight), a second pass on the SAME view
		// should NOT launch another — this tests the inflight guard, not just the sig guard.
		const d = deferred<CompletionResult>();
		const completeFn = vi.fn((): Promise<CompletionResult> => d.promise);

		const keel = new KeelConductor();
		keel.attach(makeMockHost({ canComplete: true, completeFn }));

		const view = makeView(20, 4_000);
		keel.conduct(view); // pass 1 → launches
		keel.conduct(view); // pass 2 → still inflight → must NOT re-launch
		keel.conduct(view); // pass 3 → still inflight → must NOT re-launch

		expect(completeFn).toHaveBeenCalledTimes(1);

		// Clean up.
		d.reject(new Error("cleanup"));
	});
});
