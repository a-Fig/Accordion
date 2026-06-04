<script lang="ts">
	import type { AccordionStore } from "../engine/store.svelte";
	import type { BlockKind } from "../engine/types";

	let { store, onpick }: { store: AccordionStore; onpick: (id: string) => void } = $props();

	// Ordered by value-over-time: the top of this list is the first thing folding
	// gives up (cheap to lose, decays fast); the bottom is kept longest.
	const LADDER: { kind: BlockKind; label: string; note: string }[] = [
		{ kind: "tool_result", label: "Tool results", note: "what tools returned — decays fastest, folded first" },
		{ kind: "thinking", label: "Thinking", note: "reasoning — fades once the turn is done" },
		{ kind: "text", label: "Replies", note: "the agent's messages back to you" },
		{ kind: "tool_call", label: "Tool calls", note: "what the agent did — a durable record, kept" },
		{ kind: "user", label: "Your messages", note: "your intent — folded last of all" },
	];

	interface Row {
		kind: BlockKind;
		label: string;
		note: string;
		live: number; // tokens currently in the window
		full: number; // tokens if nothing of this kind were folded
		count: number; // how many blocks of this kind
		folded: number; // how many are folded
		bigId: string; // id of the single heaviest block (jump target)
	}

	const rows = $derived.by<Row[]>(() => {
		const m = new Map<BlockKind, Row>();
		for (const k of LADDER) m.set(k.kind, { ...k, live: 0, full: 0, count: 0, folded: 0, bigId: "" });
		const bigTok = new Map<BlockKind, number>();
		for (const b of store.blocks) {
			const r = m.get(b.kind);
			if (!r) continue;
			r.live += store.effTokens(b);
			r.full += b.tokens;
			r.count++;
			if (store.isFolded(b)) r.folded++;
			if (b.tokens > (bigTok.get(b.kind) ?? -1)) {
				bigTok.set(b.kind, b.tokens);
				r.bigId = b.id;
			}
		}
		return [...m.values()];
	});

	// The bar's full extent represents the larger of "everything unfolded" or the
	// budget — so the budget line is always on-screen and the saved tail is honest.
	const denom = $derived(Math.max(store.fullTokens, store.budget, 1));
	const budgetLeft = $derived((store.budget / denom) * 100);
	const sorted = $derived([...rows].sort((a, b) => b.live - a.live));

	const fmt = (n: number) => n.toLocaleString();
	const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
	const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);
</script>

