import { describe, expect, it } from "vitest";
import { fitCalibration } from "./calibration";

describe("fitCalibration", () => {
	it("uses an additive anchor for the first receipt so fresh content is not amplified", () => {
		expect(fitCalibration([{ est: 1000, real: 2500 }])).toEqual({ scale: 1, base: 1500 });
	});

	it("learns fixed overhead and anchors the fit through the latest real receipt", () => {
		const fit = fitCalibration([
			{ est: 491, real: 13_466 },
			{ est: 891, real: 14_168 },
			{ est: 2539, real: 15_943 },
		]);
		expect(fit).not.toBeNull();
		expect(fit!.base + fit!.scale * 2539).toBeCloseTo(15_943, 8);
		// Issue #102: adding an ~8.8k-token tool result should add roughly that much, not multiply
		// the entire new total by the old fixed-overhead-heavy ratio (which produced ~71.5k).
		expect(Math.round(fit!.base + fit!.scale * 11_390)).toBeLessThan(30_000);
	});

	it("ignores invalid observations and rejects a non-positive regression slope", () => {
		expect(
			fitCalibration([
				{ est: Number.NaN, real: 1 },
				{ est: 100, real: 200 },
				{ est: 200, real: 100 },
			]),
		).toEqual({ scale: 1, base: -100 });
	});
});
