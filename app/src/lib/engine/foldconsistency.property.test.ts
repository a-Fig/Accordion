import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import { wireFoldable } from "./digest";
import { computeFoldOps } from "../live/plan";
import type { Block, BlockKind, ParsedSession } from "./types";

/*
 * Property-style consistency pin for the KIND foldability gate. A seeded PRNG generates
 * MANY random sessions + operation sequences (no Math.random, no fast-check — both forbidden
 * here) and asserts two invariants after each random op:
 *
 *   UNIVERSAL — a block that reads folded and is NOT a collapsed folded-group member must
 *   be a wire-foldable kind. This is the "no UI lie" guarantee: the view can never recess a
 *   tile / count savings for a block the wire would receive whole. (No group ops are issued
 *   here, so the group caveat is vacuously satisfied, but we keep the guard literal.)
 *
 *   LIVE-SET EQUALITY (variant A, durable ids only) — the set of ids the store renders folded
 *   (minus collapsed group members) equals exactly the set `computeFoldOps` would emit on the
 *   wire. This is the guarantee the live link relies on: what the screen folds is what the
 *   agent's context loses. For variant B (non-durable ids) `computeFoldOps` drops everything
 *   on the durable-id guard, so the equality is NOT expected and is not asserted.
 *
 * On failure the seed + offending block are embedded in the message so any failure replays.
 */

// mulberry32 — a tiny deterministic PRNG. Seeded per iteration so every failure is reproducible.
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const KINDS: BlockKind[] = ["user", "text", "thinking", "tool_call", "tool_result"];

type IdShape = "durable" | "nondurable";

/** Durable id prefixes (mirror `isDurableId`): u:/a:/r:/s:. */
function durableId(kind: BlockKind, n: number): string {
	switch (kind) {
		case "user":
			return `u:${n}`;
		case "tool_result":
			return `r:${n}`;
		case "tool_call":
			// a tool_call is an assistant-message part — durable shape a:<eid>:p<j>
			return `a:${n}:p0`;
		default:
			// text / thinking are assistant-message parts
			return `a:${n}:p0`;
	}
}

/** On-disk-style NON-durable ids (positional fallback): `<eventId>:p<j>` / `:u` / `:r`. */
function nonDurableId(kind: BlockKind, n: number): string {
	switch (kind) {
		case "user":
			return `${n}:u`;
		case "tool_result":
			return `${n}:r`;
		default:
			return `${n}:p0`;
	}
}

/** Build one random session of `len` blocks for the given id shape. */
function genSession(rnd: () => number, len: number, shape: IdShape): Block[] {
	const blocks: Block[] = [];
	let turn = 1;
	let nextCallId = 1;
	// Track an open tool_call awaiting its result so a tool_result can share its callId.
	let pendingCall: { callId: string } | null = null;
	for (let i = 0; i < len; i++) {
		// Ascending (non-strict) turns.
		if (rnd() < 0.35) turn++;
		let kind = KINDS[Math.floor(rnd() * KINDS.length)];
		// A tool_result is only meaningful if there is a call to pair it with; otherwise reroll.
		if (kind === "tool_result" && !pendingCall) kind = "thinking";
		const tokens = 1 + Math.floor(rnd() * 6000);
		let callId: string | undefined;
		if (kind === "tool_call") {
			callId = `c${nextCallId++}`;
			pendingCall = { callId };
		} else if (kind === "tool_result") {
			callId = pendingCall!.callId;
			pendingCall = null;
		}
		const id = shape === "durable" ? durableId(kind, i) : nonDurableId(kind, i);
		blocks.push({
			id,
			kind,
			turn,
			order: i,
			text: `${id} ` + "x".repeat(Math.min(tokens, 200) * 4),
			tokens,
			callId,
			override: null,
			autoFolded: false,
			by: null,
		});
	}
	return blocks;
}

function makeStore(blocks: Block[]): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks,
		lineCount: 0,
		skipped: 0,
	};
	return new AccordionStore(parsed);
}

/** The store's currently-folded set, excluding collapsed folded-group members. */
function foldedSet(s: AccordionStore): Set<string> {
	const out = new Set<string>();
	for (const b of s.blocks) {
		if (s.isFolded(b) && !s.groupOf(b)?.folded) out.add(b.id);
	}
	return out;
}

function checkInvariants(s: AccordionStore, seed: number, shape: IdShape): void {
	// UNIVERSAL — every folded (non-collapsed-group-member) block is a wire-foldable kind.
	for (const b of s.blocks) {
		if (s.isFolded(b) && !s.groupOf(b)?.folded) {
			expect(
				wireFoldable(b),
				`seed=${seed} shape=${shape}: block ${b.id} (kind=${b.kind}) reads folded but is NOT wire-foldable`,
			).toBe(true);
		}
	}
	// LIVE-SET EQUALITY — only meaningful for durable ids (computeFoldOps drops non-durable).
	if (shape === "durable") {
		const folded = foldedSet(s);
		const opIds = new Set(computeFoldOps(s).map((o) => o.id));
		expect(
			[...folded].sort(),
			`seed=${seed} shape=durable: store-folded set != computeFoldOps id set`,
		).toEqual([...opIds].sort());
	}
}

function runOne(seed: number, shape: IdShape): void {
	const rnd = mulberry32(seed);
	const len = 3 + Math.floor(rnd() * 18); // 3..20 blocks
	const s = makeStore(genSession(rnd, len, shape));
	const ids = s.blocks.map((b) => b.id);

	checkInvariants(s, seed, shape); // initial state

	const opCount = 5 + Math.floor(rnd() * 15); // 5..19 ops
	for (let k = 0; k < opCount; k++) {
		const pick = () => ids[Math.floor(rnd() * ids.length)];
		const r = rnd();
		if (r < 0.22) s.fold(pick());
		else if (r < 0.4) s.pin(pick());
		else if (r < 0.55) s.unpin(pick());
		else if (r < 0.72) s.unfold(pick());
		else if (r < 0.86) s.setBudget(Math.floor(rnd() * 80_000));
		else s.setProtect(Math.floor(rnd() * 60_000));
		checkInvariants(s, seed, shape);
	}
}

describe("fold consistency — kind gate holds across random sessions + op sequences", () => {
	it("variant A (durable ids): folded-set == computeFoldOps and only foldable kinds fold", () => {
		for (let seed = 1; seed <= 220; seed++) runOne(seed, "durable");
	});

	it("variant B (non-durable ids): only foldable kinds ever read folded", () => {
		// computeFoldOps drops non-durable ids, so live-set equality is not expected here;
		// the universal kind invariant must still hold.
		for (let seed = 1001; seed <= 1221; seed++) runOne(seed, "nondurable");
	});
});
