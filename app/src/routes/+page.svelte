<script lang="ts">
	import { onMount } from "svelte";
	import { parse } from "$lib/engine/parse";
	import { AccordionStore } from "$lib/engine/store.svelte";
	import ContextSummary from "$lib/ui/ContextSummary.svelte";
	import ContextTimeline from "$lib/ui/ContextTimeline.svelte";
	import Timeline from "$lib/ui/Timeline.svelte";

	let store = $state<AccordionStore | null>(null);
	let error = $state("");
	let view = $state<"summary" | "timeline">("summary");

	onMount(async () => {
		try {
			const res = await fetch("/sample-session.jsonl");
			if (!res.ok) throw new Error(`failed to load sample (${res.status})`);
			const parsed = parse(await res.text());
			store = new AccordionStore(parsed);
			if (typeof window !== "undefined") (window as any).__store = store; // debug handle
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	});

	const fmt = (n: number) => n.toLocaleString();

	function pick(id: string) {
		const el = document.getElementById("block-" + id);
		if (!el) return;
		el.scrollIntoView({ behavior: "smooth", block: "center" });
		el.classList.add("flash");
		setTimeout(() => el.classList.remove("flash"), 900);
	}

	function baseName(p: string): string {
		return p ? p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p : "";
	}
</script>

<svelte:head><title>Accordion</title></svelte:head>

{#if error}
	<div class="fallback">
		<h1>🪗 Accordion</h1>
		<p class="err">Couldn't load the session: {error}</p>
	</div>
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
						· {store.blocks.length} blocks
					</div>
				</div>
			</div>
			<a class="nav" href="/map" data-sveltekit-reload={false}>Map view →</a>
		</header>

		<section class="contextpane">
			<div class="switch">
				<button class:on={view === "summary"} onclick={() => (view = "summary")}>Summary</button>
				<button class:on={view === "timeline"} onclick={() => (view = "timeline")}>Timeline</button>
			</div>
			{#if view === "summary"}
				<ContextSummary {store} onpick={pick} />
			{:else}
				<ContextTimeline {store} onpick={pick} />
			{/if}
		</section>

		<div class="main">
			<main class="scroll">
				<Timeline {store} />
			</main>

			<aside>
				<div class="ctl">
					<label class="ctl-l" for="budget">
						Context budget <b class="mono">{fmt(store.budget)}</b>
					</label>
					<input
						id="budget"
						type="range"
						min="12000"
						max="160000"
						step="2000"
						value={store.budget}
						oninput={(e) => store!.setBudget(+e.currentTarget.value)}
					/>
					<button class="btn" onclick={() => store!.resetAll()}>Reset all to auto</button>
				</div>

				<div class="feed">
					<div class="feed-h">Activity</div>
					{#if store.log.length === 0}
						<div class="empty muted">Fold, unfold or pin a block — moves show here, attributed.</div>
					{/if}
					{#each store.log as ev (ev.n)}
						<div class="ev">
							<span class="who who-{ev.by}">{ev.by}</span>
							<span class="ev-a">{ev.action}</span>
							<span class="ev-d">{ev.detail}</span>
						</div>
					{/each}
				</div>
			</aside>
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
	.titles {
		min-width: 0;
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

	.contextpane {
		padding: 14px 16px;
		border-bottom: 1px solid var(--line);
		background: var(--bg);
		flex: 0 0 auto;
		display: flex;
		flex-direction: column;
		gap: 11px;
	}
	.switch {
		display: inline-flex;
		align-self: flex-start;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		padding: 2px;
		gap: 2px;
	}
	.switch button {
		background: transparent;
		border: none;
		color: var(--muted);
		font-size: 12px;
		font-weight: 600;
		padding: 4px 14px;
		border-radius: 5px;
		transition: background 120ms ease, color 120ms ease;
	}
	.switch button:hover {
		color: var(--text);
	}
	.switch button.on {
		background: var(--panel-3);
		color: var(--text);
	}

	.main {
		flex: 1;
		display: grid;
		grid-template-columns: minmax(0, 1fr) 290px;
		overflow: hidden;
	}
	.scroll {
		overflow-y: auto;
		padding: 8px 16px;
	}
	aside {
		border-left: 1px solid var(--line);
		background: var(--panel);
		overflow-y: auto;
		padding: 14px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.ctl {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.ctl-l {
		font-size: 12px;
		color: var(--muted);
		display: flex;
		justify-content: space-between;
	}
	.ctl-l b {
		color: var(--text);
	}
	input[type="range"] {
		width: 100%;
		accent-color: var(--accent);
	}
	.btn {
		background: var(--panel-3);
		border: 1px solid var(--line);
		color: var(--text);
		padding: 6px 10px;
		border-radius: var(--radius-sm);
		font-size: 12px;
		transition: background 120ms ease;
	}
	.btn:hover {
		background: var(--line);
	}

	.feed {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-height: 0;
	}
	.feed-h {
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--faint);
		font-weight: 600;
	}
	.empty {
		font-size: 12px;
		line-height: 1.5;
	}
	.ev {
		font-size: 12px;
		display: flex;
		gap: 6px;
		align-items: baseline;
	}
	.who {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 1px 5px;
		border-radius: 4px;
		background: var(--panel-3);
		color: var(--muted);
		flex: 0 0 auto;
	}
	.who-you {
		color: var(--accent);
	}
	.who-auto {
		color: var(--warn);
	}
	.who-agent {
		color: var(--ok);
	}
	.ev-a {
		color: var(--text);
	}
	.ev-d {
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.muted {
		color: var(--muted);
	}
	:global(.flash) {
		animation: flash 0.9s ease;
	}
	@keyframes flash {
		0%,
		100% {
			box-shadow: 0 0 0 0 transparent;
		}
		30% {
			box-shadow: 0 0 0 2px var(--accent);
		}
	}
</style>
