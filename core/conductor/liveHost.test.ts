/*
 * liveHost.test.ts — `LiveConductorHost` (the in-extension live conductor host, Phase C) driven
 * against a REAL `Truth` with mocked sockets / spawn / completion. Covers: select→detach ordering
 * (freeze BEFORE clearLocks), eager `setLocks`, single-use attach token, non-active-socket
 * rejection, the wire-departing hold (in-process sync/async + remote holdRelease/timeout with the
 * holdId generation guard), the P1-6 initial pass on select (in-process + remote), the P1-5 detach
 * tail-inheritance (freeze survives, protectTokens adopts the enforced tail) and its replica replay,
 * the spawn pending-attach timeout, shutdown teardown, completion abort on detach, S7 cancelComplete
 * forwarding, and the human-override clamp of a conductor propose. Plus the registry catalog.
 */
import { describe, it, expect, vi } from "vitest";
import { Truth } from "../truth";
import type { Block, ParsedSession } from "../types";
import type { ServerMessage, WireEvent } from "../protocol";
import { serializeSnapshot, hydrateSnapshot, applyWireEvent, wireEventFromTruthEvent } from "../replica";
import { LiveConductorHost, type LiveHostDeps, type SpawnedRunner } from "./liveHost";
import { catalogMeta, entryById } from "./registry";
import type { ConductorHost } from "./contract";
import { DoormanConductor } from "../conductors/doorman/doorman";
import { NaiveCompactionConductor } from "../conductors/compaction-naive/compaction-naive";

const META = { format: "pi" as const, title: "t", cwd: "", model: "" };

function blk(id: string, kind: Block["kind"], order: number, turn: number, tokens = 1000, extra: Partial<Block> = {}): Block {
	return { id, kind, turn, order, text: `${id} ` + "x".repeat(tokens * 4), tokens, override: null, autoFolded: false, by: null, ...extra };
}
function textSeq(n: number): Block[] {
	return Array.from({ length: n }, (_, i) => blk(`a:b${i}:p0`, "text", i, i + 1, 1000));
}
function bulk(blocks: Block[]): Truth {
	const parsed: ParsedSession = { meta: META, blocks, lineCount: 0, skipped: 0 };
	return new Truth(parsed);
}
function liveTruth(): Truth {
	return new Truth({ meta: META, blocks: [], lineCount: 0, skipped: 0 });
}
/** A live Truth with a GIANT fresh prior-turn tool_result (doorman's plain birth-fold candidate). */
function giantTruth(): Truth {
	const t = liveTruth();
	t.append([
		blk("u:1", "user", 0, 1, 10),
		blk("a:c1:p0", "tool_call", 1, 1, 10, { toolName: "shell", callId: "c1" }),
		blk("r:c1", "tool_result", 2, 1, 3000, { toolName: "shell", callId: "c1" }),
		blk("u:2", "user", 3, 2, 10),
		blk("a:d1:p0", "text", 4, 2, 10),
	]);
	return t;
}

interface MockChild extends SpawnedRunner {
	killCount: number;
	fireExit(info?: { code?: number | null; stderr?: string }): void;
}
function mockChild(): MockChild {
	const cbs: Array<(info?: { code?: number | null; stderr?: string }) => void> = [];
	const child: MockChild = {
		killCount: 0,
		kill() {
			child.killCount++;
		},
		onExit(cb) {
			cbs.push(cb);
		},
		fireExit(info) {
			for (const cb of cbs.slice()) cb(info);
		},
	};
	return child;
}

