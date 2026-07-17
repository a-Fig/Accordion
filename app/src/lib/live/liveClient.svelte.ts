/*
 * liveClient.svelte.ts — the GUI side of the Phase B live link.
 *
 * The extension is now the AUTHORITY: it hosts the session's Truth. This client is a REPLICA +
 * remote control. It connects (as a WebSocket CLIENT), receives a `snapshot`, builds a rev-aligned
 * replica `AccordionStore` around a hydrated replica Truth, and then REPLAYS the serialized `event`
 * stream onto that replica (which drives the exact same reactive mirror the app already renders).
 * Human steering actions route to the wire as `command`s (via the store's command sink); there is
 * NO optimistic apply — the mirror moves only when the host's echoed events arrive (loopback echo
 * is sub-ms). A replayed event whose rev doesn't line up, or a `reset`, triggers a resnapshot.
 *
 * It drives the SAME `session.store` the rest of the UI renders, so "live mode" needs no new view.
 */
import { session, cancelPendingLoad } from "../session.svelte";
import { AccordionStore } from "../engine/store.svelte";
import { hydrateSnapshot } from "$core/replica";
import type { SessionMeta } from "$core/types";
import { folding } from "./folding.svelte";
import {
	DEFAULT_PORT,
	PROTOCOL_VERSION,
	isServerMessage,
	isWireBlock,
	type ServerMessage,
	type HelloMessage,
	type SnapshotState,
	type WireCommand,
} from "./protocol";
import { ghostStart, ghostEnd, ghostClearAll } from "./ghostState.svelte";

let socket: WebSocket | null = null;
let manualClose = false;
let commandSeq = 0;
// While true, incoming `event`s are dropped — a fresh `snapshot` is in flight (after a rev gap /
// reset), so replaying stale events onto the about-to-be-replaced replica is pointless.
let awaitingSnapshot = false;
// Session meta from `hello`, used to build the replica store when the snapshot arrives.
let pendingMeta: SessionMeta = { format: "pi", title: "live pi session", cwd: "", model: "" };

/** Fresh, all-zero hook telemetry — one connection's worth. */
function freshTelemetry() {
	return { lastHookMs: 0, maxHookMs: 0, p95HookMs: 0, rebuilds: 0, hookCount: 0 };
}

/**
 * Live connection status, for the UI. `telemetry` is the extension's `context`-hook duration
 * stream (Phase B replaced the plan-outcome tally): the latency badge reads `lastHookMs`, with
 * `maxHookMs` / `p95HookMs` / `rebuilds` in its tooltip. Reset on every new connection.
 */
export const live = $state<{
	status: "idle" | "connecting" | "connected" | "error";
	detail: string;
	sessionId: string | null;
	port: number | null;
	telemetry: { lastHookMs: number; maxHookMs: number; p95HookMs: number; rebuilds: number; hookCount: number };
}>({
	status: "idle",
	detail: "",
	sessionId: null,
	port: null,
	telemetry: freshTelemetry(),
});

/** Send a remote-control command to the host (guarded on socket state). */
function sendCommand(cmd: WireCommand): void {
	const ws = socket;
	if (!ws || ws.readyState !== WebSocket.OPEN) return;
	try {
		ws.send(JSON.stringify({ type: "command", seq: ++commandSeq, cmd }));
	} catch {
		/* socket gone — the next attach re-snapshots and re-syncs */
	}
}

/** Ask the host for a fresh snapshot (rev gap / reset recovery). Suppresses event replay until it lands. */
function requestResnapshot(): void {
	awaitingSnapshot = true;
	const ws = socket;
	if (!ws || ws.readyState !== WebSocket.OPEN) return;
	try {
		ws.send(JSON.stringify({ type: "resnapshot" }));
	} catch {
		/* socket gone */
	}
}

/**
 * Arm / disarm folding for the live session — the arm toggle. Sends a `setFolding` command; the
 * host flips its authoritative flag and echoes a `folding` message that updates `folding.enabled`
 * (no optimistic local flip — the display flag tracks the host's real arm). Named `setArmed` for
 * continuity with the header toggle.
 */
export function setArmed(on: boolean): void {
	sendCommand({ kind: "setFolding", value: on });
}

/** Build the replica store from a snapshot and install the command sink. */
function adoptSnapshot(state: SnapshotState): void {
	ghostClearAll();
	// Defense in depth (same caution the old sync path used): the WS is authenticated, but a
	// malformed frame must not feed NaN token accounting or throw mid-pump. Drop bad block elements
	// and default the array-shaped fields.
	const clean: SnapshotState = {
		...state,
		blocks: (Array.isArray(state.blocks) ? state.blocks : []).filter(isWireBlock),
		overlay: Array.isArray(state.overlay) ? state.overlay : [],
		groups: Array.isArray(state.groups) ? state.groups : [],
		locks: Array.isArray(state.locks) ? state.locks : [],
		birthFolded: Array.isArray(state.birthFolded) ? state.birthFolded : [],
	};
	const truth = hydrateSnapshot(pendingMeta, clean);
	const store = new AccordionStore({ meta: pendingMeta, blocks: [], lineCount: 0, skipped: 0 }, truth);
	store.setCommandSink(sendCommand);
	session.store = store;
	folding.enabled = !!state.foldingEnabled;
	awaitingSnapshot = false;
}

