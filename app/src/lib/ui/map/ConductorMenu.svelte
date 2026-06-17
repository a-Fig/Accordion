<script lang="ts">
	/*
	 * ConductorMenu.svelte — the interactive conductor switcher (ADR 0007).
	 *
	 * Replaces the read-only active-conductor BADGE in the map header. The trigger is a
	 * clickable evolution of that pill (sliders icon + active label + chevron); clicking it
	 * opens a popover that lets the user pick a conductor (Built-in / discovered + configured
	 * externals / Raw) and add a new one by ws:// URL.
	 *
	 * This component only READS conductor state and calls the selection/config actions — it
	 * never attaches anything itself. The actual attach/detach is driven by an $effect in
	 * +page.svelte that tracks `conductorState.activeId`.
	 */
	import { tick } from "svelte";
	import Icon from "$lib/ui/Icon.svelte";
	import ConsentDialog from "./ConsentDialog.svelte";
	import type { AccordionStore } from "$lib/engine/store.svelte";
	import { IN_PROCESS_CONDUCTORS, inProcessConductor } from "$conductors";
	import { LOCK_NAMES, hasLock, isExclusive, type LockName } from "$conductors/contract";
	import { conductorState, setActiveConductor } from "$lib/live/conductor.svelte";
	import { conductorLink, BUILTIN_ID, NONE_ID } from "$lib/live/conductorClient.svelte";
	import {
		allConductors,
		conductorDiscovery,
		addConfiguredConductor,
		removeConfiguredConductor,
		launchable,
		launchConductor,
		stopConductor,
		isLaunching,
		launchFailures,
	} from "$lib/live/conductorDiscovery.svelte";
	import { mergeExternalConductors, type ExternalRow } from "$lib/live/conductorMerge";
	import { isTauriEnv } from "$lib/session.svelte";

	// The active session's store — read for the live lock-set (`store.isLocked` /
	// `store.conductor?.locks`) and the kill switch (`store.detach()` via the Raw row /
	// attach path). Optional so the menu still renders if a store isn't mounted yet.
	let { store }: { store?: AccordionStore } = $props();

	let open = $state(false);
	let showAdd = $state(false);
	let urlDraft = $state("");
	let urlError = $state("");
	/** Per-id inline launch error text (cleared when the menu closes). */
	let launchErrors = $state<Record<string, string>>({});

	// ── Consent gate (ADR 0011 §6) ───────────────────────────────────────────────
	// Selecting an EXCLUSIVE conductor (one that declares a non-empty lock-set) is a
	// deliberate handover, so we hold the selection and show the lock table first. The
	// pending pick lives here until the user confirms (→ commit the selection) or cancels
	// (→ drop it, stay on the current conductor). Collaborative picks skip the gate.
	let pendingConsent = $state<{ id: string; label: string; locks: readonly LockName[]; isRemote?: boolean } | null>(null);

	function confirmConsent(): void {
		if (pendingConsent) {
			if (pendingConsent.isRemote) {
				// Remote post-handshake path: already attached — record consent so the effect
				// doesn't re-prompt. Reassign (new Set) so the $effect dependency re-runs.
				remoteConsentedIds = new Set([...remoteConsentedIds, pendingConsent.id]);
			} else {
				// In-process pre-attach path: commit the selection now.
				setActiveConductor(pendingConsent.id);
			}
		}
		pendingConsent = null;
		closeMenu();
	}
	function cancelConsent(): void {
		if (pendingConsent?.isRemote) {
			// Remote post-handshake cancel: detach (kill switch — freezes + unlocks) for an
			// immediate, synchronous revert of the locked view.
			store?.detach();
			// Bug #2: detach() alone is NOT durable. The selection still points at the declined
			// remote id, and the live RemoteRunner is still attached — so the auto-recovery path
			// (a socket drop bumps conductorRetry.tick → the attach effect re-dials the SAME
			// activeId) would silently re-attach and re-lock the conductor the user just declined.
			// Reset the selection to Raw so the attach effect tears the runner down (attachConductor
			// closes activeRemote on a NONE_ID switch) and never re-dials it. Mirrors handleStop /
			// forget, which fall the active selection back when their conductor goes away.
			setActiveConductor(NONE_ID);
		}
		pendingConsent = null; // revert: never attached (in-process) or detached (remote)
	}

	// ── Post-handshake consent for REMOTE exclusive conductors (ADR 0011 §6) ────
	// Remote conductors only reveal their lock-set in `conductor/hello` (after the WS
	// handshake), so the in-process pre-attach gate above never sees them. We watch
	// `store.conductor` reactively; when a remote conductor's locks arrive exclusive we
	// show the SAME ConsentDialog. On CANCEL we call `store.detach()` (the kill switch —
	// freezes the current folded view and unlocks every control). On CONFIRM we just
	// record the id so we don't re-prompt on the same session.
	//
	// RESIDUAL: this prompt fires after the handshake, so the remote may apply its first
	// plan before the user responds. Cancel → detach cleanly freezes/reverts that state.
	// The engine separately releases held overrides when the remote locks arrive.
	//
	// NOTE: launchable external conductors also flow through this path — launching selects
	// the id, the WS handshake delivers locks, and this effect prompts if exclusive. The
	// handleLaunch() path deliberately does NOT suppress this gate.
	// Reassignment-based (not .add()) so the $effect re-runs when new ids are recorded.
	let remoteConsentedIds = $state(new Set<string>());

	$effect(() => {
		const cond = store?.conductor;
		// Read the lock-set off the store's REACTIVE snapshot, NOT `cond.locks` (Bug #1): a remote
		// runner mutates its `locks` field in place when `conductor/hello` lands, so `store.conductor`
		// keeps the same object reference and `cond.locks` would never re-track. `store.locks` is the
		// `$state` snapshot the store reassigns in reconcileLocks(), so this effect re-runs when a
		// remote's locks finally arrive — which is the whole point of the post-handshake gate.
		const locks = store?.locks ?? [];
		// Guard: no conductor, dialog already open, or conductor is in-process → skip.
		if (!cond || pendingConsent) return;
		if (inProcessConductor(cond.id)) return;
		if (!isExclusive(locks)) return;
		if (remoteConsentedIds.has(cond.id)) return;

		// Remote exclusive conductor not yet consented — show the post-handshake gate.
		// `isRemote: true` tells confirmConsent/cancelConsent to use the remote path:
		// confirm → record as consented (already attached); cancel → store.detach().
		pendingConsent = { id: cond.id, label: cond.label, locks, isRemote: true };
	});

	let rootEl = $state<HTMLDivElement>();
	let triggerEl = $state<HTMLButtonElement>();
	let urlInputEl = $state<HTMLInputElement>();

	// ── Merged external row list ────────────────────────────────────────────────
	// Uses the pure `mergeExternalConductors` helper (also unit-tested separately).
	// Three sources merged and deduped by id, in priority order:
	//  • running   — discovered; may also be launchable or configured
	//  • stopped   — in launchable list, NOT yet discovered
	//  • configured — hand-entered URL, NOT discovered and NOT launchable
	// (ExternalRow type is re-exported from conductorMerge.ts)
	const externalRows = $derived.by((): ExternalRow[] => {
		// Read all reactive sources so Svelte tracks each one.
		const discovered = conductorDiscovery.discovered;
		const configured = conductorDiscovery.configured;
		const launchableList = launchable;
		// isLaunching is also reactive (reads launchingSet), so touch it here to stay subscribed.
		const _anyLaunching = launchableList.some((c) => isLaunching(c.id));
		void _anyLaunching;
		return mergeExternalConductors(discovered, launchableList, configured, new Set(
			launchableList.filter((c) => isLaunching(c.id)).map((c) => c.id),
		));
	});

	// Ids of CONFIGURED entries — needed for the allConductors() isRemote check and Forget.
	const configuredIds = $derived(new Set(conductorDiscovery.configured.map((c) => c.id)));
	// The externals available to switch to (for isRemote / activeLabel — still using allConductors()).
	const externals = $derived(allConductors());

	const activeId = $derived(conductorState.activeId);
	// "Remote" chrome (accent + status dot) only when the selected external actually resolves
	// to a known entry. A selected-but-undiscovered remote (e.g. a cfg: id restored from
	// localStorage before discovery, or one that went offline) falls back to the built-in in
	// the engine — so the trigger must NOT wear remote accent + a dot next to a "Built-in"
	// label. Gating on the list keeps label/accent/dot honest and in lockstep with attach.
	const isRemote = $derived(
		!inProcessConductor(activeId) && activeId !== NONE_ID && externals.some((c) => c.id === activeId),
	);
	// Resolve the SELECTED id to a label. An in-process id (built-in or a sibling) resolves to its
	// registry label; Raw is Raw; otherwise a discovered remote's label, falling back to the
	// external-row label (launchable/configured) or the raw id for an unknown selection.
	const activeLabel = $derived(
		inProcessConductor(activeId)?.label ??
			(activeId === NONE_ID
				? "Raw"
				: (externals.find((c) => c.id === activeId)?.label ??
					externalRows.find((r) => r.id === activeId)?.label ??
					activeId)),
	);

	// The ACTIVE conductor's live lock-set (source of truth once attached — covers remote
	// conductors whose locks only arrive in the handshake). Drives the trigger's "locked"
	// chrome and the "detach to regain control" hint. Reads the store's REACTIVE snapshot
	// (`store.locks`), not `store.conductor.locks`: a remote runner mutates its locks in place,
	// so only the snapshot reassignment re-tracks (Bug #1).
	const activeLocks = $derived<readonly LockName[]>(store?.locks ?? []);
	const activeExclusive = $derived(isExclusive(activeLocks));

	function toggle(): void {
		open = !open;
		if (!open) closeAddPanel();
	}

	function closeMenu(): void {
		open = false;
		closeAddPanel();
		launchErrors = {};
	}

	function closeAddPanel(): void {
		showAdd = false;
		urlDraft = "";
		urlError = "";
	}

	// The lock-set an in-process conductor DECLARES (known without instantiating it, via the
	// registry entry). Remote conductors only reveal their locks after the `conductor/hello`
	// handshake, so they're treated as collaborative until attached — the live `store.conductor`
	// is the source of truth once that happens.
	function declaredLocks(id: string): readonly LockName[] {
		return inProcessConductor(id)?.locks ?? [];
	}

	function select(id: string): void {
		// Re-selecting the active conductor is a no-op (no re-handover prompt).
		if (id === activeId) {
			closeMenu();
			return;
		}
		const locks = declaredLocks(id);
		if (isExclusive(locks)) {
			// Exclusive → hold the pick behind the consent gate (ADR 0011 §6). The menu stays
			// closed visually behind the modal; the pick only commits on confirm.
			pendingConsent = { id, label: inProcessConductor(id)?.label ?? id, locks };
			open = false;
			return;
		}
		setActiveConductor(id);
		closeMenu();
	}

	function forget(id: string, e: MouseEvent): void {
		// Forgetting a configured conductor must NOT close the menu. But if it was the ACTIVE
		// one, fall the selection back to the built-in: the engine already does this safely,
		// and matching it here keeps the trigger label, accent, status dot, and the menu's
		// checkmark from stranding on a now-deleted id.
		e.stopPropagation();
		if (conductorState.activeId === id) setActiveConductor(BUILTIN_ID);
		removeConfiguredConductor(id);
	}

	function handleStop(id: string, e: MouseEvent): void {
		e.stopPropagation();
		if (conductorState.activeId === id) setActiveConductor(BUILTIN_ID);
		void stopConductor(id);
	}

	async function handleLaunch(id: string, e: MouseEvent): Promise<void> {
		e.stopPropagation();
		const prevActive = conductorState.activeId;
		// Select first so the attach effect is armed; the flash-suppression guard in
		// +page.svelte holds the built-in fallback while isLaunching(id) is true.
		setActiveConductor(id);
		try {
			await launchConductor(id);
		} catch (err) {
			// Revert selection and show the error inline — but ONLY if the user is still on the id
			// we launched. They may have picked another conductor while the launch was in flight;
			// stomping their newer selection back to prevActive would be wrong.
			if (conductorState.activeId === id) setActiveConductor(prevActive);
			launchErrors = { ...launchErrors, [id]: String(err) };
		}
	}

	// Watchdog-driven revert: when a launch silently fails (process spawned but never connected),
	// the discovery module records it in `launchFailures` and clears the launching flag. Surface
	// that by falling the selection back to the built-in — but, as in the reject path above, only
	// if the user is still parked on the failed id (don't stomp a newer selection). The inline
	// error itself renders directly from `launchFailures[row.id]` in the template.
	$effect(() => {
		for (const id of Object.keys(launchFailures)) {
			if (conductorState.activeId === id) setActiveConductor(BUILTIN_ID);
		}
	});

	async function openAddPanel(): Promise<void> {
		showAdd = true;
		urlError = "";
		// Wait for Svelte to mount the input before focusing — a bare microtask can race the
		// framework's own DOM flush and silently no-op (urlInputEl still undefined).
		await tick();
		urlInputEl?.focus();
	}

	function submitUrl(): void {
		const entry = addConfiguredConductor(urlDraft.trim());
		if (entry) {
			setActiveConductor(entry.id);
			urlDraft = "";
			urlError = "";
			closeMenu();
		} else {
			urlError = "Enter a ws:// or wss:// URL"; // invalid scheme — don't fail silently
		}
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
				triggerEl?.focus(); // keyboard dismissal — return focus to the trigger
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

<div class="cond-menu" bind:this={rootEl}>
	<!-- Trigger: a clickable evolution of the old .cond-status badge. -->
	<button
		type="button"
		class="cond-trigger"
		class:remote={isRemote}
		class:locked={activeExclusive}
		class:open
		bind:this={triggerEl}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label="Switch conductor"
		title={"Conductor: " +
			activeLabel +
			(isRemote ? " · " + conductorLink.status : "") +
			(activeExclusive ? " · exclusive (locked) — detach to take back control" : "") +
			" — click to switch"}
		onclick={toggle}
	>
		<Icon name={activeExclusive ? "lock" : "sliders-horizontal"} size={11} />
		<span class="cond-trigger-label">{activeLabel}</span>
		{#if isRemote}
			<span
				class="cond-status-dot"
				class:connected={conductorLink.status === "connected"}
				class:error={conductorLink.status === "error"}
				aria-hidden="true"
			></span>
		{/if}
		<Icon name="chevron-down" size={11} />
	</button>

	{#if open}
		<div class="cond-pop" role="menu" aria-label="Conductors">
			<!-- In-process conductors (registry-driven — Built-in + any compiled-in sibling) -->
			{#each IN_PROCESS_CONDUCTORS as c (c.id)}
				<button
					type="button"
					class="cond-item"
					class:active={activeId === c.id}
					role="menuitemradio"
					aria-checked={activeId === c.id}
					onclick={() => select(c.id)}
				>
					<span class="cond-check">
						{#if activeId === c.id}<Icon name="check" size={13} />{/if}
					</span>
					<span class="cond-item-label">{c.label}</span>
					{#if isExclusive(c.locks)}
						<!-- Compact lock table: one mark per lockable control (✗ = taken, ✓ = yours). -->
						<span class="lock-mini" title="Exclusive — {c.locks!.length} of 3 controls taken over (you can always detach)">
							<Icon name="lock" size={10} />
							{#each LOCK_NAMES as name (name)}
								<span class="lock-pip" class:taken={hasLock(c.locks, name)} aria-hidden="true"></span>
							{/each}
						</span>
					{/if}
				</button>
			{/each}

			<!-- Discovered (running) + launchable-stopped + configured-only externals -->
			{#each externalRows as row (row.id)}
				<div class="cond-row">
					{#if row.kind === "running"}
						<button
							type="button"
							class="cond-item"
							class:active={activeId === row.id}
							role="menuitemradio"
							aria-checked={activeId === row.id}
							title={row.url}
							onclick={() => select(row.id)}
						>
							<span class="cond-check">
								{#if activeId === row.id}<Icon name="check" size={13} />{/if}
							</span>
							<span class="cond-item-label">{row.label}</span>
						</button>
						{#if isTauriEnv && row.canLaunch}
							<button
								type="button"
								class="cond-action-btn"
								title="Stop this conductor"
								aria-label="Stop conductor"
								onclick={(e) => handleStop(row.id, e)}
							>
								<Icon name="square" size={10} />
							</button>
						{:else if row.canForget}
							<button
								type="button"
								class="cond-forget"
								title="Forget this conductor"
								aria-label="Forget conductor"
								onclick={(e) => forget(row.id, e)}
							>
								<Icon name="x" size={11} />
							</button>
						{/if}
					{:else if row.kind === "stopped"}
						<button
							type="button"
							class="cond-item cond-item-stopped"
							class:active={activeId === row.id}
							role="menuitemradio"
							aria-checked={activeId === row.id}
							onclick={(e) => { e.preventDefault(); void handleLaunch(row.id, e as MouseEvent); }}
						>
							<span class="cond-check">
								{#if activeId === row.id && isLaunching(row.id)}
									<span class="cond-spinner" aria-hidden="true"></span>
								{:else if activeId === row.id}
									<Icon name="check" size={13} />
								{/if}
							</span>
							<span class="cond-item-label">{row.label}</span>
							<span class="cond-stopped-badge">
								{#if isLaunching(row.id)}Launching…{:else}stopped{/if}
							</span>
						</button>
						{#if isTauriEnv && !isLaunching(row.id)}
							<button
								type="button"
								class="cond-action-btn cond-launch-btn"
								title="Launch this conductor"
								aria-label="Launch conductor"
								onclick={(e) => void handleLaunch(row.id, e)}
							>
								<Icon name="play" size={10} />
							</button>
						{/if}
					{:else}
						<!-- configured-only (hand-entered URL) -->
						<button
							type="button"
							class="cond-item"
							class:active={activeId === row.id}
							role="menuitemradio"
							aria-checked={activeId === row.id}
							title={row.url}
							onclick={() => select(row.id)}
						>
							<span class="cond-check">
								{#if activeId === row.id}<Icon name="check" size={13} />{/if}
							</span>
							<span class="cond-item-label">{row.label}</span>
						</button>
						<button
							type="button"
							class="cond-forget"
							title="Forget this conductor"
							aria-label="Forget conductor"
							onclick={(e) => forget(row.id, e)}
						>
							<Icon name="x" size={11} />
						</button>
					{/if}
				</div>
				<!-- One error line per row: a direct launch reject (launchErrors) OR a silent
				     watchdog timeout (launchFailures). The reject path is shown first if both ever
				     coexist; in practice only one is set for a given attempt. -->
				{#if launchErrors[row.id] ?? launchFailures[row.id]}
					<p class="cond-launch-error">{launchErrors[row.id] ?? launchFailures[row.id]}</p>
				{/if}
			{/each}

			<!-- The kill switch (ADR 0011 §6): selecting Raw detaches, which FREEZES the current
			     folded view as human-owned and unlocks every control. Always available — no lock
			     can disable it. When an exclusive conductor is active we surface it as the way back. -->
			{#if activeExclusive}
				<p class="cond-locked-hint">
					<Icon name="lock" size={10} />
					Locked by <b>{activeLabel}</b> — detach to take back control.
				</p>
			{/if}
			<button
				type="button"
				class="cond-item raw"
				class:active={activeId === NONE_ID}
				class:detach={activeExclusive}
				role="menuitemradio"
				aria-checked={activeId === NONE_ID}
				title={activeExclusive
					? "Detach: freeze the current folded view as yours and unlock every control"
					: "Raw — no conductor managing this context"}
				onclick={() => select(NONE_ID)}
			>
				<span class="cond-check">
					{#if activeExclusive}
						<Icon name="square" size={11} />
					{:else if activeId === NONE_ID}
						<Icon name="check" size={13} />
					{/if}
				</span>
				<span class="cond-item-label">{activeExclusive ? "Detach (freeze & take back control)" : "Raw"}</span>
			</button>

			<div class="cond-sep" role="separator"></div>

			{#if !showAdd}
				<button type="button" class="cond-item cond-add-action" onclick={openAddPanel}>
					<span class="cond-check"><Icon name="plus" size={13} /></span>
					<span class="cond-item-label">Add conductor…</span>
				</button>
			{:else}
				<div class="cond-add-panel">
					<div class="cond-add-row">
						<input
							class="cond-url"
							type="text"
							placeholder="ws://…"
							bind:this={urlInputEl}
							bind:value={urlDraft}
							oninput={() => (urlError = "")}
							onkeydown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									submitUrl();
								}
							}}
						/>
						<button type="button" class="cond-url-add" onclick={submitUrl}>Connect</button>
					</div>
					{#if urlError}<p class="cond-url-error">{urlError}</p>{/if}
				</div>
			{/if}
		</div>
	{/if}

	{#if pendingConsent}
		<ConsentDialog
			label={pendingConsent.label}
			locks={pendingConsent.locks}
			onconfirm={confirmConsent}
			oncancel={cancelConsent}
		/>
	{/if}
</div>

<style>
	.cond-menu {
		position: relative;
		display: inline-flex;
	}

	/* ── Trigger: clickable version of the old .cond-status badge ── */
	.cond-trigger {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: var(--fs-xs);
		font-weight: 600;
		letter-spacing: 0.01em;
		color: var(--muted);
		background: var(--panel-2);
		border: 1px solid var(--line);
		padding: 3px 7px 3px 7px;
		border-radius: var(--radius-pill);
		white-space: nowrap;
		user-select: none;
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out);
	}
	.cond-trigger:hover,
	.cond-trigger.open {
		background: var(--panel-4);
		border-color: var(--line-strong);
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

	/* Remote accent treatment — mirrors .cond-status.remote */
	.cond-trigger.remote {
		color: var(--accent);
		background: var(--accent-soft);
		border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
	}
	.cond-trigger.remote:hover,
	.cond-trigger.remote.open {
		background: color-mix(in srgb, var(--accent) 18%, var(--panel));
		border-color: var(--accent);
		color: var(--accent);
	}

	.cond-status-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--faint);
		flex: 0 0 auto;
	}
	.cond-status-dot.connected {
		background: var(--accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent);
	}
	.cond-status-dot.error {
		background: var(--k-tool_result, #f0a35e);
	}

	/* Exclusive (locked) conductor — the trigger wears a warning accent so the handover is
	   never invisible. Takes precedence over the remote accent (both can be true at once). */
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

	/* ── Popover ── */
	.cond-pop {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 50;
		min-width: 220px;
		max-width: 320px;
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
	/* When an exclusive conductor is active, the Raw row IS the kill switch — give it weight. */
	.cond-item.raw.detach {
		color: var(--warn);
		font-weight: 600;
	}
	.cond-item.raw.detach .cond-check {
		color: var(--warn);
	}

	/* Compact lock table on an exclusive conductor's menu row: a lock glyph + 3 pips
	   (filled = taken over). Reads at a glance without instantiating the conductor. */
	.lock-mini {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		flex: 0 0 auto;
		color: var(--warn);
		margin-left: 2px;
	}
	.lock-pip {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		border: 1px solid color-mix(in srgb, var(--warn) 55%, transparent);
		background: transparent;
	}
	.lock-pip.taken {
		background: var(--warn);
		border-color: var(--warn);
	}

	/* "Locked by X — detach to take back control" hint above the kill switch. */
	.cond-locked-hint {
		display: flex;
		align-items: center;
		gap: 5px;
		margin: 4px 6px 2px;
		font-size: var(--fs-2xs);
		line-height: 1.4;
		color: var(--warn);
	}
	.cond-locked-hint b {
		font-weight: 600;
	}

	/* Fixed-width leading slot so the check (or +) never shifts the label. */
	.cond-check {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 13px;
		flex: 0 0 auto;
		color: var(--accent);
	}
	.cond-add-action .cond-check {
		color: var(--muted);
	}

	.cond-item-label {
		flex: 1 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* A configured row pairs the selectable item with a trailing "Forget" button as
	   siblings (a button can't legally nest inside a button). */
	.cond-row {
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.cond-row .cond-item {
		flex: 1 1 auto;
		min-width: 0;
	}

	/* Trailing "Forget" button on configured rows. */
	.cond-forget {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 24px;
		height: 24px;
		padding: 0;
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		color: var(--faint);
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out);
	}
	.cond-forget:hover {
		background: var(--panel-4);
		color: var(--text);
	}
	.cond-forget:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.cond-sep {
		height: 1px;
		margin: 4px 2px;
		background: var(--line-soft);
	}

	.cond-add-action {
		color: var(--muted);
	}

	/* ── Inline add panel ── */
	.cond-add-panel {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 3px 4px 4px;
	}
	.cond-add-row {
		display: flex;
		gap: 5px;
	}
	.cond-url {
		flex: 1 1 auto;
		min-width: 0;
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		color: var(--text);
		background: var(--panel-2);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		padding: 5px 7px;
		outline: none;
	}
	.cond-url::placeholder {
		color: var(--faint);
	}
	.cond-url:focus-visible {
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
	}
	.cond-url-add {
		flex: 0 0 auto;
		font-size: var(--fs-2xs);
		font-weight: 600;
		color: var(--accent);
		background: var(--accent-soft);
		border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line));
		border-radius: var(--radius-sm);
		padding: 5px 9px;
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out);
	}
	.cond-url-add:hover {
		background: color-mix(in srgb, var(--accent) 22%, var(--panel));
		border-color: var(--accent);
	}
	.cond-url-add:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
	.cond-url-error {
		margin: 0;
		font-size: var(--fs-2xs);
		color: var(--k-tool_result, #f0a35e);
	}

	/* ── Launch / Stop action buttons ── */
	/* Shares shape with .cond-forget; distinct accent for each action. */
	.cond-action-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 24px;
		height: 24px;
		padding: 0;
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		color: var(--faint);
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out);
	}
	.cond-action-btn:hover {
		background: var(--panel-4);
		color: var(--text);
	}
	.cond-action-btn:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
	/* Launch button gets a subtle accent on hover */
	.cond-launch-btn:hover {
		color: var(--accent);
	}

	/* Stopped-state badge shown inline in the row label area */
	.cond-stopped-badge {
		flex: 0 0 auto;
		font-size: var(--fs-2xs);
		font-weight: 500;
		color: var(--faint);
		opacity: 0.75;
		margin-left: 4px;
	}

	/* De-emphasise a stopped (not-running) row */
	.cond-item-stopped {
		color: var(--muted);
		opacity: 0.75;
	}
	.cond-item-stopped.active {
		opacity: 1;
		color: var(--accent);
	}

	/* Inline launch error */
	.cond-launch-error {
		margin: 2px 8px 3px;
		font-size: var(--fs-2xs);
		color: var(--k-tool_result, #f0a35e);
		line-height: 1.4;
		word-break: break-word;
	}

	/* Tiny spinner for the "launching" state */
	@keyframes cond-spin {
		to { transform: rotate(360deg); }
	}
	.cond-spinner {
		display: inline-block;
		width: 9px;
		height: 9px;
		border: 1.5px solid color-mix(in srgb, var(--accent) 35%, transparent);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: cond-spin 0.7s linear infinite;
		flex: 0 0 auto;
	}
</style>
