<script lang="ts">
	import { onMount } from "svelte";
	import { session, isTauriEnv, loadSample, openFile, loadFilePath } from "$lib/session.svelte.ts";
	import { connectLive, disconnectLive, live } from "$lib/live/liveClient.svelte";
	import { discovery, startDiscovery, stopDiscovery, selectSession, DEMO_ID } from "$lib/live/discovery.svelte";
	import { claudeDiscovery, startClaudeDiscovery, stopClaudeDiscovery, selectClaude } from "$lib/live/claudeDiscovery.svelte";
	import { conductorState } from "$lib/live/conductor.svelte";
	import { startConductorDiscovery, stopConductorDiscovery, allConductors, isLaunching } from "$lib/live/conductorDiscovery.svelte";
	import { attachConductor, conductorRetry } from "$lib/live/conductorClient.svelte";
	import { folding } from "$lib/live/folding.svelte";
	import { DEFAULT_PORT } from "$lib/live/protocol";
	import type { SessionEntry } from "$lib/live/registry";
	import type { ClaudeCodeSession } from "$lib/live/claude";
	import SessionsSidebar from "$lib/ui/live/SessionsSidebar.svelte";
	import MapHeader from "$lib/ui/map/MapHeader.svelte";
	import ContextMap from "$lib/ui/map/ContextMap.svelte";
	import Inspector from "$lib/ui/map/Inspector.svelte";
	import Icon from "$lib/ui/Icon.svelte";

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

	// ── Conductors (ADR 0007) ──────────────────────────────────────────────
	// External conductors to offer in the switcher (discovered + configured). The built-in
	// and "Raw" entries are added by the sidebar itself. Reactive so newly-found conductors
	// appear without a reload.
	const conductors = $derived(allConductors());

	// Attach the selected conductor to the active session's store. Tracks the store, the
	// selection, AND the available list — so a conductor selected before discovery found it
	// (e.g. a remote id restored from localStorage on launch) gets attached once it appears.
	// `attachConductor` is idempotent, so a poll refreshing the list when we're already
	// correctly attached is a no-op (no reconnect churn).
	//
	// Flash suppression: if the active id is a launchable that is still launching (started
	// but not yet discovered), hold — do NOT fall back to built-in while the process is
	// booting. Once discovery sees the heartbeat, isLaunching clears, conductors changes,
	// and this effect re-runs to attach the real RemoteRunner.
	$effect(() => {
		void conductorRetry.tick; // re-fire on a remote-drop retry tick (recover a same-process socket drop)
		const store = session.store;
		const activeId = conductorState.activeId;
		const list = conductors;
		if (!store) return;
		// Suppress the built-in fallback while the process is still starting up.
		if (isLaunching(activeId) && !list.some((c) => c.id === activeId)) return;
		attachConductor(store, activeId, list);
	});

	const selectedBlock = $derived(
		session.store && selectedId ? session.store.blocks.find((b) => b.id === selectedId) ?? null : null,
	);
	const selectedGroup = $derived(
		session.store && selectedId ? session.store.groupById(selectedId) ?? null : null,
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
		startConductorDiscovery();
		return () => {
			stopDiscovery();
			stopClaudeDiscovery();
			stopConductorDiscovery();
			disconnectLive();
		};
	});

	// Two distinct states — keep them separate (they contradict otherwise):
	//  • LIVE     = connected to a pi session over the socket; folds steer the agent.
	//  • WATCHING = tailing a read-only Claude Code transcript; folds are a local lens.
	const isLive = $derived(live.status === "connected");
	const isWatching = $derived(session.live && session.readOnly && live.status !== "connected");
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
						<span class="brand-icon">
							<Icon name="accordion" size={20} stroke={1.75} />
						</span>
						<span class="wordmark">Accordion</span>
						<div class="divider"></div>
						<div class="session-meta">
							<span class="meta-title tnum">
								{session.filePath ? baseName(session.filePath) : s.meta.title}
							</span>
							{#if isLive}
								<span class="live-chip" class:steering={folding.enabled}>
									<span class="live-dot" title="Live — connected to pi; folds steer the agent"></span>
									<span class="live-label">LIVE</span>
								</span>
							{:else if isWatching}
								<span class="live-chip watching">
									<span class="live-dot" title="Watching — tailing a read-only Claude Code transcript; folds are a local lens"></span>
									<span class="live-label">WATCHING</span>
								</span>
							{/if}
						</div>
					</div>
					<div class="meta-row">
						<span class="meta-chip mono tnum">{s.meta.model || s.meta.format}</span>
						{#if s.meta.cwd}
							<span class="meta-sep">·</span>
							<span class="meta-chip mono tnum">{baseName(s.meta.cwd)}</span>
						{/if}
						<span class="meta-sep">·</span>
						<span class="meta-chip mono tnum">{s.blocks.length} blocks</span>
					</div>
					<div class="nav-row">
						{#if live.status === "connected"}
							<button class="nav-btn" onclick={disconnectLive}>
								<Icon name="x" size={13} />
								Disconnect
							</button>
						{:else if isTauriEnv}
							<button class="nav-btn" onclick={openFile}>
								<Icon name="folder" size={13} />
								Open…
							</button>
						{/if}
					</div>
				</header>

				<MapHeader store={s} readOnly={session.readOnly} />

				<div class="main" class:open={!!selectedBlock || !!selectedGroup}>
					<div class="canvas">
						<ContextMap store={s} {selectedId} onselect={(id) => (selectedId = selectedId === id ? null : id)} />
					</div>
					{#if selectedBlock || selectedGroup}
						<Inspector
							store={s}
							block={selectedBlock}
							group={selectedGroup}
							onselect={(id) => (selectedId = id)}
							onclose={() => (selectedId = null)}
						/>
					{/if}
				</div>
			</div>
		{:else}
			<div class="fallback">
				<div class="hero-plate">
					<Icon name="accordion" size={40} stroke={1.5} />
				</div>
				<h1 class="hero-title">Accordion</h1>
				<p class="sub">
					{#if isTauriEnv}
						{#if discovery.sessions.length}
							Pick a live pi session on the left to watch its context.
						{:else}
							Context-window visualizer for pi and Claude Code sessions.
						{/if}
					{:else}
						Context-window visualizer for pi and Claude Code sessions.
					{/if}
				</p>
				{#if isTauriEnv}
					<div class="action-group">
						<button class="btn-primary" onclick={openFile}>
							<Icon name="folder" size={14} />
							Open session file…
						</button>
					</div>
					<p class="hint">Or try the <strong>Demo session</strong> at the bottom of the sidebar.</p>
				{:else}
					<p class="hint">
						Live session discovery is a desktop feature — run <code>npm run tauri dev</code>. In the browser you can
						dial a known port or load the sample.
					</p>
					<div class="port-row">
						<input class="port" type="number" min="1" max="65535" bind:value={manualPort} aria-label="pi port" />
						<button
							class="btn-primary"
							onclick={() => connectLive(manualPort)}
							disabled={live.status === "connecting"}
						>
							<Icon name="activity" size={14} />
							{live.status === "connecting" ? "Connecting…" : "Connect to port"}
						</button>
					</div>
					<button class="btn-ghost" onclick={loadSample}>
						<Icon name="file-text" size={13} />
						Load sample (982 blocks)
					</button>
				{/if}
				{#if live.status === "error"}<p class="err">{live.detail}</p>{/if}
				{#if session.error}<p class="err">{session.error}</p>{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	/* ── Layout shell ─────────────────────────────────────────── */
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

	/* ── Topbar ───────────────────────────────────────────────── */
	.topbar {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		padding: 0 var(--sp-4);
		height: 44px;
		border-bottom: 1px solid var(--line-soft);
		background: var(--panel);
		box-shadow: var(--shadow-1);
		flex: 0 0 auto;
	}

	/* Brand cluster: icon + wordmark + divider + session title */
	.brand {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-width: 0;
		flex: 1;
	}
	.brand-icon {
		color: var(--accent);
		display: flex;
		align-items: center;
		flex: 0 0 auto;
	}
	.wordmark {
		font-size: var(--fs-md);
		font-weight: 700;
		color: var(--text);
		letter-spacing: -0.02em;
		flex: 0 0 auto;
		line-height: 1;
	}
	.divider {
		width: 1px;
		height: 16px;
		background: var(--line);
		flex: 0 0 auto;
		margin: 0 var(--sp-1);
	}
	.session-meta {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-width: 0;
	}
	.meta-title {
		font-size: var(--fs-sm);
		font-weight: 500;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 38vw;
	}

	/* Live / Watching chip — colour driven by --chip so both states share one rule.
	   Preview (default) and Watching = blue; Steering (folding armed) = green. */
	.live-chip {
		--chip: var(--accent);
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: 0 0 auto;
	}
	.live-chip.steering {
		--chip: var(--ok);
	}
	/* compositor-only pulse (transform + opacity) — no per-frame repaint */
	@keyframes livepulse {
		0% { transform: scale(1); opacity: 0.5; }
		70%, 100% { transform: scale(2.6); opacity: 0; }
	}
	.live-dot {
		position: relative;
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--chip);
		flex: 0 0 auto;
	}
	.live-dot::after {
		content: "";
		position: absolute;
		inset: 0;
		border-radius: 50%;
		background: var(--chip);
		animation: livepulse 2s ease-in-out infinite;
		pointer-events: none;
	}
	.live-label {
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--chip);
		letter-spacing: 0.06em;
		line-height: 1;
	}

	/* Meta chips row (model · cwd · blocks) */
	.meta-row {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		flex: 0 0 auto;
	}
	.meta-chip {
		font-size: var(--fs-xs);
		color: var(--faint);
		white-space: nowrap;
	}
	.meta-sep {
		font-size: var(--fs-xs);
		color: var(--faint);
		opacity: 0.5;
		user-select: none;
	}

	/* Nav buttons */
	.nav-row {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		flex: 0 0 auto;
	}
	.nav-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		font-size: var(--fs-sm);
		font-weight: 500;
		color: var(--muted);
		background: var(--panel-3);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		padding: 5px var(--sp-3);
		cursor: pointer;
		white-space: nowrap;
		transition: color var(--dur-fast) var(--ease-out),
		            background var(--dur-fast) var(--ease-out),
		            border-color var(--dur-fast) var(--ease-out);
	}
	.nav-btn:hover {
		color: var(--text);
		background: var(--panel-4);
		border-color: var(--line-strong);
	}

	/* ── Main grid (canvas + inspector) ──────────────────────── */
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

	/* ── Fallback / empty state ───────────────────────────────── */
	.fallback {
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--sp-3);
		padding: var(--sp-5);
		text-align: center;
	}

	/* Hero icon plate */
	.hero-plate {
		width: 80px;
		height: 80px;
		border-radius: var(--radius-lg);
		background: var(--accent-soft);
		border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--accent);
		box-shadow: var(--shadow-2);
		margin-bottom: var(--sp-1);
	}

	.hero-title {
		font-size: var(--fs-2xl);
		font-weight: 700;
		color: var(--text);
		letter-spacing: -0.03em;
		margin: 0;
		line-height: 1.1;
	}
	.sub {
		font-size: var(--fs-base);
		color: var(--muted);
		margin: 0;
		max-width: 400px;
		line-height: 1.55;
	}
	.hint code {
		font-family: var(--mono);
		font-size: var(--fs-xs);
		background: var(--panel-2);
		color: var(--muted);
		padding: 1px 5px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--line);
	}

	/* Action group */
	.action-group {
		display: flex;
		gap: var(--sp-2);
		align-items: center;
		margin-top: var(--sp-1);
	}

	/* Primary CTA */
	.btn-primary {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-2);
		background: var(--accent-soft);
		color: var(--accent);
		border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
		padding: 9px var(--sp-4);
		border-radius: var(--radius-sm);
		font-size: var(--fs-md);
		font-weight: 600;
		cursor: pointer;
		transition: background var(--dur-fast) var(--ease-out),
		            border-color var(--dur-fast) var(--ease-out),
		            color var(--dur-fast) var(--ease-out);
	}
	.btn-primary:hover {
		background: color-mix(in srgb, var(--accent) 22%, transparent);
		border-color: color-mix(in srgb, var(--accent) 50%, transparent);
		color: var(--accent-hover);
	}
	.btn-primary:disabled {
		opacity: 0.45;
		cursor: default;
	}

	/* Ghost secondary */
	.btn-ghost {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		background: transparent;
		border: 1px solid var(--line);
		color: var(--faint);
		padding: 7px var(--sp-3);
		border-radius: var(--radius-sm);
		font-size: var(--fs-sm);
		font-weight: 500;
		cursor: pointer;
		transition: color var(--dur-fast) var(--ease-out),
		            border-color var(--dur-fast) var(--ease-out);
	}
	.btn-ghost:hover {
		color: var(--muted);
		border-color: var(--line-strong);
	}

	/* Port row (browser dev mode) */
	.port-row {
		display: flex;
		gap: var(--sp-2);
		align-items: center;
	}
	.port {
		width: 96px;
		padding: 9px var(--sp-3);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--panel);
		color: var(--text);
		font-family: var(--mono);
		font-size: var(--fs-sm);
	}

	.hint {
		font-size: var(--fs-xs);
		color: var(--faint);
		margin: 0;
		max-width: 400px;
		line-height: 1.6;
	}
	.hint strong {
		color: var(--muted);
		font-weight: 600;
	}

	.fallback .err {
		font-size: var(--fs-sm);
		color: var(--danger);
		margin: 0;
	}
</style>
