/*
 * controllerUi.svelte.ts — client UX decisions for the single-controller lease (v16, ADR 0024,
 * spec Part 3). `liveClient.svelte.ts` owns the wire-facing `controllerState`/`isController`/
 * `claimController` primitives (task 1); this module is the UI layer built ON TOP of them:
 *
 *   • `decideAutoClaim` — the pure "what should THIS surface do on hello" predicate (silent claim
 *     vs. the one-time takeover popup vs. nothing). No Svelte, no I/O — trivially unit-testable.
 *   • `evaluateHelloController` / `noteControllerBroadcast` — wire that decision (plus the
 *     sessionStorage "shown once" gate and the demotion toast) into the reactive `$state` below.
 *   • `attemptSteer` — the single choke point every steering control (map tile, transcript row,
 *     the FOLDING arm, the conductor picker, the BUDGET/PROTECT dials) routes a mutation attempt
 *     through: blocked → flash the read-only hint and never call the action; allowed → call it.
 *
 * Deliberately does NOT import from `liveClient.svelte.ts` — that module already imports THIS one
 * (to drive the hello/controller handlers), and a two-way import would cycle. Components that need
 * to actually SEND a claim (the takeover popup's "Take control", the demotion toast's "Take back",
 * the header's "TAKE CONTROL" button) import `claimController` from `liveClient.svelte.ts` directly.
 */
import type { ControllerInfo } from "$core/protocol";

/** What a connecting/reconnecting surface should do about the controller lease it just learned
 *  about: silently take it (nothing was contesting it), ask first (someone else holds it live), or
 *  do nothing (we already hold it). */
export type AutoClaimDecision = "claim" | "popup" | "noop";

/**
 * The auto-claim decision core (spec Part 3, bullet 1): null/stale lease → claim silently; a fresh
 * lease held by a DIFFERENT surface → ask (the takeover popup); a fresh lease already held by US
 * (a reconnect, a sidebar session switch that dials a different session's extension) → nothing to
 * do. Pure and framework-free so it can be tested without any Svelte/DOM setup.
 */
export function decideAutoClaim(info: ControllerInfo | null, mySurfaceId: string): AutoClaimDecision {
	if (!info || !info.fresh) return "claim";
	if (info.surfaceId === mySurfaceId) return "noop";
	return "popup";
}

// ── the one-time takeover popup ──────────────────────────────────────────────
const POPUP_SEEN_KEY = "accordion_takeover_popup_seen";

// Read through `window.sessionStorage` (not the bare global) — the same seam `mySurfaceId()`
// uses for `localStorage` in liveClient.svelte.ts, so tests shim `globalThis.window` once and
// both modules pick it up identically.
function sessionFlagSet(key: string): boolean {
	try {
		return typeof window !== "undefined" && window.sessionStorage?.getItem(key) === "1";
	} catch {
		return false; // storage unavailable (SSR / private mode) — never let that block the popup
	}
}
function setSessionFlag(key: string): void {
	try {
		window?.sessionStorage?.setItem(key, "1");
	} catch {
		/* best-effort only — worst case the popup can show again this tab */
	}
}
/** Test-only escape hatch: resets the "seen" flag between test cases. */
export function _resetPopupSeenForTests(): void {
	try {
		window?.sessionStorage?.removeItem(POPUP_SEEN_KEY);
	} catch {
		/* ignore */
	}
}

export const takeoverPopup = $state<{ show: boolean; label: string }>({ show: false, label: "" });

/**
 * Called from `liveClient`'s `hello` handler with the just-adopted `controllerState.info`. Decides
 * auto-claim vs. the popup vs. nothing (`decideAutoClaim`), and — for "popup" — shows it AT MOST
 * once per browser tab (sessionStorage; spec: "dismissal remembered... after dismissal, the header
 * TAKE CONTROL button is the only affordance"). Returns the decision so the caller can act on
 * "claim" (this module never imports `claimController` — see the file banner).
 */
export function evaluateHelloController(info: ControllerInfo | null, mySurfaceId: string): AutoClaimDecision {
	const decision = decideAutoClaim(info, mySurfaceId);
	if (decision === "popup" && !sessionFlagSet(POPUP_SEEN_KEY)) {
		setSessionFlag(POPUP_SEEN_KEY); // shown once — set the instant we decide to show it, not on dismiss
		takeoverPopup.show = true;
		takeoverPopup.label = info?.label ?? "";
	} else {
		takeoverPopup.show = false;
	}
	return decision;
}

export function dismissTakeoverPopup(): void {
	takeoverPopup.show = false;
}

