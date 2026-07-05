/*
 * conductor.handoff.test.ts — state-machine tests for HandoffConductor.
 *
 * The handoff conductor is a close cousin of NaiveCompactionConductor: same single-`group`-
 * over-the-aged-run shape with an LLM digest, same visible-window hysteresis, same in-flight /
 * stale-completion / attempt-key guards. Two things differ and are pinned here:
 *   1. It holds the `tail-size` lock with a small `tailTokens` (HANDOFF_TAIL_TOKENS) — it OWNS
 *      a deliberately small protected tail so the handoff absorbs nearly the whole conversation.
 *   2. The completion prompt/system is a HANDOFF DOCUMENT for a cold successor agent, not a
 *      compaction summary.
 *
 * Most tests are pure unit-level via a MockHost (promises resolved/rejected manually for
 * determinism); the tail-size lock and the end-to-end group are exercised THROUGH AccordionStore
 * at the end (MockHost does not apply host clamps, so only the store surfaces protected/
 * invalid-group behavior).
 */

import { describe, it, expect } from "vitest";
import { HandoffConductor, HANDOFF_TAIL_TOKENS } from "$conductors/handoff/handoff";
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
 * @param agedBlocks - blocks OLDER than the protected tail (i < protectedFromIndex)
 * @param tailBlocks - blocks IN the protected tail (i >= protectedFromIndex)
 * @param budget     - token budget
 * @param liveTokens - current RAW live token count (host clears conductor folds first)
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
		protectTokens: HANDOFF_TAIL_TOKENS,
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
	statusText = "";
	statusMetrics: Record<string, number | string | boolean> = {};

	pending: PendingCompletion[] = [];
	onRequestRerun: (() => void) | null = null;

	constructor(opts: MockHostOptions = {}) {
		this.canComplete = opts.canComplete ?? true;
	}

	can(cap: string): boolean {
		if (cap === "complete") return this.canComplete;
		return true;
	}

	complete(req: CompletionRequest): Promise<CompletionResult> {
		this.completeCalls.push(req);
		return new Promise<CompletionResult>((resolve, reject) => {
			this.pending.push({ req, resolve, reject });
		});
	}

	countTokens(text: string): number {
		return Math.ceil(text.length / 4);
	}

	digestOf(id: string): string | null {
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

	resolveNext(text: string): void {
		const p = this.pending.shift();
		if (!p) throw new Error("no pending completion to resolve");
		p.resolve({ text, model: "test-model" });
	}

	rejectNext(err: unknown = new Error("test rejection")): void {
		const p = this.pending.shift();
		if (!p) throw new Error("no pending completion to reject");
		p.reject(err);
	}
}

// ── 1. Under threshold / no aged region → [] and no complete calls ────────────

describe("HandoffConductor — under threshold / no aged region", () => {
	it("returns [] when liveTokens < 90% budget with no aged blocks", () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const view = makeView([], [vb("tail0")], 100_000, 10_000);
		expect(c.conduct(view)).toEqual([]);
		expect(host.completeCalls).toHaveLength(0);
	});

	it("returns [] when aged blocks exist but the visible window is below 90% (no prior handoff)", () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const view = makeView([vb("a0")], [vb("tail0")], 100_000, 89_999);
		expect(c.conduct(view)).toEqual([]);
		expect(host.completeCalls).toHaveLength(0);
	});

	it("returns null when host is not provided (no attach call)", () => {
		const c = new HandoffConductor();
		const view = makeView([vb("a0")], [vb("tail0")], 100_000, 96_000);
		expect(c.conduct(view)).toBeNull();
	});
});

// ── 2. First handoff: launch → null → resolve → ONE group command ─────────────

