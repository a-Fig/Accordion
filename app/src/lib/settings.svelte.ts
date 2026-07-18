/*
 * settings.svelte.ts — reactive, localStorage-persisted user preferences.
 *
 * Single source of truth for all user-facing settings. Each setting is a typed
 * field on `Settings` with a declared default; adding a new preference is a
 * one-line change (field + default + optional setter if the generic `set` isn't
 * enough). All reads are reactive via $state — usable in $derived / templates.
 *
 * Dependency-free beyond Svelte runes: no Svelte components, no UI imports.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** How folded blocks are rendered in the Map grid. */
export type FoldDisplayMode = "classic" | "sliver";

/** All user-configurable preferences. Extend by adding a field + default here. */
interface SettingsShape {
	foldDisplayMode: FoldDisplayMode;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS: SettingsShape = {
	foldDisplayMode: "classic",
};

// ─── localStorage helpers ─────────────────────────────────────────────────────

const NS = "accordion.settings";

function loadKey<K extends keyof SettingsShape>(key: K): SettingsShape[K] {
	if (typeof localStorage === "undefined") return DEFAULTS[key];
	try {
		const raw = localStorage.getItem(`${NS}.${key}`);
		if (raw === null) return DEFAULTS[key];
		return validate(key, raw);
	} catch {
		return DEFAULTS[key];
	}
}

function persistKey<K extends keyof SettingsShape>(key: K, value: SettingsShape[K]): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(`${NS}.${key}`, String(value));
	} catch {
		/* storage full / blocked — preference just won't persist */
	}
}

/**
 * Validate a raw localStorage string against the known allowed values for a key.
 * Falls back to the default if the stored value is unrecognised.
 */
function validate<K extends keyof SettingsShape>(key: K, raw: string): SettingsShape[K] {
	switch (key) {
		case "foldDisplayMode": {
			const allowed: FoldDisplayMode[] = ["classic", "sliver"];
			return (allowed.includes(raw as FoldDisplayMode)
				? (raw as FoldDisplayMode)
				: DEFAULTS.foldDisplayMode) as SettingsShape[K];
		}
		default:
			return DEFAULTS[key];
	}
}

// ─── Store class ─────────────────────────────────────────────────────────────

class Settings {
	foldDisplayMode = $state<FoldDisplayMode>(loadKey("foldDisplayMode"));

	/**
	 * Generic setter — updates reactive state and persists to localStorage.
	 * Usage: `settings.set("foldDisplayMode", "sliver")`
	 */
	set<K extends keyof SettingsShape>(key: K, value: SettingsShape[K]): void {
		switch (key) {
			case "foldDisplayMode":
				this.foldDisplayMode = value as FoldDisplayMode;
				break;
		}
		persistKey(key, value);
	}
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const settings = new Settings();

// Expose for devtools inspection — mirrors the window.__store pattern.
if (typeof window !== "undefined") (window as unknown as Record<string, unknown>).__settings = settings;
