import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { servedToken, _resetServedTokenForTests } from "./servedToken";

/*
 * servedToken.test.ts — the served page's one-shot bearer capture (S1b, ADR 0024 §9). Verifies the
 * token is (1) read out of the URL, (2) scrubbed from the address bar via history.replaceState with
 * every OTHER query param preserved, and (3) memoized so both the WS dial and the /sessions poll keep
 * forwarding it AFTER the strip.
 */

let hadWindow: boolean;
let savedWindow: unknown;

/** A minimal window stub: a mutable location + a history.replaceState that rewrites location.search
 *  the way a real browser would, so a second read sees the scrubbed URL. */
function fakeWindow(search: string, pathname = "/", hash = ""): { location: { pathname: string; search: string; hash: string }; history: { state: unknown; replaceState: (state: unknown, title: string, url: string) => void }; calls: string[] } {
	const calls: string[] = [];
	const location = { pathname, search, hash };
	return {
		location,
		history: {
			state: { some: "state" },
			replaceState(_state: unknown, _title: string, url: string) {
				calls.push(url);
				// Reflect the new URL back onto location so a later read observes the scrub.
				const q = url.indexOf("?");
				const h = url.indexOf("#");
				location.search = q >= 0 ? (h >= 0 ? url.slice(q, h) : url.slice(q)) : "";
			},
		},
		calls,
	};
}

beforeEach(() => {
	hadWindow = "window" in globalThis;
	savedWindow = (globalThis as any).window;
	_resetServedTokenForTests();
});

afterEach(() => {
	if (hadWindow) (globalThis as any).window = savedWindow;
	else delete (globalThis as any).window;
	_resetServedTokenForTests();
});

describe("servedToken — capture once, scrub from the address bar", () => {
	it("returns the token from the URL and strips ONLY the token param from the address bar", () => {
		const w = fakeWindow("?token=deadbeef&session=s1");
		(globalThis as any).window = w;

		expect(servedToken()).toBe("deadbeef");
		// history.replaceState was called once, and the token is gone but other params remain.
		expect(w.calls.length).toBe(1);
		expect(w.location.search).toBe("?session=s1");
		expect(w.location.search).not.toContain("token");
	});

	it("preserves the path and hash while scrubbing the token", () => {
		const w = fakeWindow("?token=abc", "/somewhere", "#frag");
		(globalThis as any).window = w;

		expect(servedToken()).toBe("abc");
		expect(w.calls[0]).toBe("/somewhere#frag"); // no query left, hash + path preserved
	});

	it("memoizes: later reads return the token even after it is gone from the URL (clobber-resistant)", () => {
		const w = fakeWindow("?token=keepme");
		(globalThis as any).window = w;

		expect(servedToken()).toBe("keepme"); // first read captures + strips
		expect(w.location.search).toBe(""); // now scrubbed from the URL
		expect(servedToken()).toBe("keepme"); // still forwarded (WS dial + /sessions poll)
		expect(servedToken()).toBe("keepme");
		expect(w.calls.length).toBe(1); // scrub happens exactly once, not on every read
	});

	it("returns null and never touches history when the page carries no token", () => {
		const w = fakeWindow("?session=s1");
		(globalThis as any).window = w;

		expect(servedToken()).toBe(null);
		expect(w.calls.length).toBe(0); // nothing to strip → no replaceState
		expect(w.location.search).toBe("?session=s1"); // untouched
	});

	it("is best-effort: a throwing history still yields the captured token", () => {
		const location = { pathname: "/", search: "?token=xyz", hash: "" };
		(globalThis as any).window = {
			location,
			get history(): never {
				throw new Error("history unavailable");
			},
		};
		// Capture happens before the history access throws, so the token is still returned.
		expect(servedToken()).toBe("xyz");
	});
});
