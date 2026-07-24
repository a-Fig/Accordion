/*
 * registry.ts — the session DISCOVERY contract for the "pull" connection model.
 *
 * In the pull model the pi extension does NOT spawn or push the GUI open. Instead,
 * each pi session advertises itself by writing a small descriptor file:
 *
 *   ~/.accordion/sessions/<sessionId>.json      (SessionEntry)
 *
 * refreshes it on a heartbeat while it lives, and deletes it on shutdown. The
 * Accordion app watches that directory and lists every live pi, so the user opens
 * ONE app and attaches to any session by clicking it. Liveness is read from the
 * heartbeat timestamp (a session whose heartbeat went stale is reaped).
 *
 * `/accordion` in a pi terminal additionally writes a single focus request:
 *
 *   ~/.accordion/focus.json                     (FocusRequest)
 *
 * which the app consumes (read-once, then delete) to foreground itself and select
 * that session. This remains the only session handoff path. `/accordion` may
 * best-effort launch/reinvoke the desktop app as a convenience, but the app still
 * discovers and pulls the session through this registry contract.
 *
 * This file is the SINGLE SOURCE OF TRUTH for the directory layout and the JSON
 * shapes. It is imported by:
 *   • the extension (Node) — which performs the writes using node:fs/os/path, and
 *   • the app (types only) — the Tauri Rust layer performs the reads and MUST
 *     mirror these constants (see app/src-tauri/src/lib.rs).
 *
 * Keep it dependency-free and runtime-pure: NO fs/os imports, so the browser
 * bundle can import the types without pulling in Node built-ins.
 */

/** Bump on any breaking change to SessionEntry / FocusRequest / ControllerLease below. */
export const REGISTRY_PROTOCOL = 1;

/** Layout under the user's home directory. Rust mirrors the SESSIONS_SUBDIR / FOCUS_FILE reads
 *  (lib.rs). CONTROLLER_FILE / DOOR_SECRET_FILE are NOT read by Rust — the controller lease reaches
 *  every client over the WS (ADR 0024), and the door secret is used only by the Node extension —
 *  so they need no Rust mirror. */
export const REGISTRY_DIR = ".accordion";
export const SESSIONS_SUBDIR = "sessions";
export const FOCUS_FILE = "focus.json";

/**
 * The global single-controller lease (ADR 0024), written at `~/.accordion/controller.json`. Exactly
 * one surface controls machine-wide across ALL live sessions; every other surface is a live
 * READ-ONLY mirror. Any extension may read/write it (atomic write-rename, same as SessionEntry); the
 * lease-holder's extension refreshes `heartbeatAt` while a matching socket is connected, and other
 * extensions observe changes via a ~1s mtime poll.
 */
export const CONTROLLER_FILE = "controller.json";

/**
 * The shared browser bearer secret (32 hex bytes), written at `~/.accordion/door-secret` by the first
 * extension that needs it (ADR 0024). EVERY extension accepts it as a bearer wherever the per-session
 * `webToken` is accepted (static serving, token-gated endpoints, WS upgrade), which makes the door URL
 * session-independent. Posture is unchanged: local same-user processes can already read pi's session
 * data; a hostile web page cannot read files.
 */
export const DOOR_SECRET_FILE = "door-secret";

/**
 * No controller heartbeat for this long ⇒ the lease is STALE and the session is treated as
 * uncontrolled (any surface may silently auto-claim). Deliberately tight (6s) so a surface that
 * closed its tab frees control quickly. Must be comfortably larger than the extension's controller
 * heartbeat interval so a merely-idle controller surface is never treated as gone.
 */
export const CONTROLLER_STALE_AFTER_MS = 6_000;

/**
 * No heartbeat for this long ⇒ the app treats the session as dead and reaps its
 * file. Must be comfortably larger than the extension's heartbeat interval so an
 * idle-but-alive pi (one that simply hasn't made a model call) is never reaped.
 */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const STALE_AFTER_MS = 15_000;

/** One live pi session, written to ~/.accordion/sessions/<sessionId>.json. */
export interface SessionEntry {
	/** REGISTRY_PROTOCOL at write time — the reader rejects mismatches. */
	registryProtocol: number;
	/** Wire PROTOCOL_VERSION (protocol.ts) the session speaks. */
	protocolVersion: number;
	sessionId: string;
	/** Ephemeral loopback WebSocket port this session's extension is listening on. */
	port: number;
	/** OS process id of the pi session (diagnostics only; liveness uses heartbeat). */
	pid: number;
	cwd: string;
	title: string;
	/** Model id, e.g. "google/gemini-2.5-flash-lite" (best-effort; "" if unknown). */
	model: string;
	/** Last-known context tokens (pi's own estimate), or null if unknown. */
	tokens: number | null;
	/** Model context window in tokens, or null if unknown. */
	contextWindow: number | null;
	/** Epoch ms when the session started. */
	startedAt: number;
	/** Epoch ms of the last heartbeat refresh — the staleness/liveness signal. */
	heartbeatAt: number;
}

/** A one-shot request from `/accordion` to foreground the app on a session. */
export interface FocusRequest {
	sessionId: string;
	ts: number;
}

/**
 * The global controller lease (ADR 0024), written to `~/.accordion/controller.json`. One surface
 * steers all live sessions; the rest are live READ-ONLY mirrors.
 */
export interface ControllerLease {
	/** REGISTRY_PROTOCOL at write time — the reader rejects mismatches. */
	registryProtocol: number;
	/** The controlling surface's per-tab id (a UUID minted in sessionStorage; see surfaceId.ts). */
	surfaceId: string;
	/** Human label for the controlling surface, e.g. "Desktop app" / "Browser tab". */
	label: string;
	/** Epoch ms when this surface first took the lease. */
	claimedAt: number;
	/** Epoch ms of the last heartbeat refresh — the freshness/liveness signal. */
	heartbeatAt: number;
}

/** True when a value parses as a current-protocol controller lease whose heartbeat is fresh. */
export function isFreshLease(l: unknown, now: number): l is ControllerLease {
	if (!l || typeof l !== "object") return false;
	const v = l as Record<string, unknown>;
	return (
		v.registryProtocol === REGISTRY_PROTOCOL &&
		typeof v.surfaceId === "string" &&
		v.surfaceId.length > 0 &&
		typeof v.label === "string" &&
		typeof v.heartbeatAt === "number" &&
		now - (v.heartbeatAt as number) <= CONTROLLER_STALE_AFTER_MS
	);
}

/** True when a value parses as a well-formed controller lease, regardless of heartbeat freshness. */
export function isControllerLease(l: unknown): l is ControllerLease {
	if (!l || typeof l !== "object") return false;
	const v = l as Record<string, unknown>;
	return (
		v.registryProtocol === REGISTRY_PROTOCOL &&
		typeof v.surfaceId === "string" &&
		v.surfaceId.length > 0 &&
		typeof v.label === "string" &&
		typeof v.claimedAt === "number" &&
		typeof v.heartbeatAt === "number"
	);
}

/** True when an entry parses as a current-protocol, non-stale, dialable session. */
export function isLiveEntry(e: unknown, now: number): e is SessionEntry {
	if (!e || typeof e !== "object") return false;
	const v = e as Record<string, unknown>;
	return (
		v.registryProtocol === REGISTRY_PROTOCOL &&
		typeof v.sessionId === "string" &&
		typeof v.port === "number" &&
		v.port > 0 &&
		typeof v.heartbeatAt === "number" &&
		now - (v.heartbeatAt as number) <= STALE_AFTER_MS
	);
}

