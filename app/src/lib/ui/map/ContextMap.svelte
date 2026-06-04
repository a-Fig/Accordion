<script lang="ts">
	import type { AccordionStore } from "../../engine/store.svelte";
	import type { Block } from "../../engine/types";

	let {
		store,
		selectedId,
		onselect,
	}: { store: AccordionStore; selectedId: string | null; onselect: (id: string) => void } = $props();

	let zoom = $state<"turns" | "chains">("turns");

	interface Unit {
		key: string;
		turn: number;
		label: string;
		blocks: Block[];
		full: number;
		live: number;
		foldedCount: number;
	}

	// Split the conversation into agent-chains: one assistant message (its
	// thinking/text/call share an id prefix) plus the tool_results that answer it.
	function chainsOf(blocks: Block[]): Block[][] {
		const out: Block[][] = [];
		let cur: Block[] | null = null;
		let curMsg: string | null = null;
		for (const b of blocks) {
			const msg = b.id.split(":")[0];
			if (b.kind === "user") {
				if (cur) out.push(cur);
				out.push([b]);
				cur = null;
				curMsg = null;
				continue;
			}
			if (b.kind !== "tool_result") {
				if (cur && msg !== curMsg) {
					out.push(cur);
					cur = null;
				}
				if (!cur) cur = [];
				curMsg = msg;
				cur.push(b);
			} else {
				if (!cur) {
					cur = [];
					curMsg = null;
				}
				cur.push(b);
			}
		}
		if (cur) out.push(cur);
		return out;
	}

	function measure(blocks: Block[]): { full: number; live: number; folded: number } {
		let full = 0,
			live = 0,
			folded = 0;
		for (const b of blocks) {
			full += b.tokens;
			live += store.effTokens(b);
			if (store.isFolded(b)) folded++;
		}
		return { full, live, folded };
	}

	const units = $derived.by<Unit[]>(() => {
		const out: Unit[] = [];
		if (zoom === "turns") {
			const m = new Map<number, Block[]>();
			for (const b of store.blocks) {
				if (!m.has(b.turn)) m.set(b.turn, []);
				m.get(b.turn)!.push(b);
			}
			for (const [turn, blocks] of [...m.entries()].sort((a, b) => a[0] - b[0])) {
				const mm = measure(blocks);
				out.push({
					key: "t" + turn,
					turn,
					label: turn === 0 ? "pre" : "T" + turn,
					blocks,
					full: mm.full,
					live: mm.live,
					foldedCount: mm.folded,
				});
			}
		} else {
			const chains = chainsOf(store.blocks);
			const seen = new Map<number, number>(); // agent-chain index within each turn
			for (const blocks of chains) {
				const turn = blocks[0]?.turn ?? 0;
				const isUser = blocks.length === 1 && blocks[0].kind === "user";
				let label: string;
				if (isUser) {
					label = turn === 0 ? "pre" : "T" + turn;
				} else {
					const n = (seen.get(turn) ?? 0) + 1;
					seen.set(turn, n);
					label = `T${turn}.${n}`;
				}
				const mm = measure(blocks);
				out.push({
					key: blocks[0].id,
					turn,
					label,
					blocks,
					full: mm.full,
					live: mm.live,
					foldedCount: mm.folded,
				});
			}
		}
		return out;
	});

	const maxFull = $derived(units.reduce((m, u) => Math.max(m, u.full), 1));
	const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);

	function tip(b: Block): string {
		const tool = b.toolName ? ` ${b.toolName}` : "";
		const f = store.isFolded(b) ? ` · folded ${b.tokens}→${store.effTokens(b)}` : "";
		return `${b.kind}${tool} · ${b.tokens.toLocaleString()} tok${f}\nclick to inspect · double-click to fold/unfold`;
	}

	// Delegated handlers — one pair instead of ~1000 per-tile listeners.
	function findId(e: Event): string | null {
		const el = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
		return el?.dataset.id ?? null;
	}
	function onClick(e: MouseEvent) {
		const id = findId(e);
		if (id) onselect(id);
	}
	function onDbl(e: MouseEvent) {
		const id = findId(e);
		if (id) store.toggle(id);
	}
</script>