// ── the demotion toast ───────────────────────────────────────────────────────
const DEMOTION_TOAST_MS = 8_000;
export const demotionToast = $state<{ show: boolean; label: string }>({ show: false, label: "" });
let demotionTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Called from `liveClient`'s `controller` broadcast handler BEFORE it overwrites
 * `controllerState.info`: if WE held the fresh lease and the broadcast names a different surface,
 * show the demotion toast (spec Part 3, bullet 5). Never fires for a broadcast we didn't lose
 * anything to (we were never the fresh holder, or the broadcast is just confirming our own claim).
 */
export function noteControllerBroadcast(
	prev: ControllerInfo | null,
	next: { surfaceId: string; label: string },
	mySurfaceId: string,
): void {
	const wasMine = !!prev && prev.fresh && prev.surfaceId === mySurfaceId;
	if (!wasMine || next.surfaceId === mySurfaceId) return;
	demotionToast.show = true;
	demotionToast.label = next.label;
	clearTimeout(demotionTimer);
	demotionTimer = setTimeout(() => {
		demotionToast.show = false;
	}, DEMOTION_TOAST_MS);
}

export function dismissDemotionToast(): void {
	demotionToast.show = false;
	clearTimeout(demotionTimer);
	demotionTimer = undefined;
}

// ── blocked-interaction feedback ─────────────────────────────────────────────
const BLOCKED_HINT_MS = 1800;
export const blockedHint = $state<{ show: boolean; text: string; x: number; y: number }>({
	show: false,
	text: "",
	x: 0,
	y: 0,
});
let blockedTimer: ReturnType<typeof setTimeout> | undefined;

/** The fixed copy every blocked-interaction hint uses — the verb is the only thing that adapts
 *  (spec: "…to fold" / "…to steer" / "…to arm" / "…to set budget"). Never says "view-only". */
export function readOnlyTip(verb: string): string {
	return `READ-ONLY — take control to ${verb}`;
}

export function flashBlockedHint(verb: string, x: number, y: number): void {
	blockedHint.text = readOnlyTip(verb);
	blockedHint.x = x;
	blockedHint.y = y;
	blockedHint.show = true;
	clearTimeout(blockedTimer);
	blockedTimer = setTimeout(() => {
		blockedHint.show = false;
	}, BLOCKED_HINT_MS);
}

/** For a hint with no natural anchor point (a server-side `commandResult.refused:"read-only"` —
 *  see `attemptSteer`'s doc comment) — centered near the top of the viewport. */
export function flashBlockedHintCenter(verb: string): void {
	const x = typeof window !== "undefined" && window.innerWidth ? window.innerWidth / 2 : 0;
	flashBlockedHint(verb, x, 96);
}

export function dismissBlockedHint(): void {
	blockedHint.show = false;
	clearTimeout(blockedTimer);
	blockedTimer = undefined;
}

/**
 * The single choke point every steering control (map tile / transcript double-click, the FOLDING
 * arm, the conductor picker, the BUDGET/PROTECT dials + the protect handle) routes a mutation
 * attempt through. `live` is the wire-controlled flag (`store.wireControlled`, or equivalently
 * `live.status === "connected"`) — a CC/demo/file session is never gated (there is no controller
 * lease for those; spec: "Demo/CC/file sessions keep today's behavior everywhere"). When blocked,
 * `action` is NEVER called (spec: "do NOT send commands that will be refused") and the read-only
 * hint flashes at the interaction's coordinates. Returns whether the action ran, in case a caller
 * wants to know (most don't). The server's `refused:"read-only"` on a `commandResult` is the real
 * boundary for a race this client-side gate misses (see `flashBlockedHintCenter`, wired in
 * `liveClient`'s `commandResult` handling) — this function is the client-side mirror, not a
 * replacement for it.
 */
export function attemptSteer(
	opts: { live: boolean; isController: boolean; verb: string; x: number; y: number },
	action: () => void,
): boolean {
	if (opts.live && !opts.isController) {
		flashBlockedHint(opts.verb, opts.x, opts.y);
		return false;
	}
	action();
	return true;
}

/** Reset every transient UI-decision state this module owns — called alongside liveClient's own
 *  reset (connect start + disconnect) so a stale popup/toast/hint from a prior connection never
 *  lingers into a fresh one. Does NOT touch the sessionStorage "seen" flag — that is deliberately
 *  tab-lifetime, not connection-lifetime (spec: shows at most once per browser tab). */
export function resetControllerUi(): void {
	takeoverPopup.show = false;
	dismissDemotionToast();
	dismissBlockedHint();
}
