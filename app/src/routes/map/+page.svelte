<script lang="ts">
	import { onMount } from "svelte";
	import { parse } from "$lib/engine/parse";
	import { AccordionStore } from "$lib/engine/store.svelte";
	import MapHeader from "$lib/ui/map/MapHeader.svelte";
	import ContextMap from "$lib/ui/map/ContextMap.svelte";
	import Inspector from "$lib/ui/map/Inspector.svelte";

	let store = $state<AccordionStore | null>(null);
	let error = $state("");
	let selectedId = $state<string | null>(null);

	const selected = $derived(store && selectedId ? store.blocks.find((b) => b.id === selectedId) ?? null : null);

	onMount(async () => {
		try {
			const res = await fetch("/sample-session.jsonl");
			if (!res.ok) throw new Error(`failed to load sample (${res.status})`);
			store = new AccordionStore(parse(await res.text()));
			if (typeof window !== "undefined") (window as any).__store = store;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	});

	function baseName(p: string): string {
		return p ? p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p : "";
	}
</script>

<svelte:head><title>Accordion · Map</title></svelte:head>

{#if error}
	<div class="fallback"><h1>🪗 Accordion · Map</h1><p class="err">Couldn't load the session: {error}</p></div>
{:else if !store}
	<div class="fallback"><p class="muted">Loading session…</p></div>
{:else}
	<div class="app">
		<header class="topbar">
			<div class="brand">
				<span class="logo">🪗</span>
				<div class="titles">
					<div class="t1">{store.meta.title}</div>
					<div class="t2 mono">
						{store.meta.model || store.meta.format}
						{#if store.meta.cwd}· {baseName(store.meta.cwd)}{/if}
						· map view
					</div>
				</div>
			</div>
			<a class="nav" href="/" data-sveltekit-reload={false}>Classic view →</a>
		</header>

		<MapHeader {store} />

		<div class="main" class:open={!!selected}>
			<div class="canvas">
				<ContextMap {store} {selectedId} onselect={(id) => (selectedId = selectedId === id ? null : id)} />
			</div>
			{#if selected}
				<Inspector {store} block={selected} onclose={() => (selectedId = null)} />
			{/if}
		</div>
	</div>
{/if}

<style>
	.app {
		height: 100vh;
		display: flex;
		flex-direction: column;
	}
	.fallback {
		height: 100vh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
	}
	.fallback .err {
		color: var(--danger);
	}
	.muted {
		color: var(--muted);
	}

	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 16px;
		border-bottom: 1px solid var(--line);
		background: var(--panel);
		flex: 0 0 auto;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 11px;
		min-width: 0;
	}
	.logo {
		font-size: 22px;
	}
	.t1 {
		font-weight: 600;
		font-size: 14px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 52vw;
	}
	.t2 {
		font-size: 11px;
		color: var(--muted);
	}
	.nav {
		font-size: 12px;
		color: var(--accent);
		text-decoration: none;
		padding: 5px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		white-space: nowrap;
	}
	.nav:hover {
		background: var(--panel-2);
	}

	.main {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		overflow: hidden;
	}
	.main.open {
		grid-template-columns: minmax(0, 1fr) minmax(360px, 30vw);
	}
	.canvas {
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}
</style>
