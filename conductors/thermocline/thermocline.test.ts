// thermocline.test.ts — the epoch machine driven against the in-process TestHost.
//
// The conductor is written ONLY against `ConductorHost`, so the SAME class Phase C will run in a
// separate process (via the remote SDK) is exercised here in-process against a real Truth. Covers:
//   • EMERGENCY: over-cap → deterministic plan proposed immediately, NO host.complete.
//   • PREPARE→COMMIT with canned completions (the LLM digest lands on the folded block).
//   • prepareToken discard on supersede (an agent recall mid-prepare voids the epoch).
//   • reconcilePlan / planWithRealStratumTokens / dropOwnStrataOldestFirst (pure commit helpers).
//   • HOLD dedup — a steady-state tick re-plans nothing and proposes nothing (rev unchanged).
//   • probe-absent fallback — an empty/rejecting scorer still compresses via age-based rungs.
//   • persistence round-trip — write after commit, restore + validate against live ids (temp dir).
import { describe, test, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestHost } from "../../core/conductor/testhost";
import type { Block } from "../../core/types";
import { ThermoclineConductor, reconcilePlan, planWithRealStratumTokens, dropOwnStrataOldestFirst } from "./thermocline";
import type { Plan, ConductorView, ViewBlock } from "./policy";

// ── helpers ───────────────────────────────────────────────────────────────────────────────────
const flush = () => new Promise<void>((r) => setTimeout(r, 0)); // flush microtasks (async prepare)
const emptyScorer = async () => new Map<string, number>();
const rejectScorer = async () => {
	throw new Error("probe absent");
};

function block(o: Partial<Block> & { id: string; order: number }): Block {
	return {
		id: o.id,
		kind: o.kind ?? "text",
		turn: o.turn ?? 1,
		order: o.order,
		text: o.text ?? o.id,
		tokens: o.tokens ?? 1000,
		toolName: o.toolName,
		callId: o.callId,
		isError: o.isError,
		override: null,
		autoFolded: false,
		by: null,
	};
}

/** N tool_call+tool_result pairs — NON-foldable units, so only age-based strata (groups) can compress. */
function pairs(n: number): Block[] {
	const out: Block[] = [];
	for (let i = 0; i < n; i++) {
		out.push(block({ id: `call${i}`, kind: "tool_call", callId: `c${i}`, tokens: 500, order: i * 2, toolName: "read_file" }));
		out.push(block({ id: `res${i}`, kind: "tool_result", callId: `c${i}`, tokens: 9_500, order: i * 2 + 1, text: `result body ${i}` }));
	}
	return out;
}

// ── EMERGENCY: over cap → deterministic, no LLM ──────────────────────────────────────────────
test("EMERGENCY: over the hard cap → deterministic compression, NO host.complete", async () => {
	const host = new TestHost();
	const cond = new ThermoclineConductor({ scorer: emptyScorer, sessionKey: null });
	cond.attach(host);
	host.setBudget(5_000);
	host.setProtect(300);
	host.appendBlocks(Array.from({ length: 10 }, (_, i) => block({ id: `b${i}`, order: i, tokens: 1_000 })));
	await flush();

	expect(host.completeLog.length).toBe(0); // emergency is DETERMINISTIC — never calls the model
	expect(host.truth.blocks.some((b) => host.truth.isFolded(b))).toBe(true); // it compressed
	expect(host.truth.stats().liveTokens).toBeLessThanOrEqual(5_000); // ≤ the hard cap
});

// ── PREPARE → COMMIT with canned completions ─────────────────────────────────────────────────
test("PREPARE→COMMIT: the canned LLM digest lands on the folded block", async () => {
	const host = new TestHost();
	const cond = new ThermoclineConductor({ scorer: emptyScorer, sessionKey: null });
	cond.attach(host);
	host.setBudget(12_000);
	host.setProtect(300);
	for (let i = 0; i < 4; i++) host.queueCompletion({ text: `CANNED-DIGEST-${i}` });
	host.appendBlocks(Array.from({ length: 10 }, (_, i) => block({ id: `b${i}`, order: i, tokens: 1_000, text: `body of block ${i}` })));
	await flush();

	expect(host.completeLog.length).toBeGreaterThanOrEqual(1); // the LLM digest path fired
	const foldedWithDigest = host.truth.blocks.some((b) => host.truth.isFolded(b) && (b.subst ?? "").includes("CANNED-DIGEST"));
	expect(foldedWithDigest).toBe(true);
});

// ── prepareToken discard on supersede (agent recall mid-prepare) ─────────────────────────────
test("prepareToken discard: an agent recall mid-prepare voids the in-flight epoch (no commit)", async () => {
	const host = new TestHost();
	const cond = new ThermoclineConductor({ scorer: emptyScorer, sessionKey: null });
	cond.attach(host);
	host.setBudget(12_000);
	host.setProtect(300);
	for (let i = 0; i < 4; i++) host.queueCompletion({ text: `CANNED-${i}` });
	host.appendBlocks(Array.from({ length: 10 }, (_, i) => block({ id: `b${i}`, order: i, tokens: 1_000 })));
	// PREPARE has fired host.complete synchronously and is suspended at Promise.allSettled.
	expect(host.completeLog.length).toBeGreaterThanOrEqual(1);
	// The agent reaches back into a block — consumes a by:"agent" recall state-change → bumps
	// prepareToken so the resuming prepare discards itself before committing.
	host.agentRecall("b0");
	await flush();

	expect(host.truth.blocks.every((b) => !host.truth.isFolded(b))).toBe(true); // the epoch never committed
	expect(host.truth.groups.length).toBe(0);
});

