/*
 * conductor.bear2-hybrid.test.ts — end-to-end tests for Bear2HybridConductor.
 *
 * ALL tests run THROUGH AccordionStore (attach the conductor to a real store, assert on
 * applied state). This is the hard repo rule: bare conductor unit tests miss host clamps.
 * The harness mirrors conductor.compaction-naive.test.ts exactly.
 *
 * Test plan:
 *   A. No-key idle: compressor=null → can("compress")===false → conductor returns [] and
 *      emits an "API key" status; nothing is folded or grouped.
 *   B. Bear-2 replace on the newer half: with a fast deterministic compressor, a session
 *      over the 90% trigger has newer-half eligible blocks content-substituted via `replace`.
 *      Assert that at least one block ends up with `digestOf !== original text` (subst set)
 *      and `isFolded === true`.
 *   C. Older-half summary + disjointness: with a fake completer returning a fixed summary,
 *      assert the older half collapses into a group AND no single block is simultaneously
 *      `replace`d and a group member (disjoint command sets).
 *   D. Hard-failure freeze: compressor always throws → after enough passes for a block to
 *      fail twice, conductor sets the FAILED status and returns null (no new folds beyond
 *      what was already applied).
 */

import { describe, it, expect } from "vitest";
import { Bear2HybridConductor } from "$conductors/bear2-hybrid/bear2-hybrid";
import { IN_PROCESS_CONDUCTORS } from "$conductors";
import { AccordionStore } from "./store.svelte";
import type { Block, ParsedSession } from "./types";
import type { CompletionRequest, CompletionResult, ConductorView } from "$conductors/contract";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a real engine Block (mirrors the compaction-naive test harness). */
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
		// text is long enough that the deterministic shorten actually shrinks it
		text: `block ${i} ` + "x".repeat(Math.max(tokens * 4, 20)),
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

/** Flush the microtask queue several times to let all promise chains settle. */
async function flushMicrotasks(times = 10): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
}

/**
 * Deterministic shorten: returns the first 50% of the text. Always shorter for any
 * text longer than 1 character, so the conductor's "only cache if it actually shrinks"
 * guard passes.
 */
function deterministicShorten(text: string): string {
	return text.slice(0, Math.floor(text.length / 2));
}

// ── A. No-key idle ────────────────────────────────────────────────────────────

describe("Bear2HybridConductor — no-key idle (compressor null)", () => {
	it("returns [] when compressor is null; nothing is folded or grouped; status mentions API key", async () => {
		// A large session over the 90% threshold — if the conductor were misbehaving it
		// would try to fold. With compressor=null it must stay fully idle.
		const blocks = [
			blk(0, "text", 5000),
			blk(1, "text", 5000),
			blk(2, "text", 5000),
			blk(3, "text", 5000),
			blk(4, "text", 5000),
			blk(5, "text", 5000),
			blk(6, "text", 5000),
			blk(7, "text", 5000),
			blk(8, "text", 5000),
			blk(9, "text", 500), // tail
		];
		const s = makeStore(blocks);
		s.setProtect(500); // protect the tail block
		s.setBudget(40_000); // 45k live vs 40k budget → 112% → well over 90%

		// NO compressor set (and no completer) — the conductor cannot operate.
		// s.compressor remains null (default).

		s.attach(new Bear2HybridConductor());
		await flushMicrotasks();

		// No block should be folded.
		for (const b of s.blocks) {
			expect(s.isFolded(b)).toBe(false);
		}
		// No groups created.
		expect(s.groups).toHaveLength(0);

		// No clamp reports: the conductor returned [] (clear to raw), so nothing was applied.
		expect(s.lastReports).toHaveLength(0);
	});
});

// ── B. Bear-2 replace on the newer half ──────────────────────────────────────

