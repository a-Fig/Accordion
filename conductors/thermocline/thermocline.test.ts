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
import type { Op, TxnResult } from "../../core/ops";
import { foldTag } from "../../core/digest";
import { ThermoclineConductor, reconcilePlan, planWithRealStratumTokens, dropOwnStrataOldestFirst } from "./thermocline";
import { planEpoch, emitOps, DEFAULT_CFG } from "./policy";
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

/** A ConductorView materialized from a live host — the RAW `fullTokens` baseline the policy folds
 *  down from (matches ThermoclineConductor.materialize). */
function viewOf(host: TestHost): ConductorView {
	const s = host.truth.stats();
	return {
		blocks: host.blocks().slice() as ViewBlock[],
		budget: s.budget,
		contextWindow: s.contextWindow,
		liveTokens: s.fullTokens,
		protectedFromIndex: s.protectedFromIndex,
		protectTokens: s.protectTokens,
	};
}

// ── APPLIED GROUPS MATCH THE PLAN — message-atom fixed point through the REAL Truth ────────────
//
// Sibling parts of one assistant message (`a:m1:p0/p1/p2` → messageKey `a:m1`) graduate independently.
// A run that starts mid-message must NOT let Truth's group snap (core/truth.ts → snappedRange) pull the
// excluded siblings in. These tests run the policy's ops through a REAL Truth and assert the applied
// group's id + member set equal the plan's, and the baked recall tag equals foldTag of the id Truth
// actually assigned. (Fixed-point ids self-map, so the bug only appears with these `:p` sibling ids.)
describe("applied group == plan (real Truth, message-atom fixed point)", () => {
	/** mA is split: mA:p0 is a HOT buoy, mA:p1 is cold+graduated. mB/mC/mD are whole cold messages. The
	 *  naive run would start at mA:p1 (mid-message mA) and snap out to swallow mA:p0. */
	function graduatedScenario(budget: number) {
		const host = new TestHost();
		host.setBudget(budget);
		host.setProtect(0); // nothing protected — every block is groupable
		host.appendBlocks([
			block({ id: "a:mA:p0", kind: "thinking", order: 0, tokens: 3_000, text: "hot reasoning" }),
			block({ id: "a:mA:p1", kind: "text", order: 1, tokens: 3_000, text: "assistant reply part" }),
			block({ id: "a:mB:p0", kind: "text", order: 2, tokens: 3_000, text: "second message" }),
			block({ id: "a:mC:p0", kind: "text", order: 3, tokens: 3_000, text: "third message" }),
			block({ id: "a:mD:p0", kind: "text", order: 4, tokens: 3_000, text: "fourth message" }),
		]);
		const view = viewOf(host);
		// Everything except the hot mA:p0 graduated.
		const scores = new Map<string, number>([
			["a:mA:p0", 0.95],
			["a:mA:p1", 0.02],
			["a:mB:p0", 0.02],
			["a:mC:p0", 0.02],
			["a:mD:p0", 0.02],
		]);
		const graduated = new Set(["a:mA:p1", "a:mB:p0", "a:mC:p0", "a:mD:p0"]);
		const plan = planEpoch(view, scores, { dwell: new Map() }, DEFAULT_CFG, { graduated });
		return { host, view, plan };
	}

	test("a graduated SUMMARY run whose naive boundary starts mid-message: applied group == plan; baked tag == foldTag(real id)", () => {
		const { host, view, plan } = graduatedScenario(100_000); // roomy → the stratum stays a summary
		const stratum = plan.strata.find((s) => s.digestKind === "summary")!;
		expect(stratum).toBeTruthy();
		// The plan already EXCLUDES the mid-message front part mA:p1 (and mA:p0).
		expect(stratum.ids[0]).toBe("a:mB:p0");
		expect(stratum.memberIds).not.toContain("a:mA:p0");
		expect(stratum.memberIds).not.toContain("a:mA:p1");

		const digests = new Map<string, string>([[`stratum:${stratum.ids[0]}`, "HOLISTIC RUN SUMMARY"]]);
		host.truth.apply(emitOps(plan, digests, view), "auto");

		const groups = host.truth.groups;
		expect(groups.length).toBe(1);
		const g = groups[0];
		// INVARIANT 1: the set Truth grouped is EXACTLY the plan's — no absorbed sibling.
		expect(new Set(g.memberIds)).toEqual(new Set(stratum.memberIds));
		expect(g.memberIds).not.toContain("a:mA:p0");
		expect(g.memberIds).not.toContain("a:mA:p1");
		expect(g.id).toBe(`g:${stratum.ids[0]}`);
		// INVARIANT 2: the baked recall tag equals foldTag of the group id Truth actually assigned.
		expect(typeof g.digest).toBe("string");
		expect((g.digest as string).startsWith(foldTag(g.id))).toBe(true);
		expect(g.digest).toBe(`${foldTag(`g:${stratum.ids[0]}`)} HOLISTIC RUN SUMMARY`);
	});

	test("a DROP run of the same shape never absorbs an out-of-plan sibling", () => {
		const { host, view, plan } = graduatedScenario(100_000);
		const stratum = plan.strata.find((s) => s.digestKind === "summary")!;
		// Render the same message-atom-snapped run as a DROP (summary:null). The boundary under test is
		// still the planner's; only the drop rendering is forced.
		const dropPlan: Plan = { ...plan, strata: plan.strata.map((s) => ({ ...s, digestKind: "drop", summaryTokens: 0 })) };
		host.truth.apply(emitOps(dropPlan, null, view), "auto");

		const groups = host.truth.groups;
		expect(groups.length).toBe(1);
		const g = groups[0];
		expect(host.truth.isDropGroup(g)).toBe(true);
		// INVARIANT 3: a drop must not silently swallow the excluded mid-message parts (no tag, no recall).
		expect(new Set(g.memberIds)).toEqual(new Set(stratum.memberIds));
		expect(g.memberIds).not.toContain("a:mA:p0");
		expect(g.memberIds).not.toContain("a:mA:p1");
	});
});