describe("HandoffConductor — first handoff cycle", () => {
	it("over threshold with aged blocks: first conduct launches exactly one complete and returns null", () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1"), vb("a2")];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);
		expect(c.conduct(view)).toBeNull();
		expect(host.completeCalls).toHaveLength(1);
		expect(host.pending).toHaveLength(1);
	});

	it("after completion resolves and requestRerun fires, next conduct returns ONE group command covering all aged blocks", async () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0", { order: 0 }), vb("a1", { order: 1 }), vb("a2", { order: 2 })];
		const view = makeView(aged, [vb("tail0")], 100_000, 96_000);

		c.conduct(view);
		let rerunFired = false;
		host.onRequestRerun = () => (rerunFired = true);
		host.resolveNext("Handoff document from the model.");
		await Promise.resolve();

		expect(rerunFired).toBe(true);
		expect(host.requestRerunCalls).toBe(1);

		const result = c.conduct(view);
		expect(result).not.toBeNull();
		expect(result!).toHaveLength(1);
		const g = result![0] as { kind: string; ids: string[]; digest: string };
		expect(g.kind).toBe("group");
		expect(g.ids).toEqual(["a0", "a2"]);
		// The digest is the handoff (preamble + model text). No {# FOLDED} tag — a fresh agent
		// cannot recover the originals.
		expect(g.digest).toContain("Handoff document from the model.");
		expect(g.digest).not.toMatch(/\{#\w+\s+FOLDED\}/);
		expect(g.digest).toContain("3 earlier message");
		expect(g.digest).toContain("Handoff from a previous session");
	});

	it("no replace/fold commands are ever emitted (the group is the sole command shape)", async () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const view = makeView([vb("a0"), vb("a1")], [vb("tail0")], 100_000, 96_000);
		c.conduct(view);
		host.resolveNext("A handoff.");
		await Promise.resolve();

		const result = c.conduct(view)!;
		expect(result.every((cmd) => cmd.kind === "group")).toBe(true);
	});
});

// ── 3. Idempotent re-emit ─────────────────────────────────────────────────────

describe("HandoffConductor — idempotent re-emit", () => {
	it("repeated conduct calls after a handoff exists return the same group without calling complete again", async () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const view = makeView([vb("a0"), vb("a1")], [vb("tail0")], 100_000, 96_000);
		c.conduct(view);
		host.resolveNext("The handoff.");
		await Promise.resolve();

		const r1 = c.conduct(view);
		const r2 = c.conduct(view);
		expect(host.completeCalls).toHaveLength(1);
		expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
		expect(r1!).toHaveLength(1);
		expect(r1![0].kind).toBe("group");
	});

	it("returns the same group even when liveTokens drops below threshold (once handed off, stays handed off)", async () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		c.conduct(makeView(aged, [vb("tail0")], 100_000, 96_000));
		host.resolveNext("Handoff.");
		await Promise.resolve();
		c.conduct(makeView(aged, [vb("tail0")], 100_000, 96_000)); // commit

		const result = c.conduct(makeView(aged, [vb("tail0")], 100_000, 50_000));
		expect(result!).toHaveLength(1);
		expect(result![0].kind).toBe("group");
		expect(host.completeCalls).toHaveLength(1);
	});
});

// ── 4. Hysteresis: visible-window band ────────────────────────────────────────

describe("HandoffConductor — hysteresis (visible-window band)", () => {
	it("after a handoff with large saving, a new aged block does NOT re-trigger while visible < 90%", async () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const a0 = vb("a0", { tokens: 40_000, order: 0 });
		const a1 = vb("a1", { tokens: 40_000, order: 1 });
		const tail0 = vb("tail0", { tokens: 4_000 });

		c.conduct(makeView([a0, a1], [tail0], 100_000, 96_000));
		host.resolveNext("FIRST HANDOFF");
		await Promise.resolve();
		c.conduct(makeView([a0, a1], [tail0], 100_000, 96_000)); // commit

		// A new block ages in but the saving keeps visible well below 90% → NO relaunch.
		const b0 = vb("b0", { tokens: 5_000, order: 2 });
		const result = c.conduct(makeView([a0, a1, b0], [tail0], 100_000, 101_000));

		expect(host.completeCalls).toHaveLength(1);
		const groups = result!.filter((cmd) => cmd.kind === "group") as Array<{ ids: string[]; digest: string }>;
		expect(groups).toHaveLength(1);
		expect(groups[0].ids).toEqual(["a0", "a1"]);
		expect(groups[0].digest).toContain("FIRST HANDOFF");
	});

	it("re-triggers once the visible window refills to 90% (new aged content pushes it over)", async () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const a0 = vb("a0", { tokens: 40_000, order: 0 });
		const a1 = vb("a1", { tokens: 40_000, order: 1 });
		const tail0 = vb("tail0", { tokens: 4_000 });

		c.conduct(makeView([a0, a1], [tail0], 100_000, 96_000));
		host.resolveNext("FIRST HANDOFF");
		await Promise.resolve();
		c.conduct(makeView([a0, a1], [tail0], 100_000, 96_000)); // commit; visible ≈ 16000

		const b0 = vb("b0", { tokens: 5_000, order: 2 });
		c.conduct(makeView([a0, a1, b0], [tail0], 100_000, 101_000)); // no relaunch
		expect(host.completeCalls).toHaveLength(1);

		// Grow the raw window until visible >= 90000 → relaunch.
		c.conduct(makeView([a0, a1, b0], [tail0], 100_000, 171_000));
		expect(host.completeCalls).toHaveLength(2);
		const secondPrompt = host.completeCalls[1].prompt;
		expect(secondPrompt).toContain("FIRST HANDOFF");
		expect(secondPrompt).toContain("content of b0");
	});
});

