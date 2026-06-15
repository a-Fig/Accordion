import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RemoteRunner, attachConductor, conductorLink, conductorRetry, conductorStatus } from "./conductorClient.svelte";
import { AccordionStore } from "../engine/store.svelte";
import type { Block, ParsedSession } from "../engine/types";
import type { ConductorEntry } from "./registry";
import { estTokens } from "../engine/tokens";

/*
 * Round-trip the RemoteRunner against a fake WebSocket — the integration proof that an
 * out-of-process conductor can drive the store over the wire: receive context, send
 * commands, get clamp feedback, and answer capability requests. No real socket; we drive
 * the message pump by hand (the pattern extension/smoke.mjs uses against a real WS).
 */

class FakeWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSED = 3;
	static last: FakeWebSocket | null = null;

	readyState = FakeWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	sent: string[] = [];

	constructor(public url: string) {
		FakeWebSocket.last = this;
	}
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
	}
	// --- test drivers ---
	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}
	emit(obj: unknown): void {
		this.onmessage?.({ data: JSON.stringify(obj) });
	}
	/** All parsed frames the host sent, in order. */
	frames(): any[] {
		return this.sent.map((s) => JSON.parse(s));
	}
	framesOfType(t: string): any[] {
		return this.frames().filter((f) => f.type === t);
	}
}

function blk(i: number, kind: Block["kind"] = "text", tokens = 1000): Block {
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
	};
}

function makeStore(n: number): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "live", cwd: "/tmp", model: "m" },
		blocks: Array.from({ length: n }, (_, i) => blk(i)),
		lineCount: 0,
		skipped: 0,
	};
	return new AccordionStore(parsed);
}

const ENTRY: ConductorEntry = {
	registryProtocol: 1,
	conductorProtocol: 2,
	id: "remote-test",
	label: "Remote Test",
	url: "ws://127.0.0.1:9999",
	pid: 0,
	startedAt: 0,
	heartbeatAt: 0,
};

let savedWS: unknown;
beforeEach(() => {
	savedWS = (globalThis as any).WebSocket;
	(globalThis as any).WebSocket = FakeWebSocket;
	FakeWebSocket.last = null;
	// conductorStatus is module-level $state — reset it so a leaked value from a prior test
	// can't make a later assertion pass (or flake) by luck of ordering.
	conductorStatus.text = "";
	conductorStatus.metrics = {};
});
afterEach(() => {
	(globalThis as any).WebSocket = savedWS;
});

function connectRunner(store: AccordionStore): { runner: RemoteRunner; ws: FakeWebSocket } {
	const runner = new RemoteRunner(ENTRY, store);
	store.attach(runner);
	runner.connect();
	const ws = FakeWebSocket.last!;
	ws.open(); // → host/hello + initial context/update
	return { runner, ws };
}

function sendHello(ws: FakeWebSocket, content: "full" | "shape" | "onDemand" = "full"): void {
	ws.emit({ type: "conductor/hello", conductorProtocol: 2, id: "remote-test", label: "Remote Test", wants: { content } });
}

describe("RemoteRunner — handshake & context push", () => {
	it("sends host/hello on open, then holds context until conductor/hello arrives", () => {
		const { ws } = connectRunner(makeStore(3));
		const hello = ws.framesOfType("host/hello");
		expect(hello).toHaveLength(1);
		expect(hello[0].conductorProtocol).toBe(2);
		// No context pushed yet — we wait to learn `wants` so we never leak full text.
		expect(ws.framesOfType("context/update")).toHaveLength(0);

		sendHello(ws, "full");
		const u = ws.framesOfType("context/update").pop();
		expect(u.blocks).toHaveLength(3);
		expect(u.blocks[0].text).toBeDefined(); // wants:"full"
	});

	it("honours wants:shape from the very first context frame (no full text leaked)", () => {
		const { ws } = connectRunner(makeStore(2));
		sendHello(ws, "shape");
		const u = ws.framesOfType("context/update").pop();
		expect(u.blocks[0].text).toBeUndefined();
		expect(u.blocks[0].preview).toBeDefined();
	});
});

