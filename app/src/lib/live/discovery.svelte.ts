/*
 * discovery.svelte.ts — the app side of the "pull" connection model.
 *
 * Polls the native `list_sessions` command (which reads ~/.accordion/sessions/),
 * keeps a reactive list of live pi sessions for the sidebar, reaps stale entries,
 * and consumes `/accordion` focus requests. Outside Tauri (plain browser dev) the
 * native commands don't exist, so this stays a silent no-op and the sidebar is
 * simply empty — discovery is a desktop-only capability by design.
 */
import { isTauriEnv } from "../session.svelte";
import { isLiveEntry, type SessionEntry, type FocusRequest } from "./registry";
import { disconnectLive, live as liveConn } from "./liveClient.svelte";

/**
 * Sentinel session id for the bundled demo transcript. It isn't a live pi
 * session, so the poller must never reap it from `discovery.selected` (see poll).
 */
export const DEMO_ID = "__demo__";

export const discovery = $state<{ sessions: SessionEntry[]; selected: string | null; ready: boolean }>({
	sessions: [],
	selected: null,
	ready: false,
});

const POLL_MS = 1000;
const FOCUS_TTL_MS = 4000; // keep a focus request pending until its session appears, then give up

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let _timer: ReturnType<typeof setInterval> | null = null;
let _invoke: InvokeFn | null = null;
let _onFocus: ((sessionId: string) => void) | null = null;
let _polling = false; // guard against overlapping polls if invoke ever stalls
// A consumed `/accordion` focus request, held in memory until its session shows
// up in the list. take_focus_request deletes the file on read, so if the session
// isn't listed yet we must NOT drop the request — we retry it across polls.
let _pendingFocus: { sessionId: string; since: number } | null = null;

async function getInvoke(): Promise<InvokeFn> {
	if (_invoke) return _invoke;
	const mod = await import("@tauri-apps/api/core");
	_invoke = mod.invoke as unknown as InvokeFn;
	return _invoke;
}

async function poll(): Promise<void> {
	if (_polling) return;
	_polling = true;
	try {
		const invoke = await getInvoke();
		if (!invoke) return;
		const raw = await invoke<unknown[]>("list_sessions");
		const now = Date.now();
		const live: SessionEntry[] = [];
		for (const e of raw) {
			if (isLiveEntry(e, now)) {
				live.push(e);
			} else if (e && typeof e === "object" && typeof (e as { sessionId?: unknown }).sessionId === "string") {
				// current-but-stale or old-protocol → reap so the folder stays clean.
				// (A merely-paused session self-heals: its next heartbeat rewrites the file.)
				invoke("reap_session", { sessionId: (e as { sessionId: string }).sessionId }).catch(() => {});
			}
		}
		live.sort((a, b) => a.startedAt - b.startedAt);
		discovery.sessions = live;
		discovery.ready = true;
		if (
			discovery.selected &&
			discovery.selected !== DEMO_ID &&
			!live.some((s) => s.sessionId === discovery.selected)
		) {
			discovery.selected = null; // the live session we were looking at is gone
				// The session we were attached to vanished (e.g. pi was SIGKILLed with no close
				// frame) - tear down the orphaned socket so we do not show a live view for a
				// dead session.
				if (liveConn.status === "connected" || liveConn.status === "connecting") disconnectLive();
		}

		// Consume any new focus request into the pending slot (replacing an older one).
		const req = await invoke<FocusRequest | null>("take_focus_request");
		if (req && typeof req.sessionId === "string") {
			_pendingFocus = { sessionId: req.sessionId, since: now };
		}
		// Satisfy a pending focus only once its session is actually listed, so a
		// request that arrives a beat before the session appears isn't lost. Bring
		// the window forward only when we genuinely select something.
		if (_pendingFocus) {
			if (live.some((s) => s.sessionId === _pendingFocus!.sessionId)) {
				const id = _pendingFocus.sessionId;
				_pendingFocus = null;
				_onFocus?.(id);
				invoke("focus_window").catch(() => {});
			} else if (now - _pendingFocus.since > FOCUS_TTL_MS) {
				_pendingFocus = null; // session never showed — drop it rather than focus an empty view
			}
		}
	} catch {
		/* not Tauri / command missing / transient — leave state untouched */
	} finally {
		_polling = false;
	}
}

export function startDiscovery(onFocus: (sessionId: string) => void): void {
	if (!isTauriEnv || _timer) return;
	_onFocus = onFocus;
	void poll();
	_timer = setInterval(() => void poll(), POLL_MS);
}

export function stopDiscovery(): void {
	if (_timer) {
		clearInterval(_timer);
		_timer = null;
	}
	_onFocus = null;
}

export function selectSession(sessionId: string | null): void {
	discovery.selected = sessionId;
}
