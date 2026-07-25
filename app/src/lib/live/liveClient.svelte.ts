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
import { session, cancelPendingLoad, isTauriEnv } from "../session.svelte";
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
	type ActiveConductorMeta,
	type ControllerInfo,
} from "$core/protocol";
import { ghostStart, ghostEnd, ghostClearAll } from "./ghostState.svelte";
import { evaluateHelloController, noteControllerBroadcast, flashBlockedHintCenter, resetControllerUi, someoneElseControls } from "./controllerUi.svelte";
import { mySurfaceId, surfaceIdIfSettled, surfaceIdReady } from "./surfaceId";
import { showNotice, dismissNotice } from "./notice.svelte";

// Re-export so existing importers keep a stable path (`mySurfaceId` moved to surfaceId.ts to add the
// sessionStorage + BroadcastChannel-dedupe machinery without bloating this module — ADR 0024 §5).
export { mySurfaceId };

let socket: WebSocket | null = null;
let manualClose = false;
let commandSeq = 0;
// Guards the surfaceIdReady()-deferred first dial (see connectLive): a deferred open aborts when a
// newer connect/disconnect superseded it during the ≤150ms dedupe wait.
let connectSeq = 0;
// While true, incoming `event`s are dropped — a fresh `snapshot` is in flight (after a rev gap /
// reset), so replaying stale events onto the about-to-be-replaced replica is pointless.
let awaitingSnapshot = false;
// Session meta from `hello`, used to build the replica store when the snapshot arrives.
let pendingMeta: SessionMeta = { format: "pi", title: "live pi session", cwd: "", model: "" };

/** Fresh, all-zero hook telemetry — one connection's worth. */
function freshTelemetry() {
	return { lastHookMs: 0, maxHookMs: 0, p95HookMs: 0, rebuilds: 0, hookCount: 0, lastHoldMs: 0, holdTimeouts: 0, realTokens: null, estWireTokens: null };
}

/**
 * Live connection status, for the UI. `telemetry` is the extension's `context`-hook duration
 * stream (Phase B replaced the plan-outcome tally): the latency badge reads `lastHookMs`, with
 * `maxHookMs` / `p95HookMs` / `rebuilds` in its tooltip. `lastHoldMs`/`holdTimeouts` (v13) are the
 * NEW wire-departing hold the host grants an attached conductor's last-moment proposal — the
 * latency badge re-keys its amber/red thresholds off `lastHookMs - lastHoldMs` so a conductor
 * legitimately spending its declared hold budget never paints the badge as if the hook itself were
 * slow (see MapHeader.svelte). `realTokens`/`estWireTokens` (v18, issue #11 stage 1) are the raw
 * ingredients of the host's most recent token-calibration observation — `null` until the first one
 * lands this connection; auditing-only, the calibrated multiplier itself lives on the replica Truth
 * (`store.calibration`), not here. Reset on every new connection.
 */
export const live = $state<{
	status: "idle" | "connecting" | "connected" | "error";
	detail: string;
	sessionId: string | null;
	port: number | null;
	telemetry: {
		lastHookMs: number;
		maxHookMs: number;
		p95HookMs: number;
		rebuilds: number;
		hookCount: number;
		lastHoldMs: number;
		holdTimeouts: number;
		realTokens: number | null;
		estWireTokens: number | null;
	};
}>({
	status: "idle",
	detail: "",
	sessionId: null,
	port: null,
	telemetry: freshTelemetry(),
});

/**
 * The host's advertised conductor catalog (Phase C, `hello.conductors`) — the SINGLE source of
 * truth the GUI's conductor picker (`ConductorMenu.svelte`) renders from. Empty until a `hello`
 * carrying a non-empty catalog arrives; cleared on disconnect (see `resetConductorState`).
 */
export const conductors = $state<ActiveConductorMeta[]>([]);

/**
 * The host's currently-attached conductor (Phase C, broadcast `conductorState`), or `null` when
 * context is raw/human-only. Every client — GUI or conductor-role — agrees on this, never a
 * locally tracked guess (see `ConductorStateMessage`'s doc comment in core/protocol.ts).
 */