describe("RemoteRunner — commands drive the store", () => {
	it("applies a fold and reports no clamp for a valid command", () => {
		const store = makeStore(3);
		store.setProtect(0); // small fixture (3×1000 tok) is entirely inside the 20k tail — disable protection so a fold is allowed
		const { ws } = connectRunner(store);
		ws.emit({ type: "conductor/commands", rev: 1, commands: [{ kind: "fold", ids: ["m0:p0"] }] });

		expect(store.isFolded(store.get("m0:p0")!)).toBe(true);
		expect(store.get("m0:p0")!.by).toBe("auto"); // attribution is now uniform across all conductors

		const results = ws.framesOfType("host/commandResult");
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[results.length - 1].reports).toEqual([]);
	});

	it("replaces content and round-trips a clamp report for an unknown id", () => {
		const store = makeStore(3);
		store.setProtect(0); // see above — disable protection so the tiny fixture's blocks are foldable
		const { ws } = connectRunner(store);
		ws.emit({
			type: "conductor/commands",
			rev: 2,
			commands: [
				{ kind: "replace", id: "m1:p0", content: "summarized" },
				{ kind: "fold", ids: ["ghost:p0"] },
			],
		});

		expect(store.digestOf(store.get("m1:p0")!)).toBe("summarized");
		const result = ws.framesOfType("host/commandResult").pop();
		expect(result.reports.some((r: any) => r.reason === "unknown-id")).toBe(true);
	});

	it("holds the last command set when the conductor goes silent", () => {
		const store = makeStore(3);
		store.setProtect(0); // see above — disable protection so the tiny fixture's blocks are foldable
		const { ws } = connectRunner(store);
		ws.emit({ type: "conductor/commands", commands: [{ kind: "fold", ids: ["m0:p0"] }] });
		expect(store.isFolded(store.get("m0:p0")!)).toBe(true);

		// New context arrives, conductor says nothing → fold held, new block raw.
		store.appendBlocks([blk(9)]);
		expect(store.isFolded(store.get("m0:p0")!)).toBe(true);
		expect(store.isFolded(store.get("m9:p0")!)).toBe(false);
	});
});

describe("RemoteRunner — capabilities", () => {
	it("answers countTokens from the host tokenizer", () => {
		const { ws } = connectRunner(makeStore(2));
		ws.emit({ type: "cap/request", reqId: "c1", capability: "countTokens", text: "hello world" });
		const res = ws.framesOfType("cap/result").pop();
		expect(res.reqId).toBe("c1");
		expect(res.ok).toBe(true);
		expect(res.value).toBe(estTokens("hello world"));
	});

	it("answers getContent and errors on an unknown block", () => {
		const store = makeStore(2);
		const { ws } = connectRunner(store);
		ws.emit({ type: "cap/request", reqId: "c2", capability: "getContent", ids: ["m0:p0"] });
		ws.emit({ type: "cap/request", reqId: "c3", capability: "getContent", ids: ["nope"] });
		const [ok, bad] = ws.framesOfType("cap/result").slice(-2);
		expect(ok.value).toBe(store.get("m0:p0")!.text);
		expect(bad.ok).toBe(false);
		expect(bad.error).toContain("nope");
	});
});

describe("RemoteRunner — host events", () => {
	it("forwards an agent-unfold notification", () => {
		const { runner, ws } = connectRunner(makeStore(2));
		runner.notifyEvent("agentUnfold", ["abc123"], "agent unfolded 1 block(s)");
		const ev = ws.framesOfType("host/event").pop();
		expect(ev.event).toBe("agentUnfold");
		expect(ev.ids).toEqual(["abc123"]);
	});
});

describe("attachConductor — human-override wiring", () => {
	it("routes a hand fold/pin to the attached remote as host/event humanOverride", () => {
		const store = makeStore(2);
		attachConductor(store, ENTRY.id, [ENTRY]); // dials a RemoteRunner
		const ws = FakeWebSocket.last!;
		ws.open();

		store.pin("m0:p0"); // human action by hand

		const ev = ws.framesOfType("host/event").filter((e) => e.event === "humanOverride").pop();
		expect(ev).toBeDefined();
		expect(ev.ids).toEqual(["m0:p0"]);

		attachConductor(store, "builtin", []); // tear the remote down so it can't leak into other tests
	});
});

describe("RemoteRunner — stale-rev guard (Bug 1)", () => {
	it("drops a conductor/commands reply whose rev is older than the latest context/update sent", () => {
		const store = makeStore(3);
		store.setProtect(0);
		const { runner, ws } = connectRunner(store);
		sendHello(ws, "full");

		// After conductor/hello, one context/update was sent (rev=1).
		// A reply for rev=0 (< 1) must be dropped — block must NOT be folded.
		ws.emit({ type: "conductor/commands", rev: 0, commands: [{ kind: "fold", ids: ["m0:p0"] }] });
		expect(store.isFolded(store.get("m0:p0")!)).toBe(false);

		// A reply for the current rev (1) must be applied.
		ws.emit({ type: "conductor/commands", rev: 1, commands: [{ kind: "fold", ids: ["m0:p0"] }] });
		expect(store.isFolded(store.get("m0:p0")!)).toBe(true);

		runner.close();
	});

	it("accepts a conductor/commands reply with no rev (backward compat with conductors that don't echo rev)", () => {
		const store = makeStore(3);
		store.setProtect(0);
		const { runner, ws } = connectRunner(store);
		sendHello(ws, "full");

		// No rev field — must be accepted (backward compatible).
		ws.emit({ type: "conductor/commands", commands: [{ kind: "fold", ids: ["m0:p0"] }] });
		expect(store.isFolded(store.get("m0:p0")!)).toBe(true);

		runner.close();
	});
});

