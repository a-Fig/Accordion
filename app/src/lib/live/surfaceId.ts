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
 * shared-id bug for the duplicate. So on startup — before this surface dials — we announce our id on
 * a BroadcastChannel and listen briefly: any OTHER live context that already owns the same id
 * answers "in-use", and the not-yet-dialed newcomer re-mints a fresh id into its own sessionStorage.
 * An ESTABLISHED / already-dialed context NEVER re-mints (it defends its id by answering "in-use");
 * only the newcomer moves. Everything here is FAILURE-OPEN: no BroadcastChannel support, or any
 * error, ⇒ we just proceed with the sessionStorage id.
 *
 * Framework-free (no runes) and dependency-free, so it is trivially unit-testable (surfaceId.test.ts).
 */
const SURFACE_ID_KEY = "accordion_surface_id";
const CHANNEL_NAME = "accordion-surface-id";
// How long a fresh (not-yet-dialed) surface stays willing to re-mint on a collision announcement.
// After this, an undialed-but-older tab defends its id instead of yielding to a later duplicate.
const DEDUPE_WINDOW_MS = 150;

type DedupeMessage = { kind: "id-check" | "in-use"; id: string; nonce: string };

let myId: string | null = null; // null until ensureInit() runs (or storage is unavailable)
let myNonce = "";
let dialed = false; // set once this surface actually dials the wire — an established context never re-mints
let windowOpen = false; // true only during the fresh-surface DEDUPE_WINDOW_MS listen
let channel: BroadcastChannel | null = null;
let initDone = false;
let windowTimer: ReturnType<typeof setTimeout> | undefined;

function mintId(): string {
	try {
		if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	} catch {
		/* fall through */
	}
	return `s-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Read the persisted id (per tab) or mint + persist a fresh one. Returns null iff storage threw
 *  (SSR is handled by the caller) — the surface then falls back to the volatile "ephemeral" id. */
function readOrMintId(): string | null {
	try {
		let id = window.sessionStorage.getItem(SURFACE_ID_KEY);
		if (!id) {
			id = mintId();
			window.sessionStorage.setItem(SURFACE_ID_KEY, id);
		}
		return id;
	} catch {
		return null; // storage unavailable (private mode / disabled) — caller returns "ephemeral"
	}
}

/** Re-mint a fresh id into our own sessionStorage — only ever called on the not-yet-dialed newcomer
 *  when a peer announces our id is already taken. Best-effort persist. */
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
 *  An id-check for our id ⇒ we own it, so answer "in-use"; and if we are the fresh newcomer, re-mint.
 *  An "in-use" for our id ⇒ a peer owns it; the fresh newcomer re-mints. */
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
		if (windowOpen && !dialed) remint();
	}
}

/** Open the dedupe channel, announce our id, and stay listening. Failure-open throughout. */
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
	postMessage({ kind: "id-check", id: myId!, nonce: myNonce });
	windowTimer = setTimeout(() => {
		windowOpen = false; // the newcomer window closed — from here we defend our id, never yield it
	}, DEDUPE_WINDOW_MS);
}

function ensureInit(): void {
	if (initDone) return;
	initDone = true;
	if (typeof window === "undefined") return; // SSR — mySurfaceId() returns "ephemeral"
	myId = readOrMintId();
	if (myId === null) return; // storage unavailable — no id to dedupe; "ephemeral" fallback
	myNonce = mintId();
	startDedupe();
}

/**
 * This surface's per-tab controller-lease id. Minted once into sessionStorage (survives this tab's
 * own reloads; a new/reopened tab is a new surface). Falls back to a volatile "ephemeral" id when
 * storage is unavailable (SSR / private mode) — such a surface simply can't hold the lease across
 * reloads, which is acceptable (ADR 0024 §5).
 */
export function mySurfaceId(): string {
	if (typeof window === "undefined") return "ephemeral";
	ensureInit();
	return myId ?? "ephemeral";
}

/** Called by `connectLive` when this surface actually dials the wire. From that point the id is
 *  FROZEN: an established/connected context never re-mints (it defends its id instead), so a late
 *  duplicate announcement can't move the lease out from under a live connection. Idempotent. */
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
	initDone = false;
}
