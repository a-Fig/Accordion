/*
 * liveClient.svelte.ts — the GUI side of the live pi link.
 *
 * Connects (as a WebSocket CLIENT) to the pi extension's server, builds a live
 * AccordionStore from the streamed context, and answers each `sync` with a fold
 * plan. In Milestone 1 the plan is always empty (`ops: []`) — the loop is proven
 * end-to-end while never altering a model call.
 *
 * It drives the SAME `session` object the rest of the UI already renders, so
 * "live mode" needs no new view: populating `session.store` is enough.
 */
import { session } from "../session.svelte";
import { AccordionStore } from "../engine/store.svelte";
import { wireToBlock } from "./mapping";
import { DEFAULT_PORT, PROTOCOL_VERSION, isServerMessage, type ServerMessage, type PlanMessage, type FoldOp } from "./protocol";
import { ghostStart, ghostEnd, ghostClearAll } from "./ghostState.svelte";

let socket: WebSocket | null = null;
let manualClose = false;

/** Live connection status, for the UI. */
export const live = $state<{ status: "idle" | "connecting" | "connected" | "error"; detail: string }>({
	status: "idle",
	detail: "",
});

/**
 * The fold plan the GUI returns for a sync. Milestone 1: fold nothing. Milestone 2
 * reads the live store's auto-fold decisions and emits one op per folded block,
 * carrying the digest text (computed GUI-side via engine/digest).
 */
function computePlan(): FoldOp[] {
	return [];
}

export function connectLive(port: number = DEFAULT_PORT): void {
	if (typeof window === "undefined" || typeof WebSocket === "undefined") return;
	disconnectLive(); // drop any prior socket
	manualClose = false;
	live.status = "connecting";
	live.detail = `ws://127.0.0.1:${port}`;
	session.error = "";

	let ws: WebSocket;
	try {
		ws = new WebSocket(`ws://127.0.0.1:${port}`);
	} catch (e) {
		live.status = "error";
		live.detail = e instanceof Error ? e.message : String(e);
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
				if (msg.protocolVersion !== PROTOCOL_VERSION) {
					// Refuse a version mismatch loudly rather than driving the session with a wire
					// shape one side does not understand (in M2 that would silently corrupt the fold
					// ops / digests applied to the model context).
					live.status = "error";
					live.detail = `protocol mismatch - extension v${msg.protocolVersion}, app v${PROTOCOL_VERSION}; update both to the same version`;
					try { ws.close(); } catch { /* ignore */ }
					return;
				}
			live.status = "connected";
			session.error = "";
			session.live = true;
			session.filePath = null;
			// Structural reset: clear all ghosts — no ghost survives a session reconnect.
			ghostClearAll();
			session.store = new AccordionStore({
				meta: { format: "pi", title: msg.meta.title || "live pi session", cwd: msg.meta.cwd || "", model: msg.meta.model || "" },
				blocks: [],
				lineCount: 0,
				skipped: 0,
			});
		} else if (msg.type === "sync") {
			if (!session.store) return;
			if (msg.full) {
				// structural reset — rebuild from scratch; clear all ghosts.
				ghostClearAll();
				session.store = new AccordionStore({
					meta: session.store.meta,
					blocks: [],
					lineCount: 0,
					skipped: 0,
				});
			}
			// Committed blocks arrive HERE (the appendBlocks path), NEVER from ghost state.
			// Invariant: a ghost is only removed, never converted to a block.
			session.store.appendBlocks(msg.blocks.map(wireToBlock));
			const reply: PlanMessage = { type: "plan", reqId: msg.reqId, ops: computePlan() };
			try {
				ws.send(JSON.stringify(reply));
			} catch {
				/* socket gone — extension will time out and pass through */
			}
		} else if (msg.type === "stream") {
			// Ghost lifecycle — presentation only; ghosts NEVER enter session.store.blocks.
			if (msg.phase === "start") {
				ghostStart(msg.kind, msg.contentIndex);
			} else if (msg.phase === "end") {
				// Intentionally a NO-OP. A part finishing is NOT the resolution point: its
				// committed block only arrives at `message_end` (commit is per-message, not
				// per-part — ADR 0003 §3). If we cleared the ghost here, a non-final part
				// (e.g. thinking before a long text) would show NOTHING at the live edge for
				// the rest of the message — a visible blank. So the ghost persists until the
				// `message_end` abort-sweep, which fires in the SAME tick as the committed-
				// block sync → seamless hand-off, no gap. (`end` frames are still sent: they
				// mark the part lifecycle and enable a future per-part commit if desired.)
			} else if (msg.phase === "abort") {
				if (msg.contentIndex < 0) {
					// Sweep: clear all ghosts. The normal resolver (message_end/agent_end
					// sweep) AND the abnormal one (stream error/aborted — no block is coming,
					// so the ghost must vanish per invariant #3).
					ghostClearAll();
				} else {
					// Targeted abort for a specific part.
					ghostEnd(msg.contentIndex);
				}
			}
		}
	};

	ws.onerror = () => {
		live.status = "error";
		live.detail = `could not reach pi on :${port} — is a pi session running with the accordion extension?`;
	};

	ws.onclose = () => {
		session.live = false;
		// Guaranteed teardown (invariant #2): on disconnect, all ghosts vanish with the
		// GUI state. A ghost cannot outlive the WS connection that spawned it.
		ghostClearAll();
		// Only the ACTIVE socket may touch shared status. A superseded socket - a prior
			// connection whose close fires asynchronously after connectLive() already swapped
			// in a new one and reset manualClose - must NOT run this block, or it clobbers the
			// new socket's connecting/connected state back to idle.
			if (socket === ws) {
				socket = null;
				if (!manualClose && live.status !== "error") {
					live.status = "idle";
					live.detail = "disconnected";
				}
			}
	};
}

export function disconnectLive(): void {
	manualClose = true;
	session.live = false;
	// Guaranteed teardown (invariant #2): explicit disconnect clears all ghosts
	// immediately, before the socket close fires.
	ghostClearAll();
	if (socket) {
		try {
			socket.close();
		} catch {
			/* ignore */
		}
		socket = null;
	}
	if (live.status !== "error") live.status = "idle";
}

/** Reserved for M2: kept so the import graph and protocol version are referenced. */
export const CLIENT_PROTOCOL_VERSION = PROTOCOL_VERSION;
