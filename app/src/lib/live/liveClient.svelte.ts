/*
 * liveClient.svelte.ts — the GUI side of the live pi link.
 *
 * Connects (as a WebSocket CLIENT) to the pi extension's server, builds a live
 * AccordionStore from the streamed context, and answers each `sync` with a fold
 * plan. The plan is empty unless the user has armed folding (`folding.enabled`);
 * armed, it mirrors the engine's fold decisions into provider-safe ops (see
 * `computePlan` / `plan.ts`). Disarmed, no model call is ever altered.
 *
 * It drives the SAME `session` object the rest of the UI already renders, so
 * "live mode" needs no new view: populating `session.store` is enough.
 */
import { session, cancelPendingLoad } from "../session.svelte";
import { AccordionStore } from "../engine/store.svelte";
import { wireToBlock } from "./mapping";
import { computeFoldOps, computeGroupOps, resolveUnfold, resolveRecall } from "./plan";
import { folding, setFolding } from "./folding.svelte";
import { DEFAULT_PORT, PROTOCOL_VERSION, isServerMessage, isWireBlock, type ServerMessage, type HelloMessage, type PlanMessage, type FoldOp, type GroupOp, type UnfoldResultMessage, type RecallResultMessage, type ArmedMessage, type PassthroughCause } from "./protocol";
import { ghostStart, ghostEnd, ghostClearAll } from "./ghostState.svelte";

let socket: WebSocket | null = null;
let manualClose = false;
// True once budget has been set from pi's contextWindow for the current connection.
// Prevents subsequent syncs from overriding a user's manual budget adjustment.
let budgetLive = false;

/** A fresh, all-zero `planOutcomes` counter map (issue #60) — one connection's worth. */
function freshPlanOutcomes(): Record<PassthroughCause, number> & { total: number } {
	return { applied: 0, "empty-plan": 0, "timeout-stale": 0, "timeout-raw": 0, "epoch-mismatch": 0, total: 0 };
}

/**
 * Live connection status, for the UI. `planOutcomes` (issue #60, ADR 0020) tallies every
 * `passthrough` ack this connection has received — one bucket per `PassthroughCause`, plus
 * `total` (acked model calls seen this connection). Reset to zero on every new connection
 * (see `connectLive`) alongside `sessionId`/`port` — it describes THIS connection's wire
 * history, not a running lifetime total (contrast the extension's own `/__accordion/meta`
 * counters, which ARE lifetime totals).
 */
export const live = $state<{
	status: "idle" | "connecting" | "connected" | "error";
	detail: string;
	sessionId: string | null;
	port: number | null;
	planOutcomes: Record<PassthroughCause, number> & { total: number };
}>({
	status: "idle",
	detail: "",
	sessionId: null,
	port: null,
	planOutcomes: freshPlanOutcomes(),
});

/**
 * The fold plan the GUI returns for a sync — Milestone 2, "engine on."
 *
 * The folder is OPT-IN and OFF by default (`folding.enabled`). While off, the GUI
 * still folds locally for the on-screen preview but replies with an EMPTY plan, so
 * the live model call is untouched (M1 behavior). Only when the user explicitly
 * arms folding does this mirror the engine's current fold decisions into wire ops
 * (kind- and durable-id-guarded in `computeFoldOps`/`computeGroupOps`). No store ⇒
 * empty plan. Group-collapse ops (ADR 0006) ride the SAME arm — disarmed, no group
 * collapses a live model call.
 *
 * This is the one place the GUI can alter a real model call; keep it a pure read.
 */
function computePlan(): { ops: FoldOp[]; groups: GroupOp[] } {
	if (!folding.enabled || !session.store) return { ops: [], groups: [] };
	return { ops: computeFoldOps(session.store), groups: computeGroupOps(session.store) };
}

/**
 * Tell the extension whether this client is ARMED (guarded send). Armed, the extension
 * blocks each `context` hook on the plan up to the hard deadline instead of racing past it
 * at the short fast-path timeout (see `ArmedMessage` in protocol.ts). No-op when the socket
 * is not OPEN — the state is re-synced on every attach from the hello handler, so a send
 * that can't land now is never lost.
 */
function sendArmed(on: boolean): void {
	const ws = socket;
	if (!ws || ws.readyState !== WebSocket.OPEN) return;
	const msg: ArmedMessage = { type: "armed", armed: on };
	try {
		ws.send(JSON.stringify(msg));
	} catch {
		/* socket gone — the next attach re-syncs armed state */
	}
}

/**
 * Arm / disarm folding for the live session — the SINGLE source of truth behind the GUI's
 * arm toggle. Flips the local `folding.enabled` (drives the on-screen preview and, armed,
 * the fold plan actually applied) AND declares the armed state to the extension over the
 * wire so its plan-wait blocking follows the same switch. Replaces the old benchmark-only
 * `ACCORDION_STEERING` env flag with one steering concept shared by GUI and headless host.
 */
