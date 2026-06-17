import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import { AutopilotConductor } from "$conductors/autopilot/autopilot";
import type { Conductor, ConductorView, Command, LockName } from "$conductors/contract";
import type { Block, ParsedSession } from "./types";

/*
 * ADR 0011 — conductor involvement locks (HOST ENFORCEMENT).
 *
 * "Human overrides always win" becomes "human overrides win for every control the
 * conductor did NOT lock." A conductor declares a lock-set; the host gates the named
 * human/agent controls and (under `tail-size`) hands the conductor the protected tail.
 * Detach is the kill switch: it FREEZES the current folded view and unlocks everything.
 *
 * Everything here is gated on the conductor's ACTIVELY DECLARED lock-set, so with no lock
 * declared behavior is byte-for-byte today's — the golden test stays untouched (the last
 * test in this file is the local sanity guard for that invariant).
 */

function blk(i: number, kind: Block["kind"] = "text", tokens = 1000, extra: Partial<Block> = {}): Block {
	return {
		id: `m${i}:p0`,
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

/** A test conductor with a configurable lock-set and a directly-set desired command batch. */
class LockingConductor implements Conductor {
	readonly id = "locking";
	readonly label = "Locking";
	readonly locks: readonly LockName[];
	cmds: Command[] | null = [];
	constructor(locks: readonly LockName[] = []) {
		this.locks = locks;
	}
	conduct(_view: ConductorView): Command[] | null {
		return this.cmds;
	}
}

// ── human-steering ─────────────────────────────────────────────────────────────
describe("ADR 0011 — human-steering lock gates every human entry point", () => {
	it("collaborative (no lock): fold / pin / createGroup / resetAll all work", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.attach(new LockingConductor([])); // collaborative

		s.fold("m0:p0");
		expect(s.get("m0:p0")!.override).toBe("folded");
		s.pin("m1:p0");
		expect(s.get("m1:p0")!.override).toBe("pinned");
		const g = s.createGroup("m2:p0", "m3:p0");
		expect(g).not.toBeNull();
		expect(s.groups.length).toBe(1);
		s.resetAll();
		expect(s.blocks.every((b) => b.override === null)).toBe(true);
	});

	it("locked: fold / pin / createGroup / resetAll are no-ops (no override appears)", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.attach(new LockingConductor(["human-steering"]));

		s.fold("m0:p0");
		expect(s.get("m0:p0")!.override).toBe(null); // refused
		s.pin("m1:p0");
		expect(s.get("m1:p0")!.override).toBe(null); // refused
		const g = s.createGroup("m2:p0", "m3:p0");
		expect(g).toBeNull(); // refused
		expect(s.groups.length).toBe(0);
	});

	it("locked: resetAll is a hard no-op — a conductor fold is left standing", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		const c = new LockingConductor(["human-steering"]);
		c.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		s.attach(c);
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true);

		s.resetAll(); // would normally clear all overrides + emit "reset"
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true); // conductor fold untouched
		expect(s.log.some((e) => e.action === "reset")).toBe(false); // no log emitted
	});

	it("locked: toggle / unpin / auto / foldGroup are no-ops on fresh human actions", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		// A conductor that folds m0 and groups m2..m3, while locking the human out. (Build via a
		// conductor so there is durable conductor state to attempt human steering against.)
		const c = new LockingConductor(["human-steering"]);
		c.cmds = [{ kind: "fold", ids: ["m0:p0"] }, { kind: "group", ids: ["m2:p0", "m3:p0"] }];
		s.attach(c);
		const groupId = s.groups[0].id;
		expect(s.groups[0].folded).toBe(true);

		// Every human entry point refused — no human override appears, the group is untouched.
		s.toggle("m4:p0");
		expect(s.get("m4:p0")!.override).toBe(null);
		s.unpin("m0:p0"); // no-op (and m0 isn't pinned anyway)
		s.auto("m0:p0"); // would clear the conductor fold's override if allowed
		s.unfoldGroup(groupId); // human can't unfold the conductor group
		s.deleteGroup(groupId); // human can't delete it

		expect(s.isFolded(s.get("m0:p0")!)).toBe(true); // conductor fold still standing
		expect(s.groups.length).toBe(1); // group survives a locked-out human delete
		expect(s.groups[0].folded).toBe(true); // and a locked-out human unfold
		expect(s.blocks.every((b) => b.by !== "you")).toBe(true); // the human authored nothing
	});

	it("locked: the conductor's own fold still applies (only the HUMAN is gated)", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		const c = new LockingConductor(["human-steering"]);
		c.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		s.attach(c);
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true); // conductor steering is not gated
		expect(s.get("m0:p0")!.by).toBe("auto");
	});
});

