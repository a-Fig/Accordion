<script lang="ts">
	import type { AccordionStore } from "../../engine/store.svelte";
	import type { BlockKind } from "../../engine/types";
	import AnimatedNumber from "$lib/ui/AnimatedNumber.svelte";
	import Icon from "$lib/ui/Icon.svelte";
	import { folding, setFolding } from "$lib/live/folding.svelte";
	import { live } from "$lib/live/liveClient.svelte";

	let { store, readOnly = false }: { store: AccordionStore; readOnly?: boolean } = $props();

	const LADDER: { kind: BlockKind; label: string }[] = [
		{ kind: "tool_result", label: "tool results" },
		{ kind: "thinking", label: "thinking" },
		{ kind: "text", label: "replies" },
		{ kind: "tool_call", label: "tool calls" },
		{ kind: "user", label: "your messages" },
	];

	const liveByKind = $derived.by(() => {
		const m: Record<string, number> = {};
		for (const k of LADDER) m[k.kind] = 0;
		for (const b of store.blocks) if (b.kind in m) m[b.kind] += store.effTokens(b);
		return m;
	});

	const denom = $derived(Math.max(store.fullTokens, store.budget, 1));
	// fmt/k formatters must round their input because AnimatedNumber passes a float mid-tween
	const fmt = (n: number) => Math.round(n).toLocaleString();
	const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
	const k = (n: number) => {
		const r = Math.round(n);
		if (r >= 1_000_000) {
			const m = r / 1_000_000;
			return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
		}
		return r >= 1000 ? `${(r / 1000).toFixed(r >= 10000 ? 0 : 1)}k` : `${r}`;
	};
	const fmtOverBy = (n: number) => k(Math.round(n));
</script>

