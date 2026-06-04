<script lang="ts">
	import type { AccordionStore } from "../engine/store.svelte";
	import type { Block } from "../engine/types";

	let { store, onpick }: { store: AccordionStore; onpick: (id: string) => void } = $props();

	interface Turn {
		turn: number;
		blocks: Block[];
		full: number; // tokens if nothing folded — drives row length
		live: number; // tokens in the window now
		folded: number; // how many blocks folded
		firstId: string;
	}

	const turns = $derived.by<Turn[]>(() => {
		const m = new Map<number, Turn>();
		for (const b of store.blocks) {
			let t = m.get(b.turn);
			if (!t) {
				t = { turn: b.turn, blocks: [], full: 0, live: 0, folded: 0, firstId: b.id };
				m.set(b.turn, t);
			}
			t.blocks.push(b);
			t.full += b.tokens;
			t.live += store.effTokens(b);
			if (store.isFolded(b)) t.folded++;
		}
		return [...m.values()].sort((a, b) => a.turn - b.turn);
	});

	const maxFull = $derived(turns.reduce((m, t) => Math.max(m, t.full), 1));

	const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);

	function tip(b: Block): string {
		const tool = b.toolName ? ` ${b.toolName}` : "";
		return `${b.kind}${tool} · ${b.tokens.toLocaleString()} tok${store.isFolded(b) ? " · folded" : ""}`;
	}

	// one delegated click handler instead of ~1000 button elements
	function onClick(e: MouseEvent) {
		const el = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
		if (el?.dataset.id) onpick(el.dataset.id);
	}
</script>

<div class="wrap">
	<!-- delegated click surface (avoids ~1000 focusable nodes); keyboard reaches blocks via the timeline list below -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="rows" role="toolbar" tabindex="-1" aria-label="Context timeline by turn" onclick={onClick}>
		{#each turns as t (t.turn)}
			<div class="row">
				<div class="gutter" data-id={t.firstId} title="Jump to turn {t.turn}">
					<span class="tn">{t.turn === 0 ? "pre" : "T" + t.turn}</span>
					<span class="tk mono">{k(t.full)}</span>
				</div>
				<div class="track">
					<div class="ribbon" style:width="{(t.full / maxFull) * 100}%">
						{#each t.blocks as b (b.id)}
							<div
								class="seg k-{b.kind}"
								class:folded={store.isFolded(b)}
								class:pinned={b.override === "pinned"}
								style:flex-grow={Math.max(b.tokens, 1)}
								data-id={b.id}
								title={tip(b)}
							></div>
						{/each}
					</div>
					{#if t.folded}
						<span class="rmeta mono">{t.folded}/{t.blocks.length} folded · {k(t.live)} live</span>
					{:else}
						<span class="rmeta mono dim">{t.blocks.length} blocks</span>
					{/if}
				</div>
			</div>
		{/each}
	</div>
	<div class="foot">
		<span class="lg"><i class="sw solid"></i> live</span>
		<span class="lg"><i class="sw hatch"></i> folded</span>
		<span class="grow"></span>
		<span class="dim">row length = turn size · segment = one block, by tokens</span>
	</div>
</div>

<style>
	.wrap {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 264px;
		overflow-y: auto;
		padding-right: 4px;
	}
	.row {
		display: grid;
		grid-template-columns: 52px minmax(0, 1fr);
		align-items: center;
		gap: 10px;
	}
	.gutter {
		display: flex;
		flex-direction: column;
		line-height: 1.1;
		cursor: pointer;
		border-radius: 4px;
		padding: 2px 4px;
		transition: background 110ms ease;
	}
	.gutter:hover {
		background: var(--panel-2);
	}
	.tn {
		font-size: 12px;
		font-weight: 700;
		color: var(--text);
	}
	.tk {
		font-size: 10px;
		color: var(--faint);
	}
	.track {
		position: relative;
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.ribbon {
		display: flex;
		height: 18px;
		min-width: 3px;
		border-radius: 3px;
		overflow: hidden;
		background: var(--panel-2);
		box-shadow: inset 0 0 0 1px var(--line-soft);
	}
	.seg {
		height: 100%;
		min-width: 0; /* purely token-proportional — never overflow/clip the ribbon */
		flex-basis: 0;
		cursor: pointer;
		transition: filter 90ms ease;
	}
	.seg:hover {
		filter: brightness(1.35);
	}
	.seg.k-user { background: var(--k-user); }
	.seg.k-text { background: var(--k-text); }
	.seg.k-thinking { background: var(--k-thinking); }
	.seg.k-tool_call { background: var(--k-tool_call); }
	.seg.k-tool_result { background: var(--k-tool_result); }
	.seg.folded {
		opacity: 0.5;
		background-image: repeating-linear-gradient(
			45deg,
			rgba(0, 0, 0, 0.5) 0,
			rgba(0, 0, 0, 0.5) 1.5px,
			transparent 1.5px,
			transparent 4px
		);
	}
	.seg.pinned {
		box-shadow: inset 0 0 0 1.5px #fff;
	}
	.rmeta {
		font-size: 10px;
		color: var(--warn);
		white-space: nowrap;
		flex: 0 0 auto;
	}
	.rmeta.dim {
		color: var(--faint);
	}
	.foot {
		display: flex;
		align-items: center;
		gap: 14px;
		font-size: 11px;
		color: var(--muted);
	}
	.foot .grow {
		flex: 1;
	}
	.foot .dim {
		color: var(--faint);
	}
	.lg {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.sw {
		width: 14px;
		height: 10px;
		border-radius: 2px;
		display: inline-block;
		background: var(--k-thinking);
	}
	.sw.hatch {
		opacity: 0.6;
		background-image: repeating-linear-gradient(
			45deg,
			rgba(0, 0, 0, 0.5) 0,
			rgba(0, 0, 0, 0.5) 1.5px,
			transparent 1.5px,
			transparent 4px
		);
	}
</style>
