/*
 * surfaceId.ts — this surface's controller-lease identity (v16, ADR 0024).
 *
 * PER-TAB, not per-origin. The id lives in `sessionStorage` (NOT `localStorage`): sessionStorage is
 * scoped to a single tab/window, so two tabs open against the same origin get DISTINCT ids. That
 * distinction is load-bearing under the door (ADR 0024 §7): the door puts every surface on one
 * fixed origin, so a `localStorage` id — shared across all same-origin tabs — would hand two door
 * tabs the identical surface id, and the single-controller arbitration (§1–§6) would collapse: both
 * would render steerable and both would pass the server's `isControllerSocket` gate. sessionStorage
 * closes that hole.
 *
 * Consequences of sessionStorage, stated honestly:
 *   • The id survives THIS tab's own reloads (sessionStorage persists across F5), so a controller
 *     that reloads silently reclaims its own lease — the common case stays frictionless.
 *   • The Tauri desktop webview is a single long-lived window ⇒ exactly one surface, as before.
 *   • A tab that is CLOSED and later REOPENED is a NEW surface by design (fresh sessionStorage ⇒
 *     fresh id). This is deliberate: a reopened tab is genuinely a different surface, and the
 *     6s lease staleness window (ADR 0024 §5) frees the old lease for it to re-claim.
 *
 * Duplicate-tab hole + the BroadcastChannel guard. Browsers COPY sessionStorage when a tab is
 * DUPLICATED (Ctrl-clicking "Duplicate", and some `window.open` flows), which would recreate the
 * shared-id bug for the duplicate. So on init we announce our id on a BroadcastChannel and keep
 * listening: any OTHER live context that owns the same id answers "in-use", and an UNDIALED context
 * that learns its id is taken re-mints a fresh one into its own sessionStorage. A DIALED context
 * NEVER re-mints (it defends its id by answering "in-use") — a live connection's identity is frozen.
 *
 * ORDERING IS LOAD-BEARING: the in-use reply takes a few milliseconds, so a dial must not freeze
 * the id in the same synchronous frame as init (browser-served auto-connect does exactly that via
 * onMount → connectLive). `surfaceIdReady()` is the dial-side entry point: it waits out the short
 * dedupe window (during which an in-use reply can still re-mint), THEN freezes and hands out the
 * id. The app primes this module at bootstrap (`primeSurfaceId()`, +layout.svelte) so the window
 * has usually already elapsed by the time anything dials and the await is zero; the worst case is
 * one ≤150ms wait on the very first dial — imperceptible inside a connect.
 *
 * Everything here is FAILURE-OPEN: no BroadcastChannel support, or any error, ⇒ proceed with the
 * sessionStorage id immediately (no pointless wait).
 *
 * Framework-free (no runes) and dependency-free, so it is trivially unit-testable (surfaceId.test.ts).
 */
const SURFACE_ID_KEY = "accordion_surface_id";
const CHANNEL_NAME = "accordion-surface-id";
// How long surfaceIdReady() holds the first dial so a same-id owner's in-use reply can land and
// re-mint us first. Same-machine BroadcastChannel delivery is sub-ms; 150ms is generous.
const DEDUPE_WINDOW_MS = 150;

type DedupeMessage = { kind: "id-check" | "in-use"; id: string; nonce: string };

let myId: string | null = null; // null until ensureInit() runs (or storage is unavailable)
let myNonce = "";
let dialed = false; // set when the id is handed to a dial — a dialed context never re-mints
let windowOpen = false; // true only during the fresh-surface DEDUPE_WINDOW_MS listen
let windowElapsed: Promise<void> = Promise.resolve(); // resolves when the dedupe window closes (or never opened)
let channel: BroadcastChannel | null = null;
let initDone = false;
let windowTimer: ReturnType<typeof setTimeout> | undefined;
// P3: the storage-unavailable fallback is a VOLATILE per-context random id, not a shared constant —
// two private-mode tabs must not collide on a literal "ephemeral". The constant remains only for
// SSR (no window), which never dials.
let volatileFallback: string | null = null;

