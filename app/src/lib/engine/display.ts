/*
 * display.ts — the grid's render list (ADR 0006 §3).
 *
 * `ContextMap` no longer maps `blocks` 1:1. It renders the rows this pure function
 * produces. A group has THREE display states (the redesign):
 *
 *   COLLAPSED  — folded && !peeked → ONE parent tile standing in for the whole range.
 *   PEEK       — folded &&  peeked → an open row; members shown DULL (preview only). The
 *                wire is UNCHANGED (the group is still folded), so the model's context is
 *                byte-for-byte identical to COLLAPSED. Peek is pure UI-local state passed
 *                in via `peeked`; this function NEVER mutates `group.folded`.
 *   UNFOLDED   — !folded → an open row; members shown LIVE (with their own per-block fold
 *                state). The wire is uncollapsed; the model now sees the members.
 *
 * The open states are distinguished on the wire-relevant axis by `live`: a `groupOpen`
 * row carries `live=false` for PEEK (folded, dull preview) and `live=true` for UNFOLDED
 * (folded=false, members live). `folded=false` always wins → `live=true`, even if the id
 * is also in `peeked` (you can't peek a group that's already unfolded).
 *
 * Kept pure (no store, no runes) so the layout transform is unit-testable on its own and
 * the component stays thin. Groups are always entirely older than the protected tail, so a
 * group never straddles the grid's older/protected split — callers may safely build over
 * either slice. A group whose first member is absent from the given block list is dropped
 * defensively (its members render as plain blocks rather than as ungrouped strays), which
 * only arises if an invariant is already broken.
 */
import type { Block, Group } from "./types";

export type DisplayRow =
	| { type: "block"; block: Block }
	/** COLLAPSED group → render ONE parent tile (members hidden behind it). */
	| { type: "group"; group: Group; members: Block[] }
	/**
	 * Open group → render the dull parent at the row's left, then each member tile.
	 * `live=false` → PEEK (folded, members previewed dull); `live=true` → UNFOLDED
	 * (members live with their own fold state). PEEK never touches the wire.
	 */
	| { type: "groupOpen"; group: Group; members: Block[]; live: boolean };

export function buildDisplay(
	blocks: Block[],
	groups: Group[],
	peeked: ReadonlySet<string> = new Set(),
): DisplayRow[] {
	const firstMember = new Map<string, Group>();
	const memberOf = new Map<string, Group>();
	for (const g of groups) {
		if (!g.memberIds.length) continue;
		firstMember.set(g.memberIds[0], g);
		for (const id of g.memberIds) memberOf.set(id, g);
	}
	const byId = new Map<string, Block>();
	for (const b of blocks) byId.set(b.id, b);

	const rows: DisplayRow[] = [];
	const emitted = new Set<Group>();
	for (const b of blocks) {
		const g = memberOf.get(b.id);
		if (!g) {
			rows.push({ type: "block", block: b });
			continue;
		}
		if (firstMember.get(b.id) === g) {
			// Emit the group once, at its first member; the rest of its range is skipped below.
			// NOTE: a member id absent from `blocks` is silently dropped here, so the group can
			// render with fewer tiles than `memberIds`. Safe for the only caller (always the full
			// `olderBlocks` slice, which covers every older block); a future caller passing a
			// trimmed slice would lose member tiles without warning.
			const members = g.memberIds.map((id) => byId.get(id)).filter((x): x is Block => !!x);
			if (!g.folded) {
				// UNFOLDED — members live. folded=false always wins over peek.
				rows.push({ type: "groupOpen", group: g, members, live: true });
			} else if (peeked.has(g.id)) {
				// PEEK — still folded (wire unchanged), members shown dull for preview only.
				rows.push({ type: "groupOpen", group: g, members, live: false });
			} else {
				// COLLAPSED — one parent tile.
				rows.push({ type: "group", group: g, members });
			}
			emitted.add(g);
		} else if (!emitted.has(g)) {
			// A member whose group was never emitted (its first member is absent from this
			// slice — an invariant violation): render it as a plain block so no tile is lost.
			rows.push({ type: "block", block: b });
		}
		// else: already emitted with its group → skip (it's behind/inside the parent).
	}
	return rows;
}

/** A run of plain/collapsed tiles that lays out as ONE uniform CSS grid. */
export type TilesSegment = { kind: "tiles"; rows: DisplayRow[] };
/** One OPEN group, rendered as a full-width band of natural height between grids. */
export type BandSegment = { kind: "band"; row: Extract<DisplayRow, { type: "groupOpen" }> };
export type DisplaySegment = TilesSegment | BandSegment;

/**
 * Split a display-row list into stacked segments so an OPEN group (`groupOpen`) never lives
 * inside the dense tile grid. An open group's band is multi-line (parent tile + member tiles
 * + actions) and a fixed-row CSS grid (`grid-auto-rows: var(--cell)`) would pin it to one
 * cell-height track — its content then overflows and overlaps the next row, tearing the grid.
 *
 * Instead each maximal run of `block` + COLLAPSED-`group` rows becomes a `tiles` segment (one
 * uniform grid), and every `groupOpen` row becomes its own `band` segment. The component
 * renders the segments as a vertical stack: grid · band · grid · …, so each band gets its
 * natural height and the surrounding tile grids stay perfectly uniform. A COLLAPSED group is a
 * single square, so it stays INSIDE the tile grid — only open groups break the flow. Pure.
 */
export function segmentDisplay(rows: DisplayRow[]): DisplaySegment[] {
	const segs: DisplaySegment[] = [];
	let cur: DisplayRow[] | null = null;
	for (const r of rows) {
		if (r.type === "groupOpen") {
			if (cur) {
				segs.push({ kind: "tiles", rows: cur });
				cur = null;
			}
			segs.push({ kind: "band", row: r });
		} else {
			(cur ??= []).push(r);
		}
	}
	if (cur) segs.push({ kind: "tiles", rows: cur });
	return segs;
}

// ---------------------------------------------------------------------------
// buildLane — sliver-mode lane grouping helper (pure, no store import)
// ---------------------------------------------------------------------------

/**
 * A single item in the sliver-mode lane for a `tiles` segment.
 *
 * - `tile`  — a live (non-folded) block → a full square cell.
 * - `fold`  — ONE ungrouped folded block. Folding substitutes the block's content for a
 *             digest, which is a real synthetic "cocoa" block now in the context; the lane
 *             shows that cocoa block plus the original as a thin sliver. Adjacent ungrouped
 *             folds are NEVER merged — each folded block is its own `fold` item (1 cocoa +
 *             1 sliver). Adjacency is not grouping.
 * - `group` — a collapsed ADR-0006 group → ONE shared cocoa summary block + its N member
 *             slivers. A shared summary only ever comes from an explicit group.
 *
 * Tiles-segment rows only contain `block` and `group` rows (open groups are `band`
 * segments, handled separately); `groupOpen` never reaches here.
 */
export type LaneItem =
	| { kind: "tile"; block: Block }
	| { kind: "fold"; block: Block }
	| { kind: "group"; group: Group; members: Block[] };

export function buildLane(
	rows: DisplayRow[],
	isFolded: (b: Block) => boolean,
): LaneItem[] {
	const items: LaneItem[] = [];
	for (const row of rows) {
		if (row.type === "group") {
			items.push({ kind: "group", group: row.group, members: row.members });
		} else if (row.type === "block") {
			const b = row.block;
			items.push(isFolded(b) ? { kind: "fold", block: b } : { kind: "tile", block: b });
		}
	}
	return items;
}
