import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	decideAutoClaim,
	evaluateHelloController,
	noteControllerBroadcast,
	attemptSteer,
	takeoverPopup,
	demotionToast,
	blockedHint,
	dismissTakeoverPopup,
	dismissDemotionToast,
	dismissBlockedHint,
	resetControllerUi,
	readOnlyTip,
	_resetPopupSeenForTests,
} from "./controllerUi.svelte";
import type { ControllerInfo } from "$core/protocol";

/*
 * controllerUi.test.ts — the UI-facing decision layer built on top of the v16 controller lease
 * (ADR 0024). Two things are load-bearing here and both are pure/deterministic enough to unit-test
 * without mounting a single Svelte component:
 *   1. `decideAutoClaim` — null/stale → claim; fresh+other → popup; fresh+mine → no-op.
 *   2. `attemptSteer` — the client-side mutation gate every steering control routes through.
 */

const ME = "surface-me";
const OTHER = "surface-other";

function info(over: Partial<ControllerInfo> = {}): ControllerInfo {
	return { surfaceId: OTHER, label: "Desktop app", fresh: true, ...over };
}

/** A minimal in-memory Storage stand-in — vitest's "node" environment has no real
 *  `sessionStorage`, and the module reads it via `window.sessionStorage` (see liveClient.svelte.ts's
 *  `mySurfaceId()` for the same convention with `localStorage`). */
function fakeStorage(): Storage {
	const m = new Map<string, string>();
	return {
		getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		clear: () => m.clear(),
		key: () => null,
		get length() {
			return m.size;
		},
	} as Storage;
}

let hadWindow: boolean;
let savedWindow: unknown;

beforeEach(() => {
	hadWindow = "window" in globalThis;
	savedWindow = (globalThis as any).window;
	(globalThis as any).window = { sessionStorage: fakeStorage() };
	_resetPopupSeenForTests();
	resetControllerUi();
});

afterEach(() => {
	if (hadWindow) (globalThis as any).window = savedWindow;
	else delete (globalThis as any).window;
});

describe("decideAutoClaim — the pure auto-claim/popup/no-op predicate", () => {
	it("claims silently when there is no lease at all", () => {
		expect(decideAutoClaim(null, ME)).toBe("claim");
	});

	it("claims silently when the lease is stale (fresh:false)", () => {
		expect(decideAutoClaim(info({ fresh: false, surfaceId: OTHER }), ME)).toBe("claim");
	});

	it("asks (popup) when the lease is fresh and held by a DIFFERENT surface", () => {
		expect(decideAutoClaim(info({ fresh: true, surfaceId: OTHER }), ME)).toBe("popup");
	});

	it("does nothing when the lease is fresh and already held by US", () => {
		expect(decideAutoClaim(info({ fresh: true, surfaceId: ME }), ME)).toBe("noop");
	});
});

describe("evaluateHelloController — wiring the decision into the one-time popup", () => {
	it("shows the popup on a fresh-other lease, exactly once per tab (sessionStorage gate)", () => {
		const decision = evaluateHelloController(info({ surfaceId: OTHER, label: "Desktop app" }), ME);
		expect(decision).toBe("popup");
		expect(takeoverPopup.show).toBe(true);
		expect(takeoverPopup.label).toBe("Desktop app");

		// A second hello with the same contested state must NOT re-show it (already "seen" this tab).
		takeoverPopup.show = false;
		const decision2 = evaluateHelloController(info({ surfaceId: OTHER, label: "Desktop app" }), ME);
		expect(decision2).toBe("popup");
		expect(takeoverPopup.show).toBe(false);
	});

	it("returns 'claim' for null/stale and clears any stale popup flag", () => {
		takeoverPopup.show = true;
		expect(evaluateHelloController(null, ME)).toBe("claim");
		expect(takeoverPopup.show).toBe(false);
	});

	it("returns 'noop' when the fresh lease is already ours and clears any stale popup flag", () => {
		takeoverPopup.show = true;
		expect(evaluateHelloController(info({ surfaceId: ME, fresh: true }), ME)).toBe("noop");
		expect(takeoverPopup.show).toBe(false);
	});
});

