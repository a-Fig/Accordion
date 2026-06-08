<script lang="ts">
	import { onMount } from "svelte";
	import { session, isTauriEnv, loadSample, openFile, loadFilePath } from "$lib/session.svelte.ts";
	import { connectLive, disconnectLive, live } from "$lib/live/liveClient.svelte";
	import { discovery, startDiscovery, stopDiscovery, selectSession, DEMO_ID } from "$lib/live/discovery.svelte";
	import { claudeDiscovery, startClaudeDiscovery, stopClaudeDiscovery, selectClaude } from "$lib/live/claudeDiscovery.svelte";
	import { DEFAULT_PORT } from "$lib/live/protocol";
	import type { SessionEntry } from "$lib/live/registry";
	import type { ClaudeCodeSession } from "$lib/live/claude";
	import SessionsSidebar from "$lib/ui/live/SessionsSidebar.svelte";
	import MapHeader from "$lib/ui/map/MapHeader.svelte";
	import ContextMap from "$lib/ui/map/ContextMap.svelte";
	import Inspector from "$lib/ui/map/Inspector.svelte";

	let selectedId = $state<string | null>(null);
	let manualPort = $state(DEFAULT_PORT);

	// Which session source the sidebar lists: live pi vs read-only Claude Code.
	const SRC_KEY = "accordion.sidebar.source";
	let source = $state<"pi" | "claude">(
		typeof localStorage !== "undefined" && localStorage.getItem(SRC_KEY) === "claude" ? "claude" : "pi",
	);
	$effect(() => {
		if (typeof localStorage !== "undefined") localStorage.setItem(SRC_KEY, source);
	});
	// Claude Code discovery scans 50 file-heads every 3s — run it only while its tab
	// is the active source; pi discovery (cheap registry reads) always runs.
	$effect(() => {
		if (isTauriEnv && source === "claude") startClaudeDiscovery();
		else stopClaudeDiscovery();
	});

	const selected = $derived(
		session.store && selectedId ? session.store.blocks.find((b) => b.id === selectedId) ?? null : null,
	);
	const demoSelected = $derived(discovery.selected === DEMO_ID);

	// Drop any open Inspector selection when the underlying store is replaced (session
	// switch, full resync, demo, or Open) so a stale id cannot resolve against a
	// different store and pop the Inspector open on the wrong session.
	let _prevStore: typeof session.store = null;
	$effect(() => {
		if (session.store !== _prevStore) {
			_prevStore = session.store;
			selectedId = null;
		}
	});

	function baseName(p: string): string {
		return p ? p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p : "";
	}

	function selectAndConnect(s: SessionEntry): void {
		if (discovery.selected === s.sessionId && live.status === "connected") return;
		session.readOnly = false; // a live pi session is steerable, not read-only
		selectClaude(null);
		selectSession(s.sessionId);
		connectLive(s.port);
	}

	// The bundled demo behaves like a session you can pick — it just loads the
	// sample transcript instead of dialing a live pi over the socket.
	function selectDemo(): void {
		disconnectLive();
		selectClaude(null);
		selectSession(DEMO_ID);
		loadSample();
	}

	// A Claude Code transcript: load it read-only and tail it for appends. There is
	// no live socket to steer — folds here are a personal lens (see MapHeader badge).
	function selectClaudeSession(s: ClaudeCodeSession): void {
		disconnectLive();
		selectSession(null);
		selectClaude(s.sessionId);
		loadFilePath(s.filePath);
	}

	function onFocusRequest(sessionId: string): void {
		const s = discovery.sessions.find((x) => x.sessionId === sessionId);
		if (s) selectAndConnect(s);
	}

	onMount(() => {
		startDiscovery(onFocusRequest);
		return () => {
			stopDiscovery();
			stopClaudeDiscovery();
			disconnectLive();
		};
	});
</script>

<svelte:head><title>Accordion</title></svelte:head>