// ── agent-unfold ─────────────────────────────────────────────────────────────
describe("ADR 0011 — agent-unfold lock gates the agent's unfold ONLY", () => {
	it("locked: unfold(id,'agent') is refused and the block stays folded", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		const c = new LockingConductor(["agent-unfold"]);
		c.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		s.attach(c);
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true);

		s.unfold("m0:p0", "agent"); // agent tries to force it open
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true); // refused — stays folded
		expect(s.get("m0:p0")!.override).toBe(null); // no agent override written
	});

	it("locked: a human unfold STILL works (separate axis from agent-unfold)", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		const c = new LockingConductor(["agent-unfold"]);
		c.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		s.attach(c);
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true);

		s.unfold("m0:p0", "you"); // human is NOT locked here
		expect(s.isFolded(s.get("m0:p0")!)).toBe(false);
		expect(s.get("m0:p0")!.override).toBe("unfolded");
	});

	it("collaborative: agent unfold works (the lock is what refuses it)", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		const c = new LockingConductor([]); // no lock
		c.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		s.attach(c);
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true);

		s.unfold("m0:p0", "agent");
		expect(s.isFolded(s.get("m0:p0")!)).toBe(false);
		expect(s.get("m0:p0")!.by).toBe("agent");
	});

	it("both human-steering AND agent-unfold locked: neither human nor agent unfold works", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		const c = new LockingConductor(["human-steering", "agent-unfold"]);
		c.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		s.attach(c);
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true);

		s.unfold("m0:p0", "you");
		s.unfold("m0:p0", "agent");
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true); // both refused
		expect(s.get("m0:p0")!.override).toBe(null);
	});

	it("locked: unfoldGroup(id,'agent') is refused — the agent can't unfold a GROUP through the lock (FIX 2)", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		// Build a folded conductor group over m0..m1, with the agent-unfold lock held.
		const c = new LockingConductor(["agent-unfold"]);
		c.cmds = [{ kind: "group", ids: ["m0:p0", "m1:p0"] }];
		s.attach(c);
		const groupId = s.groups[0].id;
		expect(s.groups[0].folded).toBe(true);

		s.unfoldGroup(groupId, "agent"); // agent tries to force the group open
		expect(s.groupById(groupId)!.folded).toBe(true); // refused — group stays folded
	});

	it("collaborative: unfoldGroup(id,'agent') IS allowed (the lock is what refuses it)", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		// A HUMAN group (so the human unfold-via-agent isn't re-asserted by a conductor each pass).
		s.attach(new LockingConductor([])); // collaborative
		const g = s.createGroup("m0:p0", "m1:p0");
		expect(g).not.toBeNull();
		expect(g!.folded).toBe(true);

		s.unfoldGroup(g!.id, "agent"); // no lock → the agent unfold takes effect
		expect(s.groupById(g!.id)!.folded).toBe(false);
	});
});

