import { parse } from "./engine/parse";
import { AccordionStore } from "./engine/store.svelte";

/**
 * Reactive session state, shared across the app.
 *
 * Svelte forbids *exporting a reassignable `$state` binding* from a module
 * (`state_invalid_export`) — `export let store = $state(null); store = …` throws
 * at compile time. The supported cross-module pattern is to export a single
 * `$state` *object* and mutate its properties; property mutation stays reactive
 * for every consumer that reads `session.store`, `session.readOnly`, etc.
 */
export const session = $state<{
	store: AccordionStore | null;
	filePath: string | null;
	error: string;
	readOnly: boolean;
}>({
	store: null,
	filePath: null,
	error: "",
	readOnly: false,
});

let _pollInterval: ReturnType<typeof setInterval> | null = null;
let _lastLen = -1;
let _loadToken = 0;

/** Bump the generation token, invalidating any in-flight async load. */
export function cancelPendingLoad(): void {
	_loadToken++;
}

export const isTauriEnv =
	typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function loadSample() {
	cancelPendingLoad();
	const token = _loadToken;
	_stopPolling();
	session.error = "";
	try {
		const res = await fetch("/sample-session.jsonl");
		if (!res.ok) throw new Error(`fetch failed (${res.status})`);
		const text = await res.text();
		if (token !== _loadToken) return; // a newer selection superseded this sample load — drop it
		session.store?.dispose(); // abort the outgoing store's conductor (in-flight host.complete) before discarding it
		session.store = new AccordionStore(parse(text));
		session.filePath = null;
		session.readOnly = false;
		_expose();
	} catch (e) {
		session.error = e instanceof Error ? e.message : String(e);
	}
}

/**
 * Where the Open dialog should land: a user's agent-session folders, in
 * preference order. pi first (this app is pi-centric), then Claude Code, then
 * home. Existence-checked so we never point the picker at a missing folder.
 */
async function defaultOpenDir(): Promise<string | undefined> {
	try {
		const [{ homeDir, join }, { exists }] = await Promise.all([
			import("@tauri-apps/api/path"),
			import("@tauri-apps/plugin-fs"),
		]);
		const home = await homeDir();
		const candidates = [
			await join(home, ".pi", "agent", "sessions"),
			await join(home, ".claude", "projects"),
		];
		for (const dir of candidates) {
			try {
				if (await exists(dir)) return dir;
			} catch {
				/* permission / transient — try the next candidate */
			}
		}
		return home;
	} catch {
		return undefined; // not Tauri / path API unavailable — let the dialog default
	}
}

export async function openFile() {
	session.error = "";
	try {
		const [{ open }, { readTextFile }] = await Promise.all([
			import("@tauri-apps/plugin-dialog"),
			import("@tauri-apps/plugin-fs"),
		]);
		const selected = await open({
			title: "Open session file",
			defaultPath: await defaultOpenDir(),
			filters: [{ name: "JSONL", extensions: ["jsonl"] }],
		});
		if (!selected || typeof selected !== "string") return;
		await _openWithReader(selected, readTextFile);
	} catch (e) {
		session.error = e instanceof Error ? e.message : String(e);
	}
}

/**
 * Read a Claude Code transcript via the native command. The JS fs plugin's scope does
 * NOT cover programmatic reads of ~/.claude/projects/** (only dialog-picked files), so
 * the load + tail goes through Rust, which owns ~/.claude access and confines the path
 * to the projects root.
 */
async function readClaudeSession(path: string): Promise<string> {
	const { invoke } = await import("@tauri-apps/api/core");
	return await invoke<string>("read_claude_session", { path });
}

/**
 * Load a specific Claude Code transcript read-only and tail it for appends.
 * Reuses _openWithReader with a native (scope-safe) read function.
 */
export async function loadFilePath(path: string): Promise<void> {
	session.error = "";
	try {
		await _openWithReader(path, readClaudeSession);
	} catch (e) {
		session.error = e instanceof Error ? e.message : String(e);
	}
}

async function _load(path: string, readFn: (p: string) => Promise<string>, token: number) {
	const text = await readFn(path);
	if (token !== _loadToken) return; // a newer selection superseded this load — drop it
	const prevBudget = session.store?.budget;
	const prevProtect = session.store?.protectTokens;
	session.store?.dispose(); // abort the outgoing store's conductor (in-flight host.complete) before discarding it
	session.store = new AccordionStore(parse(text));
	if (prevBudget !== undefined) session.store.setBudget(prevBudget);
	if (prevProtect !== undefined) session.store.setProtect(prevProtect);
	session.filePath = path;
	session.error = "";
	_lastLen = text.length;
	_expose();
}

/**
 * Shared helper: cancels any in-flight load, stops the current poll, loads the new
 * file, then arms readOnly + starts tailing — all guarded by the generation token so
 * a superseded read can never clobber a later selection.
 */
async function _openWithReader(path: string, readFn: (p: string) => Promise<string>) {
	cancelPendingLoad(); // invalidate any in-flight load
	_stopPolling();      // stop tailing the previous file before loading the new one
	const token = _loadToken;
	await _load(path, readFn, token);
	if (token !== _loadToken) return; // superseded during the read — don't arm readOnly/poll
	session.readOnly = true;
	_startPolling(path, readFn, token);
}

function _startPolling(path: string, readFn: (p: string) => Promise<string>, token: number) {
	_stopPolling();
	_pollInterval = setInterval(async () => {
		try {
			const text = await readFn(path);
			if (token !== _loadToken) return; // this poll belongs to a file/session that was superseded
			if (text.length !== _lastLen) {
				await _load(path, readFn, token);
			}
		} catch {
			if (token === _loadToken) _stopPolling();
		}
	}, 1500);
}

function _stopPolling() {
	if (_pollInterval !== null) {
		clearInterval(_pollInterval);
		_pollInterval = null;
	}
}

function _expose() {
	if (typeof window !== "undefined") (window as any).__store = session.store;
}
