/*
 * conductorDiscovery.svelte.ts — finding conductors to switch to (ADR 0007).
 *
 * Two sources, merged into one "available" list for the switcher:
 *  1. DISCOVERED — local conductors that advertise themselves in ~/.accordion/conductors/.
 *     Found by polling the native `list_conductors` command (desktop only), exactly as
 *     `discovery.svelte.ts` polls `list_sessions` for pi sessions.
 *  2. CONFIGURED — `ws://` URLs the user added by hand (persisted in localStorage). This is
 *     how you reach a remote conductor, and the only way to connect one in plain browser
 *     dev, where the registry under ~/.accordion can't be read.
 *
 * The built-in conductor is NOT listed here — it is always available in-process and the UI
 * prepends it. This module only surfaces the external ones.
 */
import { isTauriEnv } from "../session.svelte";
import { isLiveConductor, type ConductorEntry, REGISTRY_PROTOCOL } from "./registry";
import { CONDUCTOR_PROTOCOL_VERSION } from "$conductors/contract";

export const conductorDiscovery = $state<{
	discovered: ConductorEntry[];
	configured: ConductorEntry[];
	ready: boolean;
}>({
	discovered: [],
	configured: loadConfigured(),
	ready: false,
});

const POLL_MS = 3000; // conductors change rarely; a slower beat than session discovery is plenty
const CONFIG_KEY = "accordion.conductors.configured";

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let _timer: ReturnType<typeof setInterval> | null = null;
let _invoke: InvokeFn | null = null;
let _polling = false;

async function getInvoke(): Promise<InvokeFn> {
	if (_invoke) return _invoke;
	const mod = await import("@tauri-apps/api/core");
	_invoke = mod.invoke as unknown as InvokeFn;
	return _invoke;
}

/** All conductors the user can switch to, discovered first then configured, deduped by id. */
export function allConductors(): ConductorEntry[] {
	const seen = new Set<string>();
	const out: ConductorEntry[] = [];
	for (const c of [...conductorDiscovery.discovered, ...conductorDiscovery.configured]) {
		if (seen.has(c.id)) continue;
		seen.add(c.id);
		out.push(c);
	}
	return out;
}

async function poll(): Promise<void> {
	if (_polling) return;
	_polling = true;
	try {
		const invoke = await getInvoke();
		if (!invoke) return;
		const raw = await invoke<unknown[]>("list_conductors");
		const now = Date.now();
		const live = raw.filter((e): e is ConductorEntry => isLiveConductor(e, now));
		live.sort((a, b) => a.startedAt - b.startedAt);
		if (!sameConductors(conductorDiscovery.discovered, live)) conductorDiscovery.discovered = live;
		conductorDiscovery.ready = true;
	} catch {
		/* not Tauri / command missing / transient — leave state untouched */
	} finally {
		_polling = false;
	}
}

export function startConductorDiscovery(): void {
	if (!isTauriEnv || _timer) return;
	void poll();
	_timer = setInterval(() => void poll(), POLL_MS);
}

export function stopConductorDiscovery(): void {
	if (_timer) {
		clearInterval(_timer);
		_timer = null;
	}
}

// ─── configured (hand-entered) conductors ──────────────────────────────────────

/** A stable id for a configured URL so selection survives reloads. */
function configuredId(url: string): string {
	return `cfg:${url}`;
}

/**
 * Add (or update the label of) a configured conductor URL. Returns its entry. A configured
 * conductor is always "available" — there is no heartbeat to go stale; the connection
 * attempt itself is the liveness test, surfaced via `conductorLink` once selected.
 */
export function addConfiguredConductor(url: string, label?: string): ConductorEntry | null {
	const trimmed = url.trim();
	if (!/^wss?:\/\//i.test(trimmed)) return null; // must be a ws:// or wss:// endpoint
	const id = configuredId(trimmed);
	const now = Date.now();
	const entry: ConductorEntry = {
		registryProtocol: REGISTRY_PROTOCOL,
		conductorProtocol: CONDUCTOR_PROTOCOL_VERSION,
		id,
		label: label?.trim() || trimmed.replace(/^wss?:\/\//i, ""),
		url: trimmed,
		pid: 0,
		startedAt: now,
		heartbeatAt: now,
	};
	conductorDiscovery.configured = [...conductorDiscovery.configured.filter((c) => c.id !== id), entry];
	persistConfigured();
	return entry;
}

export function removeConfiguredConductor(id: string): void {
	conductorDiscovery.configured = conductorDiscovery.configured.filter((c) => c.id !== id);
	persistConfigured();
}

function persistConfigured(): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(CONFIG_KEY, JSON.stringify(conductorDiscovery.configured));
	} catch {
		/* storage full / blocked — configured conductors just won't persist */
	}
}

function loadConfigured(): ConductorEntry[] {
	if (typeof localStorage === "undefined") return [];
	try {
		const raw = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "[]");
		if (!Array.isArray(raw)) return [];
		// Tolerate older/partial shapes: keep only entries with a usable url + id.
		return raw.filter((c) => c && typeof c.url === "string" && typeof c.id === "string");
	} catch {
		return [];
	}
}

/** True when two conductor lists match in every field the switcher renders or dials. */
function sameConductors(a: ConductorEntry[], b: ConductorEntry[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i].id !== b[i].id || a[i].label !== b[i].label || a[i].url !== b[i].url) return false;
	}
	return true;
}
