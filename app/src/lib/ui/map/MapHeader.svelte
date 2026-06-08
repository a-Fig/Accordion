<script lang="ts">
	import type { AccordionStore } from "../../engine/store.svelte";
	import type { BlockKind } from "../../engine/types";
	import AnimatedNumber from "$lib/ui/AnimatedNumber.svelte";
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
			// whole millions read cleanest as "1M"; keep one decimal otherwise ("1.5M")
			return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
		}
		return r >= 1000 ? `${(r / 1000).toFixed(r >= 10000 ? 0 : 1)}k` : `${r}`;
	};
	// over-by figure for the pill — rounds the difference mid-tween
	const fmtOverBy = (n: number) => k(Math.round(n));
</script>

<div class="hdr">
	<div class="top">
		<div class="nums">
			<b class="live mono" class:over={store.overBudget}><AnimatedNumber value={store.liveTokens} format={fmt} /></b>
			<span class="of">/ {fmt(store.budget)} budget</span>
			<span class="pill" class:over={store.overBudget}>
				{#if store.overBudget}
					over by <AnimatedNumber value={store.liveTokens - store.budget} format={fmtOverBy} />
				{:else}
					<AnimatedNumber value={pct(store.liveTokens, store.budget)} format={(n) => `${Math.round(n)}%`} />
				{/if}
			</span>
			{#if store.savedTokens > 0}
				<span class="saved">folding saved <AnimatedNumber value={store.savedTokens} format={fmt} /> ({pct(store.savedTokens, store.fullTokens)}% of {k(store.fullTokens)})</span>
			{/if}
		</div>
		<div class="ctl">
			{#if readOnly}
				<span
					class="ro-badge"
					role="status"
					aria-label="Read-only session"
					title="Viewing a recording — folds are local and do not affect any agent."
				>READ-ONLY</span>
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
					<span class="dot" aria-hidden="true"></span>
					<span class="fl">Folding: {folding.enabled ? "steering" : "preview"}</span>
				</button>
			{/if}
			<label class="knob">
				<span class="kl">protected <b class="mono">{k(store.protectTokens)}</b></span>
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
				<span class="kl">budget <b class="mono">{k(store.budget)}</b></span>
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
		align-items: flex-end;
		gap: 14px;
		flex: 0 0 auto;
	}
	.knob {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.kl {
		font-size: 10px;
		color: var(--faint);
		letter-spacing: 0.02em;
	}
	.kl b {
		color: var(--muted);
		font-weight: 600;
	}
	.ctl input[type="range"] {
		width: 140px;
		accent-color: var(--accent);
		margin: 0;
	}
	.reset {
		background: var(--panel-3);
		border: 1px solid var(--line);
		color: var(--text);
		padding: 4px 10px;
		border-radius: var(--radius-sm);
		font-size: 12px;
		transition: background var(--dur-fast) var(--ease-out);
	}
	.reset:hover {
		background: var(--line);
	}

	/* Folding arm switch — the first control that changes what a live model sees.
	   OFF (preview): muted, recessed, reads as inert. ON (steering): accent-lit
	   with a glowing dot so it's unmistakable the agent is being touched. */
	.fold-arm {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		align-self: center;
		background: var(--panel-3);
		border: 1px solid var(--line);
		color: var(--muted);
		padding: 5px 11px;
		border-radius: 999px;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.01em;
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out),
			color var(--dur-fast) var(--ease-out);
	}
	.fold-arm:hover {
		border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
		color: var(--text);
	}
	.fold-arm .dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--faint);
		flex: 0 0 auto;
		transition:
			background var(--dur-fast) var(--ease-out),
			box-shadow var(--dur-fast) var(--ease-out);
	}
	.fold-arm.on {
		background: color-mix(in srgb, var(--accent) 16%, var(--panel));
		border-color: color-mix(in srgb, var(--accent) 60%, var(--line));
		color: var(--accent);
	}
	.fold-arm.on:hover {
		background: color-mix(in srgb, var(--accent) 24%, var(--panel));
	}
	.fold-arm.on .dot {
		background: var(--accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent);
	}

	.ro-badge {
		display: inline-flex;
		align-items: center;
		align-self: center;
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--faint);
		background: var(--panel-2);
		border: 1px solid var(--line);
		padding: 3px 8px;
		border-radius: 999px;
		white-space: nowrap;
		user-select: none;
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