// ── belt-and-braces: a reported applied-id mismatch is repaired, never baked ──────────────────
// If the engine ever grouped to a DIFFERENT id than `g:<firstId>` (a boundary regression), the baked
// foldTag would be unresolvable and content may have been absorbed. The conductor detects this from
// propose()'s real `detail`, undoes the group, discards the bookkeeping, and logs — never keeping a
// stratum whose recall tag can't resolve. We force the mismatch by lying in the host's `detail`.
test("belt-and-braces: a mismatched applied group id is discarded + repaired, no bad tag kept", async () => {
	class DetailLyingHost extends TestHost {
		proposed: Op[][] = [];
		lie = true;
		async propose(txn: { baseRev: number; ops: Op[] }): Promise<TxnResult> {
			this.proposed.push(txn.ops);
			const res = await super.propose(txn);
			if (!this.lie) return res;
			return {
				...res,
				results: res.results.map((r) => (r.applied && r.op.kind === "group" ? { ...r, detail: "g:__BOGUS__" } : r)),
			};
		}
	}
	const host = new DetailLyingHost();
	const cond = new ThermoclineConductor({ scorer: emptyScorer, sessionKey: null });
	const warnings: string[] = [];
	const origWarn = console.warn;
	console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
	try {
		cond.attach(host);
		host.setBudget(30_000);
		host.setProtect(300);
		host.appendBlocks(pairs(8)); // over budget → emergency creates ≥1 age-stratum → group ops proposed
		await flush();
	} finally {
		console.warn = origWarn;
	}

	// The engine really applied the group(s) (with the CORRECT id) — but the host LIED about the detail,
	// so the belt-and-braces must have (a) warned, (b) proposed a repair ungroup for the bogus id, and
	// (c) discarded the stratum from its own bookkeeping (the last status metric reports 0 strata).
	expect(warnings.some((w) => w.includes("discarded") && w.includes("g:__BOGUS__"))).toBe(true);
	const repairedBogus = host.proposed.some((ops) => ops.some((o) => o.kind === "ungroup" && o.groupId === "g:__BOGUS__"));
	expect(repairedBogus).toBe(true);
	const lastStrata = [...host.statusLog].reverse().find((s) => s.metrics && "strata" in s.metrics)?.metrics?.strata;
	expect(lastStrata).toBe(0); // no mismatched stratum was ever recorded (no bad tag baked into applied state)
});

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

