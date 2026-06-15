/*
 * conductorMerge.ts — pure helper that builds the external-conductor row list for the
 * conductor switcher (ConductorMenu.svelte).
 *
 * Three sources are merged and deduped by id, in priority order:
 *  1. discovered (running) — has a ConductorEntry (url, heartbeat). Wins over all others.
 *  2. launchable-stopped — in the launchable manifest, not yet running.
 *  3. configured-only — hand-entered ws:// URL, not discovered and not launchable.
 *
 * Kept in a separate file so it can be unit-tested without importing Svelte runes.
 */

import type { ConductorEntry } from "./registry";

export type LaunchableEntry = { id: string; label: string };

export type ExternalRow =
	| { kind: "running";    id: string; label: string; url: string; canLaunch: boolean; canForget: boolean }
	| { kind: "stopped";    id: string; label: string }
	| { kind: "configured"; id: string; label: string; url: string };

/**
 * Build the merged external row list.
 *
 * @param discovered  Live conductor entries (from the 3s poll).
 * @param launchableList  Conductors that can be started via `launch_conductor`.
 * @param configured  Hand-entered conductor entries (from localStorage).
 * @param launchingIds  Set of ids currently being launched (started but not yet discovered).
 */
export function mergeExternalConductors(
	discovered: ConductorEntry[],
	launchableList: LaunchableEntry[],
	configured: ConductorEntry[],
	launchingIds: ReadonlySet<string>,
): ExternalRow[] {
	const launchableIds = new Set(launchableList.map((c) => c.id));
	const configuredIds = new Set(configured.map((c) => c.id));
	const seen = new Set<string>();
	const rows: ExternalRow[] = [];

	// 1. discovered entries first (running state)
	for (const c of discovered) {
		seen.add(c.id);
		rows.push({
			kind: "running",
			id: c.id,
			label: c.label,
			url: c.url,
			canLaunch: launchableIds.has(c.id),
			canForget: configuredIds.has(c.id),
		});
	}

	// 2. launchable-stopped (in manifest, not yet discovered)
	for (const c of launchableList) {
		if (seen.has(c.id)) continue;
		seen.add(c.id);
		rows.push({ kind: "stopped", id: c.id, label: c.label });
	}

	// 3. configured-only (hand-entered, not discovered, not launchable)
	for (const c of configured) {
		if (seen.has(c.id)) continue;
		seen.add(c.id);
		rows.push({ kind: "configured", id: c.id, label: c.label, url: c.url });
	}

	// launchingIds is used by the menu component to decorate rows; no structural effect here
	void launchingIds;
	return rows;
}
