<script lang="ts">
	/*
	 * ConductorMenu.svelte — the Phase C conductor picker (v13 wire).
	 *
	 * A small dropdown next to the FOLDING arm: "None" plus the host's advertised catalog
	 * (`hello.conductors` — the picker's SINGLE source of truth; the host, not the GUI, knows
	 * what conductors exist). Picking a LOCK-FREE (collaborative) entry or "None" sends
	 * `selectConductor(id)` immediately, same as every other steering dial (no optimistic apply —
	 * the trigger's label only moves when the host echoes back `conductorState`). Picking an
	 * EXCLUSIVE entry (declares a non-empty lock-set) first opens `ConsentDialog` — the one-time
	 * handover gate (ADR 0011 §6): Confirm sends `selectConductor(id)`, Cancel sends nothing (the
	 * current selection is untouched).
	 *
	 * Consent is CLIENT-LOCAL BY DESIGN: another tab confirming an attach just broadcasts the
	 * resulting `conductorState`, which this tab reflects like any other shared dial (the trigger
	 * label/lock chrome updates). There is no cross-tab consent handshake to build here.
	 *
	 * Hidden entirely when not connected live (a CC transcript or the bundled demo has no wire —
	 * mirrors how the FOLDING arm gates on `live.status === "connected"`) or when the host has
	 * advertised an empty catalog (nothing to pick from).
	 */
	import Icon from "$lib/ui/Icon.svelte";
	import ConsentDialog from "./ConsentDialog.svelte";
	import { isExclusive } from "$core/locks";
	import type { ActiveConductorMeta } from "$core/protocol";
	import { live, conductors, conductorState, selectConductor, anotherSurfaceControls } from "$lib/live/liveClient.svelte";
	import { attemptSteer, readOnlyTip } from "$lib/live/controllerUi.svelte";

	// READ-ONLY gate (v16, ADR 0024, spec Part 3): some OTHER surface holds the controller lease.
	// This component is only ever mounted while `live.status === "connected"` (see its own gate at
	// the bottom), so "not controller" here always means "read-only", never "no wire at all".
	// U1: gated on `anotherSurfaceControls()` (a NON-null FRESH foreign lease), NOT `!isController()`,
	// so an uncontested connect (null/stale lease this surface silently auto-claims) never flashes the
	// picker read-only while the claim round-trips.
	const notController = $derived(anotherSurfaceControls());

	let open = $state(false);
	// Held selection behind the consent gate (ADR 0011 §6) — nothing is sent to the wire until
	// the user confirms; Cancel just drops it, leaving the current attach untouched.
	let pending = $state<ActiveConductorMeta | null>(null);

	const activeId = $derived(conductorState.active?.id ?? null);
	const activeLabel = $derived(conductorState.active?.label ?? "None");
	const activeExclusive = $derived(isExclusive(conductorState.active?.locks));

	let rootEl = $state<HTMLDivElement>();
	let triggerEl = $state<HTMLButtonElement>();

	// The wire dropping (disconnect, or a session switch that tears down the socket) must not
	// leave a stale popover/consent gate around for a later reconnect to suddenly resurrect —
	// `pending` in particular could otherwise re-show ConsentDialog for a catalog entry that no
	// longer exists on the new connection. Mirrors liveClient's own reset-on-disconnect.
	$effect(() => {
		if (live.status !== "connected") {
			open = false;
			pending = null;
		}
	});

	function toggle(e: MouseEvent): void {
		attemptSteer({ live: true, isController: !notController, verb: "steer", x: e.clientX, y: e.clientY }, () => {
			open = !open;
		});
	}
	function closeMenu(): void {
		open = false;
	}

	/** `null` means the "None" row. */
	function choose(meta: ActiveConductorMeta | null): void {
		// Re-picking the active selection is a no-op — no re-handover prompt.
		if ((meta?.id ?? null) === activeId) {
			closeMenu();
			return;
		}
		if (meta && isExclusive(meta.locks)) {
			// Exclusive → hold the pick behind the consent gate. The menu closes visually behind
			// the modal; the pick only reaches the wire on Confirm.
			pending = meta;
			open = false;
			return;
		}
		selectConductor(meta?.id ?? null);
		closeMenu();
	}

	function confirmPending(): void {
		if (pending) selectConductor(pending.id);
		pending = null;
	}
	function cancelPending(): void {
		pending = null; // no-op — nothing was ever sent, current attach is untouched
	}

	// ── dismissal: click-outside + Escape, only while open ──
	$effect(() => {
		if (!open) return;
		function onPointerDown(e: PointerEvent): void {
			if (rootEl && e.target instanceof Node && rootEl.contains(e.target)) return;
			closeMenu();
		}
		function onKeydown(e: KeyboardEvent): void {
			if (e.key === "Escape") {
				e.stopPropagation();
				closeMenu();
				triggerEl?.focus();
			}
		}
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKeydown, true);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("keydown", onKeydown, true);
		};
	});
</script>

