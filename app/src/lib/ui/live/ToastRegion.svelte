<script lang="ts">
	/*
	 * ToastRegion.svelte — the app's single notification corner (top-right). Every transient toast
	 * (DemotionToast, NoticeToast, and any future one) mounts INSIDE this region instead of
	 * positioning itself: the region owns the fixed corner, the z-order, and the vertical stacking,
	 * so two toasts landing at the same instant stack with consistent spacing instead of
	 * overlapping. A toast owns only its own content, state, and lifecycle.
	 *
	 * Policy (deliberately fixed, not configurable):
	 *  - Stacking order = DOM order in `+page.svelte`. Controller-lease toasts render above
	 *    informational notices — control of the session outranks "something happened".
	 *  - Spacing lives on each child as `margin-bottom` (NOT flex gap) so `toastPop`'s exit
	 *    transition can collapse it and the survivor slides up smoothly — see toastTransition.ts.
	 *  - `pointer-events: none` on the region, re-enabled per child: the empty corner never eats
	 *    clicks aimed at the map underneath.
	 *  - Not a notification framework: no queue, no store, no priorities. If the app ever needs
	 *    those, a unified store would render into this same region — the region is the substrate,
	 *    so nothing here would be thrown away.
	 */
	import type { Snippet } from "svelte";
	let { children }: { children: Snippet } = $props();
</script>

<div class="toast-region">
	{@render children()}
</div>

<style>
	.toast-region {
		position: fixed;
		top: 18px;
		right: 18px;
		z-index: 210;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		width: 320px;
		max-width: calc(100vw - 36px);
		pointer-events: none;
	}
	.toast-region > :global(*) {
		pointer-events: auto;
		margin-bottom: var(--sp-3);
	}
</style>