// ── 5. Recursive / amnesiac prompt ────────────────────────────────────────────

describe("HandoffConductor — recursive handoff (amnesia)", () => {
	it("second handoff prompt contains prior handoff + newly aged text but NOT the original first-batch text", async () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const a0 = vb("a0", { text: "ORIGINAL BLOCK A0 CONTENT" });
		const a1 = vb("a1", { text: "ORIGINAL BLOCK A1 CONTENT" });
		const tail0 = vb("tail0", { protected: true });

		c.conduct(makeView([a0, a1], [tail0], 100_000, 96_000));
		host.resolveNext("FIRST HANDOFF OUTPUT");
		await Promise.resolve();
		c.conduct(makeView([a0, a1], [tail0], 100_000, 96_000)); // commit

		const b0 = vb("b0", { text: "NEW BLOCK B0 CONTENT" });
		c.conduct(makeView([a0, a1, b0], [tail0], 100_000, 96_000));

		expect(host.completeCalls).toHaveLength(2);
		const p2 = host.completeCalls[1].prompt;
		expect(p2).toContain("FIRST HANDOFF OUTPUT");
		expect(p2).toContain("NEW BLOCK B0 CONTENT");
		expect(p2).not.toContain("ORIGINAL BLOCK A0 CONTENT");
		expect(p2).not.toContain("ORIGINAL BLOCK A1 CONTENT");
	});

	it("second handoff uses the <previous-handoff> and <conversation> wrappers with merge instructions", async () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		c.conduct(makeView(aged, [vb("tail0")], 100_000, 96_000));
		host.resolveNext("HANDOFF ONE");
		await Promise.resolve();
		c.conduct(makeView(aged, [vb("tail0")], 100_000, 96_000));

		c.conduct(makeView([...aged, vb("b0")], [vb("tail0")], 100_000, 96_000));
		const p2 = host.completeCalls[1].prompt;
		expect(p2).toContain("<previous-handoff>");
		expect(p2).toContain("</previous-handoff>");
		expect(p2).toContain("<conversation>");
		expect(p2).toContain("PRESERVE");
		expect(p2).toMatch(/verbatim/i);
	});
});

// ── 6. No double-launch while in-flight & retry gating ─────────────────────────

describe("HandoffConductor — launch gating", () => {
	it("while a complete is pending, further conduct calls do not call complete again", () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const view = makeView([vb("a0"), vb("a1")], [vb("tail0")], 100_000, 96_000);
		c.conduct(view);
		c.conduct(view);
		c.conduct(view);
		expect(host.completeCalls).toHaveLength(1);
	});

	it("after rejection, does NOT re-launch on the next conduct with the SAME newly-aged set; returns []", async () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const view = makeView([vb("a0"), vb("a1")], [vb("tail0")], 100_000, 96_000);
		c.conduct(view);
		host.rejectNext(new Error("network error"));
		await Promise.resolve();

		expect(c.conduct(view)).toEqual([]);
		expect(host.completeCalls).toHaveLength(1);
	});

	it("after rejection, DOES re-launch when a NEW aged block arrives (attempt key changes)", async () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		c.conduct(makeView(aged, [vb("tail0")], 100_000, 96_000));
		host.rejectNext(new Error("error"));
		await Promise.resolve();

		c.conduct(makeView([...aged, vb("b0")], [vb("tail0")], 100_000, 96_000));
		expect(host.completeCalls).toHaveLength(2);
	});
});

// ── 7. Unavailable path ────────────────────────────────────────────────────────

