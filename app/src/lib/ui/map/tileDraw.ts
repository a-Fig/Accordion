/**
 * tileDraw.ts — pure drawing + geometry core for the canvas tile renderer.
 *
 * Framework-free: no Svelte, no imports from the app. All pixel work and math
 * lives here so it is fully unit-testable via vitest (node env, no canvas API
 * needed for geometry tests).
 *
 * PERFORMANCE CONTRACT (per CLAUDE.md):
 *  - No per-tile gradients or ctx.filter in the hot draw loop.
 *  - Dice sprites are pre-rendered once to offscreen canvases, then blitted.
 *  - Folded desaturation is done in JS (HSL math) — NOT ctx.filter.
 *  - Diagonal hatch for folded tiles is drawn inline (cheap 1px lines).
 */

import type { BlockKind } from "../../engine/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TileSpec = {
  /** Block id, group id, or "" for vacated/ghost. */
  id: string;
  /** Block kind, "group" for a collapsed folder tile, "vacated"/"ghost" for placeholders. */
  kind: BlockKind | "group" | "vacated" | "ghost";
  /** Die face 0–6 (0 = blank/no pips for drop groups; ignored for vacated). */
  face: number;
  folded: boolean;
  pinned: boolean;
  selected: boolean;
  inrange: boolean;
  /**
   * For ghost tiles: opacity in [0,1]. The host advances this each rAF.
   * For all other kinds this field is ignored.
   */
  ghostOpacity?: number;
  /**
   * For ghost tiles: the kind of the block being formed, used to pick the fill color.
   * Mirrors the old `.cell.ghost.k-{kind}` CSS class. Defaults to "text" if absent.
   */
  colorKind?: BlockKind;
};

export type Palette = {
  kindColors: Record<BlockKind, string>;
  accent: string;
  accentDim: string;
  group: string;
  groupEdge: string;
  groupAccent: string;
};

// ---------------------------------------------------------------------------
// faceFor — mirrors ContextMap.svelte's cut-offs exactly
// ---------------------------------------------------------------------------

export function faceFor(tokens: number): number {
  return tokens > 15000
    ? 6
    : tokens > 5000
      ? 5
      : tokens > 1500
        ? 4
        : tokens > 500
          ? 3
          : tokens > 100
            ? 2
            : 1;
}

// ---------------------------------------------------------------------------
// Palette reader
// ---------------------------------------------------------------------------

/**
 * Read the kind colors and accent/group tokens from CSS custom properties.
 * Call once on mount; cache the result. Re-reading is cheap but unnecessary
 * on a single dark theme.
 */
export function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    kindColors: {
      user: v("--k-user") || "#6ea8fe",
      text: v("--k-text") || "#aab2c2",
      thinking: v("--k-thinking") || "#b483e0",
      tool_call: v("--k-tool_call") || "#34d3c2",
      tool_result: v("--k-tool_result") || "#f0a35e",
    },
    accent: v("--accent") || "#6ea8fe",
    accentDim: v("--accent-dim") || "#2d4a7a",
    group: v("--group") || "#6f4a32",
    groupEdge: v("--group-edge") || "#9c6b43",
    groupAccent: v("--group-accent") || "#d39455",
  };
}

// ---------------------------------------------------------------------------
// Color utilities
// ---------------------------------------------------------------------------

/** Parse a hex string (#rrggbb or #rgb) into [r,g,b] 0–255. */
function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ];
  }
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Convert [r,g,b] 0–255 to CSS rgb() string. */
function toRgb(r: number, g: number, b: number): string {
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

/** Convert RGB to HSL. Returns [h 0-360, s 0-1, l 0-1]. */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

/** Convert HSL to RGB (0–255 each). */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h /= 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue2rgb(h + 1 / 3) * 255, hue2rgb(h) * 255, hue2rgb(h - 1 / 3) * 255];
}

/**
 * Approximate CSS `saturate(0.5)` by halving the HSL saturation.
 * Does NOT use ctx.filter (too slow in a per-tile loop).
 */
