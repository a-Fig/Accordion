import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { connectLive, disconnectLive, setArmed, live } from "./liveClient.svelte";
import { folding } from "./folding.svelte";
import { session } from "../session.svelte";
import { PROTOCOL_VERSION } from "./protocol";
import type { Conductor, ConductorView, Command } from "$conductors/contract";

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

/*
 * passthrough-ack handling (issue #60, ADR 0020). The extension acks every `context` hook
 * outcome as a `passthrough` message; the live client (1) tallies `live.planOutcomes` for the
 * "wire N/M" readout and (2) reconciles birth-fold bookkeeping when the ack reveals the GUI's
 * own fresh plan did NOT ride the wire (`timeout-stale`/`timeout-raw`). Driven end-to-end
 * through the FakeWebSocket harness (this file's existing pattern) rather than the store alone
 * — the reconciliation GUARD (last-answered reqId, epoch-mismatch exemption) lives entirely in
 * liveClient.svelte.ts, so a store-only test would miss it. The deeper mechanics of WHY dropping
 * the exemption matters (a block un-refoldable once "protected") are covered end-to-end through
 * the real store in store.birthfold.test.ts (case (n)).
 */
describe("liveClient — passthrough ack handling (issue #60)", () => {
	/** A minimal PLANNED sync — enough for the client to append a block, reply with a plan,
	 *  and record `reqId` as the last-answered planned sync. */
	function plannedSyncFrame(reqId: number) {
		return {
			type: "sync",
			reqId,
			full: false,
			blocks: [{ id: `u:${reqId}`, kind: "user", turn: 1, order: 0, text: "hi", tokens: 10 }],
			contextWindow: 1000,
			planned: true,
		};
	}

	it("tallies planOutcomes counters per cause and a running total", () => {
		connectAndHello();
		const ws = FakeWebSocket.last!;
		expect(live.planOutcomes.total).toBe(0);

		ws.emit({ type: "passthrough", reqId: 1, cause: "applied", ops: 2, groups: 0, recalls: 0 });
		ws.emit({ type: "passthrough", reqId: 2, cause: "empty-plan", ops: 0, groups: 0, recalls: 0 });
		ws.emit({ type: "passthrough", reqId: 3, cause: "timeout-stale", ops: 1, groups: 0, recalls: 0 });
		ws.emit({ type: "passthrough", reqId: 4, cause: "timeout-raw", ops: 0, groups: 0, recalls: 0 });
		ws.emit({ type: "passthrough", reqId: 5, cause: "epoch-mismatch", ops: 0, groups: 0, recalls: 0 });

		expect(live.planOutcomes).toEqual({
			applied: 1,
			"empty-plan": 1,
			"timeout-stale": 1,
			"timeout-raw": 1,
			"epoch-mismatch": 1,
			total: 5,
		});
	});

	it("resets planOutcomes to zero on a fresh connection", () => {
		connectAndHello();
		FakeWebSocket.last!.emit({ type: "passthrough", reqId: 1, cause: "applied", ops: 0, groups: 0, recalls: 0 });
		expect(live.planOutcomes.total).toBe(1);

		connectAndHello(); // fresh connect — connectLive() drops the prior socket first
		expect(live.planOutcomes.total).toBe(0);
	});

	it("a timeout-stale ack for the last-answered planned reqId reconciles via markSent({rawWire:true})", () => {
		connectAndHello();
		const ws = FakeWebSocket.last!;
		expect(session.store).not.toBeNull();
		const spy = vi.spyOn(session.store!, "markSent");

		ws.emit(plannedSyncFrame(7)); // client replies, sets lastPlannedReqId=7, calls markSent() once
		spy.mockClear(); // drop that call — assert only the ack-triggered one below

		ws.emit({ type: "passthrough", reqId: 7, cause: "timeout-stale", ops: 0, groups: 0, recalls: 0 });
		expect(spy).toHaveBeenCalledWith({ rawWire: true });
	});

	it("a timeout-raw ack for the last-answered planned reqId ALSO reconciles", () => {
		connectAndHello();
		const ws = FakeWebSocket.last!;
		const spy = vi.spyOn(session.store!, "markSent");

		ws.emit(plannedSyncFrame(9));
		spy.mockClear();

		ws.emit({ type: "passthrough", reqId: 9, cause: "timeout-raw", ops: 0, groups: 0, recalls: 0 });
		expect(spy).toHaveBeenCalledWith({ rawWire: true });
	});

	it("an epoch-mismatch ack is counted but never triggers reconciliation (superseded view)", () => {
		connectAndHello();
		const ws = FakeWebSocket.last!;
		const spy = vi.spyOn(session.store!, "markSent");

		ws.emit(plannedSyncFrame(11));
		spy.mockClear();

		ws.emit({ type: "passthrough", reqId: 11, cause: "epoch-mismatch", ops: 0, groups: 0, recalls: 0 });
		expect(spy).not.toHaveBeenCalled();
		expect(live.planOutcomes["epoch-mismatch"]).toBe(1);
	});

	it("an ack for an unknown/older reqId (not the last-answered one) is ignored for reconciliation", () => {
		connectAndHello();
		const ws = FakeWebSocket.last!;
		const spy = vi.spyOn(session.store!, "markSent");

		ws.emit(plannedSyncFrame(20));
		spy.mockClear();

		// A stale ack for an OLDER reqId than the one this client last answered.
		ws.emit({ type: "passthrough", reqId: 19, cause: "timeout-stale", ops: 0, groups: 0, recalls: 0 });
		expect(spy).not.toHaveBeenCalled();
		// The counter still counts it — only reconciliation is gated on the reqId match.
		expect(live.planOutcomes["timeout-stale"]).toBe(1);
	});

	it("an applied/empty-plan ack never forces a redundant rawWire markSent call", () => {
		connectAndHello();
		const ws = FakeWebSocket.last!;
		const spy = vi.spyOn(session.store!, "markSent");

		ws.emit(plannedSyncFrame(30));
		spy.mockClear();

		ws.emit({ type: "passthrough", reqId: 30, cause: "applied", ops: 1, groups: 0, recalls: 0 });
		ws.emit({ type: "passthrough", reqId: 30, cause: "empty-plan", ops: 0, groups: 0, recalls: 0 });
		expect(spy).not.toHaveBeenCalled();
	});

	/**
	 * The whole reconciliation scheme rests on FIFO wire ordering: the extension sends the
	 * `passthrough` ack for reqId N strictly AFTER the planned sync it answers and strictly
	 * BEFORE the next sync — so reconciliation can never race a block that arrives later. If
	 * that ordering were violated (ack processed after newer blocks already landed), `markSent`'s
	 * `Math.max` against the store's then-current last block would advance `sentThroughOrder`
	 * past those newer blocks too, wrongly marking a never-sent block as already sent (it would
	 * read `fresh:false` and lose birth-fold eligibility, see store.svelte.ts `isFresh`/
	 * `birthFoldEligible`, ADR 0018/#43).
	 *
	 * `sentThroughOrder`/`birthFolded` are private to `AccordionStore`, so this asserts the
	 * sharpest available public equivalent: attach a stub conductor (same pattern as
	 * store.birthfold.test.ts) purely to observe `ConductorView.fresh` — a block the store still
	 * considers un-sent reads `fresh:true` regardless of protection or fold state.
	 */
	it("a passthrough ack for reqId N does not swallow a block that arrives in a LATER sync (FIFO ordering)", () => {
		connectAndHello();
		const ws = FakeWebSocket.last!;
		expect(session.store).not.toBeNull();

		class StubConductor implements Conductor {
			readonly id = "stub";
			readonly label = "Stub";
			lastView: ConductorView | null = null;
			conduct(view: ConductorView): Command[] | null {
				this.lastView = view;
				return []; // no fold decisions — this conductor exists only to capture the view
			}
		}
		const conductor = new StubConductor();
		session.store!.attach(conductor);

		// (a) planned sync reqId=5 — client replies, sets lastPlannedReqId=5, and (folding
		// disarmed by default in this suite) optimistically calls markSent({rawWire:true}).
		ws.emit(plannedSyncFrame(5));

		// (b) the extension's passthrough ack for that SAME reqId — reconciliation fires and
		// calls markSent({rawWire:true}) again (idempotent).
		ws.emit({ type: "passthrough", reqId: 5, cause: "timeout-raw", ops: 0, groups: 0, recalls: 0 });

		// (c) a VIEW-ONLY sync (no `planned`) carrying a brand-new block, arriving strictly
		// AFTER the reconciliation above.
		ws.emit({
			type: "sync",
			reqId: 6,
			full: false,
			blocks: [{ id: "u:6", kind: "user", turn: 2, order: 1, text: "later", tokens: 5 }],
			contextWindow: 1000,
			planned: false,
		});

		const newBlock = conductor.lastView!.blocks.find((b) => b.id === "u:6");
		expect(newBlock).toBeDefined();
		expect(newBlock!.fresh).toBe(true); // never marked sent — FIFO ordering preserved
	});
});
