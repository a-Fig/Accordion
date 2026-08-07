import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import type { LockName } from "./locks";
import { LOCK_NAMES, LOCK_LABELS, hasLock, isExclusive } from "./locks";
import type { Block, ParsedSession } from "./types";
import { foldCode } from "./digest";

/*
 * ADR 0011 — involvement locks, restored as an ENGINE capability.
 *
 * "Human overrides always win" becomes "human overrides win for every control the holder did
 * NOT lock." A lock-set is set programmatically via `store.setLocks(locks, holder, tailTokens?)`
 * and released via `store.clearLocks()`; NO conductor object is involved (the strategy layer is
 * gone). The engine gates the named human/agent controls and (under `tail-size`) drives the
 * protected tail from the holder's declared `tailTokens`.
 *
 * The future host drives folds as the non-human "auto" actor; these tests use `by:"auto"` the
 * same way, since acquiring `human-steering` releases every HUMAN hold — the only standing folds
 * a human can be locked out of are strategy-owned (non-human) ones.
 */

// Durable, foldable ids (`a:…:p0`) so the resolveUnfold / resolveRecall paths match.
function blk(i: number, kind: Block["kind"] = "text", tokens = 1000, extra: Partial<Block> = {}): Block {
	return {
		id: `a:b${i}:p0`,
		kind,
		turn: i + 1,
		order: i,
		text: `block ${i} ` + "x".repeat(tokens * 4),
		tokens,
		override: null,
		autoFolded: false,
		by: null,
		...extra,
	};
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

// ── the vocabulary (locks.ts) ────────────────────────────────────────────────
describe("ADR 0011 — lock vocabulary", () => {
	it("LOCK_NAMES is the canonical ordered set; LOCK_LABELS describes each", () => {
		expect(LOCK_NAMES).toEqual(["human-steering", "agent-unfold", "tail-size"]);
		for (const n of LOCK_NAMES) expect(typeof LOCK_LABELS[n]).toBe("string");
	});
	it("hasLock / isExclusive", () => {
		expect(hasLock(["human-steering"], "human-steering")).toBe(true);
		expect(hasLock(["human-steering"], "tail-size")).toBe(false);
		expect(hasLock(undefined, "tail-size")).toBe(false);
		expect(isExclusive([])).toBe(false);
		expect(isExclusive(["agent-unfold"])).toBe(true);
		expect(isExclusive(undefined)).toBe(false);
	});
});

// ── human-steering ─────────────────────────────────────────────────────────────
describe("ADR 0011 — human-steering gates every human entry point", () => {
	it("collaborative (no lock): fold / pin / createGroup / resetAll all work", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);

		s.fold("a:b0:p0");
		expect(s.get("a:b0:p0")!.override).toBe("folded");
		s.pin("a:b1:p0");
		expect(s.get("a:b1:p0")!.override).toBe("pinned");
		const g = s.createGroup("a:b2:p0", "a:b3:p0");
		expect(g).not.toBeNull();
		expect(s.groups.length).toBe(1);
		s.resetAll();
		expect(s.blocks.every((b) => b.override === null)).toBe(true);
		expect(s.groups.length).toBe(0);
	});

	it("locked: fold / pin / createGroup are no-ops (no human override appears)", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.setLocks(["human-steering"], "test-host");

		s.fold("a:b0:p0");
		expect(s.get("a:b0:p0")!.override).toBe(null); // refused
		s.pin("a:b1:p0");
		expect(s.get("a:b1:p0")!.override).toBe(null); // refused
		const g = s.createGroup("a:b2:p0", "a:b3:p0");
		expect(g).toBeNull(); // refused
		expect(s.groups.length).toBe(0);
		expect(s.blocks.every((b) => b.by !== "you")).toBe(true); // the human authored nothing
	});

	it("locked: resetAll is a hard no-op — a strategy-owned fold is left standing, no log", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.setLocks(["human-steering"], "test-host");
		// The strategy (non-human "auto" actor) folds a block — not gated by human-steering.
		s.fold("a:b0:p0", "auto");
		expect(s.isFolded(s.get("a:b0:p0")!)).toBe(true);

		s.resetAll(); // would normally clear all overrides + emit "reset"
		expect(s.isFolded(s.get("a:b0:p0")!)).toBe(true); // strategy fold untouched
		expect(s.log.some((e) => e.action === "reset")).toBe(false); // no log emitted
	});

	it("locked: toggle / unpin / auto / foldGroup / unfoldGroup / deleteGroup are no-ops on strategy state", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.setLocks(["human-steering"], "test-host");
		// The strategy folds b0 and groups b2..b3 (as "auto") — the human is locked out of both.
		s.fold("a:b0:p0", "auto");
		const g = s.createGroup("a:b2:p0", "a:b3:p0", "auto");
		expect(g).not.toBeNull();
		const groupId = g!.id;
		expect(s.groups[0].folded).toBe(true);

		// Every human entry point is refused — no human override appears, the group is untouched.
		s.toggle("a:b4:p0"); // human toggle
		expect(s.get("a:b4:p0")!.override).toBe(null);
		s.unfold("a:b0:p0"); // human can't unfold the strategy fold
		expect(s.isFolded(s.get("a:b0:p0")!)).toBe(true);
		s.auto("a:b0:p0"); // human can't clear the strategy fold
		// A strategy fold is `autoFolded` (override stays null so a human CAN re-override); the
		// refused human `auto()` leaves it untouched — still folded, still authored by the strategy.
		expect(s.isFolded(s.get("a:b0:p0")!)).toBe(true);
		expect(s.get("a:b0:p0")!.by).toBe("auto");
		s.unfoldGroup(groupId); // human can't unfold the strategy group
		s.deleteGroup(groupId); // human can't delete it
		expect(s.groups.length).toBe(1);
		expect(s.groups[0].folded).toBe(true);
		expect(s.blocks.every((b) => b.by !== "you")).toBe(true); // the human authored nothing
	});

	it("locked: the strategy's own fold still applies (only the HUMAN is gated)", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.setLocks(["human-steering"], "test-host");
		s.fold("a:b0:p0", "auto");
		expect(s.isFolded(s.get("a:b0:p0")!)).toBe(true);
		expect(s.get("a:b0:p0")!.by).toBe("auto");
	});

	it("observation is NEVER gated — reads still work under the lock", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.fold("a:b0:p0", "auto"); // strategy folds one block
		const foldedLive = s.liveTokens;
		expect(foldedLive).toBeLessThan(s.fullTokens);

		s.setLocks(["human-steering"], "test-host");
		// Every read surface still works and reflects the strategy fold — locking is about
		// touching, never seeing (ADR 0011 §3).
		expect(s.liveTokens).toBe(foldedLive);
		expect(s.foldedCount).toBe(1);
		expect(s.isFolded(s.get("a:b0:p0")!)).toBe(true);
		expect(typeof s.digestOf(s.get("a:b0:p0")!)).toBe("string");
		expect(s.canFold(s.get("a:b1:p0")!)).toBe(true); // foldability predicate still readable
	});
});

