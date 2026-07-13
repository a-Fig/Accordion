import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { connectLive, disconnectLive, live } from "./liveClient.svelte";
import { session } from "../session.svelte";
import { PROTOCOL_VERSION } from "./protocol";

/*
 * Malformed-frame hardening. Browser upgrades are authenticated, but native/Tauri clients
 * remain tokenless and any authorized peer may still send malformed data. isServerMessage
 * only vets the `type` tag — these tests pin that a hello without a real `meta` object and
 * a sync without a real `blocks` array are absorbed gracefully instead of throwing
 * mid-pump and stranding the client half-connected.
 *
 * Same FakeWebSocket pattern as liveClient.test.ts / conductorClient.test.ts.
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
	frames(): any[] {
		return this.sent.map((s) => JSON.parse(s));
	}
	framesOfType(t: string): any[] {
		return this.frames().filter((f) => f.type === t);
	}
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
});

afterEach(() => {
	disconnectLive();
	(globalThis as any).WebSocket = savedWS;
	if (hadWindow) (globalThis as any).window = savedWindow;
	else delete (globalThis as any).window;
});

function connectAndOpen(): FakeWebSocket {
	connectLive(1234);
	const ws = FakeWebSocket.last!;
	ws.open();
	return ws;
}

describe("liveClient — malformed frames from the unauthenticated WS", () => {
	it("absorbs a hello with no meta object: connects with fallback meta instead of throwing", () => {
		const ws = connectAndOpen();
		expect(() =>
			ws.emit({ type: "hello", protocolVersion: PROTOCOL_VERSION, sessionId: "s-x" }),
		).not.toThrow();
		expect(live.status).toBe("connected");
		expect(session.store).not.toBeNull();
		expect(session.store!.meta.title).toBe("live pi session");
		expect(session.store!.meta.cwd).toBe("");
	});

	it("absorbs a hello whose meta is a non-object", () => {
		const ws = connectAndOpen();
		expect(() =>
			ws.emit({ type: "hello", protocolVersion: PROTOCOL_VERSION, sessionId: "s-x", meta: 42 }),
		).not.toThrow();
		expect(live.status).toBe("connected");
		expect(session.store!.meta.title).toBe("live pi session");
	});

	it("absorbs a sync with a non-array blocks field and still replies with a plan", () => {
		const ws = connectAndOpen();
		ws.emit({
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			sessionId: "s-x",
			meta: { title: "t", cwd: "/tmp", model: "m", contextWindow: 1000 },
		});
		ws.sent.length = 0;
		expect(() => ws.emit({ type: "sync", reqId: 7, full: false, blocks: "nope" })).not.toThrow();
		// The pump survived: no blocks were added, and the plan reply still went out —
		// a throw before the reply would leave the extension waiting for a plan timeout.
		expect(session.store!.blocks).toHaveLength(0);
		const plans = ws.framesOfType("plan");
		expect(plans).toHaveLength(1);
		expect(plans[0].reqId).toBe(7);
	});

	it("drops malformed ELEMENTS of a sync blocks array, keeps the valid ones, still replies", () => {
		const ws = connectAndOpen();
		ws.emit({
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			sessionId: "s-x",
			meta: { title: "t", cwd: "/tmp", model: "m", contextWindow: 1000 },
		});
		ws.sent.length = 0;
		const good = { id: "u:1", kind: "user", turn: 1, order: 0, text: "hi", tokens: 5 };
		expect(() =>
			ws.emit({
				type: "sync",
				reqId: 8,
				full: false,
				blocks: [null, {}, { id: "x", kind: "user" }, { ...good, kind: "nonsense" }, good],
			}),
		).not.toThrow();
		expect(session.store!.blocks.map((b) => b.id)).toEqual(["u:1"]);
		const plans = ws.framesOfType("plan");
		expect(plans).toHaveLength(1);
		expect(plans[0].reqId).toBe(8);
	});
});