function mintId(): string {
	try {
		if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	} catch {
		/* fall through */
	}
	return `s-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** The volatile per-context id used when storage is unavailable (private mode / disabled). Random
 *  per JS context, so two such tabs still get distinct ids; lost on reload, which is acceptable. */
function ephemeralFallback(): string {
	if (volatileFallback === null) volatileFallback = mintId();
	return volatileFallback;
}

/** Read the persisted id (per tab) or mint + persist a fresh one. Returns null iff storage threw
 *  (SSR is handled by the callers) — the surface then runs on the volatile fallback id. */
function readOrMintId(): string | null {
	try {
		let id = window.sessionStorage.getItem(SURFACE_ID_KEY);
		if (!id) {
			id = mintId();
			window.sessionStorage.setItem(SURFACE_ID_KEY, id);
		}
		return id;
	} catch {
		return null; // storage unavailable — callers fall back to ephemeralFallback()
	}
}

/** Re-mint a fresh id into our own sessionStorage — only ever on an UNDIALED context that learned
 *  its id is already owned elsewhere. Best-effort persist. */
function remint(): void {
	const fresh = mintId();
	try {
		window.sessionStorage.setItem(SURFACE_ID_KEY, fresh);
	} catch {
		/* best-effort — worst case we run this tab on a volatile id */
	}
	myId = fresh;
}

function postMessage(msg: DedupeMessage): void {
	try {
		channel?.postMessage(msg);
	} catch {
		/* channel gone — dedupe is best-effort */
	}
}

/** Handle a peer announcement. We only ever act on messages about OUR CURRENT id from ANOTHER
 *  context (BroadcastChannel never echoes our own posts, but the nonce guard is belt-and-suspenders).
 *  • id-check for our id ⇒ we own it, so answer "in-use" (always); and if BOTH of us are fresh
 *    newcomers (our own startup window still open, not dialed), we re-mint too — simultaneous
 *    duplicates each move to a fresh id.
 *  • in-use for our id ⇒ a peer authoritatively owns it: any UNDIALED context re-mints, no matter
 *    how late the reply lands (the window gates only how long a dial is held, never reply
 *    handling). A DIALED context never re-mints — its id is frozen into a live connection. */
function onDedupeMessage(ev: MessageEvent): void {
	const msg = ev?.data as Partial<DedupeMessage> | undefined;
	if (!msg || typeof msg !== "object") return;
	if (typeof msg.id !== "string" || typeof msg.nonce !== "string") return;
	if (msg.nonce === myNonce) return; // our own post (defensive)
	if (msg.id !== myId) return; // not about our id
	if (msg.kind === "id-check") {
		postMessage({ kind: "in-use", id: myId, nonce: myNonce }); // defend our id (always — even once dialed)
		if (windowOpen && !dialed) remint();
	} else if (msg.kind === "in-use") {
		if (!dialed) remint();
	}
}

/** Open the dedupe channel, announce our id, and stay listening. Failure-open throughout: if the
 *  channel can't open, `windowElapsed` stays pre-resolved so surfaceIdReady() never waits for
 *  nothing. */
function startDedupe(): void {
	let BC: typeof BroadcastChannel | undefined;
	try {
		BC = typeof globalThis !== "undefined" ? (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel : undefined;
	} catch {
		BC = undefined;
	}
	if (!BC) return; // no BroadcastChannel support → proceed with the sessionStorage id (failure-open)
	try {
		channel = new BC(CHANNEL_NAME);
	} catch {
		channel = null;
		return; // failure-open
	}
	channel.onmessage = onDedupeMessage;
	windowOpen = true;
	windowElapsed = new Promise<void>((resolve) => {
		windowTimer = setTimeout(() => {
			windowOpen = false; // window over — an in-use reply STILL re-mints while undialed
			resolve();
		}, DEDUPE_WINDOW_MS);
	});
	postMessage({ kind: "id-check", id: myId!, nonce: myNonce });
}

function ensureInit(): void {
	if (initDone) return;
	initDone = true;
	if (typeof window === "undefined") return; // SSR — mySurfaceId() returns the constant guard value
	myId = readOrMintId();
	if (myId === null) return; // storage unavailable — volatile fallback; nothing to dedupe against
	myNonce = mintId();
	startDedupe();
}

/**
 * This surface's per-tab controller-lease id, as it stands RIGHT NOW. Minted once into
 * sessionStorage (survives this tab's own reloads; a new/reopened tab is a new surface). Falls back
 * to a volatile per-context id when storage is unavailable (private mode) and to the constant
 * "ephemeral" under SSR (which never dials). NOTE: before the surface has dialed, this value can
 * still change once (a duplicate-tab re-mint) — anything building DIAL params must go through
 * `surfaceIdReady()` / `surfaceIdIfSettled()` instead, which wait out the dedupe window and freeze.
 */
export function mySurfaceId(): string {
	if (typeof window === "undefined") return "ephemeral";
	ensureInit();
	return myId ?? ephemeralFallback();
}

/** Prime the module at app bootstrap (+layout.svelte onMount): runs init + starts the dedupe
 *  window WITHOUT freezing, so by the time anything dials the window has usually already elapsed
 *  and `surfaceIdReady()` resolves instantly. Safe to call any number of times. */
export function primeSurfaceId(): void {
	if (typeof window === "undefined") return;
	ensureInit();
}

/** The dial fast-path: the frozen id IFF the dedupe has already settled (window elapsed, already
 *  dialed, no channel, or no storage) — freezing it on the way out — else null (the caller must
 *  await `surfaceIdReady()`). Lets an already-settled connect stay fully synchronous. */
export function surfaceIdIfSettled(): string | null {
	if (typeof window === "undefined") return "ephemeral"; // SSR guard — never actually dials
	ensureInit();
	if (myId === null) {
		markSurfaceDialed();
		return ephemeralFallback(); // no storage ⇒ nothing another tab could have copied
	}
	if (dialed || !windowOpen) {
		markSurfaceDialed();
		return myId;
	}
	return null; // dedupe window still open — surfaceIdReady() must wait it out
}

/**
 * The dial-side entry point: resolves with this surface's id AFTER the dedupe window has elapsed
 * (immediately when it already has, or never opened), freezing the id via `markSurfaceDialed()` on
 * the way out. An `in-use` reply landing inside the window re-mints BEFORE the id is handed to the
 * dial — this is what makes the duplicate-tab guard effective for browser-served auto-connect,
 * which would otherwise freeze the copied id in the same synchronous frame as init.
 */
export function surfaceIdReady(): Promise<string> {
	const settled = surfaceIdIfSettled();
	if (settled !== null) return Promise.resolve(settled);
	return windowElapsed.then(() => {
		markSurfaceDialed();
		return myId ?? ephemeralFallback();
	});
}

/** Freeze this surface's id: from here on it NEVER re-mints (it defends its id on the channel
 *  instead), so a late duplicate announcement can't move the lease out from under a live
 *  connection. Called by `surfaceIdReady()`/`surfaceIdIfSettled()` when handing the id to a dial.
 *  Idempotent. */
export function markSurfaceDialed(): void {
	ensureInit();
	dialed = true;
	windowOpen = false;
}

/** Test-only: reset all module state (id, nonce, channel, timers) so each case starts fresh. */
export function _resetSurfaceIdForTests(): void {
	try {
		channel?.close();
	} catch {
		/* ignore */
	}
	if (windowTimer) {
		clearTimeout(windowTimer);
		windowTimer = undefined;
	}
	channel = null;
	myId = null;
	myNonce = "";
	dialed = false;
	windowOpen = false;
	windowElapsed = Promise.resolve();
	initDone = false;
	volatileFallback = null;
}
