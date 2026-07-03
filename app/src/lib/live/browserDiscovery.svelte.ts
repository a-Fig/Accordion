/*
 * browserDiscovery.svelte.ts — multi-session discovery for browser-served mode.
 *
 * The desktop app's discovery.svelte.ts polls a Tauri `invoke("list_sessions")` command
 * because a browser tab cannot read `~/.accordion/` itself. But the pi extension serving
 * this page CAN — it's a Node process, not filesystem-sandboxed — so it exposes the same
 * registry over `/__accordion/sessions` (token-gated; see extension/accordion.ts). This
 * module polls that HTTP endpoint instead of `invoke`, and writes into the SAME reactive
 * `discovery.sessions` state discovery.svelte.ts exports, so the sidebar and session-select
 * plumbing need no separate code path for browser-served vs desktop.
 *
 * No focus-request consumption here (that needs a second one-shot endpoint this PR doesn't
 * add) and no CLIENT-side reap of dead siblings (the server already reaps opportunistically
 * in listLiveSessions — see accordion.ts). Discovery stays best-effort, per the live-link
 * invariant: a fetch failure just leaves the last-known list in place, EXCEPT for the
 * actively-connected session, which connectedFallback() below guarantees never disappears.
 *
 * Known limitation: `fetch("/__accordion/sessions")` is a RELATIVE url, so it always targets
 * the origin that served this page (call it session A) — not whichever session the user has
 * since switched to via the sidebar (connectLive(B.port) dials a different port over the
 * WebSocket, but there is no cross-port equivalent for this HTTP poll without either a CORS
 * change to accordion.ts, currently deliberately absent everywhere, or routing discovery over
 * the WS itself). If session A's pi process exits, this tab's polling goes permanently silent
 * — new sibling sessions started afterward will not appear here. connectedFallback() below
 * keeps the CURRENTLY connected session visible/reconnectable regardless, so the sidebar never
 * lies about "no live sessions" while one is plainly connected — but recovering full discovery
 * still requires reloading the page from a still-live session's own `/accordion` URL.
 */
import { discovery, sameSessions, DEMO_ID } from "./discovery.svelte";
import { isLiveEntry, REGISTRY_PROTOCOL, type SessionEntry } from "./registry";
import { disconnectLive, live as liveConn } from "./liveClient.svelte";
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
			const res = await fetch("/__accordion/sessions", { credentials: "same-origin" });
			if (res.ok) {
				const ct = res.headers.get("content-type") ?? "";
				if (ct.includes("application/json")) {
					const body = (await res.json()) as { sessions?: unknown[] };
					const raw = Array.isArray(body.sessions) ? body.sessions : [];
					const now = Date.now();
					live = raw.filter((e): e is SessionEntry => isLiveEntry(e, now));
				}
			}
		} catch {
			/* network error / endpoint absent (older extension) / serving session exited */
		}
		if (!live.some((s) => s.sessionId === liveConn.sessionId)) {
			const fallback = connectedFallback();
			if (fallback) live.push(fallback);
		}
		if (!sameSessions(discovery.sessions, live)) discovery.sessions = live;
		discovery.ready = true;
		if (discovery.selected && discovery.selected !== DEMO_ID && !live.some((s) => s.sessionId === discovery.selected)) {
			discovery.selected = null; // the live session we were looking at is gone
			if (liveConn.status === "connected" || liveConn.status === "connecting") disconnectLive();
		}
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
