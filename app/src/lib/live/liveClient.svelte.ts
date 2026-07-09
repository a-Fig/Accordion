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
import { activeRemoteRunner } from "./conductorClient.svelte";
import { DEFAULT_PORT, PROTOCOL_VERSION, isServerMessage, type ServerMessage, type PlanMessage, type FoldOp, type GroupOp, type UnfoldResultMessage, type RecallResultMessage, type CompleteRequestMessage, type ArmedMessage } from "./protocol";
import { ghostStart, ghostEnd, ghostClearAll } from "./ghostState.svelte";
import type { CompletionRequest, CompletionResult } from "$conductors/contract";

let socket: WebSocket | null = null;
let manualClose = false;
// True once budget has been set from pi's contextWindow for the current connection.
// Prevents subsequent syncs from overriding a user's manual budget adjustment.
let budgetLive = false;

/**
 * Safety backstop: if the extension (or the model it calls) never replies to a
 * completion request, the pending promise would hang forever. Two minutes is generous
 * enough for any real LLM completion while still bounding the worst-case hang window.
 * On fire, the promise rejects and the map entry is cleared so a late `completeResult`
 * for the same reqId is ignored.
 */
const COMPLETION_TIMEOUT_MS = 120_000;

/**
 * Pending out-of-band completion requests keyed by `reqId`. A conductor calls
 * `host.complete(req)`, which routes here; the promise resolves/rejects when the
 * extension sends back a matching `completeResult`. Module-scoped and parallel to
 * `socket` so it survives across the connect/message lifecycle without threading
 * through a closure per connection.
 *
 * Each entry also holds a `timer` handle that is cleared on every settle path
 * (success, abort, disconnect drain) so no timer leaks.
 */