// ── agent-unfold ─────────────────────────────────────────────────────────────
describe("ADR 0011 — agent-unfold gates the agent's unfold ONLY", () => {
	it("locked: unfold(id,'agent') is refused and the block stays folded", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.fold("a:b0:p0", "auto");
		s.setLocks(["agent-unfold"], "test-host");
		expect(s.isFolded(s.get("a:b0:p0")!)).toBe(true);

		s.unfold("a:b0:p0", "agent"); // agent tries to force it open
		expect(s.isFolded(s.get("a:b0:p0")!)).toBe(true); // refused — stays folded
		expect(s.get("a:b0:p0")!.by).toBe("auto"); // no agent override written
	});

	it("locked: a HUMAN unfold STILL works (separate axis from agent-unfold)", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.fold("a:b0:p0", "auto");
		s.setLocks(["agent-unfold"], "test-host");
		expect(s.isFolded(s.get("a:b0:p0")!)).toBe(true);

		s.unfold("a:b0:p0", "you"); // human is NOT locked on this axis
		expect(s.isFolded(s.get("a:b0:p0")!)).toBe(false);
		expect(s.get("a:b0:p0")!.override).toBe("unfolded");
	});

	it("locked: recall is NEVER blocked — returns the block's ORIGINAL content, view unchanged", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		const full = s.get("a:b0:p0")!.text;
		s.fold("a:b0:p0", "auto");
		s.setLocks(["agent-unfold"], "test-host");

		const { restored, missing } = s.resolveRecall([foldCode("a:b0:p0")]);
		expect(missing).toEqual([]);
		expect(restored.length).toBe(1);
		expect(restored[0].text).toBe(full); // original content, not the digest
		expect(s.isFolded(s.get("a:b0:p0")!)).toBe(true); // read-only — still folded
	});

	it("locked: unfoldGroup(id,'agent') is refused — the agent can't unfold a GROUP through the lock", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		const g = s.createGroup("a:b0:p0", "a:b1:p0", "auto");
		expect(g).not.toBeNull();
		s.setLocks(["agent-unfold"], "test-host");
		expect(s.groups[0].folded).toBe(true);

		s.unfoldGroup(g!.id, "agent"); // agent tries to force the group open
		expect(s.groupById(g!.id)!.folded).toBe(true); // refused — group stays folded
	});

	it("collaborative: agent unfold works (the lock is what refuses it)", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.fold("a:b0:p0", "auto");
		expect(s.isFolded(s.get("a:b0:p0")!)).toBe(true);

		s.unfold("a:b0:p0", "agent");
		expect(s.isFolded(s.get("a:b0:p0")!)).toBe(false);
		expect(s.get("a:b0:p0")!.by).toBe("agent");
	});
});

