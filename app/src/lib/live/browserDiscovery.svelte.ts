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
 * session's own `/accordion` URL restores full discovery. localFallback() below at least keeps
 * the CURRENTLY connected (or actively-being-dialed) session visible/reconnectable regardless,
 * so the sidebar never lies about "no live sessions" while one is plainly connected, and a
 * session switch can never be torn down by a poll that just hasn't caught up yet.
 *
 * Poll-failure handling (PR #52 review findings #4/#5): a poll that fails outright — network
 * error, non-ok status (403/500 — the deterministic cookie-collision case fixed on another
 * branch is exactly this), or a non-JSON body — must NOT publish `[]`. Publishing an empty list
 * on a transient failure feeds straight into discovery.svelte.ts's publishSessions() reap-guard,
 * which drops `discovery.selected` and tears down the live socket (disconnectLive()) whenever
 * the selected session goes missing from the published list AND status is "connected" OR
 * "connecting" — including an in-flight session switch that has nothing to do with the poll
 * itself. So on any poll failure we simply hold the last published list instead (see `poll()`).
 * A poll that succeeds and genuinely reports zero sessions still publishes `[]` — only the
 * *fetch* failing is special-cased, not an empty-but-valid response.
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
 * Read the per-session token the page was opened with (`/?token=...` — see +page.svelte's
 * `readServedToken()`, which does the same lookup for the WS dial). The poll fetch relies on
 * the ambient `accordion_token` cookie by default, but that cookie is shared per-origin: if a
 * sibling session's tab (or a reload) mints a DIFFERENT session's cookie on the same origin,
 * this tab's cookie gets clobbered and the poll starts 403ing. Forwarding the URL token as a
 * query param survives that — the server accepts either (see accordion.ts's isWebAuthed).
 */
function urlToken(): string | null {
	if (typeof window === "undefined") return null;
	return new URLSearchParams(window.location.search).get("token");
}

/**
 * Synthesize a placeholder SessionEntry for the session this tab is either connected to, or
 * actively dialing right now — from the live socket + its store meta, NOT read off
 * `/__accordion/sessions` (see the file banner for why that fetch can go stale or briefly omit
 * an entry). Only fields the sidebar actually renders (label/model/usage) carry real values;
 * `pid`/`startedAt` are meaningless placeholders.
 *
 * Covers two cases:
 *  - "connected": the live socket has a confirmed `sessionId` from the server's `hello`.
 *  - "connecting": `connectLive` sets `status`/`port` synchronously but `sessionId` stays null
 *    until `hello` arrives. `selectAndConnect` (+page.svelte) sets `discovery.selected` to the
 *    target session's id synchronously, immediately before dialing, so it names the in-flight
 *    target here. Without this, a poll that (for any reason) doesn't yet list the session being
 *    dialed would look — to publishSessions()'s reap-guard — indistinguishable from that session
 *    having died, and would tear down the in-flight connect mid-handshake.
 */
function localFallback(): SessionEntry | null {
	if (liveConn.status === "connected" && liveConn.sessionId && liveConn.port) {
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
	if (liveConn.status === "connecting" && liveConn.port && discovery.selected && discovery.selected !== DEMO_ID) {
		return {
			registryProtocol: REGISTRY_PROTOCOL,
			protocolVersion: PROTOCOL_VERSION,
			sessionId: discovery.selected,
			port: liveConn.port,
			pid: 0,
			cwd: "",
			title: "connecting…",
			model: "",
			tokens: null,
			contextWindow: null,
			startedAt: 0,
			heartbeatAt: Date.now(),
		};
	}
	return null;
}

export async function poll(): Promise<void> {
	if (_polling) return;
	_polling = true;
	try {
		// null = the fetch itself failed (network error, non-ok status, non-JSON body) — hold
		// the last published list rather than publish `[]`. A real empty list from a
		// successful, well-formed response is a distinct outcome and still publishes.
		let live: SessionEntry[] | null = null;
		try {
			const token = urlToken();
			const url = token ? `/__accordion/sessions?token=${encodeURIComponent(token)}` : "/__accordion/sessions";
			const res = await fetch(url);
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
		if (live === null) return; // poll failed outright — hold the last published list

		// Only "connected" and "connecting" ever need a synthesized entry (see localFallback);
		// any other status (idle/error) falls through to null and the real reap-on-vanish
		// behavior in publishSessions applies unchanged.
		const targetId =
			liveConn.status === "connected" ? liveConn.sessionId :
			liveConn.status === "connecting" ? discovery.selected :
			null;
		if (targetId && !live.some((s) => s.sessionId === targetId)) {
			const fallback = localFallback();
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
