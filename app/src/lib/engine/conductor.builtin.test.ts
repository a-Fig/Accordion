import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "./parse";
import { AccordionStore } from "./store.svelte";

/*
 * GOLDEN regression for the built-in conductor (the engine's auto-folder).
 *
 * The M1 rewire (ADR 0007) extracts the folder's decision logic into a
 * `BuiltinConductor` that flows through the new command-apply path. The whole point
 * of that change is that it is BYTE-IDENTICAL: the same sample, budget, and protect
 * target must fold exactly the same blocks before and after the refactor.
 *
 * This file is the pin. It is written and snapshotted against the CURRENT store
 * (before any seam change) so the captured fold set is ground truth. Every later step
 * must keep it green. The aggregate counts are inline (visible, hard to drift past
 * review); the full folded-id set is an external snapshot.
 */

const SAMPLE = readFileSync(
	fileURLToPath(new URL("../../../static/sample-session.jsonl", import.meta.url)),
	"utf8",
);

/** The default view a freshly-loaded session shows: budget 70k, protect 20k. */
function defaultStore(): AccordionStore {
	return new AccordionStore(parse(SAMPLE));
}

/** A stable, comparable digest of the store's current fold decision. */
function foldShape(s: AccordionStore) {
	const foldedIds = s.blocks.filter((b) => s.isFolded(b)).map((b) => b.id).sort();
	return {
		foldedCount: s.foldedCount,
		liveTokens: s.liveTokens,
		savedTokens: s.savedTokens,
		fullTokens: s.fullTokens,
		foldedIds,
	};
}

describe("built-in conductor — golden fold of the sample session", () => {
	it("folds the sample identically at default budget/protect", () => {
		const s = defaultStore();
		const shape = foldShape(s);

		// Sanity: the sample must actually exercise the folder.
		expect(s.blocks.length).toBeGreaterThan(900);
		expect(shape.foldedCount).toBeGreaterThan(0);

		// Headline aggregates — inline so a regression is visible in the diff.
		expect({
			blocks: s.blocks.length,
			foldedCount: shape.foldedCount,
			liveTokens: shape.liveTokens,
			savedTokens: shape.savedTokens,
			fullTokens: shape.fullTokens,
		}).toMatchInlineSnapshot(`
			{
			  "blocks": 982,
			  "foldedCount": 300,
			  "fullTokens": 133571,
			  "liveTokens": 69879,
			  "savedTokens": 63692,
			}
		`);

		// The exact set of folded ids — external snapshot (large, but the real golden).
		expect(shape.foldedIds).toMatchSnapshot("folded-ids");
	});

	it("respects the budget: live context fits under 70k after folding", () => {
		const s = defaultStore();
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
	});

	it("never folds a protected-tail block", () => {
		const s = defaultStore();
		const pf = s.protectedFromIndex;
		s.blocks.forEach((b, i) => {
			if (i >= pf) expect(s.isFolded(b)).toBe(false);
		});
	});
});
