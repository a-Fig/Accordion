<script lang="ts">
	import { onMount } from "svelte";
	import { session, isTauriEnv, loadSample, openFile, loadFilePath } from "$lib/session.svelte.ts";
	import { settings } from "$lib/settings.svelte.ts";
	import { connectLive, disconnectLive, live } from "$lib/live/liveClient.svelte";
	import { discovery, startDiscovery, stopDiscovery, DEMO_ID } from "$lib/live/discovery.svelte";
	import { claudeDiscovery, startClaudeDiscovery, stopClaudeDiscovery } from "$lib/live/claudeDiscovery.svelte";
	import { conductorState } from "$lib/live/conductor.svelte";
	import { startConductorDiscovery, stopConductorDiscovery, allConductors, isLaunching } from "$lib/live/conductorDiscovery.svelte";
	import { attachConductor, conductorRetry } from "$lib/live/conductorClient.svelte";
	import { folding } from "$lib/live/folding.svelte";
	import { foldAlarm, runFoldCheck } from "$lib/live/foldAlarm.svelte";
	import { DEFAULT_PORT } from "$lib/live/protocol";
	import type { SessionEntry } from "$lib/live/registry";
	import type { ClaudeCodeSession } from "$lib/live/claude";
	import SessionsSidebar from "$lib/ui/live/SessionsSidebar.svelte";
	import MapHeader from "$lib/ui/map/MapHeader.svelte";
	import ContextMap from "$lib/ui/map/ContextMap.svelte";
	import Inspector from "$lib/ui/map/Inspector.svelte";
	import ConductorActivity from "$lib/ui/map/ConductorActivity.svelte";
	import Icon from "$lib/ui/Icon.svelte";
	import Logo from "$lib/ui/Logo.svelte";

	let selectedId = $state<string | null>(null);
	let manualPort = $state(DEFAULT_PORT);
	let activityOpen = $state(false);
	let browserServed = $state(false);
	let servedSessionId = $state<string | null>(null);

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

	// Wire the host's `compress` capability (Bear-2 via The Token Company) onto the active
	// store. Unlike `completer` (a live-pi-only model link set by the WS client), compression
	// is a standalone app-side HTTP call — so it's wired here at the route level and works for
	// EVERY session source (demo, read-only Claude Code, live pi). It tracks `session.store`,
	// `isTauriEnv`, and the reactive `settings.bear2ApiKey`, so `can("compress")` flips to
	// false the instant the key is cleared or in browser dev (no Tauri) — letting a conductor
	// show a "set your key" prompt instead of failing mid-fold. Aggressiveness is fixed at 0.2
	// here (the single place it's specified); the host contract keeps it off the call surface.
	$effect(() => {
		const store = session.store;
		if (!store) return;
		const key = settings.bear2ApiKey;
		if (isTauriEnv && key.trim() !== "") {
			store.compressor = async (text: string) => {
				const { invoke } = await import("@tauri-apps/api/core");
				return await invoke<string>("compress_text", {
					text,
					apiKey: key,
					aggressiveness: 0.2,
				});
			};
		} else {
			store.compressor = null;
		}
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
		claudeDiscovery.selected = null;
		discovery.selected = s.sessionId;
		connectLive(s.port);
	}

	// The bundled demo behaves like a session you can pick — it just loads the
	// sample transcript instead of dialing a live pi over the socket.
	function selectDemo(): void {
		disconnectLive();
		claudeDiscovery.selected = null;
		discovery.selected = DEMO_ID;
		loadSample();
	}

	// Browser-served mode is single-session: the extension that served this page hosts the
	// live WS on the SAME origin port. This is the "way back" to the live session — e.g.
	// after viewing the Demo — since the browser has no multi-session discovery to pick from.
	function reconnectServed(): void {
		discovery.selected = null;
		claudeDiscovery.selected = null;
		connectLive(Number(window.location.port) || DEFAULT_PORT);
	}

	// A Claude Code transcript: load it read-only and tail it for appends. There is
	// no live socket to steer — folds here are a personal lens (see MapHeader badge).
	function selectClaudeSession(s: ClaudeCodeSession): void {
		disconnectLive();
		discovery.selected = null;
		claudeDiscovery.selected = s.sessionId;
		loadFilePath(s.filePath);
	}

	function onFocusRequest(sessionId: string): void {
		const s = discovery.sessions.find((x) => x.sessionId === sessionId);
		if (s) selectAndConnect(s);
	}

	onMount(() => {
		startDiscovery(onFocusRequest);
		startConductorDiscovery();

		// Browser-served auto-connect: if this page was served by the pi extension on a
		// loopback port, /__accordion/meta returns { served: true, sessionId, protocolVersion }.
		// In any other context (Vite dev server, static host) the endpoint is absent — 404 or
		// non-JSON — so we silently fall through and leave the manual UI visible.
		if (!isTauriEnv && typeof window !== "undefined") {
			(async () => {
				try {
					const res = await fetch("/__accordion/meta", { credentials: "same-origin" });
					if (!res.ok) return;
					const ct = res.headers.get("content-type") ?? "";
					if (!ct.includes("application/json")) return;
					const body = await res.json() as { served?: boolean; sessionId?: string; protocolVersion?: number };
					if (body.served !== true) return;
					browserServed = true;
					servedSessionId = body.sessionId ?? null;
					const port = Number(window.location.port) || DEFAULT_PORT;
					connectLive(port);
				} catch {
					// 404, network error, non-JSON — leave browserServed false; manual UI stays.
				}
			})();
		}

		return () => {
			stopDiscovery();
			stopClaudeDiscovery();
			stopConductorDiscovery();
			disconnectLive();
		};
	});

	const isLive = $derived(live.status === "connected");
	const isWatching = $derived(session.readOnly && !isLive);

	// View↔wire fold alarm (indicator-only): re-run the divergence check on every settled
	// store change. `st.version` is the settled-change signal (manual fold, conductor pass,
	// budget/protect change, append — all route through refold()→runConductor()→version++).
	$effect(() => {
		const st = session.store;
		if (!st) {
			foldAlarm.active = false;
			foldAlarm.detail = "";
			return;
		}
		st.version; // track the settled-change signal
		runFoldCheck(st, live.status === "connected");
	});
</script>

<svelte:head><title>Accordion</title></svelte:head>

<div class="shell" class:railed={isTauriEnv || browserServed}>
	{#if isTauriEnv || browserServed}
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
			{browserServed}
			servedTitle={session.store?.meta.title ?? "pi session"}
			servedModel={session.store?.meta.model ?? ""}
			onreconnect={reconnectServed}
		/>
	{/if}

	<div class="content">
		{#if session.store}
			{@const s = session.store}
			<div class="app">
				<header class="topbar">
					<!-- Brand lockup: logo + wordmark -->
					<div class="brand">
						<span class="brand-icon">
							<Logo size={20} />
						</span>
						<span class="wordmark">Accordion</span>
						{#if foldAlarm.active}
							<span class="alarm-dot" title={foldAlarm.detail || "View ↔ wire fold mismatch — the screen disagrees with what the agent would receive"}></span>
						{/if}
					</div>
					<!-- Session identity: title + live/watching status -->
					<div class="session-cluster">
						<div class="divider"></div>
						<span class="session-title">
							{session.filePath ? baseName(session.filePath) : s.meta.title}
						</span>
						{#if isLive}
							<span class="live-chip" class:steering={folding.enabled}>
								<span class="live-dot" title={folding.enabled ? "Connected to pi; actively steering the agent's context" : "Connected to pi; passively watching the session"}></span>
								<span class="live-label">{folding.enabled ? "steering" : "live"}</span>
							</span>
						{:else if isWatching}
							<span class="live-chip">
								<span class="live-dot" title="Tailing a read-only transcript; folds are a local lens"></span>
								<span class="live-label">watching</span>
							</span>
						{/if}
					</div>
					<!-- Data readout: model · cwd · blocks (mono, smoke — these are metrics not prose) -->
					<div class="meta-row">
						<span class="meta-chip mono tnum">{s.meta.model || s.meta.format}</span>
						{#if s.meta.cwd}
							<span class="meta-sep">·</span>
							<span class="meta-chip mono tnum">{baseName(s.meta.cwd)}</span>
						{/if}
						<span class="meta-sep">·</span>
						<span class="meta-chip mono tnum">{s.blocks.length} blocks</span>
					</div>
					<!-- Nav actions -->
					<div class="nav-row">
						<button
							class="nav-btn"
							class:active={activityOpen}
							onclick={() => (activityOpen = !activityOpen)}
							aria-pressed={activityOpen}
							title="Show conductor activity"
						>
							<Icon name="activity" size={13} />
							Activity
						</button>
						{#if live.status === "connected"}
							<button class="nav-btn" onclick={disconnectLive}>
								<Icon name="x" size={12} />
								Disconnect
							</button>
						{:else if isTauriEnv}
							<button class="nav-btn" onclick={openFile}>
								<Icon name="folder" size={12} />
								Open…
							</button>
						{/if}
					</div>
				</header>

				<MapHeader store={s} readOnly={session.readOnly} />

				<div class="main" class:open={!!selectedBlock || !!selectedGroup} class:activity={activityOpen}>
					<div class="canvas">
						<ContextMap store={s} {selectedId} onselect={(id) => (selectedId = selectedId === id ? null : id)} />
					</div>
					{#if activityOpen}
						<ConductorActivity store={s} onclose={() => (activityOpen = false)} />
					{/if}
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
				<!-- Spectrum hairline wash — the brand's only color on the empty state -->
				<div class="hero-spectrum" aria-hidden="true"></div>

				<div class="hero-body">
					<!-- Logo lockup: icon + wordmark as a unit -->
					<div class="hero-lockup">
						<span class="hero-logo"><Logo size={32} /></span>
						<span class="hero-wordmark">Accordion</span>
					</div>

					<!-- The brand headline — large, confident, -2% tracking -->
					<h1 class="hero-headline">Your session, intact.</h1>

					<!-- Quiet sub-line: grounded, factual -->
					<p class="hero-sub">
						{#if isTauriEnv}
							{#if discovery.sessions.length}
								A live session is waiting on the left. Pick it to watch its context unfold.
							{:else}
								Fold old context. Keep momentum. Nothing in your session is deleted.
							{/if}
						{:else}
							Fold old context. Keep momentum. Nothing in your session is deleted.
						{/if}
					</p>

					<!-- Primary + secondary actions -->
					{#if isTauriEnv}
						<ol class="start-steps">
							<li><span class="step-num">1</span> Open <strong>pi</strong> in your terminal</li>
							<li><span class="step-num">2</span> Run <code>/accordion</code> to start the extension</li>
						</ol>
					{:else}
						{#if browserServed}
							<p class="hint">
								{#if live.status === "connected"}
									Connected to your pi session.
								{:else if live.status === "connecting"}
									Connecting to your pi session…
								{:else}
									Waiting for your pi session…
								{/if}
							</p>
						{:else}
							<p class="hint">
								Live session discovery is a desktop feature — run <code>npm run tauri dev</code>. In the browser you can dial a known port or load the sample.
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
							<button class="btn-secondary" onclick={loadSample}>
								<Icon name="file-text" size={13} />
								Load sample (982 blocks)
							</button>
						{/if}
					{/if}
					{#if live.status === "error"}<p class="err">{live.detail}</p>{/if}
					{#if session.error}<p class="err">{session.error}</p>{/if}
				</div>
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
	/* Calm single-row chrome: brand lockup · divider · session title · status | data readout | nav */
	.topbar {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		padding: 0 var(--sp-5);
		height: 44px;
		border-bottom: 1px solid var(--line-soft);
		background: var(--panel);
		box-shadow: var(--shadow-1);
		flex: 0 0 auto;
	}
	/* Smoky spectrum hairline along the bottom edge — brand spectrum kept low-key:
	   1px tall, 20% opacity, faded at both ends so it's a wash, never a hard rainbow bar. */
	.topbar::after {
		content: "";
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 1px;
		background: var(--gradient-spectrum);
		opacity: 0.20;
		-webkit-mask-image: linear-gradient(90deg, transparent, #000 15%, #000 85%, transparent);
		mask-image: linear-gradient(90deg, transparent, #000 15%, #000 85%, transparent);
		pointer-events: none;
	}

	/* Brand lockup: icon + wordmark (sits on the left, flex-shrink:0) */
	.brand {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		flex: 0 0 auto;
	}
	.brand-icon {
		color: var(--accent);
		display: flex;
		align-items: center;
	}
	.wordmark {
		font-family: var(--sans);
		font-size: var(--fs-md);
		font-weight: 700;
		color: var(--text);
		letter-spacing: -0.02em;
		line-height: 1;
	}

	/* Session identity cluster: divider + title + live/watching chip.
	   Fills available space, truncates title gracefully. */
	.session-cluster {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		flex: 1;
		min-width: 0;
	}
	.divider {
		width: 1px;
		height: 16px;
		background: var(--line);
		flex: 0 0 auto;
	}
	.session-title {
		font-size: var(--fs-sm);
		font-weight: 500;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	/* Live / Watching chip — colour driven by --chip so both states share one rule.
	   Preview + Watching = neutral accent; Steering (folding armed) = green (--ok). */
	.live-chip {
		--chip: var(--accent);
		display: inline-flex;
		align-items: center;
		gap: 5px;
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
		width: 6px;
		height: 6px;
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
		font-family: var(--mono);
		font-size: var(--fs-2xs);
		font-weight: 600;
		color: var(--chip);
		letter-spacing: 0.10em;
		text-transform: uppercase;
		line-height: 1;
	}

	/* View↔wire fold-mismatch alarm — a single header dot, exempt from the grid
	   perf rule (about the 982-tile canvas, not a lone indicator).
	   Compositor-only (transform + opacity); slower 3s pulse. */
	@keyframes alarmpulse {
		0% { transform: scale(1); opacity: 0.5; }
		70%, 100% { transform: scale(2.6); opacity: 0; }
	}
	.alarm-dot {
		position: relative;
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--danger);
		flex: 0 0 auto;
	}
	.alarm-dot::after {
		content: "";
		position: absolute;
		inset: 0;
		border-radius: 50%;
		background: var(--danger);
		animation: alarmpulse 3s ease-in-out infinite;
		pointer-events: none;
	}

	/* Data readout: model · cwd · blocks — mono, smoke; these are metrics not prose */
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
		opacity: 0.4;
		user-select: none;
	}

	/* Nav buttons — outline secondary: transparent bg, --line-strong border */
	.nav-row {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		flex: 0 0 auto;
	}
	.nav-btn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: var(--fs-xs);
		font-weight: 500;
		color: var(--muted);
		background: transparent;
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-sm);
		padding: 4px var(--sp-3);
		cursor: pointer;
		white-space: nowrap;
		transition: color var(--dur-fast) var(--ease-out),
		            background var(--dur-fast) var(--ease-out),
		            border-color var(--dur-fast) var(--ease-out);
	}
	.nav-btn:hover {
		color: var(--text);
		background: var(--accent-soft);
		border-color: var(--accent);
	}
	.nav-btn.active {
		color: var(--accent);
		background: var(--accent-soft);
		border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
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
	.main.activity {
		grid-template-columns: minmax(0, 1fr) minmax(280px, 320px);
	}
	.main.open.activity {
		grid-template-columns: minmax(0, 1fr) minmax(200px, 260px) minmax(360px, 30vw);
	}
	.canvas {
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	/* ── Fallback / empty state ───────────────────────────────── */
	/* Full-height centered layout. The spectrum wash sits at bottom via absolute. */
	.fallback {
		position: relative;
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: var(--sp-7) var(--sp-5);
		text-align: center;
		overflow: hidden;
	}

	/* Smoky spectrum wash — the ONLY color on the empty state.
	   Placed at the bottom of the viewport, fading toward near-zero opacity at the top.
	   Blurs slightly to keep it from being a hard stripe. Never more than ~18% opacity. */
	.hero-spectrum {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 220px;
		background: var(--gradient-spectrum);
		opacity: 0.10;
		-webkit-mask-image: linear-gradient(to top, rgba(0,0,0,0.55) 0%, transparent 100%);
		mask-image: linear-gradient(to top, rgba(0,0,0,0.55) 0%, transparent 100%);
		filter: blur(24px);
		pointer-events: none;
	}

	/* Inner body: logo lockup → headline → sub → actions — centered column */
	.hero-body {
		position: relative;  /* above the spectrum wash */
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--sp-4);
		max-width: 480px;
	}

	/* Logo lockup: icon + wordmark inline, like page-01 of the brand guidelines */
	.hero-lockup {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-3);
	}
	.hero-logo {
		color: var(--accent);
		display: flex;
		align-items: center;
	}
	.hero-wordmark {
		font-family: var(--sans);
		font-size: var(--fs-xl);
		font-weight: 700;
		color: var(--text);
		letter-spacing: -0.02em;
		line-height: 1;
	}

	/* The headline — large, confident, -2% tracking. Scale above --fs-2xl (24px).
	   This is the brand moment: "Your session, intact." as per page-01. */
	.hero-headline {
		font-family: var(--sans);
		font-size: clamp(var(--fs-2xl), 4vw, 40px);
		font-weight: 600;
		color: var(--text);
		letter-spacing: -0.02em;
		line-height: 1.08;
		margin: 0;
	}

	/* Quiet sub-line — calm, factual, never hype */
	.hero-sub {
		font-size: var(--fs-base);
		color: var(--muted);
		margin: 0;
		max-width: 360px;
		line-height: 1.55;
	}

	/* Primary CTA — Paper solid: white surface, Ink text (brand's one bright affordance) */
	.btn-primary {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-2);
		background: var(--paper);
		color: var(--ink);
		border: 1px solid var(--paper);
		padding: 10px var(--sp-5);
		border-radius: var(--radius-sm);
		font-family: var(--sans);
		font-size: var(--fs-md);
		font-weight: 600;
		cursor: pointer;
		transition: background var(--dur-fast) var(--ease-out),
		            border-color var(--dur-fast) var(--ease-out);
	}
	.btn-primary:hover {
		background: #ffffff;
		border-color: #ffffff;
	}
	.btn-primary:disabled {
		opacity: 0.45;
		cursor: default;
	}

	/* Secondary — outline: transparent bg, --line-strong border */
	.btn-secondary {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-1);
		background: transparent;
		border: 1px solid var(--line-strong);
		color: var(--muted);
		padding: 9px var(--sp-4);
		border-radius: var(--radius-sm);
		font-size: var(--fs-sm);
		font-weight: 500;
		cursor: pointer;
		transition: color var(--dur-fast) var(--ease-out),
		            background var(--dur-fast) var(--ease-out),
		            border-color var(--dur-fast) var(--ease-out);
	}
	.btn-secondary:hover {
		color: var(--text);
		background: var(--accent-soft);
		border-color: var(--accent);
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
	.hint code {
		font-family: var(--mono);
		font-size: var(--fs-xs);
		background: var(--panel-2);
		color: var(--muted);
		padding: 1px 5px;
		border-radius: var(--radius-xs);
		border: 1px solid var(--line);
	}
	.start-steps {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
		font-size: var(--fs-xs);
		color: var(--faint);
	}
	.start-steps li {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.start-steps strong {
		color: var(--muted);
		font-weight: 600;
	}
	.start-steps code {
		font-family: var(--mono);
		font-size: var(--fs-xs);
		background: var(--panel-2);
		color: var(--muted);
		padding: 1px 5px;
		border-radius: var(--radius-xs);
		border: 1px solid var(--line);
	}
	.step-num {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		border-radius: 50%;
		border: 1px solid var(--faint);
		font-size: 0.7rem;
		flex-shrink: 0;
	}

	.fallback .err {
		font-size: var(--fs-sm);
		color: var(--danger);
		margin: 0;
	}
</style>