<div class="map">
	<div class="toolbar">
		<div class="zoom">
			<button class:on={zoom === "turns"} onclick={() => (zoom = "turns")}>Turns</button>
			<button class:on={zoom === "chains"} onclick={() => (zoom = "chains")}>Chains</button>
		</div>
		<span class="count mono">{units.length} {zoom === "turns" ? "turns" : "chains"} · {store.blocks.length} blocks</span>
		<span class="grow"></span>
		<span class="legend">
			<i class="sw solid"></i> live <i class="sw hatch"></i> folded
			<span class="dim">· click = inspect · dbl-click = fold</span>
		</span>
	</div>

	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="rows"
		role="toolbar"
		tabindex="-1"
		aria-label="Context map"
		onclick={onClick}
		ondblclick={onDbl}
	>
		{#each units as u (u.key)}
			<div class="row" class:hasfold={u.foldedCount > 0}>
				<div class="gutter">
					<span class="ul">{u.label}</span>
					<span class="sizebar"><i style:width="{(u.full / maxFull) * 100}%"></i></span>
					<span class="uk mono">{k(u.live)}<span class="dim">/{k(u.full)}</span></span>
				</div>
				<div class="ribbon">
					{#each u.blocks as b (b.id)}
						<div
							class="tile k-{b.kind}"
							class:folded={store.isFolded(b)}
							class:pinned={b.override === "pinned"}
							class:sel={b.id === selectedId}
							style:flex-grow={Math.max(b.tokens, 1)}
							data-id={b.id}
							title={tip(b)}
						></div>
					{/each}
				</div>
			</div>
		{/each}
	</div>
</div>

<style>
	.map {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--bg);
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 14px;
		border-bottom: 1px solid var(--line);
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--muted);
	}
	.zoom {
		display: inline-flex;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		padding: 2px;
		gap: 2px;
	}
	.zoom button {
		background: transparent;
		border: none;
		color: var(--muted);
		font-size: 12px;
		font-weight: 600;
		padding: 3px 12px;
		border-radius: 5px;
	}
	.zoom button:hover {
		color: var(--text);
	}
	.zoom button.on {
		background: var(--panel-3);
		color: var(--text);
	}
	.count {
		font-size: 11px;
	}
	.grow {
		flex: 1;
	}
	.legend {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.sw {
		width: 13px;
		height: 9px;
		border-radius: 2px;
		display: inline-block;
		background: var(--k-thinking);
		vertical-align: -1px;
	}
	.sw.hatch {
		opacity: 0.55;
		background-image: repeating-linear-gradient(45deg, rgba(0, 0, 0, 0.55) 0 1.5px, transparent 1.5px 4px);
	}

	.rows {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 8px 14px 14px;
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.row {
		display: grid;
		grid-template-columns: 112px minmax(0, 1fr);
		align-items: center;
		gap: 12px;
	}
	.gutter {
		display: grid;
		grid-template-columns: 34px 1fr;
		align-items: center;
		gap: 6px 8px;
		grid-template-areas: "label bar" "label tok";
	}
	.ul {
		grid-area: label;
		font-size: 13px;
		font-weight: 700;
		color: var(--text);
	}
	.sizebar {
		grid-area: bar;
		height: 4px;
		background: var(--panel-3);
		border-radius: 999px;
		overflow: hidden;
	}
	.sizebar i {
		display: block;
		height: 100%;
		background: var(--faint);
		border-radius: 999px;
	}
	.uk {
		grid-area: tok;
		font-size: 10px;
		color: var(--muted);
	}
	.dim {
		color: var(--faint);
	}

	.ribbon {
		display: flex;
		height: 26px;
		min-width: 3px;
		border-radius: 4px;
		overflow: hidden;
		background: var(--panel-2);
		box-shadow: inset 0 0 0 1px var(--line-soft);
	}
	.tile {
		height: 100%;
		min-width: 0;
		flex-basis: 0;
		cursor: pointer;
		transition: filter 90ms ease;
	}
	.tile:hover {
		filter: brightness(1.4);
	}
	.tile.k-user { background: var(--k-user); }
	.tile.k-text { background: var(--k-text); }
	.tile.k-thinking { background: var(--k-thinking); }
	.tile.k-tool_call { background: var(--k-tool_call); }
	.tile.k-tool_result { background: var(--k-tool_result); }
	.tile.folded {
		opacity: 0.42;
		background-image: repeating-linear-gradient(
			45deg,
			rgba(0, 0, 0, 0.55) 0,
			rgba(0, 0, 0, 0.55) 1.5px,
			transparent 1.5px,
			transparent 4px
		);
	}
	.tile.pinned {
		box-shadow: inset 0 0 0 1.5px #fff;
	}
	.tile.sel {
		box-shadow: inset 0 0 0 2px var(--text), 0 0 0 1px var(--bg);
		filter: brightness(1.25);
	}
</style>
