import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { connectLive, disconnectLive, live } from "./liveClient.svelte";
import { session } from "../session.svelte";
import { PROTOCOL_VERSION } from "./protocol";

/*
 * Malformed-frame hardening (Phase B). Browser upgrades are authenticated, but native/Tauri
 * clients remain tokenless and any authorized peer may still send malformed data. isServerMessage
 * only vets the `type` tag — these tests pin that a hello without a real `meta` object falls back
 * to placeholder meta, and a snapshot with a non-array / malformed `blocks` field is absorbed
 * gracefully (bad elements dropped) instead of throwing mid-pump and stranding the client.
 *
 * Same FakeWebSocket pattern as liveClient.test.ts.
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

const EMPTY_STATE = {
	blocks: [] as any[],
	overlay: [] as any[],
	groups: [] as any[],
	budget: 70_000,
	contextWindow: 1000,
	protectTokens: 0,
	locks: [] as any[],
	lockHolder: null,
	tailTokens: 0,
	sentThroughOrder: -1,
	wireAttached: true,
	foldingEnabled: false,
	rev: 1,
};

describe("liveClient — malformed frames from the unauthenticated WS", () => {
	it("absorbs a hello with no meta object: builds the replica with fallback meta on snapshot", () => {
		const ws = connectAndOpen();
		expect(() =>
			ws.emit({ type: "hello", protocolVersion: PROTOCOL_VERSION, sessionId: "s-x", role: "gui" }),
		).not.toThrow();
		expect(live.status).toBe("connected");
		ws.emit({ type: "snapshot", state: EMPTY_STATE });
		expect(session.store).not.toBeNull();
		expect(session.store!.meta.title).toBe("live pi session");
		expect(session.store!.meta.cwd).toBe("");
	});

	it("absorbs a hello whose meta is a non-object", () => {
		const ws = connectAndOpen();
		expect(() =>
			ws.emit({ type: "hello", protocolVersion: PROTOCOL_VERSION, sessionId: "s-x", role: "gui", meta: 42 }),
		).not.toThrow();
		expect(live.status).toBe("connected");
		ws.emit({ type: "snapshot", state: EMPTY_STATE });
		expect(session.store!.meta.title).toBe("live pi session");
	});

	it("absorbs a snapshot with a non-array blocks field: builds an empty replica, no throw", () => {
		const ws = connectAndOpen();
		ws.emit({ type: "hello", protocolVersion: PROTOCOL_VERSION, sessionId: "s-x", role: "gui", meta: { title: "t", cwd: "/tmp", model: "m", contextWindow: 1000, format: "pi" } });
		expect(() => ws.emit({ type: "snapshot", state: { ...EMPTY_STATE, blocks: "nope" } })).not.toThrow();
		expect(session.store).not.toBeNull();
		expect(session.store!.blocks).toHaveLength(0);
	});

	it("drops malformed ELEMENTS of a snapshot blocks array, keeps the valid ones", () => {
		const ws = connectAndOpen();
		ws.emit({ type: "hello", protocolVersion: PROTOCOL_VERSION, sessionId: "s-x", role: "gui", meta: { title: "t", cwd: "/tmp", model: "m", contextWindow: 1000, format: "pi" } });
		const good = { id: "u:1", kind: "user", turn: 1, order: 0, text: "hi", tokens: 5 };
		expect(() =>
			ws.emit({
				type: "snapshot",
				state: { ...EMPTY_STATE, blocks: [null, {}, { id: "x", kind: "user" }, { ...good, kind: "nonsense" }, good] },
			}),
		).not.toThrow();
		expect(session.store!.blocks.map((b) => b.id)).toEqual(["u:1"]);
	});
});