export const conductorState = $state<{ active: ActiveConductorMeta | null }>({ active: null });

/**
 * The attached conductor's display-only status line/metrics (Phase C, broadcast `conductorStatus`).
 * `text: null` is the "no status" / cleared state — there is no separate null-vs-object case to
 * track, matching the wire message's own `text: string | null` semantics.
 */
export const conductorStatus = $state<{ text: string | null; metrics?: Record<string, number | string | boolean> }>({
	text: null,
});

/**
 * The current global controller lease as the host reports it (v16, ADR 0024) — from `hello.controller`
 * on connect, then updated by every `controller` broadcast. `null` = no lease exists (or not fresh at
 * connect). This is minimal plumbing: the store/UI layer (spec Part 3) derives `isController`, silent
 * auto-claim, the takeover popup, and the READ-ONLY chip from this + `mySurfaceId()`. `fresh` is true
 * for a broadcast holder (a claim/heartbeat just wrote it) and mirrors the host's flag on connect.
 */
export const controllerState = $state<{ info: ControllerInfo | null }>({ info: null });

/** This surface's per-tab id (sessionStorage-backed, with a duplicate-tab BroadcastChannel dedupe
 *  guard) lives in `surfaceId.ts` and is re-exported above. */

/** This surface's human label: "Desktop app" (Tauri) or "Browser tab" (served page). */
export function mySurfaceLabel(): string {
	return isTauriEnv ? "Desktop app" : "Browser tab";
}

/** True iff this surface currently holds the fresh controller lease. */
export function isController(): boolean {
	const info = controllerState.info;
	return !!info && info.fresh && info.surfaceId === mySurfaceId();
}

/** True iff a DIFFERENT surface currently holds a FRESH lease (someone else is actively steering). The
 *  gate for the READ-ONLY "whisper" chrome — a null/stale lease is uncontested (this surface silently
 *  auto-claims it), so it must NOT paint read-only chrome (U1). See `someoneElseControls`. */
export function anotherSurfaceControls(): boolean {
	return someoneElseControls(controllerState.info, mySurfaceId());
}

/** Claim the global controller lease for this surface (v16). Sent to the host, which writes the lease
 *  and broadcasts the change to every client. Never optimistic — `controllerState` updates only when
 *  the host echoes it back (or via the next hello). */
export function claimController(): void {
	const ws = socket;
	if (!ws || ws.readyState !== WebSocket.OPEN) return;
	try {
		ws.send(JSON.stringify({ type: "claimController" }));
	} catch {
		/* socket gone — the next attach re-snapshots and re-claims */
	}
}

/** Defensive guard for a hello's `controller` field (authorized ≠ well-formed). */
function isControllerInfo(v: unknown): v is ControllerInfo {
	if (!v || typeof v !== "object") return false;
	const c = v as Record<string, unknown>;
	return typeof c.surfaceId === "string" && typeof c.label === "string" && typeof c.fresh === "boolean";
}

/** Defensive element guard for a hello's `conductors` catalog — same "authorized but maybe
 *  malformed" caution as `isWireBlock`: a bad entry must be dropped, not thrown or fed into the
 *  picker as an unusable id/label. */
function isConductorMeta(v: unknown): v is ActiveConductorMeta {
	if (!v || typeof v !== "object") return false;
	const c = v as Record<string, unknown>;
	return (
		typeof c.id === "string" &&
		typeof c.label === "string" &&
		Array.isArray(c.locks) &&
		typeof c.tailTokens === "number" &&
		typeof c.holdWireUpToMs === "number" &&
		typeof c.remote === "boolean"
	);
}

/** Clear the conductor catalog/active/status state AND the controller-lease view — a fresh connection
 *  or a dropped one both start from "nothing known" rather than leaking a prior session's picks. The
 *  lease view is re-seeded from the next `hello.controller`. */
