import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { connectLive, disconnectLive, setArmed, live } from "./liveClient.svelte";
import { folding } from "./folding.svelte";
import { PROTOCOL_VERSION } from "./protocol";

/*
 * liveClient armed-over-wire coverage. The live client is a WebSocket CLIENT, so we drive it
 * against a fake socket installed on `globalThis.WebSocket` (the same pattern conductorClient.test.ts
 * uses, and that extension/smoke.mjs uses against a real WS). `connectLive` also guards on
 * `typeof window` — node is the vitest environment here, so we shim a truthy `window` too.
 *
 * Scope: the two things this change adds to the client — `setArmed` puts an `armed` frame on the
 * wire (guarded on socket state), and the hello handler re-declares armed:false alongside the
 * folding reset on every attach. Deeper store/plan behavior is covered elsewhere (plan.test.ts,
 * mapping.test.ts) and by the extension smoke tests.
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

function helloFrame() {
	return {
		type: "hello",
		protocolVersion: PROTOCOL_VERSION,
		sessionId: "s-test",
		meta: { title: "t", cwd: "/tmp", model: "m", contextWindow: 1000, format: "pi" },
	};
}

/** Connect and complete the hello handshake so the socket is OPEN and steerable. */
function connectAndHello(): FakeWebSocket {
	connectLive(1234);
	const ws = FakeWebSocket.last!;
	ws.open(); // OPEN before hello so a send inside the hello handler can land
	ws.emit(helloFrame());
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
});

afterEach(() => {
	disconnectLive();
	(globalThis as any).WebSocket = savedWS;
	if (hadWindow) (globalThis as any).window = savedWindow;
	else delete (globalThis as any).window;
});

describe("liveClient — armed over the wire", () => {
	it("re-declares armed:false alongside the folding reset on every attach (hello)", () => {
		const ws = connectAndHello();
		expect(live.status).toBe("connected");
		// The safety reset: a fresh attach always starts disarmed...
		expect(folding.enabled).toBe(false);
		// ...and that disarmed state is explicitly re-synced to the extension.
		const armedFrames = ws.framesOfType("armed");
		expect(armedFrames.length).toBeGreaterThanOrEqual(1);
		expect(armedFrames.at(-1)).toEqual({ type: "armed", armed: false });
	});

	it("setArmed(true) flips folding AND sends {type:'armed',armed:true} when connected", () => {
		const ws = connectAndHello();
		ws.sent.length = 0; // drop the hello-time armed:false so we assert only the toggle's frame

		setArmed(true);
		expect(folding.enabled).toBe(true);
		expect(ws.framesOfType("armed")).toEqual([{ type: "armed", armed: true }]);

		ws.sent.length = 0;
		setArmed(false);
		expect(folding.enabled).toBe(false);
		expect(ws.framesOfType("armed")).toEqual([{ type: "armed", armed: false }]);
	});

	it("setArmed still flips folding but sends nothing on the wire when the socket is closed", () => {
		const ws = connectAndHello();
		ws.close(); // readyState → CLOSED; the client's onclose nulls out the active socket
		ws.sent.length = 0;

		setArmed(true);
		// Local state (the on-screen preview / arm intent) still flips...
		expect(folding.enabled).toBe(true);
		// ...but the guarded send is a no-op: no frame goes out on a non-OPEN socket. The state
		// is re-synced on the next attach from the hello handler, so nothing is lost.
		expect(ws.framesOfType("armed")).toHaveLength(0);
	});

	it("setArmed no-ops the wire send when never connected (folding still flips)", () => {
		// No connectLive at all → module socket is null.
		setArmed(true);
		expect(folding.enabled).toBe(true);
		// Nothing to assert on a socket; the point is it does not throw and does not require a socket.
		expect(FakeWebSocket.last).toBeNull();
	});
});
