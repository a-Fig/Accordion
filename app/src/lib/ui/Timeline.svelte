<script lang="ts">
	import type { AccordionStore } from "../engine/store.svelte";
	import BlockCard from "./BlockCard.svelte";

	let { store }: { store: AccordionStore } = $props();

	// Walk blocks in order, emitting a turn divider whenever the turn number ticks.
	const rows = $derived.by(() => {
		const out: ({ divider: true; turn: number } | { divider: false; block: (typeof store.blocks)[number] })[] = [];
		let prev = -1;
		for (const b of store.blocks) {
			if (b.turn !== prev) {
				out.push({ divider: true, turn: b.turn });
				prev = b.turn;
			}
			out.push({ divider: false, block: b });
		}
		return out;
	});
</script>

<div class="timeline">
	{#each rows as row (row.divider ? "d" + row.turn : row.block.id)}
		{#if row.divider}
			<div class="divider">
				<span class="ln"></span>
				<span class="lbl">{row.turn === 0 ? "Session start" : `Turn ${row.turn}`}</span>
				<span class="ln"></span>
			</div>
		{:else}
			<BlockCard {store} block={row.block} />
		{/if}
	{/each}
</div>

<style>
	.timeline {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 4px 2px 40vh;
	}
	.divider {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 14px 2px 6px;
	}
	.divider .ln {
		height: 1px;
		background: var(--line-soft);
		flex: 1;
	}
	.divider .lbl {
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--faint);
		font-weight: 600;
	}
</style>