describe("noteControllerBroadcast — the demotion toast", () => {
	it("shows the toast when we held the fresh lease and the broadcast names someone else", () => {
		const prev: ControllerInfo = { surfaceId: ME, label: "Browser tab", fresh: true };
		noteControllerBroadcast(prev, { surfaceId: OTHER, label: "Desktop app" }, ME);
		expect(demotionToast.show).toBe(true);
		expect(demotionToast.label).toBe("Desktop app");
	});

	it("does nothing when we never held the lease (some other handoff we're just observing)", () => {
		const prev: ControllerInfo = { surfaceId: "surface-third", label: "Browser tab", fresh: true };
		noteControllerBroadcast(prev, { surfaceId: OTHER, label: "Desktop app" }, ME);
		expect(demotionToast.show).toBe(false);
	});

	it("does nothing when the broadcast is just confirming our own claim", () => {
		const prev: ControllerInfo = { surfaceId: ME, label: "Browser tab", fresh: true };
		noteControllerBroadcast(prev, { surfaceId: ME, label: "Browser tab" }, ME);
		expect(demotionToast.show).toBe(false);
	});

	it("does nothing when our prior lease was stale (we didn't actually hold it live)", () => {
		const prev: ControllerInfo = { surfaceId: ME, label: "Browser tab", fresh: false };
		noteControllerBroadcast(prev, { surfaceId: OTHER, label: "Desktop app" }, ME);
		expect(demotionToast.show).toBe(false);
	});
});

describe("attemptSteer — the client-side mutation gate every steering control routes through", () => {
	it("runs the action and flashes nothing when this surface IS the controller", () => {
		const action = vi.fn();
		const ran = attemptSteer({ live: true, isController: true, verb: "fold", x: 10, y: 20 }, action);
		expect(ran).toBe(true);
		expect(action).toHaveBeenCalledOnce();
		expect(blockedHint.show).toBe(false);
	});

	it("runs the action when not live at all (CC/demo/file — never gated)", () => {
		const action = vi.fn();
		const ran = attemptSteer({ live: false, isController: false, verb: "fold", x: 0, y: 0 }, action);
		expect(ran).toBe(true);
		expect(action).toHaveBeenCalledOnce();
		expect(blockedHint.show).toBe(false);
	});

	it("blocks the action and flashes the read-only hint at the given coordinates when live and NOT controller", () => {
		const action = vi.fn();
		const ran = attemptSteer({ live: true, isController: false, verb: "fold", x: 42, y: 99 }, action);
		expect(ran).toBe(false);
		expect(action).not.toHaveBeenCalled();
		expect(blockedHint.show).toBe(true);
		expect(blockedHint.text).toBe(readOnlyTip("fold"));
		expect(blockedHint.x).toBe(42);
		expect(blockedHint.y).toBe(99);
	});

	it("adapts the verb in the hint text (steer/arm/set budget) without ever saying 'view-only'", () => {
		attemptSteer({ live: true, isController: false, verb: "arm", x: 0, y: 0 }, () => {});
		expect(blockedHint.text).toBe("READ-ONLY — take control to arm");
		expect(blockedHint.text.toLowerCase()).not.toContain("view-only");

		attemptSteer({ live: true, isController: false, verb: "set budget", x: 0, y: 0 }, () => {});
		expect(blockedHint.text).toBe("READ-ONLY — take control to set budget");
	});
});

describe("dismiss* + resetControllerUi", () => {
	it("dismissTakeoverPopup / dismissDemotionToast / dismissBlockedHint each clear their own flag", () => {
		takeoverPopup.show = true;
		demotionToast.show = true;
		blockedHint.show = true;
		dismissTakeoverPopup();
		dismissDemotionToast();
		dismissBlockedHint();
		expect(takeoverPopup.show).toBe(false);
		expect(demotionToast.show).toBe(false);
		expect(blockedHint.show).toBe(false);
	});

	it("resetControllerUi clears all three without touching the sessionStorage seen-flag", () => {
		evaluateHelloController(info({ surfaceId: OTHER }), ME); // marks popup as "seen" this tab
		demotionToast.show = true;
		blockedHint.show = true;
		resetControllerUi();
		expect(takeoverPopup.show).toBe(false);
		expect(demotionToast.show).toBe(false);
		expect(blockedHint.show).toBe(false);
		// The tab already "saw" the popup — a fresh-other hello must not re-show it post-reset.
		expect(evaluateHelloController(info({ surfaceId: OTHER }), ME)).toBe("popup");
		expect(takeoverPopup.show).toBe(false);
	});
});