export function desaturate(hex: string, factor = 0.5): string {
  const [r, g, b] = parseHex(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const [nr, ng, nb] = hslToRgb(h, s * factor, l);
  return toRgb(nr, ng, nb);
}

// ---------------------------------------------------------------------------
// Dice sprite sheet
// ---------------------------------------------------------------------------

// Pip centres on a 100×100 viewBox — ported exactly from the f1–f6 SVGs in ContextMap.svelte.
// Face 0 is a blank die (no pips) — used for drop groups whose token cost is 0.
const PIP_POSITIONS: Record<number, [number, number][]> = {
  0: [],
  1: [[50, 50]],
  2: [
    [28, 28],
    [72, 72],
  ],
  3: [
    [28, 28],
    [50, 50],
    [72, 72],
  ],
  4: [
    [28, 28],
    [72, 28],
    [28, 72],
    [72, 72],
  ],
  5: [
    [28, 28],
    [72, 28],
    [50, 50],
    [28, 72],
    [72, 72],
  ],
  6: [
    [28, 26],
    [72, 26],
    [28, 50],
    [72, 50],
    [28, 74],
    [72, 74],
  ],
};

/** Sprite size (CSS px). Sprites are rendered at this resolution × dpr. */
const SPRITE_SIZE = 100;
let _sprites: Map<number, HTMLCanvasElement> | null = null;
let _spritesDpr = 0;

/**
 * Pre-render the 6 die faces to offscreen canvases.
 * Cached by DPR — rebuilds if the DPR arg differs from the cached build.
 */
export function buildSprites(dpr = 1): Map<number, HTMLCanvasElement> {
  // Rebuild if sprites are absent or were built at a different DPR
  if (_sprites && _spritesDpr === dpr) return _sprites;
  _spritesDpr = dpr;
  _sprites = new Map();
  const sz = SPRITE_SIZE * dpr;

  for (let face = 0; face <= 6; face++) {
    const c = document.createElement("canvas");
    c.width = sz;
    c.height = sz;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);

    const pips = PIP_POSITIONS[face];
    for (const [cx, cy] of pips) {
      // The SVG uses fill='#fff' stroke='#000' stroke-opacity='.5' stroke-width='3.6'
      // on a 100×100 viewBox, circle r='11'.
      const px = (cx / 100) * SPRITE_SIZE;
      const py = (cy / 100) * SPRITE_SIZE;
      const r = (11 / 100) * SPRITE_SIZE;
      const sw = (3.6 / 100) * SPRITE_SIZE;

      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = sw;
      ctx.stroke();
    }

    _sprites.set(face, c);
  }

  return _sprites;
}

/** Reset sprite cache — call when dpr changes to force a rebuild. */
export function resetSprites(): void {
  _sprites = null;
  _spritesDpr = 0;
}

export function getSprites(): Map<number, HTMLCanvasElement> | null {
  return _sprites;
}

// ---------------------------------------------------------------------------
// Folded-tile caches (PERF) — folded tiles are drawn on EVERY repaint (which
// fires on every hover-move). Doing per-tile HSL math + a per-tile clip()+hatch
// loop made responsiveness scale with the FOLDED count. Both are now O(1) per
// tile: the desaturated colour is memoized (≤6 distinct), and the diagonal hatch
// is baked ONCE into a sprite (rounded-masked) and blitted like the dice pips —
// no clip(), no line loop in the hot path.
// ---------------------------------------------------------------------------

/** Memoized saturate(0.5) — keyed by source hex. At most ~6 entries. */
const _desatMemo = new Map<string, string>();
function desaturateCached(hex: string): string {
  let v = _desatMemo.get(hex);
  if (v === undefined) {
    v = desaturate(hex, 0.5);
    _desatMemo.set(hex, v);
  }
  return v;
}

/** Baked diagonal-hatch sprite, cached for the current (cellSize, dpr). The
 *  old per-tile clip()+stroke loop is done ONCE here, at build time. */
