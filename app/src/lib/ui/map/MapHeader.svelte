<script lang="ts">
	import type { AccordionStore } from "../../engine/store.svelte";
	import type { BlockKind } from "../../engine/types";

	let { store }: { store: AccordionStore } = $props();

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
	const fmt = (n: number) => n.toLocaleString();
	const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
	const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);
</script>

<div class="hdr">
	<div class="top">
		<div class="nums">
			<b class="live mono" class:over={store.overBudget}>{fmt(store.liveTokens)}</b>
			<span class="of">/ {fmt(store.budget)} budget</span>
			<span class="pill" class:over={store.overBudget}>
				{store.overBudget ? `over by ${k(store.liveTokens - store.budget)}` : `${pct(store.liveTokens, store.budget)}%`}
			</span>
			{#if store.savedTokens > 0}
				<span class="saved">folding saved {fmt(store.savedTokens)} ({pct(store.savedTokens, store.fullTokens)}% of {k(store.fullTokens)})</span>
			{/if}
		</div>
		<div class="ctl">
			<input
				type="range"
				min="12000"
				max="160000"
				step="2000"
				value={store.budget}
				oninput={(e) => store.setBudget(+e.currentTarget.value)}
				aria-label="Context budget"
			/>
			<button class="reset" onclick={() => store.resetAll()}>Reset</button>
		</div>
	</div>

	<div class="bar" role="img" aria-label="Context composition">
		{#each LADDER as seg (seg.kind)}
			{@const v = liveByKind[seg.kind]}
			{#if v > 0}
				<span class="seg k-{seg.kind}" style:width="{(v / denom) * 100}%" title="{seg.label}: {fmt(v)} live"></span>
			{/if}
		{/each}
		{#if store.savedTokens > 0}
			<span class="seg saved-seg" style:width="{(store.savedTokens / denom) * 100}%" title="folded away: {fmt(store.savedTokens)}"></span>
		{/if}
		<span class="marker" style:left="{(store.budget / denom) * 100}%" title="budget"></span>
	</div>
</div>

<style>
	.hdr {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 11px 16px 13px;
		border-bottom: 1px solid var(--line);
		background: var(--panel);
		flex: 0 0 auto;
	}
	.top {
		display: flex;
		align-items: center;
		gap: 16px;
	}
	.nums {
		display: flex;
		align-items: baseline;
		gap: 9px;
		min-width: 0;
		flex-wrap: wrap;
	}
	.live {
		font-size: 19px;
		font-weight: 700;
	}
	.live.over {
		color: var(--danger);
	}
	.of {
		font-size: 12px;
		color: var(--muted);
	}
	.pill {
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
		background: var(--panel-2);
		border: 1px solid var(--line);
		padding: 2px 8px;
		border-radius: 999px;
	}
	.pill.over {
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 45%, var(--line));
	}
	.saved {
		font-size: 11px;
		color: var(--faint);
	}
	.ctl {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 10px;
		flex: 0 0 auto;
	}
	.ctl input[type="range"] {
		width: 190px;
		accent-color: var(--accent);
	}
	.reset {
		background: var(--panel-3);
		border: 1px solid var(--line);
		color: var(--text);
		padding: 4px 10px;
		border-radius: var(--radius-sm);
		font-size: 12px;
	}
	.reset:hover {
		background: var(--line);
	}

	.bar {
		position: relative;
		display: flex;
		height: 26px;
		width: 100%;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		overflow: hidden;
	}
	.seg {
		height: 100%;
		transition: width 180ms ease;
	}
	.seg.k-user { background: var(--k-user); }
	.seg.k-text { background: var(--k-text); }
	.seg.k-thinking { background: var(--k-thinking); }
	.seg.k-tool_call { background: var(--k-tool_call); }
	.seg.k-tool_result { background: var(--k-tool_result); }
	.seg.saved-seg {
		background-color: var(--panel-2);
		background-image: repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(255, 255, 255, 0.05) 4px, rgba(255, 255, 255, 0.05) 8px);
	}
	.marker {
		position: absolute;
		top: -2px;
		bottom: -2px;
		width: 2px;
		background: var(--text);
		box-shadow: 0 0 0 1px var(--bg);
		pointer-events: none;
	}
</style>