function resetConductorState(): void {
	conductors.length = 0;
	conductorState.active = null;
	conductorStatus.text = null;
	conductorStatus.metrics = undefined;
	controllerState.info = null;
	resetControllerUi(); // drop any popup/toast/hint left over from a prior connection (Part 3)
	dismissNotice(); // drop any generic notice toast left over from a prior connection (v17)
}

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

/**
 * Attach/detach a conductor (Phase C picker). `id: null` detaches whatever is currently attached;
 * `id: "<conductorId>"` attaches it (swapping out any prior attach). Same remote-control shape as
 * every other steering action: NO optimistic apply — `conductorState` updates only when the host
 * echoes it back, so a rejected/failed attach never shows a false picked state.
 */
export function selectConductor(id: string | null): void {
	sendCommand({ kind: "selectConductor", id });
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
		carriedSent: Array.isArray(state.carriedSent) ? state.carriedSent : [],
	};
	const truth = hydrateSnapshot(pendingMeta, clean);
	const store = new AccordionStore({ meta: pendingMeta, blocks: [], lineCount: 0, skipped: 0 }, truth);
	store.setCommandSink(sendCommand);
	session.store = store;
	folding.enabled = !!state.foldingEnabled;
	awaitingSnapshot = false;
}

/**
 * Tear down the wire side of a live replica (both the socket-death path and manual disconnect
 * share this). A replica that just lost its wire must not go on looking steerable: null the
 * command sink AND badge the session read-only — the same affordance a Claude Code transcript
 * uses — so a fold gesture against the now-orphaned local Truth reads as a personal lens, not as
 * still steering a live agent that's gone. Checked BEFORE nulling the sink (wireControlled would
 * otherwise always read false); a store that was never live (demo/file/CC — never wire-controlled)
 * is left alone so an unrelated session displayed during a failed connect attempt isn't mislabeled.
 */
function orphanReplica(): void {
	if (session.store && session.store.wireControlled) session.readOnly = true;
	if (session.store) session.store.setCommandSink(null);
}

