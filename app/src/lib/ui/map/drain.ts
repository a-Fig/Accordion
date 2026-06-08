/*
 * drain.ts — the "drain without reflow" bookkeeping for the protected box.
 *
 * When a block ages out of the protected working tail it should leave an empty
 * slot rather than pulling its neighbours back a cell. Holes accumulate at the
 * FRONT of the protected grid (the oldest end, where blocks depart). We only
 * reclaim that space — letting tiles move — when a whole leading row has emptied
 * out, or when a resize re-flows the grid anyway.
 *
 * This is the pure core of that rule: given the previous state and the new
 * boundary/column count, return how many leading placeholder cells to render.
 * Kept dependency-free so it can be unit-tested without a DOM.
 */
export function nextVacated(
	prevVacated: number,
	prevBoundary: number,
	boundary: number,
	prevCols: number,
	cols: number,
	forceReset = false,
): number {
	// A boundary can move for reasons that are NOT a block aging out of the tail:
	// the whole session was swapped, or the user dragged the protected-size slider.
	// Those are clean re-flows, so the caller passes forceReset to drop every hole
	// rather than mistaking the jump for a flurry of departures.
	if (forceReset) return 0;

	// A resize changes the grid geometry → everything re-flows regardless, so
	// holding stale holes would be meaningless. Start clean.
	if (cols !== prevCols) return 0;

	const drained = boundary - prevBoundary;

	// Blocks left the protected tail: add a hole per departure, then reclaim any
	// fully-empty leading rows so the tiles shift up at most once per row.
	if (drained > 0) {
		let v = prevVacated + drained;
		while (cols > 0 && v >= cols) v -= cols;
		return v;
	}

	// The tail widened (blocks returned to protection). A returning block re-enters at
	// the FRONT/oldest end of the protected grid — exactly where the leading holes are —
	// so it consumes one existing hole rather than displacing the surviving tiles. Refill
	// one hole per returning block, clamped at 0; dropping all holes here would slide the
	// remaining protected tiles up and reflow the grid (the very thing this prevents).
	if (drained < 0) return Math.max(0, prevVacated + drained);

	// No boundary movement → leave the holes exactly as they are.
	return prevVacated;
}
