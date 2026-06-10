import { describe, it, expect } from "vitest";
import { faceFor, computeGeometry, tileRectCss, hitTest, desaturate, resetSprites, getSprites, type TileSpec } from "./tileDraw";

// ---------------------------------------------------------------------------
// faceFor
// ---------------------------------------------------------------------------

describe("faceFor — token → die face mapping", () => {
  it("face 1 for ≤100 tokens", () => {
    expect(faceFor(0)).toBe(1);
    expect(faceFor(1)).toBe(1);
    expect(faceFor(100)).toBe(1);
  });

  it("face 2 for 101–500 tokens", () => {
    expect(faceFor(101)).toBe(2);
    expect(faceFor(500)).toBe(2);
  });

  it("face 3 for 501–1500 tokens", () => {
    expect(faceFor(501)).toBe(3);
    expect(faceFor(1500)).toBe(3);
  });

  it("face 4 for 1501–5000 tokens", () => {
    expect(faceFor(1501)).toBe(4);
    expect(faceFor(5000)).toBe(4);
  });

  it("face 5 for 5001–15000 tokens", () => {
    expect(faceFor(5001)).toBe(5);
    expect(faceFor(15000)).toBe(5);
  });

  it("face 6 for >15000 tokens", () => {
    expect(faceFor(15001)).toBe(6);
    expect(faceFor(100000)).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// computeGeometry
// ---------------------------------------------------------------------------

describe("computeGeometry", () => {
  it("computes rows and height correctly", () => {
    const geo = computeGeometry(10, 5, 20, 200, 4);
    // 10 tiles, 5 cols → 2 rows
    expect(geo.canvasHeight).toBe(2 * 20 + 1 * 4); // 44
  });

  it("partial last row: ceil(n/cols) rows", () => {
    // 11 tiles, 5 cols → 3 rows
    const geo = computeGeometry(11, 5, 20, 200, 4);
    expect(geo.canvasHeight).toBe(3 * 20 + 2 * 4); // 68
  });

  it("centers the grid in the container", () => {
    // 3 cols × 20px + 2 gaps × 4px = 68px track group
    // Container 200px → marginLeft = (200 - 68) / 2 = 66
    const geo = computeGeometry(3, 3, 20, 200, 4);
    expect(geo.marginLeft).toBe(66);
  });

  it("0 count → 0 height", () => {
    const geo = computeGeometry(0, 5, 20, 200, 4);
    expect(geo.canvasHeight).toBe(0);
  });

  it("exposes all input params", () => {
    const geo = computeGeometry(6, 3, 20, 100, 4);
    expect(geo.cols).toBe(3);
    expect(geo.cell).toBe(20);
    expect(geo.gap).toBe(4);
    expect(geo.count).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// tileRectCss
// ---------------------------------------------------------------------------

describe("tileRectCss — index → rect", () => {
  const GEO = computeGeometry(12, 4, 20, 200, 4);

  it("returns correct x/y/w/h for tile 0", () => {
    const rect = tileRectCss(0, GEO);
    expect(rect).not.toBeNull();
    expect(rect!.w).toBe(20);
    expect(rect!.h).toBe(20);
    // x is marginLeft + 0*(20+4)
    expect(rect!.x).toBe(GEO.marginLeft);
    expect(rect!.y).toBe(0);
  });

  it("advances x by (cell+gap) per column", () => {
    const r0 = tileRectCss(0, GEO)!;
    const r1 = tileRectCss(1, GEO)!;
    expect(r1.x - r0.x).toBe(20 + 4); // 24
  });

  it("advances y by (cell+gap) per row", () => {
    const r0 = tileRectCss(0, GEO)!;
    const r4 = tileRectCss(4, GEO)!; // first tile of row 1 (4 cols)
    expect(r4.y - r0.y).toBe(20 + 4); // 24
    expect(r4.x).toBe(r0.x); // same column
  });

  it("returns null for negative index", () => {
    expect(tileRectCss(-1, GEO)).toBeNull();
  });

  it("returns null for index >= count", () => {
    expect(tileRectCss(12, GEO)).toBeNull();
    expect(tileRectCss(100, GEO)).toBeNull();
  });

  it("last tile in partial last row has correct position", () => {
    // 12 tiles, 4 cols → full rows only; but test with 13 (1 in last row)
    const geo13 = computeGeometry(13, 4, 20, 200, 4);
    const r12 = tileRectCss(12, geo13)!;
    // row 3, col 0
    expect(r12.y).toBe(3 * (20 + 4));
    expect(r12.x).toBe(geo13.marginLeft);
  });
});

// ---------------------------------------------------------------------------
// hitTest — round-trip: center of tile i → i; gaps → -1; OOB → -1
// ---------------------------------------------------------------------------

describe("hitTest — pointer → tile index", () => {
  const GEO = computeGeometry(12, 4, 20, 200, 4);

  it("center of each tile round-trips back to its index", () => {
    for (let i = 0; i < 12; i++) {
      const rect = tileRectCss(i, GEO)!;
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      expect(hitTest(cx, cy, GEO)).toBe(i);
    }
  });

  it("gap between tiles returns -1", () => {
    // gap is to the right of tile 0
    const r0 = tileRectCss(0, GEO)!;
    const gapX = r0.x + r0.w + 1; // 1px into the gap
    const gapY = r0.y + r0.h / 2;
    expect(hitTest(gapX, gapY, GEO)).toBe(-1);
  });

  it("vertical gap between rows returns -1", () => {
    const r0 = tileRectCss(0, GEO)!;
    const r4 = tileRectCss(4, GEO)!;
    const gapY = (r0.y + r0.h + r4.y) / 2; // midpoint of vertical gap
    expect(hitTest(r0.x + r0.w / 2, gapY, GEO)).toBe(-1);
  });

  it("negative x/y returns -1", () => {
    expect(hitTest(-1, 10, GEO)).toBe(-1);
    expect(hitTest(10, -1, GEO)).toBe(-1);
  });

  it("far right (outside track group) returns -1", () => {
    expect(hitTest(GEO.canvasWidth + 10, 10, GEO)).toBe(-1);
  });

  it("below the last row returns -1", () => {
    expect(hitTest(GEO.marginLeft + 2, GEO.canvasHeight + 5, GEO)).toBe(-1);
  });

  it("empty grid (count=0) always returns -1", () => {
    const empty = computeGeometry(0, 4, 20, 200, 4);
    expect(hitTest(10, 10, empty)).toBe(-1);
  });

  it("partial last row — after the last tile returns -1", () => {
    // 5 tiles, 4 cols: tile [0–3] in row 0, tile [4] in row 1 col 0.
    // col 1 of row 1 has no tile → should return -1.
    const geo5 = computeGeometry(5, 4, 20, 200, 4);
    const r4 = tileRectCss(4, geo5)!; // last tile: row 1, col 0
    const phantomX = r4.x + r4.w + 4 + r4.w / 2; // col 1 of row 1
    const phantomY = r4.y + r4.h / 2;
    expect(hitTest(phantomX, phantomY, geo5)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// TileSpec — colorKind field
// ---------------------------------------------------------------------------

describe("TileSpec colorKind", () => {
  it("ghost spec accepts colorKind field", () => {
    const spec: TileSpec = {
      id: "",
      kind: "ghost",
      face: 1,
      folded: false,
      pinned: false,
      selected: false,
      inrange: false,
      ghostOpacity: 0.7,
      colorKind: "tool_call",
    };
    expect(spec.colorKind).toBe("tool_call");
  });

  it("ghost spec without colorKind is valid (optional)", () => {
    const spec: TileSpec = {
      id: "",
      kind: "ghost",
      face: 1,
      folded: false,
      pinned: false,
      selected: false,
      inrange: false,
    };
    expect(spec.colorKind).toBeUndefined();
  });

  it("non-ghost spec can also carry colorKind (field is optional on all)", () => {
    const spec: TileSpec = {
      id: "abc",
      kind: "text",
      face: 2,
      folded: false,
      pinned: false,
      selected: false,
      inrange: false,
    };
    expect(spec.colorKind).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resetSprites / _spritesDpr — cache invalidation (Fix 3)
// ---------------------------------------------------------------------------

describe("resetSprites — clears sprite cache so DPR change forces rebuild", () => {
  it("getSprites() returns null after resetSprites()", () => {
    // Start from a clean slate regardless of previous test order.
    resetSprites();
    expect(getSprites()).toBeNull();
  });

  it("getSprites() remains null after a second resetSprites()", () => {
    resetSprites();
    resetSprites();
    expect(getSprites()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// desaturate — color utility
// ---------------------------------------------------------------------------

describe("desaturate", () => {
  it("returns a valid rgb() string", () => {
    const result = desaturate("#b483e0");
    expect(result).toMatch(/^rgb\(/);
  });

  it("does not crash on dark colors", () => {
    expect(() => desaturate("#6f4a32")).not.toThrow();
  });

  it("returns grey for fully saturated colors at factor=0", () => {
    // factor=0 → fully desaturated; the r/g/b channels should equalize (grey)
    const result = desaturate("#ff0000", 0);
    // luminance of pure red = 0.299; grey value ~76
    const match = result.match(/rgb\((\d+),(\d+),(\d+)\)/);
    expect(match).not.toBeNull();
    if (match) {
      const r = Number(match[1]);
      const g = Number(match[2]);
      const b = Number(match[3]);
      // all channels should be equal (grey)
      expect(Math.abs(r - g)).toBeLessThan(2);
      expect(Math.abs(g - b)).toBeLessThan(2);
    }
  });
});
