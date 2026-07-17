/*
 * compaction-naive.test.ts — golden tests for the ported NaiveCompactionConductor, driven by
 * TestHost + canned completions (per core/conductor/testhost.ts).
 *
 * Scenario numbering (0-100 tokens/block, budget 1000, high-water mark 900):
 *   `buildPass1Blocks()` — 12 blocks, indices 0-11, each 100 tokens.
 *     protect target 250 (cap 312.5) snaps the tail to the last 3 blocks (300 tokens), so with
 *     this exact setup `protectedFromIndex` is ALWAYS 9: aged = indices 0-8 (900 tokens, marked
 *     "AGED-i"), protected tail = indices 9-11 (300 tokens, marked "TAIL-i" — they age in on the
 *     recursive pass once more blocks are appended).
 *   `buildPass2AddedBlocks()` — 15 more 100-token blocks, indices 12-26 ("NEW-i"). Appended to a
 *     27-block conversation, the SAME protect target/cap snaps `protectedFromIndex` to 24: aged
 *     grows to indices 0-23, protected tail becomes indices 24-26 (the newest 3 blocks — their
 *     markers must never appear in any prompt).
 *
 * These numbers are exact consequences of `Truth`'s `computeProtectedFromIndex` (core/truth.ts)
 * given uniform 100-token blocks and a 250-token protect target — not hand-waved estimates — so
 * the "only aged blocks in the prompt" / "only newly-aged blocks on the recursive pass" assertions
 * below can check precise marker membership rather than vague existence.
 */
import { describe, expect, it } from "vitest";
import { TestHost } from "../../conductor/testhost";
import type { Block, BlockKind } from "../../types";
import { COMPACTION_SYSTEM, NaiveCompactionConductor } from "./compaction-naive";

const BUDGET = 1000; // TRIGGER (0.9) high-water mark = 900 tokens
const PROTECT = 250; // protect target; cap = 312.5 (PROTECT_OVERFLOW_CAP = 1.25)
const TOK = 100; // uniform per-block token cost used throughout

const SUMMARY_A = "Alpha summary body.";
const SUMMARY_B = "Beta summary body, updated.";

const FOLD_TAG_RE = /\{#[0-9a-z]{6} FOLDED\}/;

/** Flush the microtask queue enough times for a `host.complete()` promise chain (incl. the
 *  resolve/reject handler's synchronous `this.rerun()`) to fully settle. */
async function flush(times = 3): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
}

function mkBlock(id: string, order: number, kind: BlockKind, tokens: number, text: string, extra: Partial<Block> = {}): Block {
	return { id, kind, turn: order + 1, order, text, tokens, override: null, autoFolded: false, by: null, ...extra };
}

const idOf = (idx: number): string => `a:b${idx}:p0`;

/** 12 blocks, indices 0-11. 0-8 → aged ("AGED-i"), 9-11 → protected tail ("TAIL-i"). */
function buildPass1Blocks(): Block[] {
	return Array.from({ length: 12 }, (_, idx) => {
		const marker = idx <= 8 ? `AGED-${idx}` : `TAIL-${idx}`;
		return mkBlock(idOf(idx), idx, idx % 2 === 0 ? "user" : "text", TOK, marker);
	});
}

/** 15 more blocks, indices 12-26 ("NEW-i"). With buildPass1Blocks already appended, this pushes
 *  protectedFromIndex from 9 to 24 (see file banner). */
function buildPass2AddedBlocks(): Block[] {
	return Array.from({ length: 15 }, (_, i) => {
		const idx = 12 + i;
		return mkBlock(idOf(idx), idx, idx % 2 === 0 ? "user" : "text", TOK, `NEW-${idx}`);
	});
}

/** Attach a fresh conductor to a fresh host preloaded with `buildPass1Blocks()`, budget/protect
 *  set as documented above. Blocks appended and locks NOT applied (TestHost/adapter do not
 *  auto-apply a conductor's declared `locks` on attach — see the note on `locks` below). */
function setupHost(): { host: TestHost; conductor: NaiveCompactionConductor } {
	const host = new TestHost();
	host.setBudget(BUDGET);
	host.setProtect(PROTECT);
	host.appendBlocks(buildPass1Blocks());
	const conductor = new NaiveCompactionConductor();
	conductor.attach(host);
	return { host, conductor };
}

/** setupHost() + drive one successful first-pass compaction to completion. */
async function runPass1(summaryText = SUMMARY_A): Promise<{ host: TestHost; conductor: NaiveCompactionConductor }> {
	const { host, conductor } = setupHost();
	host.queueCompletion({ text: summaryText });
	host.commitTurn();
	await flush();
	return { host, conductor };
}