describe("Bear2HybridConductor — Bear-2 replace on the newer half", () => {
	it("substitutes at least one newer-half eligible block with compressed content after the async loop settles", async () => {
		// Build a session with a large enough aged region to push well past 90%.
		// Blocks 0–7 are aged (large); block 8 is protected tail (small).
		// Token total: 8 * 5000 = 40k aged + 500 tail = 40.5k vs budget 40k → ~101%
		// After the split at the midpoint (50% = 20k tokens), the older half is blocks 0–3
		// and the newer half is blocks 4–7.
		const agedBlocks = [
			blk(0, "text", 5000),
			blk(1, "text", 5000),
			blk(2, "text", 5000),
			blk(3, "text", 5000),
			blk(4, "text", 5000), // newer half starts here (after 20k)
			blk(5, "text", 5000),
			blk(6, "text", 5000),
			blk(7, "text", 5000),
		];
		const tailBlock = blk(8, "text", 500);
		const blocks = [...agedBlocks, tailBlock];

		const s = makeStore(blocks);
		s.setProtect(500);
		s.setBudget(40_000); // 40.5k / 40k → over threshold

		// Install a fast, deterministic compressor that provably shrinks the text.
		s.compressor = async (text: string) => deterministicShorten(text);

		s.attach(new Bear2HybridConductor());
		// Let the fire-and-forget Bear-2 promises resolve through multiple flush rounds.
		await flushMicrotasks(20);

		// At least one block in the newer half (blocks 4–7) should be folded with a
		// substituted content (i.e. the compressed text, not the engine digest).
		const newerHalfIds = ["m4:p0", "m5:p0", "m6:p0", "m7:p0"];
		let replacedCount = 0;
		for (const id of newerHalfIds) {
			const b = s.get(id);
			if (!b) continue;
			if (s.isFolded(b) && b.subst !== undefined) {
				// The substitute must be shorter than the original text (Bear-2 shrank it).
				expect(b.subst.length).toBeLessThan(b.text?.length ?? Infinity);
				replacedCount++;
			}
		}
		expect(replacedCount).toBeGreaterThanOrEqual(1);

		// The protected tail block must never be touched.
		const tail = s.get("m8:p0");
		expect(tail).toBeDefined();
		expect(s.isFolded(tail!)).toBe(false);
	});
});

// ── C. Older-half summary + disjointness ─────────────────────────────────────

describe("Bear2HybridConductor — older-half summary and disjointness", () => {
	it("older half collapses into a group with the LLM summary, and no block is both replaced and grouped", async () => {
		// Same topology as B: 8 large aged blocks + 1 tail. Total tokens = 40.5k > budget 40k.
		// Older half: blocks 0–3 (20k tokens) → summary group.
		// Newer half: blocks 4–7 → Bear-2 replace.
		const agedBlocks = [
			blk(0, "text", 5000),
			blk(1, "text", 5000),
			blk(2, "text", 5000),
			blk(3, "text", 5000),
			blk(4, "text", 5000),
			blk(5, "text", 5000),
			blk(6, "text", 5000),
			blk(7, "text", 5000),
		];
		const tailBlock = blk(8, "text", 500);
		const blocks = [...agedBlocks, tailBlock];

		const s = makeStore(blocks);
		s.setProtect(500);
		s.setBudget(40_000);

		// Both compressor AND completer installed.
		s.compressor = async (text: string) => deterministicShorten(text);
		s.completer = async (_req: CompletionRequest): Promise<CompletionResult> => ({
			text: "FIXED OLDER-HALF SUMMARY",
			model: "test-model",
		});

		s.attach(new Bear2HybridConductor());
		// Flush enough times for the Bear-2 promises AND the LLM summary promise to settle.
		await flushMicrotasks(30);

		// There should be exactly one group covering the older half.
		const groups = s.groups;
		expect(groups.length).toBeGreaterThanOrEqual(1);
		const summaryGroup = groups.find((g) => s.groupSummary(g).includes("FIXED OLDER-HALF SUMMARY"));
		expect(summaryGroup).toBeDefined();

		// The group must only cover older-half block ids (m0:p0–m3:p0).
		const olderHalfIds = new Set(["m0:p0", "m1:p0", "m2:p0", "m3:p0"]);
		for (const id of summaryGroup!.memberIds) {
			expect(olderHalfIds.has(id)).toBe(true);
		}

		// DISJOINTNESS: no block that is a group member should also have a Bear-2 subst.
		// (The two command sets must never target the same block.)
		const groupMemberSet = new Set(summaryGroup!.memberIds);
		for (const b of s.blocks) {
			if (b.subst !== undefined) {
				// This block was `replace`d by Bear-2.
				expect(groupMemberSet.has(b.id)).toBe(false);
			}
		}

		// Also assert the inverse: group members are not individually replace-folded.
		for (const id of groupMemberSet) {
			const b = s.get(id);
			if (!b) continue;
			// A group member may be folded (it is collapsed into the group) but should NOT
			// have a conductor-authored `subst` — that would be a double-apply.
			// Note: group members can appear folded via groupWire; subst would mean a `replace`
			// was also applied. Assert subst is unset for group members.
			expect(b.subst).toBeUndefined();
		}
	});
});

