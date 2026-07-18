/*
 * replica.test.ts — Phase B (de)serialization round trip (core/replica.ts).
 *
 * Covers the review finding that `SnapshotState` used to omit `birthFolded`: a replica hydrated
 * via snapshot after a birth-fold started with an EMPTY birth-fold set, so its very next
 * housekeep healed the block locally while the host kept it folded — a silent divergence neither
 * side's `rev` bookkeeping could catch (both still bump by exactly one).
 */
import { describe, it, expect } from "vitest";
import { Truth } from "./truth";
import type { Block, SessionMeta } from "./types";
import type { WireEvent } from "./protocol";
import { serializeSnapshot, hydrateSnapshot, wireEventFromTruthEvent } from "./replica";

const META: SessionMeta = { format: "pi", title: "t", cwd: "", model: "" };

function blk(id: string, order: number, tokens = 1000): Block {
	return { id, kind: "text", turn: order + 1, order, text: `${id} ` + "x".repeat(tokens * 4), tokens, override: null, autoFolded: false, by: null };
}
function live(): Truth {
	return new Truth({ meta: META, blocks: [], lineCount: 0, skipped: 0 });
}
function seq(n: number, tokens = 1000): Block[] {
	return Array.from({ length: n }, (_, i) => blk(`a:b${i}:p0`, i, tokens));
}

describe("replica — birthFolded round trip (protocol v12)", () => {
	it("serializeSnapshot → hydrateSnapshot preserves birth-fold membership, so a grown tail does NOT heal it — while a stale format (birthFolded lost) WOULD heal it", () => {
		const host = live();
		host.append(seq(6, 1000));
		host.setProtect(2000); // protects the newest ~2 blocks
		const newest = host.blocks[host.blocks.length - 1];
		expect(host.isProtected(newest)).toBe(true);
		expect(host.sent(newest)).toBe(false); // live + never sent → eligible for the birth-fold exemption

		const r = host.apply([{ kind: "fold", ids: [newest.id] }], "auto"); // birth-fold: protected + unsent
		expect(r.results[0].applied).toBe(true);
		expect(host.isFolded(host.get(newest.id)!)).toBe(true);

		const state = serializeSnapshot(host, false);
		expect(state.birthFolded).toContain(newest.id);

		// The correct replica: birthFolded carried over by adoptSnapshot. Growing the tail further
		// re-runs housekeep/healProtected on the replica — the birth-fold must survive it, exactly
		// as it does on the host (core/truth.test.ts's "Truth — birth-fold" suite).
		const replica = hydrateSnapshot(META, state);
		replica.setProtect(1_000_000); // tail grows to cover everything → triggers a housekeep pass
		expect(replica.isFolded(replica.get(newest.id)!)).toBe(true); // survives — never seen whole

		// A stale-format peer that lost `birthFolded` (the pre-fix bug: `adoptSnapshot` used to do
		// `this.birthFolded.clear()` unconditionally) heals the SAME block on the SAME trigger —
		// proving this assertion actually exercises the fix, not some other invariant.
		const staleReplica = hydrateSnapshot(META, { ...state, birthFolded: [] });
		staleReplica.setProtect(1_000_000);
		expect(staleReplica.isFolded(staleReplica.get(newest.id)!)).toBe(false); // healed — the bug
	});
});

// Fix #1: the replica-facing event must forward ONLY the ids that actually applied on the host, so
// a per-id clamp (one `stale` id in a multi-id batch) never re-applies on a baseRev-less replica.
describe("replica — wireEventFromTruthEvent forwards only applied ids (fix #1)", () => {
	it("rewrites a partially-clamped multi-id fold to carry only the applied id", () => {
		const t = live();
		t.append(seq(3, 1000));
		t.setProtect(0);
		const base = t.rev;
		t.apply([{ kind: "pin", ids: ["a:b1:p0"] }], "you"); // B touched → stale vs base
		const events: WireEvent[] = [];
		const off = t.onEvent((e) => {
			const w = wireEventFromTruthEvent(e);
			if (w) events.push(w);
		});
		t.apply([{ kind: "fold", ids: ["a:b0:p0", "a:b1:p0"] }], "you", base); // A applies, B stale
		off();
		const opsEv = events.find((w): w is Extract<WireEvent, { kind: "ops" }> => w.kind === "ops");
		expect(opsEv?.ops).toEqual([{ kind: "fold", ids: ["a:b0:p0"] }]); // B (stale) dropped from the wire op
	});
});

// Fix #2: `carriedSent` must round-trip a snapshot or a replica reclassifies a sent block as fresh
// (birth-fold-eligible / back in freshIds) — the same invisible-divergence class as v12's birthFolded.
describe("replica — carriedSent round trip (protocol v15)", () => {
	it("serializeSnapshot → hydrateSnapshot preserves per-id carried sent-ness across an insert-before rebuild", () => {
		const host = live();
		host.append(seq(2, 1000)); // A(order0), B(order1)
		host.markSent(1); // both sent
		const fresh: Block[] = [
			blk("a:new:p0", 0, 1000), // X — new, unsent, inserted before A/B
			blk("a:b0:p0", 1, 1000),
			blk("a:b1:p0", 2, 1000),
		];
		const rebuilt = Truth.rebuildFrom(host, { meta: META, blocks: fresh, lineCount: 0, skipped: 0 });
		expect(rebuilt.carriedSentIds).toEqual(expect.arrayContaining(["a:b0:p0", "a:b1:p0"]));

		const state = serializeSnapshot(rebuilt, false);
		expect(state.carriedSent).toEqual(expect.arrayContaining(["a:b0:p0", "a:b1:p0"]));

		const replica = hydrateSnapshot(META, state);
		expect(replica.sent(replica.get("a:b0:p0")!)).toBe(true); // carried across the wire
		expect(replica.sent(replica.get("a:new:p0")!)).toBe(false);

		// A stale-format peer that lost carriedSent reclassifies the sent block as fresh — the bug this closes.
		const stale = hydrateSnapshot(META, { ...state, carriedSent: [] });
		expect(stale.sent(stale.get("a:b0:p0")!)).toBe(false);
	});
});