<div class="hdr">
	<div class="top">
		<!-- ── Left: hero stat + usage pill + saved ── -->
		<div class="nums">
			<span class="hero-stat mono tnum" class:over={store.overBudget}>
				<AnimatedNumber value={store.liveTokens} format={fmt} />
			</span>
			<span class="budget-denom tnum">/ <AnimatedNumber value={store.budget} format={fmt} /></span>
			<span class="usage-pill tnum" class:over={store.overBudget}>
				<span class="pill-dot" aria-hidden="true"></span>
				{#if store.overBudget}
					over by <AnimatedNumber value={store.liveTokens - store.budget} format={fmtOverBy} />
				{:else}
					<AnimatedNumber value={pct(store.liveTokens, store.budget)} format={(n) => `${Math.round(n)}%`} />
				{/if}
			</span>
			{#if store.savedTokens > 0}
				<span class="saved-stat tnum">
					<Icon name="chevrons-down-up" size={12} />
					<AnimatedNumber value={store.savedTokens} format={k} /> saved
				</span>
			{/if}
		</div>

		<!-- ── Right: controls cluster ── -->
		<div class="ctl">
			{#if readOnly}
				<span
					class="ro-badge"
					role="status"
					aria-label="Read-only session"
					title="Viewing a recording — folds are local and do not affect any agent."
				>
					<Icon name="eye" size={11} />
					READ-ONLY
				</span>
			{/if}

			{#if live.status === "connected"}
				<button
					class="fold-arm"
					class:on={folding.enabled}
					aria-pressed={folding.enabled}
					aria-label="Apply folds to the live agent"
					title={folding.enabled
						? "Accordion is applying folds to the live agent's context. Takes effect on the agent's next turn."
						: "Folds are previewed in the view only. The agent's context is unchanged."}
					onclick={() => setFolding(!folding.enabled)}
				>
					<Icon name="activity" size={13} />
					<span class="fold-arm-dot" aria-hidden="true"></span>
					<span class="fold-arm-label">Folding: {folding.enabled ? "steering" : "preview"}</span>
				</button>
			{/if}

			<label class="knob">
				<span
					class="kl"
					title="Actual protected tail: {fmt(store.protectedTokens)} tokens; target: {fmt(store.protectTokens)} tokens"
				>
					<Icon name="lock" size={11} />
					<span class="kl-text">protect</span>
					<b class="mono tnum kl-val">{k(store.protectedTokens)}</b>
					{#if store.protectedTokens !== store.protectTokens}
						<span class="kl-target tnum">/{k(store.protectTokens)}</span>
					{/if}
				</span>
				<input
					type="range"
					min="0"
					max="60000"
					step="2000"
					value={store.protectTokens}
					oninput={(e) => store.setProtect(+e.currentTarget.value)}
					aria-label="Protected tokens"
				/>
			</label>

			<label class="knob">
				<span class="kl">
					<Icon name="target" size={11} />
					<span class="kl-text">budget</span>
					<b class="mono tnum kl-val">{k(store.budget)}</b>
				</span>
				<input
					type="range"
					min="12000"
					max={Math.max(store.contextWindow ?? 200_000, store.budget, 200_000)}
					step="2000"
					value={store.budget}
					oninput={(e) => store.setBudget(+e.currentTarget.value)}
					aria-label="Context budget"
				/>
			</label>

			<button class="reset-btn" onclick={() => store.resetAll()}>
				<Icon name="rotate-ccw" size={13} />
				Reset
			</button>
		</div>
	</div>

	<!-- ── Composition bar ── -->
	<div class="bar" role="img" aria-label="Context composition">
		<span class="bar-marker" style:left="{(store.budget / denom) * 100}%" title="budget: {fmt(store.budget)}">
			<span class="bar-marker-cap" aria-hidden="true"></span>
		</span>
		{#each LADDER as seg (seg.kind)}
			{@const v = liveByKind[seg.kind]}
			{#if v > 0}
				<span class="seg k-{seg.kind}" style:width="{(v / denom) * 100}%" title="{seg.label}: {fmt(v)} live"></span>
			{/if}
		{/each}
		{#if store.savedTokens > 0}
			<span class="seg saved-seg" style:width="{(store.savedTokens / denom) * 100}%" title="folded away: {fmt(store.savedTokens)}"></span>
		{/if}
	</div>
</div>

<style>
	/* ── Container ── */
	.hdr {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		padding: var(--sp-3) var(--sp-4) var(--sp-3);
		border-bottom: 1px solid var(--line-soft);
		background: var(--panel);
		box-shadow: var(--shadow-1);
		flex: 0 0 auto;
	}

	/* ── Top row: nums left, ctl right ── */
	.top {
		display: flex;
		align-items: center;
		gap: var(--sp-4);
	}

	/* ── Nums cluster ── */
	.nums {
		display: flex;
		align-items: baseline;
		gap: var(--sp-2);
		min-width: 0;
		flex-wrap: wrap;
	}

	/* Hero stat — the primary focal point */
	.hero-stat {
		font-size: var(--fs-2xl);
		font-weight: 700;
		color: var(--text);
		line-height: 1;
		letter-spacing: -0.01em;
		transition: color var(--dur-fast) var(--ease-out);
	}
	.hero-stat.over {
		color: var(--danger);
	}

	.budget-denom {
		font-size: var(--fs-sm);
		color: var(--faint);
		align-self: baseline;
	}

	/* Usage pill */
	.usage-pill {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--muted);
		background: var(--panel-2);
		border: 1px solid var(--line);
		padding: 2px 8px 2px 6px;
		border-radius: var(--radius-pill);
		transition:
			color var(--dur-fast) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out),
			background var(--dur-fast) var(--ease-out);
	}
	.usage-pill.over {
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 10%, var(--panel-2));
		border-color: color-mix(in srgb, var(--danger) 40%, var(--line));
	}
	.pill-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--muted);
		flex: 0 0 auto;
		transition: background var(--dur-fast) var(--ease-out);
	}
	.usage-pill.over .pill-dot {
		background: var(--danger);
	}

	/* Saved stat */
	.saved-stat {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-xs);
		color: var(--ok);
		opacity: 0.85;
	}

	/* ── Controls cluster ── */
	.ctl {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		flex: 0 0 auto;
	}

	/* Read-only badge */
	.ro-badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-xs);
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--faint);
		background: var(--panel-2);
		border: 1px solid var(--line);
		padding: 3px 8px 3px 6px;
		border-radius: var(--radius-pill);
		white-space: nowrap;
		user-select: none;
	}

	/* Folding-arm toggle */
	.fold-arm {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		background: var(--panel-3);
		border: 1px solid var(--line);
		color: var(--muted);
		padding: 5px 11px 5px 9px;
		border-radius: var(--radius-pill);
		font-size: var(--fs-xs);
		font-weight: 600;
		letter-spacing: 0.01em;
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out);
	}
	.fold-arm:hover {
		background: var(--panel-4);
		border-color: var(--line-strong);
		color: var(--text);
	}
	.fold-arm-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--faint);
		flex: 0 0 auto;
		transition:
			background var(--dur-fast) var(--ease-out),
			box-shadow var(--dur-fast) var(--ease-out);
	}
	.fold-arm.on {
		background: var(--accent-soft);
		border-color: color-mix(in srgb, var(--accent) 60%, var(--line));
		color: var(--accent);
	}
	.fold-arm.on:hover {
		background: color-mix(in srgb, var(--accent) 22%, var(--panel));
		border-color: var(--accent);
	}
	.fold-arm.on .fold-arm-dot {
		background: var(--accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent);
	}

	/* Slider knob */
	.knob {
		display: flex;
		flex-direction: column;
		gap: 4px;
		cursor: default;
	}
	.kl {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-xs);
		color: var(--faint);
		letter-spacing: 0.04em;
		text-transform: uppercase;
		user-select: none;
	}
	.kl-val {
		color: var(--muted);
		font-weight: 600;
		text-transform: none;
		letter-spacing: 0;
	}
	.kl-target {
		color: var(--faint);
		font-weight: 500;
		text-transform: none;
		letter-spacing: 0;
	}
	.knob input[type="range"] {
		width: 120px;
		height: 4px;
		accent-color: var(--accent);
		margin: 0;
		cursor: pointer;
		/* Custom track via appearance manipulation where supported */
		appearance: none;
		-webkit-appearance: none;
		background: var(--panel-2);
		border-radius: var(--radius-pill);
		outline: none;
	}
	.knob input[type="range"]::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--accent);
		cursor: pointer;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
		transition: box-shadow var(--dur-fast) var(--ease-out);
	}
	.knob input[type="range"]:hover::-webkit-slider-thumb {
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 30%, transparent);
	}
	.knob input[type="range"]:focus-visible {
		box-shadow: var(--focus-ring);
		border-radius: var(--radius-pill);
	}

	/* Reset button */
	.reset-btn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		background: var(--panel-3);
		border: 1px solid var(--line);
		color: var(--text);
		padding: 5px 10px 5px 8px;
		border-radius: var(--radius-sm);
		font-size: var(--fs-xs);
		font-weight: 500;
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out);
	}
	.reset-btn:hover {
		background: var(--panel-4);
		border-color: var(--line-strong);
	}

	/* ── Composition bar ── */
	.bar {
		position: relative;
		display: flex;
		height: 26px;
		width: 100%;
		background: var(--panel-2);
		border: 1px solid var(--line-soft);
		/* inset frame shadow gives the "recessed track" feeling */
		box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.35);
		border-radius: var(--radius-pill);
		overflow: hidden;
	}
	.seg {
		height: 100%;
		/* 1px gap between segments via outline trick — avoids reflow */
		outline: 1px solid var(--panel);
		outline-offset: -1px;
		transition: width 180ms var(--ease-out);
		flex: 0 0 auto;
	}
	/* Segment rounding — only first and last visible get radius (paint trick via box-shadow) */
	.seg:first-child  { border-radius: var(--radius-pill) 0 0 var(--radius-pill); }
	.seg:last-of-type { border-radius: 0 var(--radius-pill) var(--radius-pill) 0; }

	.seg.k-user       { background: var(--k-user); }
	.seg.k-text       { background: var(--k-text); }
	.seg.k-thinking   { background: var(--k-thinking); }
	.seg.k-tool_call  { background: var(--k-tool_call); }
	.seg.k-tool_result{ background: var(--k-tool_result); }
	.seg.saved-seg {
		background-color: var(--panel-3);
		background-image: repeating-linear-gradient(
			45deg,
			transparent,
			transparent 4px,
			rgba(255, 255, 255, 0.045) 4px,
			rgba(255, 255, 255, 0.045) 8px
		);
	}

	/* Budget marker line + tiny cap */
	.bar-marker {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: var(--text);
		box-shadow: 0 0 0 1px var(--panel-2);
		pointer-events: none;
		transform: translateX(-50%);
	}
	.bar-marker-cap {
		position: absolute;
		top: -3px;
		left: 50%;
		transform: translateX(-50%);
		width: 6px;
		height: 6px;
		background: var(--text);
		border-radius: 50%;
		box-shadow: 0 0 0 1px var(--panel-2);
	}
</style>
