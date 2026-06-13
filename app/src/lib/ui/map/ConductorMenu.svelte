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
	import { conductorState, setActiveConductor } from "$lib/live/conductor.svelte";
	import { conductorLink, BUILTIN_ID, NONE_ID } from "$lib/live/conductorClient.svelte";
	import {
		allConductors,
		conductorDiscovery,
		addConfiguredConductor,
		removeConfiguredConductor,
	} from "$lib/live/conductorDiscovery.svelte";

	let open = $state(false);
	let showAdd = $state(false);
	let urlDraft = $state("");
	let urlError = $state("");

	let rootEl = $state<HTMLDivElement>();
	let triggerEl = $state<HTMLButtonElement>();
	let urlInputEl = $state<HTMLInputElement>();

	// The externals available to switch to (discovered + configured, deduped).
	const externals = $derived(allConductors());
	// The ids of CONFIGURED (hand-entered) conductors — only these get a "Forget" button.
	const configuredIds = $derived(new Set(conductorDiscovery.configured.map((c) => c.id)));

	const activeId = $derived(conductorState.activeId);
	// "Remote" chrome (accent + status dot) only when the selected external actually resolves
	// to a known entry. A selected-but-undiscovered remote (e.g. a cfg: id restored from
	// localStorage before discovery, or one that went offline) falls back to the built-in in
	// the engine — so the trigger must NOT wear remote accent + a dot next to a "Built-in"
	// label. Gating on the list keeps label/accent/dot honest and in lockstep with attach.
	const isRemote = $derived(
		activeId !== BUILTIN_ID && activeId !== NONE_ID && externals.some((c) => c.id === activeId),
	);
	// Resolve the SELECTED id to a label. A remote not yet discovered falls back to "Built-in".
	const activeLabel = $derived(
		activeId === BUILTIN_ID
			? "Built-in"
			: activeId === NONE_ID
				? "Raw"
				: (externals.find((c) => c.id === activeId)?.label ?? "Built-in"),
	);

	function toggle(): void {
		open = !open;
		if (!open) closeAddPanel();
	}

	function closeMenu(): void {
		open = false;
		closeAddPanel();
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
			<!-- Built-in -->
			<button
				type="button"
				class="cond-item"
				class:active={activeId === BUILTIN_ID}
				role="menuitemradio"
				aria-checked={activeId === BUILTIN_ID}
				onclick={() => select(BUILTIN_ID)}
			>
				<span class="cond-check">
					{#if activeId === BUILTIN_ID}<Icon name="check" size={13} />{/if}
				</span>
				<span class="cond-item-label">Built-in</span>
			</button>

			<!-- Discovered + configured externals -->
			{#each externals as c (c.id)}
				<div class="cond-row">
					<button
						type="button"
						class="cond-item"
						class:active={activeId === c.id}
						role="menuitemradio"
						aria-checked={activeId === c.id}
						title={c.url}
						onclick={() => select(c.id)}
					>
						<span class="cond-check">
							{#if activeId === c.id}<Icon name="check" size={13} />{/if}
						</span>
						<span class="cond-item-label">{c.label}</span>
					</button>
					{#if configuredIds.has(c.id)}
						<button
							type="button"
							class="cond-forget"
							title="Forget this conductor"
							aria-label="Forget conductor"
							onclick={(e) => forget(c.id, e)}
						>
							<Icon name="x" size={11} />
						</button>
					{/if}
				</div>
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
</style>
