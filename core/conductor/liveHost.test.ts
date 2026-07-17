/*
 * liveHost.test.ts — `LiveConductorHost` (the in-extension live conductor host, Phase C) driven
 * against a REAL `Truth` with mocked sockets / spawn / completion. Covers: select→detach ordering
 * (freeze BEFORE clearLocks), eager `setLocks`, single-use attach token, non-active-socket
 * rejection, the wire-departing hold (in-process sync/async + remote empty-propose/timeout with the
 * generation token), the spawn pending-attach timeout, shutdown teardown, completion abort on
 * detach, and the human-override clamp of a conductor propose. Plus the registry catalog.
 */
import { describe, it, expect, vi } from "vitest";
import { Truth } from "../truth";
import type { Block, ParsedSession } from "../types";
import type { ServerMessage } from "../protocol";
import { LiveConductorHost, type LiveHostDeps, type SpawnedRunner } from "./liveHost";
import { catalogMeta, entryById } from "./registry";

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
	spawned: MockChild[];
	runCompletion: ReturnType<typeof vi.fn>;
}
function makeDeps(truth: Truth | null, overrides: Partial<LiveHostDeps> = {}): Harness {
	const broadcastLog: ServerMessage[] = [];
	const conductorLog: ServerMessage[] = [];
	const spawned: MockChild[] = [];
	let n = 0;
	const runCompletion = vi.fn(async (_req: unknown, _signal: AbortSignal) => ({ text: "SUMMARY", model: "m" }));
	const deps: LiveHostDeps = {
		truth: () => truth,
		broadcast: (m) => broadcastLog.push(m),
		sendToConductor: (m) => conductorLog.push(m),
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
	return { deps, broadcastLog, conductorLog, spawned, runCompletion };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

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

describe("hold — remote", () => {
	it("resolves on the first propose (empty ops = release ack)", async () => {
		const t = liveTruth();
		t.append(textSeq(2));
		const h = makeDeps(t);
		const host = new LiveConductorHost(h.deps);
		host.select("thermocline");
		const sock = {};
		host.acceptConductorSocket(sock, host.pendingAttachToken);
		const p = host.fireWireDepartingAndAwaitHold();
		expect(h.conductorLog.some((m) => m.type === "wireDeparting")).toBe(true);
		host.handleConductorMessage(sock, { type: "propose", seq: 1, baseRev: t.rev, ops: [] });
		await p;
		expect(host.holdTimeouts).toBe(0);
	});

	it("times out, counts it, and a LATE propose does not resolve a future hold (generation token)", async () => {
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
			await vi.advanceTimersByTimeAsync(200);
			await p1;
			expect(host.holdTimeouts).toBe(1);
			// A propose arriving after the timeout finds no pending hold — ignored (still applied+replied).
			host.handleConductorMessage(sock, { type: "propose", seq: 9, baseRev: t.rev, ops: [] });
			expect(host.holdTimeouts).toBe(1);
			// A fresh hold is NOT resolved by that earlier late propose — it times out on its own.
			const p2 = host.fireWireDepartingAndAwaitHold();
			await vi.advanceTimersByTimeAsync(200);
			await p2;
			expect(host.holdTimeouts).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});
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
		const done = h.conductorLog.filter((m) => m.type === "completeResult").pop();
		expect(done && done.type === "completeResult" && done.ok).toBe(false);
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
