import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { connectLive, disconnectLive, setArmed, live } from "./liveClient.svelte";
import { folding } from "./folding.svelte";
import { session } from "../session.svelte";
import { PROTOCOL_VERSION, type SnapshotState, type WireEvent } from "./protocol";

/*
 * liveClient Phase B coverage. The live client is a WebSocket CLIENT, so we drive it against a fake
 * socket installed on `globalThis.WebSocket`. `connectLive` also guards on `typeof window` — node is
 * the vitest environment, so we shim a truthy `window` too.
 *
 * Scope: the replica + remote-control contract — hello → snapshot builds a replica store; `event`s
 * replay onto it (rev-gap → resnapshot); a human fold routes to the wire as a `command` with NO
 * optimistic apply (the block folds only when the echo event arrives); the arm toggle sends a
 * `setFolding` command and tracks the host's `folding` echo; telemetry drives the latency badge.
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
	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}
	emit(obj: unknown): void {
		this.onmessage?.({ data: JSON.stringify(obj) });
	}
	frames(): any[] {
		return this.sent.map((s) => JSON.parse(s));
	}
	framesOfType(t: string): any[] {
		return this.frames().filter((f) => f.type === t);
	}
}

function helloFrame() {
	return {
		type: "hello",
		protocolVersion: PROTOCOL_VERSION,
		sessionId: "s-test",
		role: "gui",
		meta: { title: "t", cwd: "/tmp", model: "m", contextWindow: 1000, format: "pi" },
	};
}

const BASE_REV = 5;
function snapshotState(over: Partial<SnapshotState> = {}): SnapshotState {
	return {
		blocks: [
			{ id: "u:1", kind: "user", turn: 1, order: 0, text: "hi", tokens: 100 },
			{ id: "a:r1:p0", kind: "text", turn: 1, order: 1, text: "reply " + "x".repeat(200), tokens: 200 },
		],
		overlay: [],
		groups: [],
		budget: 70_000,
		contextWindow: 1000,
		protectTokens: 0, // nothing protected → the reply block is foldable
		locks: [],
		lockHolder: null,
		tailTokens: 0,
		sentThroughOrder: 1,
		wireAttached: true,
		foldingEnabled: false,
		birthFolded: [],
		rev: BASE_REV,
		...over,
	};
}

/** Connect, hello, and snapshot so the replica store is built and steerable. */
function connectHelloSnapshot(over: Partial<SnapshotState> = {}): FakeWebSocket {
	connectLive(1234);
	const ws = FakeWebSocket.last!;
	ws.open();
	ws.emit(helloFrame());
	ws.emit({ type: "snapshot", state: snapshotState(over) });
	return ws;
}

let savedWS: unknown;
let savedWindow: unknown;
let hadWindow: boolean;

beforeEach(() => {
	savedWS = (globalThis as any).WebSocket;
	hadWindow = "window" in globalThis;
	savedWindow = (globalThis as any).window;
	(globalThis as any).WebSocket = FakeWebSocket;
	(globalThis as any).window = (globalThis as any).window ?? {};
	FakeWebSocket.last = null;
	folding.enabled = false;
	session.store = null;
});

afterEach(() => {
	disconnectLive();
	(globalThis as any).WebSocket = savedWS;
	if (hadWindow) (globalThis as any).window = savedWindow;
	else delete (globalThis as any).window;
});