let _hatch: { key: string; canvas: HTMLCanvasElement } | null = null;
function getHatchSprite(size: number, dpr: number): HTMLCanvasElement {
  const key = `${size}:${dpr}`;
  if (_hatch && _hatch.key === key) return _hatch.canvas;
  const c = document.createElement("canvas");
  const px = Math.max(1, Math.round(size * dpr));
  c.width = px;
  c.height = px;
  const ctx = c.getContext("2d")!;
  ctx.scale(dpr, dpr);
  // Round-mask once so the hatch can't poke past the tile's rounded corners.
  buildRoundRect(ctx, 0, 0, size, size, 3);
  ctx.clip();
  // rgba(255,255,255,.06), 1px lines every 5px at 45° — matches the old CSS hatch.
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  const step = 5;
  const diag = size * 2;
  ctx.beginPath();
  for (let d = -diag; d < diag; d += step) {
    ctx.moveTo(d, 0);
    ctx.lineTo(d + size, size);
  }
  ctx.stroke();
  _hatch = { key, canvas: c };
  return c;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export type GridGeometry = {
  /** Number of columns. */
  cols: number;
  /** Cell size in CSS px. */
  cell: number;
  /** Gap between cells in CSS px. */
  gap: number;
  /** Number of tiles. */
  count: number;
  /** Total canvas CSS width. */
  canvasWidth: number;
  /** Total canvas CSS height. */
  canvasHeight: number;
  /**
   * Left offset (CSS px) where the grid starts inside the canvas, accounting
   * for CSS `justify-content: center`.
   */
  marginLeft: number;
};

/**
 * Compute grid geometry given the container width and tile params.
 *
 * CSS `justify-content: center` centers the fixed-width track group. The
 * canvas fills the full container width; the grid is inset by `marginLeft`.
 */
export function computeGeometry(
  count: number,
  cols: number,
  cell: number,
  containerCssWidth: number,
  gap = 4,
): GridGeometry {
  const rows = Math.ceil(count / cols);
  // Total track group width (the block that gets centered):
  const trackGroupWidth = cols * cell + Math.max(0, cols - 1) * gap;
  const canvasWidth = containerCssWidth;
  // Center the track group within the canvas (mirrors justify-content:center).
  const marginLeft = Math.max(0, Math.floor((containerCssWidth - trackGroupWidth) / 2));
  const canvasHeight = rows > 0 ? rows * cell + (rows - 1) * gap : 0;

  return { cols, cell, gap, count, canvasWidth, canvasHeight, marginLeft };
}

/**
 * Return the CSS-px rect {x, y, w, h} of the tile at `index`.
 * Returns null if index is out of range.
 */
export function tileRectCss(
  index: number,
  geo: GridGeometry,
): { x: number; y: number; w: number; h: number } | null {
  if (index < 0 || index >= geo.count) return null;
  const col = index % geo.cols;
  const row = Math.floor(index / geo.cols);
  const x = geo.marginLeft + col * (geo.cell + geo.gap);
  const y = row * (geo.cell + geo.gap);
  return { x, y, w: geo.cell, h: geo.cell };
}

/**
 * Given a CSS-px pointer position within the canvas, return the tile index
 * or -1 if the point falls in a gap or outside the grid.
 */
export function hitTest(xCss: number, yCss: number, geo: GridGeometry): number {
  if (geo.count === 0 || geo.cols === 0) return -1;

  // Adjust for the centering margin
  const lx = xCss - geo.marginLeft;
  const ly = yCss;

  if (lx < 0 || ly < 0) return -1;

  const step = geo.cell + geo.gap;
  const col = Math.floor(lx / step);
  const row = Math.floor(ly / step);

  if (col < 0 || col >= geo.cols) return -1;
  if (row < 0) return -1;

  // Check the point isn't in a gap
  const inColGap = lx - col * step >= geo.cell;
  const inRowGap = ly - row * step >= geo.cell;
  if (inColGap || inRowGap) return -1;

  const index = row * geo.cols + col;
  if (index >= geo.count) return -1;

  return index;
}

// ---------------------------------------------------------------------------
// Tile drawing
// ---------------------------------------------------------------------------

/**
 * Draw one tile into `ctx` at the given CSS-px rect.
 *
 * All effects are inset-only — no outset box-shadows (they clip in dense grids).
 * Folded desaturation uses JS HSL math; brightness uses a translucent overlay rect.
 * ctx.filter is NEVER used here.
 */
export function drawTile(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
  spec: TileSpec,
  palette: Palette,
  sprites: Map<number, HTMLCanvasElement>,
  opts: { hovered: boolean; dpr?: number } = { hovered: false },
): void {
  const { x, y, w, h } = rect;
  const r = 3; // border-radius: 3px (cells), 4px (group-tile) — use 3 for most

  // ---- vacated: transparent, 1px dashed accent ring, no fill ----
  if (spec.kind === "vacated") {
    ctx.save();
    ctx.strokeStyle = hexWithAlpha(palette.accent, 0.3);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    return;
  }

  // ---- ghost: kind color with pulsing opacity + dashed inset ring ----
  if (spec.kind === "ghost") {
    const op = spec.ghostOpacity ?? 0.55;
    // Use the forming block's kind color; fall back to "text" (safe default).
    const fillHex = palette.kindColors[spec.colorKind ?? "text"];

    ctx.save();
    ctx.globalAlpha = op;
    ctx.fillStyle = fillHex;
    roundRectFill(ctx, x, y, w, h, r);
    // dashed inset ring
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    roundRect(ctx, x + 1, y + 1, w - 2, h - 2, Math.max(0, r - 1));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    return;
  }

  // ---- derive base fill color ----
  const isGroup = spec.kind === "group";
  const rawColor = isGroup
    ? palette.group
    : palette.kindColors[spec.kind as BlockKind];

  // Folded: desaturate — but restore full saturation on hover (matches old CSS
  // `.cell.folded:hover { filter: saturate(1) brightness(1.1) }`).
  let baseColor = rawColor;
  if (spec.folded && !opts.hovered) {
    baseColor = desaturateCached(rawColor);
  }

  // ---- base rounded rect fill ----
  ctx.save();

  if (spec.folded) {
    // folded: recessed but still legibly COLORED (live=1.0, so this still reads
    // as dimmer/recessed); full brightness on hover.
    ctx.globalAlpha = opts.hovered ? 0.85 : 0.46;
  }

  ctx.fillStyle = baseColor;
  roundRectFill(ctx, x, y, w, h, isGroup ? 4 : r);

  // ---- folded hatch — blit the baked sprite (no per-tile clip()/loop) ----
  if (spec.folded) {
    ctx.drawImage(getHatchSprite(w, opts.dpr ?? 1), x, y, w, h);
  }

  // ---- restore alpha for ring/overlay work ----
  ctx.globalAlpha = 1;

  // ---- inset edge shadow: rgba(0,0,0,.22) 1px ----
  // (skip for folded+non-hovered — visual noise at .36 alpha)
  if (!spec.folded || opts.hovered) {
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, isGroup ? 4 : r);
    ctx.stroke();
  }

  // ---- group bevel: inset lighter top-left, darker bottom-right ----
  if (isGroup) {
    // Light top-left highlight
    ctx.strokeStyle = hexWithAlpha("#ffffff", 0.16);
    ctx.lineWidth = 2;
    ctx.beginPath();
    // top edge + left edge (partial bevel)
    ctx.moveTo(x + 4, y + 1);
    ctx.lineTo(x + w - 4, y + 1);
    ctx.moveTo(x + 1, y + 4);
    ctx.lineTo(x + 1, y + h - 4);
    ctx.stroke();
    // Dark bottom-right shadow
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + w - 4, y + h - 1);
    ctx.lineTo(x + 4, y + h - 1);
    ctx.moveTo(x + w - 1, y + h - 4);
    ctx.lineTo(x + w - 1, y + 4);
    ctx.stroke();

    // Group edge inset ring
    ctx.strokeStyle = palette.groupEdge;
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 4);
    ctx.stroke();
  }

  // ---- dice pips (blitted from sprite) ----
  // Folded tiles KEEP their dice face (the old DOM showed pips at the cell's
  // .36 opacity). Drawing them dimmed-but-visible keeps a folded block reading
  // as "a recessed version of the colored tile," not a blank square.
  const spriteCanvas = sprites.get(spec.face);
  if (spriteCanvas) {
    if (spec.folded) {
      ctx.save();
      ctx.globalAlpha = opts.hovered ? 0.75 : 0.55;
      ctx.drawImage(spriteCanvas, x, y, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(spriteCanvas, x, y, w, h);
    }
  }

  // ---- pinned: inset 2px white ring (drawn before sel/inrange so sel ring sits on top) ----
  if (spec.pinned) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    roundRect(ctx, x + 1, y + 1, w - 2, h - 2, Math.max(0, r - 1));
    ctx.stroke();
  }

  // ---- inrange: group-accent ring + group-accent fill tint ----
  if (spec.inrange) {
    // Warm fill tint (~30% group-accent over the tile)
    ctx.fillStyle = hexWithAlpha(palette.groupAccent, 0.3);
    roundRectFill(ctx, x, y, w, h, r);
    // Double inset ring: 3px dark then 2px group-accent
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 3;
    roundRect(ctx, x + 1.5, y + 1.5, w - 3, h - 3, Math.max(0, r - 1));
    ctx.stroke();
    ctx.strokeStyle = palette.groupAccent;
    ctx.lineWidth = 2;
    roundRect(ctx, x + 1, y + 1, w - 2, h - 2, Math.max(0, r - 1));
    ctx.stroke();
  }

  // ---- selected: inset 2px accent, inset 3px dark, brightness overlay ----
  if (spec.selected && !isGroup) {
    // brightness ~1.18: translucent white overlay
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    roundRectFill(ctx, x, y, w, h, r);
    // Double inset ring: 3px black then 2px accent
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 3;
    roundRect(ctx, x + 1.5, y + 1.5, w - 3, h - 3, Math.max(0, r - 1));
    ctx.stroke();
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 2;
    roundRect(ctx, x + 1, y + 1, w - 2, h - 2, Math.max(0, r - 1));
    ctx.stroke();
  } else if (spec.selected && isGroup) {
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 3;
    roundRect(ctx, x + 1.5, y + 1.5, w - 3, h - 3, 3);
    ctx.stroke();
    ctx.strokeStyle = palette.groupAccent;
    ctx.lineWidth = 2;
    roundRect(ctx, x + 1, y + 1, w - 2, h - 2, 3);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    roundRectFill(ctx, x, y, w, h, 4);
  }

  // ---- hovered (non-folded): brightness ~1.22 overlay + inset 1px white ring ----
  if (opts.hovered && !spec.folded) {
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    roundRectFill(ctx, x, y, w, h, isGroup ? 4 : r);
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, isGroup ? 4 : r);
    ctx.stroke();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Canvas path helpers (inlined for performance — no per-call object alloc)
// ---------------------------------------------------------------------------

/** Build a rounded-rect path without stroking/filling. */
function buildRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Stroke a rounded rect path. */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  buildRoundRect(ctx, x, y, w, h, Math.max(0, r));
}

/** Fill a rounded rect. */
function roundRectFill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  buildRoundRect(ctx, x, y, w, h, Math.max(0, r));
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Utility: hex color + alpha → CSS rgba()
// ---------------------------------------------------------------------------

function hexWithAlpha(hex: string, alpha: number): string {
  try {
    const [r, g, b] = parseHex(hex);
    return `rgba(${r},${g},${b},${alpha})`;
  } catch {
    return `rgba(110,168,254,${alpha})`;
  }
}