describe("HandoffConductor — unavailable path (can(complete)===false)", () => {
	it("returns [] and never calls complete when can returns false before a handoff exists", () => {
		const c = new HandoffConductor();
		const host = new MockHost({ canComplete: false });
		c.attach(host);

		const view = makeView([vb("a0"), vb("a1"), vb("a2")], [vb("tail0")], 100_000, 96_000);
		const result = c.conduct(view);
		expect(host.completeCalls).toHaveLength(0);
		expect(result).toEqual([]);
		expect(host.statusText).toContain("waiting for live model link");
	});

	it("does not fall back to a deterministic group in degrade mode", () => {
		const c = new HandoffConductor();
		const host = new MockHost({ canComplete: false });
		c.attach(host);

		const view = makeView([vb("a0"), vb("a1")], [vb("tail0")], 100_000, 96_000);
		expect(c.conduct(view)).toEqual([]);
	});
});

// ── 8. detach() lifecycle & stale-completion guards ────────────────────────────

describe("HandoffConductor — detach() lifecycle", () => {
	it("detach() aborts the AbortSignal passed to in-flight complete", () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		c.conduct(makeView([vb("a0"), vb("a1")], [vb("tail0")], 100_000, 96_000));
		const signal = host.pending[0].req.signal!;
		expect(signal.aborted).toBe(false);
		c.detach();
		expect(signal.aborted).toBe(true);
	});

	it("after detach(), conduct() returns null (no host)", () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);
		c.detach();
		expect(c.conduct(makeView([vb("a0")], [vb("tail0")], 100_000, 96_000))).toBeNull();
	});

	it("reattach resets prior handoff, handed-off ids, and retry key", async () => {
		const c = new HandoffConductor();
		const host1 = new MockHost();
		c.attach(host1);

		c.conduct(makeView([vb("old0"), vb("old1")], [vb("tail0")], 100_000, 96_000));
		host1.resolveNext("old handoff");
		await Promise.resolve();
		expect(c.conduct(makeView([vb("old0"), vb("old1")], [vb("tail0")], 100_000, 96_000))).not.toEqual([]);

		c.detach();
		const host2 = new MockHost();
		c.attach(host2);

		// Same ids, under threshold → no inherited handoff.
		expect(c.conduct(makeView([vb("old0"), vb("old1")], [vb("tail0")], 100_000, 50_000))).toEqual([]);
		// A failed attempt key from the prior lifetime must not suppress a fresh launch.
		expect(c.conduct(makeView([vb("old0"), vb("old1")], [vb("tail0")], 100_000, 96_000))).toBeNull();
		expect(host2.completeCalls).toHaveLength(1);
	});

	it("a stale completion resolving after re-attach does NOT corrupt the new session", async () => {
		const c = new HandoffConductor();
		const host1 = new MockHost();
		c.attach(host1);

		const view = makeView([vb("a0"), vb("a1")], [vb("tail0")], 100_000, 96_000);
		c.conduct(view);
		const stale = host1.pending[0];

		c.detach();
		const host2 = new MockHost();
		c.attach(host2);
		c.conduct(view); // launch B
		expect(host2.pending).toHaveLength(1);

		// A resolves late — guard must bail; B stays in-flight.
		stale.resolve({ text: "STALE HANDOFF FROM A", model: "old" });
		await Promise.resolve();
		expect(host2.pending).toHaveLength(1);
		expect(c.conduct(view)).toBeNull();

		host2.resolveNext("FRESH HANDOFF FROM B");
		await Promise.resolve();
		const g = c.conduct(view)!.find((cmd) => cmd.kind === "group") as { digest: string };
		expect(g.digest).toContain("FRESH HANDOFF FROM B");
		expect(g.digest).not.toContain("STALE HANDOFF FROM A");
	});
});

// ── 9. Prompt & system construction ───────────────────────────────────────────