// ── finding 6: tick serialization + prompt wire-departing emergency ───────────────────────────
//
// Two closely-spaced events must never interleave two `runTick` bodies (they share appliedFolds/
// appliedStrata/appliedPlan/preparing). The tick chain serializes them. The wire-departing EMERGENCY
// is deliberately NOT on that chain — it must ride the departing wire even while a tick is suspended.

/** Records concurrency of `propose` calls: a real macrotask delay keeps a call "in flight" long
 *  enough that an interleaving tick's propose would overlap it, bumping `peak` past 1. */
class OverlapProbeHost extends TestHost {
	inFlight = 0;
	peak = 0;
	override async propose(txn: { baseRev: number; ops: Op[] }): Promise<TxnResult> {
		this.inFlight++;
		this.peak = Math.max(this.peak, this.inFlight);
		const res = await super.propose(txn); // sync apply to Truth
		await new Promise((r) => setTimeout(r, 10)); // real yield — an interleaving tick would overlap here
		this.inFlight--;
		return res;
	}
}

test("tick serialization: two rapid turn-committed events never interleave (proposes stay serial)", async () => {
	const host = new OverlapProbeHost();
	const cond = new ThermoclineConductor({ scorer: emptyScorer, sessionKey: null });
	cond.attach(host);
	host.setBudget(5_000);
	host.setProtect(300);

	// Two over-budget batches, each committed immediately after append — a burst of events (2 append +
	// 2 commit) that all enqueue ticks. Without the chain the append-tick and commit-tick overlap.
	host.appendBlocks(Array.from({ length: 8 }, (_, i) => block({ id: `a${i}`, order: i, tokens: 1_000 })));
	const p1 = host.commitTurn();
	host.appendBlocks(Array.from({ length: 8 }, (_, i) => block({ id: `z${i}`, order: 8 + i, tokens: 1_000 })));
	const p2 = host.commitTurn();
	await Promise.all([p1, p2]);

	expect(host.peak).toBe(1); // every propose completed before the next tick's began — no interleave
	expect(host.truth.blocks.some((b) => host.truth.isFolded(b))).toBe(true); // work actually happened
	expect(host.truth.stats().liveTokens).toBeLessThanOrEqual(5_000);
});

/** Gates every `propose` on an external release, recording how many were ENTERED. `propose` hangs
 *  BEFORE applying, so Truth stays un-mutated while a tick's propose is suspended — exactly the state
 *  in which a wire-departing emergency must still run promptly. */
class GatedProposeHost extends TestHost {
	proposeEnters = 0;
	private release!: () => void;
	private gate: Promise<void> = new Promise<void>((r) => (this.release = r));
	openGate(): void {
		this.release();
	}
	override async propose(txn: { baseRev: number; ops: Op[] }): Promise<TxnResult> {
		this.proposeEnters++;
		await this.gate; // hang BEFORE applying → Truth un-mutated while a tick is suspended here
		return super.propose(txn);
	}
}

test("wire-departing runs its emergency promptly even while a tick is suspended at propose", async () => {
	const host = new GatedProposeHost();
	const cond = new ThermoclineConductor({ scorer: emptyScorer, sessionKey: null });
	cond.attach(host);
	host.setBudget(5_000);
	host.setProtect(300);

	// An over-budget append kicks a tick whose emergency reaches `propose` and hangs on the gate.
	host.appendBlocks(Array.from({ length: 10 }, (_, i) => block({ id: `b${i}`, order: i, tokens: 1_000 })));
	await flush();
	expect(host.proposeEnters).toBe(1); // the tick is suspended at its gated propose

	// The wire departs while that tick is still pending. onWireDeparting is NOT queued behind the tick
	// chain — its emergency runs immediately and INITIATES its own propose (enter #2), proving prompt.
	const departP = host.departWire();
	await flush();
	expect(host.proposeEnters).toBe(2); // the emergency's propose fired without waiting for the tick

	// Release both — they apply against the same Truth; the engine clamps the duplicate. No crash.
	host.openGate();
	await departP;
	await flush();
	expect(host.truth.blocks.some((b) => host.truth.isFolded(b))).toBe(true);
	expect(host.truth.stats().liveTokens).toBeLessThanOrEqual(5_000);
});

