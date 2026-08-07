import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { REGISTRY_PROTOCOL, type SessionEntry } from "./registry";
import { PROTOCOL_VERSION } from "$core/protocol";

/*
 * browserDiscovery.test.ts — poll-failure and mid-switch resilience (PR #52 review findings
 * #4 and #5).
 *
 * #4: a poll that fails outright (network error, non-ok status like a cookie-collision 403,
 * or a non-JSON body) must NOT publish `[]`. Doing so feeds discovery.svelte.ts's
 * publishSessions() reap-guard, which drops `discovery.selected` and disconnects whenever the
 * selected session goes missing from the list while status is "connected" or "connecting" —
 * including an in-flight session switch that has nothing to do with the poll. The fix holds the
 * last published list on any fetch failure instead.
 *
 * #5: the poll fetch now forwards the page's `?token=` (when present) as a query param, so a
 * poll survives the `accordion_token` cookie being clobbered by a sibling session's tab.
 *
 * We stub `window`/`fetch` (vitest's environment here is plain node — see vitest.config.ts) and
 * drive the real, exported `poll()` against the real `discovery`/`live` reactive state, the same
 * pattern liveClient.test.ts uses for its module.
 */

import { poll, __resetPollFailureStreakForTest } from "./browserDiscovery.svelte";
import { discovery, publishSessions, DEMO_ID } from "./discovery.svelte";
import { live } from "./liveClient.svelte";

// Fixed heartbeatAt (not Date.now()) so two separately-constructed "identical" entries always
// compare equal with toEqual — sameSessions() ignores heartbeatAt, but toEqual does not.
function entry(sessionId: string, port: number): SessionEntry {
	return {
		registryProtocol: REGISTRY_PROTOCOL,
		protocolVersion: PROTOCOL_VERSION,
		sessionId,
		port,
		pid: 111,
		cwd: "/tmp/proj",
		title: "t",
		model: "m",
		tokens: null,
		contextWindow: null,
		startedAt: 1,
		heartbeatAt: 1000,
	};
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		headers: { get: () => "application/json" },
		json: async () => body,
	} as unknown as Response;
}

let savedFetch: unknown;
let savedWindow: unknown;
let hadWindow: boolean;
let fetchImpl: (url: string, opts?: RequestInit) => Promise<Response>;

beforeEach(() => {
	savedFetch = (globalThis as any).fetch;
	hadWindow = "window" in globalThis;
	savedWindow = (globalThis as any).window;
	(globalThis as any).window = { location: { search: "" } };
	fetchImpl = async () => jsonResponse({ sessions: [] });
	(globalThis as any).fetch = (url: string, opts?: RequestInit) => fetchImpl(url, opts);

	discovery.sessions = [];
	discovery.selected = null;
	discovery.ready = false;
	live.status = "idle";
	live.sessionId = null;
	live.port = null;
	__resetPollFailureStreakForTest();
});

afterEach(() => {
	(globalThis as any).fetch = savedFetch;
	if (hadWindow) (globalThis as any).window = savedWindow;
	else delete (globalThis as any).window;
});

