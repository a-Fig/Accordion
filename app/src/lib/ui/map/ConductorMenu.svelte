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
	import { IN_PROCESS_CONDUCTORS, inProcessConductor } from "$conductors";
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

	let open = $state(false);
	let showAdd = $state(false);
	let urlDraft = $state("");
	let urlError = $state("");
	/** Per-id inline launch error text (cleared when the menu closes). */
	let launchErrors = $state<Record<string, string>>({});

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

	function select(id: string): void {
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
		class:open
		bind:this={triggerEl}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label="Switch conductor"
		title={"Conductor: " + activeLabel + (isRemote ? " · " + conductorLink.status : "") + " — click to switch"}
		onclick={toggle}
	>
		<Icon name="sliders-horizontal" size={11} />
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

			<!-- Raw (no conductor) — de-emphasized -->
			<button
				type="button"
				class="cond-item raw"
				class:active={activeId === NONE_ID}
				role="menuitemradio"
				aria-checked={activeId === NONE_ID}
				onclick={() => select(NONE_ID)}
			>
				<span class="cond-check">
					{#if activeId === NONE_ID}<Icon name="check" size={13} />{/if}
				</span>
				<span class="cond-item-label">Raw</span>
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
