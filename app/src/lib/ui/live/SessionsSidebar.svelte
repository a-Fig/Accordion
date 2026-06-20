<script lang="ts">
	import type { SessionEntry } from "$lib/live/registry";
	import type { ClaudeCodeSession } from "$lib/live/claude";
	import { folding } from "$lib/live/folding.svelte";
	import AnimatedNumber from "$lib/ui/AnimatedNumber.svelte";
	import Icon from "$lib/ui/Icon.svelte";
	import SegControl from "$lib/ui/SegControl.svelte";
	import SettingsPanel from "$lib/ui/SettingsPanel.svelte";
	import { relTime } from "$lib/utils";

	let {
		source = "pi",
		onsource = () => {},
		sessions,
		selected,
		connected,
		demoSelected = false,
		onselect,
		ondemo,
		claudeSessions = [],
		claudeSelected = null,
		onselectclaude = () => {},
	}: {
		source?: "pi" | "claude";
		onsource?: (s: "pi" | "claude") => void;
		sessions: SessionEntry[];
		selected: string | null;
		connected: boolean;
		demoSelected?: boolean;
		onselect: (s: SessionEntry) => void;
		ondemo: () => void;
		claudeSessions?: ClaudeCodeSession[];
		claudeSelected?: string | null;
		onselectclaude?: (s: ClaudeCodeSession) => void;
	} = $props();

	const STORE_KEY = "accordion.sidebar.collapsed";

	function loadCollapsed(): boolean {
		if (typeof localStorage === "undefined") return false;
		return localStorage.getItem(STORE_KEY) === "1";
	}

	let collapsed = $state(loadCollapsed());
	let settingsOpen = $state(false);

	$effect(() => {
		if (typeof localStorage !== "undefined") {
			localStorage.setItem(STORE_KEY, collapsed ? "1" : "0");
		}
	});

	// Cmd/Ctrl+B toggles the rail — the near-universal "toggle sidebar" shortcut.
	$effect(() => {
		function onKey(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
				e.preventDefault();
				collapsed = !collapsed;
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	function baseName(p: string): string {
		return p ? p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p : "";
	}
	function shortModel(m: string): string {
		if (!m) return "—";
		return m.includes("/") ? m.split("/").pop()! : m;
	}
	function pct(e: SessionEntry): number | null {
		if (e.tokens == null || !e.contextWindow) return null;
		return Math.min(100, Math.round((e.tokens / e.contextWindow) * 100));
	}
	function fmtTokens(n: number | null): string {
		if (n == null) return "";
		const r = Math.round(n);
		if (r >= 1000) return `${(r / 1000).toFixed(r >= 10000 ? 0 : 1)}k`;
		return String(r);
	}
	function label(s: SessionEntry): string {
		return baseName(s.cwd) || s.title || "session";
	}

	const activeCount = $derived(source === "pi" ? sessions.length : claudeSessions.length);
</script>

<aside class="rail" class:collapsed>
	{#if collapsed}
		<!-- Slim icon rail -->
		<button
			class="rail-btn logo-btn"
			title="Expand sidebar  (Ctrl/Cmd+B)"
			aria-label="Expand sidebar"
			onclick={() => (collapsed = false)}
		>
			<Icon name="accordion" size={18} class="accent-icon" />
		</button>

		<!-- Tiny source toggle pill -->
		<button
			class="src-pill"
			title="Switch source (pi / Claude Code)"
			aria-label="Switch source"
			onclick={() => onsource(source === "pi" ? "claude" : "pi")}
		>
			{source === "pi" ? "pi" : "CC"}
		</button>

		{#if source === "pi"}
			<div class="icon-list">
				{#each sessions as s (s.sessionId)}
					{@const isSel = s.sessionId === selected}
					<button
						class="rail-btn dot-btn"
						class:sel={isSel}
						title={label(s)}
						aria-label={label(s)}
						onclick={() => onselect(s)}
					>
						<span class="status-dot" class:on={isSel && connected} class:steering={isSel && connected && folding.enabled}></span>
					</button>
				{/each}
			</div>
			<!-- Bottom group: Demo + gear, flush at the rail foot -->
			<div class="rail-foot">
				<button
					class="rail-btn dot-btn demo-icon"
					class:sel={demoSelected}
					title="Demo session (bundled sample)"
					aria-label="Demo session"
					onclick={ondemo}
				>
					<span class="status-dot demo-dot"></span>
				</button>
				<button
					class="rail-btn settings-icon"
					title="Settings"
					aria-label="Settings"
					onclick={() => (settingsOpen = true)}
				>
					<Icon name="sliders-horizontal" size={16} />
				</button>
			</div>
		{:else}
			<div class="icon-list">
				{#each claudeSessions.slice(0, 12) as s (s.sessionId)}
					{@const isSel = s.sessionId === claudeSelected}
					<button
						class="rail-btn dot-btn"
						class:sel={isSel}
						title={s.title || s.project}
						aria-label={s.title || s.project}
						onclick={() => onselectclaude(s)}
					>
						<Icon name="file-text" size={16} />
					</button>
				{/each}
			</div>
			<!-- Bottom group: gear only (no Demo in CC mode) -->
			<div class="rail-foot">
				<button
					class="rail-btn settings-icon"
					title="Settings"
					aria-label="Settings"
					onclick={() => (settingsOpen = true)}
				>
					<Icon name="sliders-horizontal" size={16} />
				</button>
			</div>
		{/if}
	{:else}
		<!-- Expanded sidebar -->
		<div class="head">
			<span class="logo-wrap" aria-hidden="true">
				<Icon name="accordion" size={16} class="accent-icon" />
			</span>
			<span class="wordmark">Accordion</span>

			<span class="count tnum" aria-label="{activeCount} sessions">{activeCount}</span>

			<button
				class="collapse-btn"
				title="Collapse sidebar  (Ctrl/Cmd+B)"
				aria-label="Collapse sidebar"
				onclick={() => (collapsed = true)}
			>
				<Icon name="chevrons-left" size={14} />
			</button>
		</div>

		<!-- Source switcher on its own row so the header stays slim and the collapse
		     button is never clipped in the narrow (232px) rail. -->
		<div class="source-row">
			<SegControl
				options={[
					{ id: "pi", label: "pi", icon: "terminal" },
					{ id: "claude", label: "Claude Code", icon: "message-square" },
				]}
				value={source}
				onchange={(v) => onsource(v as "pi" | "claude")}
				ariaLabel="Session source"
				iconSize={11}
			/>
		</div>

		{#if source === "pi"}
			<div class="scroll">
				{#if sessions.length === 0}
					<div class="empty">
						<Icon name="terminal" size={20} class="empty-icon" />
						<p class="empty-msg">No live pi sessions</p>
						<p class="empty-hint">Start <code>pi</code> in a project — it shows up here on its own.</p>
					</div>
				{:else}
					<ul class="list">
						{#each sessions as s (s.sessionId)}
							{@const p = pct(s)}
							{@const isSel = s.sessionId === selected}
							<li>
								<button class="row" class:sel={isSel} onclick={() => onselect(s)} title={s.cwd}>
									<span class="status-dot" class:on={isSel && connected} class:steering={isSel && connected && folding.enabled}></span>
									<span class="body">
										<span class="t1">{label(s)}</span>
										<span class="t2 mono">{shortModel(s.model)}</span>
									</span>
									{#if p !== null}
										<span class="usage" title={`${s.tokens} / ${s.contextWindow} tokens`}>
											<span class="bar"><span class="fill" class:hot={p >= 80} style:width={`${p}%`}></span></span>
											<span class="pct tnum"><AnimatedNumber value={s.tokens ?? 0} format={fmtTokens} /></span>
										</span>
									{/if}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<!-- Bundled demo, pinned at the foot -->
			<div class="demo-foot">
				<button class="row demo" class:sel={demoSelected} onclick={ondemo} title="Bundled sample session — a static demo transcript">
					<span class="status-dot demo-dot"></span>
					<span class="body">
						<span class="t1">Demo session</span>
						<span class="t2">Bundled sample · static</span>
					</span>
					<span class="badge">demo</span>
				</button>
			</div>
		{:else}
			<!-- Claude Code session list -->
			<div class="scroll">
				{#if claudeSessions.length === 0}
					<div class="empty">
						<Icon name="message-square" size={20} class="empty-icon" />
						<p class="empty-msg">No recent sessions</p>
						<p class="empty-hint">Sessions under <code>~/.claude/projects</code> appear here.</p>
					</div>
				{:else}
					<ul class="list">
						{#each claudeSessions as s (s.sessionId)}
							{@const isSel = s.sessionId === claudeSelected}
							<li>
								<button
									class="row"
									class:sel={isSel}
									onclick={() => onselectclaude(s)}
									title={s.filePath}
								>
									<Icon name="file-text" size={13} class="cc-icon" />
									<span class="body">
										<span class="t1">{s.title || s.project || s.sessionId}</span>
										<span class="t2">{s.project}</span>
									</span>
									<span class="cc-meta">
										<span class="ro-badge"><Icon name="eye" size={9} />READ</span>
										<span class="rel-time tnum" title={new Date(s.mtime).toLocaleString()}>{relTime(s.mtime)}</span>
									</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<div class="cc-foot">
				50 newest · use Open… for older
			</div>
		{/if}

		<!-- Settings entry: pinned at the very bottom of the expanded sidebar, always visible -->
		<div class="settings-foot">
			<button class="row settings-row" onclick={() => (settingsOpen = true)} title="Open settings">
				<Icon name="sliders-horizontal" size={13} class="settings-row-icon" />
				<span class="body">
					<span class="t1">Settings</span>
				</span>
			</button>
		</div>
	{/if}
</aside>

<SettingsPanel open={settingsOpen} onclose={() => (settingsOpen = false)} />

<style>
	/* ===== Rail shell ===== */
	.rail {
		width: 232px;
		flex: 0 0 auto;
		height: 100%;
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--line);
		background: var(--panel);
		overflow: hidden;
		transition: width 160ms var(--ease-out);
	}
	.rail.collapsed {
		width: 52px;
		align-items: center;
		gap: var(--sp-1);
		padding: var(--sp-2) 0;
	}

	/* ===== Collapsed icon rail ===== */
	.rail-btn {
		width: 38px;
		height: 38px;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		cursor: pointer;
		flex: 0 0 auto;
		color: var(--muted);
		transition:
			background var(--dur-fast) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out);
	}
	.rail-btn:hover {
		background: var(--panel-2);
		color: var(--text);
	}
	.logo-btn {
		color: var(--accent);
		margin-bottom: var(--sp-1);
	}
	.logo-btn:hover {
		color: var(--accent-hover);
		background: var(--accent-soft);
	}
	.icon-list {
		flex: 1;
		min-height: 0;
		width: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--sp-1);
		overflow-y: auto;
		overflow-x: hidden;
	}
	.dot-btn.sel {
		background: var(--accent-soft);
		border-color: color-mix(in srgb, var(--accent) 40%, transparent);
		color: var(--accent);
	}
	.demo-icon {
		border-style: dashed;
		border-color: var(--line-strong);
	}
	.demo-icon:hover {
		border-color: var(--accent);
	}
	/* Bottom-pinned group in the collapsed rail (Demo + gear in pi; gear only in CC) */
	.rail-foot {
		margin-top: auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--sp-1);
	}

	/* ===== Collapsed source pill ===== */
	.src-pill {
		font-size: var(--fs-xs);
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--muted);
		background: var(--panel-2);
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
		padding: 2px var(--sp-2);
		cursor: pointer;
		line-height: 1.5;
		transition:
			color var(--dur-fast) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out),
			background var(--dur-fast) var(--ease-out);
	}
	.src-pill:hover {
		color: var(--text);
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		background: var(--panel-3);
	}

	/* ===== Expanded header ===== */
	.head {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: 10px var(--sp-3);
		border-bottom: 1px solid var(--line);
		flex: 0 0 auto;
	}
	/* Source switcher gets its own row beneath the header (keeps the collapse
	   button in the header from being pushed out of the 232px rail). */
	.source-row {
		display: flex;
		padding: var(--sp-2) var(--sp-3);
		border-bottom: 1px solid var(--line);
		flex: 0 0 auto;
	}
	.logo-wrap {
		flex: 0 0 auto;
		color: var(--accent);
		display: flex;
		align-items: center;
	}
	.wordmark {
		font-size: var(--fs-sm);
		font-weight: 700;
		color: var(--text);
		letter-spacing: 0.02em;
		white-space: nowrap;
		overflow: hidden;
		/* fade out when collapsing so text doesn't squash/reflow */
		opacity: 1;
		transition: opacity 80ms var(--ease-out);
	}
	.rail.collapsed .wordmark {
		opacity: 0;
	}

	.count {
		margin-left: auto;
		font-size: var(--fs-xs);
		color: var(--faint);
		background: var(--panel-2);
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
		padding: 1px var(--sp-2);
		flex: 0 0 auto;
		line-height: 1.6;
	}
	.collapse-btn {
		background: transparent;
		border: none;
		color: var(--faint);
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: var(--radius-sm);
		padding: 0;
		cursor: pointer;
		flex: 0 0 auto;
		transition:
			color var(--dur-fast) var(--ease-out),
			background var(--dur-fast) var(--ease-out);
	}
	.collapse-btn:hover {
		color: var(--text);
		background: var(--panel-2);
	}

	/* ===== Scroll region ===== */
	.scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}

	/* ===== Empty states ===== */
	.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: var(--sp-6) var(--sp-4) var(--sp-4);
		gap: var(--sp-2);
		text-align: center;
	}
	:global(.empty-icon) {
		color: var(--faint);
		opacity: 0.5;
	}
	.empty-msg {
		margin: 0;
		font-size: var(--fs-sm);
		color: var(--faint);
		font-weight: 500;
	}
	.empty-hint {
		margin: 0;
		color: var(--faint);
		font-size: var(--fs-xs);
		line-height: 1.6;
		opacity: 0.75;
	}
	.empty code {
		background: var(--panel-2);
		padding: 1px 5px;
		border-radius: var(--radius-xs);
		font-family: var(--mono);
	}

	/* ===== Session list ===== */
	.list {
		list-style: none;
		margin: 0;
		padding: var(--sp-2) var(--sp-2) var(--sp-1);
	}
	.row {
		position: relative;
		width: 100%;
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: var(--sp-2) var(--sp-3);
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		cursor: pointer;
		text-align: left;
		color: inherit;
		transition:
			background var(--dur-fast) var(--ease-out);
	}
	/* Left-edge accent for selected rows — inset, no layout shift */
	.row::before {
		content: '';
		position: absolute;
		left: 0;
		top: 20%;
		bottom: 20%;
		width: 2px;
		border-radius: 0 2px 2px 0;
		background: var(--accent);
		opacity: 0;
		transition: opacity var(--dur-fast) var(--ease-out);
	}
	.row:hover {
		background: var(--panel-2);
	}
	.row.sel {
		background: var(--accent-soft);
	}
	.row.sel::before {
		opacity: 1;
	}

	/* ===== Status dot ===== */
	.status-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex: 0 0 auto;
		background: var(--faint);
		opacity: 0.5;
		transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), opacity var(--dur-fast) var(--ease-out);
	}
	@keyframes halo-pulse {
		0%, 100% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--dot-color) 28%, transparent); }
		50%       { box-shadow: 0 0 0 4px color-mix(in srgb, var(--dot-color) 10%, transparent); }
	}
	.status-dot.on {
		--dot-color: var(--accent);
		background: var(--dot-color);
		opacity: 1;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--dot-color) 28%, transparent);
		animation: halo-pulse var(--dur-slow) ease-in-out infinite;
	}
	.status-dot.on.steering {
		--dot-color: var(--ok);
	}
	.demo-dot {
		background: transparent;
		border: 1.5px dashed var(--muted);
		opacity: 0.7;
	}

	/* ===== Claude Code leading icon ===== */
	:global(.cc-icon) {
		color: var(--faint);
		flex: 0 0 auto;
		opacity: 0.7;
	}
	.row.sel :global(.cc-icon) {
		color: var(--accent);
		opacity: 1;
	}

	/* ===== Row body ===== */
	.body {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
		flex: 1;
	}
	.t1 {
		font-size: var(--fs-sm);
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.t2 {
		font-size: var(--fs-xs);
		color: var(--faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* ===== Usage bar ===== */
	.usage {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 3px;
		flex: 0 0 auto;
	}
	.bar {
		width: 36px;
		height: 3px;
		border-radius: var(--radius-pill);
		background: var(--panel-3);
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		background: var(--accent);
		border-radius: var(--radius-pill);
		transition: width var(--dur-mid) var(--ease-out);
	}
	.fill.hot {
		background: var(--danger);
	}
	.pct {
		font-size: var(--fs-xs);
		color: var(--faint);
	}

	/* ===== CC meta (rel-time + read-only badge) ===== */
	.cc-meta {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 3px;
		flex: 0 0 auto;
	}
	.ro-badge {
		display: flex;
		align-items: center;
		gap: 2px;
		font-size: var(--fs-xs);
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--faint);
		opacity: 0.65;
	}
	.rel-time {
		font-size: var(--fs-xs);
		color: var(--faint);
		white-space: nowrap;
	}

	/* ===== Demo footer ===== */
	.demo-foot {
		flex: 0 0 auto;
		padding: var(--sp-1) var(--sp-2);
		border-top: 1px solid var(--line);
	}
	/* demo row: dashed border treatment */
	.row.demo {
		border: 1px dashed var(--line-strong);
	}
	.row.demo:hover {
		border-color: color-mix(in srgb, var(--accent) 40%, transparent);
		background: var(--panel-2);
	}
	.row.demo.sel {
		border-color: color-mix(in srgb, var(--accent) 50%, transparent);
		background: var(--accent-soft);
	}
	.badge {
		flex: 0 0 auto;
		font-size: var(--fs-2xs);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--faint);
		background: var(--panel-2);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		padding: 1px var(--sp-1);
	}

	/* ===== CC footer note ===== */
	.cc-foot {
		flex: 0 0 auto;
		padding: var(--sp-2) var(--sp-4);
		border-top: 1px solid var(--line);
		font-size: var(--fs-xs);
		color: var(--faint);
		text-align: center;
		letter-spacing: 0.02em;
	}

	/* ===== Accent icon helper (applied via class prop on Icon) ===== */
	:global(.accent-icon) {
		color: var(--accent);
	}

	/* ===== Settings entry — expanded sidebar ===== */
	.settings-foot {
		flex: 0 0 auto;
		padding: var(--sp-1) var(--sp-2);
		border-top: 1px solid var(--line);
	}
	.settings-row {
		color: var(--muted);
	}
	.settings-row .t1 {
		color: var(--muted);
		font-weight: 500;
	}
	.settings-row:hover .t1 {
		color: var(--text);
	}
	:global(.settings-row-icon) {
		color: var(--faint);
		flex: 0 0 auto;
		opacity: 0.75;
	}
	.settings-row:hover :global(.settings-row-icon) {
		color: var(--muted);
		opacity: 1;
	}
	.settings-row:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	/* ===== Settings icon — collapsed icon rail ===== */
	/* margin-top: auto removed — now handled by .rail-foot wrapper */
	.settings-icon:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}
</style>
