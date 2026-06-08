<script lang="ts">
	import type { SessionEntry } from "$lib/live/registry";
	import type { ClaudeCodeSession } from "$lib/live/claude";
	import AnimatedNumber from "$lib/ui/AnimatedNumber.svelte";
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
	const railCCSessions = $derived(claudeSessions.slice(0, 12));
</script>

<aside class="rail" class:collapsed>
	{#if collapsed}
		<!-- Slim icon rail: sessions stay glanceable; click a dot to switch, logo to expand. -->
		<button class="icon logo-btn" title="Expand sidebar  (Ctrl/Cmd+B)" onclick={() => (collapsed = false)}>
			🪗
		</button>
		<!-- Tiny source toggle -->
		<button
			class="src-pill"
			title="Switch source (pi / Claude Code)"
			onclick={() => onsource(source === "pi" ? "claude" : "pi")}
		>{source === "pi" ? "pi" : "CC"}</button>
		{#if source === "pi"}
			<div class="icon-list">
				{#each sessions as s (s.sessionId)}
					{@const isSel = s.sessionId === selected}
					<button
						class="icon dot-btn"
						class:sel={isSel}
						title={label(s)}
						aria-label={label(s)}
						onclick={() => onselect(s)}
					>
						<span class="dot" class:on={isSel && connected}></span>
					</button>
				{/each}
			</div>
			<button
				class="icon dot-btn demo-icon"
				class:sel={demoSelected}
				title="Demo session (bundled sample)"
				aria-label="Demo session"
				onclick={ondemo}
			>
				<span class="dot demo"></span>
			</button>
		{:else}
			<div class="icon-list">
				{#each railCCSessions as s (s.sessionId)}
					{@const isSel = s.sessionId === claudeSelected}
					<button
						class="icon dot-btn"
						class:sel={isSel}
						title={s.title || s.project}
						aria-label={s.title || s.project}
						onclick={() => onselectclaude(s)}
					>
						<span class="cc-mark" class:cc-sel={isSel}></span>
					</button>
				{/each}
			</div>
		{/if}
	{:else}
		<div class="head">
			<span class="logo">🪗</span>
			<!-- Segmented source switcher -->
			<div class="seg" role="group" aria-label="Session source">
				<button
					class="seg-pill"
					class:seg-active={source === "pi"}
					onclick={() => onsource("pi")}
				>pi</button>
				<button
					class="seg-pill"
					class:seg-active={source === "claude"}
					onclick={() => onsource("claude")}
				>Claude Code</button>
			</div>
			<span class="count">{activeCount}</span>
			<button class="collapse" title="Collapse sidebar  (Ctrl/Cmd+B)" aria-label="Collapse sidebar" onclick={() => (collapsed = true)}>
				«
			</button>
		</div>

		{#if source === "pi"}
			<div class="scroll">
				{#if sessions.length === 0}
					<div class="empty">
						<p>No live pi sessions.</p>
						<p class="hint">Start <code>pi</code> in a project — it shows up here on its own.</p>
					</div>
				{:else}
					<ul class="list">
						{#each sessions as s (s.sessionId)}
							{@const p = pct(s)}
							{@const isSel = s.sessionId === selected}
							<li>
								<button class="row" class:sel={isSel} onclick={() => onselect(s)} title={s.cwd}>
									<span class="dot" class:on={isSel && connected}></span>
									<span class="body">
										<span class="t1">{label(s)}</span>
										<span class="t2 mono">{shortModel(s.model)}</span>
									</span>
									{#if p !== null}
										<span class="usage" title={`${s.tokens} / ${s.contextWindow} tokens`}>
											<span class="bar"><span class="fill" class:hot={p >= 80} style:width={`${p}%`}></span></span>
											<span class="pct mono"><AnimatedNumber value={s.tokens ?? 0} format={fmtTokens} /></span>
										</span>
									{/if}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<!-- Bundled demo, pinned at the foot of the list and clearly not live. -->
			<div class="demo-foot">
				<button class="row demo" class:sel={demoSelected} onclick={ondemo} title="Bundled sample session — a static demo transcript">
					<span class="dot demo"></span>
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
						<p>No recent Claude Code sessions.</p>
						<p class="hint">Sessions under <code>~/.claude/projects</code> appear here.</p>
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
									<span class="cc-mark" class:cc-sel={isSel}></span>
									<span class="body">
										<span class="t1">{s.title || s.project || s.sessionId}</span>
										<span class="t2">{s.project}</span>
									</span>
									<span class="rel-time" title={new Date(s.mtime).toLocaleString()}>{relTime(s.mtime)}</span>
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
	{/if}
</aside>

<style>
	.rail {
		width: 232px;
		flex: 0 0 auto;
		height: 100%;
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--line);
		background: var(--panel);
		overflow: hidden;
		transition: width 160ms ease;
	}
	.rail.collapsed {
		width: 52px;
		align-items: center;
		gap: 4px;
		padding: 8px 0;
	}

	/* ---- collapsed icon rail ---- */
	.icon {
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
		transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
	}
	.icon:hover {
		background: var(--panel-2);
	}
	.logo-btn {
		font-size: 18px;
		margin-bottom: 2px;
	}
	.icon-list {
		flex: 1;
		min-height: 0;
		width: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		overflow-y: auto;
		overflow-x: hidden;
	}
	.dot-btn.sel {
		background: var(--panel-2);
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
	}
	.demo-icon {
		margin-top: auto;
	}

	/* ---- collapsed source pill ---- */
	.src-pill {
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--muted);
		background: var(--panel-2);
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 1px 6px;
		cursor: pointer;
		line-height: 1.5;
		transition: color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
	}
	.src-pill:hover {
		color: var(--text);
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
	}

	/* ---- expanded header ---- */
	.head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--line);
		flex: 0 0 auto;
	}
	.logo {
		font-size: 16px;
		flex: 0 0 auto;
	}

	/* Segmented source switcher */
	.seg {
		display: flex;
		gap: 2px;
		background: var(--panel-2);
		border: 1px solid var(--line);
		border-radius: 999px;
		padding: 2px;
	}
	.seg-pill {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.03em;
		color: var(--muted);
		background: transparent;
		border: 1px solid transparent;
		border-radius: 999px;
		padding: 2px 8px;
		cursor: pointer;
		line-height: 1.4;
		transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
		white-space: nowrap;
	}
	.seg-pill:hover {
		color: var(--text);
	}
	.seg-pill.seg-active {
		background: color-mix(in srgb, var(--accent) 18%, var(--panel));
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		color: var(--text);
	}

	.count {
		margin-left: auto;
		font-size: 11px;
		color: var(--faint);
		background: var(--panel-2);
		border-radius: 999px;
		padding: 1px 8px;
	}
	.collapse {
		background: transparent;
		border: none;
		color: var(--faint);
		font-size: 15px;
		line-height: 1;
		padding: 2px 4px;
		border-radius: 5px;
		cursor: pointer;
		transition: color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
	}
	.collapse:hover {
		color: var(--text);
		background: var(--panel-2);
	}

	.scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}
	.empty {
		padding: 18px 14px;
		color: var(--muted);
	}
	.empty p {
		margin: 0 0 8px;
		font-size: 12px;
	}
	.empty .hint {
		color: var(--faint);
		font-size: 11px;
		line-height: 1.5;
	}
	.empty code {
		background: var(--panel-2);
		padding: 1px 5px;
		border-radius: 4px;
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 6px;
	}
	.row {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 9px 10px;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		cursor: pointer;
		text-align: left;
		transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
	}
	.row:hover {
		background: var(--panel-2);
	}
	.row.sel {
		background: var(--panel-2);
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex: 0 0 auto;
		background: var(--faint);
	}
	@keyframes dotpulse {
		0%, 100% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent); }
		50%       { box-shadow: 0 0 0 5px color-mix(in srgb, var(--ok) 10%, transparent); }
	}
	.dot.on {
		background: var(--ok);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent);
		animation: dotpulse var(--dur-slow) ease-in-out infinite;
	}
	.dot.demo {
		background: transparent;
		border: 1px dashed var(--muted);
	}

	/* Claude Code calm hollow-square marker */
	.cc-mark {
		width: 8px;
		height: 8px;
		border-radius: 1px;
		flex: 0 0 auto;
		background: transparent;
		border: 1.5px solid var(--muted);
		opacity: 0.55;
		transition: opacity var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
	}
	.cc-mark.cc-sel {
		border-color: var(--accent);
		opacity: 1;
		background: color-mix(in srgb, var(--accent) 20%, transparent);
	}

	.body {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
		flex: 1;
	}
	.t1 {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.t2 {
		font-size: 10.5px;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.usage {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 3px;
		flex: 0 0 auto;
	}
	.bar {
		width: 38px;
		height: 4px;
		border-radius: 999px;
		background: var(--panel);
		border: 1px solid var(--line);
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		background: var(--accent);
		transition: width var(--dur-mid) var(--ease-out);
	}
	.fill.hot {
		background: var(--danger);
	}
	.pct {
		font-size: 10px;
		color: var(--faint);
	}

	/* Relative time badge for CC rows */
	.rel-time {
		flex: 0 0 auto;
		font-size: 10px;
		color: var(--faint);
		white-space: nowrap;
	}

	/* ---- demo foot ---- */
	.demo-foot {
		flex: 0 0 auto;
		padding: 6px;
		border-top: 1px solid var(--line);
	}
	.badge {
		flex: 0 0 auto;
		font-size: 9px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--faint);
		background: var(--panel-2);
		border: 1px solid var(--line);
		border-radius: 4px;
		padding: 1px 5px;
	}

	/* ---- CC foot note ---- */
	.cc-foot {
		flex: 0 0 auto;
		padding: 8px 14px;
		border-top: 1px solid var(--line);
		font-size: 10px;
		color: var(--faint);
		text-align: center;
	}
</style>