describe("liveClient — replica build + event replay", () => {
	it("builds a rev-aligned replica store from the snapshot", () => {
		connectHelloSnapshot();
		expect(live.status).toBe("connected");
		expect(session.store).not.toBeNull();
		expect(session.store!.blocks.map((b) => b.id)).toEqual(["u:1", "a:r1:p0"]);
		expect(session.store!.rev).toBe(BASE_REV);
		expect(folding.enabled).toBe(false);
	});

	it("replays an appended event and stays rev-aligned (no resnapshot)", () => {
		const ws = connectHelloSnapshot();
		ws.sent.length = 0;
		const ev: WireEvent = {
			kind: "appended",
			blocks: [{ id: "u:2", kind: "user", turn: 2, order: 2, text: "next", tokens: 100 }],
			rev: BASE_REV + 1,
		};
		ws.emit({ type: "event", event: ev });
		expect(session.store!.blocks.map((b) => b.id)).toEqual(["u:1", "a:r1:p0", "u:2"]);
		expect(session.store!.rev).toBe(BASE_REV + 1);
		expect(ws.framesOfType("resnapshot")).toHaveLength(0);
	});

	it("requests a resnapshot when a replayed event's rev doesn't line up", () => {
		const ws = connectHelloSnapshot();
		ws.sent.length = 0;
		ws.emit({
			type: "event",
			event: { kind: "appended", blocks: [{ id: "u:2", kind: "user", turn: 2, order: 2, text: "x", tokens: 100 }], rev: 999 },
		});
		expect(ws.framesOfType("resnapshot")).toEqual([{ type: "resnapshot" }]);
	});

	it("requests a resnapshot on a reset event rather than replaying it", () => {
		const ws = connectHelloSnapshot();
		ws.sent.length = 0;
		ws.emit({ type: "event", event: { kind: "reset", by: "you", rev: BASE_REV + 1 } });
		expect(ws.framesOfType("resnapshot")).toEqual([{ type: "resnapshot" }]);
	});
});

describe("liveClient — remote control (commands, no optimistic apply)", () => {
	it("routes a human fold to the wire as a command and only folds on the echoed event", () => {
		const ws = connectHelloSnapshot();
		ws.sent.length = 0;

		session.store!.fold("a:r1:p0");
		// No optimistic apply: the block is NOT folded until the host echoes the event back.
		const b = session.store!.get("a:r1:p0")!;
		expect(session.store!.isFolded(b)).toBe(false);
		const cmds = ws.framesOfType("command");
		expect(cmds).toHaveLength(1);
		expect(cmds[0].cmd).toEqual({ kind: "ops", ops: [{ kind: "fold", ids: ["a:r1:p0"] }] });

		// The host applies the fold and echoes an ops event; the replica folds via replay.
		ws.emit({ type: "event", event: { kind: "ops", by: "you", ops: [{ kind: "fold", ids: ["a:r1:p0"] }], rev: BASE_REV + 1 } });
		expect(session.store!.isFolded(session.store!.get("a:r1:p0")!)).toBe(true);
	});

	it("routes budget + protect dials to the wire as config commands", () => {
		const ws = connectHelloSnapshot();
		ws.sent.length = 0;
		session.store!.setBudget(120_000);
		session.store!.setProtect(8_000);
		expect(ws.framesOfType("command").map((f) => f.cmd)).toEqual([
			{ kind: "setBudget", value: 120_000 },
			{ kind: "setProtect", value: 8_000 },
		]);
	});

	it("setArmed sends a setFolding command; folding.enabled tracks the host's echo, not optimism", () => {
		const ws = connectHelloSnapshot();
		ws.sent.length = 0;
		setArmed(true);
		expect(ws.framesOfType("command")).toEqual([{ type: "command", seq: expect.any(Number), cmd: { kind: "setFolding", value: true } }]);
		expect(folding.enabled).toBe(false); // not optimistic — waits for the echo
		ws.emit({ type: "folding", enabled: true });
		expect(folding.enabled).toBe(true);
	});
});

describe("liveClient — telemetry + protocol guard", () => {
	it("updates the latency telemetry from a telemetry frame", () => {
		const ws = connectHelloSnapshot();
		ws.emit({ type: "telemetry", lastHookMs: 3, maxHookMs: 12, p95HookMs: 7, rebuilds: 1, hookCount: 42 });
		expect(live.telemetry).toEqual({ lastHookMs: 3, maxHookMs: 12, p95HookMs: 7, rebuilds: 1, hookCount: 42 });
	});

	it("refuses a protocol-version mismatch loudly", () => {
		connectLive(1234);
		const ws = FakeWebSocket.last!;
		ws.open();
		ws.emit({ ...helloFrame(), protocolVersion: PROTOCOL_VERSION + 1 });
		expect(live.status).toBe("error");
		expect(live.detail).toContain("protocol mismatch");
	});
});
