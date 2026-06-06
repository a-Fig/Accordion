/*
 * ghostState.test.ts — unit tests for the ghost state machine.
 *
 * Tests the add / remove / clear invariants for the presentation-only
 * "forming ghost" state introduced in Phase 4 of ADR 0003.
 *
 * Ghosts NEVER enter store.blocks — these tests confirm the state machine
 * independently; the block model is not touched here.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ghosts, ghostStart, ghostEnd, ghostClearAll } from "./ghostState.svelte";

// Reset ghost state before each test so tests are isolated.
beforeEach(() => {
	ghostClearAll();
});

describe("ghostStart — adds / refreshes a ghost", () => {
	it("adds a ghost for a new contentIndex", () => {
		ghostStart("thinking", 0);
		expect(ghosts.length).toBe(1);
		expect(ghosts[0]).toEqual({ contentIndex: 0, kind: "thinking" });
	});

	it("adds multiple ghosts for different contentIndexes", () => {
		ghostStart("thinking", 0);
		ghostStart("text", 1);
		ghostStart("tool_call", 2);
		expect(ghosts.length).toBe(3);
		expect(ghosts.map((g) => g.contentIndex)).toEqual([0, 1, 2]);
	});

	it("refreshes an existing ghost (same contentIndex, new kind)", () => {
		ghostStart("thinking", 0);
		ghostStart("text", 0); // update in place
		expect(ghosts.length).toBe(1);
		expect(ghosts[0].kind).toBe("text");
	});
});

describe("ghostEnd — removes a specific ghost", () => {
	it("removes the ghost matching contentIndex", () => {
		ghostStart("thinking", 0);
		ghostStart("text", 1);
		ghostEnd(0);
		expect(ghosts.length).toBe(1);
		expect(ghosts[0].contentIndex).toBe(1);
	});

	it("is a no-op when the contentIndex is not found", () => {
		ghostStart("text", 2);
		ghostEnd(99); // unknown index
		expect(ghosts.length).toBe(1);
	});

	it("clears the list when the only ghost is removed", () => {
		ghostStart("tool_call", 5);
		ghostEnd(5);
		expect(ghosts.length).toBe(0);
	});
});

describe("ghostClearAll — abort sweep", () => {
	it("clears all active ghosts", () => {
		ghostStart("thinking", 0);
		ghostStart("text", 1);
		ghostStart("tool_call", 2);
		ghostClearAll();
		expect(ghosts.length).toBe(0);
	});

	it("is idempotent when already empty", () => {
		ghostClearAll();
		ghostClearAll();
		expect(ghosts.length).toBe(0);
	});
});

describe("ghost lifecycle — start → end / abort", () => {
	it("start then end resolves cleanly: no ghost remains", () => {
		ghostStart("text", 3);
		expect(ghosts.length).toBe(1);
		ghostEnd(3);
		expect(ghosts.length).toBe(0);
	});

	it("start then abort-all sweeps: no ghost remains", () => {
		ghostStart("thinking", 0);
		ghostStart("text", 1);
		ghostClearAll(); // abort sweep (contentIndex < 0 path maps to clearAll in the client)
		expect(ghosts.length).toBe(0);
	});

	it("a ghost is only removed, never converted (invariant: ghosts never become blocks)", () => {
		// This test asserts the state machine never holds a "committed" state —
		// the only transitions are add → remove. There is no "convert" operation.
		ghostStart("text", 7);
		const snapshotBefore = { ...ghosts[0] };
		ghostEnd(7);
		// The ghost is gone; no block was produced by this module.
		expect(ghosts.length).toBe(0);
		// The snapshot is unrelated to any store — this module has no import of
		// store.svelte.ts and exports no Block type. The assertion is structural.
		expect(snapshotBefore.kind).toBe("text");
	});
});