// ── reconcile / real-token / drop-own commit helpers (pure) ──────────────────────────────────
describe("commit helpers", () => {
	const mkPlan = (): Plan => ({
		folds: [{ unitId: "a", ids: ["a"], tier: "digest" }],
		strata: [{ ids: ["b", "c"], unitIds: ["b", "c"], memberIds: ["b", "c"], digestKind: "summary", summaryTokens: 100 }],
		targetTokens: 0,
		cap: 0,
		projected: 0,
	});

	test("reconcilePlan drops a fold whose id the agent touched, keeps the rest", () => {
		const out = reconcilePlan(mkPlan(), new Set(["a"]));
		expect(out.folds.length).toBe(0);
		expect(out.strata.length).toBe(1);
	});
	test("reconcilePlan drops a whole stratum when ANY member was touched", () => {
		const out = reconcilePlan(mkPlan(), new Set(["c"]));
		expect(out.strata.length).toBe(0);
		expect(out.folds.length).toBe(1);
	});
	test("reconcilePlan with an empty touched set is a no-op (same reference)", () => {
		const p = mkPlan();
		expect(reconcilePlan(p, new Set())).toBe(p);
	});
	test("planWithRealStratumTokens substitutes the real summary length (~len/4)", () => {
		const out = planWithRealStratumTokens(mkPlan(), new Map([["stratum:b", "y".repeat(800)]]));
		expect(out.strata[0].summaryTokens).toBe(200); // 800 chars → 200 tokens, was 100 estimate
	});
	test("dropOwnStrataOldestFirst converts the OLDER stratum first (conversation order)", () => {
		const v: ConductorView = {
			blocks: [
				{ id: "old", kind: "text", turn: 1, order: 0, tokens: 5_000, foldedTokens: 40, held: false, folded: true, protected: false, grouped: true, sent: true } as ViewBlock,
				{ id: "new", kind: "text", turn: 1, order: 9, tokens: 5_000, foldedTokens: 40, held: false, folded: true, protected: false, grouped: true, sent: true } as ViewBlock,
			],
			budget: 100, contextWindow: 100, liveTokens: 10_000, protectedFromIndex: 2, protectTokens: 0,
		};
		// Array order [new, old] — a naive walk would drop "new" first; conversation order drops "old".
		const plan: Plan = {
			folds: [],
			strata: [
				{ ids: ["new", "new"], unitIds: ["new"], memberIds: ["new"], digestKind: "summary", summaryTokens: 100 },
				{ ids: ["old", "old"], unitIds: ["old"], memberIds: ["old"], digestKind: "summary", summaryTokens: 100 },
			],
			targetTokens: 100, cap: 100, projected: 0,
		};
		dropOwnStrataOldestFirst(plan, v, 100);
		const older = plan.strata.find((s) => s.ids[0] === "old")!;
		expect(older.digestKind).toBe("drop");
	});
});

// ── HOLD dedup — a steady-state tick re-plans nothing ─────────────────────────────────────────
test("HOLD dedup: a stable tick after an epoch proposes nothing (Truth rev unchanged)", async () => {
	const host = new TestHost();
	const cond = new ThermoclineConductor({ scorer: emptyScorer, sessionKey: null });
	cond.attach(host);
	host.setBudget(5_000);
	host.setProtect(300);
	host.appendBlocks(Array.from({ length: 10 }, (_, i) => block({ id: `b${i}`, order: i, tokens: 1_000 })));
	await flush();
	expect(host.truth.blocks.some((b) => host.truth.isFolded(b))).toBe(true);

	const revAfterEpoch = host.truth.rev;
	host.commitTurn(); // a HOLD tick — nothing changed, so nothing should be re-proposed
	await flush();
	expect(host.truth.rev).toBe(revAfterEpoch); // no redundant re-plan / re-propose
});