const pendingCompletions = new Map<number, { resolve: (r: CompletionResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
/** Monotonic counter for `completeRequest` reqIds. Starts at 1 to distinguish from unset/zero. */
let completionReqId = 0;

/** Live connection status, for the UI. */
export const live = $state<{ status: "idle" | "connecting" | "connected" | "error"; detail: string; sessionId: string | null }>({
	status: "idle",
	detail: "",
	sessionId: null,
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
 * Reject all pending completion promises and clear the registry. Called on any
 * disconnect path so no request can silently hang across a session boundary.
 * Also clears the per-entry timeout timer so no timer leaks survive a disconnect.
 */
function drainPendingCompletions(reason: string): void {
	for (const { reject, timer } of pendingCompletions.values()) {
		clearTimeout(timer);
		reject(new Error(reason));
	}
	pendingCompletions.clear();
}

/**
 * Fire an out-of-band completion request to the pi extension over the live socket.
 *
 * This is the implementation behind `store.completer` — the live client injects it
 * when the socket opens and clears it when the socket closes. Conductors reach it
 * through `host.complete(req)` (never called directly).
 *
 * Hard invariants:
 *  - NEVER blocks or alters the agent's own model call; the extension fulfils it on a
 *    side channel completely outside the sync→plan→apply loop.
 *  - If `req.signal` is already aborted before this call, the promise rejects
 *    immediately so no wire message is sent.
 *  - If `req.signal` fires while the call is in flight, the pending entry is removed
 *    and the promise rejects with the abort reason; a late `completeResult` for the
 *    same `reqId` is then silently ignored (no pending entry found).
 */
async function sendCompletion(req: CompletionRequest): Promise<CompletionResult> {
	const ws = socket;
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		throw new Error("not connected");
	}

	// Abort immediately if the signal is already fired before we even send.
	if (req.signal?.aborted) {
		throw new DOMException("aborted", "AbortError");
	}

	const reqId = ++completionReqId;
	const msg: CompleteRequestMessage = {
		type: "completeRequest",
		reqId,
		system: req.system,
		prompt: req.prompt,
		maxOutputTokens: req.maxOutputTokens,
	};

	return new Promise<CompletionResult>((resolve, reject) => {
		// Register BEFORE sending so there is no window where a synchronous response
		// could arrive before we have stored the handlers (impossible over WS in practice,
		// but defensive correctness costs nothing here).
		let abortListener: (() => void) | null = null;

		// Placeholder timer handle; replaced with the real timer immediately after the
		// entry is inserted into the map (before the WS send), so the settle wrapper
		// always has a valid handle to clear.
		let timeoutHandle: ReturnType<typeof setTimeout>;

		const settle = (fn: () => void): void => {
			// Clear the safety-backstop timer exactly once regardless of settle path
			// (success via completeResult, abort signal, or drain on disconnect).
			clearTimeout(timeoutHandle);
			// Clean up the abort listener exactly once regardless of settle path.
			if (abortListener && req.signal) {
				req.signal.removeEventListener("abort", abortListener);
				abortListener = null;
			}
			pendingCompletions.delete(reqId);
			fn();
		};

		// Start the safety backstop timer. On fire, reject the promise and remove the
		// entry so any late `completeResult` for this reqId is silently ignored.
		timeoutHandle = setTimeout(() => {
			if (pendingCompletions.has(reqId)) {
				settle(() => reject(new Error("completion timed out")));
			}
		}, COMPLETION_TIMEOUT_MS);

		pendingCompletions.set(reqId, {
			resolve: (r) => settle(() => resolve(r)),
			reject: (e) => settle(() => reject(e)),
			timer: timeoutHandle,
		});

		// Wire the abort signal AFTER the entry is in the map so the listener can safely
		// delete it and any late result for this reqId is ignored. Route through settle()
		// so the timeout timer is cleared and the abort listener is removed exactly once.
		if (req.signal) {
			abortListener = () => {
				settle(() => reject(new DOMException("aborted", "AbortError")));
			};
			req.signal.addEventListener("abort", abortListener, { once: true });
		}

		try {
			ws.send(JSON.stringify(msg));
		} catch (e) {
			settle(() => reject(new Error(e instanceof Error ? e.message : "send failed")));
		}
	});
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

export function connectLive(port: number = DEFAULT_PORT): void {
	if (typeof window === "undefined" || typeof WebSocket === "undefined") return;
	cancelPendingLoad(); // invalidate any pending file/CC load that would otherwise clobber the live store
	disconnectLive(); // drop any prior socket
	manualClose = false;
	live.status = "connecting";
	live.detail = `ws://127.0.0.1:${port}`;
	live.sessionId = null;
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
			session.store?.dispose(); // abort the outgoing store's conductor (in-flight host.complete) before discarding it
			session.store = new AccordionStore({
				meta: { format: "pi", title: msg.meta.title || "live pi session", cwd: msg.meta.cwd || "", model: msg.meta.model || "" },
				blocks: [],
				lineCount: 0,
				skipped: 0,
			});
			// Expose the completion backend to conductors while this socket is live.
			// Cleared on disconnect/close so `host.can("complete")` returns false when
			// there is no active model link.
			session.store.completer = sendCompletion;
			session.store.wireAttached = true; // live wire up → view mirrors the wire (issue #13)
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
				session.store.dispose(); // abort the outgoing store's conductor (in-flight host.complete) before discarding it
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
				// Re-attach the completer: a structural reset builds a brand-new store object,
				// so the reference from the hello path is gone. The socket is still live.
				session.store.completer = sendCompletion;
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
		} else if (msg.type === "completeResult") {
			if (typeof msg.reqId !== "number") return;
			// Out-of-band completion response from the extension (protocol v5). Look up the
			// pending promise by reqId; if the entry is gone (aborted or stale), ignore silently.
			const pending = pendingCompletions.get(msg.reqId);
			if (pending) {
				if (msg.ok) {
					pending.resolve({
						text: msg.text ?? "",
						model: msg.model ?? "",
						inputTokens: msg.inputTokens,
						outputTokens: msg.outputTokens,
					});
				} else {
					pending.reject(new Error(msg.error ?? "completion failed"));
				}
				// `pending.resolve/reject` already delete the entry via the `settle` wrapper
				// in `sendCompletion`, so no explicit `pendingCompletions.delete` here.
			}
		}
	};

	ws.onerror = () => {
		live.status = "error";
		live.detail = `could not reach pi on :${port} — is a pi session running with the accordion extension?`;
		live.sessionId = null;
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
			// Clear the completion backend so `host.can("complete")` returns false while
			// disconnected. Drain any pending completion promises with a disconnection error
			// so they do not hang indefinitely.
			if (session.store) session.store.completer = null;
			if (session.store) session.store.wireAttached = false; // wire down → durability-agnostic view (issue #13)
			drainPendingCompletions("disconnected");
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
	// Clear the completion backend and drain any in-flight completion promises before
	// closing the socket, so conductors that await host.complete() get an immediate error
	// rather than a dangling promise. The onclose handler also runs this path but may
	// fire asynchronously; running it here ensures the completer is unavailable the
	// moment the caller's disconnectLive() returns.
	if (session.store) session.store.completer = null;
	if (session.store) session.store.wireAttached = false; // closing → no wire (issue #13)
	drainPendingCompletions("disconnected");
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
}