describe("HandoffConductor — prompt construction", () => {
	it("first prompt wraps the conversation and includes all aged block text", () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [
			vb("a0", { text: "user: do the thing", kind: "user" }),
			vb("a1", { text: "assistant reply text", kind: "text" }),
		];
		c.conduct(makeView(aged, [vb("tail0")], 100_000, 96_000));

		const prompt = host.completeCalls[0].prompt;
		expect(prompt).toContain("<conversation>");
		expect(prompt).toContain("do the thing");
		expect(prompt).toContain("assistant reply text");
	});

	it("system prompt is the handoff template: fresh agent framing, verbatim original request, handoff sections", () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		c.conduct(makeView([vb("a0")], [vb("tail0")], 100_000, 96_000));
		const { system } = host.completeCalls[0];
		expect(system).toBeDefined();
		// Fresh-agent framing (distinct from the compaction template).
		expect(system).toMatch(/fresh AI coding agent/i);
		expect(system).toMatch(/NO memory/i);
		expect(system).toMatch(/do NOT continue the conversation/i);
		// Handoff-shaped sections.
		expect(system).toContain("## Original request");
		expect(system).toContain("## Task");
		expect(system).toContain("## Current state");
		expect(system).toContain("## Next steps");
		expect(system).toContain("## Key files");
		expect(system).toContain("## Gotchas");
		expect(system).toContain("## How to resume");
		// The sacred rule: original request reproduced verbatim.
		expect(system).toMatch(/VERBATIM/i);
	});

	it("maxOutputTokens is a positive number and an AbortSignal is passed", () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		c.conduct(makeView([vb("a0")], [vb("tail0")], 100_000, 96_000));
		const req = host.completeCalls[0];
		expect(req.maxOutputTokens!).toBeGreaterThan(0);
		expect(req.signal).toBeInstanceOf(AbortSignal);
	});
});

// ── 10. Held / grouped exclusion & threshold boundary ──────────────────────────

describe("HandoffConductor — held/grouped exclusion & threshold", () => {
	it("held and grouped blocks are excluded from the aged region", () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const held = vb("held0", { held: true });
		const grouped = vb("grp0", { grouped: true });
		const aged = vb("aged0");
		c.conduct(makeView([held, grouped, aged], [vb("tail0")], 100_000, 96_000));

		const prompt = host.completeCalls[0].prompt;
		expect(prompt).toContain("content of aged0");
		expect(prompt).not.toContain("content of held0");
		expect(prompt).not.toContain("content of grp0");
	});

	it("when ALL aged blocks are held, the aged region is empty → [] with no complete", () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const view = makeView([vb("h0", { held: true }), vb("h1", { held: true })], [vb("tail0")], 100_000, 96_000);
		expect(c.conduct(view)).toEqual([]);
		expect(host.completeCalls).toHaveLength(0);
	});

	it("triggers at exactly 90%, not at 89.999%", () => {
		const c1 = new HandoffConductor();
		const h1 = new MockHost();
		c1.attach(h1);
		expect(c1.conduct(makeView([vb("a0"), vb("a1")], [vb("tail0")], 100_000, 90_000))).toBeNull();
		expect(h1.completeCalls).toHaveLength(1);

		const c2 = new HandoffConductor();
		const h2 = new MockHost();
		c2.attach(h2);
		expect(c2.conduct(makeView([vb("a0"), vb("a1")], [vb("tail0")], 100_000, 89_999))).toEqual([]);
		expect(h2.completeCalls).toHaveLength(0);
	});
});

// ── 11. All kinds swallowed ────────────────────────────────────────────────────

describe("HandoffConductor — all block kinds are swallowed", () => {
	it("user, tool_call, tool_result, thinking, and text all appear in the prompt and are covered by the group", async () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [
			vb("u0", { kind: "user", text: "USER INTENT TEXT", order: 0, tokens: 500 }),
			vb("t0", { kind: "text", text: "assistant prose", order: 1, tokens: 500 }),
			vb("th0", { kind: "thinking", text: "private reasoning", order: 2, tokens: 500 }),
			vb("tc0", { kind: "tool_call", text: "TOOL_CALL_BODY", toolName: "bash", order: 3, tokens: 500 }),
			vb("tr0", { kind: "tool_result", text: "TOOL_RESULT_BODY", toolName: "bash", order: 4, tokens: 500 }),
		];
		c.conduct(makeView(aged, [vb("tail0")], 100_000, 96_000));

		const prompt = host.completeCalls[0].prompt;
		expect(prompt).toContain("USER INTENT TEXT");
		expect(prompt).toContain("assistant prose");
		expect(prompt).toContain("private reasoning");
		expect(prompt).toContain("TOOL_CALL_BODY");
		expect(prompt).toContain("TOOL_RESULT_BODY");

		host.resolveNext("the handoff");
		await Promise.resolve();
		const g = c.conduct(makeView(aged, [vb("tail0")], 100_000, 96_000))![0] as { ids: string[] };
		expect(g.ids).toEqual(["u0", "tr0"]);
	});
});