// ── IRREDUCIBLE OVERFLOW (P1-4) ────────────────────────────────────────────────────────────────
//
// budget (12k) < protected tail (~21k, default protectTokens=20k walking back over 3k-token
// blocks) is fully reachable via the GUI's 12k budget floor + the default protect target — see the
// finding. Every mover on the Rung-5 hard-cap floor excludes protected units by construction, so
// the ladder can NEVER bring the live context under a cap smaller than the protected tail alone.
// Thermocline must surface this explicitly (status text + machine metric), never just show a
// silently-stuck fill% > 100, and must NOT keep re-firing PREPARE (host.complete/LLM calls) once
// it knows the current configuration is un-winnable.
describe("IRREDUCIBLE OVERFLOW (P1-4)", () => {
	/** budget 12k, protectTokens 20k, 10×3k-token blocks (30k total) → protected tail walks back to
	 *  ~21k (7 blocks), comfortably over the 12k cap — irreducible by construction. */
	function irreducibleSetup() {
		const host = new TestHost();
		const cond = new ThermoclineConductor({ scorer: emptyScorer, sessionKey: null });
		cond.attach(host);
		host.setBudget(12_000);
		host.setProtect(20_000);
		host.appendBlocks(Array.from({ length: 10 }, (_, i) => block({ id: `b${i}`, order: i, tokens: 3_000 })));
		return { host, cond };
	}

	function lastMetrics(host: TestHost) {
		return [...host.statusLog].reverse().find((s) => s.metrics)?.metrics;
	}

	test("(a) budget < protected tail: status names the numbers, metric set, and PREPARE never fires (flat over several ticks)", async () => {
		const { host } = irreducibleSetup();
		await flush();

		// Never satisfiable by ANY combination of folds/groups/drops — the protected tail alone (~21k)
		// exceeds the 12k cap, so the ladder gave up with projected still over cap.
		expect(host.truth.stats().liveTokens).toBeGreaterThan(12_000);

		const m = lastMetrics(host);
		expect(m?.irreducibleOverflow).toBe(true);
		expect(typeof m?.overflowTokens).toBe("number");
		expect(m!.overflowTokens as number).toBeGreaterThan(0);
		const statusText = [...host.statusLog].reverse().find((s) => s.metrics)?.text ?? "";
		expect(statusText).toMatch(/irreducible/i);
		expect(statusText).toMatch(/protected tail/i);
		expect(statusText).toMatch(/cap/i);

		// NEVER silent: it happened without any LLM activity (deterministic emergency only).
		const completesAtStuck = host.completeLog.length;
		expect(completesAtStuck).toBe(0);

		// CALM / IDEMPOTENT: several more ticks under the SAME un-winnable config must not fire any
		// MORE host.complete calls — no hot-looping PREPARE on a plan that can never commit.
		for (let i = 0; i < 5; i++) {
			host.appendBlocks([block({ id: `noise${i}`, order: 20 + i, tokens: 10 })]); // tiny, changes nothing
			await flush();
		}
		expect(host.completeLog.length).toBe(completesAtStuck); // flat — still 0
		expect(lastMetrics(host)?.irreducibleOverflow).toBe(true); // still surfaced, not dropped
	});

	test("(b) raising the budget clears the state on the next tick; normal planning resumes", async () => {
		const { host } = irreducibleSetup();
		await flush();
		expect(lastMetrics(host)?.irreducibleOverflow).toBe(true);

		host.setBudget(200_000); // now comfortably winnable — the ladder isn't even needed
		await host.commitTurn(); // the next tick re-checks fresh (config changes alone don't retick)
		await flush();

		const m = lastMetrics(host);
		expect(m?.irreducibleOverflow).toBe(false);
		expect(host.truth.stats().liveTokens).toBeLessThanOrEqual(200_000);
		// Still no LLM calls were ever needed for this scenario.
		expect(host.completeLog.length).toBe(0);
	});

	test("(b-alt) shrinking the protected tail to 0 also clears the state", async () => {
		const { host } = irreducibleSetup();
		await flush();
		expect(lastMetrics(host)?.irreducibleOverflow).toBe(true);

		host.setProtect(0); // nothing protected anymore — everything foldable/groupable/droppable
		await host.commitTurn();
		await flush();

		expect(lastMetrics(host)?.irreducibleOverflow).toBe(false);
		expect(host.truth.stats().liveTokens).toBeLessThanOrEqual(12_000);
	});

	test("(c) wire-departing emergency under the same irreducible config: no crash, resolves promptly, overflow still surfaced", async () => {
		const { host } = irreducibleSetup();
		await flush();
		expect(lastMetrics(host)?.irreducibleOverflow).toBe(true);

		// Fresh unsent content lands, then the wire departs — onWireDeparting's emergency path
		// (NOT queued behind the tick chain) must run cleanly under the SAME un-winnable config.
		host.appendBlocks([block({ id: "fresh0", order: 30, tokens: 500 })]);
		await flush();

		const start = Date.now();
		await expect(host.departWire()).resolves.toBeUndefined(); // no throw
		expect(Date.now() - start).toBeLessThan(1_000); // resolves promptly — no stall introduced

		expect(lastMetrics(host)?.irreducibleOverflow).toBe(true); // still surfaced, never silently dropped
		expect(host.truth.blocks.some((b) => host.truth.isFolded(b))).toBe(true); // still compressed what it could
		expect(host.completeLog.length).toBe(0); // the emergency path is deterministic — no LLM here either
	});
});

