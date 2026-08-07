import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { connectLive, disconnectLive, setArmed, live, conductors, conductorState, conductorStatus, selectConductor, mySurfaceId } from "./liveClient.svelte";
import { _resetSurfaceIdForTests } from "./surfaceId";
import { notice } from "./notice.svelte";
import { folding } from "./folding.svelte";
import { session } from "../session.svelte";
import { AccordionStore } from "../engine/store.svelte";
import { PROTOCOL_VERSION, type SnapshotState, type WireEvent, type ActiveConductorMeta } from "$core/protocol";

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

function helloFrame(over: { conductors?: ActiveConductorMeta[] } = {}) {
	return {
		type: "hello",
		protocolVersion: PROTOCOL_VERSION,
		sessionId: "s-test",
		role: "gui",
		meta: { title: "t", cwd: "/tmp", model: "m", contextWindow: 1000, format: "pi" },
		...over,
	};
}

function conductorMeta(over: Partial<ActiveConductorMeta> = {}): ActiveConductorMeta {
	return {
		id: "cond-a",
		label: "Conductor A",
		locks: [],
		tailTokens: 4000,
		holdWireUpToMs: 50,
		remote: false,
		...over,
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
		ws.emit({
			type: "telemetry",
			lastHookMs: 3,
			maxHookMs: 12,
			p95HookMs: 7,
			rebuilds: 1,
			hookCount: 42,
			lastHoldMs: 2,
			holdTimeouts: 0,
			realTokens: 5150,
			estWireTokens: 5000,
		});
		expect(live.telemetry).toEqual({
			lastHookMs: 3,
			maxHookMs: 12,
			p95HookMs: 7,
			rebuilds: 1,
			hookCount: 42,
			lastHoldMs: 2,
			holdTimeouts: 0,
			realTokens: 5150,
			estWireTokens: 5000,
		});
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

describe("liveClient — conductor catalog + state (Phase C, v13)", () => {
	it("captures the conductor catalog from hello", () => {
		connectLive(1234);
		const ws = FakeWebSocket.last!;
		ws.open();
		const meta = conductorMeta({ id: "cond-a", label: "Conductor A" });
		ws.emit(helloFrame({ conductors: [meta] }));
		expect(conductors).toEqual([meta]);
	});

	it("defaults to an empty catalog when hello omits conductors", () => {
		connectHelloSnapshot();
		expect(conductors).toEqual([]);
	});

	it("drops malformed catalog entries instead of throwing", () => {
		connectLive(1234);
		const ws = FakeWebSocket.last!;
		ws.open();
		const good = conductorMeta({ id: "cond-good" });
		expect(() =>
			ws.emit(helloFrame({ conductors: [good, { id: "cond-bad" } as unknown as ActiveConductorMeta, null as unknown as ActiveConductorMeta] })),
		).not.toThrow();
		expect(conductors).toEqual([good]);
	});

	it("applies a conductorState broadcast", () => {
		const ws = connectHelloSnapshot();
		const meta = conductorMeta({ id: "cond-a" });
		ws.emit({ type: "conductorState", active: meta });
		expect(conductorState.active).toEqual(meta);
		ws.emit({ type: "conductorState", active: null });
		expect(conductorState.active).toBeNull();
	});

	it("applies a conductorStatus broadcast, including a clearing null text", () => {
		const ws = connectHelloSnapshot();
		ws.emit({ type: "conductorStatus", text: "scoring turn 12", metrics: { score: 0.5 } });
		expect(conductorStatus.text).toBe("scoring turn 12");
		expect(conductorStatus.metrics).toEqual({ score: 0.5 });
		ws.emit({ type: "conductorStatus", text: null });
		expect(conductorStatus.text).toBeNull();
	});

	it("selectConductor sends a selectConductor command with a fresh seq", () => {
		const ws = connectHelloSnapshot();
		ws.sent.length = 0;
		selectConductor("cond-a");
		selectConductor(null);
		const cmds = ws.framesOfType("command");
		expect(cmds).toHaveLength(2);
		expect(cmds[0].cmd).toEqual({ kind: "selectConductor", id: "cond-a" });
		expect(cmds[1].cmd).toEqual({ kind: "selectConductor", id: null });
		expect(cmds[1].seq).toBeGreaterThan(cmds[0].seq);
	});

	it("resets the catalog/active/status state on disconnect", () => {
		connectLive(1234);
		const ws = FakeWebSocket.last!;
		ws.open();
		ws.emit(helloFrame({ conductors: [conductorMeta()] }));
		ws.emit({ type: "snapshot", state: snapshotState() });
		ws.emit({ type: "conductorState", active: conductorMeta() });
		ws.emit({ type: "conductorStatus", text: "working" });
		expect(conductors.length).toBe(1);
		expect(conductorState.active).not.toBeNull();
		expect(conductorStatus.text).toBe("working");

		disconnectLive();

		expect(conductors).toEqual([]);
		expect(conductorState.active).toBeNull();
		expect(conductorStatus.text).toBeNull();
		expect(conductorStatus.metrics).toBeUndefined();
	});
});

describe("liveClient — generic notice broadcast (v17)", () => {
	it("shows the notice toast with the broadcast text", () => {
		const ws = connectHelloSnapshot();
		notice.show = false;
		ws.emit({ type: "notice", text: "pi compacted the session natively — Accordion's map has been rebuilt to match." });
		expect(notice.show).toBe(true);
		expect(notice.text).toBe("pi compacted the session natively — Accordion's map has been rebuilt to match.");
	});

	it("ignores a malformed notice (non-string/empty text) instead of throwing", () => {
		const ws = connectHelloSnapshot();
		notice.show = false;
		expect(() => ws.emit({ type: "notice", text: 42 as unknown as string })).not.toThrow();
		expect(notice.show).toBe(false);
		expect(() => ws.emit({ type: "notice", text: "" })).not.toThrow();
		expect(notice.show).toBe(false);
	});

	it("resets the notice toast on disconnect", () => {
		const ws = connectHelloSnapshot();
		ws.emit({ type: "notice", text: "something happened" });
		expect(notice.show).toBe(true);
		disconnectLive();
		expect(notice.show).toBe(false);
	});
});

describe("liveClient — read-only badge on wire loss (P3: an orphaned replica must not stay silently mutable)", () => {
	it("badges the session read-only when the socket dies out from under an established replica", () => {
		const ws = connectHelloSnapshot();
		expect(session.readOnly).toBe(false);

		ws.close(); // socket death, not a manual disconnect
		expect(session.readOnly).toBe(true);
		expect(session.store!.wireControlled).toBe(false); // command sink nulled too
	});

	it("badges the session read-only on a manual disconnect too", () => {
		connectHelloSnapshot();
		expect(session.readOnly).toBe(false);

		disconnectLive();
		expect(session.readOnly).toBe(true);
	});

	it("clears the read-only badge on the next hello (reconnect)", () => {
		const ws = connectHelloSnapshot();
		ws.close();
		expect(session.readOnly).toBe(true);

		connectLive(1234);
		const ws2 = FakeWebSocket.last!;
		ws2.open();
		ws2.emit(helloFrame());
		expect(session.readOnly).toBe(false);
	});

	it("does not mislabel an unrelated (never wire-controlled) session on a failed connect attempt", () => {
		// A CC/file/demo session sitting in session.store when a live connect is attempted and
		// then fails before ever reaching snapshot: this store was never wireControlled, so its
		// read-only-ness must be left exactly as it was — a failed dial elsewhere shouldn't badge
		// an unrelated session.
		session.store = new AccordionStore({ meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks: [], lineCount: 0, skipped: 0 });
		session.readOnly = false;

		connectLive(1234);
		const ws = FakeWebSocket.last!;
		ws.open();
		ws.close(); // dies before hello/snapshot ever arrive

		expect(session.readOnly).toBe(false);
	});
});

describe("liveClient — deferred first dial while the surface-id dedupe window is open (F1, ADR 0024 §5)", () => {
	// The auto-connect ordering end-to-end at the connectLive level: onMount → connectLive is the
	// FIRST entry into surfaceId.ts, so the dedupe window is still open at dial time. connectLive
	// must HOLD the dial through the window (no socket yet), let an in-use reply re-mint the copied
	// id, and only then open the socket — carrying the RE-MINTED id on `?surface=`. Freezing the id
	// in the same synchronous frame as init (the pre-fix behavior) put the copied id on the wire.
	class TestBC {
		static last: TestBC | null = null;
		onmessage: ((ev: { data: unknown }) => void) | null = null;
		constructor(public name: string) {
			TestBC.last = this;
		}
		postMessage(_m: unknown): void {}
		close(): void {}
		deliver(m: unknown): void {
			this.onmessage?.({ data: m });
		}
	}
	function storageWith(seed: Record<string, string>): Storage {
		const m = new Map<string, string>(Object.entries(seed));
		return {
			getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
			setItem: (k: string, v: string) => void m.set(k, v),
			removeItem: (k: string) => void m.delete(k),
			clear: () => m.clear(),
			key: () => null,
			get length() {
				return m.size;
			},
		} as Storage;
	}

	let savedBC: unknown;
	let hadBC: boolean;

	beforeEach(() => {
		hadBC = "BroadcastChannel" in globalThis;
		savedBC = (globalThis as any).BroadcastChannel;
		(globalThis as any).BroadcastChannel = TestBC;
		TestBC.last = null;
		_resetSurfaceIdForTests();
	});

	afterEach(() => {
		vi.useRealTimers();
		if (hadBC) (globalThis as any).BroadcastChannel = savedBC;
		else delete (globalThis as any).BroadcastChannel;
		_resetSurfaceIdForTests();
	});

	it("holds the dial through the window; an in-use reply re-mints the id BEFORE it rides the wire", async () => {
		vi.useFakeTimers();
		(globalThis as any).window = { sessionStorage: storageWith({ accordion_surface_id: "copied-id" }) };

		connectLive(1234); // same frame as the module's first init — the auto-connect ordering
		expect(FakeWebSocket.last).toBeNull(); // dial HELD — no socket while the window is open
		expect(live.status).toBe("connecting"); // but the UI already shows the connect intent

		// The original tab (owner of "copied-id") replies a few ms later, inside the held window.
		TestBC.last!.deliver({ kind: "in-use", id: "copied-id", nonce: "original-tab" });
		await vi.advanceTimersByTimeAsync(300); // window elapses → deferred dial re-enters

		const ws = FakeWebSocket.last!;
		expect(ws).not.toBeNull(); // the socket opened only after the window settled
		const surface = new URL(ws.url).searchParams.get("surface");
		expect(surface).not.toBe("copied-id"); // the wire carries the RE-MINTED id
		expect(surface).toBe(mySurfaceId()); // and it matches this surface's settled identity
	});

	it("a disconnect during the held window aborts the deferred dial (no zombie socket)", async () => {
		vi.useFakeTimers();
		(globalThis as any).window = { sessionStorage: storageWith({ accordion_surface_id: "some-id" }) };

		connectLive(1234);
		expect(FakeWebSocket.last).toBeNull(); // held
		disconnectLive(); // user navigates away / closes the session during the ≤150ms hold
		await vi.advanceTimersByTimeAsync(300);

		expect(FakeWebSocket.last).toBeNull(); // the superseded deferred dial never opened a socket
	});
});