// ── 12. Empty completion is a failure ──────────────────────────────────────────

describe("HandoffConductor — empty completion result", () => {
	it("empty text is treated as failure: no header-only group, no requestRerun", async () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const view = makeView([vb("a0"), vb("a1")], [vb("tail0")], 100_000, 96_000);
		expect(c.conduct(view)).toBeNull();
		host.resolveNext("   \n\t  ");
		await Promise.resolve();
		expect(host.statusText).toContain("empty document");
		expect(c.conduct(view)).toEqual([]);
		expect(host.requestRerunCalls).toBe(0);
	});

	it("an empty result does NOT clobber a prior committed handoff", async () => {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);

		const aged = [vb("a0"), vb("a1")];
		c.conduct(makeView(aged, [vb("tail0")], 100_000, 96_000));
		host.resolveNext("REAL HANDOFF");
		await Promise.resolve();
		c.conduct(makeView(aged, [vb("tail0")], 100_000, 96_000));

		c.conduct(makeView([...aged, vb("b0")], [vb("tail0")], 100_000, 96_000)); // launch #2
		host.resolveNext("   ");
		await Promise.resolve();

		const g = c.conduct(makeView([...aged, vb("b0")], [vb("tail0")], 100_000, 96_000))!
			.find((cmd) => cmd.kind === "group") as { digest: string };
		expect(g.digest).toContain("REAL HANDOFF");
	});
});

// ── 13. Vanished handed-off blocks (regression) ───────────────────────────────

describe("HandoffConductor — vanished handed-off blocks", () => {
	async function setup(): Promise<{ c: HandoffConductor; a: ViewBlock; b: ViewBlock; d: ViewBlock }> {
		const c = new HandoffConductor();
		const host = new MockHost();
		c.attach(host);
		const a = vb("a", { order: 0 });
		const b = vb("b", { order: 1 });
		const d = vb("d", { order: 2 });
		c.conduct(makeView([a, b, d], [vb("tail0")], 100_000, 96_000));
		host.resolveNext("THE HANDOFF");
		await Promise.resolve();
		c.conduct(makeView([a, b, d], [vb("tail0")], 100_000, 96_000)); // commit
		return { c, a, b, d };
	}

	it("when the first survivor vanishes, the group re-homes to the remaining contiguous survivors", async () => {
		const { c, b, d } = await setup();
		const g = c.conduct(makeView([b, d], [vb("tail0")], 100_000, 96_000))![0] as { ids: string[] };
		expect(g.ids).toEqual(["b", "d"]);
	});

	it("when ALL handed-off blocks vanish, returns []", async () => {
		const { c } = await setup();
		expect(c.conduct(makeView([], [vb("tail0")], 100_000, 10_000))).toEqual([]);
	});

	it("a held block splitting the survivors yields one group per side", async () => {
		const { c, a, b, d } = await setup();
		const result = c.conduct(makeView([a, { ...b, held: true }, d], [vb("tail0")], 100_000, 96_000))!;
		const groups = result.filter((cmd) => cmd.kind === "group") as Array<{ ids: string[] }>;
		expect(groups).toHaveLength(2);
		expect(groups[0].ids).toEqual(["a", "a"]);
		expect(groups[1].ids).toEqual(["d", "d"]);
	});
});

// ── 14. Lock declaration ───────────────────────────────────────────────────────

describe("HandoffConductor — lock declaration", () => {
	it("declares all three steering locks and a small positive tailTokens", () => {
		const c = new HandoffConductor();
		expect(c.locks).toEqual(["human-steering", "agent-unfold", "tail-size"]);
		expect(c.tailTokens).toBe(HANDOFF_TAIL_TOKENS);
		expect(c.tailTokens).toBeGreaterThan(0);
		// Distinctly smaller than the human's default ~20k tail — that is the "fresh start".
		expect(c.tailTokens).toBeLessThan(20_000);
	});
});

// ── 15. AccordionStore integration ─────────────────────────────────────────────

