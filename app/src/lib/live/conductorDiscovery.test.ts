import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ConductorEntry } from "./registry";

/*
 * conductorDiscovery.test.ts — the launch watchdog / "launching forever" deadlock guard.
 *
 * The original bug: `launch_conductor` returns Ok the instant `node` spawns. If the process
 * then never advertises a heartbeat, `isLaunching(id)` stays true forever, the +page.svelte
 * attach effect holds, and the agent runs with NO conductor behind a perpetual "Launching…"
 * spinner. The frontend watchdog (LAUNCH_TIMEOUT_MS) is the safety net; this exercises it.
 *
 * We mock the Tauri `invoke` import so launch/poll never touch native, and use fake timers so
 * the 12s watchdog fires deterministically. We drive the REAL `poll()` (exported for this test)
 * to prove the discovery path cancels the watchdog.
 */

// The discovery module dynamically imports "@tauri-apps/api/core" for `invoke`. Mock it so
// launch_conductor / list_conductors resolve to whatever the test sets, never hitting native.
let invokeImpl: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> = async () => undefined;
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (cmd: string, args?: Record<string, unknown>) => invokeImpl(cmd, args),
}));

// Import AFTER the mock is registered.
import {
	launchConductor,
	isLaunching,
	launchFailures,
	poll,
	conductorDiscovery,
	stopConductor,
	LAUNCH_TIMEOUT_MS,
} from "./conductorDiscovery.svelte";

function liveEntry(id: string): ConductorEntry {
	return {
		registryProtocol: 1,
		conductorProtocol: 3,
		id,
		label: id,
		url: `ws://127.0.0.1:7700`,
		pid: 1234,
		startedAt: Date.now(),
		heartbeatAt: Date.now(), // fresh — passes isLiveConductor staleness check
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	// Reset shared module state between tests (it's a singleton store).
	conductorDiscovery.discovered = [];
	for (const k of Object.keys(launchFailures)) delete launchFailures[k];
	invokeImpl = async () => undefined;
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("launchConductor synchronous state-arming (HIGH bugs #1 and #2)", () => {
	it("launchConductor arms launchingSet and clears prior failure synchronously (before any await)", () => {
		const id = "sync-arm-test";

		// Pre-seed a prior failure so we can confirm delete launchFailures[id] runs synchronously.
		launchFailures[id] = "previous failure message";

		// invokeImpl resolves immediately for both commands — this test only cares about state
		// that is armed before the first await; the post-await path (watchdog) runs cleanly.
		invokeImpl = async (cmd) => {
			if (cmd === "launch_conductor") return undefined;
			return undefined;
		};

		// Call WITHOUT awaiting. JS guarantees an async function runs synchronously up to its
		// first `await`, so the three arming lines (clearLaunchWatchdog / delete launchFailures /
		// launchingSet.add) have already executed by the time control returns here. This is the
		// invariant that closes both HIGH bugs: no Svelte effect can flush between
		// setActiveConductor(id) and the point where launchingSet.add(id) is visible, because
		// the add now happens before the first await in launchConductor.
		const _p = launchConductor(id);

		// Assertions run synchronously — before any microtask from the async chain resolves.
		expect(isLaunching(id)).toBe(true);       // launchingSet.add(id) ran synchronously
		expect(id in launchFailures).toBe(false); // delete launchFailures[id] ran synchronously

		// Return the promise so vitest waits for it (avoids unhandled-rejection noise from the
		// watchdog setTimeout that fires if we abandon it mid-flight).
		return _p;
	});
});

describe("launch watchdog — discovery cancels it (the happy path)", () => {
	it("launch resolves → isLaunching true → poll discovers → launching clears and watchdog is cancelled", async () => {
		const id = "recency-folder";
		// launch_conductor resolves Ok (process spawned); list_conductors will report it live.
		invokeImpl = async (cmd) => {
			if (cmd === "launch_conductor") return undefined; // spawned ok
			if (cmd === "list_conductors") return [liveEntry(id)];
			return undefined;
		};

		await launchConductor(id);
		// Spawned ok but not yet discovered → marked launching, watchdog armed.
		expect(isLaunching(id)).toBe(true);
		expect(id in launchFailures).toBe(false);

		// Discovery sees the heartbeat → clears launching AND cancels the watchdog.
		await poll();
		expect(isLaunching(id)).toBe(false);
		expect(conductorDiscovery.discovered.some((c) => c.id === id)).toBe(true);

		// Prove the watchdog was cancelled: advancing past the timeout records NO failure.
		vi.advanceTimersByTime(LAUNCH_TIMEOUT_MS + 1000);
		expect(id in launchFailures).toBe(false);
		expect(isLaunching(id)).toBe(false);
	});
});

describe("launch watchdog — fires when the conductor never connects (the deadlock guard)", () => {
	it("launch resolves → id never discovered → after LAUNCH_TIMEOUT_MS launching clears and a failure is recorded", async () => {
		const id = "attention-folder";
		// launch_conductor resolves Ok, but the conductor never advertises (list stays empty).
		invokeImpl = async (cmd) => {
			if (cmd === "launch_conductor") return undefined;
			if (cmd === "list_conductors") return [];
			return undefined;
		};

		await launchConductor(id);
		expect(isLaunching(id)).toBe(true);
		expect(id in launchFailures).toBe(false);

		// A poll that does NOT discover it must leave the watchdog armed.
		await poll();
		expect(isLaunching(id)).toBe(true);

		// Fire the watchdog.
		vi.advanceTimersByTime(LAUNCH_TIMEOUT_MS + 1);

		// Outcome 1: launching cleared (so the attach effect stops holding and falls back).
		expect(isLaunching(id)).toBe(false);
		// Outcome 2: a user-facing failure recorded for the menu to surface.
		expect(launchFailures[id]).toMatch(/never connected/);
	});

	it("a direct launch reject clears launching without arming a watchdog", async () => {
		const id = "broken-conductor";
		invokeImpl = async (cmd) => {
			if (cmd === "launch_conductor") throw "Conductor 'broken-conductor' isn't set up yet. Run `npm install`…";
			return undefined;
		};

		await expect(launchConductor(id)).rejects.toBeTruthy();
		// Reject path: launching cleared immediately, no watchdog, no silent failure entry.
		expect(isLaunching(id)).toBe(false);
		vi.advanceTimersByTime(LAUNCH_TIMEOUT_MS + 1000);
		expect(id in launchFailures).toBe(false);
	});

	it("stopConductor cancels a pending watchdog so a deliberate stop never trips a false failure", async () => {
		const id = "recency-folder";
		invokeImpl = async (cmd) => {
			if (cmd === "launch_conductor") return undefined;
			if (cmd === "stop_conductor") return undefined;
			if (cmd === "list_conductors") return [];
			return undefined;
		};

		await launchConductor(id);
		expect(isLaunching(id)).toBe(true);

		// User stops it before discovery — must cancel the watchdog.
		await stopConductor(id);
		expect(isLaunching(id)).toBe(false);

		vi.advanceTimersByTime(LAUNCH_TIMEOUT_MS + 1000);
		expect(id in launchFailures).toBe(false);
	});
});