describe("poll() — hold last list on outright failure (finding #4)", () => {
	it("network error: does not publish [] and does not touch discovery.selected", async () => {
		const last = [entry("s1", 100)];
		publishSessions(last);
		discovery.selected = "s1";

		fetchImpl = async () => {
			throw new TypeError("network error");
		};
		await poll();

		expect(discovery.sessions).toEqual(last); // untouched
		expect(discovery.selected).toBe("s1");
	});

	it("non-ok status (403 cookie-collision): holds last list instead of publishing []", async () => {
		const last = [entry("s1", 100)];
		publishSessions(last);
		discovery.selected = "s1";

		fetchImpl = async () => jsonResponse({ error: "forbidden" }, false, 403);
		await poll();

		expect(discovery.sessions).toEqual(last);
		expect(discovery.selected).toBe("s1");
	});

	it("non-JSON body: holds last list instead of publishing []", async () => {
		const last = [entry("s1", 100)];
		publishSessions(last);
		discovery.selected = "s1";

		fetchImpl = async () =>
			({
				ok: true,
				status: 200,
				headers: { get: () => "text/plain" },
				json: async () => ({}),
			}) as unknown as Response;
		await poll();

		expect(discovery.sessions).toEqual(last);
		expect(discovery.selected).toBe("s1");
	});

	it("a genuinely successful empty response still publishes [] (not special-cased)", async () => {
		publishSessions([entry("s1", 100)]);
		discovery.selected = null; // nothing selected, so publishing [] is safe to observe directly

		fetchImpl = async () => jsonResponse({ sessions: [] });
		await poll();

		expect(discovery.sessions).toEqual([]);
	});

	it("malformed 200 JSON body (no sessions array): holds last list instead of publishing [] (finding #1)", async () => {
		const last = [entry("s1", 100)];
		publishSessions(last);
		discovery.selected = "s1";

		fetchImpl = async () => jsonResponse({ notSessions: "garbage" });
		await poll();

		expect(discovery.sessions).toEqual(last); // untouched
		expect(discovery.selected).toBe("s1");
	});
});

describe("poll() — sustained-failure threshold (finding #2)", () => {
	it("9 consecutive failures still hold the last list", async () => {
		const last = [entry("s1", 100)];
		publishSessions(last);
		discovery.selected = "s1";

		fetchImpl = async () => {
			throw new TypeError("network error");
		};
		for (let i = 0; i < 9; i++) {
			await poll();
		}

		expect(discovery.sessions).toEqual(last);
		expect(discovery.selected).toBe("s1");
	});

	it("the 10th consecutive failure publishes [] once, letting the reap proceed", async () => {
		const last = [entry("s1", 100)];
		publishSessions(last);
		discovery.selected = "s1";

		fetchImpl = async () => {
			throw new TypeError("network error");
		};
		for (let i = 0; i < 10; i++) {
			await poll();
		}

		expect(discovery.sessions).toEqual([]);
		expect(discovery.selected).toBeNull(); // reaped, same as a genuine empty response
	});

	it("a success mid-streak resets the counter, so the threshold doesn't trip early", async () => {
		const last = [entry("s1", 100)];
		publishSessions(last);
		discovery.selected = "s1";

		fetchImpl = async () => {
			throw new TypeError("network error");
		};
		for (let i = 0; i < 9; i++) {
			await poll();
		}
		expect(discovery.selected).toBe("s1"); // still held, one short of the threshold

		// A single successful poll resets the streak to 0.
		fetchImpl = async () => jsonResponse({ sessions: [entry("s1", 100)] });
		await poll();
		expect(discovery.selected).toBe("s1");

		// Another 9 failures should still just hold — if the counter hadn't reset, this would be
		// cumulative failures #10-18 and would have already tripped the threshold.
		fetchImpl = async () => {
			throw new TypeError("network error");
		};
		for (let i = 0; i < 9; i++) {
			await poll();
		}

		expect(discovery.sessions).not.toEqual([]);
		expect(discovery.selected).toBe("s1");
	});
});