describe("RemoteRunner — protocol-mismatch status survives teardown (Bug 2)", () => {
	it("preserves error status and detail after the mismatch branch calls close()", () => {
		const store = makeStore(2);
		const { ws } = connectRunner(store);
		// Do NOT sendHello — we want to test the mismatch branch directly.

		// Emit a conductor/hello with a wrong protocol version.
		ws.emit({ type: "conductor/hello", conductorProtocol: 999, id: "x", label: "X" });

		// close() must NOT have reset status to "idle" — the error must survive.
		expect(conductorLink.status).toBe("error");
		expect(conductorLink.detail).toMatch(/protocol mismatch/);
	});
});

describe("attachConductor — dead runner re-dial on repeat attach (Bug 4)", () => {
	it("creates a NEW socket when attachConductor is called again after an unexpected drop", () => {
		const store = makeStore(2);
		attachConductor(store, ENTRY.id, [ENTRY]);
		const ws1 = FakeWebSocket.last!;
		ws1.open();

		// Mark the runner dead via an unexpected socket close (no runner.close() beforehand).
		ws1.onclose?.();

		// The runner should now be flagged dead.
		expect(conductorLink.status).toBe("error");

		// Calling attachConductor again with the same id+entry must NOT short-circuit:
		// the dead runner must be torn down and a new socket dialed.
		attachConductor(store, ENTRY.id, [ENTRY]);
		const ws2 = FakeWebSocket.last!;

		// A new socket must have been created — not the same stale one.
		expect(ws2).not.toBe(ws1);

		// Clean up.
		attachConductor(store, "builtin", []);
	});

	it("a MANUAL close does NOT set dead — a repeat attach of a different id stays a normal no-op via lastId guard", () => {
		const store = makeStore(2);
		attachConductor(store, ENTRY.id, [ENTRY]);
		const ws1 = FakeWebSocket.last!;
		ws1.open();

		// Manually switch away — this calls runner.close() which must NOT set _dead.
		attachConductor(store, "builtin", []);

		// Switch back to the remote entry: a fresh runner (new socket) is created.
		attachConductor(store, ENTRY.id, [ENTRY]);
		const ws2 = FakeWebSocket.last!;
		expect(ws2).not.toBe(ws1);

		// Clean up.
		attachConductor(store, "builtin", []);
	});
});

describe("RemoteRunner — stale desired cleared on unexpected disconnect (Bug 3)", () => {
	it("clears to raw (conduct returns []) after an unexpected socket close", () => {
		const store = makeStore(3);
		store.setProtect(0);
		const { runner, ws } = connectRunner(store);
		sendHello(ws, "full");

		// Arm the runner with a fold command (rev=1, matching what was sent).
		ws.emit({ type: "conductor/commands", rev: 1, commands: [{ kind: "fold", ids: ["m0:p0"] }] });
		expect(store.isFolded(store.get("m0:p0")!)).toBe(true);

		// Simulate unexpected drop: call onclose without setting manualClose (no runner.close()).
		ws.onclose?.();

		// The status should be "error" (not "idle") to signal an unexpected drop.
		expect(conductorLink.status).toBe("error");

		// conduct() should now return [] (clear to raw), not the stale fold command.
		// We use a minimal ConductorView — the runner only reads its cached `desired`.
		const view = {
			budget: 10000,
			contextWindow: 200000,
			liveTokens: 3000,
			protectedFromIndex: 0,
			protectTokens: 0,
			blocks: [],
		};
		const result = runner.conduct(view as any);
		expect(result).toEqual([]);
	});

	it("the STORE goes raw immediately after disconnect — without manually calling conduct()", () => {
		const store = makeStore(3);
		store.setProtect(0);
		const { ws } = connectRunner(store);
		sendHello(ws, "full");

		// Fold m0:p0 via conductor command.
		ws.emit({ type: "conductor/commands", rev: 1, commands: [{ kind: "fold", ids: ["m0:p0"] }] });
		expect(store.isFolded(store.get("m0:p0")!)).toBe(true);

		// Unexpected close — the onclose handler must immediately call store.refold() so the
		// block flips to raw in the same tick, not waiting for some future unrelated refold.
		ws.onclose?.();

		// The store must be raw NOW, without any manual conduct() call from the test.
		expect(store.isFolded(store.get("m0:p0")!)).toBe(false);
	});
});