interface Harness {
	deps: LiveHostDeps;
	broadcastLog: ServerMessage[];
	conductorLog: ServerMessage[];
	socketLog: Array<{ socket: unknown; msg: ServerMessage }>;
	spawned: MockChild[];
	runCompletion: ReturnType<typeof vi.fn>;
}
function makeDeps(truth: Truth | null, overrides: Partial<LiveHostDeps> = {}): Harness {
	const broadcastLog: ServerMessage[] = [];
	const conductorLog: ServerMessage[] = [];
	const socketLog: Array<{ socket: unknown; msg: ServerMessage }> = [];
	const spawned: MockChild[] = [];
	let n = 0;
	const runCompletion = vi.fn(async (_req: unknown, _signal: AbortSignal) => ({ text: "SUMMARY", model: "m" }));
	const deps: LiveHostDeps = {
		truth: () => truth,
		broadcast: (m) => broadcastLog.push(m),
		sendToConductor: (m) => conductorLog.push(m),
		sendToSocket: (socket, m) => socketLog.push({ socket, msg: m }),
		mintToken: () => `tok-${++n}`,
		spawnRunner: () => {
			const c = mockChild();
			spawned.push(c);
			return c;
		},
		runCompletion: runCompletion as unknown as LiveHostDeps["runCompletion"],
		spawnEnv: () => ({ port: 4321, sessionKey: "sess-1", home: "/tmp/home" }),
		now: () => Date.now(),
		...overrides,
	};
	return { deps, broadcastLog, conductorLog, socketLog, spawned, runCompletion };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
/** Poll `pred` until true (real timers), for async chains that settle over several microtask hops. */
async function until(pred: () => boolean, ms = 2000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > ms) throw new Error("until: timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

// ── registry ──────────────────────────────────────────────────────────────────
describe("registry", () => {
	it("catalogMeta excludes a spawn conductor whose runner doesn't resolve, includes it when it does", () => {
		const without = catalogMeta();
		expect(without.some((e) => e.id === "thermocline")).toBe(false);
		expect(without.some((e) => e.id === "doorman")).toBe(true);
		const withRunner = catalogMeta(() => true);
		expect(withRunner.find((e) => e.id === "thermocline")?.remote).toBe(true);
		expect(withRunner.find((e) => e.id === "doorman")?.remote).toBe(false);
	});
	it("sources lock/tail/hold metadata from the conductor definitions", () => {
		expect(entryById("compaction-naive")?.locks).toEqual(["human-steering", "agent-unfold"]);
		expect(entryById("handoff")?.locks).toContain("tail-size");
		expect(entryById("handoff")?.tailTokens).toBe(0);
		expect(entryById("doorman")?.holdWireUpToMs).toBe(150);
		expect(entryById(null)?.id).toBe("none");
		expect(entryById("nope")).toBeUndefined();
	});
});

// ── attach / detach ─────────────────────────────────────────────────────────────
describe("select — eager locks + attach broadcast", () => {
	it("acquires the conductor's locks eagerly and broadcasts conductorState on attach", () => {
		const t = bulk(textSeq(3));
		const h = makeDeps(t);
		const host = new LiveConductorHost(h.deps);
		host.select("compaction-naive");
		expect(t.locks).toEqual(["human-steering", "agent-unfold"]);
		expect(t.lockHolder).toBe("Naive compaction");
		const cs = h.broadcastLog.filter((m) => m.type === "conductorState").pop();
		expect(cs && cs.type === "conductorState" && cs.active?.id).toBe("compaction-naive");
	});
});

// ── fix 2: transactional attach — a failed create()/attach() must never strand a lock ──────────
describe("select — a throwing create() never acquires a lock (fix 2a)", () => {
	it("leaves Truth completely unlocked and nothing advertised active when the factory throws", () => {
		const t = bulk(textSeq(2));
		const h = makeDeps(t);
		const host = new LiveConductorHost(h.deps);
		const entry = entryById("compaction-naive")!;
		const createSpy = vi.spyOn(entry, "create").mockImplementation(() => {
			throw new Error("boom");
		});
		try {
			host.select("compaction-naive");
			// Pre-fix, `setLocks` ran BEFORE `create()`, so a throwing factory left the lock acquired
			// with no conductor behind it. Post-fix, nothing is locked and nothing is active.
			expect(t.locks).toEqual([]);
			expect(host.activeMeta()).toBeNull();
			const status = h.broadcastLog.filter((m) => m.type === "conductorStatus").pop();
			expect(status && status.type === "conductorStatus" && status.text).toMatch(/failed to start/);
		} finally {
			createSpy.mockRestore();
		}
	});
});

describe("select — a throwing attach() cleans up instead of stranding a lock (fix 2b)", () => {
	it("detaches the half-attached conductor and leaves Truth unlocked when attach() throws", () => {
		const t = bulk(textSeq(2));
		const h = makeDeps(t);
		const host = new LiveConductorHost(h.deps);
		// compaction-naive (NOT doorman) — it declares NON-EMPTY locks (["human-steering",
		// "agent-unfold"]), so a stuck lock is actually observable; doorman is collaborative
		// (no locks), so `setLocks([])` would trivially look "unlocked" either way.
		const attachSpy = vi.spyOn(NaiveCompactionConductor.prototype, "attach").mockImplementation(() => {
			throw new Error("attach boom");
		});
		try {
			host.select("compaction-naive");
			// Pre-fix, `setLocks` (and `active`/`mode`) were already committed before `attach()` ran, so a
			// throwing attach left a dead conductor advertised active with its lock stuck. Post-fix, the
			// whole attach attempt is rolled back: no lock, nothing active.
			expect(t.locks).toEqual([]);
			expect(host.activeMeta()).toBeNull();
			const status = h.broadcastLog.filter((m) => m.type === "conductorStatus").pop();
			expect(status && status.type === "conductorStatus" && status.text).toMatch(/failed to attach/);
		} finally {
			attachSpy.mockRestore();
		}
	});
});

describe("select — a spawn conductor's locks are deferred to accept, not select (fix 2c)", () => {
	it("does not touch Truth's locks at select time, only once the runner's socket is accepted", () => {
		const t = bulk(textSeq(6));
		t.setProtect(20_000); // the human's dial covers the whole 6k-token session
		const h = makeDeps(t);
		const host = new LiveConductorHost(h.deps);
		const setLocksSpy = vi.spyOn(t, "setLocks");

		host.select("thermocline"); // spawn conductor — runner spawned but not yet dialed in
		// Pre-fix, `setLocks` ran synchronously right here (housekeep could already prune/heal folds to
		// fit a shrunk tail for a conductor that might never actually attach). Post-fix, nothing happens
		// to Truth until the runner's socket is accepted.
		expect(setLocksSpy).not.toHaveBeenCalled();
		expect(t.locks).toEqual([]);

		host.acceptConductorSocket({}, host.pendingAttachToken);
		// NOW — and only now — the declared locks engage.
		expect(setLocksSpy).toHaveBeenCalledTimes(1);
		expect(t.locks).toEqual(["human-steering"]);
	});

	it("a runner that never dials in and times out never mutated Truth's locks at all", async () => {
		vi.useFakeTimers();
		try {
			const t = bulk(textSeq(6));
			const h = makeDeps(t);
			const host = new LiveConductorHost(h.deps);
			const setLocksSpy = vi.spyOn(t, "setLocks");
			host.select("thermocline");
			await vi.advanceTimersByTimeAsync(10_000); // pending-attach timeout — auto-detach, no accept ever happened
			expect(host.activeMeta()).toBeNull();
			// The conductor never actually attached, so `setLocks` must never have been called for it —
			// there was nothing to (irreversibly) heal/prune back out.
			expect(setLocksSpy).not.toHaveBeenCalled();
			expect(t.locks).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("detach — freeze BEFORE clearLocks", () => {
	it("a strategy fold's subst survives detach as a human fold, and freeze runs before clearLocks", () => {
		const t = bulk(textSeq(3));
		t.setProtect(0); // no protected tail — healProtected can't heal the fold on detach
		const h = makeDeps(t);
		const host = new LiveConductorHost(h.deps);
		host.select("compaction-naive");
		// A strategy-owned subst fold, exactly what an attached conductor would apply.
		t.apply([{ kind: "replace", id: "a:b0:p0", content: "XSUB", recoverable: false }], "auto");
		expect(t.get("a:b0:p0")!.subst).toBe("XSUB");

		const applySpy = vi.spyOn(t, "apply");
		const clearSpy = vi.spyOn(t, "clearLocks");
		host.select("none"); // detach

		const b = t.get("a:b0:p0")!;
		expect(b.override).toBe("folded");
		expect(b.by).toBe("you");
		expect(b.subst).toBe("XSUB"); // subst preserved byte-identical through the ownership transfer
		expect(t.locks).toEqual([]);
		expect(host.activeMeta()).toBeNull();

		const freezeIdx = applySpy.mock.calls.findIndex((c) => Array.isArray(c[0]) && (c[0] as Array<{ kind?: string }>)[0]?.kind === "freeze");
		expect(freezeIdx).toBeGreaterThanOrEqual(0);
		expect(applySpy.mock.invocationCallOrder[freezeIdx]).toBeLessThan(clearSpy.mock.invocationCallOrder[0]);
	});
});

// ── P1-6: initial pass on select ────────────────────────────────────────────────
describe("initial pass on select (P1-6)", () => {
	it("an in-process conductor gets an immediate turn-committed and compacts without waiting for a turn", async () => {
		const t = bulk(textSeq(10)); // 10 × 1000 = 10k raw
		t.setProtect(0); // whole session aged
		t.setBudget(3000); // 10k ≫ 0.9 × 3000, so compaction-naive triggers on the very first pass
		const h = makeDeps(t);
		const host = new LiveConductorHost(h.deps);
		host.select("compaction-naive");
		// No turn_end has fired. ONLY the P1-6 initial turn-committed drives the first pass →
		// launchCompletion → (mock) resolves → rerun → a summary group lands in Truth. Without the
		// initial pass the conductor would idle with zero groups.
		await until(() => t.groups.length > 0);
		expect(t.groups.length).toBeGreaterThan(0);
		expect(t.groups.every((g) => g.by === "auto")).toBe(true);
		expect(h.runCompletion).toHaveBeenCalled();
	});

	it("a freshly attached remote conductor is sent an initial turnCommitted", () => {
		const t = liveTruth();
		t.append(textSeq(3));
		const h = makeDeps(t);
		const host = new LiveConductorHost(h.deps);
		host.select("thermocline");
		host.acceptConductorSocket({}, host.pendingAttachToken);
		h.conductorLog.length = 0;
		// The extension calls this AFTER dispatching the conductor's first snapshot (once the SDK has
		// hydrated + attached), so the message actually drives a pass instead of idling until a turn.
		host.fireInitialTurnCommitted();
		const tc = h.conductorLog.filter((m) => m.type === "turnCommitted").pop();
		expect(tc && tc.type === "turnCommitted").toBe(true);
		expect(tc && tc.type === "turnCommitted" && tc.rev).toBe(t.rev);
	});
});

// ── P1-5: detach inherits the conductor-enforced tail ────────────────────────────
describe("detach — inherit the conductor's tail (P1-5)", () => {
	it("adopts the tail-size conductor's enforced tail as protectTokens so the frozen fold isn't healed back", () => {
		const t = bulk(textSeq(6)); // 6 × 1000; the default 20k tail would cover the whole session
		const host = new LiveConductorHost(makeDeps(t).deps);
		host.select("handoff"); // locks human-steering + agent-unfold + tail-size, tailTokens 0
		expect(t.locks).toContain("tail-size");
		expect(t.protectTokens).toBe(20_000); // the human's dial is untouched while the lock is held

		// A strategy fold near the tail — under tailTokens 0 nothing is protected, so it lands.
		t.apply([{ kind: "replace", id: "a:b5:p0", content: "SUB", recoverable: false }], "auto");
		expect(t.get("a:b5:p0")!.subst).toBe("SUB");

		host.select("none"); // detach → freeze → clearLocks({ inheritTail: true })

		// The enforced tail (0) is now the human's protectTokens — it did NOT snap back to 20k.
		expect(t.protectTokens).toBe(0);
		expect(t.locks).toEqual([]);
		// The frozen fold survives as a human fold, subst byte-identical — NOT healed by a snapped-back tail.
		const b = t.get("a:b5:p0")!;
		expect(b.override).toBe("folded");
		expect(b.by).toBe("you");
		expect(b.subst).toBe("SUB");
		expect(t.isFolded(b)).toBe(true);
	});

	it("a replica replaying the detach sequence (freeze → inherit-tail config → locks) surfaces the config divergence as a rev mismatch, never a silent fork", () => {
		// The exact Truth state at detach: a tail-size lock (tailTokens 0) with a strategy fold.
		const t = bulk(textSeq(6));
		t.setLocks(["human-steering", "tail-size"], "Handoff", 0);
		t.apply([{ kind: "replace", id: "a:b5:p0", content: "SUB", recoverable: false }], "auto");

		// A rev-aligned replica hydrated from the pre-detach snapshot.
		const replica = hydrateSnapshot(META, serializeSnapshot(t, false));
		expect(replica.rev).toBe(t.rev);

		// Capture the WireEvents the real detach sequence emits.
		const events: WireEvent[] = [];
		const off = t.onEvent((e) => {
			const ev = wireEventFromTruthEvent(e);
			if (ev) events.push(ev);
		});
		t.apply([{ kind: "freeze" }], "you");
		t.clearLocks({ inheritTail: true });
		off();

		// Exactly: ops(freeze) → config(protectTokens) → locks — each rev-stamped.
		expect(events.map((e) => e.kind)).toEqual(["ops", "config", "locks"]);

		// Replay onto the replica. The freeze ops event replays cleanly (rev aligns). The config event
		// carries the inherited protectTokens, but the replica's tail-size lock is STILL held then (the
		// locks event hasn't replayed yet), so its `setProtect` is refused — a genuine, DETECTABLE
		// divergence (rev mismatch) that in the live client triggers a resnapshot. Prefer clean replay,
		// but this rev-mismatch fallback is acceptable precisely because it is NOT a silent state fork.
		let divergedAt: WireEvent["kind"] | null = null;
		for (const ev of events) {
			applyWireEvent(replica, ev);
			if (replica.rev !== ev.rev && divergedAt === null) divergedAt = ev.kind;
		}
		expect(divergedAt).toBe("config"); // the divergence is caught at the config event, not silent

		// A fresh post-detach snapshot recovers the replica exactly: inherited tail + the frozen fold.
		const recovered = hydrateSnapshot(META, serializeSnapshot(t, false));
		expect(recovered.rev).toBe(t.rev);
		expect(recovered.protectTokens).toBe(0);
		const rb = recovered.get("a:b5:p0")!;
		expect(rb.override).toBe("folded");
		expect(rb.subst).toBe("SUB");
	});
});

// ── spawn token ──────────────────────────────────────────────────────────────────
describe("spawn attach token — single use", () => {
	it("accepts the pending token once, then rejects a reuse", () => {
		const t = bulk(textSeq(2));
		const host = new LiveConductorHost(makeDeps(t).deps);
		host.select("thermocline");
		const token = host.pendingAttachToken;
		expect(token).toBeTruthy();
		expect(host.acceptConductorSocket({}, token)).toBe(true);
		expect(host.pendingAttachToken).toBeNull();
		expect(host.acceptConductorSocket({}, token)).toBe(false);
	});
});

describe("conductor messages — only the active socket is honored", () => {
	it("ignores propose / completeRequest / setConductorStatus from a non-active socket", () => {
		const t = bulk(textSeq(2));
		const h = makeDeps(t);
		const host = new LiveConductorHost(h.deps);
		host.select("thermocline");
		const sockA = { id: "A" };
		const sockB = { id: "B" };
		host.acceptConductorSocket(sockA, host.pendingAttachToken);
		h.conductorLog.length = 0;
		host.handleConductorMessage(sockB, { type: "propose", seq: 1, baseRev: t.rev, ops: [] });
		host.handleConductorMessage(sockB, { type: "completeRequest", reqId: 1, prompt: "x" });
		host.handleConductorMessage(sockB, { type: "setConductorStatus", text: "hi" });
		expect(h.conductorLog.length).toBe(0);
		expect(h.broadcastLog.some((m) => m.type === "conductorStatus")).toBe(false);
		// The active socket IS honored.
		host.handleConductorMessage(sockA, { type: "propose", seq: 2, baseRev: t.rev, ops: [] });
		expect(h.conductorLog.some((m) => m.type === "proposeResult" && m.seq === 2)).toBe(true);
	});
});

// ── wire-departing hold ──────────────────────────────────────────────────────────
describe("hold — in-process", () => {
	it("doorman folds the giant on the departing wire; the hold settles on a microtask, no timeout", async () => {
		const t = giantTruth();
		const host = new LiveConductorHost(makeDeps(t).deps);
		host.select("doorman");
		await host.fireWireDepartingAndAwaitHold();
		expect(t.isFolded(t.get("r:c1")!)).toBe(true); // birth-folded on the departing wire
		expect(host.holdTimeouts).toBe(0);
	});

	it("an async handler resolves the hold when it settles before the timeout", async () => {
		const t = liveTruth();
		t.append(textSeq(2));
		const host = new LiveConductorHost(makeDeps(t).deps);
		host.select("doorman");
		let settle: () => void = () => {};
		host.on((e) => (e.type === "wire-departing" ? new Promise<void>((r) => (settle = r)) : undefined));
		const p = host.fireWireDepartingAndAwaitHold();
		settle();
		await p;
		expect(host.holdTimeouts).toBe(0);
	});

	it("an async handler that never settles hits the timeout and counts it", async () => {
		vi.useFakeTimers();
		try {
			const t = liveTruth();
			t.append(textSeq(2));
			const host = new LiveConductorHost(makeDeps(t).deps);
			host.select("doorman"); // holdWireUpToMs = 150
			host.on((e) => (e.type === "wire-departing" ? new Promise<void>(() => {}) : undefined));
			const p = host.fireWireDepartingAndAwaitHold();
			await vi.advanceTimersByTimeAsync(150);
			await p;
			expect(host.holdTimeouts).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("hold — remote (v14 holdRelease)", () => {
	/** The holdId the host stamped on its most recent `wireDeparting` message. */
	function lastHoldId(log: ServerMessage[]): number {
		const wd = log.filter((m) => m.type === "wireDeparting").pop();
		return wd && wd.type === "wireDeparting" ? wd.holdId : -1;
	}

	it("resolves on the matching holdRelease — a propose no longer releases the hold (P1-2)", async () => {
		const t = liveTruth();
		t.append(textSeq(2));
		const h = makeDeps(t);
		const host = new LiveConductorHost(h.deps);
		host.select("thermocline");
		const sock = {};
		host.acceptConductorSocket(sock, host.pendingAttachToken);
		let resolved = false;
		const p = host.fireWireDepartingAndAwaitHold().then(() => {
			resolved = true;
		});
		const holdId = lastHoldId(h.conductorLog);
		expect(holdId).toBeGreaterThan(0);
		// A propose during the hold must NOT release it (the P1-2 regression: a background-tick propose
		// racing the hold would otherwise release it before the handler's last-moment fold lands).
		host.handleConductorMessage(sock, { type: "propose", seq: 1, baseRev: t.rev, ops: [] });
		await flush();
		expect(resolved).toBe(false);
		// The dedicated holdRelease carrying the CURRENT holdId is what actually releases it.
		host.handleConductorMessage(sock, { type: "holdRelease", holdId });
		await p;
		expect(resolved).toBe(true);
		expect(host.holdTimeouts).toBe(0);
	});

	it("times out, counts it, and a stale holdRelease never resolves a later hold (holdId generation guard)", async () => {
		vi.useFakeTimers();
		try {
			const t = liveTruth();
			t.append(textSeq(2));
			const h = makeDeps(t);
			const host = new LiveConductorHost(h.deps);
			host.select("thermocline"); // holdWireUpToMs = 200
			const sock = {};
			host.acceptConductorSocket(sock, host.pendingAttachToken);
			const p1 = host.fireWireDepartingAndAwaitHold();
			const holdId1 = lastHoldId(h.conductorLog);
			await vi.advanceTimersByTimeAsync(200);
			await p1;
			expect(host.holdTimeouts).toBe(1);
			// A holdRelease for the already-timed-out hold is a no-op (no pending hold to match).
			host.handleConductorMessage(sock, { type: "holdRelease", holdId: holdId1 });
			expect(host.holdTimeouts).toBe(1);
			// A fresh hold gets a DISTINCT holdId; the stale one must not resolve it — it times out itself.
			h.conductorLog.length = 0;
			const p2 = host.fireWireDepartingAndAwaitHold();
			const holdId2 = lastHoldId(h.conductorLog);
			expect(holdId2).not.toBe(holdId1);
			host.handleConductorMessage(sock, { type: "holdRelease", holdId: holdId1 }); // stale — ignored
			await vi.advanceTimersByTimeAsync(200);
			await p2;
			expect(host.holdTimeouts).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ── fix 4: detach mid-hold must unblock the IN-PROCESS hold immediately, not wait out holdWireUpToMs ──
describe("hold — detach mid-hold releases the in-process hold immediately (fix 4)", () => {
	it("select(\"none\") mid-hold resolves the pending wire-departing hold without waiting out holdWireUpToMs", async () => {
		vi.useFakeTimers();
		try {
			const t = liveTruth();
			t.append(textSeq(2));
			const host = new LiveConductorHost(makeDeps(t).deps);
			host.select("doorman"); // holdWireUpToMs = 150
			host.on((e) => (e.type === "wire-departing" ? new Promise<void>(() => {}) : undefined)); // never settles
			const p = host.fireWireDepartingAndAwaitHold();
			host.select("none"); // detach mid-hold, with 150ms still on the clock
			// Pre-fix: the in-process hold only raced the handler settling vs. the 150ms timer — neither
			// of which we ever advance here — so `p` would hang forever and this test would time out.
			// Post-fix: `detachActive` fires `inProcessHoldRelease`, so `p` resolves right away.
			await p;
			expect(host.holdTimeouts).toBe(0); // resolved via detach, not the timeout path
			expect(host.lastHoldMs).toBe(0); // the detach reset stands — this resumed call must not clobber it
		} finally {
			vi.useRealTimers();
		}
	}, 1000);
});

// ── spawn lifecycle ──────────────────────────────────────────────────────────────
describe("spawn — pending-attach timeout auto-detaches", () => {
	it("auto-detaches, kills the child, and surfaces a status when the runner never dials in", async () => {
		vi.useFakeTimers();
		try {
			const t = bulk(textSeq(2));
			const h = makeDeps(t);
			const host = new LiveConductorHost(h.deps);
			host.select("thermocline");
			expect(host.activeMeta()?.id).toBe("thermocline");
			await vi.advanceTimersByTimeAsync(10_000);
			expect(host.activeMeta()).toBeNull();
			expect(h.spawned[0].killCount).toBeGreaterThanOrEqual(1);
			expect(t.locks).toEqual([]);
			const status = h.broadcastLog.filter((m) => m.type === "conductorStatus").pop();
			expect(status && status.type === "conductorStatus" && status.text).toMatch(/did not attach/);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("shutdown — SIGTERM then SIGKILL after the grace", () => {
	it("kills the child, then force-kills if it hasn't exited", async () => {
		vi.useFakeTimers();
		try {
			const t = bulk(textSeq(2));
			const h = makeDeps(t);
			const host = new LiveConductorHost(h.deps);
			host.select("thermocline");
			const child = h.spawned[0];
			host.shutdown();
			expect(child.killCount).toBe(1); // SIGTERM
			await vi.advanceTimersByTimeAsync(2000);
			expect(child.killCount).toBe(2); // SIGKILL after the grace (child never fired onExit)
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("completion — aborted on detach", () => {
	it("aborts the in-flight completion signal when the conductor detaches", async () => {
		let captured: AbortSignal | null = null;
		const t = bulk(textSeq(2));
		const h = makeDeps(t, {
			runCompletion: (_req, signal) =>
				new Promise((_res, rej) => {
					captured = signal;
					signal.addEventListener("abort", () => rej(new Error("aborted")));
				}),
		});
		const host = new LiveConductorHost(h.deps);
		host.select("thermocline");
		const sock = {};
		host.acceptConductorSocket(sock, host.pendingAttachToken);
		host.handleConductorMessage(sock, { type: "completeRequest", reqId: 7, prompt: "summarize the aged region" });
		expect(captured).not.toBeNull();
		host.select("none"); // detach → abort in-flight completions
		await flush();
		expect(captured!.aborted).toBe(true);
		// The completeResult routes to the ORIGINATING socket (sendToSocket), bound to `sock`.
		const done = h.socketLog.filter((e) => e.socket === sock && e.msg.type === "completeResult").pop();
		expect(done && done.msg.type === "completeResult" && done.msg.ok).toBe(false);
	});
});

// ── S7: a conductor's completion abort is forwarded to the in-flight completion ──
describe("completeRequest — cancelComplete aborts the matching completion (S7)", () => {
	it("aborts the completion for a given reqId, ignores an unknown reqId, and routes the failure back", async () => {
		let captured: AbortSignal | null = null;
		const t = bulk(textSeq(2));
		const h = makeDeps(t, {
			runCompletion: (_req, signal) =>
				new Promise((_res, rej) => {
					captured = signal;
					signal.addEventListener("abort", () => rej(new Error("aborted")));
				}),
		});
		const host = new LiveConductorHost(h.deps);
		host.select("thermocline");
		const sock = {};
		host.acceptConductorSocket(sock, host.pendingAttachToken);
		host.handleConductorMessage(sock, { type: "completeRequest", reqId: 42, prompt: "summarize the aged region" });
		expect(captured).not.toBeNull();

		// An unknown/settled reqId is a no-op — the in-flight completion is untouched.
		host.handleConductorMessage(sock, { type: "cancelComplete", reqId: 999 });
		expect(captured!.aborted).toBe(false);

		// The matching reqId aborts the in-flight completion's controller.
		host.handleConductorMessage(sock, { type: "cancelComplete", reqId: 42 });
		expect(captured!.aborted).toBe(true);
		await flush();
		const done = h.socketLog.filter((e) => e.socket === sock && e.msg.type === "completeResult").pop();
		expect(done && done.msg.type === "completeResult" && done.msg.ok).toBe(false);
	});
});

// ── fix 1 (P1): a stale generation's completion settling late must not delete a NEW generation's
// live entry of the SAME reqId — every spawned SDK numbers its own requests from 1, so reqId alone
// is not a safe cross-generation key ────────────────────────────────────────────────────────────
describe("completeRequest — reqId aliasing across generations (fix 1)", () => {
	it("A's stale completion settling after detach must not delete B's live entry of the same reqId", async () => {
		const t = bulk(textSeq(2));
		const pending: Array<{ resolve: (r: { text: string; model: string }) => void; signal: AbortSignal }> = [];
		const h = makeDeps(t, {
			// Deliberately does NOT wire `signal` → reject: this simulates a provider call that
			// "ignores its abort" and keeps running (and eventually settling) after detach.
			runCompletion: (_req, signal) =>
				new Promise((res) => {
					pending.push({ resolve: res as (r: { text: string; model: string }) => void, signal });
				}),
		});
		const host = new LiveConductorHost(h.deps);

		// Generation A attaches and issues reqId 1; it stays in flight (the mock ignores abort).
		host.select("thermocline");
		const sockA = {};
		host.acceptConductorSocket(sockA, host.pendingAttachToken);
		host.handleConductorMessage(sockA, { type: "completeRequest", reqId: 1, prompt: "a" });
		expect(pending.length).toBe(1);
		host.select("none"); // detach: aborts A's controller, but the mock ignores the signal

		// Generation B attaches; its (fresh) spawned SDK numbers requests from 1 again.
		host.select("thermocline");
		const sockB = {};
		host.acceptConductorSocket(sockB, host.pendingAttachToken);
		host.handleConductorMessage(sockB, { type: "completeRequest", reqId: 1, prompt: "b" });
		expect(pending.length).toBe(2);

		// A's stale completion FINALLY settles — its `.finally()` must NOT delete B's live reqId-1 entry.
		pending[0].resolve({ text: "STALE-A", model: "m" });
		await flush();

		// B's cancelComplete for reqId 1 must still find and abort B's controller — pre-fix, A's
		// unconditional `completionsByReqId.delete(1)` already wiped this out, so B's abort would be a
		// silent no-op and the stale spend would run unbounded.
		host.handleConductorMessage(sockB, { type: "cancelComplete", reqId: 1 });
		expect(pending[1].signal.aborted).toBe(true);
	});
});

describe("propose — human override clamps a conductor op (pin mid-completion)", () => {
	it("a conductor fold of a human-pinned block is clamped human-override and the pin stands", async () => {
		const t = bulk(textSeq(3));
		t.setProtect(0);
		const host = new LiveConductorHost(makeDeps(t).deps);
		t.apply([{ kind: "pin", ids: ["a:b0:p0"] }], "you"); // human pins mid-run
		const r = await host.propose({ baseRev: t.rev, ops: [{ kind: "fold", ids: ["a:b0:p0"] }] });
		expect(r.results[0].applied).toBe(false);
		expect(r.results[0].clamped).toBe("human-override");
		expect(t.get("a:b0:p0")!.override).toBe("pinned");
	});
});

// ── finding 1: host-only freeze op refused at the conductor wire entry ─────────────
describe("propose — a host-only freeze op is refused at the wire entry", () => {
	it("strips freeze (locked clamp), applies the rest, and does NOT seize a strategy fold", async () => {
		const t = bulk(textSeq(3));
		t.setProtect(0); // no protected tail — a fold could otherwise heal on its own
		const host = new LiveConductorHost(makeDeps(t).deps);
		// A strategy-owned fold, exactly what an attached conductor holds.
		t.apply([{ kind: "replace", id: "a:b0:p0", content: "XSUB", recoverable: false }], "auto");
		expect(t.get("a:b0:p0")!.autoFolded).toBe(true);
		expect(t.get("a:b0:p0")!.override).toBeNull();

		// A conductor propose smuggling a freeze alongside a real fold.
		const r = await host.propose({ baseRev: t.rev, ops: [{ kind: "freeze" }, { kind: "fold", ids: ["a:b1:p0"] }] });

		// The freeze was refused in-position with a `locked` clamp; the real fold applied.
		expect(r.results[0].op.kind).toBe("freeze");
		expect(r.results[0].applied).toBe(false);
		expect(r.results[0].clamped).toBe("locked");
		expect(r.results[1].applied).toBe(true);

		// The strategy fold is UNTOUCHED — the freeze did not transfer ownership to the human.
		expect(t.get("a:b0:p0")!.autoFolded).toBe(true);
		expect(t.get("a:b0:p0")!.override).toBeNull();
		expect(t.get("a:b0:p0")!.by).toBe("auto");
	});

	it("the host's own detach freeze still transfers strategy ownership to the human", () => {
		// The detach kill switch calls Truth.apply([{freeze}], "you") DIRECTLY — it never routes
		// through applyPropose/applyCommand — so the guard must not touch it. (Covered end-to-end by
		// "detach — freeze BEFORE clearLocks"; asserted here at the seam for finding 1 too.)
		const t = bulk(textSeq(2));
		t.setProtect(0);
		const host = new LiveConductorHost(makeDeps(t).deps);
		host.select("compaction-naive");
		t.apply([{ kind: "replace", id: "a:b0:p0", content: "Z", recoverable: false }], "auto");
		host.select("none"); // detach → internal freeze
		expect(t.get("a:b0:p0")!.override).toBe("folded");
		expect(t.get("a:b0:p0")!.by).toBe("you");
	});
});

// ── fix 3: an in-process conductor's `propose` is refused once it's no longer the attached one ──
describe("propose — a detached in-process conductor's stray callback is refused, not applied (fix 3)", () => {
	it("a propose issued through the facade handed to a since-detached conductor mutates nothing", async () => {
		const t = bulk(textSeq(3));
		t.setProtect(0); // no protected tail — nothing else would stop the fold from landing
		const host = new LiveConductorHost(makeDeps(t).deps);

		// Capture the ACTUAL `ConductorHost` doorman was handed at attach (the generation-scoped
		// facade, post-fix) by spying on its `attach` — the spy still calls through, so doorman
		// attaches normally.
		const attachSpy = vi.spyOn(DoormanConductor.prototype, "attach");
		host.select("doorman");
		const staleHost: ConductorHost = attachSpy.mock.calls[0][0];
		attachSpy.mockRestore();

		// A different conductor attaches in doorman's place. Doorman's OWN `detach()` unsubscribes
		// from events, but this simulates the bug's shape exactly: a stray async callback that never
		// let go of the host reference it captured at attach time (e.g. a timer doorman failed to
		// cancel in its own `detach()`) still holds `staleHost` and could call `propose` on it.
		host.select("compaction-naive");

		const r = await staleHost.propose({ baseRev: t.rev, ops: [{ kind: "fold", ids: ["a:b0:p0"] }] });

		// Refused, not thrown — and Truth is untouched: the stale propose never landed.
		expect(r.results[0].applied).toBe(false);
		expect(t.get("a:b0:p0")!.autoFolded).toBe(false);
	});
});

// ── finding 4: a late completeResult routes to the ORIGINATING socket, not the swapped-in one ──
describe("completeRequest — reply binds to the socket that asked", () => {
	it("a completion resolving after an A→B swap is NOT sent to B (and does not crash on closed A)", async () => {
		const t = bulk(textSeq(2));
		let resolveCompletion: ((r: { text: string; model: string }) => void) | null = null;
		const h = makeDeps(t, {
			runCompletion: () => new Promise((res) => { resolveCompletion = res as typeof resolveCompletion; }),
		});
		const host = new LiveConductorHost(h.deps);

		// Conductor A attaches and issues a completion request that stays in flight.
		host.select("thermocline");
		const sockA = { id: "A" };
		host.acceptConductorSocket(sockA, host.pendingAttachToken);
		host.handleConductorMessage(sockA, { type: "completeRequest", reqId: 5, prompt: "summarize" });
		expect(resolveCompletion).not.toBeNull();

		// A detaches (aborting its completions) and B attaches in its place.
		host.select("none");
		host.select("thermocline");
		const sockB = { id: "B" };
		host.acceptConductorSocket(sockB, host.pendingAttachToken);

		// The stale completion resolves now — it must go to A (a no-op sink), never to B.
		resolveCompletion!({ text: "LATE", model: "m" });
		await flush();

		const toB = h.socketLog.filter((e) => e.socket === sockB && e.msg.type === "completeResult");
		expect(toB.length).toBe(0);
		const toA = h.socketLog.filter((e) => e.socket === sockA && e.msg.type === "completeResult");
		expect(toA.length).toBe(1); // the reply was addressed to A's socket (the extension's sender no-ops if A is closed)
	});
});

// ── finding 5: lastHoldMs telemetry resets on detach (cumulative holdTimeouts stays) ──
describe("telemetry — lastHoldMs resets on detach", () => {
	it("a hold-having conductor's lastHoldMs is cleared on detach, holdTimeouts kept cumulative", async () => {
		vi.useFakeTimers();
		try {
			const t = liveTruth();
			t.append(textSeq(2));
			const host = new LiveConductorHost(makeDeps(t).deps);
			host.select("thermocline"); // holdWireUpToMs = 200
			const sock = {};
			host.acceptConductorSocket(sock, host.pendingAttachToken);
			// A hold that times out — records a non-zero lastHoldMs and bumps holdTimeouts.
			const p = host.fireWireDepartingAndAwaitHold();
			await vi.advanceTimersByTimeAsync(200);
			await p;
			expect(host.lastHoldMs).toBeGreaterThan(0);
			expect(host.holdTimeouts).toBe(1);

			host.select("none"); // detach
			expect(host.lastHoldMs).toBe(0); // phantom hold no longer subtracted from netHookMs
			expect(host.holdTimeouts).toBe(1); // cumulative counter preserved
		} finally {
			vi.useRealTimers();
		}
	});
});