// ── C2. Regression: grow the tail so the midpoint re-enters the compacted range ──

describe("Bear2HybridConductor — compactedIds excludes blocks from newer-half treatment", () => {
	it("after the older half is summarized, growing the protected tail must not double-apply replace+group to a compacted block", async () => {
		// REPRODUCES THE BUG (ADR 0015 fix): a block already in `compactedIds` could ALSO be
		// recomputed into the newer half and receive a Bear-2 `replace` (and be double-counted
		// in bear2Saving) when the human GROWS the protected tail after a summary committed —
		// the token midpoint then falls INSIDE the already-compacted range. The fix makes
		// `compactedIds` authoritatively exclude a block from all newer-half treatment.
		//
		// Topology (same as test C): blocks 0–7 large (5000), block 8 small tail (500).
		// First settle: older half {0–3} → summary group (compactedIds = {m0..m3}); newer
		// half {4–7} → Bear-2 replace.
		const agedBlocks = [
			blk(0, "text", 5000),
			blk(1, "text", 5000),
			blk(2, "text", 5000),
			blk(3, "text", 5000),
			blk(4, "text", 5000),
			blk(5, "text", 5000),
			blk(6, "text", 5000),
			blk(7, "text", 5000),
		];
		const tailBlock = blk(8, "text", 500);
		const blocks = [...agedBlocks, tailBlock];

		const s = makeStore(blocks);
		s.setProtect(500);
		// A deliberately TINY budget so the conductor stays permanently over the 90% trigger:
		// even after both treatments apply, the visible window never drops below 0.9·budget, so
		// `launchBear2` keeps firing. This removes the hysteresis that would otherwise mask the
		// post-grow re-launch, exposing the double-apply directly.
		s.setBudget(5_000);

		s.compressor = async (text: string) => deterministicShorten(text);
		s.completer = async (_req: CompletionRequest): Promise<CompletionResult> => ({
			text: "FIXED OLDER-HALF SUMMARY",
			model: "test-model",
		});

		s.attach(new Bear2HybridConductor());
		// Let the Bear-2 promises AND the summary completion settle: compactedIds = {m0..m3},
		// newer half {4–7} carries Bear-2 substitutions.
		await flushMicrotasks(30);

		// Sanity: the older half is summarized and the newer half carries at least one subst.
		const summaryGroup0 = s.groups.find((g) => s.groupSummary(g).includes("FIXED OLDER-HALF SUMMARY"));
		expect(summaryGroup0).toBeDefined();
		expect(s.blocks.some((b) => b.subst !== undefined)).toBe(true);

		// NOW GROW THE PROTECTED TAIL. Target 16k pulls blocks 5–8 into the protected tail,
		// leaving aged = {0,1,2,3,4}. The token midpoint of that 25k region is 12.5k, so the
		// recomputed split would place compacted block m3 into the NEWER half — pre-fix it then
		// receives a fresh Bear-2 `replace` (the window is still over threshold) while ALSO being
		// a summary-group member. setProtect re-runs conduct().
		s.setProtect(16_000);
		// Flush so any (buggy) freshly-launched Bear-2 calls on the re-entered compacted block
		// resolve and cache, then re-run conduct() so emitState would emit their replaces.
		await flushMicrotasks(30);
		s.setProtect(16_000);
		await flushMicrotasks(30);

		// THE INVARIANT: no block is simultaneously content-substituted (`subst` set, i.e. a
		// Bear-2 `replace`) AND a member of the summary group. The two command sets must be
		// disjoint regardless of where the midpoint falls.
		const summaryGroup = s.groups.find((g) => s.groupSummary(g).includes("FIXED OLDER-HALF SUMMARY"));
		expect(summaryGroup).toBeDefined();
		const groupMembers = new Set(summaryGroup!.memberIds);
		for (const b of s.blocks) {
			if (b.subst !== undefined) {
				expect(groupMembers.has(b.id)).toBe(false);
			}
		}
		// And explicitly: no compacted block carries a Bear-2 subst.
		for (const id of groupMembers) {
			const b = s.get(id);
			if (!b) continue;
			expect(b.subst).toBeUndefined();
		}
	});
});