{#if live.status === "connected" && conductors.length > 0}
	<div class="cond-menu" bind:this={rootEl}>
		<button
			type="button"
			class="cond-trigger"
			class:locked={activeExclusive}
			class:open
			class:ro-dim={notController}
			bind:this={triggerEl}
			aria-haspopup="menu"
			aria-expanded={open}
			aria-disabled={notController}
			aria-label="Switch conductor"
			title={notController
				? readOnlyTip("steer")
				: "Conductor: " +
					activeLabel +
					(activeExclusive ? " · exclusive — pick None to release" : "") +
					" — click to switch"}
			onclick={toggle}
		>
			<Icon name={activeExclusive ? "lock" : "sliders-horizontal"} size={11} />
			<span class="cond-trigger-eyebrow mono">CONDUCTOR</span>
			<span class="cond-trigger-label">{activeLabel}</span>
			<Icon name="chevron-down" size={11} />
		</button>

		{#if open}
			<div class="cond-pop" role="menu" aria-label="Conductors">
				<button
					type="button"
					class="cond-item raw"
					class:active={activeId === null}
					role="menuitemradio"
					aria-checked={activeId === null}
					title="No conductor — context is raw, human-only"
					onclick={() => choose(null)}
				>
					<span class="cond-check">
						{#if activeId === null}<Icon name="check" size={13} />{/if}
					</span>
					<span class="cond-item-label">None</span>
				</button>

				<div class="cond-sep" role="separator"></div>

				<!-- The host's catalog carries its own "none" sentinel (load-bearing core-side —
				     see core/conductor/registry.ts), but the hardcoded row above is already the
				     single "detach" affordance — filter the sentinel out here so it never renders
				     twice. -->
				{#each conductors.filter((c) => c.id !== "none") as c (c.id)}
					<button
						type="button"
						class="cond-item"
						class:active={activeId === c.id}
						role="menuitemradio"
						aria-checked={activeId === c.id}
						title={c.description ?? c.label}
						onclick={() => choose(c)}
					>
						<span class="cond-check">
							{#if activeId === c.id}<Icon name="check" size={13} />{/if}
						</span>
						<span class="cond-item-label">{c.label}</span>
						{#if isExclusive(c.locks)}
							<span class="cond-exclusive" title="Exclusive — takes over {c.locks.length} of 3 steering controls">
								<Icon name="lock" size={10} />
							</span>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>

	{#if pending}
		<ConsentDialog conductor={pending} onconfirm={confirmPending} oncancel={cancelPending} />
	{/if}
{/if}

<style>
	.cond-menu {
		position: relative;
		display: inline-flex;
	}

	/* ── Trigger: same ghost-button shape as the FOLDING arm, with a CONDUCTOR eyebrow ── */
	.cond-trigger {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: var(--fs-xs);
		font-weight: 500;
		color: var(--text);
		background: transparent;
		border: 1px solid var(--line);
		padding: 6px 10px 6px 10px;
		border-radius: var(--radius-sm);
		white-space: nowrap;
		user-select: none;
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out);
	}
	.cond-trigger-eyebrow {
		font-size: var(--fs-2xs);
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--faint);
	}
	.cond-trigger:hover,
	.cond-trigger.open {
		border-color: var(--line-strong);
		background: var(--accent-soft);
		color: var(--text);
	}
	.cond-trigger:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
	.cond-trigger-label {
		max-width: 14ch;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* Exclusive (locked) conductor attached — warning accent so the handover is never invisible.
	   --warn is the same muted amber the LATENCY badge uses for a slow hook; never the reserved
	   #044EFF user-block blue. */
	.cond-trigger.locked {
		color: var(--warn);
		background: color-mix(in srgb, var(--warn) 12%, var(--panel-2));
		border-color: color-mix(in srgb, var(--warn) 45%, var(--line));
	}
	.cond-trigger.locked:hover,
	.cond-trigger.locked.open {
		background: color-mix(in srgb, var(--warn) 18%, var(--panel));
		border-color: var(--warn);
		color: var(--warn);
	}

	/* READ-ONLY "whisper" treatment (v16, ADR 0024): some OTHER surface holds the controller lease.
	   Quiet dim, matching MapHeader's own `.ro-dim` — stays clickable so a click can flash the
	   blocked-interaction hint (see `toggle()`). */
	.cond-trigger.ro-dim {
		opacity: 0.35;
		cursor: not-allowed;
	}

	/* ── Popover ── */
	.cond-pop {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 50;
		min-width: 200px;
		max-width: 300px;
		padding: 5px;
		display: flex;
		flex-direction: column;
		gap: 1px;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow-2);
	}

	.cond-item {
		display: flex;
		align-items: center;
		gap: 7px;
		width: 100%;
		padding: 6px 8px;
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		font-size: var(--fs-xs);
		font-weight: 500;
		color: var(--text);
		text-align: left;
		cursor: pointer;
		transition: background var(--dur-fast) var(--ease-out);
	}
	.cond-item:hover {
		background: var(--panel-3);
	}
	.cond-item:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
	.cond-item.active {
		color: var(--accent);
	}
	.cond-item.raw {
		color: var(--faint);
	}
	.cond-item.raw.active {
		color: var(--accent);
	}

	/* Fixed-width leading slot so the check never shifts the label. */
	.cond-check {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 13px;
		flex: 0 0 auto;
		color: var(--accent);
	}
	.cond-item-label {
		flex: 1 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cond-exclusive {
		display: inline-flex;
		align-items: center;
		flex: 0 0 auto;
		color: var(--warn);
	}

	.cond-sep {
		height: 1px;
		margin: 4px 2px;
		background: var(--line-soft);
	}
</style>
