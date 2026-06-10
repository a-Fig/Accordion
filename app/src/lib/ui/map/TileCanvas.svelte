<script lang="ts">
	/**
	 * TileCanvas.svelte — Svelte 5 host for ONE canvas-rendered tile grid segment.
	 *
	 * Responsibilities:
	 *   - Sizes a <canvas> to fill its container width, with computed CSS height.
	 *   - Backs the canvas at devicePixelRatio for crisp rendering.
	 *   - Coalesces all redraws through a single rAF loop (one pass over specs).
	 *   - Resolves pointer events to tile indices via hitTest and forwards
	 *     semantic callbacks to the integrator (onhit, onhover).
	 *   - Drives ghost-tile opacity pulse via a separate rAF loop.
	 *   - Exports `tileClientRect(id)` for the integrator's arrow-key scroll.
	 *
	 * DOES NOT import or modify ContextMap.svelte, the store, or app.css.
	 */

	import { onMount, onDestroy } from "svelte";
	import {
		readPalette,
		buildSprites,
		resetSprites,
		computeGeometry,
		tileRectCss,
		hitTest,
		drawTile,
		type TileSpec,
		type Palette,
		type GridGeometry,
	} from "./tileDraw";

	// ---------------------------------------------------------------------------
	// Props
	// ---------------------------------------------------------------------------

	let {
		specs,
		cols,
		cell,
		gap = 4,
		onhit,
		ondbl,
		onhover,
	}: {
		/** Ordered array of tile specs — one per grid cell, in conversation order. */
		specs: TileSpec[];
		/** Number of columns in the grid. */
		cols: number;
		/** Cell size in CSS px. */
		cell: number;
		/** Gap between cells in CSS px (default 4). */
		gap?: number;
		/**
		 * Fired on single-click when the pointer lands on a non-vacated, non-ghost tile.
		 * The raw MouseEvent is passed as the second argument for shift/modifier access.
		 */
		onhit?: (
			e: {
				id: string;
				kind: TileSpec["kind"];
				shiftKey: boolean;
				index: number;
			},
			ev: MouseEvent,
		) => void;
		/**
		 * Fired on double-click when the pointer lands on a non-vacated, non-ghost tile.
		 * The raw MouseEvent is passed as the second argument.
		 */
		ondbl?: (
			e: {
				id: string;
				kind: TileSpec["kind"];
				shiftKey: boolean;
				index: number;
			},
			ev: MouseEvent,
		) => void;
		/**
		 * Fired when the hovered tile changes. Passes `null` on pointer-leave.
		 * `clientRect` is the tile's rect in viewport/client coordinates — use it
		 * to position a tooltip.
		 */
		onhover?: (e: { spec: TileSpec; clientRect: DOMRect } | null) => void;
	} = $props();

	// ---------------------------------------------------------------------------
	// Internal state
	// ---------------------------------------------------------------------------

	let canvas = $state<HTMLCanvasElement | undefined>(undefined);
	let containerWidth = $state(0);
	let hoveredIndex = $state(-1);

	// Ghost pulse state: phase advances [0, 2π) each rAF frame.
	let ghostPhase = $state(0);
	let ghostRafId: number | null = null;

	let palette: Palette | null = null;
	let sprites: Map<number, HTMLCanvasElement> | null = null;
	let dpr = 1;
	let ro: ResizeObserver | null = null;

	// ---------------------------------------------------------------------------
	// Derived geometry
	// ---------------------------------------------------------------------------

	const geo = $derived(computeGeometry(specs.length, cols, cell, containerWidth, gap));

	// ---------------------------------------------------------------------------
	// Draw loop
	// ---------------------------------------------------------------------------

	let scheduledRedraw = false;

	// ---------------------------------------------------------------------------
	// Partial redraw — hover-only dirty-tile path
	// ---------------------------------------------------------------------------

	/**
	 * Set of tile indices that need a targeted repaint.
	 *
	 * Safety invariants that make per-tile clear correct:
	 *  - 4px gaps between tiles + all tile decorations are INSET-ONLY ⇒ clearing
	 *    one tile's exact CSS-px rect cannot corrupt a neighbor's pixels.
	 *  - group-kind tiles draw a ~0.5px bevel overflow, but with 4px gaps this
	 *    still cannot reach a neighbor; a tile repaints its own overflow deterministically.
	 *  - Clears use CSS-px coords (ctx.setTransform(dpr,0,0,dpr,0,0) means all
	 *    draw/clear coords are CSS px — do NOT use canvas.width/canvas.height here).
	 */
	const partialDirty = new Set<number>();
	let partialRafPending = false;

	function scheduleRedraw() {
		if (scheduledRedraw) return;
		scheduledRedraw = true;
		requestAnimationFrame(() => {
			scheduledRedraw = false;
			// A full redraw supersedes any pending partial work — clear the dirty set
			// so the partial rAF (if it fires after this) does no stale double-paint.
			partialDirty.clear();
			redraw();
		});
	}

	function schedulePartialRedraw(indices: number[]) {
		// If a full redraw is already scheduled, let it handle everything.
		if (scheduledRedraw) return;
		for (const i of indices) {
			if (i >= 0 && i < specs.length) partialDirty.add(i);
		}
		if (partialRafPending) return;
		partialRafPending = true;
		requestAnimationFrame(() => {
			partialRafPending = false;
			// Re-check: if a full redraw fired in the same frame, skip the partial pass.
			if (scheduledRedraw) {
				partialDirty.clear();
				return;
			}
			runPartialRedraw();
		});
	}

	function runPartialRedraw() {
		if (!canvas || !palette || !sprites) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		const g = geo;
		// Snapshot and clear the dirty set before drawing so new dirty entries
		// added while we're drawing (e.g. from a concurrent ghost tick) are not lost.
		const indices = [...partialDirty];
		partialDirty.clear();
		for (const i of indices) {
			const rect = tileRectCss(i, g);
			if (!rect) continue;
			// Clear only this tile's CSS-px rect (transform is already dpr-scaled).
			ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
			drawOneTile(ctx, i, g);
		}
	}

	// ---------------------------------------------------------------------------
	// Single-tile draw helper — used by both full and partial paths
	// ---------------------------------------------------------------------------

	/**
	 * Draw tile `i` into `ctx` using the current geo, specs, hoveredIndex, and ghostPhase.
	 * Callers are responsible for clearing the tile's rect before calling this if doing
	 * a partial repaint (full redraw clears the whole canvas first).
	 */
	function drawOneTile(ctx: CanvasRenderingContext2D, i: number, g: GridGeometry) {
		if (!palette || !sprites) return;
		const spec = specs[i];
		const rect = tileRectCss(i, g);
		if (!rect) return;
		// For ghost tiles, inject the current animated opacity.
		const finalSpec: TileSpec =
			spec.kind === "ghost"
				? { ...spec, ghostOpacity: ghostOpacity(ghostPhase) }
				: spec;
		drawTile(ctx, rect, finalSpec, palette, sprites, { hovered: hoveredIndex === i, dpr });
	}

	function redraw() {
		if (!canvas || !palette || !sprites) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const g = geo;

		// Clear entire canvas
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		for (let i = 0; i < specs.length; i++) {
			drawOneTile(ctx, i, g);
		}
	}

	/** Compute ghost opacity from a phase [0, 2π). Range: 0.55–0.85. */
	function ghostOpacity(phase: number): number {
		return 0.55 + 0.15 * (1 + Math.sin(phase)) / 1; // 0.55..0.85
	}

	// Ghost rAF loop — runs only while there are ghost specs.
	function startGhostLoop() {
		if (ghostRafId !== null) return;
		function tick() {
			ghostPhase = (ghostPhase + 0.06) % (Math.PI * 2);
			scheduleRedraw();
			const hasGhosts = specs.some((s) => s.kind === "ghost");
			if (hasGhosts) {
				ghostRafId = requestAnimationFrame(tick);
			} else {
				ghostRafId = null;
			}
		}
		ghostRafId = requestAnimationFrame(tick);
	}

	function stopGhostLoop() {
		if (ghostRafId !== null) {
			cancelAnimationFrame(ghostRafId);
			ghostRafId = null;
		}
	}

	// ---------------------------------------------------------------------------
	// Canvas sizing
	// ---------------------------------------------------------------------------

	function resizeCanvas() {
		if (!canvas) return;
		// Update backing store dimensions
		const cssW = geo.canvasWidth;
		const cssH = Math.max(1, geo.canvasHeight); // at least 1px so ctx is valid
		const newDpr = window.devicePixelRatio || 1;
		if (newDpr !== dpr) {
			dpr = newDpr;
			resetSprites();
			sprites = buildSprites(dpr);
		}
		const physW = Math.round(cssW * dpr);
		const physH = Math.round(cssH * dpr);
		if (canvas.width !== physW || canvas.height !== physH) {
			canvas.width = physW;
			canvas.height = physH;
		}
		const ctx = canvas.getContext("2d");
		if (ctx) {
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		}
		canvas.style.width = `${cssW}px`;
		canvas.style.height = `${cssH}px`;
	}

	// ---------------------------------------------------------------------------
	// Pointer event handling
	// ---------------------------------------------------------------------------

	function getPointerIndex(e: MouseEvent): number {
		if (!canvas) return -1;
		const canvasRect = canvas.getBoundingClientRect();
		const xCss = e.clientX - canvasRect.left;
		const yCss = e.clientY - canvasRect.top;
		return hitTest(xCss, yCss, geo);
	}

	function handlePointerMove(e: PointerEvent) {
		const idx = getPointerIndex(e);
		if (idx !== hoveredIndex) {
			const prev = hoveredIndex;
			hoveredIndex = idx;
			// Only repaint the tile that was left and the tile that was entered —
			// not the whole canvas. Filter -1 (off-canvas) from the clear list.
			schedulePartialRedraw([prev, idx]);
			if (onhover) {
				if (idx >= 0 && idx < specs.length) {
					const spec = specs[idx];
					// non-interactive kinds
					if (spec.kind === "vacated" || spec.kind === "ghost") {
						onhover(null);
					} else {
						const tileRect = tileRectCss(idx, geo);
						if (tileRect && canvas) {
							const canvasRect = canvas.getBoundingClientRect();
							const clientRect = new DOMRect(
								canvasRect.left + tileRect.x,
								canvasRect.top + tileRect.y,
								tileRect.w,
								tileRect.h,
							);
							onhover({ spec, clientRect });
						}
					}
				} else {
					onhover(null);
				}
			}
		}
	}

	function handlePointerLeave() {
		if (hoveredIndex !== -1) {
			const prev = hoveredIndex;
			hoveredIndex = -1;
			schedulePartialRedraw([prev]);
		}
		onhover?.(null);
	}

	function handleClick(e: MouseEvent) {
		// Only handle the first click in a sequence; a 2nd click (detail >= 2) is part of
		// a dblclick — the host must call clearPendingClick() in ondbl, not see it here.
		if (e.detail > 1) return;
		const idx = getPointerIndex(e);
		if (idx < 0 || idx >= specs.length) return;
		const spec = specs[idx];
		if (spec.kind === "vacated" || spec.kind === "ghost") return;
		onhit?.({ id: spec.id, kind: spec.kind, shiftKey: e.shiftKey, index: idx }, e);
	}

	function handleDblClick(e: MouseEvent) {
		const idx = getPointerIndex(e);
		if (idx < 0 || idx >= specs.length) return;
		const spec = specs[idx];
		if (spec.kind === "vacated" || spec.kind === "ghost") return;
		ondbl?.({ id: spec.id, kind: spec.kind, shiftKey: e.shiftKey, index: idx }, e);
	}

	// ---------------------------------------------------------------------------
	// Exported helper for integrator
	// ---------------------------------------------------------------------------

	/**
	 * Clear the hovered tile immediately (e.g. on scroll, when pointermove
	 * does not fire and the tooltip would otherwise freeze over stale content).
	 */
	export function clearHover(): void {
		if (hoveredIndex !== -1) {
			const prev = hoveredIndex;
			hoveredIndex = -1;
			schedulePartialRedraw([prev]);
		}
	}

	/**
	 * Returns the client-space DOMRect of the tile with the given id, or null
	 * if no matching tile is found or the canvas isn't mounted yet.
	 *
	 * Use this from the integrator for arrow-key scroll (scrollIntoView) and
	 * programmatic tooltip positioning.
	 */
	export function tileClientRect(id: string): DOMRect | null {
		if (!canvas) return null;
		const idx = specs.findIndex((s) => s.id === id);
		if (idx < 0) return null;
		const tileRect = tileRectCss(idx, geo);
		if (!tileRect) return null;
		const canvasRect = canvas.getBoundingClientRect();
		return new DOMRect(
			canvasRect.left + tileRect.x,
			canvasRect.top + tileRect.y,
			tileRect.w,
			tileRect.h,
		);
	}

	/**
	 * Client-space centers of every real (non-vacated, non-ghost) tile in this
	 * segment. One getBoundingClientRect for the canvas + analytic per-tile math,
	 * so it's cheap to call across all segments on a keypress. Used by the
	 * integrator for geometry-aware vertical (↑/↓) arrow navigation, which must
	 * cross independent grids (older box / bands / protected tail) by screen
	 * position rather than by a flat index step.
	 */
	export function allTileCenters(): { id: string; cx: number; cy: number }[] {
		if (!canvas) return [];
		const canvasRect = canvas.getBoundingClientRect();
		const g = geo;
		const out: { id: string; cx: number; cy: number }[] = [];
		for (let i = 0; i < specs.length; i++) {
			const s = specs[i];
			if (!s.id || s.kind === "vacated" || s.kind === "ghost") continue;
			const r = tileRectCss(i, g);
			if (!r) continue;
			out.push({
				id: s.id,
				cx: canvasRect.left + r.x + r.w / 2,
				cy: canvasRect.top + r.y + r.h / 2,
			});
		}
		return out;
	}

	// ---------------------------------------------------------------------------
	// Effects
	// ---------------------------------------------------------------------------

	// Read palette once on mount (after DOM is available for getComputedStyle).
	onMount(() => {
		palette = readPalette();
		dpr = window.devicePixelRatio || 1;
		sprites = buildSprites(dpr);

		// ResizeObserver on the canvas's parent to track container width.
		if (canvas?.parentElement) {
			ro = new ResizeObserver((entries) => {
				for (const entry of entries) {
					const newWidth = entry.contentRect.width;
					if (Math.abs(newWidth - containerWidth) > 0.5) {
						containerWidth = newWidth;
					}
				}
			});
			ro.observe(canvas.parentElement);
			containerWidth = canvas.parentElement.clientWidth;
		}
	});

	onDestroy(() => {
		ro?.disconnect();
		stopGhostLoop();
	});

	// Whenever geo or canvas changes, resize the canvas backing store.
	$effect(() => {
		void geo; // depend on geometry changes
		if (canvas) {
			resizeCanvas();
			scheduleRedraw();
		}
	});

	// Redraw when specs change. hoveredIndex is intentionally NOT listed here —
	// hover changes flow only through schedulePartialRedraw() to avoid a full
	// canvas repaint on every mouse-move frame.
	// (ghostPhase is also excluded — ghost loop calls scheduleRedraw itself.)
	$effect(() => {
		void specs;
		if (canvas && palette && sprites) {
			scheduleRedraw();
		}
	});

	// Manage ghost loop: start when any ghost specs exist, stop when none.
	$effect(() => {
		const hasGhosts = specs.some((s) => s.kind === "ghost");
		if (hasGhosts) {
			startGhostLoop();
		} else {
			stopGhostLoop();
		}
	});
</script>

<!--
  The canvas width is governed by the parent container (width:100%).
  CSS height is set programmatically via resizeCanvas().
  pointer-events are on so click/pointermove work.
-->
<canvas
	bind:this={canvas}
	style="display:block;width:100%;"
	onpointermove={handlePointerMove}
	onpointerleave={handlePointerLeave}
	onclick={handleClick}
	ondblclick={handleDblClick}
	aria-hidden="true"
></canvas>