// ── no-double-count regression — a SECOND over-budget epoch must still fire ───────────────────
// Guards the raw-baseline fix: stats().liveTokens ALREADY reflects our own folds, so if `fill` used
// it (instead of stats.fullTokens) it would subtract our folds a SECOND time, read far too low, and
// the second over-budget batch would silently NOT compress. With the correct raw baseline, epoch 2
// fires and the new content is compressed back under cap.
test("no double-count: after epoch 1 folds, a second over-budget batch still triggers compression", async () => {
	const host = new TestHost();
	const cond = new ThermoclineConductor({ scorer: emptyScorer, sessionKey: null });
	cond.attach(host);
	host.setBudget(5_000);
	host.setProtect(300);

	// Epoch 1: 6 blocks over budget → emergency compresses to ~lowWater.
	host.appendBlocks(Array.from({ length: 6 }, (_, i) => block({ id: `a${i}`, order: i, tokens: 1_000 })));
	await flush();
	expect(host.truth.blocks.some((b) => host.truth.isFolded(b))).toBe(true);
	const foldedAfterEpoch1 = host.truth.blocks.filter((b) => host.truth.isFolded(b)).length;

	// A fresh over-budget batch lands. With the buggy stats.liveTokens baseline, fill would read ~0.4
	// and NO epoch would fire, leaving this batch (6k tokens) live and the context ~9k over a 5k cap.
	host.appendBlocks(Array.from({ length: 6 }, (_, i) => block({ id: `z${i}`, order: 6 + i, tokens: 1_000 })));
	await flush();

	expect(host.truth.stats().liveTokens).toBeLessThanOrEqual(5_000); // epoch 2 fired and compressed
	expect(host.truth.blocks.filter((b) => host.truth.isFolded(b)).length).toBeGreaterThan(foldedAfterEpoch1);
});

// ── probe-absent fallback — empty/rejecting scorer still compresses via age-based rungs ───────
test("probe-absent fallback: a rejecting scorer still compresses (age-based strata, no LLM)", async () => {
	const host = new TestHost();
	const cond = new ThermoclineConductor({ scorer: rejectScorer, sessionKey: null });
	cond.attach(host);
	host.setBudget(30_000);
	host.setProtect(300);
	host.appendBlocks(pairs(8)); // non-foldable pairs → only age-based strata can compress
	await flush(); // let the rejecting scorer settle (must not crash / leak an unhandled rejection)

	expect(host.completeLog.length).toBe(0); // deterministic emergency — no model calls
	expect(host.truth.groups.length).toBeGreaterThanOrEqual(1); // age-based strata carried the strategy
	expect(host.truth.stats().liveTokens).toBeLessThanOrEqual(30_000);
});

// ── persistence round-trip — write after commit, restore + validate against live ids ─────────
test("persistence round-trip: strata persisted after commit are restored and re-applied", async () => {
	const dir = mkdtempSync(join(tmpdir(), "thermo-persist-"));
	const key = "roundtrip";

	// Conductor A commits a deep zone under budget pressure, then persists it.
	const hostA = new TestHost();
	const condA = new ThermoclineConductor({ scorer: emptyScorer, persistDir: dir, sessionKey: key });
	condA.attach(hostA);
	hostA.setBudget(30_000);
	hostA.setProtect(300);
	hostA.appendBlocks(pairs(8));
	await flush(); // emergency commit → schedulePersist (queueMicrotask) → persistNow

	const saved = JSON.parse(readFileSync(join(dir, `thermocline-state-${key}.json`), "utf8"));
	expect(Array.isArray(saved.strata)).toBe(true);
	expect(saved.strata.length).toBeGreaterThanOrEqual(1);
	const savedMembers: string[] = saved.strata.flatMap((s: { memberIds: string[] }) => s.memberIds);
	expect(savedMembers.length).toBeGreaterThan(0);

	// Conductor B (same persistDir + sessionKey) restores on attach and re-applies on the first view.
	const hostB = new TestHost();
	const condB = new ThermoclineConductor({ scorer: emptyScorer, persistDir: dir, sessionKey: key });
	condB.attach(hostB);
	hostB.setBudget(200_000); // roomy → no emergency clobbers the restored deep zone on the first tick
	hostB.setProtect(300);
	hostB.appendBlocks(pairs(8)); // SAME block ids → restore validation keeps every stratum
	await flush();

	expect(hostB.truth.groups.length).toBeGreaterThanOrEqual(1); // the restored strata were re-grouped
	const groupMembers = new Set(hostB.truth.groups.flatMap((g) => g.memberIds));
	expect(savedMembers.some((id) => groupMembers.has(id))).toBe(true);
});

// ── restore validation drops strata whose members vanished ───────────────────────────────────
test("restore validation: a stratum with a vanished member is dropped (never grouped)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "thermo-stale-"));
	const key = "stale";
	const hostA = new TestHost();
	const condA = new ThermoclineConductor({ scorer: emptyScorer, persistDir: dir, sessionKey: key });
	condA.attach(hostA);
	hostA.setBudget(30_000);
	hostA.setProtect(300);
	hostA.appendBlocks(pairs(8));
	await flush();

	// Conductor B restores, but the new session has DIFFERENT block ids — every stratum is stale.
	const hostB = new TestHost();
	const condB = new ThermoclineConductor({ scorer: emptyScorer, persistDir: dir, sessionKey: key });
	condB.attach(hostB);
	hostB.setBudget(200_000);
	hostB.setProtect(300);
	hostB.appendBlocks(Array.from({ length: 6 }, (_, i) => block({ id: `fresh${i}`, order: i, tokens: 1_000 })));
	await flush();

	// No restored stratum could validate → none grouped (a group over vanished ids would be unsafe).
	expect(hostB.truth.groups.length).toBe(0);
});