export function setArmed(on: boolean): void {
	setFolding(on);
	sendArmed(on);
}

export function connectLive(port: number = DEFAULT_PORT, opts: { host?: string; token?: string } = {}): void {
	if (typeof window === "undefined" || typeof WebSocket === "undefined") return;
	cancelPendingLoad(); // invalidate any pending file/CC load that would otherwise clobber the live store
	disconnectLive(); // drop any prior socket
	manualClose = false;
	// Host defaults to loopback (the desktop app is always co-located with pi). A
	// browser-served page uses its literal loopback hostname and forwards the bearer from
	// its /accordion URL. The extension also recognizes exact-origin cookies and verified
	// sibling Accordion Origins, which preserves reloads and multi-session switching.
	const host = opts.host ?? "127.0.0.1";
	const tokenQs = opts.token ? `/?token=${encodeURIComponent(opts.token)}` : "";
	live.status = "connecting";
	live.detail = `ws://${host}:${port}`;
	live.sessionId = null;
	live.port = port;
	live.planOutcomes = freshPlanOutcomes(); // issue #60: counters describe THIS connection only
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
			// Browser upgrades are Origin/token-gated, but trusted native/Tauri clients remain
			// tokenless and any accepted peer can still send malformed data. isServerMessage
			// only vets the `type` tag — guard the
			// nested shape here rather than letting a malformed frame throw mid-pump and
			// strand the client half-connected.
			const meta: Partial<HelloMessage["meta"]> = msg.meta && typeof msg.meta === "object" ? msg.meta : {};
			if (msg.protocolVersion !== PROTOCOL_VERSION) {
				// Refuse a version mismatch loudly rather than driving the session with a wire
				// shape one side does not understand (in M2 that would silently corrupt the fold
				// ops / digests applied to the model context).
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
			// A live pi session is steerable, never a read-only recording. Reset here —
			// alongside the authoritative store rebuild — so the READ-ONLY badge can never
			// stick when attaching after viewing a Claude Code transcript, regardless of
			// which caller reached connectLive.
			session.readOnly = false;
			// Safety (review Q5b): every new live attach starts DISARMED - folding is
			// opt-in per session, never silently carried from a previously armed agent.
			folding.enabled = false;
			// Explicitly re-sync the disarmed state to the extension on every attach, so a fresh
			// (or reconnected) extension learns this client's armed state over the wire from turn
			// zero rather than inferring it. The socket is OPEN here (we are handling its hello).
			sendArmed(false);
			// Structural reset: clear all ghosts — no ghost survives a session reconnect.
			ghostClearAll();
			budgetLive = false;
			session.store = new AccordionStore({
				meta: { format: "pi", title: meta.title || "live pi session", cwd: meta.cwd || "", model: meta.model || "" },
				blocks: [],
				lineCount: 0,
				skipped: 0,
			});
			session.store.wireAttached = true; // live wire up → view mirrors the wire (issue #13)
			if (typeof meta.contextWindow === "number" && meta.contextWindow > 0) {
				session.store.setContextWindow(meta.contextWindow);
				session.store.setBudget(meta.contextWindow);
				budgetLive = true;
			}
		} else if (msg.type === "sync") {
			if (!session.store) return;
			if (msg.full) {
				// structural reset — rebuild from scratch; clear all ghosts.
				ghostClearAll();
				const prevContextWindow = session.store.contextWindow;
				const prevBudget = session.store.budget;
				const prevProtect = session.store.protectTokens;
				session.store = new AccordionStore({
					meta: session.store.meta,
					blocks: [],
					lineCount: 0,
					skipped: 0,
				});
				// Carry forward contextWindow, user-adjusted budget, and protect-tail across resets.
				if (prevContextWindow !== null) session.store.setContextWindow(prevContextWindow);
				session.store.setBudget(prevBudget);
				session.store.setProtect(prevProtect);
				session.store.wireAttached = true; // socket still live after structural reset (issue #13)
			}
			// Update contextWindow from the sync (refreshed each context hook, and pushed
			// immediately on a `/model` swap). Snap the budget to the window the FIRST time
			// we learn it (before the user can adjust) AND whenever the window CHANGES — a
			// changed window means a different model, so the old budget no longer fits.
			const cw = msg.contextWindow;
			if (typeof cw === "number" && cw > 0) {
				const prev = session.store.contextWindow;
				session.store.setContextWindow(cw);
				if (!budgetLive || (prev !== null && prev !== cw)) {
					session.store.setBudget(cw);
					budgetLive = true;
				}
			}
			// Committed blocks arrive HERE (the appendBlocks path), NEVER from ghost state.
			// Invariant: a ghost is only removed, never converted to a block.
			// Same unauthenticated-WS caution as the hello path: a sync without a real blocks
			// array — or with malformed elements — must not throw mid-pump (the plan reply
			// below still runs) or corrupt the store's token accounting.
			session.store.appendBlocks((Array.isArray(msg.blocks) ? msg.blocks : []).filter(isWireBlock).map(wireToBlock));
			const plan = computePlan();
			const reply: PlanMessage = { type: "plan", reqId: msg.reqId, ops: plan.ops, groups: plan.groups };
			try {
				ws.send(JSON.stringify(reply));
			} catch {
				/* socket gone — extension will time out and pass through */
			}
		} else if (msg.type === "unfoldRequest") {
			// The live agent asked (via the `unfold` tool) to restore folded blocks it saw
			// tagged `{#<code> FOLDED}`. Resolve each code to its folded block(s) and hold
			// them unfolded with provenance "agent" — so it shows in the activity log as
			// agent-initiated and the human stays the source of truth (they can re-fold it).
			// This is a STATE change only: the restored content reaches the agent at its NEXT
			// context hook (the block drops out of the fold plan). Unfolding only ever shows
			// the model MORE of its own original context, so there is no provider-safety risk.
			const codes = Array.isArray(msg.codes) ? msg.codes : [];
			// Only act while ARMED. Disarmed, the agent's real context is full (no tags were
			// applied), so an unfold request is stale/meaningless — applying a sticky "agent"
			// override then would silently leak a block from the budget on the next arm.
			const { restored, missing } =
				folding.enabled && session.store ? resolveUnfold(session.store, codes) : { restored: [], missing: codes };
			const reply: UnfoldResultMessage = { type: "unfoldResult", reqId: msg.reqId, restored, missing };
			try {
				ws.send(JSON.stringify(reply));
			} catch {
				/* socket gone — the tool will time out and tell the agent to retry */
			}
		} else if (msg.type === "recallRequest") {
			// The live agent asked (via the `recall` tool, ADR 0011) for the ORIGINAL full
			// content of folded blocks it saw tagged `{#<code> FOLDED}`. recall is an
			// UNBLOCKABLE READ - the counterpart to the human's peek: it returns the content
			// THIS turn and does NOT change fold state (no override, the block stays folded).
			// Because it is a pure read, it is NOT gated by the armed/disarmed steering toggle:
			// we resolve against the current store either way (resolveRecall never mutates, so
			// disarmed there is simply nothing folded to recall, all codes report missing).
			const codes = Array.isArray(msg.codes) ? msg.codes : [];
			const { restored, missing } = session.store ? resolveRecall(session.store, codes) : { restored: [], missing: codes };
			const reply: RecallResultMessage = { type: "recallResult", reqId: msg.reqId, restored, missing };
			try {
				ws.send(JSON.stringify(reply));
			} catch {
				/* socket gone - the tool will time out and tell the agent to retry */
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
		} else if (msg.type === "passthrough") {
			// The extension's per-outcome ack for a `context` hook resolution (issue #60, ADR
			// 0020). Tally the counter for the "wire N/M" readout.
			// `msg.cause` comes off the wire untyped — a malformed/unknown cause must not add a
			// spurious key (e.g. NaN-poisoning via prototype/array quirks) or bump `total` for an
			// outcome we can't attribute. Only tally a cause we actually have a bucket for.
			if (msg.cause in live.planOutcomes) {
				live.planOutcomes[msg.cause]++;
				live.planOutcomes.total++;
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
		// Guaranteed teardown (invariant #2): on disconnect, all ghosts vanish with the
		// GUI state. A ghost cannot outlive the WS connection that spawned it.
		ghostClearAll();
		// Only the ACTIVE socket may touch shared status. A superseded socket - a prior
		// connection whose close fires asynchronously after connectLive() already swapped
		// in a new one and reset manualClose - must NOT run this block, or it clobbers the
		// new socket's connecting/connected state back to idle.
		if (socket === ws) {
			socket = null;
			live.sessionId = null;
			live.port = null;
			if (session.store) session.store.wireAttached = false; // wire down → durability-agnostic view (issue #13)
			if (!manualClose && live.status !== "error") {
				live.status = "idle";
				live.detail = "disconnected";
			}
		}
	};
}

export function disconnectLive(): void {
	manualClose = true;
	budgetLive = false;
	// Guaranteed teardown (invariant #2): explicit disconnect clears all ghosts
	// immediately, before the socket close fires.
	ghostClearAll();
	if (session.store) session.store.wireAttached = false; // closing → no wire (issue #13)
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