// ── tail-size ─────────────────────────────────────────────────────────────
describe("ADR 0011 — tail-size lock: the conductor owns the tail", () => {
	it("locked: protectedFromIndex === blocks.length (no protected tail)", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(20_000); // would normally protect the whole small session
		expect(s.protectedFromIndex).toBe(0); // collaborative: all protected

		s.attach(new LockingConductor(["tail-size"]));
		expect(s.protectedFromIndex).toBe(s.blocks.length); // no host tail under the lock
		expect(s.blocks.every((b) => !s.isProtected(b))).toBe(true);
	});

	it("locked: setProtect is a no-op (the human can't resize the tail)", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.attach(new LockingConductor(["tail-size"]));
		const before = s.protectTokens;
		s.setProtect(5000);
		expect(s.protectTokens).toBe(before); // unchanged
		expect(s.protectedFromIndex).toBe(s.blocks.length);
	});

	it("locked: a conductor fold of a RECENT block is applied (no 'protected' clamp)", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(20_000); // the whole session would be the protected tail
		const newest = s.blocks[s.blocks.length - 1].id;
		const c = new LockingConductor(["tail-size"]);
		c.cmds = [{ kind: "fold", ids: [newest] }];
		s.attach(c);

		expect(s.isFolded(s.get(newest)!)).toBe(true); // folded — tail is conductor policy now
		expect(s.lastReports.some((r) => r.reason === "protected")).toBe(false);
	});

	it("collaborative: that same recent fold is clamped 'protected' (lock is what lifts it)", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(20_000);
		const newest = s.blocks[s.blocks.length - 1].id;
		const c = new LockingConductor([]); // no lock
		c.cmds = [{ kind: "fold", ids: [newest] }];
		s.attach(c);

		expect(s.isFolded(s.get(newest)!)).toBe(false); // protected — refused
		expect(s.lastReports.some((r) => r.reason === "protected")).toBe(true);
	});
});

// ── attach: consent → baseline release ───────────────────────────────────────
describe("ADR 0011 — attach releases human/agent holds in locked domains only", () => {
	it("human-steering lock releases human pin/fold/unfold; leaves them under no lock", () => {
		const mk = () => {
			const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
			s.setProtect(0);
			s.pin("m0:p0");
			s.fold("m1:p0");
			s.unfold("m2:p0"); // human-held open
			return s;
		};

		// Collaborative attach: human holds survive untouched.
		const sCollab = mk();
		sCollab.attach(new LockingConductor([]));
		expect(sCollab.get("m0:p0")!.override).toBe("pinned");
		expect(sCollab.get("m1:p0")!.override).toBe("folded");
		expect(sCollab.get("m2:p0")!.override).toBe("unfolded");

		// Locking attach: human holds in the locked domain are released to baseline.
		const sLock = mk();
		sLock.attach(new LockingConductor(["human-steering"]));
		expect(sLock.get("m0:p0")!.override).toBe(null);
		expect(sLock.get("m1:p0")!.override).toBe(null);
		expect(sLock.get("m2:p0")!.override).toBe(null);
		expect(sLock.get("m0:p0")!.by).toBe(null);
	});

	it("agent-unfold lock releases ONLY agent sticky unfolds — human holds stay", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		// A conductor folds m0, the agent then unfolds it (sticky, by:"agent").
		const c0 = new LockingConductor([]);
		c0.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		s.attach(c0);
		s.unfold("m0:p0", "agent");
		expect(s.get("m0:p0")!.by).toBe("agent");
		expect(s.get("m0:p0")!.override).toBe("unfolded");
		// And a human pin elsewhere.
		s.pin("m1:p0");

		// Attach a conductor locking ONLY agent-unfold.
		s.attach(new LockingConductor(["agent-unfold"]));
		expect(s.get("m0:p0")!.override).toBe(null); // agent unfold released
		expect(s.get("m1:p0")!.override).toBe("pinned"); // human pin NOT touched (different axis)
	});
});

