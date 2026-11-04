/**
 * regretPoll.svelte.ts — browser-served-mode poll of `/__accordion/meta` for the `regret` counters
 * (PR #152), feeding `MapHeader`'s REACH-BACK chip.
 *
 * Browser-served mode only, for now: the desktop app is a Tauri webview with no same-origin path to
 * the extension's HTTP server, and `/meta` carries no CORS headers, so desktop polling needs its own
 * transport (a follow-up). Like `browserDiscovery`, the fetch is RELATIVE, so it reaches whichever
 * origin served the page — after a sidebar session switch that may not be the connected session.
 * `parseRegret` therefore only accepts a body whose `sessionId` is the connected one; otherwise the
 * chip hides rather than showing another session's numbers.
 *
 * A failed poll holds the last value (a transient blip must not flicker the chip off); a poll that
 * succeeds but is for another session, or lacks `regret` (older extension), clears it.
 */
import { live } from "./liveClient.svelte";
import { parseRegret, type RegretMeta } from "./regret";

const POLL_MS = 3000;
const FETCH_TIMEOUT_MS = 2500;

export const regretView = $state<{ regret: RegretMeta | null }>({ regret: null });

let _timer: ReturnType<typeof setInterval> | null = null;

async function poll(): Promise<void> {
	try {
		const res = await fetch("/__accordion/meta", { credentials: "same-origin", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!res.ok) return;
		const body: unknown = await res.json();
		regretView.regret = parseRegret(body, live.sessionId);
	} catch {
		// network error / timeout / non-JSON — hold the last value
	}
}

export function startRegretPoll(): void {
	if (_timer) return;
	void poll();
	_timer = setInterval(() => void poll(), POLL_MS);
}

export function stopRegretPoll(): void {
	if (_timer) {
		clearInterval(_timer);
		_timer = null;
	}
	regretView.regret = null;
}