describe("poll() — mid-switch protection while connecting (finding #4b)", () => {
	it("does not reap discovery.selected or disconnect while dialing a session absent from a real (successful) poll", async () => {
		// Session A is currently connected and listed; the sidebar switches to B.
		publishSessions([entry("a", 100)]);
		discovery.selected = "b"; // selectAndConnect sets this synchronously, before dialing
		live.status = "connecting"; // connectLive sets this synchronously too
		live.sessionId = null; // not yet known — hello hasn't arrived
		live.port = 200; // B's port

		// The server's poll response hasn't caught up yet: it still only lists A.
		fetchImpl = async () => jsonResponse({ sessions: [entry("a", 100)] });
		await poll();

		// B must not be reaped from discovery.selected (that would tear down the in-flight
		// connect via disconnectLive() inside publishSessions).
		expect(discovery.selected).toBe("b");
		// The published list carries a synthesized placeholder for B so the reap-guard sees it.
		expect(discovery.sessions.some((s) => s.sessionId === "b")).toBe(true);
		expect(discovery.sessions.some((s) => s.sessionId === "a")).toBe(true);
	});

	it("still reaps discovery.selected once the connect attempt has resolved to 'error' (pre-existing behavior unaffected)", async () => {
		// A dial to "b" failed outright (liveClient sets status "error" and clears sessionId on
		// failure — see liveClient.svelte.ts). localFallback() only synthesizes for
		// "connected"/"connecting", so a genuinely successful poll that still doesn't list "b"
		// must fall through to the real reap, same as before this fix.
		discovery.selected = "b";
		live.status = "error";
		live.sessionId = null;
		live.port = null;

		fetchImpl = async () => jsonResponse({ sessions: [] });
		await poll();

		expect(discovery.sessions).toEqual([]);
		expect(discovery.selected).toBeNull();
	});

	it("re-adds the connected session via the pre-existing fallback when a real poll misses it", async () => {
		publishSessions([entry("a", 100)]);
		discovery.selected = "a";
		live.status = "connected";
		live.sessionId = "a";
		live.port = 100;

		fetchImpl = async () => jsonResponse({ sessions: [] });
		await poll();

		// "a" itself is connected, so localFallback() re-adds it — this proves the existing
		// connected-fallback behavior (pre-existing, unrelated to this fix) is unaffected.
		expect(discovery.sessions.some((s) => s.sessionId === "a")).toBe(true);
		expect(discovery.selected).toBe("a");
	});

	it("does not synthesize a fallback for the demo session id while connecting", async () => {
		discovery.selected = DEMO_ID;
		live.status = "connecting";
		live.port = 200;

		fetchImpl = async () => jsonResponse({ sessions: [] });
		await poll();

		expect(discovery.sessions.some((s) => s.sessionId === DEMO_ID)).toBe(false);
	});
});

describe("poll() — forwards the URL token (finding #5)", () => {
	it("appends ?token= to the fetch URL when the page carries one", async () => {
		(globalThis as any).window = { location: { search: "?token=abc123" } };
		let seenUrl = "";
		fetchImpl = async (url: string) => {
			seenUrl = url;
			return jsonResponse({ sessions: [] });
		};

		await poll();

		expect(seenUrl).toBe("/__accordion/sessions?token=abc123");
	});

	it("omits the token param when the page has none", async () => {
		(globalThis as any).window = { location: { search: "" } };
		let seenUrl = "";
		fetchImpl = async (url: string) => {
			seenUrl = url;
			return jsonResponse({ sessions: [] });
		};

		await poll();

		expect(seenUrl).toBe("/__accordion/sessions");
	});
});

describe("poll() — fetch timeout (a hung connection must count as a failure, not a permanent freeze)", () => {
	it("aborts a fetch that outlives the timeout and treats it as a failed poll", async () => {
		vi.useFakeTimers();
		try {
			const last = [entry("s1", 100)];
			publishSessions(last);
			discovery.selected = "s1";

			// A half-open connection: the mock never settles on its own — only the abort signal
			// (which the real `fetch` would honor) ever rejects it.
			fetchImpl = (_url: string, opts?: RequestInit) =>
				new Promise((_resolve, reject) => {
					opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				});

			const pending = poll();
			await vi.advanceTimersByTimeAsync(4000);
			await pending;

			// Held, same as any other outright failure — not reaped, not published as [].
			expect(discovery.sessions).toEqual(last);
			expect(discovery.selected).toBe("s1");
		} finally {
			vi.useRealTimers();
		}
	});

	it("a hung poll counts toward the sustained-failure threshold like any other failure", async () => {
		vi.useFakeTimers();
		try {
			const last = [entry("s1", 100)];
			publishSessions(last);
			discovery.selected = "s1";

			fetchImpl = (_url: string, opts?: RequestInit) =>
				new Promise((_resolve, reject) => {
					opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				});

			for (let i = 0; i < 10; i++) {
				const pending = poll();
				await vi.advanceTimersByTimeAsync(4000);
				await pending;
			}

			// The 10th consecutive timeout gives up holding, same as the sustained-network-failure case.
			expect(discovery.sessions).toEqual([]);
			expect(discovery.selected).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});
