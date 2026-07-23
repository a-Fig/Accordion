<script lang="ts">
	/*
	 * TakeoverPopup.svelte — the one-time single-controller handover gate (v16, ADR 0024, spec Part
	 * 3). Shown by `+page.svelte` when `controllerUi.svelte.ts`'s `takeoverPopup.show` is true: on
	 * connect, another surface holds the FRESH global controller lease. Copy is VERBATIM from the
	 * approved mock (`controller-ux-mockups.html` §04) — do not editorialize it.
	 *
	 * Same visual language + focus-trap pattern as `ConsentDialog.svelte` (the conductor handover
	 * gate): backdrop click / Escape / "Stay read-only" all decline; "Take control" confirms. Pure
	 * presentation — the caller (`+page.svelte`) owns sending `claimController()` and dismissing.
	 */
	import Icon from "$lib/ui/Icon.svelte";
	import { mySurfaceLabel } from "$lib/live/liveClient.svelte";

	let {
		label,
		onconfirm,
		ondecline,
	}: {
		/** The current controller's label, e.g. "Desktop app" / "Browser tab". */
		label: string;
		onconfirm: () => void;
		ondecline: () => void;
	} = $props();

	// The who-phrase adapts (spec): "Desktop app" reads as "The desktop app"; anything else (a
	// browser tab, today the only other surface kind) reads as the disambiguating "Another tab" —
	// saying "a browser tab" would be ambiguous when THIS surface is also a browser tab.
	const who = $derived(label === "Desktop app" ? "The desktop app" : "Another tab");
	// The "now" row names THIS surface — almost always "This tab" (only a browser tab ever really
	// contests a lease against a running desktop app), but stays honest if a desktop app somehow
	// opens onto an already-controlled lease too.
	const meLabel = $derived(mySurfaceLabel() === "Desktop app" ? "This app" : "This tab");

	let cancelBtn = $state<HTMLButtonElement>();
	let confirmBtn = $state<HTMLButtonElement>();
	$effect(() => {
		cancelBtn?.focus();
		function onKey(e: KeyboardEvent): void {
			if (e.key === "Escape") {
				e.stopPropagation();
				ondecline();
				return;
			}
			if (e.key === "Tab") {
				const focused = document.activeElement;
				if (e.shiftKey) {
					if (focused === cancelBtn || focused !== confirmBtn) {
						e.preventDefault();
						confirmBtn?.focus();
					}
				} else if (focused === confirmBtn || focused !== cancelBtn) {
					e.preventDefault();
					cancelBtn?.focus();
				}
			}
		}
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="takeover-backdrop" onclick={ondecline}>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="takeover-card"
		role="dialog"
		tabindex="-1"
		aria-modal="true"
		aria-labelledby="takeover-title"
		onclick={(e) => e.stopPropagation()}
	>
		<header class="takeover-head">
			<span class="takeover-icon"><Icon name="lock" size={15} /></span>
			<h2 id="takeover-title" class="takeover-title">Control sessions from here?</h2>
		</header>

		<p class="takeover-body">
			{who} is currently steering your pi sessions. Only one surface steers at a time — every
			other surface stays a live mirror.
		</p>

		<ul class="switchup" aria-label="What changes">
			<li class="switch-row now">
				<span class="switch-fill" aria-hidden="true"></span>
				<span class="switch-who">{meLabel}</span>
				<span class="switch-what">steers all sessions</span>
			</li>
			<li class="switch-row then">
				<span class="switch-hollow" aria-hidden="true"></span>
				<span class="switch-who">{label}</span>
				<span class="switch-what">becomes read-only</span>
			</li>
		</ul>

		<footer class="takeover-actions">
			<button type="button" class="takeover-btn takeover-decline" bind:this={cancelBtn} onclick={ondecline}>
				Stay read-only
			</button>
			<button type="button" class="takeover-btn takeover-confirm" bind:this={confirmBtn} onclick={onconfirm}>
				Take control
			</button>
		</footer>

		<p class="takeover-fine">You can take control back from any surface, any time.</p>
	</div>
</div>

<style>
	.takeover-backdrop {
		position: fixed;
		inset: 0;
		z-index: 220;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--sp-4);
		background: rgba(0, 0, 0, 0.55);
	}

	.takeover-card {
		width: 100%;
		max-width: 440px;
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
		padding: var(--sp-4);
		background: var(--panel);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow-2);
	}

	.takeover-head {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
	}
	.takeover-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border-radius: var(--radius-sm);
		background: var(--panel-3);
		color: var(--text);
		flex: 0 0 auto;
	}
	.takeover-title {
		margin: 0;
		font-size: var(--fs-base);
		font-weight: 600;
		color: var(--text);
	}

	.takeover-body {
		margin: 0;
		font-size: var(--fs-sm);
		line-height: 1.5;
		color: var(--muted);
	}

	/* ── the two-row "what changes" table ── */
	.switchup {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
		border: 1px solid var(--line-soft);
		border-radius: var(--radius-sm);
		overflow: hidden;
		background: var(--line-soft);
	}
	.switch-row {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: var(--sp-2) var(--sp-3);
		background: var(--panel-2);
		font-size: var(--fs-sm);
	}
	.switch-who {
		font-weight: 600;
		color: var(--text);
		min-width: 90px;
	}
	.switch-what {
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--faint);
	}
	.switch-row.now .switch-what {
		color: var(--muted);
	}
	.switch-fill,
	.switch-hollow {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex: 0 0 auto;
		box-sizing: border-box;
	}
	.switch-fill {
		background: var(--accent);
	}
	.switch-hollow {
		border: 1.5px solid var(--faint);
	}

	.takeover-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
		margin-top: 2px;
	}
	.takeover-btn {
		font-size: var(--fs-sm);
		font-weight: 600;
		padding: 7px 14px;
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out);
	}
	/* "Stay read-only" is the safe default — quiet outline, NOT the primary accent (never blue). */
	.takeover-decline {
		color: var(--text);
		background: var(--panel-3);
		border: 1px solid var(--line);
	}
	.takeover-decline:hover {
		background: var(--panel-4);
		border-color: var(--line-strong);
	}
	/* "Take control" — solid neutral (Cloud), dark text. Never the reserved #044EFF user-block blue. */
	.takeover-confirm {
		color: var(--ink);
		background: var(--paper);
		border: 1px solid var(--paper);
	}
	.takeover-confirm:hover {
		background: #ffffff;
	}
	.takeover-btn:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.takeover-fine {
		margin: 0;
		font-size: var(--fs-2xs);
		color: var(--faint);
	}
</style>