// ── detach: freeze, not reset-to-raw ─────────────────────────────────────────
describe("ADR 0011 — detach freezes the folded view and unlocks", () => {
	it("conductor-folded blocks become sticky human folds and survive; controls unlock", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		const c = new LockingConductor(["human-steering", "agent-unfold", "tail-size"]);
		c.cmds = [{ kind: "fold", ids: ["m0:p0", "m1:p0"] }];
		s.attach(c);
		expect(s.isLocked("human-steering")).toBe(true);
		const frozen = s.blocks.filter((b) => s.isFolded(b)).map((b) => b.id);
		expect(frozen.length).toBeGreaterThan(0);

		s.detach();

		// Frozen folds persist, now human-owned and individually reversible.
		for (const id of frozen) {
			const b = s.get(id)!;
			expect(s.isFolded(b)).toBe(true);
			expect(b.override).toBe("folded");
			expect(b.by).toBe("you");
			expect(b.subst).toBeUndefined();
		}
		// Every control is unlocked again.
		expect(s.isLocked("human-steering")).toBe(false);
		expect(s.isLocked("agent-unfold")).toBe(false);
		expect(s.isLocked("tail-size")).toBe(false);
		expect(s.conductor).toBe(null);

		// Human steering works again post-detach (the kill switch returned the keys).
		s.unfold(frozen[0]);
		expect(s.isFolded(s.get(frozen[0])!)).toBe(false);
	});

	it("detach does NOT reset to raw (a folded block is not dumped back to full)", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		const c = new LockingConductor([]);
		c.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		s.attach(c);
		const liveFolded = s.liveTokens;
		expect(liveFolded).toBeLessThan(s.fullTokens);

		s.detach();
		expect(s.liveTokens).toBe(liveFolded); // unchanged — the view is frozen, not raw
		expect(s.liveTokens).toBeLessThan(s.fullTokens);
	});
});

// ── detach a tail-size-locked conductor: the freeze must survive the tail re-protecting (FIX 1)
describe("ADR 0011 — detach freeze survives the re-protected tail (FIX 1, BLOCKER)", () => {
	it("Autopilot folds recent blocks; after detach they STAY folded (no heal back to full)", () => {
		// An over-budget session so Autopilot (tail-size lock) folds recent blocks INTO the
		// tail the host would normally protect. The whole small session is "the tail" at 20k.
		const s = makeStore(Array.from({ length: 6 }, (_, i) => blk(i, "text", 5000)));
		s.setProtect(20_000); // collaboratively the whole session would be protected
		s.setBudget(8_000); // far below the 30k live → Autopilot must fold several blocks

		s.attach(new AutopilotConductor());
		// Under tail-size the host lifts its floor; Autopilot folds enough to fit budget.
		const frozen = s.blocks.filter((b) => s.isFolded(b)).map((b) => b.id);
		expect(frozen.length).toBeGreaterThan(0);
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
		const liveFolded = s.liveTokens;

		s.detach();

		// (a) the frozen blocks are STILL folded, now human-owned.
		for (const id of frozen) {
			const b = s.get(id)!;
			expect(s.isFolded(b)).toBe(true);
			expect(b.override).toBe("folded");
			expect(b.by).toBe("you");
			expect(b.subst).toBeUndefined();
			// (FIX 5) no stale autoFolded alongside the override.
			expect(b.autoFolded).toBe(false);
		}
		// (b) liveTokens stays at the folded level — NOT healed back to fullTokens.
		expect(s.liveTokens).toBe(liveFolded);
		expect(s.liveTokens).toBeLessThan(s.fullTokens);
		// The tail HAS re-protected now the tail-size lock is gone (proves the bug's setup).
		expect(s.protectedFromIndex).toBeLessThan(s.blocks.length);
		expect(frozen.some((id) => s.isProtected(s.get(id)!))).toBe(true);

		// (c) all locks released and a frozen block is individually human-reversible.
		expect(s.isLocked("human-steering")).toBe(false);
		expect(s.isLocked("agent-unfold")).toBe(false);
		expect(s.isLocked("tail-size")).toBe(false);
		s.unfold(frozen[0]);
		expect(s.isFolded(s.get(frozen[0])!)).toBe(false);
	});

	it("works with a plain test conductor declaring tail-size too (not Autopilot-specific)", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i, "text", 5000)));
		s.setProtect(20_000);
		const c = new LockingConductor(["tail-size"]);
		// Fold the two most recent blocks — exactly the tail the host would re-protect.
		c.cmds = [{ kind: "fold", ids: ["m3:p0", "m4:p0"] }];
		s.attach(c);
		expect(s.isFolded(s.get("m4:p0")!)).toBe(true);
		const liveFolded = s.liveTokens;

		s.detach();

		expect(s.isFolded(s.get("m4:p0")!)).toBe(true); // frozen, not healed
		expect(s.get("m4:p0")!.override).toBe("folded");
		expect(s.get("m4:p0")!.by).toBe("you");
		expect(s.liveTokens).toBe(liveFolded);
		// The newest block IS in the re-protected tail, proving the heal exemption fired.
		expect(s.isProtected(s.get("m4:p0")!)).toBe(true);
	});

	it("a later resetAll clears the freeze exemption (frozen folds return to auto)", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i, "text", 5000)));
		s.setProtect(0); // no tail so resetAll's refold doesn't immediately re-protect
		const c = new LockingConductor(["tail-size"]);
		c.cmds = [{ kind: "fold", ids: ["m4:p0"] }];
		s.attach(c);
		s.detach();
		expect(s.get("m4:p0")!.override).toBe("folded");

		s.resetAll(); // clears overrides AND the frozen set
		expect(s.get("m4:p0")!.override).toBe(null);
	});
});

