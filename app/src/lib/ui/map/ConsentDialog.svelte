<script lang="ts">
	/*
	 * ConsentDialog.svelte — the one-time handover gate for an EXCLUSIVE conductor (ADR 0011 §6).
	 *
	 * Attaching a conductor that declares a non-empty lock-set is a deliberate handover, not a
	 * silent switch: "trust moves from override to revocability." So before the attach happens
	 * we show the LOCK TABLE — for each of the three lockable steering controls, whether this
	 * conductor takes it over (✗ "taken over") or leaves it to the human (✓ "stays yours") —
	 * plus the sacred tier that is ALWAYS the human's (observation/peek, the budget, the agent's
	 * recall, and detach itself). Confirm → proceed with the normal attach path. Cancel → the
	 * caller reverts the selection (nothing attaches).
	 *
	 * Pure presentation: it reads the candidate conductor's label + locks (passed in, so we
	 * never instantiate the conductor to show its table) and emits onconfirm / oncancel. The
	 * caller (ConductorMenu) owns the selection flow.
	 */
	import { LOCK_NAMES, hasLock, type LockName } from "$conductors/contract";
	import Icon from "$lib/ui/Icon.svelte";

	let {
		label,
		locks,
		onconfirm,
		oncancel,
	}: {
		/** Human-facing name of the conductor about to be attached. */
		label: string;
		/** The lock-set it declares (non-empty — this dialog only shows for exclusive conductors). */
		locks: readonly LockName[];
		onconfirm: () => void;
		oncancel: () => void;
	} = $props();

	// Friendly names for the three lockable steering controls.
	const LOCK_LABEL: Record<LockName, string> = {
		"human-steering": "Your steering",
		"agent-unfold": "The agent's unfold",
		"tail-size": "The tail size",
	};
	const LOCK_DETAIL: Record<LockName, string> = {
		"human-steering": "hand fold / unfold / pin / group / reset",
		"agent-unfold": "the agent forcing a block to stand open",
		"tail-size": "the protected-tail dial and its no-fold floor",
	};

	// One row per lockable control, in canonical order — taken vs stays-yours.
	const rows = $derived(
		LOCK_NAMES.map((name) => ({ name, taken: hasLock(locks, name) })),
	);

	// The sacred tier — never lockable, always the human's (or the agent's, for recall).
	const SACRED: { label: string; note: string }[] = [
		{ label: "Watch", note: "peek, the live map, the activity log" },
		{ label: "Recall", note: "the agent can always read folded content" },
		{ label: "Budget", note: "the context budget stays yours" },
		{ label: "Detach", note: "the kill switch — take back control anytime" },
	];

	// Focus the safe default (Cancel) when the dialog mounts; trap Escape → cancel.
	// Tab / Shift-Tab cycle between the two buttons only (focus trap — the dialog has
	// role="dialog" aria-modal, but browsers don't enforce the trap automatically).
	let cancelBtn = $state<HTMLButtonElement>();
	let confirmBtn = $state<HTMLButtonElement>();
	$effect(() => {
		cancelBtn?.focus();
		function onKey(e: KeyboardEvent): void {
			if (e.key === "Escape") {
				e.stopPropagation();
				oncancel();
				return;
			}
			if (e.key === "Tab") {
				// Cycle focus between Cancel ↔ confirm (the only two focusable elements).
				const focused = document.activeElement;
				if (e.shiftKey) {
					// Shift-Tab: if on Cancel (or anything else), move to confirm.
					if (focused === cancelBtn || focused !== confirmBtn) {
						e.preventDefault();
						confirmBtn?.focus();
					}
				} else {
					// Tab: if on confirm (or anything else), move to cancel.
					if (focused === confirmBtn || focused !== cancelBtn) {
						e.preventDefault();
						cancelBtn?.focus();
					}
				}
			}
		}
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	});
</script>

