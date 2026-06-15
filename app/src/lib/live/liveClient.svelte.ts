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
import { computeFoldOps, computeGroupOps, resolveUnfold } from "./plan";
import { folding } from "./folding.svelte";
import { activeRemoteRunner } from "./conductorClient.svelte";
import { DEFAULT_PORT, PROTOCOL_VERSION, isServerMessage, type ServerMessage, type PlanMessage, type FoldOp, type GroupOp, type UnfoldResultMessage } from "./protocol";
import { ghostStart, ghostEnd, ghostClearAll } from "./ghostState.svelte";

let socket: WebSocket | null = null;
let manualClose = false;
// True once budget has been set from pi's contextWindow for the current connection.
// Prevents subsequent syncs from overriding a user's manual budget adjustment.
let budgetLive = false;

/** Live connection status, for the UI. */
export const live = $state<{ status: "idle" | "connecting" | "connected" | "error"; detail: string }>({
	status: "idle",
	detail: "",
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

export function connectLive(port: number = DEFAULT_PORT): void {
	if (typeof window === "undefined" || typeof WebSocket === "undefined") return;
	cancelPendingLoad(); // invalidate any pending file/CC load that would otherwise clobber the live store
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
			session.filePath = null;
			// A live pi session is steerable, never a read-only recording. Reset here —
			// alongside the authoritative store rebuild — so the READ-ONLY badge can never
			// stick when attaching after viewing a Claude Code transcript, regardless of
			// which caller reached connectLive.
			session.readOnly = false;
				// Safety (review Q5b): every new live attach starts DISARMED - folding is
				// opt-in per session, never silently carried from a previously armed agent.
				folding.enabled = false;
			// Structural reset: clear all ghosts — no ghost survives a session reconnect.
			ghostClearAll();
			budgetLive = false;
			session.store = new AccordionStore({
				meta: { format: "pi", title: msg.meta.title || "live pi session", cwd: msg.meta.cwd || "", model: msg.meta.model || "" },
				blocks: [],
				lineCount: 0,
				skipped: 0,
			});
			if (typeof msg.meta.contextWindow === "number" && msg.meta.contextWindow > 0) {
				session.store.setContextWindow(msg.meta.contextWindow);
				session.store.setBudget(msg.meta.contextWindow);
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
			session.store.appendBlocks(msg.blocks.map(wireToBlock));
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
			// Tell an attached remote conductor that the agent pulled blocks back to full — it
			// didn't initiate this, and may want to adapt (ADR 0007 host/event). Fire-and-forget.
			// We send block ids (not fold codes) so the conductor can correlate against the
			// ViewBlocks it received. A code may map to >1 block on a hash collision — include all.
			if (restored.length) {
				// `r.ids` carries the exact ids the resolver touched (group memberIds or
				// per-block id, including all hash-collision matches). Dedupe across entries.
				const ids = [...new Set(restored.flatMap((r) => r.ids))];
				activeRemoteRunner()?.notifyEvent(
					"agentUnfold",
					ids,
					`agent unfolded ${restored.length} block(s)`,
				);
			}
			const reply: UnfoldResultMessage = { type: "unfoldResult", reqId: msg.reqId, restored, missing };
			try {
				ws.send(JSON.stringify(reply));
			} catch {
				/* socket gone — the tool will time out and tell the agent to retry */
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
	budgetLive = false;
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

/** The protocol version this client speaks; surfaced for the mismatch guard above. */
export const CLIENT_PROTOCOL_VERSION = PROTOCOL_VERSION;
