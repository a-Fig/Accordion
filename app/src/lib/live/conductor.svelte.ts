/*
 * conductor.svelte.ts — the active-conductor SELECTION (shared UI state).
 *
 * Mirrors `folding.svelte.ts`: a tiny reactive switch the sidebar sets and the header
 * reads. WHICH conductor is active is the user's choice, persisted across reloads. The
 * AVAILABLE list lives in `conductorDiscovery.svelte.ts`; the actual attach/detach is
 * `conductorClient.attachConductor`. This module just remembers the pick.
 */
import { BUILTIN_ID } from "./conductorClient.svelte";

const KEY = "accordion.conductor.active";

export const conductorState = $state<{ activeId: string }>({
	activeId: load(),
});

export function setActiveConductor(id: string): void {
	conductorState.activeId = id;
	if (typeof localStorage !== "undefined") {
		try {
			localStorage.setItem(KEY, id);
		} catch {
			/* storage blocked — selection just won't persist */
		}
	}
}

function load(): string {
	if (typeof localStorage === "undefined") return BUILTIN_ID;
	return localStorage.getItem(KEY) || BUILTIN_ID;
}