<div class="summary">
	<!-- headline: the one sentence that frames the whole picture -->
	<div class="head">
		<div class="lede">
			<b class="mono live" class:over={store.overBudget}>{fmt(store.liveTokens)}</b>
			<span class="of">in the window</span>
			<span class="sep">·</span>
			<b class="mono">{fmt(store.budget)}</b>
			<span class="of">budget</span>
		</div>
		<div class="pill" class:over={store.overBudget}>
			{store.overBudget ? `over by ${k(store.liveTokens - store.budget)}` : `${pct(store.liveTokens, store.budget)}% full`}
		</div>
	</div>

	<!-- the hero bar: colored = live by type, faint = folded away, line = budget -->
	<div
		class="bar"
		role="img"
		aria-label="Context composition by type, with folded portion and budget marker"
	>
		{#each LADDER as seg (seg.kind)}
			{@const r = rows.find((x) => x.kind === seg.kind)}
			{#if r && r.live > 0}
				<span
					class="seg k-{seg.kind}"
					style:width="{(r.live / denom) * 100}%"
					title="{seg.label}: {fmt(r.live)} live tokens"
				></span>
			{/if}
		{/each}
		{#if store.savedTokens > 0}
			<span
				class="seg saved"
				style:width="{(store.savedTokens / denom) * 100}%"
				title="Folded away: {fmt(store.savedTokens)} tokens"
			></span>
		{/if}
		<span class="marker" style:left="{budgetLeft}%" title="Budget: {fmt(store.budget)}"></span>
	</div>

	<div class="caption">
		<span class="swatch live-sw"></span> live now
		<span class="swatch saved-sw"></span> folded away
		<span class="swatch budget-sw"></span> budget
		<span class="grow"></span>
		{#if store.savedTokens > 0}
			Folding saved <b>{fmt(store.savedTokens)}</b> tokens · would be
			<b>{fmt(store.fullTokens)}</b> unfolded ({pct(store.fullTokens, store.budget)}% of budget)
		{:else}
			Nothing folded — all <b>{fmt(store.fullTokens)}</b> tokens are live
		{/if}
	</div>

	<!-- breakdown: 5 readable rows, biggest first, click to jump to the heaviest block -->
	<div class="rows">
		{#each sorted as r (r.kind)}
			<button class="row" onclick={() => r.bigId && onpick(r.bigId)} title="Jump to the largest {r.label.toLowerCase()} block">
				<span class="dot k-{r.kind}"></span>
				<span class="name">{r.label}</span>
				<span class="meter"><span class="meter-fill k-{r.kind}" style:width="{pct(r.live, store.liveTokens)}%"></span></span>
				<span class="tok mono">{fmt(r.live)}</span>
				<span class="share mono">{pct(r.live, store.liveTokens)}%</span>
				<span class="fold mono" class:dim={r.folded === 0}>
					{r.folded ? `${r.folded}/${r.count} folded` : `${r.count}`}
				</span>
			</button>
		{/each}
	</div>
</div>

<style>
	.summary {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.head {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}
	.lede {
		display: flex;
		align-items: baseline;
		gap: 6px;
		font-size: 13px;
	}
	.lede .live {
		font-size: 22px;
		font-weight: 700;
		letter-spacing: -0.01em;
	}
	.lede .live.over {
		color: var(--danger);
	}
	.lede .of {
		color: var(--muted);
		font-size: 12px;
	}
	.lede .sep {
		color: var(--faint);
		margin: 0 2px;
	}
	.lede b.mono {
		color: var(--text);
	}
	.pill {
		margin-left: auto;
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
		background: var(--panel-2);
		border: 1px solid var(--line);
		padding: 3px 9px;
		border-radius: 999px;
	}
	.pill.over {
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 45%, var(--line));
		background: color-mix(in srgb, var(--danger) 14%, var(--panel-2));
	}

	.bar {
		position: relative;
		display: flex;
		align-items: stretch;
		height: 34px;
		width: 100%;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		overflow: hidden;
	}
	.seg {
		height: 100%;
		min-width: 0;
		transition: width 180ms ease;
	}
	.seg.k-user { background: var(--k-user); }
	.seg.k-text { background: var(--k-text); }
	.seg.k-thinking { background: var(--k-thinking); }
	.seg.k-tool_call { background: var(--k-tool_call); }
	.seg.k-tool_result { background: var(--k-tool_result); }
	.seg.saved {
		background-color: var(--panel-2);
		background-image: repeating-linear-gradient(
			45deg,
			transparent,
			transparent 4px,
			rgba(255, 255, 255, 0.05) 4px,
			rgba(255, 255, 255, 0.05) 8px
		);
	}
	.marker {
		position: absolute;
		top: -3px;
		bottom: -3px;
		width: 2px;
		background: var(--text);
		box-shadow: 0 0 0 1px var(--bg);
		pointer-events: none;
	}

	.caption {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 11px;
		color: var(--muted);
		flex-wrap: wrap;
	}
	.caption b {
		color: var(--text);
		font-weight: 600;
	}
	.caption .grow {
		flex: 1;
	}
	.swatch {
		width: 10px;
		height: 10px;
		border-radius: 2px;
		display: inline-block;
		vertical-align: -1px;
	}
	.swatch.live-sw {
		background: linear-gradient(90deg, var(--k-tool_result), var(--k-thinking), var(--k-user));
	}
	.swatch.saved-sw {
		background: var(--panel-2);
		background-image: repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(255, 255, 255, 0.12) 2px, rgba(255, 255, 255, 0.12) 4px);
		border: 1px solid var(--line);
	}
	.swatch.budget-sw {
		width: 2px;
		height: 12px;
		border-radius: 0;
		background: var(--text);
	}

	.rows {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-top: 2px;
	}
	.row {
		display: grid;
		grid-template-columns: 14px minmax(96px, 1.1fr) minmax(60px, 2fr) 64px 42px 96px;
		align-items: center;
		gap: 10px;
		padding: 5px 8px;
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		text-align: left;
		transition: background 110ms ease;
	}
	.row:hover {
		background: var(--panel-2);
	}
	.dot {
		width: 10px;
		height: 10px;
		border-radius: 3px;
	}
	.dot.k-user { background: var(--k-user); }
	.dot.k-text { background: var(--k-text); }
	.dot.k-thinking { background: var(--k-thinking); }
	.dot.k-tool_call { background: var(--k-tool_call); }
	.dot.k-tool_result { background: var(--k-tool_result); }
	.name {
		font-size: 13px;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.meter {
		height: 7px;
		background: var(--panel-3);
		border-radius: 999px;
		overflow: hidden;
	}
	.meter-fill {
		display: block;
		height: 100%;
		border-radius: 999px;
		transition: width 180ms ease;
	}
	.meter-fill.k-user { background: var(--k-user); }
	.meter-fill.k-text { background: var(--k-text); }
	.meter-fill.k-thinking { background: var(--k-thinking); }
	.meter-fill.k-tool_call { background: var(--k-tool_call); }
	.meter-fill.k-tool_result { background: var(--k-tool_result); }
	.tok {
		font-size: 12px;
		font-weight: 600;
		text-align: right;
		color: var(--text);
	}
	.share {
		font-size: 11px;
		text-align: right;
		color: var(--muted);
	}
	.fold {
		font-size: 11px;
		text-align: right;
		color: var(--warn);
		white-space: nowrap;
	}
	.fold.dim {
		color: var(--faint);
	}
</style>