describe("NaiveCompactionConductor — trigger + first pass", () => {
	it("does not trigger below the 90% high-water mark", async () => {
		const host = new TestHost();
		host.setBudget(BUDGET);
		host.setProtect(0); // no protected tail — irrelevant to this test
		host.appendBlocks(Array.from({ length: 5 }, (_, i) => mkBlock(idOf(i), i, i % 2 === 0 ? "user" : "text", TOK, `LOW-${i}`)));
		const conductor = new NaiveCompactionConductor();
		conductor.attach(host);

		host.commitTurn();
		await flush();

		expect(host.completeLog.length).toBe(0); // 5*100 = 500 < 900 — never launches
		expect(host.truth.groups.length).toBe(0);
	});

	it("triggers at 90%: complete() gets the first-pass prompt (aged blocks only); one group results", async () => {
		const { host } = setupHost();
		host.queueCompletion({ text: SUMMARY_A });
		host.commitTurn();
		await flush();

		expect(host.completeLog.length).toBe(1);
		const req = host.completeLog[0];
		expect(req.system).toBe(COMPACTION_SYSTEM);
		expect(req.maxOutputTokens).toBe(8000); // MAX_SUMMARY_TOKENS, kept module-private as in the reference
		expect(req.prompt).toContain("<conversation>");
		expect(req.prompt).not.toContain("<previous-summary>");
		for (let i = 0; i <= 8; i++) expect(req.prompt).toContain(`AGED-${i}`); // every aged block present
		for (let i = 9; i <= 11; i++) expect(req.prompt).not.toContain(`TAIL-${i}`); // protected tail excluded

		expect(host.truth.groups.length).toBe(1);
		const g = host.truth.groups[0];
		expect(g.memberIds[0]).toBe(idOf(0));
		expect(g.memberIds[g.memberIds.length - 1]).toBe(idOf(8));
		const summary = host.truth.groupSummary(g);
		expect(summary).toBe(`[Compacted summary of 9 earlier messages]\n\n${SUMMARY_A}`);
		expect(summary).not.toMatch(FOLD_TAG_RE); // literal group digest — never a fold tag
	});
});

describe("NaiveCompactionConductor — recursive pass", () => {
	it("wraps <previous-summary> + only newly-aged blocks; the old compacted originals are never re-read", async () => {
		const { host } = await runPass1();

		host.appendBlocks(buildPass2AddedBlocks()); // pushes protectedFromIndex from 9 to 24
		host.queueCompletion({ text: SUMMARY_B });
		host.commitTurn();
		await flush();

		expect(host.completeLog.length).toBe(2);
		const req2 = host.completeLog[1];
		expect(req2.prompt).toContain("<previous-summary>");
		expect(req2.prompt).toContain(SUMMARY_A); // the prior summary text, embedded verbatim

		// The 9 blocks already compacted are NOT re-fed to the model (recursive amnesia by design).
		for (let i = 0; i <= 8; i++) expect(req2.prompt).not.toContain(`AGED-${i}`);
		// The old protected tail, now aged, IS newly fed.
		for (let i = 9; i <= 11; i++) expect(req2.prompt).toContain(`TAIL-${i}`);
		// The new blocks that are now aged ARE fed.
		for (let i = 12; i <= 23; i++) expect(req2.prompt).toContain(`NEW-${i}`);
		// The newest 3 blocks are still protected — never appear in any prompt.
		for (let i = 24; i <= 26; i++) expect(req2.prompt).not.toContain(`NEW-${i}`);

		expect(host.truth.groups.length).toBe(1); // the two runs (old + new group) merge into one
		const g = host.truth.groups[0];
		expect(g.memberIds[0]).toBe(idOf(0));
		expect(g.memberIds[g.memberIds.length - 1]).toBe(idOf(23));
		const summary = host.truth.groupSummary(g);
		expect(summary).toBe(`[Compacted summary of 24 earlier messages]\n\n${SUMMARY_B}`);
		expect(summary).not.toMatch(FOLD_TAG_RE);
	});
});

describe("NaiveCompactionConductor — hysteresis", () => {
	it("holds immediately after compaction — no re-trigger until new blocks age in", async () => {
		const { host } = await runPass1();
		expect(host.completeLog.length).toBe(1);
		expect(host.truth.groups.length).toBe(1);

		host.commitTurn(); // same aged/newlyAged set, nothing appended
		await flush();

		expect(host.completeLog.length).toBe(1); // no relaunch
		expect(host.truth.groups.length).toBe(1); // unchanged
	});
});