// ── protect-heal reconciliation (P2 fix) ──────────────────────────────────────────────────────
//
// BUG (pre-fix): `appliedFolds`/`appliedStrata` are the conductor's OWN private ledger of "what we
// committed", diffed against on every HOLD and fed straight into `project()`. A human raising
// `setProtect` mid-session can HEAL an already-applied fold or PRUNE an already-applied stratum's
// group UNDERNEATH the conductor — Truth's `healProtected`/`pruneProtectedGroups` run synchronously
// inside `setProtect`, but the `state-changed{what:"protect"}` event carries NO block ids, and
// `onStateChanged` used to react only to `by:"agent"` touches. Because thermocline locks
// `human-steering` (a human can't directly fold/unfold/pin while it's held), `setProtect` was the
// ONE remaining channel through which this could happen — exactly what this test drives. Without
// the fix, the healed saving stays credited forever, fill under-reports, and the "hard budget
// invariant" is defeated with NO overflow status ever surfacing.
test("protect-heal reconciliation: raising setProtect over an applied stratum drops the stale credit and re-evaluates", async () => {
	const host = new TestHost();
	const cond = new ThermoclineConductor({ scorer: emptyScorer, sessionKey: null });
	cond.attach(host);
	host.setBudget(30_000);
	host.setProtect(300); // small tail — everything else groupable
	host.appendBlocks(pairs(8)); // non-foldable pairs → only age-based strata (groups) can compress
	await flush();

	// The epoch committed at least one stratum (a `group` op) to fit under the 30k cap.
	expect(host.truth.groups.length).toBeGreaterThanOrEqual(1);
	expect(host.truth.stats().liveTokens).toBeLessThanOrEqual(30_000);

	// The human raises the protected tail to cover EVERYTHING. Truth's housekeep — inside
	// `setProtect`, synchronously, BEFORE the state-changed event fires — prunes every stratum group
	// and heals every fold: the saving is GONE, and (because every block is now protected) the
	// ladder can never re-fold/re-group any of it either — genuinely irreducible.
	host.setProtect(1_000_000);
	await flush();

	expect(host.truth.groups.length).toBe(0); // pruneProtectedGroups really did remove it
	expect(host.truth.stats().liveTokens).toBeGreaterThan(30_000); // healed content is back to full, over cap

	// THE FIX: thermocline's OWN reported state must reflect this reality — not the stale pre-heal
	// credit — and must have RE-EVALUATED promptly (not waited for the next natural turn/append).
	// Pre-fix this assertion fails: appliedStrata still names the pruned group, project() keeps
	// subtracting its (now-fictional) saving, and no tick even reruns off the bare `setProtect` call
	// — the last status stays the stale pre-heal one (irreducibleOverflow still false, overflowTokens
	// still 0). `overflowTokens` (not `fullness`) is the assertion here: it's re-derived fresh from
	// the post-heal projection every time `setOverflowState` runs, so it can't read stale.
	const lastMetrics = [...host.statusLog].reverse().find((s) => s.metrics)?.metrics;
	expect(lastMetrics?.irreducibleOverflow).toBe(true);
	expect(lastMetrics?.overflowTokens as number).toBeGreaterThan(40_000); // the FULL raw gap, not a stale partial credit
	const statusText = [...host.statusLog].reverse().find((s) => s.metrics)?.text ?? "";
	expect(statusText).toMatch(/irreducible/i);
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
