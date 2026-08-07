<script lang="ts">
	/*
	 * NoticeToast.svelte — a minimal, generic informational toast (protocol v17, server `notice`
	 * message). Shown by `+page.svelte` when `notice.svelte.ts`'s `notice.show` is true (set by
	 * `liveClient`'s `notice` handler). First use: pi compacted the session natively while folding
	 * was off, so every attached UI — not just whoever is watching pi's own CLI — sees why the map
	 * just changed shape.
	 *
	 * Styled to match `DemotionToast.svelte` (same corner, panel, neutral palette, auto-dismiss feel)
	 * since that is the app's one existing precedent for "small transient thing just happened" —
	 * deliberately simpler: a single message line and a close button, no action button (there is
	 * nothing to do about a notice, unlike "take back" control).
	 */
	let { text, onclose }: { text: string; onclose: () => void } = $props();
</script>

<div class="notice-toast" role="status">
	<div class="notice-body">{text}</div>
	<button type="button" class="notice-close" onclick={onclose} aria-label="Dismiss">&times;</button>
</div>

<style>
	.notice-toast {
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
	.notice-body {
		flex: 1 1 auto;
		min-width: 0;
		font-size: var(--fs-sm);
		color: var(--text);
		line-height: 1.4;
	}
	.notice-close {
		flex: 0 0 auto;
		background: transparent;
		border: none;
		color: var(--faint);
		font-size: 16px;
		line-height: 1;
		cursor: pointer;
		padding: 2px;
	}
	.notice-close:hover {
		color: var(--text);
	}
	.notice-close:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
</style>
