/*
 * remote.test.ts — the out-of-process conductor SDK (`./remote`) against a REAL loopback WebSocket
 * server speaking exact v13 wire shapes.
 *
 * `ws` (the extension's runtime dependency) is not resolvable from this test file: `core/` has no
 * node_modules of its own, and vitest's module resolution walks up from `core/conductor/` — it
 * never reaches `extension/node_modules/ws` or `app/node_modules` (neither has `ws` either; empirically
 * confirmed before writing this file — importing "ws" here fails to resolve). So the harness below
 * hand-rolls the minimal RFC 6455 pieces it needs (the opening handshake + unmasked/masked framing)
 * directly over `node:http`, and drives `runRemoteConductor` with its DEFAULT `wsFactory` — Node
 * 22's built-in global `WebSocket` client, spec-compliant against any RFC 6455 server.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import type { Duplex } from "node:stream";
import { runRemoteConductor } from "./remote";
import type { Conductor, ConductorHost, HostEvent } from "./contract";
import type { Op, TxnResult } from "../ops";
import { PROTOCOL_VERSION } from "../protocol";
import type {
	HelloMessage,
	SnapshotState,
	SnapshotMessage,
	EventMessage,
	WireBlock,
	WireEvent,
	ProposeMessage,
	ProposeResultMessage,
	CompleteRequestMessage,
	CompleteResultMessage,
	WireDepartingMessage,
	TurnCommittedMessage,
	RecallObservationMessage,
	ResnapshotMessage,
	SetConductorStatusMessage,
	SessionMetaWire,
} from "../protocol";

// ── minimal RFC 6455 server (test-only; see the file banner above) ─────────────────────────────

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKey(key: string): string {
	return crypto.createHash("sha1").update(key + WS_MAGIC).digest("base64");
}

/** Encode ONE unmasked server→client text frame (server frames are never masked). */
function encodeFrame(text: string): Buffer {
	const payload = Buffer.from(text, "utf8");
	const len = payload.length;
	let header: Buffer;
	if (len < 126) {
		header = Buffer.from([0x81, len]);
	} else if (len < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x81;
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x81;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	return Buffer.concat([header, payload]);
}

/** Incremental client→server frame decoder (client frames are masked per RFC 6455). Calls
 *  `onText` for each complete text frame and `onClose` once a close frame arrives. */
function makeDecoder(onText: (text: string) => void, onClose: () => void): (chunk: Buffer) => void {
	let buf = Buffer.alloc(0);
	return (chunk: Buffer) => {
		buf = Buffer.concat([buf, chunk]);
		for (;;) {
			if (buf.length < 2) return;
			const b0 = buf[0];
			const b1 = buf[1];
			const opcode = b0 & 0x0f;
			const masked = (b1 & 0x80) !== 0;
			let len = b1 & 0x7f;
			let offset = 2;
			if (len === 126) {
				if (buf.length < offset + 2) return;
				len = buf.readUInt16BE(offset);
				offset += 2;
			} else if (len === 127) {
				if (buf.length < offset + 8) return;
				len = Number(buf.readBigUInt64BE(offset));
				offset += 8;
			}
			let maskKey: Buffer | null = null;
			if (masked) {
				if (buf.length < offset + 4) return;
				maskKey = buf.subarray(offset, offset + 4);
				offset += 4;
			}
			if (buf.length < offset + len) return;
			let payload = buf.subarray(offset, offset + len);
			if (masked && maskKey) {
				const unmasked = Buffer.alloc(len);
				for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
				payload = unmasked;
			}
			buf = buf.subarray(offset + len);
			if (opcode === 0x8) onClose();
			else if (opcode === 0x1) onText(payload.toString("utf8"));
			// ping/pong/binary: not needed by this harness.
		}
	};
}

/** A single-client loopback WS test server speaking exact v13 shapes. */
class TestWireServer {
	private server = http.createServer();
	private socket: Duplex | null = null;
	private inbox: unknown[] = [];
	private waiters: Array<(v: unknown) => void> = [];
	private resolveConnected!: () => void;
	readonly connected: Promise<void> = new Promise((res) => {
		this.resolveConnected = res;
	});
	readonly portReady: Promise<number>;

	constructor() {
		this.server.on("upgrade", (req, socket) => {
			this.socket = socket;
			const key = String(req.headers["sec-websocket-key"]);
			socket.write(
				"HTTP/1.1 101 Switching Protocols\r\n" +
					"Upgrade: websocket\r\n" +
					"Connection: Upgrade\r\n" +
					`Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
			);
			const feed = makeDecoder(
				(text) => {
					const parsed: unknown = JSON.parse(text);
					const waiter = this.waiters.shift();
					if (waiter) waiter(parsed);
					else this.inbox.push(parsed);
				},
				() => {
					try {
						socket.end();
					} catch {
						/* ignore */
					}
				},
			);
			socket.on("data", feed);
			this.resolveConnected();
		});
		this.portReady = new Promise((resolve) => {
			this.server.listen(0, "127.0.0.1", () => resolve((this.server.address() as { port: number }).port));
		});
	}

	send(msg: unknown): void {
		if (!this.socket) throw new Error("TestWireServer.send: no client connected yet");
		this.socket.write(encodeFrame(JSON.stringify(msg)));
	}

	/** Resolve with the next client→server message, queued FIFO if one already arrived. */
	next<T = unknown>(): Promise<T> {
		if (this.inbox.length) return Promise.resolve(this.inbox.shift() as T);
		return new Promise((resolve) => this.waiters.push(resolve as (v: unknown) => void));
	}

	/** True iff at least one client→server message is already queued (non-blocking peek). */
	hasPending(): boolean {
		return this.inbox.length > 0;
	}

	closeClient(): void {
		try {
			this.socket?.end();
		} catch {
			/* ignore */
		}
	}

	async teardown(): Promise<void> {
		this.closeClient();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

const META_WIRE: SessionMetaWire = { title: "t", cwd: "/tmp", model: "m", contextWindow: null, format: "pi" };

function helloMsg(overrides: Partial<HelloMessage> = {}): HelloMessage {
	return { type: "hello", protocolVersion: PROTOCOL_VERSION, role: "conductor", meta: META_WIRE, ...overrides };
}

function emptySnapshot(rev = 0): SnapshotState {
	return {
		blocks: [],
		overlay: [],
		groups: [],
		budget: 70_000,
		contextWindow: null,
		protectTokens: 20_000,
		locks: [],
		lockHolder: null,
		tailTokens: 0,
		sentThroughOrder: -1,
		wireAttached: true,
		foldingEnabled: false,
		birthFolded: [],
		rev,
	};
}

function wireBlock(id: string, order: number, tokens = 100): WireBlock {
	return { id, kind: "text", turn: order + 1, order, text: `text of ${id}`, tokens };
}

function snapshotMsg(state: SnapshotState): SnapshotMessage {
	return { type: "snapshot", state };
}

/** A scripted `Conductor`: captures the attached host + attach/detach counts, and lets each test
 *  supply its own `onEvent` reaction (used for the wire-departing hold-release scenarios). */
function makeStub(onEvent?: (e: HostEvent, host: ConductorHost) => void | Promise<void>) {
	let hostRef: ConductorHost | undefined;
	let attachCount = 0;
	let detachCount = 0;
	let resolveAttached!: (h: ConductorHost) => void;
	const attached = new Promise<ConductorHost>((res) => {
		resolveAttached = res;
	});
	const seen: HostEvent[] = [];
	const conductor: Conductor = {
		id: "stub",
		label: "Stub",
		attach(host) {
			attachCount++;
			hostRef = host;
			host.on((e) => {
				seen.push(e);
				return onEvent?.(e, host);
			});
			resolveAttached(host);
		},
		detach() {
			detachCount++;
		},
	};
	return {
		conductor,
		attached,
		seen,
		get host() {
			return hostRef;
		},
		get attachCount() {
			return attachCount;
		},
		get detachCount() {
			return detachCount;
		},
	};
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
		await delay(5);
	}
}

// ── tests ────────────────────────────────────────────────────────────────────────────────────

let activeServers: TestWireServer[] = [];
function newServer(): TestWireServer {
	const s = new TestWireServer();
	activeServers.push(s);
	return s;
}
afterEach(async () => {
	await Promise.all(activeServers.map((s) => s.teardown()));
	activeServers = [];
});

describe("runRemoteConductor — attach lifecycle", () => {
	it("attaches only after the FIRST snapshot, with a host whose stats()/blocks() match it", async () => {
		const server = newServer();
		const port = await server.portReady;
		const stub = makeStub();
		const run = runRemoteConductor(stub.conductor, { port, token: "tok" });
		await server.connected;
		server.send(helloMsg());

		// hello alone must not attach.
		await delay(30);
		expect(stub.attachCount).toBe(0);

		server.send(snapshotMsg({ ...emptySnapshot(0), blocks: [wireBlock("a:m1:p0", 0, 250)] }));
		const host = await stub.attached;
		expect(stub.attachCount).toBe(1);

		expect(host.stats().blockCount).toBe(1);
		expect(host.stats().rev).toBe(0);
		expect(host.stats().budget).toBe(70_000);
		const blocks = host.blocks();
		expect(blocks.length).toBe(1);
		expect(blocks[0].id).toBe("a:m1:p0");
		expect(blocks[0].tokens).toBe(250);
		expect(host.get("a:m1:p0")?.id).toBe("a:m1:p0");
		expect(host.get("missing")).toBeUndefined();
		expect(host.textOf("a:m1:p0")).toBe("text of a:m1:p0");

		server.closeClient();
		await run;
	});

	it("rejects loudly on a protocol/role mismatch — never attaches, never detaches", async () => {
		const server = newServer();
		const port = await server.portReady;
		const stub = makeStub();
		const run = runRemoteConductor(stub.conductor, { port, token: "tok" });
		await server.connected;
		server.send(helloMsg({ protocolVersion: PROTOCOL_VERSION + 1 }));

		await expect(run).rejects.toThrow(/protocol\/role mismatch/i);
		expect(stub.attachCount).toBe(0);
		expect(stub.detachCount).toBe(0);
	});

	it("rejects on a role mismatch even with a matching protocol version", async () => {
		const server = newServer();
		const port = await server.portReady;
		const stub = makeStub();
		const run = runRemoteConductor(stub.conductor, { port, token: "tok" });
		await server.connected;
		server.send(helloMsg({ role: "gui" }));

		await expect(run).rejects.toThrow(/protocol\/role mismatch/i);
		expect(stub.attachCount).toBe(0);
	});
});

async function attachedFixture(): Promise<{ server: TestWireServer; stub: ReturnType<typeof makeStub>; host: ConductorHost; run: Promise<void>; port: number }> {
	const server = newServer();
	const port = await server.portReady;
	const stub = makeStub();
	const run = runRemoteConductor(stub.conductor, { port, token: "tok" });
	await server.connected;
	server.send(helloMsg());
	server.send(snapshotMsg(emptySnapshot(0)));
	const host = await stub.attached;
	return { server, stub, host, run, port };
}

describe("runRemoteConductor — event replay", () => {
	it("replays an `appended` event onto the replica and dispatches a mapped blocks-appended HostEvent", async () => {
		const { server, stub, host, run } = await attachedFixture();

		const ev: WireEvent = { kind: "appended", blocks: [wireBlock("a:m2:p0", 0, 500)], rev: 1 };
		server.send({ type: "event", event: ev } satisfies EventMessage);

		await waitFor(() => stub.seen.some((e) => e.type === "blocks-appended"));
		const appended = stub.seen.find((e) => e.type === "blocks-appended");
		expect(appended && appended.type === "blocks-appended" && appended.blocks[0].id).toBe("a:m2:p0");
		expect(host.blocks().length).toBe(1);
		expect(host.get("a:m2:p0")?.tokens).toBe(500);
		expect(host.stats().rev).toBe(1);

		server.closeClient();
		await run;
	});
});

describe("runRemoteConductor — rev-gap recovery", () => {
	it("a rev mismatch triggers `resnapshot`; the next snapshot re-hydrates and dispatches resync", async () => {
		const { server, stub, host, run } = await attachedFixture();

		// The host claims rev 99 for an ordinary append the replica would only bump to rev 1 for —
		// a manufactured divergence.
		const ev: WireEvent = { kind: "appended", blocks: [wireBlock("a:gap:p0", 0, 100)], rev: 99 };
		server.send({ type: "event", event: ev } satisfies EventMessage);

		const resnap = await server.next<ResnapshotMessage>();
		expect(resnap.type).toBe("resnapshot");

		server.send(snapshotMsg({ ...emptySnapshot(99), blocks: [wireBlock("a:fresh:p0", 0, 42)] }));
		await waitFor(() => stub.seen.some((e) => e.type === "resync"));
		expect(host.stats().rev).toBe(99);
		expect(host.blocks().map((b) => b.id)).toEqual(["a:fresh:p0"]);

		server.closeClient();
		await run;
	});

	it("a `reset` event is resnapshotted rather than replayed (mirrors liveClient.svelte.ts)", async () => {
		const { server, host, run } = await attachedFixture();

		server.send({ type: "event", event: { kind: "reset", by: "you", rev: 7 } } satisfies EventMessage);
		const resnap = await server.next<ResnapshotMessage>();
		expect(resnap.type).toBe("resnapshot");

		server.send(snapshotMsg(emptySnapshot(7)));
		await waitFor(() => host.stats().rev === 7);

		server.closeClient();
		await run;
	});
});

describe("runRemoteConductor — propose round trip", () => {
	it("returns the host's proposeResult verbatim", async () => {
		const { server, host, run } = await attachedFixture();

		const ops: Op[] = [{ kind: "fold", ids: ["a:m1:p0"] }];
		const pending = host.propose({ baseRev: 0, ops });

		const wireMsg = await server.next<ProposeMessage>();
		expect(wireMsg.type).toBe("propose");
		expect(wireMsg.baseRev).toBe(0);
		expect(wireMsg.ops).toEqual(ops);

		const scripted: TxnResult = { rev: 1, results: [{ op: ops[0], applied: true }] };
		server.send({ type: "proposeResult", seq: wireMsg.seq, rev: scripted.rev, results: scripted.results } satisfies ProposeResultMessage);

		const result = await pending;
		expect(result).toEqual(scripted);

		server.closeClient();
		await run;
	});
});

describe("runRemoteConductor — completeRequest round trip", () => {
	it("resolves a successful completion", async () => {
		const { server, host, run } = await attachedFixture();

		const pending = host.complete({ prompt: "summarize this" });
		const wireMsg = await server.next<CompleteRequestMessage>();
		expect(wireMsg.type).toBe("completeRequest");
		expect(wireMsg.prompt).toBe("summarize this");

		server.send({
			type: "completeResult",
			reqId: wireMsg.reqId,
			ok: true,
			text: "a summary",
			model: "claude-x",
			inputTokens: 10,
			outputTokens: 5,
		} satisfies CompleteResultMessage);

		const result = await pending;
		expect(result).toEqual({ text: "a summary", model: "claude-x", inputTokens: 10, outputTokens: 5 });

		server.closeClient();
		await run;
	});

	it("maps a scripted error result to a rejected promise (the contract's failure shape)", async () => {
		const { server, host, run } = await attachedFixture();

		const pending = host.complete({ prompt: "will fail" });
		const wireMsg = await server.next<CompleteRequestMessage>();

		server.send({ type: "completeResult", reqId: wireMsg.reqId, ok: false, error: "model unavailable" } satisfies CompleteResultMessage);

		await expect(pending).rejects.toThrow(/model unavailable/);

		server.closeClient();
		await run;
	});
});

describe("runRemoteConductor — wireDeparting hold-release contract", () => {
	it("a handler that proposes during handling suppresses the automatic empty propose", async () => {
		const server = newServer();
		const port = await server.portReady;
		let proposeCount = 0;
		const stub = makeStub(async (e, host) => {
			if (e.type !== "wire-departing") return;
			const p = host.propose({ baseRev: e.rev, ops: [{ kind: "fold", ids: ["x"] }] });
			// Let the propose reach the wire before the handler resolves (still counts as "during
			// handling" — the flag is set the instant `propose` is INVOKED, not when it settles).
			await delay(10);
			void p;
		});
		const run = runRemoteConductor(stub.conductor, { port, token: "tok" });
		await server.connected;
		server.send(helloMsg());
		server.send(snapshotMsg(emptySnapshot(0)));
		await stub.attached;

		server.send({ type: "wireDeparting", rev: 0, liveTokens: 10, budget: 70_000, freshIds: [], holdMs: 200 } satisfies WireDepartingMessage);

		// Count every propose the server receives for a settling window, then assert exactly one —
		// the handler's own real propose, never a second automatic empty one.
		const seenProposes: ProposeMessage[] = [];
		const collect = async () => {
			for (;;) {
				const msg = await server.next<ProposeMessage>();
				seenProposes.push(msg);
				proposeCount++;
				server.send({ type: "proposeResult", seq: msg.seq, rev: msg.baseRev + 1, results: [{ op: msg.ops[0] ?? { kind: "resetAll" }, applied: true }] } satisfies ProposeResultMessage);
			}
		};
		void collect();
		await delay(80);
		expect(proposeCount).toBe(1);
		expect(seenProposes[0].ops.length).toBe(1);

		server.closeClient();
		await run;
	});

	it("a handler that never proposes gets exactly one automatic empty propose after it settles", async () => {
		const server = newServer();
		const port = await server.portReady;
		const stub = makeStub((e) => {
			void e; // does nothing — no propose call
		});
		const run = runRemoteConductor(stub.conductor, { port, token: "tok" });
		await server.connected;
		server.send(helloMsg());
		server.send(snapshotMsg(emptySnapshot(0)));
		await stub.attached;

		server.send({ type: "wireDeparting", rev: 3, liveTokens: 10, budget: 70_000, freshIds: [], holdMs: 200 } satisfies WireDepartingMessage);

		const msg = await server.next<ProposeMessage>();
		expect(msg.type).toBe("propose");
		expect(msg.baseRev).toBe(3);
		expect(msg.ops).toEqual([]);

		server.closeClient();
		await run;
	});

	it("an async handler's release is deferred until it actually settles", async () => {
		const server = newServer();
		const port = await server.portReady;
		let settleHandler!: () => void;
		const handlerSettles = new Promise<void>((res) => {
			settleHandler = res;
		});
		const stub = makeStub(async (e) => {
			if (e.type !== "wire-departing") return;
			await handlerSettles; // held open until the test releases it
		});
		const run = runRemoteConductor(stub.conductor, { port, token: "tok" });
		await server.connected;
		server.send(helloMsg());
		server.send(snapshotMsg(emptySnapshot(0)));
		await stub.attached;

		server.send({ type: "wireDeparting", rev: 5, liveTokens: 10, budget: 70_000, freshIds: [], holdMs: 200 } satisfies WireDepartingMessage);

		// Before the handler settles, no propose (empty or otherwise) should have been sent yet.
		await delay(40);
		expect(server.hasPending()).toBe(false);

		settleHandler();
		const msg = await server.next<ProposeMessage>();
		expect(msg.ops).toEqual([]);
		expect(msg.baseRev).toBe(5);

		server.closeClient();
		await run;
	});
});

describe("runRemoteConductor — turn-committed and recall", () => {
	it("dispatches a turn-committed HostEvent verbatim", async () => {
		const { server, stub, run } = await attachedFixture();
		server.send({ type: "turnCommitted", turn: 4, rev: 0 } satisfies TurnCommittedMessage);
		await waitFor(() => stub.seen.some((e) => e.type === "turn-committed"));
		const e = stub.seen.find((e) => e.type === "turn-committed");
		expect(e).toEqual({ type: "turn-committed", turn: 4, rev: 0 });
		server.closeClient();
		await run;
	});

	it("dispatches a recall observation as a state-changed HostEvent stamped with the replica's current rev", async () => {
		const { server, stub, run } = await attachedFixture();
		server.send({ type: "recall", ids: ["a:m1:p0"], by: "agent" } satisfies RecallObservationMessage);
		await waitFor(() => stub.seen.some((e) => e.type === "state-changed"));
		const e = stub.seen.find((e) => e.type === "state-changed");
		expect(e).toEqual({ type: "state-changed", changes: [{ id: "a:m1:p0", what: "recall", by: "agent" }], rev: 0 });
		server.closeClient();
		await run;
	});
});

describe("runRemoteConductor — setStatus is fire-and-forget", () => {
	it("sends setConductorStatus without waiting for a reply", async () => {
		const { server, host, run } = await attachedFixture();
		host.setStatus("scanning…", { pass: 1 });
		const msg = await server.next<SetConductorStatusMessage>();
		expect(msg).toEqual({ type: "setConductorStatus", text: "scanning…", metrics: { pass: 1 } });
		server.closeClient();
		await run;
	});
});

describe("runRemoteConductor — teardown", () => {
	it("a server-initiated close detaches exactly once and resolves cleanly", async () => {
		const { server, stub, run } = await attachedFixture();
		server.closeClient();
		await run;
		expect(stub.detachCount).toBe(1);
	});

	it("an aborted signal closes the socket and detaches exactly once", async () => {
		const server = newServer();
		const port = await server.portReady;
		const stub = makeStub();
		const controller = new AbortController();
		const run = runRemoteConductor(stub.conductor, { port, token: "tok", signal: controller.signal });
		await server.connected;
		server.send(helloMsg());
		server.send(snapshotMsg(emptySnapshot(0)));
		await stub.attached;

		controller.abort();
		await run;
		expect(stub.detachCount).toBe(1);
	});
});