describe("NaiveCompactionConductor — reject path", () => {
	it("sets sticky status, refuses to relaunch on the identical aged set, relaunches on a genuinely new one", async () => {
		const { host } = setupHost();

		host.queueCompletionError(new Error("boom"));
		host.commitTurn();
		await flush();

		expect(host.completeLog.length).toBe(1);
		expect(host.truth.groups.length).toBe(0); // first pass failed — still raw
		expect(host.statusLog.length).toBeGreaterThan(0);
		const lastStatus = host.statusLog[host.statusLog.length - 1];
		expect(lastStatus.text).toMatch(/waiting for new context to age in/i);

		// Same aged set as the failed attempt — must NOT relaunch.
		host.commitTurn();
		await flush();
		expect(host.completeLog.length).toBe(1);

		// Genuinely new aged content changes `newlyAged` → relaunch is allowed; queue success this time.
		host.appendBlocks(Array.from({ length: 5 }, (_, i) => mkBlock(idOf(12 + i), 12 + i, "text", TOK, `RETRY-${12 + i}`)));
		host.queueCompletion({ text: SUMMARY_A });
		host.commitTurn();
		await flush();

		expect(host.completeLog.length).toBe(2);
		expect(host.truth.groups.length).toBe(1); // recovered
	});
});

describe("NaiveCompactionConductor — stale-completion guard", () => {
	it("a resolve after detach mutates nothing and proposes nothing", async () => {
		const { host, conductor } = setupHost();

		host.queueCompletion({ text: SUMMARY_A });
		host.commitTurn(); // launches the completion synchronously; the promise is not yet observed
		conductor.detach(); // aborts + nulls `inflight` before the pending .then can run

		await flush();

		expect(host.completeLog.length).toBe(1); // the call did happen
		expect(host.truth.groups.length).toBe(0); // but the stale guard discarded its result
		expect(host.statusLog[host.statusLog.length - 1].text).toBeNull(); // detach()'s clear stands
	});
});

describe("NaiveCompactionConductor — a held block splits the aged region", () => {
	it("emits two groups (one per side), both carrying the same summary; the held block stays untouched", async () => {
		const { host } = setupHost();
		host.humanPin(idOf(4)); // split point, inside the aged region (0-8)

		host.queueCompletion({ text: SUMMARY_A });
		host.commitTurn();
		await flush();

		expect(host.truth.groups.length).toBe(2);
		const g1 = host.truth.groups.find((g) => g.memberIds[0] === idOf(0))!;
		const g2 = host.truth.groups.find((g) => g.memberIds[0] === idOf(5))!;
		expect(g1).toBeDefined();
		expect(g2).toBeDefined();
		expect(g1.memberIds).toEqual([idOf(0), idOf(1), idOf(2), idOf(3)]);
		expect(g2.memberIds).toEqual([idOf(5), idOf(6), idOf(7), idOf(8)]);
		expect(host.truth.groupSummary(g1)).toBe(host.truth.groupSummary(g2));

		const held = host.truth.get(idOf(4))!;
		expect(held.override).toBe("pinned"); // untouched
		expect(host.truth.groups.some((g) => g.memberIds.includes(idOf(4)))).toBe(false);
	});
});

describe("NaiveCompactionConductor — all block kinds", () => {
	it("the aged region includes every kind; a tool_call/tool_result pair inside it is swallowed together", async () => {
		const host = new TestHost();
		host.setBudget(BUDGET);
		host.setProtect(0); // no protected tail — the whole 6-block conversation is aged
		host.appendBlocks([
			mkBlock("a:u0:p0", 0, "user", 160, "USER-0"),
			mkBlock("a:t1:p0", 1, "text", 160, "TEXT-1"),
			mkBlock("a:k2:p0", 2, "thinking", 160, "THINK-2"),
			mkBlock("a:c3:p0", 3, "tool_call", 160, "CALL-3", { callId: "call-1", toolName: "run" }),
			mkBlock("a:r4:p0", 4, "tool_result", 160, "RESULT-4", { callId: "call-1", toolName: "run" }),
			mkBlock("a:t5:p0", 5, "text", 160, "TEXT-5"),
		]);
		const conductor = new NaiveCompactionConductor();
		conductor.attach(host);
		host.queueCompletion({ text: SUMMARY_A });
		host.commitTurn();
		await flush();

		expect(host.truth.groups.length).toBe(1);
		const g = host.truth.groups[0];
		expect(g.memberIds).toEqual(["a:u0:p0", "a:t1:p0", "a:k2:p0", "a:c3:p0", "a:r4:p0", "a:t5:p0"]);
	});
});

describe("NaiveCompactionConductor — identity", () => {
	it("declares id/label/locks (locks are data only — the Phase-C host owns applying them)", () => {
		const conductor = new NaiveCompactionConductor();
		expect(conductor.id).toBe("compaction-naive");
		expect(conductor.label).toBe("Naive compaction");
		expect(conductor.locks).toEqual(["human-steering", "agent-unfold"]);
	});
});
