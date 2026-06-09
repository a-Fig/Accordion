<script lang="ts">
	import { untrack, onDestroy } from "svelte";
	import type { AccordionStore } from "../../engine/store.svelte";
	import type { Block, Group } from "../../engine/types";
	import { ghosts, type Ghost } from "../../live/ghostState.svelte";
	import { nextVacated } from "./drain";
	import AnimatedNumber from "$lib/ui/AnimatedNumber.svelte";
	import { buildDisplay, segmentDisplay, type DisplayRow } from "$lib/engine/display";
	import Icon from "$lib/ui/Icon.svelte";
	import SegControl from "$lib/ui/SegControl.svelte";

	let {
		store,
		selectedId,
		onselect,
	}: { store: AccordionStore; selectedId: string | null; onselect: (id: string) => void } = $props();

	// Two lenses on the same context:
	//  • map        — the abstraction: shape, weight, fold state at a glance (the grid).
	//  • transcript — the concretion: the actual text, readable top-to-bottom. Folded
	//                 blocks show their digest (the exact {#code FOLDED} string the agent
	//                 sees); live blocks show full text. Fold/unfold inline.
	let view = $state<"map" | "transcript">("map");
	// Human-readable role label for a transcript message header.
	const ROLE: Record<Block["kind"], string> = {
		user: "You",
		text: "Assistant",
		thinking: "Thinking",
		tool_call: "Tool call",
		tool_result: "Tool result",
	};

	// ---- weight as dice faces: every tile is the same square; token weight is
	//      read as a die face 1–6 (more pips = heavier block). -----------------
	// Upper-bound labels — a face N tile holds blocks UP TO the listed token count
	// (face 6 is the open-ended top tier). These mirror faceFor()'s cut-offs exactly.
	const FACES = [
		{ f: 1, lbl: "up to 100 tok" },
		{ f: 2, lbl: "up to 500 tok" },
		{ f: 3, lbl: "up to 1.5k tok" },
		{ f: 4, lbl: "up to 5k tok" },
		{ f: 5, lbl: "up to 15k tok" },
		{ f: 6, lbl: "past 15k tok" },
	] as const;
	function faceFor(tok: number): number {
		return tok > 15000 ? 6 : tok > 5000 ? 5 : tok > 1500 ? 4 : tok > 500 ? 3 : tok > 100 ? 2 : 1;
	}
	// Legend hover: reveal a face's token range the instant the cursor crosses a die
	// (pointerenter per die — no native-title delay), so values surface even mid-move.
	let hoveredFace = $state<number | null>(null);
	const hotFace = $derived(hoveredFace !== null ? FACES[hoveredFace] : null);


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

	// ---- single- vs double-click disambiguation -------------------------------
	// A plain click INSPECTS (opens the panel); a double-click FOLDS. The browser
	// fires two `click`s before `dblclick`, so we DEFER the inspect action and cancel it
	// if a second click arrives — otherwise double-clicking to fold would flash the side
	// panel open first. The 2nd click (`e.detail >= 2`) cancels the pending inspect the
	// instant it lands, so a fold never flashes regardless of the timer; the timer is just
	// the fallback that COMMITS a genuine single click. Range-select (shift) is immediate.
	const DBL_GUARD = 250;
	let clickTimer: ReturnType<typeof setTimeout> | undefined;
	function clearPendingClick() {
		if (clickTimer) {
			clearTimeout(clickTimer);
			clickTimer = undefined;
		}
	}
	function deferClick(fn: () => void) {
		clearPendingClick();
		clickTimer = setTimeout(() => {
			clickTimer = undefined;
			fn();
		}, DBL_GUARD);
	}
	onDestroy(() => {
		clearTimeout(scrollTimer);
		clearPendingClick();
	});

	function fit() {
		if (!stage || view !== "map") return;
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
		void view;
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
			clearPendingClick(); // drop any deferred inspect bound to the old session
			peeked = new Set();
		});
	});
	$effect(() => {
		if (view !== "map")
			untrack(() => {
				clearRange();
				clearPendingClick(); // a pending map inspect must not fire after leaving the grid
				peeked = new Set();
			});
	});
	// Reconcile: an Inspector "Unfold to context" or "Delete group" action makes a peeked
	// group go live or vanish. Drop stale peek entries so the band doesn't persist after
	// the group is no longer folded (unfolded → live) or no longer exists (deleted).
	$effect(() => {
		const live = store.groups; // re-run when groups change
		void live;
		untrack(() => {
			const next = new Set([...peeked].filter((gid) => store.groupById(gid)?.folded));
			if (next.size !== peeked.size) peeked = next;
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
		// A 2nd+ click in a double/triple sequence: cancel the pending single-click inspect
		// and let onDbl handle the fold. Fires the instant the 2nd click lands, so a fold
		// never flashes the panel even if the clicks are slower than DBL_GUARD.
		if (e.detail > 1) {
			clearPendingClick();
			return;
		}
		const hit = resolveHit(e);

		if (hit.kind === "group") {
			const gid = hit.gid;
			// During an active range-select, a group tile is not a valid range target (groups
			// can't nest or overlap), so shift-clicking one must NOT hijack the gesture — ignore
			// it and let the user pick a plain block to close the range.
			if (e.shiftKey && rangeAnchorId) return;
			// Defer the select+peek so a double-click (which COLLAPSES the group) doesn't flash
			// the Inspector / a peek-open first.
			deferClick(() => {
				const grp = store.groupById(gid);
				// Select the GROUP id so the Inspector shows group mode. Call unconditionally so the
				// parent's toggle (selectedId === id ? null : id) can DESELECT on a re-click — matching
				// block behavior; the togglePeek below keeps the peek band in sync per click.
				// Length guard: createGroup enforces >= 2 members, so an empty group is an invariant
				// violation — but read defensively so a bad state never sets selection to undefined.
				if (grp && grp.memberIds.length > 0) onselect(gid);
				// A FOLDED parent tile toggles PEEK (open-for-viewing, wire UNCHANGED). An UNFOLDED
				// group's dull parent already shows its state in the Inspector, so a plain
				// click there only selects it — peek on folded groups is preserved.
				if (grp?.folded) togglePeek(gid);
			});
			return;
		}

		if (hit.kind !== "block") return;
		const id = hit.id;
		const bl = store.get(id);

		// Range-select → groups is a map-only gesture; in transcript a click only inspects.
		if (view === "map" && e.shiftKey && rangeAnchorId) {
			clearPendingClick(); // a deliberate range gesture — act now, drop any pending inspect
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

		// Plain click on a block: inspect, and (map only) anchor a range if this block could
		// actually start one (older + ungrouped). DEFERRED so a double-click folds the block
		// without opening the side panel first.
		deferClick(() => {
			onselect(id);
			rangeAnchorId = view === "map" && bl && !store.isProtected(bl) && !store.groupOf(bl) ? id : null;
			rangeEndId = null;
			groupErr = false;
		});
	}

	function onDbl(e: MouseEvent) {
		clearPendingClick(); // cancel the pending single-click inspect/peek — this is a fold
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
		if (view !== "map") return undefined;
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
			// Select the GROUP id so the Inspector shows group mode, and scroll the
			// folded-group tile (carries data-group, not data-id).
			if (g.id !== selectedId) onselect(g.id);
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
		// group member maps to its group's stop (the first member). A group id maps to its
		// first member's stop (the collapsed-group stop already represents memberIds[0]).
		let pos = -1;
		if (selectedId) {
			// If selectedId is a group id, use its first member as the representative block.
			const grpSel = store.groupById(selectedId);
			const repBlockId = grpSel ? grpSel.memberIds[0] : selectedId;
			const sel = store.blocks.findIndex((b) => b.id === repBlockId);
			if (sel !== -1) {
				const g = collapsedGroupOf(store.blocks[sel]);
				const repId = g ? g.memberIds[0] : repBlockId;
				pos = order.findIndex((i) => store.blocks[i].id === repId);
			}
		}
		if (pos === -1) {
			// nothing selected yet — enter from the matching edge
			focusStop(order[key === "ArrowLeft" || key === "ArrowUp" ? order.length - 1 : 0]);
			return;
		}
		const step = view === "map" ? cols : 1; // map: ↑/↓ jump a full row; transcript: one message
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
		<!-- View segmented control: Map (abstraction) / Transcript (concretion) -->
		<SegControl
			options={[
				{ id: "map", label: "Map", icon: "layout-grid" },
				{ id: "transcript", label: "Transcript", icon: "file-text" },
			]}
			value={view}
			onchange={(v) => (view = v as "map" | "transcript")}
		/>

		<div class="tb-divider"></div>

		{#if view === "map"}
			<!-- Token-tier legend: dice faces. Hovering (even while moving) reveals each
			     face's token range instantly via a gliding tooltip — discover by accident. -->
			<div class="tiers">
				<span class="tlbl">WEIGHT</span>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="tier-strip" onpointerleave={() => (hoveredFace = null)}>
					{#each FACES as f, i}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<i
							class="die face f{f.f}"
							class:hot={hoveredFace === i}
							onpointerenter={() => (hoveredFace = i)}
						></i>
					{/each}
					{#if hotFace}
						<span class="die-pop" style:left="{(hoveredFace ?? 0) * 20 + 8}px">
							face {hotFace.f} · {hotFace.lbl}
						</span>
					{/if}
				</div>
			</div>

			<span class="grow"></span>

			<!-- Range-select chip / hint -->
			{#if rangeCount >= 2}
				<div class="range-bar" class:err={groupErr}>
					<span class="range-chip">
						<Icon name="corner-down-right" size={11} />
						<b>{rangeCount}</b> blocks → group
						<span class="dim">· Enter</span>
					</span>
					{#if groupErr}<span class="range-err">overlaps a group or protected tail</span>{/if}
					<button class="group-btn" onclick={handleCreateGroup}>Group</button>
					<button class="range-clear" onclick={clearRange} title="Clear selection (Esc)">
						<Icon name="x" size={11} />
					</button>
				</div>
				<div class="tb-divider"></div>
			{:else if rangeAnchorId}
				<span class="range-hint dim">shift-click to complete range</span>
				<div class="tb-divider"></div>
			{/if}

			<!-- Live/folded legend + density — pushed to the right -->
			<div class="legend">
				<span class="sw-pair"><i class="sw solid"></i><span class="sw-lbl">live</span></span>
				<span class="sw-pair"><i class="sw hatch"></i><span class="sw-lbl">folded</span></span>
			</div>

			<div class="tb-divider"></div>

			<!-- Density control -->
			<div class="density">
				<button onclick={() => (nudge -= 1)} aria-label="Smaller tiles" title="Smaller tiles">
					<Icon name="minus" size={12} />
				</button>
				<button class="density-readout" onclick={() => (nudge = 0)} title="Reset density">{cell}px</button>
				<button onclick={() => (nudge += 1)} aria-label="Larger tiles" title="Larger tiles">
					<Icon name="plus" size={12} />
				</button>
			</div>
		{:else}
			<!-- Transcript mode info -->
			<span class="count mono">{store.blocks.length} blocks · {store.foldedCount} folded</span>

			<span class="grow"></span>

			<!-- Live/folded legend — pushed right to match the map toolbar -->
			<div class="legend">
				<span class="sw-pair"><i class="sw solid"></i><span class="sw-lbl">live</span></span>
				<span class="sw-pair"><i class="sw hatch"></i><span class="sw-lbl">folded</span></span>
			</div>

			<div class="tb-divider"></div>

			<span class="dim" style="font-size:var(--fs-xs)">click = inspect · dbl-click = fold</span>
		{/if}
	</div>

	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="stage"
		class:isgrid={view === "map"}
		class:istranscript={view === "transcript"}
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
		{#if view === "map"}
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
													class:sel={selectedId === g.id}
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
											class:sel={selectedId === g.id}
											data-group={g.id}
											title="{live ? 'group (unfolded — live)' : 'group (peek — preview only)'} · {seg.row.members.length} blocks · double-click to collapse"
										></div>
										<div class="band-members">
											{#each seg.row.members as mb (mb.id)}
												{@const mt = { b: mb, face: faceFor(mb.tokens) }}
												{@render tile(mt, false, !live)}
											{/each}
										</div>
									</div>
								{/if}
							{/each}
						</div>
					</section>
				{/if}
				{#if protectedTiles.length}
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
				{/if}
			</div>
		{:else}
			<!-- TRANSCRIPT: the concretion. Blocks in conversation order, full text when live,
			     the exact {#code FOLDED} digest the agent sees when folded. Click = inspect,
			     dbl-click or the row button = fold/unfold. Colour spine = kind grammar. -->
			<div class="transcript">
				{#each store.blocks as b (b.id)}
					{@const folded = store.isFolded(b)}
					{@const prot = store.isProtected(b)}
					<article
						class="tr-msg k-{b.kind}"
						class:folded
						class:pinned={b.override === "pinned"}
						class:prot
						class:sel={b.id === selectedId}
						data-id={b.id}
						title={tip(b, prot)}
					>
						<header class="tr-head">
							<span class="tr-role">{ROLE[b.kind]}</span>
							{#if b.toolName}<span class="tr-tool mono">{b.toolName}</span>{/if}
							<span class="tr-tok mono tnum">
								{k(store.effTokens(b))}{#if folded}<span class="dim">/{k(b.tokens)}</span>{/if} tok
							</span>
							{#if prot}
								<span class="tr-flag" title="protected working tail — never folds"><Icon name="lock" size={10} /></span>
							{:else if b.override === "pinned"}
								<span class="tr-flag" title="pinned — held full"><Icon name="pin" size={10} /></span>
							{/if}
							<span class="grow"></span>
							{#if !prot}
								<button
									class="tr-btn"
									onclick={(e) => { e.stopPropagation(); store.toggle(b.id); }}
									title={folded ? "Unfold to full text" : "Fold to digest"}
								>
									<Icon name={folded ? "chevrons-up-down" : "chevrons-down-up"} size={12} />
									{folded ? "Unfold" : "Fold"}
								</button>
							{/if}
						</header>
						<div class="tr-text" class:digest={folded}>{folded ? store.digestOf(b) : b.text}</div>
					</article>
				{/each}
			</div>
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
		gap: var(--sp-3);
		padding: var(--sp-2) var(--sp-4);
		background: var(--panel);
		border-bottom: 1px solid var(--line-soft);
		flex: 0 0 auto;
		font-size: var(--fs-xs);
		color: var(--muted);
		min-height: 40px;
		/* sit above the grid stage (a later sibling) so the dice tooltip, which drops
		   below the toolbar over the grid, isn't painted over by the tiles. */
		position: relative;
		z-index: 2;
	}
	/* subtle vertical divider between toolbar clusters */
	.tb-divider {
		width: 1px;
		height: 18px;
		background: var(--line-soft);
		flex: 0 0 auto;
	}
	.grow {
		flex: 1;
	}
	.count {
		font-size: var(--fs-xs);
	}
	.dim {
		color: var(--faint);
	}

	/* ---- token-tier legend ---- */
	.tiers {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-2);
	}
	.tlbl {
		font-size: var(--fs-2xs);
		font-weight: 600;
		letter-spacing: 0.07em;
		color: var(--faint);
		text-transform: uppercase;
	}
	/* bare dice — no surrounding bubble; anchors the hover tooltip. gap(4)+die(16)=20px
	   step, which the .die-pop left offset mirrors. */
	.tier-strip {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.die {
		box-sizing: border-box;
		width: 16px;
		height: 16px;
		background: var(--panel-3);
		border: 1px solid var(--line);
		border-radius: 3px;
		display: inline-block;
		flex: 0 0 auto;
		transition:
			transform var(--dur-fast) var(--ease-out),
			border-color var(--dur-fast) var(--ease-out),
			box-shadow var(--dur-fast) var(--ease-out);
	}
	/* premium hover: a subtle lift + accent ring on the die under the cursor (only 6
	   dice here — transforms/box-shadow are fine, unlike the 982-tile grid). */
	.die.hot {
		transform: translateY(-1px) scale(1.14);
		border-color: var(--accent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 32%, transparent);
		z-index: 2;
	}
	/* gliding tooltip: stays mounted while the cursor moves across the strip, sliding
	   to the hovered die via the `left` transition so values surface without stopping. */
	.die-pop {
		position: absolute;
		/* drop DOWN over the grid — popping up would slide under the header/bar above. */
		top: calc(100% + 8px);
		transform: translateX(-50%);
		background: var(--panel-4);
		color: var(--text);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-sm);
		padding: 3px 9px;
		font-size: var(--fs-xs);
		font-weight: 500;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		pointer-events: none;
		box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
		z-index: 10;
		transition: left var(--dur-fast) var(--ease-out);
		animation: die-pop-in var(--dur-fast) var(--ease-out);
	}
	.die-pop::after {
		content: "";
		position: absolute;
		bottom: 100%;
		left: 50%;
		transform: translateX(-50%);
		border: 5px solid transparent;
		border-bottom-color: var(--panel-4);
	}
	@keyframes die-pop-in {
		from { opacity: 0; transform: translateX(-50%) translateY(-4px); }
		to   { opacity: 1; transform: translateX(-50%) translateY(0); }
	}

	/* ---- live/folded legend ---- */
	.legend {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-3);
	}
	.sw-pair {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.sw-lbl {
		font-size: var(--fs-xs);
		color: var(--faint);
	}
	.sw {
		width: 12px;
		height: 9px;
		border-radius: 2px;
		display: inline-block;
		background: var(--k-thinking);
		flex: 0 0 auto;
	}
	.sw.hatch {
		opacity: 0.55;
		background-image: repeating-linear-gradient(45deg, rgba(0, 0, 0, 0.55) 0 1.5px, transparent 1.5px 4px);
	}

	/* ---- density control ---- */
	.density {
		display: inline-flex;
		align-items: center;
		background: var(--panel-2);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		overflow: hidden;
	}
	.density button {
		display: flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: none;
		color: var(--muted);
		padding: 4px 8px;
		min-width: 28px;
		transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
	}
	.density button:hover {
		background: var(--panel-4);
		color: var(--text);
	}
	.density-readout {
		background: transparent;
		border: none;
		border-left: 1px solid var(--line-soft);
		border-right: 1px solid var(--line-soft);
		font-size: var(--fs-xs);
		font-variant-numeric: tabular-nums;
		color: var(--faint);
		min-width: 36px;
		text-align: center;
		padding: 4px 6px;
		cursor: pointer;
		user-select: none;
		transition: color var(--dur-fast) var(--ease-out);
	}
	.density-readout:hover {
		color: var(--muted);
	}

	/* ---- range selection toolbar affordances — warm amber "building" chip ---- */
	.range-bar {
		display: inline-flex;
		align-items: center;
		gap: var(--sp-2);
	}
	/* Counter chip: pill shape, amber family, signals "forming a new object". */
	.range-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: var(--fs-xs);
		color: var(--text);
		background: color-mix(in srgb, var(--group-accent) 12%, var(--panel-2));
		border: 1px solid color-mix(in srgb, var(--group-accent) 50%, transparent);
		border-radius: var(--radius-pill);
		padding: 3px 10px;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
		animation: chip-in var(--dur-mid) var(--ease-out);
	}
	@keyframes chip-in {
		from { opacity: 0; transform: scale(0.92); }
		to   { opacity: 1; transform: scale(1); }
	}
	.range-chip b {
		font-variant-numeric: tabular-nums;
		color: var(--group-accent);
		font-weight: 800;
	}
	.range-bar.err .range-chip {
		border-color: color-mix(in srgb, var(--danger) 60%, transparent);
	}
	.group-btn {
		background: var(--group-accent);
		color: var(--group-ink);
		border: none;
		border-radius: var(--radius-sm);
		font-size: var(--fs-xs);
		font-weight: 700;
		padding: 4px 12px;
		cursor: pointer;
		transition: filter var(--dur-fast) var(--ease-out);
	}
	.group-btn:hover {
		filter: brightness(1.1);
	}
	.range-clear {
		display: flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: 1px solid var(--line);
		color: var(--muted);
		border-radius: var(--radius-sm);
		padding: 4px 6px;
		cursor: pointer;
		transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
	}
	.range-clear:hover {
		color: var(--text);
		background: var(--panel-3);
		border-color: var(--line-strong);
	}
	.range-hint {
		font-size: var(--fs-xs);
	}
	.range-err {
		font-size: var(--fs-xs);
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
	.stage.istranscript {
		overflow-y: auto;
		padding: var(--sp-4) var(--sp-4) 48px;
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
		gap: var(--sp-4);
		width: 100%;
		/* promote the scroll content to its own GPU layer: once painted, scrolling
		   is a cheap layer translation rather than a repaint of the tiles. */
		transform: translateZ(0);
	}
	.box {
		border-radius: var(--radius-lg);
		border: 1px solid var(--line);
		background: var(--panel-2);
		padding: var(--sp-3);
		display: flex;
		align-items: stretch;
		gap: var(--sp-2);
	}
	/* left rail: a small vertical token tally for the box */
	.rail {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		writing-mode: vertical-rl;
		transform: rotate(180deg);
		font-variant-numeric: tabular-nums;
		font-size: var(--fs-2xs);
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--faint);
		user-select: none;
		gap: 4px;
	}
	.rail .tok {
		font-weight: 700;
		font-size: var(--fs-xs);
		letter-spacing: 0.04em;
		text-transform: none;
	}
	/* prot rail uses an accent tint to signal the protected-tail identity */
	.box.prot .rail {
		color: color-mix(in srgb, var(--accent) 65%, var(--muted));
	}
	/* the protected box: meaningfully thicker, accented frame = protection signal.
	   Keep this visually distinct — it's a key part of the visual grammar. */
	.box.prot {
		border: 3px solid var(--accent-dim);
		background: var(--panel);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 18%, transparent), var(--shadow-1);
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

	/* ---- transcript (the readable, scrollable concretion) ---- */
	.transcript {
		max-width: 880px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
	}
	.tr-msg {
		--kc: var(--muted); /* kind colour — set per kind below (visual grammar) */
		border: 1px solid var(--line-soft);
		border-left: 3px solid var(--kc);
		border-radius: var(--radius-sm);
		background: var(--panel);
		padding: var(--sp-2) var(--sp-3);
		cursor: pointer;
		transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
	}
	.tr-msg:hover {
		border-color: var(--line-strong);
		border-left-color: var(--kc);
	}
	.tr-msg.sel {
		border-color: var(--accent);
		border-left-color: var(--kc);
		box-shadow: 0 0 0 1px var(--accent-soft);
	}
	.tr-msg.k-user { --kc: var(--k-user); }
	.tr-msg.k-text { --kc: var(--k-text); }
	.tr-msg.k-thinking { --kc: var(--k-thinking); }
	.tr-msg.k-tool_call { --kc: var(--k-tool_call); }
	.tr-msg.k-tool_result { --kc: var(--k-tool_result); }
	/* folded: recessed (live = solid / folded = recessed, per the grammar) */
	.tr-msg.folded {
		background: var(--panel-2);
		border-left-style: dashed;
	}
	.tr-msg.pinned {
		border-left-width: 4px;
	}

	.tr-head {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		margin-bottom: 5px;
	}
	.tr-role {
		font-size: var(--fs-xs);
		font-weight: 700;
		letter-spacing: 0.02em;
		color: var(--kc);
	}
	.tr-tool {
		font-size: var(--fs-xs);
		color: var(--muted);
		background: var(--panel-2);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		padding: 0 6px;
	}
	.tr-tok {
		font-size: var(--fs-xs);
		color: var(--faint);
	}
	.tr-flag {
		display: inline-flex;
		align-items: center;
		color: var(--faint);
	}
	.tr-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: var(--fs-xs);
		font-weight: 500;
		color: var(--muted);
		background: var(--panel-2);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		padding: 3px 8px;
		cursor: pointer;
		opacity: 0;
		transition: opacity var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out),
			background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
	}
	.tr-msg:hover .tr-btn,
	.tr-msg.sel .tr-btn {
		opacity: 1;
	}
	.tr-btn:hover {
		color: var(--text);
		background: var(--panel-3);
		border-color: var(--line-strong);
	}
	.tr-text {
		font-size: var(--fs-sm);
		line-height: 1.55;
		color: var(--text);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.tr-text.digest {
		font-family: var(--mono);
		font-size: var(--fs-xs);
		color: var(--muted);
	}
	/* keyboard focus: keep the button reachable when its row is the focus target */
	.tr-btn:focus-visible {
		opacity: 1;
		outline: none;
		box-shadow: var(--focus-ring);
	}
</style>