<div class="shell" class:railed={isTauriEnv}>
	{#if isTauriEnv}
		<SessionsSidebar
			{source}
			onsource={(s) => (source = s)}
			sessions={discovery.sessions}
			selected={discovery.selected}
			connected={live.status === "connected"}
			{demoSelected}
			onselect={selectAndConnect}
			ondemo={selectDemo}
			claudeSessions={claudeDiscovery.sessions}
			claudeSelected={claudeDiscovery.selected}
			onselectclaude={selectClaudeSession}
		/>
	{/if}

	<div class="content">
		{#if session.store}
			{@const s = session.store}
			<div class="app">
				<header class="topbar">
					<div class="brand">
						<span class="logo">🪗</span>
						<div class="titles">
							<div class="t1">
								{session.filePath ? baseName(session.filePath) : s.meta.title}
								{#if live.status === "connected"}<span class="live-dot" title="Live — connected to pi"></span>
								{:else if session.live}<span class="live-dot" title="Live — polling for changes"></span>{/if}
							</div>
							<div class="t2 mono">
								{s.meta.model || s.meta.format}
								{#if s.meta.cwd}· {baseName(s.meta.cwd)}{/if}
								· {s.blocks.length} blocks
							</div>
						</div>
					</div>
					<div class="nav-row">
						{#if live.status === "connected"}
							<button class="nav" onclick={disconnectLive}>Disconnect</button>
						{:else if isTauriEnv}
							<button class="nav" onclick={openFile}>Open…</button>
						{/if}
					</div>
				</header>

				<MapHeader store={s} readOnly={session.readOnly} />

				<div class="main" class:open={!!selected}>
					<div class="canvas">
						<ContextMap store={s} {selectedId} onselect={(id) => (selectedId = selectedId === id ? null : id)} />
					</div>
					{#if selected}
						<Inspector store={s} block={selected} onclose={() => (selectedId = null)} />
					{/if}
				</div>
			</div>
		{:else}
			<div class="fallback">
				<span class="hero-logo">🪗</span>
				<h1>Accordion</h1>
				{#if isTauriEnv}
					<p class="sub">
						{#if discovery.sessions.length}
							Pick a live pi session on the left to watch its context.
						{:else}
							Start <code>pi</code> in a project — it appears in the sidebar automatically.
						{/if}
					</p>
					<button class="btn-open" onclick={openFile}>Open session file…</button>
					<p class="hint">Or try the <strong>Demo session</strong> at the bottom of the sidebar.</p>
				{:else}
					<p class="sub">Context-window visualizer for pi and Claude Code sessions</p>
					<p class="hint">
						Live session discovery is a desktop feature — run <code>npm run tauri dev</code>. In the browser you can
						dial a known port or load the sample.
					</p>
					<div class="port-row">
						<input class="port" type="number" min="1" max="65535" bind:value={manualPort} aria-label="pi port" />
						<button
							class="btn-open"
							onclick={() => connectLive(manualPort)}
							disabled={live.status === "connecting"}
						>
							{live.status === "connecting" ? "Connecting…" : "Connect to port"}
						</button>
					</div>
					<button class="btn-ghost" onclick={loadSample}>Load sample (982 blocks)</button>
				{/if}
				{#if live.status === "error"}<p class="err">{live.detail}</p>{/if}
				{#if session.error}<p class="err">{session.error}</p>{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.shell {
		height: 100vh;
		display: flex;
		overflow: hidden;
	}
	.content {
		flex: 1;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.app {
		height: 100%;
		display: flex;
		flex-direction: column;
	}
	.fallback {
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding: 24px;
		text-align: center;
	}
	.fallback .err {
		color: var(--danger);
		font-size: 13px;
	}
	.hero-logo {
		font-size: 48px;
		line-height: 1;
	}
	.fallback h1 {
		font-size: 22px;
		font-weight: 700;
		margin: 0;
	}
	.sub {
		font-size: 13px;
		color: var(--muted);
		margin: 0;
		max-width: 440px;
	}
	.sub code,
	.hint code {
		background: var(--panel-2);
		padding: 1px 5px;
		border-radius: 4px;
	}
	.port-row {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.port {
		width: 96px;
		padding: 9px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--panel);
		color: var(--text);
		font-size: 13px;
	}
	.btn-open {
		background: var(--accent);
		color: #fff;
		border: none;
		padding: 10px 24px;
		border-radius: var(--radius-sm);
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		transition: opacity 120ms ease;
	}
	.btn-open:hover {
		opacity: 0.85;
	}
	.btn-open:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.btn-ghost {
		background: transparent;
		border: 1px solid var(--line);
		color: var(--muted);
		padding: 7px 18px;
		border-radius: var(--radius-sm);
		font-size: 13px;
		cursor: pointer;
		transition: color 120ms ease, border-color 120ms ease;
	}
	.btn-ghost:hover {
		color: var(--text);
		border-color: var(--muted);
	}
	.hint {
		font-size: 11px;
		color: var(--faint);
		margin: 0;
		max-width: 440px;
		line-height: 1.5;
	}
	.hint strong {
		color: var(--muted);
		font-weight: 600;
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
		display: flex;
		align-items: center;
		gap: 7px;
	}
	.t2 {
		font-size: 11px;
		color: var(--muted);
	}
	@keyframes livepulse {
		0%, 100% { opacity: 1; transform: scale(1); }
		50% { opacity: .5; transform: scale(.82); }
	}
	.live-dot {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--ok);
		flex: 0 0 auto;
		animation: livepulse var(--dur-slow) ease-in-out infinite;
	}
	.nav-row {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 0 0 auto;
	}
	.nav {
		font-size: 12px;
		color: var(--accent);
		text-decoration: none;
		padding: 5px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		white-space: nowrap;
		background: transparent;
		cursor: pointer;
		transition: background 120ms ease;
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