// ── the two axes are independent (lock-restore review follow-up) ──────────────
describe("ADR 0011 — human-steering and agent-unfold are independent axes", () => {
	it("human-steering locked ALONE: the agent's unfold still works", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.fold("a:b0:p0", "auto"); // strategy fold
		s.setLocks(["human-steering"], "test-host"); // only the HUMAN is locked

		// The human is refused…
		s.unfold("a:b0:p0", "you");
		expect(s.isFolded(s.get("a:b0:p0")!)).toBe(true);
		// …but the agent's unfold axis is untouched, so it still forces the block open.
		s.unfold("a:b0:p0", "agent");
		expect(s.isFolded(s.get("a:b0:p0")!)).toBe(false);
		expect(s.get("a:b0:p0")!.by).toBe("agent");
	});

	it("BOTH human-steering AND agent-unfold locked: both axes refuse", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.fold("a:b0:p0", "auto"); // strategy fold
		s.setLocks(["human-steering", "agent-unfold"], "test-host"); // lock both axes

		// The human can't unfold…
		s.unfold("a:b0:p0", "you");
		expect(s.isFolded(s.get("a:b0:p0")!)).toBe(true);
		expect(s.get("a:b0:p0")!.by).toBe("auto"); // no human override written
		// …and neither can the agent — both axes are held.
		s.unfold("a:b0:p0", "agent");
		expect(s.isFolded(s.get("a:b0:p0")!)).toBe(true);
		expect(s.get("a:b0:p0")!.by).toBe("auto"); // no agent override written either
	});
});

// ── tail-size ─────────────────────────────────────────────────────────────
describe("ADR 0011 — tail-size lock drives protectedFromIndex", () => {
	it("locked (tailTokens omitted → 0): no protected tail; setProtect is a no-op", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(20_000); // would normally protect the whole small session
		expect(s.protectedFromIndex).toBe(0); // collaborative: all protected

		s.setLocks(["tail-size"], "test-host"); // no tailTokens → 0 → blocks.length
		expect(s.protectedFromIndex).toBe(s.blocks.length); // no host tail under the lock
		expect(s.blocks.every((b) => !s.isProtected(b))).toBe(true);

		const before = s.protectTokens;
		s.setProtect(5000);
		expect(s.protectTokens).toBe(before); // unchanged — the human can't resize the tail
		expect(s.protectedFromIndex).toBe(s.blocks.length);
	});

	it("locked with tailTokens=3000: walk-back protects the newest ~3k tokens", () => {
		const s = makeStore(Array.from({ length: 10 }, (_, i) => blk(i, "text", 1000)));
		s.setLocks(["tail-size"], "test-host", 3000);
		expect(s.protectedFromIndex).toBe(7); // blocks 7,8,9 protected (3×1000 = 3000 = target)
		for (let i = 0; i < 7; i++) expect(s.isProtected(s.get(`a:b${i}:p0`)!)).toBe(false);
		for (let i = 7; i < 10; i++) expect(s.isProtected(s.get(`a:b${i}:p0`)!)).toBe(true);
	});

	it("locked with a RECENT strategy fold: applied (no protected floor under the lock)", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(20_000); // the whole session would be the protected tail
		const newest = s.blocks[s.blocks.length - 1].id;
		s.setLocks(["tail-size"], "test-host");
		s.fold(newest, "auto"); // recent fold, allowed because the tail is now conductor policy
		expect(s.isFolded(s.get(newest)!)).toBe(true);
	});

	it("non-finite tailTokens (NaN) clamps to 0 (own everything), never poisons the boundary", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i, "text", 1000)));
		s.setProtect(20_000);
		s.setLocks(["tail-size"], "test-host", Number.NaN);
		expect(s.protectedFromIndex).toBe(s.blocks.length); // NaN → 0 → no tail (own everything)
		expect(s.blocks.every((b) => !s.isProtected(b))).toBe(true);
	});
});

