/*
 * ghostState.svelte.ts — GUI-only reactive state for "forming ghosts."
 *
 * A ghost is a presentation-only pulsing placeholder that says "pi is generating
 * a block of this kind, right now." It carries NO content and NO token count.
 *
 * INVARIANTS (enforced below):
 *   1. Ghosts NEVER enter store.blocks or the engine model.
 *      Committed blocks arrive solely via the Phase-3 appendBlocks path in
 *      liveClient.svelte.ts. A ghost is only ever removed, never converted.
 *   2. Every ghost spawned on a "start" frame is cleared on:
 *        a. its own "end" frame       (clean single-part resolution)
 *        b. an "abort" sweep          (error/abort or message_end/agent_end backstop)
 *        c. WS onclose / disconnectLive
 *        d. "hello" or full-sync reset
 *      No ghost can pulse forever.
 */

export interface Ghost {
	/** The assistantMessageEvent.contentIndex — key for lookup. */
	contentIndex: number;
	/** The kind of block being formed. */
	kind: "thinking" | "text" | "tool_call";
}

/**
 * Reactive list of active ghosts, in arrival order (which mirrors contentIndex
 * order since a message's parts are streamed sequentially). Exported as a $state
 * so Svelte components can subscribe reactively. Only liveClient.svelte.ts
 * (and this module) may write to it.
 */
export const ghosts = $state<Ghost[]>([]);

/** Spawn or refresh a ghost for the given contentIndex + kind. */
export function ghostStart(kind: Ghost["kind"], contentIndex: number): void {
	// If one with this contentIndex already exists (e.g. a retry), update in place.
	const idx = ghosts.findIndex((g) => g.contentIndex === contentIndex);
	if (idx >= 0) {
		ghosts[idx] = { contentIndex, kind };
	} else {
		ghosts.push({ contentIndex, kind });
	}
}

/** Remove the ghost for a specific contentIndex (clean "end" resolution). */
export function ghostEnd(contentIndex: number): void {
	const idx = ghosts.findIndex((g) => g.contentIndex === contentIndex);
	if (idx >= 0) ghosts.splice(idx, 1);
}

/**
 * Clear ALL active ghosts (abort sweep, or structural reset).
 * Used on: abort with contentIndex < 0, message_end backstop, agent_end backstop,
 * WS disconnect, hello, full-sync reset.
 */
export function ghostClearAll(): void {
	ghosts.length = 0;
}
