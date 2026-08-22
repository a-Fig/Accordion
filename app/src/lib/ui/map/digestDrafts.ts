/*
 * digestDrafts.ts — client-local, unsaved digest text, keyed by block/group id.
 *
 * WHY THIS IS NOT IN `Truth`. A human unfold clears `subst` (`Truth.opUnfold`), so a user who
 * writes a careful digest and then hits the row's Unfold button loses it. Keeping the text in
 * `Truth` instead would mean a new overlay field, and the overlay ships inside `SnapshotState` —
 * a protocol bump (v22 → v23) and the extension/app version-lockstep dance, for what is really
 * just typing-in-progress. So the draft lives here, in the client, and the ENGINE stays the sole
 * owner of committed state.
 *
 * The consequence is honest and deliberate: a draft survives folding, unfolding, scrolling,
 * switching to Map view and back, and re-selecting the block. It does NOT survive a reload, a
 * reconnect, a resnapshot, closing the tab, or a second surface — none of those carry client
 * memory. Anything the user actually wants kept, they Save.
 *
 * Not reactive on purpose: `DigestEditor` seeds its own `$state` from here on mount and writes
 * back on input, so no component re-renders because some other block's draft changed.
 */

const drafts = new Map<string, string>();

/** The unsaved draft for `id`, or `undefined` if the user has nothing in flight. */
export function getDraft(id: string): string | undefined {
	return drafts.get(id);
}

/**
 * Record (or clear) the in-flight draft for `id`. `text` matching the committed value clears the
 * entry rather than storing it — a draft the user has typed back to where it started is not a
 * draft, and keeping it would resurrect stale text after an unrelated edit elsewhere.
 */
export function setDraft(id: string, text: string, committed: string): void {
	if (text === committed) drafts.delete(id);
	else drafts.set(id, text);
}

/** Drop the draft for `id` — on Save, on Restore-auto, or on an explicit revert. */
export function clearDraft(id: string): void {
	drafts.delete(id);
}

/** Drop every draft. Called when the session swaps, so ids from a dead session can't leak in. */
export function clearAllDrafts(): void {
	drafts.clear();
}