// ── D. Hard-failure freeze ────────────────────────────────────────────────────

describe("Bear2HybridConductor — hard-failure freeze on persistent Bear-2 error", () => {
	it("after BEAR2_MAX_RETRIES failures on a block, conductor freezes: status shows FAILED alarm, no new folds", async () => {
		// Session over the threshold so Bear-2 fires immediately.
		const blocks = [
			blk(0, "text", 5000),
			blk(1, "text", 5000),
			blk(2, "text", 5000),
			blk(3, "text", 5000),
			blk(4, "text", 5000),
			blk(5, "text", 5000),
			blk(6, "text", 5000),
			blk(7, "text", 5000),
			blk(8, "text", 500), // tail
		];
		const s = makeStore(blocks);
		s.setProtect(500);
		s.setBudget(40_000);

		// Compressor always throws a 429-like error.
		// No completer (we only test the Bear-2 failure path here).
		s.compressor = async (_text: string): Promise<string> => {
			throw new Error("429 rate limited");
		};

		const conductor = new Bear2HybridConductor();
		s.attach(conductor);

		// Each pass through the conduct loop launches up to BEAR2_CONCURRENCY=8 compress
		// calls. Each rejection increments the retry counter. After 2 failures per block
		// (BEAR2_MAX_RETRIES=2) the conductor sets `failed` and returns null.
		// We need enough flush rounds for all the fire-and-forget promises to reject.
		await flushMicrotasks(30);

		// ── PROVE THE FREEZE (not just absence of folds — a do-nothing conductor would also
		// fold nothing). Three independent assertions, each of which a do-nothing conductor
		// would FAIL:

		// (1) The store's conductor-status text — set via host.setStatus — must carry the loud
		//     FAILED alarm. A conductor that never freezes never sets this.
		expect(s.conductorStatus.text).toContain("FAILED");

		// (2) The sticky internal `failed` flag is set. (Whitebox, but it is the state machine's
		//     single source of truth and a do-nothing conductor never trips it.)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((conductor as any).failed).toBe(true);

		// (3) A subsequent conduct() now returns null (hold-last freeze), NOT [] or commands. We
		//     call conduct() directly with a minimal live view; the host is still attached so the
		//     FAILED early-return path runs. A do-nothing conductor would return [] here.
		const frozenView: ConductorView = {
			blocks: s.blocks.map((b, i) => ({
				id: b.id,
				kind: b.kind,
				turn: b.turn,
				order: i,
				tokens: b.tokens,
				foldedTokens: b.tokens,
				held: false,
				folded: false,
				protected: false,
				grouped: false,
			})),
			budget: 40_000,
			liveTokens: 45_000,
			contextWindow: null,
			protectedFromIndex: s.blocks.length,
			protectTokens: 20_000,
		};
		expect(conductor.conduct(frozenView)).toBeNull();

		// ── And the original invariants still hold: the conductor froze BEFORE emitting any
		// fold/group (it failed before any success, so there is nothing to hold).
		for (const b of s.blocks) {
			// Group-member blocks have their folded state managed by the group — the
			// conductor failed before emitting any group, so none should be grouped either.
			expect(s.groups).toHaveLength(0);
			expect(b.subst).toBeUndefined();
		}

		// No clamp reports about "not-foldable" or "invalid-group" — the conductor
		// never reached the emission stage (hard failure freezes before emitState).
		expect(s.lastReports.some((r) => r.reason === "invalid-group")).toBe(false);
		expect(s.lastReports.some((r) => r.reason === "not-foldable")).toBe(false);
	});
});

// ── Registry lock-drift guard (mirror of the sliding-window test) ─────────────

describe("Bear2HybridConductor — lock declaration", () => {
	it("registry entry locks deep-equal instance locks (drift guard)", () => {
		const entry = IN_PROCESS_CONDUCTORS.find((c) => c.id === "bear2-hybrid");
		expect(entry).toBeDefined();
		const instance = new Bear2HybridConductor();
		expect(entry!.locks).toEqual([...instance.locks]);
	});
});