describe("HandoffConductor — AccordionStore integration", () => {
	it("delivers the handoff as a single folded group, owns a small tail, and gates the human's tail dial", async () => {
		// ~32k of aged history + a small newest tail. Budget tight so liveTokens >= 90%.
		const blocks = [
			blk(0, "user", 2000, { text: "opening user request" }),
			blk(1, "text", 10000, { text: "assistant work one" }),
			blk(2, "tool_result", 10000, { text: "big tool output" }),
			blk(3, "thinking", 10000, { text: "long reasoning" }),
			blk(4, "text", 1000, { text: "the newest turn" }),
		];
		const s = makeStore(blocks);
		s.setBudget(20_000);
		s.completer = async () => ({ text: "FRESH-START HANDOFF DOC", model: "test-model" });

		s.attach(new HandoffConductor());
		await flushMicrotasks();

		// The conductor owns the tail via the 8k tail-size lock, NOT the human's 20k default.
		// Walk-back (target 8000, 25% cap = 10000): newest block m4=1000 < 8000, and adding
		// m3=10000 would breach the 10000 cap → the boundary lands at index 4 (only m4 protected).
		// A human 20k tail on these same blocks would protect down to index 2 (m2,m3,m4 ≈ 21000),
		// so this exact index is the proof the conductor's 8k tail — not the 20k default — is live.
		expect(s.protectedFromIndex).toBe(4);
		expect(s.protectedTokens).toBe(1000); // only the newest block, per the cap

		// One conductor-owned, folded group carrying the handoff verbatim (no drop group).
		expect(s.groups.length).toBe(1);
		const g = s.groups[0];
		expect(g.folded).toBe(true);
		expect(g.by).toBe("auto");
		expect(s.isDropGroup(g)).toBe(false);
		expect(s.groupSummary(g)).toContain("FRESH-START HANDOFF DOC");

		// The group covers the oldest blocks (incl. the user block) but NOT the newest tail block.
		expect(g.memberIds).toContain("m0:p0");
		expect(g.memberIds).not.toContain("m4:p0");

		// Happy path: no invalid-group / not-foldable / protected clamp fired.
		expect(s.lastReports.some((r) => r.reason === "invalid-group")).toBe(false);
		expect(s.lastReports.some((r) => r.reason === "not-foldable")).toBe(false);
		expect(s.lastReports.some((r) => r.reason === "protected")).toBe(false);

		// The human's tail dial is inert under the tail-size lock: setProtect is a no-op.
		const before = s.protectedFromIndex;
		s.setProtect(200_000);
		expect(s.protectedFromIndex).toBe(before);
	});

	it("owns a demonstrably SMALLER tail than a human 20k tail on the same session (the fresh-start claim)", async () => {
		// The whole justification for a separate conductor is that it discards more of the working
		// tail than in-place compaction. Prove it differentially on identical blocks: six 5k blocks.
		//   Human 20k tail:  walk-back protects newest 4 (5+5+5+5=20000) → protectedFromIndex 2.
		//   Handoff 8k tail: walk-back protects newest 2 (5+5=10000, ≤ 10000 cap) → index 4.
		const mk = () => [
			blk(0, "user", 5000, { text: "ask" }),
			blk(1, "text", 5000, { text: "a" }),
			blk(2, "text", 5000, { text: "b" }),
			blk(3, "text", 5000, { text: "c" }),
			blk(4, "text", 5000, { text: "d" }),
			blk(5, "text", 5000, { text: "e" }),
		];

		// Human baseline: no conductor (default collaborative), explicit 20k tail.
		const sHuman = makeStore(mk());
		sHuman.setProtect(20_000);
		expect(sHuman.protectedFromIndex).toBe(2);

		// Handoff: 8k tail-size lock owns the tail.
		const sHandoff = makeStore(mk());
		sHandoff.setBudget(20_000);
		sHandoff.completer = async () => ({ text: "H", model: "test-model" });
		sHandoff.attach(new HandoffConductor());
		await flushMicrotasks();

		expect(sHandoff.protectedFromIndex).toBe(4);
		// Strictly fewer blocks kept live → strictly more of the session folded into the handoff.
		expect(sHandoff.protectedFromIndex).toBeGreaterThan(sHuman.protectedFromIndex);
		expect(sHandoff.protectedTokens).toBeLessThan(sHuman.protectedTokens);
	});

	it("re-handoffs recursively when new blocks age in over the high-water mark", async () => {
		const blocks = [
			blk(0, "text", 10000, { text: "first aged block" }),
			blk(1, "text", 10000, { text: "second aged block" }),
			blk(2, "text", 1000, { text: "tail" }),
		];
		const s = makeStore(blocks);
		s.setBudget(18_000);
		let calls = 0;
		s.completer = async () => ({ text: `HANDOFF ${++calls}`, model: "test-model" });

		s.attach(new HandoffConductor());
		await flushMicrotasks();

		expect(s.groups.length).toBe(1);
		expect(s.groupSummary(s.groups[0])).toContain("HANDOFF 1");
		expect(calls).toBe(1);

		// A large newly-aged block so the raw window climbs back past the high-water mark even
		// after the first handoff's saving (visible = liveTokens − savedTokens).
		s.appendBlocks([
			blk(3, "text", 22000, { text: "newly aged content" }),
			blk(4, "text", 1000, { text: "new tail" }),
		]);
		await flushMicrotasks();

		expect(calls).toBe(2);
		expect(s.groups.length).toBe(1);
		expect(s.groupSummary(s.groups[0])).toContain("HANDOFF 2");
		expect(s.groups[0].memberIds).toContain("m3:p0");
	});

	it("boundary straggler: a multi-part message split by the small 8k tail refuses the group that pass, then self-heals", async () => {
		// The host's tail walk-back is block-by-block and can land the 8k boundary INSIDE one
		// multi-part assistant message. The small tail makes this more reachable than naive
		// compaction's 20k tail, so pin it: the tail-straddling group is refused `invalid-group`
		// (blocks stay live, no data loss), and it heals the moment a newer block pushes the
		// split message fully below the tail.
		//
		// Message "m2" is three ~4k parts. Walk-back (target 8000, 25% cap = 10000): protects
		// m2:p2 (4000) + m2:p1 (4000) = 8000 ≥ target, so m2:p0 is left aged — splitting m2.
		const blocks = [
			blk(0, "user", 5000, { id: "m0:p0", text: "the ask" }),
			blk(1, "text", 20000, { id: "m1:p0", text: "big old work" }),
			blk(2, "thinking", 4000, { id: "m2:p0", turn: 3, text: "m2 part 0" }),
			blk(3, "text", 4000, { id: "m2:p1", turn: 3, text: "m2 part 1" }),
			blk(4, "text", 4000, { id: "m2:p2", turn: 3, text: "m2 part 2" }),
		];
		const s = makeStore(blocks);
		s.setBudget(20_000);
		s.completer = async () => ({ text: "STRADDLE HANDOFF", model: "test-model" });

		s.attach(new HandoffConductor());
		await flushMicrotasks();

		// The handoff committed internally, but the group [m0:p0 .. m2:p0] snaps outward to the
		// whole m2 message (m2:p1/m2:p2 are protected) → reaches into the tail → refused.
		expect(s.lastReports.some((r) => r.reason === "invalid-group")).toBe(true);
		expect(s.groups.length).toBe(0);

		// A newer message ages in and pushes all of m2 below the 8k tail → the group is now a
		// valid whole-message run and applies (self-heal). No stranding.
		s.appendBlocks([blk(5, "text", 8000, { id: "m3:p0", text: "new tail" })]);
		await flushMicrotasks();

		expect(s.groups.length).toBe(1);
		const g = s.groups[0];
		expect(s.groupSummary(g)).toContain("STRADDLE HANDOFF");
		// The whole split message is now inside the group (snap swept its siblings in).
		expect(g.memberIds).toContain("m2:p0");
		expect(g.memberIds).toContain("m2:p1");
		expect(g.memberIds).toContain("m2:p2");
		expect(s.lastReports.some((r) => r.reason === "invalid-group")).toBe(false);
	});
});

// ── 16. dispose() aborts in-flight completion ──────────────────────────────────

describe("HandoffConductor — dispose() cleanup", () => {
	it("aborts an in-flight handoff completion when the store is disposed", async () => {
		const blocks = [
			blk(0, "text", 10000, { text: "first aged block" }),
			blk(1, "text", 10000, { text: "second aged block" }),
			blk(2, "text", 1000, { text: "tail" }),
		];
		const s = makeStore(blocks);
		s.setBudget(18_000);

		let captured: AbortSignal | undefined;
		s.completer = (req: CompletionRequest) => {
			captured = req.signal;
			return new Promise<CompletionResult>(() => {}); // never settles
		};

		s.attach(new HandoffConductor());
		await flushMicrotasks();

		expect(captured).toBeInstanceOf(AbortSignal);
		expect(captured!.aborted).toBe(false);

		s.dispose();
		expect(captured!.aborted).toBe(true);
		expect(s.conductor).toBeNull();
	});
});