// ── setLocks: consent → baseline release ─────────────────────────────────────
describe("ADR 0011 — setLocks releases holds in the newly-locked domain only", () => {
	it("human-steering releases human pin / fold / unfold AND human groups", () => {
		const s = makeStore(Array.from({ length: 6 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.pin("a:b0:p0");
		s.fold("a:b1:p0");
		s.unfold("a:b2:p0"); // human-held open
		const g = s.createGroup("a:b3:p0", "a:b4:p0"); // human group, by:"you"
		expect(g).not.toBeNull();
		expect(s.groups.length).toBe(1);

		s.setLocks(["human-steering"], "test-host");
		expect(s.get("a:b0:p0")!.override).toBe(null);
		expect(s.get("a:b0:p0")!.by).toBe(null);
		expect(s.get("a:b1:p0")!.override).toBe(null);
		expect(s.get("a:b2:p0")!.override).toBe(null);
		expect(s.groups.length).toBe(0); // human group dissolved for a clean field
	});

	it("agent-unfold releases ONLY agent sticky unfolds — human pin and human group stay", () => {
		const s = makeStore(Array.from({ length: 6 }, (_, i) => blk(i)));
		s.setProtect(0);
		// A strategy folds b0, the agent then unfolds it (sticky, by:"agent").
		s.fold("a:b0:p0", "auto");
		s.unfold("a:b0:p0", "agent");
		expect(s.get("a:b0:p0")!.by).toBe("agent");
		expect(s.get("a:b0:p0")!.override).toBe("unfolded");
		s.pin("a:b1:p0"); // human pin, different axis
		s.createGroup("a:b3:p0", "a:b4:p0"); // human group, different axis

		s.setLocks(["agent-unfold"], "test-host");
		expect(s.get("a:b0:p0")!.override).toBe(null); // agent unfold released
		expect(s.get("a:b1:p0")!.override).toBe("pinned"); // human pin untouched
		expect(s.groups.length).toBe(1); // human group survives — not the agent-unfold domain
		expect(s.groups[0].by).toBe("you");
	});
});

// ── clearLocks: restore human seniority ──────────────────────────────────────
describe("ADR 0011 — clearLocks restores everything", () => {
	it("human-steering: after clearLocks the human can steer again", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.setLocks(["human-steering"], "test-host");
		s.fold("a:b0:p0");
		expect(s.get("a:b0:p0")!.override).toBe(null); // refused while locked

		s.clearLocks();
		expect(s.isLocked("human-steering")).toBe(false);
		expect(s.lockHolder).toBe(null);
		s.fold("a:b0:p0");
		expect(s.get("a:b0:p0")!.override).toBe("folded"); // works again
	});

	it("tail-size: after clearLocks the protect target falls back to protectTokens", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(20_000);
		s.setLocks(["tail-size"], "test-host"); // tailTokens 0 → no host tail
		expect(s.protectedFromIndex).toBe(s.blocks.length);

		s.clearLocks();
		// protectTokens (20k) drives the walk-back again → the whole small session is protected.
		expect(s.protectedFromIndex).toBe(0);
		expect(s.blocks.every((b) => s.isProtected(b))).toBe(true);
	});

	it("clearLocks heals a strategy fold the restored protected tail now covers", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i, "text", 1000)));
		s.setProtect(20_000);
		s.setLocks(["tail-size"], "test-host"); // no tail → recent fold allowed
		const newest = s.blocks[s.blocks.length - 1].id;
		s.fold(newest, "auto");
		expect(s.isFolded(s.get(newest)!)).toBe(true);

		s.clearLocks(); // protectTokens 20k re-covers the newest block → heal it back to live
		expect(s.isProtected(s.get(newest)!)).toBe(true);
		expect(s.isFolded(s.get(newest)!)).toBe(false);
	});
});

// ── reactivity ───────────────────────────────────────────────────────────────
describe("ADR 0011 — lock state is reactive", () => {
	it("isLocked / locks / lockHolder reflect setLocks and clearLocks", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		expect(s.locks).toEqual([]);
		expect(s.isLocked("human-steering")).toBe(false);
		expect(s.lockHolder).toBe(null);

		s.setLocks(["human-steering", "tail-size"], "Autopilot");
		expect(s.locks).toEqual(["human-steering", "tail-size"]);
		expect(s.isLocked("human-steering")).toBe(true);
		expect(s.isLocked("tail-size")).toBe(true);
		expect(s.isLocked("agent-unfold")).toBe(false);
		expect(s.lockHolder).toBe("Autopilot");

		s.clearLocks();
		expect(s.locks).toEqual([]);
		expect(s.isLocked("human-steering")).toBe(false);
		expect(s.lockHolder).toBe(null);
	});
});