describe("RemoteRunner — conductor/status telemetry (display-only)", () => {
	it("stashes text + metrics from a conductor/status without touching folds or replying", () => {
		const store = makeStore(3);
		store.setProtect(0);
		const { ws } = connectRunner(store);
		sendHello(ws, "full");

		const resultsBefore = ws.framesOfType("host/commandResult").length;
		ws.emit({
			type: "conductor/status",
			text: "82% full · holding · band 70–90% · 14 folded",
			metrics: { fullness: 82, action: "hold", folded: 14, scoring: false },
		});

		expect(conductorStatus.text).toBe("82% full · holding · band 70–90% · 14 folded");
		expect(conductorStatus.metrics.fullness).toBe(82);
		// Display-only: it must NOT fold anything or emit a commandResult.
		expect(store.isFolded(store.get("m0:p0")!)).toBe(false);
		expect(ws.framesOfType("host/commandResult").length).toBe(resultsBefore);
	});

	it("clears the status line on an unexpected disconnect", () => {
		const store = makeStore(2);
		const { ws } = connectRunner(store);
		sendHello(ws, "full");
		ws.emit({ type: "conductor/status", text: "50% full · holding", metrics: {} });
		expect(conductorStatus.text).toBe("50% full · holding");

		ws.onclose?.(); // unexpected drop → stale telemetry must be hidden
		expect(conductorStatus.text).toBe("");
	});

	it("clears the status line when the remote is swapped for the built-in", () => {
		const store = makeStore(2);
		attachConductor(store, ENTRY.id, [ENTRY]);
		const ws = FakeWebSocket.last!;
		ws.open();
		sendHello(ws, "full");
		ws.emit({ type: "conductor/status", text: "70% full · holding", metrics: {} });
		expect(conductorStatus.text).toBe("70% full · holding");

		attachConductor(store, "builtin", []); // swap to in-process → close() clears the line
		expect(conductorStatus.text).toBe("");
	});
});

describe("attachConductor — absent remote detaches to raw ONCE (Bug 5: re-attach loop)", () => {
	it("does NOT re-detach/refold on every call while the selected remote stays undiscovered", () => {
		const store = makeStore(2);
		// Establish a clean module baseline for this store first (in-proc attach, lastFallback=false).
		attachConductor(store, "builtin", []);

		// Spy on store.detach to count REAL (re-)detaches from here on. Per main #35 an absent
		// remote runs RAW (detach), not a built-in stand-in.
		let detachCount = 0;
		const origDetach = store.detach.bind(store);
		(store as any).detach = () => {
			detachCount++;
			return origDetach();
		};

		// Select a remote id that is NOT in `available` → detach to raw once.
		attachConductor(store, "ghost-remote", []);
		expect(detachCount).toBe(1);

		// Repeat calls with the SAME id while the remote is still absent must be no-ops. The old
		// bug re-ran the fallback (and refold) on every discovery poll → churn →
		// effect_update_depth_exceeded (the frozen window). The lastFallback guard makes it stable.
		attachConductor(store, "ghost-remote", []);
		attachConductor(store, "ghost-remote", []);
		expect(detachCount).toBe(1);

		// When the remote finally appears, we dial the real runner (a fresh socket) — no re-detach.
		FakeWebSocket.last = null;
		attachConductor(store, "ghost-remote", [{ ...ENTRY, id: "ghost-remote" }]);
		expect(detachCount).toBe(1);
		expect(FakeWebSocket.last).not.toBeNull();
		FakeWebSocket.last!.open();

		// Clean up so the remote runner can't leak into later tests.
		attachConductor(store, "builtin", []);
	});
});

describe("RemoteRunner — conductorRetry tick (bounded auto-recovery)", () => {
	it("bumps conductorRetry.tick when a greeted runner drops unexpectedly", () => {
		const store = makeStore(2);
		const { ws } = connectRunner(store);
		// Capture baseline — tests must not assert absolute values because earlier tests may have
		// already bumped the tick; always diff from the captured baseline.
		const tickBefore = conductorRetry.tick;

		// Complete the handshake so greeted=true.
		sendHello(ws, "full");

		// Simulate unexpected drop (no runner.close() beforehand).
		ws.onclose?.();

		expect(conductorRetry.tick).toBe(tickBefore + 1);
	});

	it("does NOT bump conductorRetry.tick when a runner drops before ever receiving conductor/hello", () => {
		const store = makeStore(2);
		const { ws } = connectRunner(store);
		const tickBefore = conductorRetry.tick;

		// Do NOT send conductor/hello — greeted stays false.
		// Simulate unexpected drop immediately (e.g. conductor down / unreachable).
		ws.onclose?.();

		// Tick must remain unchanged — no thrash retry for a never-greeted runner.
		expect(conductorRetry.tick).toBe(tickBefore);
	});
});
