<script lang="ts">
	import { untrack, onDestroy } from "svelte";
	import type { AccordionStore } from "../../engine/store.svelte";
	import type { Block, Group } from "../../engine/types";
	import { ghosts, type Ghost } from "../../live/ghostState.svelte";
	import { nextVacated } from "./drain";
	import AnimatedNumber from "$lib/ui/AnimatedNumber.svelte";
	import { buildDisplay, segmentDisplay, type DisplayRow } from "$lib/engine/display";
	import { chainsOf } from "./chains";

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

	// ---- PEEK: pure UI-local "open for viewing" state (the redesign). -------------
	// A group id in `peeked` renders its members OPEN-but-DULL while the group stays
	// `folded` → the wire is byte-for-byte unchanged (computeGroupOps still emits the
	// group's op). CARDINAL INVARIANT: entering/leaving peek NEVER calls a store group
	// mutator and NEVER touches `group.folded`. Only the explicit "Unfold to context"
	// button changes the wire. Mutated immutably (reassign a new Set) so `displayRows`
	// re-derives.
	let peeked = $state(new Set<string>());
	function enterPeek(gid: string) {
		const next = new Set(peeked);
		next.add(gid);
		peeked = next;
	}
	function leavePeek(gid: string) {
		if (!peeked.has(gid)) return;
		const next = new Set(peeked);
		next.delete(gid);
		peeked = next;
	}
	function togglePeek(gid: string) {
		peeked.has(gid) ? leavePeek(gid) : enterPeek(gid);
	}

	// ---- display list for the older box: groups + plain blocks via buildDisplay ----
	const olderBlocks = $derived(store.blocks.slice(0, protectedFrom));
	const displayRows = $derived(buildDisplay(olderBlocks, store.groups, peeked));
	// An OPEN group breaks the dense grid into stacked segments (grid · band · grid · …) so its
	// multi-line band gets natural height instead of overflowing one fixed-height grid track.
	const segments = $derived(segmentDisplay(displayRows));

	let stage = $state<HTMLDivElement>();
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
		return `group · ${members.length} blocks · ${k(full)} tok full${savedStr}${stragStr}\n${turns}\nclick to peek · double-click to collapse`;
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
		// Never highlight into the protected tail — a group can't reach it, so a range that
		// visually spans both boxes would mislead the user into a guaranteed-to-fail "Group".
		const hi = Math.min(Math.max(anchorIdx, endIdx), store.protectedFromIndex - 1);
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

	// A pending range-select / peek set is bound to the CURRENT session and the grid view.
	// When the session prop swaps, stale ids must never survive into createGroup (another
	// session may reuse an id) and a stale peek id must not leak across sessions; when we
	// leave the grid the toolbar/open rows are gone anyway. Clear on either change.
	$effect(() => {
		void store;
		untrack(() => {
			clearRange();
			peeked = new Set();
		});
	});
	$effect(() => {
		if (zoom !== "grid")
			untrack(() => {
				clearRange();
				peeked = new Set();
			});
	});

	// ---- hit-testing helpers --------------------------------------------------
	// A member tile (data-id) nested inside a group band (data-group) must take
	// precedence over the enclosing band so clicks on members 2..N are reachable.
	// The parent group tile itself has data-group but NO data-id (it renders with
	// only `data-group={g.id}`), so it still routes to the group handler.
	//
	// Resolution: find both candidates from the click target, then apply:
	//   • data-id found AND (no data-group, OR data-group contains the data-id el)
	//     → it's a block click (the data-id is the more specific / deeper element).
	//   • Otherwise, data-group found → it's a group click.
	//
	// Returns { kind: "block", id } | { kind: "group", gid } | { kind: "none" }.
	type HitResult =
		| { kind: "block"; id: string }
		| { kind: "group"; gid: string }
		| { kind: "none" };
	function resolveHit(e: MouseEvent): HitResult {
		const t = e.target as HTMLElement;
		const idEl = t.closest<HTMLElement>("[data-id]");
		const groupEl = t.closest<HTMLElement>("[data-group]");
		// A block click: a data-id element exists and is either outside any group
		// container, or is INSIDE one (groupEl.contains(idEl) — the data-id is the
		// more-specific descendant). The open band carries data-group, so a member
		// tile's data-id sits inside it; the contains() check is what lets the member
		// win over the band. A click on the band background (no data-id) falls through
		// to the group below → toggle peek / collapse, never a dead no-op.
		const isBlockClick = !!idEl && (!groupEl || groupEl.contains(idEl));
		if (isBlockClick && idEl!.dataset.id) return { kind: "block", id: idEl!.dataset.id };
		if (groupEl?.dataset.group) return { kind: "group", gid: groupEl.dataset.group };
		return { kind: "none" };
	}

	// Collapse a group to its resting one-tile state via ANY path: if it is live on the
	// wire (unfolded), re-fold it; and ALWAYS drop it from `peeked` so it can never return
	// to a stale dull-preview row. The ONLY store mutation here is foldGroup (re-fold) —
	// peek itself is never a wire op.
	function collapseGroup(gid: string) {
		const g = store.groupById(gid);
		if (g && !g.folded) store.foldGroup(gid);
		leavePeek(gid);
	}

	function onClick(e: MouseEvent) {
		const hit = resolveHit(e);

		if (hit.kind === "group") {
			const gid = hit.gid;
			// During an active range-select, a group tile is not a valid range target (groups
			// can't nest or overlap), so shift-clicking one must NOT hijack the gesture — ignore
			// it and let the user pick a plain block to close the range.
			if (e.shiftKey && rangeAnchorId) return;
			const grp = store.groupById(gid);
			// Selecting the group gives the Inspector context (its first member) and lights the
			// parent tile's `.sel` highlight (keyed off member inclusion). This is pure selection,
			// NOT a wire mutation.
			// Length guard: createGroup enforces >= 2 members, so an empty group is an invariant
			// violation — but read defensively so a bad state never sets selection to undefined.
			if (grp && grp.memberIds.length > 0 && grp.memberIds[0] !== selectedId) onselect(grp.memberIds[0]);
			// A FOLDED parent tile toggles PEEK (open-for-viewing, wire UNCHANGED). An UNFOLDED
			// group's dull parent already has its own row buttons (Re-fold / Delete), so a plain
			// click there is a no-op — unfolding/refolding is deliberate via those buttons only.
			if (grp?.folded) togglePeek(gid);
			return;
		}

		if (hit.kind !== "block") return;
		const id = hit.id;
		const bl = store.get(id);

		if (e.shiftKey && rangeAnchorId) {
			// Extend the range — but only to a groupable block. A protected-tail block, or one
			// already in a group, can't complete a valid range; hint instead of a phantom span.
			if (!bl || store.isProtected(bl) || store.groupOf(bl)) {
				groupErr = true;
				return;
			}
			rangeEndId = id;
			groupErr = false;
			return;
		}

		// Plain click on a block tile: inspect, and anchor a range only if this block could
		// actually start one (older + ungrouped) — otherwise leave no dangling anchor.
		onselect(id);
		rangeAnchorId = bl && !store.isProtected(bl) && !store.groupOf(bl) ? id : null;
		rangeEndId = null;
		groupErr = false;
	}

	function onDbl(e: MouseEvent) {
		const hit = resolveHit(e);
		if (hit.kind === "group") {
			// Double-click a parent (collapsed / peek / unfolded) → COLLAPSE. Never unfolds —
			// going live is deliberate via the "Unfold to context" button only.
			collapseGroup(hit.gid);
			return;
		}
		if (hit.kind === "block") store.toggle(hit.id);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			if (rangeAnchorId) { clearRange(); return; }
		}
		// Enter commits a pending range (≥2 blocks) into a group — the keyboard twin of the
		// "Group N blocks" button, matching the selection chip's hint.
		if (e.key === "Enter" && rangeCount >= 2) {
			e.preventDefault();
			handleCreateGroup();
			return;
		}
		onKey(e);
	}

	// ---- arrow-key traversal between neighboring blocks -------------------
	// Focusable STOPS in display order: a COLLAPSED group is ONE stop (its first member), so
	// an arrow press crosses the collapsed range in a single step instead of one blind press
	// per hidden member (the members have no tile to scroll to). Mirrors the grid display-list.
	// A PEEKED or UNFOLDED group is OPEN — its members each have their own data-id tile, so it
	// is NOT collapsed to one stop here (the members are individually traversable). Only the
	// GRID collapses; Turns/Chains render every member as its own ribbon tile.
	const collapsedGroupOf = (b: Block): Group | undefined => {
		if (zoom !== "grid") return undefined;
		const g = store.groupOf(b);
		return g?.folded && !peeked.has(g.id) ? g : undefined;
	};
	const navOrder = $derived.by<number[]>(() => {
		const blocks = store.blocks;
		const out: number[] = [];
		for (let i = 0; i < blocks.length; i++) {
			const g = collapsedGroupOf(blocks[i]);
			if (g && blocks[i].id !== g.memberIds[0]) continue; // hidden member — not a stop
			out.push(i);
		}
		return out;
	});
	function focusStop(blockIdx: number) {
		const b = store.blocks[blockIdx];
		if (!b) return;
		const g = collapsedGroupOf(b);
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
				const g = collapsedGroupOf(store.blocks[sel]);
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
			{#if rangeCount >= 2}
				<span class="range-bar" class:err={groupErr}>
					<span class="range-chip">
						<b>{rangeCount}</b> blocks <span class="arrow">→</span> group
						<span class="dim">· Enter to create</span>
					</span>
					<button class="group-btn" onclick={handleCreateGroup}>Group</button>
					{#if groupErr}<span class="range-err">overlaps a group or the protected tail</span>{/if}
					<button class="range-clear" onclick={clearRange} title="Clear selection (Esc)">✕</button>
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
			{#snippet tile(t: { b: Block; face: number }, prot: boolean, forceFold = false)}
				<!-- forceFold: a PEEK member is shown DULL (the `.folded` grammar) regardless of
				     its own state — it's being previewed, not put live. -->
				<div
					class="cell face f{t.face} k-{t.b.kind}"
					class:folded={forceFold || store.isFolded(t.b)}
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
						<div class="stack">
							{#each segments as seg (seg.kind === "band" ? "band-" + seg.row.group.id : "tiles-" + (seg.rows[0].type === "block" ? seg.rows[0].block.id : seg.rows[0].group.id))}
								{#if seg.kind === "tiles"}
									<div class="grid">
										{#each seg.rows as row (row.type === "block" ? row.block.id : row.group.id)}
											{#if row.type === "block"}
												{@const t = { b: row.block, face: faceFor(row.block.tokens) }}
												{@render tile(t, false)}
											{:else}
												{@const g = row.group}
												{@const gface = faceFor(store.groupLiveTokens(g))}
												<!-- COLLAPSED: one folder tile standing in for the range. -->
												<div
													class="cell face f{gface} group-tile"
													class:sel={selectedId !== null && g.memberIds.includes(selectedId)}
													data-group={g.id}
													title={groupTip(g)}
												></div>
											{/if}
										{/each}
									</div>
								{:else}
									{@const g = seg.row.group}
									{@const live = seg.row.live}
									<!-- OPEN GROUP — its own full-width row at natural height (NOT a grid track, so the
									     band can't overflow/overlap the tiles). live=false → PEEK (dull preview, wire
									     unchanged); live=true → UNFOLDED (members live). Accented left edge = one group.
									     data-group on the band itself: clicking the band background/padding resolves to
									     the group (toggle peek / collapse), while a member tile's data-id still wins via
									     groupEl.contains(idEl) in resolveHit — so no region of the band is a dead no-op. -->
									<div class="group-band" class:live data-group={g.id}>
										<div
											class="cell face f{faceFor(store.groupLiveTokens(g))} group-tile group-tile-open"
											class:sel={selectedId !== null && g.memberIds.includes(selectedId)}
											data-group={g.id}
											title="{live ? 'group (unfolded — live)' : 'group (peek — preview only)'} · {seg.row.members.length} blocks · double-click to collapse"
										></div>
										<div class="band-members">
											{#each seg.row.members as mb (mb.id)}
												{@const mt = { b: mb, face: faceFor(mb.tokens) }}
												{@render tile(mt, false, !live)}
											{/each}
										</div>
										<div class="band-actions">
											{#if live}
												<!-- UNFOLDED row: Re-fold returns to a COLLAPSED tile (clears peek); Delete drops the group. -->
												<button class="band-btn" onclick={(e) => { e.stopPropagation(); collapseGroup(g.id); }}>Re-fold</button>
												<button class="band-btn danger" onclick={(e) => { e.stopPropagation(); leavePeek(g.id); store.deleteGroup(g.id); }}>Delete</button>
											{:else}
												<!-- PEEK row: the ONLY wire-changing button is "Unfold to context" (store.unfoldGroup);
												     it also clears the peek entry so re-folding later returns to a clean COLLAPSED tile.
												     "Collapse" is pure UI (leavePeek). Delete drops the group + its stale peek entry. -->
												<button class="band-btn primary" onclick={(e) => { e.stopPropagation(); leavePeek(g.id); store.unfoldGroup(g.id); }}>Unfold to context</button>
												<button class="band-btn" onclick={(e) => { e.stopPropagation(); leavePeek(g.id); }}>Collapse</button>
												<button class="band-btn danger tertiary" onclick={(e) => { e.stopPropagation(); leavePeek(g.id); store.deleteGroup(g.id); }}>Delete</button>
											{/if}
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
</div>

<style>
	.map {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--bg);
		position: relative;
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

	/* ---- range selection toolbar affordances — a warm "building" chip ---- */
	.range-bar {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	/* The counter chip: reads the live selection count and tells the user how to commit.
	   Warm amber border so it reads as forming a NEW object (not hiding one). */
	.range-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		color: var(--text);
		background: color-mix(in srgb, var(--group-accent) 12%, var(--panel));
		border: 1px solid color-mix(in srgb, var(--group-accent) 55%, transparent);
		border-radius: 6px;
		padding: 3px 9px;
		white-space: nowrap;
	}
	.range-chip b {
		font-variant-numeric: tabular-nums;
		color: var(--group-accent);
		font-weight: 800;
	}
	.range-chip .arrow {
		color: var(--group-accent);
		font-weight: 700;
	}
	.range-bar.err .range-chip {
		border-color: color-mix(in srgb, var(--danger) 60%, transparent);
	}
	.group-btn {
		background: var(--group-accent);
		color: #1a0f06;
		border: none;
		border-radius: 6px;
		font-size: 11px;
		font-weight: 700;
		padding: 4px 12px;
		cursor: pointer;
	}
	.group-btn:hover {
		filter: brightness(1.08);
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

	/* ---- the older box's content: a vertical stack of tile-grids and open-group bands
	   (paragraph-like). Splitting at each open group keeps every grid uniform and lets bands
	   size to their content. The protected box has no groups, so it uses a bare .grid. ---- */
	.stack {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
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
	/* Inside the stack each grid is natural height (a column child must not grow vertically). */
	.stack .grid {
		flex: 0 0 auto;
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

	/* pending range selection highlight — a warm "building" treatment so the range reads
	   as forming a NEW object, not hiding one. Bold amber inset ring + a dark inset for
	   contrast; the faint warm fill is an inset box-shadow (no per-tile gradient/filter). */
	.cell.inrange {
		box-shadow: inset 0 0 0 2px var(--group-accent),
		            inset 0 0 0 3px rgba(0, 0, 0, 0.4),
		            inset 0 0 0 100px color-mix(in srgb, var(--group-accent) 30%, transparent);
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
		/* inset-only: an outset ring would clip against neighbouring tiles in the dense grid */
		box-shadow: inset 0 0 0 2px var(--accent), inset 0 0 0 3px rgba(0, 0, 0, 0.55);
		filter: brightness(1.18);
		z-index: 3;
		animation: pop var(--dur-fast) var(--ease-spring);
	}

	/* ---- group tile: the single "folder" tile representing a folded group ---- */
	.group-tile {
		/* Warm dark-brown body so a group reads as a different KIND of object — not a block
		   kind, not the accent-blue. The folder/stack hint is INSET ONLY (CLAUDE.md: outset
		   box-shadows clip): a lighter inset top-left highlight + a darker inset bottom-right
		   edge fakes a raised, stacked sheet. The dice pips (.face::before) sit on top. */
		background: var(--group);
		box-shadow:
			inset 0 0 0 1px var(--group-edge),
			inset 2px 2px 0 -1px color-mix(in srgb, #fff 16%, transparent),
			inset -3px -3px 4px -2px rgba(0, 0, 0, 0.5);
		cursor: pointer;
		border-radius: 4px;
	}
	.group-tile:hover {
		filter: brightness(1.16);
	}
	.group-tile.sel {
		box-shadow:
			inset 0 0 0 2px var(--group-accent),
			inset 0 0 0 3px rgba(0, 0, 0, 0.55),
			inset -3px -3px 4px -2px rgba(0, 0, 0, 0.5);
		filter: brightness(1.14);
		z-index: 3;
		animation: pop var(--dur-fast) var(--ease-spring);
	}

	/* dull parent tile inside an open row (peek or unfolded) — recessed; one element per
	   group, so a single `filter` here is acceptable (not the 982-grid). */
	.group-tile-open {
		/* In the flex band (no longer a grid cell) the tile has no intrinsic size — pin it. */
		width: var(--cell);
		height: var(--cell);
		flex: 0 0 auto;
		opacity: 0.5;
		filter: saturate(0.5);
		cursor: pointer;
	}
	.group-tile-open:hover {
		opacity: 0.75;
		filter: saturate(0.8) brightness(1.1);
	}
	.group-tile-open.sel {
		opacity: 0.9;
		box-shadow:
			inset 0 0 0 2px var(--group-accent),
			inset 0 0 0 3px rgba(0, 0, 0, 0.55);
	}

	/* ---- open group row: its own full-width band between tile grids (a flex child of .stack,
	   NOT a grid item) so it takes natural height and can never overflow a fixed cell-height
	   track and overlap the tiles below. The accented LEFT edge signals "this whole row is one
	   group." Opening/closing only inserts/removes this band — the tile grids stay uniform. ---- */
	.group-band {
		width: 100%;
		box-sizing: border-box;
		background: var(--group-band);
		border: 1px solid color-mix(in srgb, var(--group-accent) 26%, transparent);
		border-left: 3px solid color-mix(in srgb, var(--group-accent) 60%, transparent);
		border-radius: 6px;
		padding: 6px 8px 6px 9px;
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	/* UNFOLDED (live): a stronger warm edge — the members are really in the model's context. */
	.group-band.live {
		background: color-mix(in srgb, var(--group-accent) 11%, transparent);
		border-left-color: var(--group-accent);
	}
	.band-members {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		flex: 1;
		min-width: 0;
	}
	/* Member tiles inside an open row use the same .cell + kind classes — they inherit all
	   the existing tile styles. The row gives them a uniform small size via --cell. */
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
	/* "Unfold to context" — the primary, warm/amber action (the only one that changes the
	   wire). Filled so it clearly outranks Collapse/Delete. */
	.band-btn.primary {
		background: var(--group-accent);
		border-color: color-mix(in srgb, var(--group-accent) 70%, #000);
		color: #1a0f06;
		font-weight: 700;
	}
	.band-btn.primary:hover {
		background: var(--group-accent);
		filter: brightness(1.08);
		color: #1a0f06;
	}
	/* Delete is tertiary in the peek row — quieter until hovered. */
	.band-btn.tertiary {
		opacity: 0.7;
	}
	.band-btn.tertiary:hover {
		opacity: 1;
	}
	.band-btn.danger:hover {
		color: #f87171;
		border-color: #f87171;
		background: var(--panel-3);
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
