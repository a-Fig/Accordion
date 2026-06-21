import { describe, expect, it } from "vitest";
import { computeHealthVerdict, computeNeededStats, healthFromStore, normalizeDiagnostics, pressureLabel } from "./conductorDiagnostics";
import type { DecisionEvent } from "$lib/engine/store.svelte";

describe("conductor diagnostics normalization", () => {
	it("normalizes typed details and legacy summary cache shape", () => {
		const diagnostics = normalizeDiagnostics({
			health: {
				foldTargetCalibrated: 0.81,
				foldTargetThisTurn: 0.78,
				foldTargetBand: { min: 0.6, max: 0.92 },
				assembledTokens: 12000,
				budgetTokens: 20000,
				pressure: "comfortable",
			},
			unitTrace: [{ id: "u1", blockIds: ["b1"], fullTokens: 1000, level: 2, eligible: true, stage: "embed" }],
			factLedger: [{ category: "paths", value: "app.ts", turn: 3 }],
			relevanceTOC: [{ turn: 3, score: 0.7, label: "routing" }],
			summary: { provider: "host", cached: 4, pending: 1, errors: 0 },
		});

		expect(diagnostics.health?.foldTargetCalibrated).toBe(0.81);
		expect(diagnostics.unitTrace?.[0].stage).toBe("embed");
		expect(diagnostics.factLedger?.[0].category).toBe("paths");
		expect(diagnostics.caches?.summary?.size).toBe(4);
		expect(diagnostics.caches?.summary?.pending).toBe(1);
	});

	it("computes pressure labels and health verdicts", () => {
		expect(pressureLabel(600, 1000)).toBe("comfortable");
		expect(pressureLabel(800, 1000)).toBe("normal");
		expect(pressureLabel(900, 1000)).toBe("tight");

		const verdict = computeHealthVerdict(
			[
				{ id: "a", blockIds: ["a"], fullTokens: 100, level: 2, eligible: true },
				{ id: "b", blockIds: ["b"], fullTokens: 100, level: 0, eligible: true },
			],
			{ assembledTokens: 500, budgetTokens: 1000 },
			{ needed: 0, harmless: 0, pending: 1, resolved: 0, neededRate: null },
		);
		expect(verdict.level).toBe("green");
		expect(verdict.foldCoverage).toBe(0.5);
		expect(verdict.withinBudget).toBe(true);
	});

	it("does not mark low fold coverage red while the session is comfortably under budget", () => {
		const verdict = computeHealthVerdict(
			[
				{ id: "a", blockIds: ["a"], fullTokens: 100, level: 0, eligible: true },
				{ id: "b", blockIds: ["b"], fullTokens: 100, level: 0, eligible: true },
			],
			{ assembledTokens: 500, budgetTokens: 1000, pressure: "comfortable" },
			{ needed: 0, harmless: 0, pending: 0, resolved: 0, neededRate: null },
		);
		expect(verdict.foldCoverage).toBe(0);
		expect(verdict.withinBudget).toBe(true);
		expect(verdict.level).toBe("green");
	});

	it("labels conductor folds later opened by a human or agent as needed", () => {
		const events: DecisionEvent[] = [
			{ n: 1, at: 1, by: "you", action: "unfold", ids: ["b1"], detail: "b1", turn: 1 },
			{ n: 0, at: 0, by: "auto", action: "fold", ids: ["b1"], detail: "b1", turn: 1 },
		];
		const stats = computeNeededStats(events);
		expect(stats.needed).toBe(1);
		expect(stats.neededRate).toBe(1);
	});

	it("settles older still-folded attempts as harmless", () => {
		const events: DecisionEvent[] = [
			{ n: 0, at: 0, by: "auto", action: "fold", ids: ["b1"], detail: "b1", turn: 1 },
		];
		const stats = computeNeededStats(events, 2);
		expect(stats).toMatchObject({ needed: 0, harmless: 1, pending: 0, resolved: 1, neededRate: 0 });
	});

	it("keeps a needed result when a later auto re-fold starts a new pending attempt", () => {
		const events: DecisionEvent[] = [
			{ n: 2, at: 2, by: "auto", action: "fold", ids: ["b1"], detail: "b1", turn: 2 },
			{ n: 1, at: 1, by: "agent", action: "unfold", ids: ["b1"], detail: "b1", turn: 1 },
			{ n: 0, at: 0, by: "auto", action: "fold", ids: ["b1"], detail: "b1", turn: 1 },
		];
		const stats = computeNeededStats(events, 2);
		expect(stats.needed).toBe(1);
		expect(stats.pending).toBe(1);
		expect(stats.neededRate).toBe(1);
	});

	it("leaves current-turn attempts pending while older attempts sweep harmless", () => {
		const events: DecisionEvent[] = [
			{ n: 1, at: 1, by: "auto", action: "fold", ids: ["b2"], detail: "b2", turn: 2 },
			{ n: 0, at: 0, by: "auto", action: "fold", ids: ["b1"], detail: "b1", turn: 1 },
		];
		const stats = computeNeededStats(events, 2);
		expect(stats.harmless).toBe(1);
		expect(stats.pending).toBe(1);
		expect(stats.neededRate).toBe(0);
	});

	it("counts group attempts once by group id", () => {
		const events: DecisionEvent[] = [
			{ n: 0, at: 0, by: "auto", action: "group", ids: ["g:m0:p0", "m0:p0", "m1:p0"], detail: "2 blocks", turn: 1, kind: "group" },
		];
		const stats = computeNeededStats(events, 2);
		expect(stats.harmless).toBe(1);
		expect(stats.resolved).toBe(1);
	});

	it("labels an auto group opened by a human as needed", () => {
		const events: DecisionEvent[] = [
			{ n: 1, at: 1, by: "you", action: "unfold-group", ids: ["g:m0:p0", "m0:p0", "m1:p0"], detail: "2 blocks", turn: 1, kind: "group" },
			{ n: 0, at: 0, by: "auto", action: "group", ids: ["g:m0:p0"], detail: "2 blocks", turn: 1, kind: "group" },
		];
		const stats = computeNeededStats(events, 1);
		expect(stats.needed).toBe(1);
		expect(stats.neededRate).toBe(1);
	});

	it("uses the smaller context window as fallback pressure basis", () => {
		const health = healthFromStore(undefined, 90_000, 200_000, 100_000);
		expect(health.budgetTokens).toBe(100_000);
		expect(health.pressure).toBe("tight");
	});
});
