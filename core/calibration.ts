/** One provider receipt paired with Accordion's estimate of the same departing wire. */
export interface TokenObservation {
	est: number;
	real: number;
}

export interface AffineCalibration {
	/** Scale applied to estimated message/token deltas. */
	scale: number;
	/** Fixed request overhead (system/tool schemas/provider framing), applied once to totals. */
	base: number;
}

/**
 * Fit `real = base + scale * est` over recent provider observations.
 *
 * The slope comes from ordinary least squares, while the intercept is re-anchored through the
 * newest observation. That makes the latest provider receipt exact (no smoothing lag in the hero
 * total) and uses history only to decide how quickly newly appended raw estimates should grow.
	 * With fewer than two distinct estimates, use the conservative additive anchor (`scale = 1`):
	 * the latest real receipt stays exact and trailing chars/4 estimates cannot be amplified by fixed
	 * overhead before a second observation makes the slope identifiable.
 */
export function fitCalibration(observations: readonly TokenObservation[]): AffineCalibration | null {
	const valid = observations.filter(
		(point) => Number.isFinite(point.est) && point.est > 0 && Number.isFinite(point.real) && point.real > 0,
	);
	if (!valid.length) return null;
	const latest = valid[valid.length - 1];
	const additiveAnchor = (): AffineCalibration => ({ scale: 1, base: latest.real - latest.est });
	if (valid.length === 1) return additiveAnchor();

	const meanEst = valid.reduce((sum, point) => sum + point.est, 0) / valid.length;
	const meanReal = valid.reduce((sum, point) => sum + point.real, 0) / valid.length;
	const variance = valid.reduce((sum, point) => sum + (point.est - meanEst) ** 2, 0);
	if (!(variance > 0) || !Number.isFinite(variance)) return additiveAnchor();

	const covariance = valid.reduce(
		(sum, point) => sum + (point.est - meanEst) * (point.real - meanReal),
		0,
	);
	const scale = covariance / variance;
	if (!Number.isFinite(scale) || scale <= 0) return additiveAnchor();

	return { scale, base: latest.real - scale * latest.est };
}