<!-- Backdrop: a click outside the card cancels (same as the safe default). -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="consent-backdrop" onclick={oncancel}>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="consent-card"
		role="dialog"
		tabindex="-1"
		aria-modal="true"
		aria-labelledby="consent-title"
		onclick={(e) => e.stopPropagation()}
	>
		<header class="consent-head">
			<span class="consent-icon"><Icon name="lock" size={15} /></span>
			<h2 id="consent-title" class="consent-title"><strong>{label}</strong> wants to take over</h2>
		</header>

		<p class="consent-lede">
			This conductor is <b>exclusive</b> — it asks for uncontested control of some steering
			controls. Your safety net is no longer reaching in to overrule it; it is being able to
			<b>detach</b> at any time.
		</p>

		<!-- Lock table: which steering controls this conductor takes over. -->
		<ul class="lock-table" aria-label="Controls this conductor takes over">
			{#each rows as row (row.name)}
				<li class="lock-row" class:taken={row.taken}>
					<span class="lock-mark" class:taken={row.taken} aria-hidden="true">
						<Icon name={row.taken ? "x" : "check"} size={13} />
					</span>
					<span class="lock-text">
						<span class="lock-name">{LOCK_LABEL[row.name]}</span>
						<span class="lock-detail">{LOCK_DETAIL[row.name]}</span>
					</span>
					<span class="lock-state" class:taken={row.taken}>
						{row.taken ? "taken over" : "stays yours"}
					</span>
				</li>
			{/each}
		</ul>

		<!-- The sacred tier — always yours, no matter what. -->
		<div class="sacred">
			<span class="sacred-label">Always yours</span>
			<ul class="sacred-list">
				{#each SACRED as s (s.label)}
					<li class="sacred-item" title={s.note}>
						<Icon name="check" size={11} />
						<span>{s.label}</span>
					</li>
				{/each}
			</ul>
		</div>

		<footer class="consent-actions">
			<button type="button" class="consent-btn consent-cancel" bind:this={cancelBtn} onclick={oncancel}>
				Cancel
			</button>
			<button type="button" class="consent-btn consent-confirm" bind:this={confirmBtn} onclick={onconfirm}>
				Hand over &amp; attach
			</button>
		</footer>
	</div>
</div>

<style>
	.consent-backdrop {
		position: fixed;
		inset: 0;
		z-index: 200;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--sp-4);
		background: rgba(0, 0, 0, 0.55);
	}

	.consent-card {
		width: 100%;
		max-width: 440px;
		display: flex;
		flex-direction: column;
		gap: var(--sp-3);
		padding: var(--sp-4);
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--radius-md, 10px);
		box-shadow: var(--shadow-2);
	}

	.consent-head {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
	}
	.consent-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border-radius: var(--radius-sm);
		background: var(--accent-soft);
		color: var(--accent);
		flex: 0 0 auto;
	}
	.consent-title {
		margin: 0;
		font-size: var(--fs-base);
		font-weight: 600;
		color: var(--text);
	}
	.consent-title strong {
		color: var(--accent);
	}

	.consent-lede {
		margin: 0;
		font-size: var(--fs-sm);
		line-height: 1.5;
		color: var(--muted);
	}
	.consent-lede b {
		color: var(--text);
		font-weight: 600;
	}

	/* ── Lock table ── */
	.lock-table {
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
	.lock-row {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: var(--sp-2) var(--sp-3);
		background: var(--panel-2);
	}
	.lock-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		flex: 0 0 auto;
		border-radius: 50%;
		color: var(--ok);
		background: color-mix(in srgb, var(--ok) 16%, transparent);
	}
	.lock-mark.taken {
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 16%, transparent);
	}
	.lock-text {
		display: flex;
		flex-direction: column;
		gap: 1px;
		flex: 1 1 auto;
		min-width: 0;
	}
	.lock-name {
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--text);
	}
	.lock-detail {
		font-size: var(--fs-2xs);
		color: var(--faint);
	}
	.lock-state {
		flex: 0 0 auto;
		font-size: var(--fs-2xs);
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--ok);
	}
	.lock-state.taken {
		color: var(--danger);
	}

	/* ── Sacred tier ── */
	.sacred {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.sacred-label {
		font-size: var(--fs-2xs);
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--faint);
	}
	.sacred-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}
	.sacred-item {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-xs);
		font-weight: 500;
		color: var(--ok);
		background: color-mix(in srgb, var(--ok) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--ok) 30%, transparent);
		border-radius: var(--radius-pill);
		padding: 2px 9px 2px 7px;
	}

	/* ── Actions ── */
	.consent-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--sp-2);
		margin-top: 2px;
	}
	.consent-btn {
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
	.consent-cancel {
		color: var(--text);
		background: var(--panel-3);
		border: 1px solid var(--line);
	}
	.consent-cancel:hover {
		background: var(--panel-4);
		border-color: var(--line-strong);
	}
	.consent-confirm {
		color: var(--accent);
		background: var(--accent-soft);
		border: 1px solid color-mix(in srgb, var(--accent) 50%, var(--line));
	}
	.consent-confirm:hover {
		background: color-mix(in srgb, var(--accent) 22%, var(--panel));
		border-color: var(--accent);
	}
	.consent-btn:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
</style>
