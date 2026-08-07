<script lang="ts">
	/*
	 * DemotionToast.svelte — "we held the controller lease and someone else just took it" (v16,
	 * ADR 0024, spec Part 3). Shown by `+page.svelte` when `controllerUi.svelte.ts`'s
	 * `demotionToast.show` is true (set by `noteControllerBroadcast` in liveClient's `controller`
	 * handler). Auto-dismisses on its own timer (owned by that module); TAKE BACK re-claims.
	 *
	 * Copy verbatim from the approved mock (§05): "<Label> took control" / "This window is now a
	 * live mirror." Neutral styling, light-grey left edge — never the reserved user-block blue.
	 */
	let {
		label,
		onclose,
		ontakeback,
	}: {
		/** The surface that just took over, e.g. "Desktop app" / "Browser tab". */
		label: string;
		onclose: () => void;
		ontakeback: () => void;
	} = $props();
</script>

<div class="demotion-toast" role="status">
	<div class="demotion-body">
		<div class="demotion-title">{label} took control</div>
		<div class="demotion-detail">This window is now a live mirror.</div>
	</div>
	<button type="button" class="demotion-takeback" onclick={ontakeback}>Take back</button>
	<button type="button" class="demotion-close" onclick={onclose} aria-label="Dismiss">&times;</button>
</div>

<style>
	.demotion-toast {
		position: fixed;
		top: 18px;
		right: 18px;
		z-index: 210;
		display: flex;
		align-items: flex-start;
		gap: var(--sp-3);
		width: 320px;
		max-width: calc(100vw - 36px);
		padding: var(--sp-3);
		background: var(--panel);
		border: 1px solid var(--line-strong);
		border-left: 3px solid var(--faint);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow-2);
	}
	.demotion-body {
		flex: 1 1 auto;
		min-width: 0;
	}
	.demotion-title {
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--text);
		margin-bottom: 2px;
	}
	.demotion-detail {
		font-size: var(--fs-xs);
		color: var(--muted);
	}
	.demotion-takeback {
		flex: 0 0 auto;
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		white-space: nowrap;
		color: var(--text);
		background: transparent;
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-xs);
		padding: 5px 10px;
		cursor: pointer;
		transition: border-color var(--dur-fast) var(--ease-out);
	}
	.demotion-takeback:hover {
		border-color: var(--accent);
	}
	.demotion-takeback:focus-visible,
	.demotion-close:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
	.demotion-close {
		flex: 0 0 auto;
		background: transparent;
		border: none;
		color: var(--faint);
		font-size: 16px;
		line-height: 1;
		cursor: pointer;
		padding: 2px;
	}
	.demotion-close:hover {
		color: var(--text);
	}
</style>