// ── reconcileLocks: the remote-conductor consent→baseline release (FIX 4) ─────────
describe("ADR 0011 — reconcileLocks releases standing holds for a just-known lock-set (FIX 4)", () => {
	it("human-steering: a human pin set before locks were known is released", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.pin("m0:p0");
		s.fold("m1:p0");
		expect(s.get("m0:p0")!.override).toBe("pinned");
		expect(s.get("m1:p0")!.override).toBe("folded");

		// Simulate a remote runner that attached collaboratively, then learned its locks late:
		// set the store's conductor to a stub declaring human-steering, THEN reconcile.
		s.conductor = new LockingConductor(["human-steering"]);
		s.reconcileLocks();

		expect(s.get("m0:p0")!.override).toBe(null); // pin released to baseline
		expect(s.get("m0:p0")!.by).toBe(null);
		expect(s.get("m1:p0")!.override).toBe(null); // manual fold released too
	});

	it("collaborative locks (none) ⇒ reconcileLocks releases nothing", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.pin("m0:p0");
		s.conductor = new LockingConductor([]); // collaborative
		s.reconcileLocks();
		expect(s.get("m0:p0")!.override).toBe("pinned"); // untouched
	});

	it("agent-unfold: reconcile releases an agent unfold but leaves a human pin", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		const c0 = new LockingConductor([]);
		c0.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		s.attach(c0);
		s.unfold("m0:p0", "agent");
		s.pin("m1:p0");
		expect(s.get("m0:p0")!.by).toBe("agent");

		s.conductor = new LockingConductor(["agent-unfold"]);
		s.reconcileLocks();
		expect(s.get("m0:p0")!.override).toBe(null); // agent unfold released
		expect(s.get("m1:p0")!.override).toBe("pinned"); // human pin survives (different axis)
	});
});

// ── additivity guard (local sanity; NOT the golden) ──────────────────────────
describe("ADR 0011 — no lock ⇒ a fold pass is byte-for-byte today's", () => {
	it("a no-lock conductor folds exactly what the same conductor without the lock field would", () => {
		const cmds: Command[] = [{ kind: "fold", ids: ["m0:p0", "m1:p0"] }];

		const sLockField = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		sLockField.setProtect(0);
		const withEmptyLocks = new LockingConductor([]); // declares locks: []
		withEmptyLocks.cmds = cmds.slice();
		sLockField.attach(withEmptyLocks);

		const sNoLockField = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		sNoLockField.setProtect(0);
		// A conductor with NO `locks` field at all (undefined) — the legacy shape.
		const noLockField: Conductor = {
			id: "legacy",
			label: "Legacy",
			conduct: () => cmds.slice(),
		};
		sNoLockField.attach(noLockField);

		const shape = (s: AccordionStore) => s.blocks.filter((b) => s.isFolded(b)).map((b) => b.id).sort();
		expect(shape(sLockField)).toEqual(shape(sNoLockField));
		// And both must equal the literal expectation (the conductor folded m0 and m1).
		expect(shape(sLockField)).toEqual(["m0:p0", "m1:p0"]);
	});
});
