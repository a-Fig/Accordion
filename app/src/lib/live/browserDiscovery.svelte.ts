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
 * No reap/focus-request handling here (those need the Tauri fs layer too): a stale entry
 * simply won't reappear in the next poll once its heartbeat goes stale (isLiveEntry), and
 * the owning process deletes its own file on shutdown — worst case is a harmless orphaned
 * file until some other viewer reaps it. Discovery stays best-effort, per the live-link
 * invariant: a fetch failure just leaves the last-known list in place.
 */
import { discovery, sameSessions, DEMO_ID } from "./discovery.svelte";
import { isLiveEntry, type SessionEntry } from "./registry";
import { disconnectLive, live as liveConn } from "./liveClient.svelte";

const POLL_MS = 1000;

let _timer: ReturnType<typeof setInterval> | null = null;
let _polling = false;

async function poll(): Promise<void> {
	if (_polling) return;
	_polling = true;
	try {
		const res = await fetch("/__accordion/sessions", { credentials: "same-origin" });
		if (!res.ok) return;
		const ct = res.headers.get("content-type") ?? "";
		if (!ct.includes("application/json")) return;
		const body = (await res.json()) as { sessions?: unknown[] };
		const raw = Array.isArray(body.sessions) ? body.sessions : [];
		const now = Date.now();
		const live: SessionEntry[] = raw.filter((e): e is SessionEntry => isLiveEntry(e, now));
		live.sort((a, b) => a.startedAt - b.startedAt);
		if (!sameSessions(discovery.sessions, live)) discovery.sessions = live;
		discovery.ready = true;
		if (discovery.selected && discovery.selected !== DEMO_ID && !live.some((s) => s.sessionId === discovery.selected)) {
			discovery.selected = null; // the live session we were looking at is gone
			if (liveConn.status === "connected" || liveConn.status === "connecting") disconnectLive();
		}
	} catch {
		/* network error / endpoint absent (older extension) — leave state untouched */
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
