/*
 * browserDiscovery.svelte.ts — multi-session discovery for browser-served mode.
 *
 * The desktop app's discovery.svelte.ts polls a Tauri `invoke("list_sessions")` command
 * because a browser tab cannot read `~/.accordion/` itself. But the pi extension serving
 * this page CAN — it's a Node process, not filesystem-sandboxed — so it exposes the same
 * registry over `/__accordion/sessions` (token-gated; see extension/accordion.ts). This
 * module polls that HTTP endpoint instead of `invoke`, and shares discovery.svelte.ts's
 * `publishSessions()` to write into the SAME reactive `discovery.sessions` state, so the
 * sidebar and session-select plumbing need no separate code path for browser-served vs
 * desktop, and the two sources can't drift on the publish/reap-selection invariant.
 *
 * No focus-request consumption here (that needs a second one-shot endpoint this PR doesn't
 * add) and no CLIENT-side reap of dead siblings (the server already reaps opportunistically
 * in listLiveSessions — see accordion.ts, which also does the isLiveEntry staleness/shape
 * filtering, so the response here is trusted as-is rather than re-validated).
 *
 * Known limitation: `fetch("/__accordion/sessions")` is a RELATIVE url, so it always targets
 * the origin that served this page — not whichever session the user has since switched to via
 * the sidebar (connectLive(B.port) dials a different port over the WebSocket, but there is no
 * cross-port equivalent for this HTTP poll without either a CORS change to accordion.ts,
 * currently deliberately absent everywhere, or routing discovery over the WS itself). If the
 * serving session's pi process exits, this tab's polling goes permanently silent — new sibling
 * sessions started afterward will not appear here; only a page reload from a still-live
 * session's own `/accordion` URL restores full discovery. connectedFallback() below at least
 * keeps the CURRENTLY connected session visible/reconnectable regardless, so the sidebar never
 * lies about "no live sessions" while one is plainly connected.
 */
import { discovery, publishSessions, DEMO_ID } from "./discovery.svelte";
import { REGISTRY_PROTOCOL, type SessionEntry } from "./registry";
import { live as liveConn } from "./liveClient.svelte";
import { PROTOCOL_VERSION } from "./protocol";
import { session } from "../session.svelte";

const POLL_MS = 1000;

let _timer: ReturnType<typeof setInterval> | null = null;
let _polling = false;

/**
 * Synthesize a SessionEntry for the session this tab is actually attached to right now,
 * from the live socket + its store meta — NOT read off `/__accordion/sessions` (see the
 * file banner for why that fetch can go stale). Only fields the sidebar actually renders
 * (label/model/usage) carry real values; `pid`/`startedAt` are meaningless placeholders.
 */
function connectedFallback(): SessionEntry | null {
	if (liveConn.status !== "connected" || !liveConn.sessionId || !liveConn.port) return null;
	const meta = session.store?.meta;
	return {
		registryProtocol: REGISTRY_PROTOCOL,
		protocolVersion: PROTOCOL_VERSION,
		sessionId: liveConn.sessionId,
		port: liveConn.port,
		pid: 0,
		cwd: meta?.cwd ?? "",
		title: meta?.title ?? "pi session",
		model: meta?.model ?? "",
		tokens: null,
		contextWindow: session.store?.contextWindow ?? null,
		startedAt: 0,
		heartbeatAt: Date.now(),
	};
}

async function poll(): Promise<void> {
	if (_polling) return;
	_polling = true;
	try {
		let live: SessionEntry[] = [];
		try {
			const res = await fetch("/__accordion/sessions");
			if (res.ok) {
				const ct = res.headers.get("content-type") ?? "";
				if (ct.includes("application/json")) {
					const body = (await res.json()) as { sessions?: unknown[] };
					// Trusted as-is: the server already applies isLiveEntry (staleness/shape) and
					// reaps what fails it — see extension/accordion.ts's listLiveSessions().
					live = Array.isArray(body.sessions) ? (body.sessions as SessionEntry[]) : [];
				}
			}
		} catch {
			/* network error / endpoint absent (older extension) / serving session exited */
		}
		if (!live.some((s) => s.sessionId === liveConn.sessionId)) {
			const fallback = connectedFallback();
			if (fallback) live.push(fallback);
		}
		publishSessions(live);
	} finally {
		_polling = false;
	}
}

export function startBrowserDiscovery(): void {
	if (_timer) return;
	void poll();
	_timer = setInterval(() => void poll(), POLL_MS);
}

export function stopBrowserDiscovery(): void {
	if (_timer) {
		clearInterval(_timer);
		_timer = null;
	}
}