export function connectLive(port: number = DEFAULT_PORT, opts: { host?: string; token?: string } = {}): void {
	if (typeof window === "undefined" || typeof WebSocket === "undefined") return;
	cancelPendingLoad(); // invalidate any pending file/CC load that would otherwise clobber the live store
	disconnectLive(); // drop any prior socket
	manualClose = false;
	awaitingSnapshot = false;
	// Host defaults to loopback (the desktop app is co-located with pi). A browser-served page uses
	// its literal loopback hostname and forwards the bearer from its /accordion URL. The extension
	// also recognizes exact-origin cookies and verified sibling Accordion Origins.
	const host = opts.host ?? "127.0.0.1";
	const tokenQs = opts.token ? `/?token=${encodeURIComponent(opts.token)}` : "";
	live.status = "connecting";
	live.detail = `ws://${host}:${port}`;
	live.sessionId = null;
	live.port = port;
	live.telemetry = freshTelemetry();
	session.error = "";

	let ws: WebSocket;
	try {
		ws = new WebSocket(`ws://${host}:${port}${tokenQs}`);
	} catch (e) {
		live.status = "error";
		live.detail = e instanceof Error ? e.message : String(e);
		live.port = null;
		return;
	}
	socket = ws;

	ws.onmessage = (ev) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "");
		} catch {
			return;
		}
		if (!isServerMessage(parsed)) return; // ignore anything off-protocol
		const msg: ServerMessage = parsed;

		if (msg.type === "hello") {
			// Any accepted peer can still send malformed data (isServerMessage vets only the `type`
			// tag) — guard the nested shape rather than letting it throw mid-pump.
			const meta: Partial<HelloMessage["meta"]> = msg.meta && typeof msg.meta === "object" ? msg.meta : {};
			if (msg.protocolVersion !== PROTOCOL_VERSION) {
				live.status = "error";
				live.detail = `protocol mismatch - extension v${msg.protocolVersion}, app v${PROTOCOL_VERSION}; update both to the same version`;
				live.sessionId = null;
				try { ws.close(); } catch { /* ignore */ }
				return;
			}
			live.status = "connected";
			live.sessionId = typeof msg.sessionId === "string" ? msg.sessionId : null;
			session.error = "";
			session.filePath = null;
			// A live pi session is steerable, never a read-only recording. Reset here so the
			// READ-ONLY badge can never stick when attaching after viewing a Claude Code transcript.
			session.readOnly = false;
			pendingMeta = { format: "pi", title: meta.title || "live pi session", cwd: meta.cwd || "", model: meta.model || "" };
			// The store is built when the snapshot arrives (it carries the blocks + rev).
			awaitingSnapshot = false;
		} else if (msg.type === "snapshot") {
			if (!msg.state || typeof msg.state !== "object") return;
			adoptSnapshot(msg.state as SnapshotState);
		} else if (msg.type === "event") {
			if (awaitingSnapshot || !session.store) return; // a fresh snapshot is in flight → drop
			const ev2 = msg.event;
			if (!ev2 || typeof ev2 !== "object") return;
			// A `reset` is resnapshotted rather than replayed (sidesteps batched-transaction rev
			// ambiguity, and it is a rare, structural change). Everything else replays + gap-checks.
			if (ev2.kind === "reset") {
				requestResnapshot();
				return;
			}
			session.store.replayEvent(ev2);
			if (session.store.rev !== ev2.rev) requestResnapshot(); // diverged → resnapshot
		} else if (msg.type === "folding") {
			folding.enabled = !!msg.enabled;
		} else if (msg.type === "telemetry") {
			live.telemetry = {
				lastHookMs: msg.lastHookMs,
				maxHookMs: msg.maxHookMs,
				p95HookMs: msg.p95HookMs,
				rebuilds: msg.rebuilds,
				hookCount: msg.hookCount,
			};
		} else if (msg.type === "recall") {
			// The live agent read folded content (a pure host-side read, no state change). Surfaced
			// for conductors (Phase C); the GUI has nothing to mutate, so this is observational only.
		} else if (msg.type === "commandResult") {
			// No optimistic apply — state arrives via the event stream. Clamp UX could read `results`.
		} else if (msg.type === "stream") {
			// Ghost lifecycle — presentation only; ghosts NEVER enter session.store.blocks.
			if (msg.phase === "start") {
				ghostStart(msg.kind, msg.contentIndex);
			} else if (msg.phase === "end") {
				// Intentionally a NO-OP — a part finishing is not its resolution; the committed block
				// arrives at message_end (per-message commit). The ghost persists until the abort-sweep.
			} else if (msg.phase === "abort") {
				if (msg.contentIndex < 0) ghostClearAll();
				else ghostEnd(msg.contentIndex);
			}
		}
	};

	ws.onerror = () => {
		live.status = "error";
		live.detail = `could not reach pi on :${port} — is a pi session running with the accordion extension?`;
		live.sessionId = null;
		live.port = null;
	};

	ws.onclose = () => {
		ghostClearAll();
		// Only the ACTIVE socket may touch shared status. A superseded socket whose close fires
		// after connectLive() swapped in a new one must NOT clobber the new socket's state.
		if (socket === ws) {
			socket = null;
			awaitingSnapshot = false;
			live.sessionId = null;
			live.port = null;
			if (session.store) session.store.setCommandSink(null); // wire down → no remote control
			if (!manualClose && live.status !== "error") {
				live.status = "idle";
				live.detail = "disconnected";
			}
		}
	};
}

export function disconnectLive(): void {
	manualClose = true;
	awaitingSnapshot = false;
	ghostClearAll();
	if (session.store) session.store.setCommandSink(null);
	if (socket) {
		try {
			socket.close();
		} catch {
			/* ignore */
		}
		socket = null;
	}
	if (live.status !== "error") live.status = "idle";
	live.sessionId = null;
	live.port = null;
}
