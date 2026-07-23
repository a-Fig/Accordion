/*
 * servedToken.ts — capture the per-session bearer the served page was opened with (`/?token=…`)
 * ONCE, then scrub it out of the address bar (S1b, ADR 0024 §9).
 *
 * The door URL carries a persistent, machine-wide door secret that never rotates and rides a
 * bookmarkable link, so leaving it in `window.location` means it lands in browser history and
 * bookmark sync. We read it a single time into a module variable — so both the WS dial
 * (`liveClient.connectLive`) and the `/__accordion/sessions` poll (`browserDiscovery`) still forward
 * it, preserving the cookie-clobber resistance that forwarding was added for — and then
 * `history.replaceState` it out of the visible URL, keeping every OTHER query param intact.
 *
 * The cookie is established server-side on the initial page GET (Set-Cookie on `GET /?token=…`, see
 * accordion.ts), so it already exists by the time this app JS runs; stripping the token from the URL
 * afterward is safe (a later reload with no `?token=` is authorized by that cookie, exactly as a
 * user manually deleting the token from the URL already was).
 *
 * Framework-free (no runes) and dependency-free so it is trivially unit-testable.
 */
let captured: string | null = null;
let done = false;

/**
 * The per-session bearer this page was opened with, or null. First call (in the browser) reads it out
 * of `window.location.search`, memoizes it, and strips `token` from the address bar via
 * `history.replaceState`; every later call returns the memoized value. Best-effort: if history/URL
 * access throws, whatever was captured before the throw is still returned.
 */
export function servedToken(): string | null {
	if (done) return captured;
	if (typeof window === "undefined") return null; // SSR: don't memoize; retry in the browser
	done = true;
	try {
		const params = new URLSearchParams(window.location.search);
		captured = params.get("token");
		if (captured !== null) {
			params.delete("token");
			const qs = params.toString();
			const url = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
			window.history.replaceState(window.history.state, "", url);
		}
	} catch {
		/* best-effort — keep whatever we captured before any throw */
	}
	return captured;
}

/** Test-only: reset the one-shot capture so each case starts fresh (see servedToken.test.ts). */
export function _resetServedTokenForTests(): void {
	captured = null;
	done = false;
}
