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

/** Bump on any breaking change to SessionEntry / FocusRequest below. */
export const REGISTRY_PROTOCOL = 1;

/** Layout under the user's home directory. Rust mirrors these (lib.rs). */
export const REGISTRY_DIR = ".accordion";
export const SESSIONS_SUBDIR = "sessions";
/** Subdir under ~/.accordion where conductors advertise themselves (ADR 0007). */
export const CONDUCTORS_SUBDIR = "conductors";
export const FOCUS_FILE = "focus.json";

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

/**
 * A conductor advertising itself for discovery. Mirrors SessionEntry, but a conductor
 * exposes a full ws:// URL (it may be remote, not just an ephemeral local port) and its
 * own protocol version (the conductor wire, distinct from the pi wire PROTOCOL_VERSION).
 */
export interface ConductorEntry {
	registryProtocol: number;   // must === REGISTRY_PROTOCOL
	conductorProtocol: number;  // the conductor wire version it speaks
	id: string;                 // stable conductor id
	label: string;              // human-facing name for the switcher
	url: string;                // ws:// endpoint the app connects to (as a client)
	pid: number;
	startedAt: number;
	heartbeatAt: number;        // liveness signal — stale after STALE_AFTER_MS
}

/** True if `e` is a well-formed, non-stale conductor advertisement. */
export function isLiveConductor(e: unknown, now: number): e is ConductorEntry {
	if (!e || typeof e !== "object") return false;
	const v = e as Record<string, unknown>;
	return (
		v.registryProtocol === REGISTRY_PROTOCOL &&
		typeof v.id === "string" &&
		typeof v.url === "string" &&
		v.url.length > 0 &&
		typeof v.heartbeatAt === "number" &&
		now - (v.heartbeatAt as number) <= STALE_AFTER_MS
	);
}

