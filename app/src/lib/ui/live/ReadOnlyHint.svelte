<script lang="ts">
	/*
	 * ReadOnlyHint.svelte — the small floating "READ-ONLY — take control to <verb>" tooltip a
	 * blocked steering attempt flashes near the interaction (v16, ADR 0024, spec Part 3, mock §06).
	 * Mounted ONCE at the app shell (`+page.svelte`) so every gated control (map tile / transcript
	 * double-click, the FOLDING arm, the conductor picker, the BUDGET/PROTECT dials) can trigger it
	 * via `controllerUi.svelte.ts`'s `flashBlockedHint` without each owning its own popup markup.
	 * Purely reactive to `blockedHint` — no props, no local state.
	 */
	import { blockedHint } from "$lib/live/controllerUi.svelte";

	// U5: clamp to the viewport so a hint flashed from a click near an edge never renders off-screen.
	// The box is `translate(-50%, 12px)` (centered horizontally, dropped below the point), nowrap, and
	// at most ~a few hundred px wide — keep a generous half-width margin on x and the drop clearance on
	// y. A rough clamp is fine for a transient whisper; it only needs to stay on-screen near the edges.
	const X_MARGIN = 150;
	const Y_MARGIN = 44;
	const clamped = $derived.by(() => {
		const vw = typeof window !== "undefined" ? window.innerWidth : 0;
		const vh = typeof window !== "undefined" ? window.innerHeight : 0;
		const x = vw ? Math.min(Math.max(blockedHint.x, X_MARGIN), Math.max(X_MARGIN, vw - X_MARGIN)) : blockedHint.x;
		const y = vh ? Math.min(Math.max(blockedHint.y, 8), Math.max(8, vh - Y_MARGIN)) : blockedHint.y;
		return { x, y };
	});
</script>

{#if blockedHint.show}
	<div class="ro-hint" role="status" aria-live="polite" style:left="{clamped.x}px" style:top="{clamped.y}px">
		{blockedHint.text}
	</div>
{/if}

<style>
	.ro-hint {
		position: fixed;
		z-index: 230;
		transform: translate(-50%, 12px);
		background: var(--panel-3);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-xs);
		padding: 6px 10px;
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		letter-spacing: 0.06em;
		color: var(--text);
		box-shadow: var(--shadow-2);
		white-space: nowrap;
		pointer-events: none;
	}
</style>
