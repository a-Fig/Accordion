import { parse } from "./engine/parse";
import { AccordionStore } from "./engine/store.svelte";

/**
 * Reactive session state, shared across the app.
 *
 * Svelte forbids *exporting a reassignable `$state` binding* from a module
 * (`state_invalid_export`) — `export let store = $state(null); store = …` throws
 * at compile time. The supported cross-module pattern is to export a single
 * `$state` *object* and mutate its properties; property mutation stays reactive
 * for every consumer that reads `session.store`, `session.live`, etc.
 */
export const session = $state<{
	store: AccordionStore | null;
	filePath: string | null;
	error: string;
	live: boolean;
}>({
	store: null,
	filePath: null,
	error: "",
	live: false,
});

let _pollInterval: ReturnType<typeof setInterval> | null = null;
let _lastLen = -1;

export const isTauriEnv =
	typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function loadSample() {
	_stopPolling();
	session.error = "";
	try {
		const res = await fetch("/sample-session.jsonl");
		if (!res.ok) throw new Error(`fetch failed (${res.status})`);
		const text = await res.text();
		session.store = new AccordionStore(parse(text));
		session.filePath = null;
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
		await _load(selected, readTextFile);
		_startPolling(selected, readTextFile);
	} catch (e) {
		session.error = e instanceof Error ? e.message : String(e);
	}
}

async function _load(path: string, readFn: (p: string) => Promise<string>) {
	const text = await readFn(path);
	const prevBudget = session.store?.budget;
	const prevProtect = session.store?.protectTokens;
	session.store = new AccordionStore(parse(text));
	if (prevBudget !== undefined) session.store.setBudget(prevBudget);
	if (prevProtect !== undefined) session.store.setProtect(prevProtect);
	session.filePath = path;
	session.error = "";
	_lastLen = text.length;
	_expose();
}

function _startPolling(path: string, readFn: (p: string) => Promise<string>) {
	_stopPolling();
	session.live = true;
	_pollInterval = setInterval(async () => {
		try {
			const text = await readFn(path);
			if (text.length !== _lastLen) {
				await _load(path, readFn);
			}
		} catch {
			_stopPolling();
		}
	}, 1500);
}

function _stopPolling() {
	if (_pollInterval !== null) {
		clearInterval(_pollInterval);
		_pollInterval = null;
	}
	session.live = false;
}

function _expose() {
	if (typeof window !== "undefined") (window as any).__store = session.store;
}
