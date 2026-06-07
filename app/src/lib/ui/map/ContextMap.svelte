<script lang="ts">
	import { untrack, onDestroy } from "svelte";
	import type { AccordionStore } from "../../engine/store.svelte";
	import type { Block, Group } from "../../engine/types";
	import { ghosts, type Ghost } from "../../live/ghostState.svelte";
	import { nextVacated } from "./drain";
	import AnimatedNumber from "$lib/ui/AnimatedNumber.svelte";
	import { buildDisplay, type DisplayRow } from "$lib/engine/display";

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
	// live (effective) token weight in each box — shown as a vertical tally on the
	// box's left rail. The protected tail never folds, so its eff == full.
	const olderTok = $derived(olderTiles.reduce((s, t) => s + store.effTokens(t.b), 0));
	const protTok = $derived(protectedTiles.reduce((s, t) => s + t.b.tokens, 0));

	// ---- display list for the older box: groups + plain blocks via buildDisplay ----
	const olderBlocks = $derived(store.blocks.slice(0, protectedFrom));
	const displayRows = $derived(buildDisplay(olderBlocks, store.groups));

	let stage = $state<HTMLDivElement>();
	let mapEl = $state<HTMLDivElement>();
	let cell = $state(20);
	let cols = $state(40);
	let nudge = $state(0); // user density adjustment (± px per cell)
	const GAP = 4;

	// ---- "drain without reflow" -------------------------------------------------
	// When a block crosses out of the protected tail it should leave a HOLE rather
	// than yanking its neighbours back a slot. Holes pile up at the front of the
	// protected grid; only when a whole leading row is empty (or a resize re-flows
	// everything) do we reclaim the space — so the tiles move once per row, not on
	// every single departure. `vacated` is the number of leading placeholder cells.
	let vacated = $state(0);
	const vacatedCells = $derived(Array.from({ length: vacated }, (_, i) => i));
	let _prevBoundary = 0;
	let _prevCols = 0;
	let _prevStore: AccordionStore | null = null;
	let _prevProtect = -1;

	// ---- scroll smoothness: while the stage is actively scrolling, suppress
	//      per-tile :hover. Otherwise ~1k tiles sliding under a STATIONARY cursor
	//      each fire :hover in/out → a repaint per tile per frame (a repaint storm
	//      that has nothing to do with the user actually hovering). We flip the
	//      grid to pointer-events:none during scroll, then restore ~140ms after it
	//      settles — so scrolling is pure layer compositing, no paint.
	let scrolling = $state(false);
	let scrollTimer: ReturnType<typeof setTimeout> | undefined;
	function onScroll() {
		if (!scrolling) scrolling = true;
		clearTimeout(scrollTimer);
		scrollTimer = setTimeout(() => (scrolling = false), 140);
	}
	onDestroy(() => clearTimeout(scrollTimer));

	function fit() {
		if (!stage || zoom !== "grid") return;
		// reserve room for the two boxes' chrome (borders, padding, gap)
		const CHROME_H = 84;
		const CHROME_W = 56; // box inner padding + the left token rail
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

	// Track the protected boundary so a departing block leaves a hole instead of
	// reflowing the grid. Reclaim space only when a full leading row is empty, or
	// when a resize (cols change) re-flows everything anyway. A session swap or a
	// protect-slider drag also moves the boundary but is a clean re-flow, not a
	// flurry of departures — forceReset drops the holes in those cases.
	$effect(() => {
		const st = store;
		const boundary = store.protectedFromIndex;
		const protect = store.protectTokens;
		const c = cols;
		untrack(() => {
			const forceReset = st !== _prevStore || protect !== _prevProtect;
			vacated = nextVacated(vacated, _prevBoundary, boundary, _prevCols, c, forceReset);
			_prevStore = st;
			_prevProtect = protect;
			_prevCols = c;
			_prevBoundary = boundary;
		});
	});

	const k = (n: number) => { n = Math.round(n); return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`; };
	function tip(b: Block, prot = false): string {
		const tool = b.toolName ? ` ${b.toolName}` : "";
		const f = store.isFolded(b) ? ` · folded ${b.tokens}→${store.effTokens(b)}` : "";
		const action = prot ? "click to inspect · protected — never folds" : "click to inspect · double-click to fold";
		return `${b.kind}${tool} · ${b.tokens.toLocaleString()} tok${f}\n${action}`;
	}
	function groupTip(g: Group): string {
		const members = store.groupMembers(g);
		const full = store.groupFullTokens(g);
		const saved = store.groupSavedTokens(g);
		const strag = store.groupStragglerCount(g);
		const turns = members.length > 0
			? `turns ${members[0].turn}–${members[members.length - 1].turn}`
			: "";
		const savedStr = saved > 0 ? ` · saves ${k(saved)} tok` : "";
		const stragStr = strag > 0 ? ` · ${strag} kept live` : "";
		return `group · ${members.length} blocks · ${k(full)} tok full${savedStr}${stragStr}\n${turns}\ndouble-click to unfold · click for preview`;
	}

	// ---- range selection state (local — for creating groups) ----------------
	let rangeAnchorId = $state<string | null>(null);
	let rangeEndId = $state<string | null>(null);

	// The set of block ids currently in the pending range (by block order).
	const rangeSet = $derived.by<Set<string>>(() => {
		if (!rangeAnchorId || !rangeEndId) return new Set();
		const anchorIdx = store.blocks.findIndex((b) => b.id === rangeAnchorId);
		const endIdx = store.blocks.findIndex((b) => b.id === rangeEndId);
		if (anchorIdx === -1 || endIdx === -1) return new Set();
		const lo = Math.min(anchorIdx, endIdx);
		const hi = Math.max(anchorIdx, endIdx);
		const s = new Set<string>();
		for (let i = lo; i <= hi; i++) s.add(store.blocks[i].id);
		return s;
	});
	const rangeCount = $derived(rangeSet.size);

	// Brief inline hint when a Group attempt is rejected (overlap / protected tail / <2).
	let groupErr = $state(false);
	function clearRange() {
		rangeAnchorId = null;
		rangeEndId = null;
		groupErr = false;
	}
	function handleCreateGroup() {
		if (!rangeAnchorId || !rangeEndId) return;
		const g = store.createGroup(rangeAnchorId, rangeEndId);
		// Only clear on success; on failure keep the selection and say why (no silent drop).
		if (g) clearRange();
		else groupErr = true;
	}

	// ---- selected group (for the fan-out overlay) ---------------------------
	let selectedGroupId = $state<string | null>(null);
	// Position of the overlay card, relative to .map, in px.
	let overlayX = $state(0);
	let overlayY = $state(0);

	function openGroupOverlay(gid: string, tileEl: HTMLElement) {
		selectedGroupId = gid;
		if (!mapEl) return;
		const mapRect = mapEl.getBoundingClientRect();
		const tileRect = tileEl.getBoundingClientRect();
		// Position below the tile; clamp so the card stays inside .map (card ~220px wide, ~180px tall).
		const CARD_W = 224;
		const CARD_H = 180;
		let x = tileRect.left - mapRect.left;
		let y = tileRect.bottom - mapRect.top + 6;
		if (x + CARD_W > mapRect.width - 8) x = mapRect.width - CARD_W - 8;
		if (x < 8) x = 8;
		if (y + CARD_H > mapRect.height - 8) y = tileRect.top - mapRect.top - CARD_H - 6;
		if (y < 8) y = 8;
		overlayX = x;
		overlayY = y;
	}
	function closeOverlay() {
		selectedGroupId = null;
	}
	const overlayGroup = $derived(selectedGroupId ? store.groupById(selectedGroupId) : undefined);
	const overlayMembers = $derived(overlayGroup ? store.groupMembers(overlayGroup) : []);

	// A pending range-select / open overlay is bound to the CURRENT session and the grid
	// view. When the session prop swaps, stale ids must never survive into createGroup
	// (another session may reuse an id); when we leave the grid the toolbar/overlay are gone
	// anyway. Clear on either change.
	$effect(() => {
		void store;
		untrack(() => {
			clearRange();
			closeOverlay();
		});
	});
	$effect(() => {
		if (zoom !== "grid")
			untrack(() => {
				clearRange();
				closeOverlay();
			});
	});

	function findId(e: Event): string | null {
		const el = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
		return el?.dataset.id ?? null;
	}
	function findGroupId(e: Event): string | null {
		const el = (e.target as HTMLElement).closest<HTMLElement>("[data-group]");
		return el?.dataset.group ?? null;
	}

	function onClick(e: MouseEvent) {
		// Overlay close: clicking outside the overlay (but inside .map) closes it.
		if (selectedGroupId) {
			const overlay = (e.target as HTMLElement).closest<HTMLElement>(".group-overlay");
			if (!overlay) closeOverlay();
		}

		const gid = findGroupId(e);
		if (gid) {
			// During an active range-select, a group tile is not a valid range target (groups
			// can't nest or overlap), so shift-clicking one must NOT hijack the gesture by
			// opening the overlay — ignore it and let the user pick a plain block to close the
			// range.
			if (e.shiftKey && rangeAnchorId) return;
			// A FOLDED group tile → open the fan-out overlay. An OPEN group's dull parent has
			// its own band controls (Re-fold / Delete), so a single click there is a no-op.
			const grp = store.groupById(gid);
			const tileEl = (e.target as HTMLElement).closest<HTMLElement>("[data-group]");
			if (grp?.folded && tileEl) openGroupOverlay(gid, tileEl);
			return;
		}

		const id = findId(e);
		if (!id) return;

		if (e.shiftKey && rangeAnchorId) {
			// Shift-click: extend the range to this block.
			rangeEndId = id;
			groupErr = false;
			return;
		}

		// Plain click on a block tile: inspect + set anchor.
		onselect(id);
		rangeAnchorId = id;
		rangeEndId = null;
		groupErr = false;
	}

	function onDbl(e: MouseEvent) {
		const gid = findGroupId(e);
		if (gid) {
			store.toggleGroup(gid);
			closeOverlay();
			return;
		}
		const id = findId(e);
		if (id) store.toggle(id);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			if (selectedGroupId) { closeOverlay(); return; }
			if (rangeAnchorId) { clearRange(); return; }
		}
		onKey(e);
	}

	// ---- arrow-key traversal between neighboring blocks -------------------
	// Focusable STOPS in display order: a FOLDED group is ONE stop (its first member), so an
	// arrow press crosses a collapsed range in a single step instead of one blind press per
	// hidden member (the members have no tile to scroll to). Mirrors the grid display-list.
	// Only the GRID collapses a folded group to one tile; Turns/Chains still render every
	// member as its own ribbon tile, so the group-skip applies in grid view only.
	const foldedGroupOf = (b: Block): Group | undefined => {
		if (zoom !== "grid") return undefined;
		const g = store.groupOf(b);
		return g?.folded ? g : undefined;
	};
	const navOrder = $derived.by<number[]>(() => {
		const blocks = store.blocks;
		const out: number[] = [];
		for (let i = 0; i < blocks.length; i++) {
			const g = foldedGroupOf(blocks[i]);
			if (g && blocks[i].id !== g.memberIds[0]) continue; // hidden member — not a stop
			out.push(i);
		}
		return out;
	});
	function focusStop(blockIdx: number) {
		const b = store.blocks[blockIdx];
		if (!b) return;
		const g = foldedGroupOf(b);
		if (g) {
			// Select the group's first member (Inspector context) and scroll its parent tile —
			// the folded-group tile carries data-group, not data-id.
			if (g.memberIds[0] !== selectedId) onselect(g.memberIds[0]);
			const esc = g.id.replace(/"/g, '\\"');
			stage?.querySelector<HTMLElement>(`[data-group="${esc}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
			return;
		}
		if (b.id !== selectedId) onselect(b.id);
		const esc = b.id.replace(/"/g, '\\"');
		stage?.querySelector<HTMLElement>(`[data-id="${esc}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}
	function onKey(e: KeyboardEvent) {
		const key = e.key;
		if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "ArrowUp" && key !== "ArrowDown") return;
		e.preventDefault();
		const order = navOrder;
		if (!order.length) return;
		// Map the current selection to a position in `order`. A selection sitting on a hidden
		// group member maps to its group's stop (the first member).
		let pos = -1;
		if (selectedId) {
			const sel = store.blocks.findIndex((b) => b.id === selectedId);
			if (sel !== -1) {
				const g = foldedGroupOf(store.blocks[sel]);
				const repId = g ? g.memberIds[0] : selectedId;
				pos = order.findIndex((i) => store.blocks[i].id === repId);
			}
		}
		if (pos === -1) {
			// nothing selected yet — enter from the matching edge
			focusStop(order[key === "ArrowLeft" || key === "ArrowUp" ? order.length - 1 : 0]);
			return;
		}
		const step = zoom === "grid" ? cols : 1; // ↑/↓ jump a full row (in tile/stop space)
		let p = pos;
		if (key === "ArrowRight") p = pos + 1;
		else if (key === "ArrowLeft") p = pos - 1;
		else if (key === "ArrowDown") p = pos + step;
		else p = pos - step;
		p = Math.max(0, Math.min(order.length - 1, p));
		if (p !== pos) focusStop(order[p]);
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="map" bind:this={mapEl}>
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
			{#if rangeCount >= 2}
				<span class="range-bar">
					<button class="group-btn" onclick={handleCreateGroup}>Group {rangeCount} blocks</button>
					{#if groupErr}<span class="range-err">can’t group — overlaps a group or the protected tail</span>{/if}
					<button class="range-clear" onclick={clearRange} title="Clear selection">✕</button>
				</span>
			{:else if rangeAnchorId}
				<span class="range-hint dim">shift-click another block to complete range</span>
			{/if}
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
		class:scrolling
		bind:this={stage}
		role="toolbar"
		tabindex="0"
		aria-label="Context map — arrow keys move between blocks"
		onclick={onClick}
		ondblclick={onDbl}
		onkeydown={onKeydown}
		onscroll={onScroll}
	>
		{#if zoom === "grid"}
			{#snippet ghostTile(g: Ghost)}
				<div
					class="cell ghost k-{g.kind}"
					title="{g.kind} · forming…"
				></div>
			{/snippet}
			{#snippet tile(t: { b: Block; face: number }, prot: boolean)}
				<div
					class="cell face f{t.face} k-{t.b.kind}"
					class:folded={store.isFolded(t.b)}
					class:pinned={t.b.override === "pinned"}
					class:sel={t.b.id === selectedId}
					class:inrange={rangeSet.has(t.b.id)}
					data-id={t.b.id}
					title={tip(t.b, prot)}
				></div>
			{/snippet}
			<div class="boxes" style:--cell="{cell}px" style:--cols={cols}>
				{#if olderTiles.length}
					<section class="box older">
						<div class="rail" title="{olderTok.toLocaleString()} live tokens · foldable">
							<span class="tok"><AnimatedNumber value={olderTok} format={k} /></span>
						</div>
						<div class="grid">
							{#each displayRows as row (row.type === "block" ? row.block.id : row.group.id)}
								{#if row.type === "block"}
									{@const t = { b: row.block, face: faceFor(row.block.tokens) }}
									{@render tile(t, false)}
								{:else if row.type === "group"}
									{@const g = row.group}
									{@const gface = faceFor(store.groupLiveTokens(g))}
									<div
										class="cell face f{gface} group-tile"
										class:sel={selectedGroupId === g.id || (selectedId !== null && g.memberIds.includes(selectedId))}
										data-group={g.id}
										title={groupTip(g)}
									></div>
								{:else}
									{@const g = row.group}
									<!-- open group: a full-width band that interrupts the grid -->
									<div class="group-band" style:grid-column="1 / -1">
										<div
											class="cell face f{faceFor(store.groupLiveTokens(g))} group-tile group-tile-open"
											data-group={g.id}
											title="group (open) · {row.members.length} blocks · double-click to fold"
										></div>
										<div class="band-members">
											{#each row.members as mb (mb.id)}
												{@const mt = { b: mb, face: faceFor(mb.tokens) }}
												{@render tile(mt, false)}
											{/each}
										</div>
										<div class="band-actions">
											<button class="band-btn" onclick={(e) => { e.stopPropagation(); store.foldGroup(g.id); }}>Re-fold</button>
											<button class="band-btn danger" onclick={(e) => { e.stopPropagation(); store.deleteGroup(g.id); }}>Delete</button>
										</div>
									</div>
								{/if}
							{/each}
						</div>
					</section>
				{/if}
				<section class="box prot">
					<div class="rail" title="{protTok.toLocaleString()} tokens · protected working tail">
						<span class="tok"><AnimatedNumber value={protTok} format={k} /></span>
					</div>
					<div class="grid">
						{#each vacatedCells as i (i)}<div class="cell vacated"></div>{/each}
						{#each protectedTiles as t (t.b.id)}{@render tile(t, true)}{/each}
						{#each ghosts as g (g.contentIndex)}
							{@render ghostTile(g)}
						{/each}
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

	<!-- Fan-out overlay for a selected folded group. Absolutely positioned inside .map
	     so it does NOT reflow the grid. Compositor-only enter: opacity+transform only. -->
	{#if overlayGroup && overlayGroup.folded}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			class="group-overlay"
			style:left="{overlayX}px"
			style:top="{overlayY}px"
			role="dialog"
			aria-label="Group preview"
		>
			<div class="overlay-members">
				{#each overlayMembers as mb (mb.id)}
					<div class="mini-tile k-{mb.kind}" title="{mb.kind} · {mb.tokens} tok"></div>
				{/each}
			</div>
			<p class="overlay-summary">{store.groupSummary(overlayGroup)}</p>
			<div class="overlay-actions">
				<button onclick={() => { store.unfoldGroup(overlayGroup!.id); closeOverlay(); }}>Unfold</button>
				<button class="danger" onclick={() => { store.deleteGroup(overlayGroup!.id); closeOverlay(); }}>Delete</button>
				<button class="close-btn" onclick={closeOverlay}>✕</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.map {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--bg);
		position: relative; /* anchor for the fan-out overlay */
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
		transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
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
		transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
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

	/* ---- range selection toolbar affordances ---- */
	.range-bar {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.group-btn {
		background: var(--accent);
		color: #fff;
		border: none;
		border-radius: 6px;
		font-size: 11px;
		font-weight: 600;
		padding: 4px 10px;
		cursor: pointer;
	}
	.group-btn:hover {
		opacity: 0.85;
	}
	.range-clear {
		background: transparent;
		border: 1px solid var(--line);
		color: var(--muted);
		border-radius: 5px;
		font-size: 10px;
		padding: 3px 7px;
		cursor: pointer;
	}
	.range-clear:hover {
		color: var(--text);
		background: var(--panel-3);
	}
	.range-hint {
		font-size: 10px;
	}
	.range-err {
		font-size: 10px;
		color: var(--danger, #f87171);
		white-space: nowrap;
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
		/* promote the scroll content to its own GPU layer: once painted, scrolling
		   is a cheap layer translation rather than a repaint of the tiles. */
		transform: translateZ(0);
	}
	.box {
		border-radius: 14px;
		border: 1.5px solid var(--line);
		background: var(--panel-2);
		padding: 12px;
		display: flex;
		align-items: stretch;
		gap: 8px;
	}
	/* left rail: a small vertical token tally for the group */
	.rail {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		writing-mode: vertical-rl;
		transform: rotate(180deg);
		font-variant-numeric: tabular-nums;
		font-size: 11px;
		letter-spacing: 0.04em;
		color: var(--faint);
		user-select: none;
	}
	.rail .tok {
		font-weight: 700;
	}
	.box.prot .rail {
		color: color-mix(in srgb, var(--accent) 70%, var(--muted));
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
		flex: 1;
		min-width: 0;
	}
	/* while scrolling, make tiles transparent to the pointer so a stationary cursor
	   doesn't trigger :hover on every tile that slides past it (repaint storm). */
	.stage.scrolling .grid {
		pointer-events: none;
	}
	.cell {
		box-sizing: border-box;
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
	/* vacated slot: a block left the protected tail but we hold its place (no reflow)
	   until the whole leading row empties. Reads as an empty outline, not a tile. */
	.cell.vacated {
		background: transparent;
		border: 1px dashed color-mix(in srgb, var(--accent) 30%, transparent);
		box-shadow: none;
		cursor: default;
		pointer-events: none;
	}
	.cell.vacated:hover {
		filter: none;
		box-shadow: none;
	}

	/* pending range selection highlight — compositor-only outline, no filter */
	.cell.inrange {
		box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent) 80%, transparent),
		            inset 0 0 0 3px rgba(0, 0, 0, 0.35);
	}
	.cell.inrange:hover {
		filter: brightness(1.22);
	}

	@keyframes pop {
		0%   { transform: scale(1); }
		45%  { transform: scale(1.08); }
		100% { transform: scale(1); }
	}
	.cell.sel {
		/* inset-only so paint-containment (content-visibility) never clips it */
		box-shadow: inset 0 0 0 2px var(--accent), inset 0 0 0 3px rgba(0, 0, 0, 0.55);
		filter: brightness(1.18);
		z-index: 3;
		animation: pop var(--dur-fast) var(--ease-spring);
	}

	/* ---- group tile: the single "folder" tile representing a folded group ---- */
	.group-tile {
		/* Distinct folder/stack aesthetic: background is the accent channel so it's
		   clearly not a block. A few box-shadows are fine (few group tiles, not 982). */
		background: color-mix(in srgb, var(--accent) 40%, var(--panel-3));
		box-shadow:
			inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 60%, transparent),
			2px 2px 0 1px color-mix(in srgb, var(--accent) 30%, transparent),
			3px 3px 0 2px color-mix(in srgb, var(--accent) 15%, transparent);
		cursor: pointer;
		border-radius: 4px;
	}
	.group-tile:hover {
		filter: brightness(1.18);
	}
	.group-tile.sel {
		box-shadow:
			inset 0 0 0 2px var(--accent),
			inset 0 0 0 3px rgba(0, 0, 0, 0.55),
			2px 2px 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
		filter: brightness(1.18);
		z-index: 3;
		animation: pop var(--dur-fast) var(--ease-spring);
	}

	/* dull parent tile inside an open group band */
	.group-tile-open {
		opacity: 0.45;
		filter: saturate(0.5);
		cursor: pointer;
	}
	.group-tile-open:hover {
		opacity: 0.7;
		filter: saturate(0.8) brightness(1.12);
	}

	/* ---- open group band: a full-width tinted strip interrupting the grid ---- */
	.group-band {
		grid-column: 1 / -1;
		background: color-mix(in srgb, var(--accent) 8%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
		border-radius: 6px;
		padding: 6px 8px;
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.band-members {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		flex: 1;
		min-width: 0;
	}
	/* Member tiles inside an open band use the same .cell + kind classes — they
	   inherit all the existing tile styles. The band gives them a uniform small size
	   via --cell from the parent .boxes. */
	.band-members .cell {
		width: var(--cell);
		height: var(--cell);
		flex: 0 0 auto;
	}
	.band-actions {
		display: flex;
		gap: 4px;
		flex: 0 0 auto;
	}
	.band-btn {
		background: var(--panel-3);
		border: 1px solid var(--line);
		color: var(--muted);
		font-size: 10px;
		border-radius: 5px;
		padding: 3px 8px;
		cursor: pointer;
		white-space: nowrap;
	}
	.band-btn:hover {
		color: var(--text);
		background: var(--panel);
	}
	.band-btn.danger:hover {
		color: #f87171;
		border-color: #f87171;
	}

	/* ---- ghost tiles: third visual state — "forming" ----
	   A ghost is a presentation-only pulsing placeholder. It is NOT a block, NOT
	   selectable, and NOT foldable. It uses the same kind color as a real tile but
	   in a clearly distinct state: reduced opacity pulsing via a compositor-only
	   opacity animation (transform/opacity only — no filter/box-shadow/gradients,
	   per CLAUDE.md perf rules). There are at most a few ghosts at a time so one
	   cheap keyframe each is fine.                                                  */
	.cell.ghost {
		cursor: default;
		/* Compositor-only animation: opacity pulse — no filter, no box-shadow. */
		animation: ghost-pulse 1.4s ease-in-out infinite;
		/* Dashed inset ring marks it visually as "not yet real." */
		box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.35);
		/* pointer-events: none so it never hijacks clicks/hovers on real tiles */
		pointer-events: none;
	}
	.cell.ghost:hover {
		/* Override the inherited :hover brightness — ghosts are not interactive. */
		filter: none;
		box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.35);
	}
	@keyframes ghost-pulse {
		0%, 100% { opacity: 0.55; transform: scale(1); }
		50%       { opacity: 0.85; transform: scale(0.93); }
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

	/* ---- fan-out overlay: absolutely positioned in .map (no reflow) ---- */
	.group-overlay {
		position: absolute;
		z-index: 40;
		background: var(--panel-3);
		border: 1px solid color-mix(in srgb, var(--accent) 50%, var(--line));
		border-radius: 10px;
		padding: 10px 12px;
		width: 224px;
		box-shadow:
			0 4px 16px rgba(0, 0, 0, 0.35),
			0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent);
		/* Compositor-only enter: opacity + translate, no filter/gradient animation */
		animation: overlay-in 140ms var(--ease-out, ease-out) both;
		pointer-events: all;
	}
	@keyframes overlay-in {
		from { opacity: 0; transform: translateY(-6px) scale(0.97); }
		to   { opacity: 1; transform: translateY(0)   scale(1);    }
	}
	.overlay-members {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-bottom: 8px;
	}
	.mini-tile {
		width: 14px;
		height: 14px;
		border-radius: 2px;
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25);
		flex: 0 0 auto;
	}
	.mini-tile.k-user { background: var(--k-user); }
	.mini-tile.k-text { background: var(--k-text); }
	.mini-tile.k-thinking { background: var(--k-thinking); }
	.mini-tile.k-tool_call { background: var(--k-tool_call); }
	.mini-tile.k-tool_result { background: var(--k-tool_result); }
	.overlay-summary {
		font-size: 10px;
		color: var(--muted);
		line-height: 1.4;
		margin: 0 0 10px;
		max-height: 72px;
		overflow: hidden;
		text-overflow: ellipsis;
		display: -webkit-box;
		-webkit-line-clamp: 4;
		line-clamp: 4;
		-webkit-box-orient: vertical;
	}
	.overlay-actions {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.overlay-actions button {
		background: var(--panel);
		border: 1px solid var(--line);
		color: var(--muted);
		font-size: 11px;
		border-radius: 6px;
		padding: 4px 10px;
		cursor: pointer;
		flex: 1;
	}
	.overlay-actions button:hover {
		color: var(--text);
		background: var(--panel-3);
	}
	.overlay-actions button.danger:hover {
		color: #f87171;
		border-color: #f87171;
	}
	.overlay-actions .close-btn {
		flex: 0 0 auto;
		padding: 4px 8px;
		font-size: 10px;
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
		transition: filter var(--dur-fast) var(--ease-out);
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
