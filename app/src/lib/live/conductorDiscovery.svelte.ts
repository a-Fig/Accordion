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
 *
 * Launchable conductors (Tauri only): the native `list_launchable_conductors` command
 * returns conductors that can be started as child processes directly from within the app.
 * Their id/label match discovered entries once running — deduped by id in the menu.
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

/** Launchable conductors: ids that can be started via `launch_conductor`. Static on disk — loaded once. */
export const launchable = $state<{ id: string; label: string }[]>([]);

/** Ids currently being launched (started but not yet discovered). */
const launchingSet = $state<Set<string>>(new Set());

/**
 * Per-id launch failure messages, surfaced inline by the menu. Set by the WATCHDOG when a
 * launch resolves Ok (the process spawned) but never advertises a heartbeat — i.e. it crashed
 * after start, or its heartbeat dir doesn't match (ACCORDION_HOME drift). A direct reject of
 * `launch_conductor` is surfaced by the menu's own try/catch; this covers the silent path.
 */
export const launchFailures = $state<Record<string, string>>({});

const POLL_MS = 3000; // conductors change rarely; a slower beat than session discovery is plenty
const CONFIG_KEY = "accordion.conductors.configured";

/**
 * How long to wait, after `launch_conductor` resolves Ok, for the conductor to show up in
 * discovery before declaring the launch failed. The Rust side already catches a <400ms crash;
 * this guards the slower "spawned fine but never connected" case so the UI never hangs forever.
 */
export const LAUNCH_TIMEOUT_MS = 12_000;

/** Pending watchdog timers, keyed by conductor id. Module-level (NOT reactive — these are just handles). */
const launchWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

/** Cancel and forget the watchdog timer for `id`, if any. Safe to call when none is pending. */
function clearLaunchWatchdog(id: string): void {
	const t = launchWatchdogs.get(id);
	if (t !== undefined) {
		clearTimeout(t);
		launchWatchdogs.delete(id);
	}
}

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

/** True while the conductor with `id` has been launched but is not yet discovered. */
export function isLaunching(id: string): boolean {
	return launchingSet.has(id);
}

/**
 * Launch the conductor process with the given id via the Tauri command.
 * Marks the id as launching until discovery picks it up (clears in the poll).
 * Rejects with a user-facing error string if the native command fails.
 *
 * If the command RESOLVES (the process spawned) but the conductor never advertises a heartbeat
 * within LAUNCH_TIMEOUT_MS, a watchdog clears the launching flag and records a launch failure —
 * so a crash-after-start (or a heartbeat-dir mismatch) surfaces an error instead of a perpetual
 * "Launching…" spinner that holds the attach effect forever (the original deadlock).
 */
export async function launchConductor(id: string): Promise<void> {
	// Arm launching state SYNCHRONOUSLY before any await. handleLaunch calls setActiveConductor(id)
	// synchronously right before awaiting us; a Svelte effect could otherwise flush during the
	// await below and (a) attach Built-in for one cycle (no launching guard yet) or (b) see a
	// stale launchFailures[id] and revert to Built-in (forcing a second click). Arming first closes
	// both holes.
	clearLaunchWatchdog(id);
	if (id in launchFailures) delete launchFailures[id];
	launchingSet.add(id);

	const invoke = await getInvoke();
	try {
		await invoke("launch_conductor", { id });
	} catch (err) {
		// A direct reject (e.g. missing deps, immediate exit, command not found). Drop the
		// launching flag (armed above) and let the caller surface the error.
		launchingSet.delete(id);
		clearLaunchWatchdog(id);
		throw err;
	}
	// Spawned ok — stay marked launching while we wait for the heartbeat. The poll clears the
	// flag (and the watchdog) once discovery sees it; the watchdog fires if it never appears.
	clearLaunchWatchdog(id); // belt-and-suspenders: never stack two timers for one id
	launchWatchdogs.set(
		id,
		setTimeout(() => {
			launchWatchdogs.delete(id);
			// Only fail if it's still launching and still not discovered — a late discovery that
			// raced the timer (or a stop) will have already cleared the flag.
			if (!launchingSet.has(id)) return;
			launchingSet.delete(id);
			launchFailures[id] =
				`'${id}' started but never connected. It may have crashed — check its setup (npm install / Python venv).`;
		}, LAUNCH_TIMEOUT_MS),
	);
}

/**
 * Stop the conductor process with the given id via the Tauri command, and
 * immediately drop it from the local discovered list so the UI updates without
 * waiting for the stale-reap window (15 s).
 */
export async function stopConductor(id: string): Promise<void> {
	const invoke = await getInvoke();
	await invoke("stop_conductor", { id });
	// Eagerly remove from discovered so the UI reflects "stopped" immediately.
	conductorDiscovery.discovered = conductorDiscovery.discovered.filter((c) => c.id !== id);
	launchingSet.delete(id); // clean up in case it was still launching
	clearLaunchWatchdog(id); // a deliberate stop must not later trip a false "never connected"
	if (id in launchFailures) delete launchFailures[id];
}

// Exported for tests so the real discovery-clear path (which cancels a pending launch watchdog
// when the conductor shows up) can be driven directly without standing up the interval/Tauri env.
export async function poll(): Promise<void> {
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
		// Clear the launching flag (and cancel the watchdog) for any id now advertised in the
		// registry — discovery succeeded, so the launch did not fail.
		for (const c of live) {
			if (launchingSet.has(c.id)) launchingSet.delete(c.id);
			clearLaunchWatchdog(c.id);
			if (c.id in launchFailures) delete launchFailures[c.id];
		}
		conductorDiscovery.ready = true;
	} catch {
		/* not Tauri / command missing / transient — leave state untouched */
	} finally {
		_polling = false;
	}
}

async function loadLaunchable(): Promise<void> {
	try {
		const invoke = await getInvoke();
		const raw = await invoke<{ id: string; label: string; command: string; args: string[] }[]>(
			"list_launchable_conductors",
		);
		if (Array.isArray(raw)) {
			launchable.splice(0, launchable.length, ...raw.map(({ id, label }) => ({ id, label })));
		}
	} catch {
		/* command missing / not Tauri — leave launchable empty */
	}
}

export function startConductorDiscovery(): void {
	if (!isTauriEnv || _timer) return;
	void poll();
	void loadLaunchable();
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