export function connectLive(port: number = DEFAULT_PORT, opts: { host?: string; token?: string } = {}): void {
	if (typeof window === "undefined" || typeof WebSocket === "undefined") return;
	// v16 (ADR 0024): the dial must carry an id the duplicate-tab dedupe has SETTLED on. Freezing the
	// id in the same synchronous frame as the module's init (exactly what browser-served auto-connect
	// does: onMount → connectLive) would render the whole BroadcastChannel guard inert — the same-id
	// owner's in-use reply lands milliseconds later, after the copied id already rode the wire. So:
	// fast path when the dedupe has already settled (bootstrap priming in +layout.svelte makes this
	// the norm — the window has long elapsed); otherwise wait out the ≤150ms window ONCE via
	// surfaceIdReady() (an in-use reply inside it re-mints us first), then re-enter — by then the id
	// is frozen and the sync path runs. The seq guard drops a deferred dial that a newer
	// connect/disconnect superseded during the wait.
	const settledSurface = surfaceIdIfSettled();
	if (settledSurface === null) {
		cancelPendingLoad();
		disconnectLive(); // drop any prior socket NOW, not after the wait
		manualClose = false;
		awaitingSnapshot = false;
		live.status = "connecting";
		live.detail = `ws://${opts.host ?? "127.0.0.1"}:${port}`;
		live.sessionId = null;
		live.port = port;
		const seq = ++connectSeq;
		void surfaceIdReady().then(() => {
			if (seq !== connectSeq || manualClose) return; // superseded during the dedupe wait
			connectLive(port, opts); // id now frozen — re-entry takes the synchronous path below
		});
		return;
	}
	++connectSeq; // supersede any still-pending deferred dial
	cancelPendingLoad(); // invalidate any pending file/CC load that would otherwise clobber the live store
	disconnectLive(); // drop any prior socket
	manualClose = false;
	awaitingSnapshot = false;
	// Host defaults to loopback (the desktop app is co-located with pi). A browser-served page uses
	// its literal loopback hostname and forwards the bearer from its /accordion URL. The extension
	// also recognizes exact-origin cookies and verified sibling Accordion Origins.
	const host = opts.host ?? "127.0.0.1";
	// Always carry this surface's identity so the host knows who is connecting for the single-
	// controller lease; the token (when present) rides the same query string. `settledSurface` is
	// the frozen id — surfaceIdIfSettled() marked the surface dialed on the way out, so from here
	// the dedupe never re-mints it out from under this connection (surfaceId.ts).
	const params = new URLSearchParams();
	if (opts.token) params.set("token", opts.token);
	params.set("surface", settledSurface);
	params.set("label", mySurfaceLabel());
	const tokenQs = `/?${params.toString()}`;
	live.status = "connecting";
	live.detail = `ws://${host}:${port}`;
	live.sessionId = null;
	live.port = port;
	live.telemetry = freshTelemetry();
	resetConductorState();
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
			// The available-conductor catalog (Phase C) — the picker's SINGLE source of truth. Absent
			// or malformed on a host with none attached/advertising ⇒ empty catalog, never a throw.
			conductors.length = 0;
			if (Array.isArray(msg.conductors)) conductors.push(...msg.conductors.filter(isConductorMeta));
			// v16: adopt the current controller lease (guard the shape), then decide what THIS
			// surface should do about it (Part 3): silently claim an uncontested/stale lease, ask
			// via the takeover popup for a fresh lease held elsewhere, or nothing when it's already
			// ours (reconnect / sidebar session switch).
			controllerState.info = isControllerInfo(msg.controller) ? msg.controller : null;
			if (evaluateHelloController(controllerState.info, mySurfaceId()) === "claim") claimController();
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
				lastHoldMs: msg.lastHoldMs,
				holdTimeouts: msg.holdTimeouts,
				realTokens: msg.realTokens,
				estWireTokens: msg.estWireTokens,
			};
		} else if (msg.type === "conductorState") {
			// Broadcast to EVERY client — the honest, shared "who (if anyone) is driving" state.
			// Guard the nested shape (isServerMessage only vets the `type` tag).
			conductorState.active = msg.active && isConductorMeta(msg.active) ? msg.active : null;
		} else if (msg.type === "conductorStatus") {
			conductorStatus.text = typeof msg.text === "string" ? msg.text : null;
			conductorStatus.metrics =
				msg.metrics && typeof msg.metrics === "object" ? msg.metrics : undefined;
		} else if (msg.type === "controller") {
			// v16: the global lease changed hands. A broadcast holder is fresh by construction (a claim/
			// heartbeat just wrote it). Check for OUR OWN demotion (Part 3) against the PRIOR info
			// before overwriting it — noteControllerBroadcast needs the "did we just lose it" comparison.
			if (typeof msg.surfaceId === "string" && typeof msg.label === "string") {
				noteControllerBroadcast(controllerState.info, { surfaceId: msg.surfaceId, label: msg.label }, mySurfaceId());
				controllerState.info = { surfaceId: msg.surfaceId, label: msg.label, fresh: true };
			}
		} else if (msg.type === "notice") {
			if (typeof msg.text === "string" && msg.text) showNotice(msg.text);
		} else if (msg.type === "recall") {
			// The live agent read folded content (a pure host-side read, no state change). Surfaced
			// for conductors (Phase C); the GUI has nothing to mutate, so this is observational only.
		} else if (msg.type === "commandResult") {
			// No optimistic apply — state arrives via the event stream. Clamp UX could read `results`.
			// v16: the server is the REAL boundary for READ-ONLY enforcement — the client-side gate
			// (`attemptSteer`) is a mirror, not a guarantee (a race: we thought we were the controller
			// when we sent this, the lease moved before the host processed it). No natural interaction
			// coordinates for a server-driven refusal, so the hint centers near the top of the view; the
			// imminent `controller` broadcast (a separate message) is what actually re-dims the controls.
			if (msg.refused === "read-only") flashBlockedHintCenter("steer");
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
			resetConductorState(); // wire down → no host to advertise/attach a conductor
			orphanReplica(); // wire down → no remote control; badge read-only if it was actually live
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
	resetConductorState();
	orphanReplica();
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
