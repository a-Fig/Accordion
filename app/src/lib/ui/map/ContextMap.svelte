<script lang="ts">
	import type { AccordionStore } from "../../engine/store.svelte";
	import type { Block } from "../../engine/types";

	let {
		store,
		selectedId,
		onselect,
	}: { store: AccordionStore; selectedId: string | null; onselect: (id: string) => void } = $props();

	let zoom = $state<"grid" | "turns" | "chains">("grid");

	// ---- weight as dice faces: every tile is the same square; token weight is
	//      read as a die face 1–6 (more pips = heavier block). -----------------
	const FACES = [
		{ f: 1, hint: "100" },
		{ f: 2, hint: "500" },
		{ f: 3, hint: "1.5k" },
		{ f: 4, hint: "5k" },
		{ f: 5, hint: "10k" },
		{ f: 6, hint: "50k" },
	] as const;
	function faceFor(tok: number): number {
		return tok >= 50000 ? 6 : tok >= 10000 ? 5 : tok >= 5000 ? 4 : tok >= 1500 ? 3 : tok >= 500 ? 2 : 1;
	}

	// ---- row groupings (turns / chains) ------------------------------------
	interface Unit {
		key: string;
		turn: number;
		label: string;
		blocks: Block[];
		full: number;
		live: number;
		foldedCount: number;
	}
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
	function measure(blocks: Block[]) {
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
		if (zoom === "grid") return [];
		const out: Unit[] = [];
		if (zoom === "turns") {
			const m = new Map<number, Block[]>();
			for (const b of store.blocks) {
				if (!m.has(b.turn)) m.set(b.turn, []);
				m.get(b.turn)!.push(b);
			}
			for (const [turn, blocks] of [...m.entries()].sort((a, b) => a[0] - b[0])) {
				const mm = measure(blocks);
				out.push({ key: "t" + turn, turn, label: turn === 0 ? "pre" : "T" + turn, blocks, full: mm.full, live: mm.live, foldedCount: mm.folded });
			}
		} else {
			const seen = new Map<number, number>();
			for (const blocks of chainsOf(store.blocks)) {
				const turn = blocks[0]?.turn ?? 0;
				const isUser = blocks.length === 1 && blocks[0].kind === "user";
				let label: string;
				if (isUser) label = turn === 0 ? "pre" : "T" + turn;
				else {
					const n = (seen.get(turn) ?? 0) + 1;
					seen.set(turn, n);
					label = `T${turn}.${n}`;
				}
				const mm = measure(blocks);
				out.push({ key: blocks[0].id, turn, label, blocks, full: mm.full, live: mm.live, foldedCount: mm.folded });
			}
		}
		return out;
	});
	const maxFull = $derived(units.reduce((m, u) => Math.max(m, u.full), 1));

	// ---- grid tiles: every block is the same square, in conversation order.
	//      uniform size ⇒ strict order with no reflow holes (linearity for free).
	const tiles = $derived(store.blocks.map((b) => ({ b, face: faceFor(b.tokens) })));
	const count = $derived(store.blocks.length);
	// the protected working tail — newest blocks the auto-folder never touches.
	// split the grid into two boxes: older/foldable (top) and protected (bottom).
	const protectedFrom = $derived(store.protectedFromIndex);
	const olderTiles = $derived(tiles.slice(0, protectedFrom));
	const protectedTiles = $derived(tiles.slice(protectedFrom));

	let stage = $state<HTMLDivElement>();
	let cell = $state(20);
	let cols = $state(40);
	let nudge = $state(0); // user density adjustment (± px per cell)
	const GAP = 4;

	function fit() {
		if (!stage || zoom !== "grid") return;
		// reserve room for the two boxes' chrome (borders, padding, gap)
		const CHROME_H = 84;
		const CHROME_W = 28; // box inner padding
		const W = stage.clientWidth - 28 - CHROME_W;
		const H = stage.clientHeight - 22 - CHROME_H;
		if (W < 40 || H < 40) return;
		// uniform squares: size a cell so all `count` tiles fill the stage. extra
		// waste because each box rounds its last row up independently.
		const waste = 1.12;
		const cpg = Math.sqrt((W * H) / (count * waste));
		let c = Math.floor(cpg - GAP) + nudge;
		c = Math.max(9, Math.min(40, c));
		cols = Math.max(4, Math.floor((W + GAP) / (c + GAP)));
		cell = c;
	}
	$effect(() => {
		if (!stage) return;
		const ro = new ResizeObserver(() => fit());
		ro.observe(stage);
		fit();
		return () => ro.disconnect();
	});
	$effect(() => {
		// refit when these change
		void zoom;
		void nudge;
		void count;
		fit();
	});

	const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);
	function tip(b: Block): string {
		const tool = b.toolName ? ` ${b.toolName}` : "";
		const f = store.isFolded(b) ? ` · folded ${b.tokens}→${store.effTokens(b)}` : "";
		return `${b.kind}${tool} · ${b.tokens.toLocaleString()} tok${f}\nclick to inspect · double-click to fold`;
	}

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

	// ---- arrow-key traversal between neighboring blocks -------------------
	function focusBlock(idx: number) {
		const b = store.blocks[idx];
		if (!b) return;
		if (b.id !== selectedId) onselect(b.id);
		const esc = b.id.replace(/"/g, '\\"');
		stage?.querySelector<HTMLElement>(`[data-id="${esc}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}
	function onKey(e: KeyboardEvent) {
		const key = e.key;
		if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "ArrowUp" && key !== "ArrowDown") return;
		e.preventDefault();
		const n = store.blocks.length;
		if (n === 0) return;
		const idx = selectedId ? store.blocks.findIndex((b) => b.id === selectedId) : -1;
		if (idx === -1) {
			// nothing selected yet — enter from the matching edge
			focusBlock(key === "ArrowLeft" || key === "ArrowUp" ? n - 1 : 0);
			return;
		}
		const step = zoom === "grid" ? cols : 1; // ↑/↓ jump a full row in the grid
		let t = idx;
		if (key === "ArrowRight") t = idx + 1;
		else if (key === "ArrowLeft") t = idx - 1;
		else if (key === "ArrowDown") t = idx + step;
		else t = idx - step;
		t = Math.max(0, Math.min(n - 1, t));
		if (t !== idx) focusBlock(t);
	}
</script>

<div class="map">
	<div class="toolbar">
		<div class="seg">
			<button class:on={zoom === "grid"} onclick={() => (zoom = "grid")}>Grid</button>
			<button class:on={zoom === "turns"} onclick={() => (zoom = "turns")}>Turns</button>
			<button class:on={zoom === "chains"} onclick={() => (zoom = "chains")}>Chains</button>
		</div>

		{#if zoom === "grid"}
			<span class="tiers">
				<span class="tlbl">tokens</span>
				{#each FACES as f}
					<i class="die face f{f.f}" title="face {f.f} · {f.hint} tokens"></i>
				{/each}
			</span>
			<span class="grow"></span>
			<span class="legend"><i class="sw solid"></i>live <i class="sw hatch"></i>folded
				<span class="dim">· ←→↑↓ move</span></span>
			<span class="density">
				<button onclick={() => (nudge -= 1)} aria-label="Smaller tiles" title="Smaller">−</button>
				<button onclick={() => (nudge = 0)} class="reset" title="Reset density">{cell}px</button>
				<button onclick={() => (nudge += 1)} aria-label="Larger tiles" title="Larger">+</button>
			</span>
		{:else}
			<span class="count mono">{units.length} {zoom} · {store.blocks.length} blocks</span>
			<span class="grow"></span>
			<span class="legend"><i class="sw solid"></i>live <i class="sw hatch"></i>folded
				<span class="dim">· click = inspect · dbl-click = fold</span></span>
		{/if}
	</div>

	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="stage"
		class:isgrid={zoom === "grid"}
		bind:this={stage}
		role="toolbar"
		tabindex="0"
		aria-label="Context map — arrow keys move between blocks"
		onclick={onClick}
		ondblclick={onDbl}
		onkeydown={onKey}
	>
		{#if zoom === "grid"}
			{#snippet tile(t: { b: Block; face: number })}
				<div
					class="cell face f{t.face} k-{t.b.kind}"
					class:folded={store.isFolded(t.b)}
					class:pinned={t.b.override === "pinned"}
					class:sel={t.b.id === selectedId}
					data-id={t.b.id}
					title={tip(t.b)}
				></div>
			{/snippet}
			<div class="boxes" style:--cell="{cell}px" style:--cols={cols}>
				{#if olderTiles.length}
					<section class="box older">
						<div class="grid">
							{#each olderTiles as t (t.b.id)}{@render tile(t)}{/each}
						</div>
					</section>
				{/if}
				<section class="box prot">
					<div class="grid">
						{#each protectedTiles as t (t.b.id)}{@render tile(t)}{/each}
					</div>
				</section>
			</div>
		{:else}
			{#each units as u (u.key)}
				<div class="row">
					<div class="gutter">
						<span class="ul">{u.label}</span>
						<span class="sizebar"><i style:width="{(u.full / maxFull) * 100}%"></i></span>
						<span class="uk mono">{k(u.live)}<span class="dim">/{k(u.full)}</span></span>
					</div>
					<div class="ribbon">
						{#each u.blocks as b (b.id)}
							<div
								class="rtile k-{b.kind}"
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
		{/if}
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

	/* ---- toolbar ---- */
	.toolbar {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 9px 16px;
		border-bottom: 1px solid var(--line);
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--muted);
	}
	.seg {
		display: inline-flex;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: 7px;
		padding: 2px;
		gap: 2px;
	}
	.seg button {
		background: transparent;
		border: none;
		color: var(--muted);
		font-size: 12px;
		font-weight: 600;
		padding: 4px 13px;
		border-radius: 5px;
		transition: background 130ms ease, color 130ms ease;
	}
	.seg button:hover {
		color: var(--text);
	}
	.seg button.on {
		background: var(--panel-3);
		color: var(--text);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
	}
	.grow {
		flex: 1;
	}
	.count {
		font-size: 11px;
	}
	.dim {
		color: var(--faint);
	}

	.tiers {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.tlbl {
		color: var(--faint);
		margin-right: 4px;
	}
	.die {
		box-sizing: border-box;
		width: 17px;
		height: 17px;
		background: var(--panel-3);
		border: 1px solid var(--line);
		border-radius: 3px;
		display: inline-block;
	}

	.legend {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.sw {
		width: 12px;
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

	.density {
		display: inline-flex;
		align-items: center;
		background: var(--panel);
		border: 1px solid var(--line);
		border-radius: 7px;
		overflow: hidden;
	}
	.density button {
		background: transparent;
		border: none;
		color: var(--muted);
		font-size: 12px;
		padding: 3px 9px;
		min-width: 26px;
		transition: background 120ms ease, color 120ms ease;
	}
	.density button:hover {
		background: var(--panel-3);
		color: var(--text);
	}
	.density .reset {
		font-size: 10px;
		color: var(--faint);
		min-width: 40px;
		border-left: 1px solid var(--line);
		border-right: 1px solid var(--line);
		font-variant-numeric: tabular-nums;
	}

	/* ---- stage ---- */
	.stage {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 11px 14px 14px;
	}
	.stage.isgrid {
		overflow-y: auto;
		padding: 11px 14px;
	}
	.stage:focus {
		outline: none;
	}
	.stage:focus-visible {
		outline: none;
		box-shadow: inset 0 0 0 1px var(--accent-dim, var(--line));
	}

	/* ---- two boxes: older/foldable (top) + protected tail (bottom) ---- */
	.boxes {
		display: flex;
		flex-direction: column;
		gap: 16px;
		width: 100%;
	}
	.box {
		border-radius: 14px;
		border: 1.5px solid var(--line);
		background: var(--panel-2);
		padding: 12px;
	}
	/* the protected box: a meaningfully thicker, accented frame implies protection */
	.box.prot {
		border: 4px solid var(--accent-dim, var(--accent));
		background: var(--panel);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
	}

	/* ---- grid: uniform squares, conversation order (no dense backfill) ---- */
	.grid {
		display: grid;
		grid-template-columns: repeat(var(--cols), var(--cell));
		grid-auto-rows: var(--cell);
		gap: 4px;
		align-content: start;
		justify-content: center;
		width: 100%;
	}
	.cell {
		box-sizing: border-box;
		/* skip painting tiles outside the viewport → smooth scroll over ~1k tiles */
		content-visibility: auto;
		contain-intrinsic-size: var(--cell) var(--cell);
		border-radius: 3px;
		cursor: pointer;
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.22);
	}
	.cell:hover {
		/* instant (no transition) so scrolling past tiles doesn't animate a repaint storm */
		filter: brightness(1.22);
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.3);
		z-index: 2;
	}
	.cell.k-user { background: var(--k-user); }
	.cell.k-text { background: var(--k-text); }
	.cell.k-thinking { background: var(--k-thinking); }
	.cell.k-tool_call { background: var(--k-tool_call); }
	.cell.k-tool_result { background: var(--k-tool_result); }
	.cell.folded {
		opacity: 0.36;
		filter: saturate(0.5);
		background-image: repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.06) 0 1px, transparent 1px 5px);
	}
	.cell.folded:hover {
		opacity: 0.85;
		filter: saturate(1) brightness(1.1);
	}
	.cell.pinned {
		box-shadow: inset 0 0 0 2px #fff;
	}
	.cell.sel {
		/* inset-only so paint-containment (content-visibility) never clips it */
		box-shadow: inset 0 0 0 2px var(--accent), inset 0 0 0 3px rgba(0, 0, 0, 0.55);
		filter: brightness(1.18);
		z-index: 3;
	}

	/* ---- dice-face pips: token weight read as a die face 1–6 ----
	   Each face is ONE cached SVG image (decoded once, blitted cheaply) instead
	   of live radial gradients — gradients re-rasterize on every repaint and
	   tanked interaction across 982 tiles. Pips scale with the tile via the SVG. */
	.face {
		position: relative;
	}
	.face::before {
		content: "";
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background-repeat: no-repeat;
		background-position: center;
		background-size: 100% 100%;
		pointer-events: none;
	}
	.f1::before {
		background-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><g fill='%23fff' stroke='%23000' stroke-opacity='.5' stroke-width='3.6'><circle cx='50' cy='50' r='11'/></g></svg>");
	}
	.f2::before {
		background-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><g fill='%23fff' stroke='%23000' stroke-opacity='.5' stroke-width='3.6'><circle cx='28' cy='28' r='11'/><circle cx='72' cy='72' r='11'/></g></svg>");
	}
	.f3::before {
		background-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><g fill='%23fff' stroke='%23000' stroke-opacity='.5' stroke-width='3.6'><circle cx='28' cy='28' r='11'/><circle cx='50' cy='50' r='11'/><circle cx='72' cy='72' r='11'/></g></svg>");
	}
	.f4::before {
		background-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><g fill='%23fff' stroke='%23000' stroke-opacity='.5' stroke-width='3.6'><circle cx='28' cy='28' r='11'/><circle cx='72' cy='28' r='11'/><circle cx='28' cy='72' r='11'/><circle cx='72' cy='72' r='11'/></g></svg>");
	}
	.f5::before {
		background-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><g fill='%23fff' stroke='%23000' stroke-opacity='.5' stroke-width='3.6'><circle cx='28' cy='28' r='11'/><circle cx='72' cy='28' r='11'/><circle cx='50' cy='50' r='11'/><circle cx='28' cy='72' r='11'/><circle cx='72' cy='72' r='11'/></g></svg>");
	}
	.f6::before {
		background-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><g fill='%23fff' stroke='%23000' stroke-opacity='.5' stroke-width='3.6'><circle cx='28' cy='26' r='11'/><circle cx='72' cy='26' r='11'/><circle cx='28' cy='50' r='11'/><circle cx='72' cy='50' r='11'/><circle cx='28' cy='74' r='11'/><circle cx='72' cy='74' r='11'/></g></svg>");
	}

	/* ---- ribbon rows (turns / chains) ---- */
	.row {
		display: grid;
		grid-template-columns: 112px minmax(0, 1fr);
		align-items: center;
		gap: 12px;
		margin-bottom: 5px;
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
	.ribbon {
		display: flex;
		height: 26px;
		min-width: 3px;
		border-radius: 4px;
		overflow: hidden;
		background: var(--panel-2);
		box-shadow: inset 0 0 0 1px var(--line-soft);
	}
	.rtile {
		height: 100%;
		min-width: 0;
		flex-basis: 0;
		cursor: pointer;
		transition: filter 90ms ease;
	}
	.rtile:hover {
		filter: brightness(1.4);
	}
	.rtile.k-user { background: var(--k-user); }
	.rtile.k-text { background: var(--k-text); }
	.rtile.k-thinking { background: var(--k-thinking); }
	.rtile.k-tool_call { background: var(--k-tool_call); }
	.rtile.k-tool_result { background: var(--k-tool_result); }
	.rtile.folded {
		opacity: 0.42;
		background-image: repeating-linear-gradient(45deg, rgba(0, 0, 0, 0.55) 0, rgba(0, 0, 0, 0.55) 1.5px, transparent 1.5px, transparent 4px);
	}
	.rtile.pinned {
		box-shadow: inset 0 0 0 1.5px #fff;
	}
	.rtile.sel {
		box-shadow: inset 0 0 0 2px var(--text);
		filter: brightness(1.2);
	}
</style>
