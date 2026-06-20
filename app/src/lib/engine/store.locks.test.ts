import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import type { Conductor, ConductorView, Command, LockName } from "$conductors/contract";
import type { Block, ParsedSession } from "./types";
import { wireFoldable } from "./digest";

/** Minimal stand-in for the (deleted) AutopilotConductor: full-exclusive, oldest-first fold. */
class AutopilotStub implements Conductor {
	readonly id = "autopilot";
	readonly label = "Autopilot";
	readonly locks = ["human-steering", "agent-unfold", "tail-size"] as const;
	// tailTokens omitted → 0 (no protected tail; the conductor owns the whole context)
	conduct(view: ConductorView): Command[] {
		const FOLD_RANK: Record<string, number> = { tool_result: 0, thinking: 1, text: 2, tool_call: 3, user: 4 };
		let live = view.liveTokens;
		if (live <= view.budget) return [];
		const cand = view.blocks
			.filter((b) => !b.held && !b.protected && !b.grouped && b.foldedTokens < b.tokens)
			.sort((a, b) => (FOLD_RANK[a.kind] ?? 99) - (FOLD_RANK[b.kind] ?? 99) || a.order - b.order);
		const ids: string[] = [];
		for (const b of cand) {
			if (live <= view.budget) break;
			ids.push(b.id);
			live += b.foldedTokens - b.tokens;
		}
		return ids.length ? [{ kind: "fold", ids }] : [];
	}
}

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

/** A test conductor with a configurable lock-set, optional tailTokens, and a directly-set desired command batch. */
class LockingConductor implements Conductor {
	readonly id = "locking";
	readonly label = "Locking";
	readonly locks: readonly LockName[];
	readonly tailTokens?: number;
	cmds: Command[] | null = [];
	constructor(locks: readonly LockName[] = [], tailTokens?: number) {
		this.locks = locks;
		this.tailTokens = tailTokens;
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
	it("locked: protectedFromIndex === blocks.length (no protected tail) when tailTokens omitted", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(20_000); // would normally protect the whole small session
		expect(s.protectedFromIndex).toBe(0); // collaborative: all protected

		s.attach(new LockingConductor(["tail-size"])); // no tailTokens → 0 → blocks.length
		expect(s.protectedFromIndex).toBe(s.blocks.length); // no host tail under the lock
		expect(s.blocks.every((b) => !s.isProtected(b))).toBe(true);
	});

	it("locked with tailTokens=3000: walk-back protects newest ~3k tokens, conductor folds only older", () => {
		// 10 blocks × 1000 tok each. Walk-back of 3000 should protect blocks 7,8,9.
		const s = makeStore(Array.from({ length: 10 }, (_, i) => blk(i, "text", 1000)));
		s.attach(new LockingConductor(["tail-size"], 3000));
		expect(s.protectedFromIndex).toBe(7); // blocks 7,8,9 protected (3×1000 = 3000 = target)
		// Older blocks are not protected.
		for (let i = 0; i < 7; i++) expect(s.isProtected(s.get(`m${i}:p0`)!), `m${i} should not be protected`).toBe(false);
		// Protected tail blocks are protected.
		for (let i = 7; i < 10; i++) expect(s.isProtected(s.get(`m${i}:p0`)!), `m${i} should be protected`).toBe(true);

		// Conductor can fold an older block (m0) — no "protected" clamp.
		const c = new LockingConductor(["tail-size"], 3000);
		c.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		const s2 = makeStore(Array.from({ length: 10 }, (_, i) => blk(i, "text", 1000)));
		s2.attach(c);
		expect(s2.isFolded(s2.get("m0:p0")!)).toBe(true);
		expect(s2.lastReports.some((r) => r.reason === "protected")).toBe(false);

		// Conductor cannot fold a protected block (m9) — clamped "protected".
		const c2 = new LockingConductor(["tail-size"], 3000);
		c2.cmds = [{ kind: "fold", ids: ["m9:p0"] }];
		const s3 = makeStore(Array.from({ length: 10 }, (_, i) => blk(i, "text", 1000)));
		s3.attach(c2);
		expect(s3.isFolded(s3.get("m9:p0")!)).toBe(false);
		expect(s3.lastReports.some((r) => r.reason === "protected")).toBe(true);
	});

	it("locked with non-finite tailTokens (NaN): clamps to 0 (own everything), never poisons the boundary or protectTokens", () => {
		// A buggy first-party conductor hands NaN. It must read as 0 (no tail), NOT fall through
		// protectedFromIndex to `return 0` (whole context protected — the inverse of intent), and
		// must NOT leak NaN into the human's protectTokens via detach inheritance.
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i, "text", 1000)));
		s.setProtect(20_000);
		const c = new LockingConductor(["tail-size"], Number.NaN);
		const newest = s.blocks[s.blocks.length - 1].id;
		c.cmds = [{ kind: "fold", ids: [newest] }];
		s.attach(c);

		expect(s.protectedFromIndex).toBe(s.blocks.length); // NaN → 0 → no tail (own everything)
		expect(s.blocks.every((b) => !s.isProtected(b))).toBe(true);
		expect(s.isFolded(s.get(newest)!)).toBe(true); // recent fold applies — NOT clamped "protected"

		s.detach();
		expect(Number.isFinite(s.protectTokens)).toBe(true); // not NaN-poisoned
		expect(s.protectTokens).toBe(0); // inherited the clamped 0, not NaN
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

	it("human-steering releases human GROUPS too, so the conductor can author over that range (@a-Fig comment 2)", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		const g = s.createGroup("m0:p0", "m1:p0"); // human group, by:"you"
		expect(g).not.toBeNull();
		expect(s.groups.length).toBe(1);

		// Collaborative attach leaves the human group intact (no lock to release it).
		const sCollab = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		sCollab.setProtect(0);
		sCollab.createGroup("m0:p0", "m1:p0");
		sCollab.attach(new LockingConductor([]));
		expect(sCollab.groups.length).toBe(1);

		// human-steering attach releases the human group → clean field for the conductor.
		const c = new LockingConductor(["human-steering"]);
		// The conductor wants to author its OWN group over the same range — which createGroup
		// refuses on overlap. Releasing the human group is what lets it land.
		c.cmds = [{ kind: "group", ids: ["m0:p0", "m1:p0"] }];
		s.attach(c);
		// The stale human group is gone, replaced by the conductor's own.
		expect(s.groups.length).toBe(1);
		expect(s.groups[0].by).toBe("auto"); // conductor-authored, not the leftover human group
		expect(s.groups[0].folded).toBe(true);
	});

	it("agent-unfold lock does NOT release human groups (only human-steering does)", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.createGroup("m0:p0", "m1:p0");
		s.attach(new LockingConductor(["agent-unfold"])); // different axis
		expect(s.groups.length).toBe(1); // human group survives — agent-unfold is not its domain
		expect(s.groups[0].by).toBe("you");
	});
});

// ── detach: freeze, not reset-to-raw ─────────────────────────────────────────
describe("ADR 0011 — detach freezes the folded view and unlocks", () => {
	it("freezes a conductor's individual fold of an OPEN-group member (no folded group to carry it) (@a-Fig comment 1 variant)", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0); // no tail — isolate the freeze behavior
		// Human group over m0,m1, then UNFOLD it → an OPEN human group.
		const g = s.createGroup("m0:p0", "m1:p0");
		expect(g).not.toBeNull();
		s.unfoldGroup(g!.id);
		expect(s.groupById(g!.id)!.folded).toBe(false);
		// A conductor folds m0 INDIVIDUALLY (allowed — an open group isn't in groupWire).
		const c = new LockingConductor([]);
		c.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		s.attach(c);
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true);
		const liveFolded = s.liveTokens;

		s.detach(); // kill switch must FREEZE the view, not let m0 reopen

		const m0 = s.get("m0:p0")!;
		expect(s.isFolded(m0)).toBe(true); // still folded — frozen, not reopened
		expect(m0.override).toBe("folded"); // individually frozen (the open group can't carry it)
		expect(m0.by).toBe("you");
		expect(m0.subst).toBeUndefined();
		expect(m0.autoFolded).toBe(false);
		expect(s.liveTokens).toBe(liveFolded); // budget not re-blown
		// And it's individually reversible by hand post-detach.
		s.unfold("m0:p0");
		expect(s.isFolded(s.get("m0:p0")!)).toBe(false);
	});


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

	it("a replace-conductor's substitution SURVIVES the freeze (exact view, not a digest)", () => {
		// ADR 0011 §6: detach freezes the current folded view IN PLACE. For a `replace`-based
		// conductor (e.g. naive compaction) the carrier block's content is the conductor's
		// generated text; the freeze must preserve it, not revert to the engine digest.
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i)));
		s.setProtect(0);
		const c = new LockingConductor(["human-steering"]);
		c.cmds = [{ kind: "replace", id: "m0:p0", content: "COMPACTED SUMMARY" }];
		s.attach(c);
		const carrier = s.get("m0:p0")!;
		expect(s.isFolded(carrier)).toBe(true);
		expect(s.digestOf(carrier)).toBe("COMPACTED SUMMARY"); // shown before detach

		s.detach();

		// Frozen, human-owned, and STILL carrying the summary (subst preserved).
		expect(s.isFolded(carrier)).toBe(true);
		expect(carrier.override).toBe("folded");
		expect(carrier.by).toBe("you");
		expect(carrier.subst).toBe("COMPACTED SUMMARY");
		expect(s.digestOf(carrier)).toBe("COMPACTED SUMMARY"); // exact view preserved
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

// ── detach a tail-size-locked conductor: tail inheritance prevents snap-back (new mechanism)
describe("ADR 0011 — detach inherits the conductor's tail — no snap-back, view frozen", () => {
	it("Autopilot (tailTokens=0) folds recent blocks; after detach they STAY folded, protectTokens inherited 0", () => {
		// An over-budget session so Autopilot (tail-size lock, tailTokens=0) folds recent blocks.
		const s = makeStore(Array.from({ length: 6 }, (_, i) => blk(i, "text", 5000)));
		s.setProtect(20_000); // human would protect the whole session collaboratively
		s.setBudget(8_000); // far below the 30k live → Autopilot must fold several blocks

		s.attach(new AutopilotStub());
		// Under tail-size the host uses activeTailTokens=0 → no protected tail for the conductor.
		const foldedIds = s.blocks.filter((b) => s.isFolded(b)).map((b) => b.id);
		expect(foldedIds.length).toBeGreaterThan(0);
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
		const liveFolded = s.liveTokens;

		s.detach();

		// (a) The folded blocks are STILL folded, now human-owned and individually reversible.
		for (const id of foldedIds) {
			const b = s.get(id)!;
			expect(s.isFolded(b)).toBe(true);
			expect(b.override).toBe("folded");
			expect(b.by).toBe("you");
			expect(b.subst).toBeUndefined();
			expect(b.autoFolded).toBe(false); // no stale autoFolded alongside the override
		}
		// (b) liveTokens stays at the folded level — NOT healed back to fullTokens.
		expect(s.liveTokens).toBe(liveFolded);
		expect(s.liveTokens).toBeLessThan(s.fullTokens);
		// (c) NEW MECHANISM: protectTokens inherited Autopilot's tailTokens (0);
		// protectedFromIndex stays blocks.length (no host tail) — NO snap-back.
		expect(s.protectTokens).toBe(0);
		expect(s.protectedFromIndex).toBe(s.blocks.length);
		// The frozen blocks are NOT protected (no host tail to protect them into).
		for (const id of foldedIds) expect(s.isProtected(s.get(id)!)).toBe(false);

		// (d) all locks released and a frozen block is individually human-reversible.
		expect(s.isLocked("human-steering")).toBe(false);
		expect(s.isLocked("agent-unfold")).toBe(false);
		expect(s.isLocked("tail-size")).toBe(false);
		s.unfold(foldedIds[0]);
		expect(s.isFolded(s.get(foldedIds[0])!)).toBe(false);
	});

	it("plain tail-size conductor (tailTokens=0): folds persist, protectTokens inherited 0, NO snap-back", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i, "text", 5000)));
		s.setProtect(20_000);
		const c = new LockingConductor(["tail-size"]); // tailTokens omitted → 0
		// Fold the two most recent blocks — the ones the host would re-protect on snap-back.
		c.cmds = [{ kind: "fold", ids: ["m3:p0", "m4:p0"] }];
		s.attach(c);
		expect(s.isFolded(s.get("m4:p0")!)).toBe(true);
		const liveFolded = s.liveTokens;

		s.detach();

		// Folds persist as human-owned.
		expect(s.isFolded(s.get("m4:p0")!)).toBe(true);
		expect(s.get("m4:p0")!.override).toBe("folded");
		expect(s.get("m4:p0")!.by).toBe("you");
		expect(s.liveTokens).toBe(liveFolded);
		// NEW: protectTokens inherited 0 → no host tail → m4 is NOT protected (no snap-back).
		expect(s.protectTokens).toBe(0);
		expect(s.protectedFromIndex).toBe(s.blocks.length);
		expect(s.isProtected(s.get("m4:p0")!)).toBe(false);
	});

	it("a redundant second detach() is a no-op (idempotent)", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i, "text", 5000)));
		s.setProtect(20_000);
		const c = new LockingConductor(["tail-size"]);
		c.cmds = [{ kind: "fold", ids: ["m3:p0", "m4:p0"] }];
		s.attach(c);
		expect(s.isFolded(s.get("m4:p0")!)).toBe(true);
		const liveFolded = s.liveTokens;

		// cancelConsent calls detach() then setActiveConductor(NONE_ID), whose attach effect
		// detaches AGAIN. The second detach must not re-run freezeForDetach() and re-inherit or
		// re-stamp. The guard makes the second call a true no-op.
		s.detach();
		s.detach();

		expect(s.isFolded(s.get("m4:p0")!)).toBe(true); // still frozen after the double detach
		expect(s.get("m4:p0")!.override).toBe("folded");
		expect(s.get("m4:p0")!.by).toBe("you");
		expect(s.liveTokens).toBe(liveFolded);
		// m4 NOT protected (inherited protectTokens=0, no snap-back even after double detach).
		expect(s.protectTokens).toBe(0);
		expect(s.protectedFromIndex).toBe(s.blocks.length);
		expect(s.isProtected(s.get("m4:p0")!)).toBe(false);
	});

	it("a later resetAll returns frozen folds to a clean slate (override null AND liveTokens===fullTokens)", () => {
		const s = makeStore(Array.from({ length: 5 }, (_, i) => blk(i, "text", 5000)));
		s.setProtect(0); // no tail
		const c = new LockingConductor(["tail-size"]);
		c.cmds = [{ kind: "fold", ids: ["m4:p0"] }];
		s.attach(c);
		s.detach();
		expect(s.get("m4:p0")!.override).toBe("folded");
		expect(s.liveTokens).toBeLessThan(s.fullTokens); // something is genuinely folded

		s.resetAll(); // clears all overrides → pure budget view
		expect(s.get("m4:p0")!.override).toBe(null);
		expect(s.liveTokens).toBe(s.fullTokens); // truly raw — not merely override-null
	});

	it("resetAll dissolves a surviving detach-frozen GROUP (inherited 0-tail can't prune it, so reset must)", () => {
		// Regression for the inherited-0-tail gap: a tail-size conductor groups recent blocks;
		// detach inherits protectTokens=0 (no tail), so the group survives as a human-owned fold.
		// resetAll must still return a clean slate — without dissolving groups it leaves the group
		// folded, silently contradicting its own "all blocks to auto".
		const s = makeStore(Array.from({ length: 40 }, (_, i) => blk(i)));
		const c = new LockingConductor(["tail-size"]); // tailTokens omitted → 0
		c.cmds = [{ kind: "group", ids: ["m36:p0", "m37:p0", "m38:p0", "m39:p0"] }];
		s.attach(c);
		s.detach();
		expect(s.groups.length).toBe(1); // group survived detach (no tail to prune it)
		expect(s.protectTokens).toBe(0);
		expect(s.liveTokens).toBeLessThan(s.fullTokens);

		s.resetAll();
		expect(s.groups.length).toBe(0); // group dissolved — true clean slate
		expect(s.liveTokens).toBe(s.fullTokens);
		expect(s.blocks.every((b) => b.override === null)).toBe(true);
	});

	it("tailTokens=3000: boundary STABLE across detach — protectTokens inherits 3000, protectedFromIndex=7", () => {
		// 10 blocks × 1000 tok. Conductor declares tailTokens=3000 → protectedFromIndex=7 during reign.
		const s = makeStore(Array.from({ length: 10 }, (_, i) => blk(i, "text", 1000)));
		s.setProtect(20_000); // human's default (overwritten on detach)
		const c = new LockingConductor(["tail-size"], 3000);
		c.cmds = []; // no folds needed — just test boundary
		s.attach(c);
		expect(s.protectedFromIndex).toBe(7); // conductor's 3000-token tail

		s.detach();

		// Boundary stable: protectTokens inherited 3000 → same walk-back → same index.
		expect(s.protectTokens).toBe(3000);
		expect(s.protectedFromIndex).toBe(7);
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

// ── Bug #1: remote locks arrive by IN-PLACE mutation; the snapshot must drive reactivity ──
//
// A remote conductor (RemoteRunner) attaches with `locks` UNDEFINED, then mutates that field
// IN PLACE when `conductor/hello` lands — it is the SAME object `store.conductor` already
// points at, so its `$state` reference never changes. The store therefore can't rely on
// reading `this.conductor.locks` to drive reactive UI (a `$derived`/`$effect` that captured
// `store.conductor` would never re-run): it mirrors the locks into a `$state` snapshot,
// reassigned in `reconcileLocks()`, which IS a reference change Svelte tracks.
//
// These tests model the real remote shape (in-place mutation, NOT the reassignment the FIX-4
// tests above use — reassignment masks the bug because it is itself a reference change) and
// assert through `protectedFromIndex`, a genuine `$derived.by` that depends on the
// `tail-size` lock. Pre-fix this derived memoized on the unchanged `store.conductor` reference
// and stayed stale even after reconcile; post-fix the snapshot write makes it recompute.
describe("ADR 0011 — Bug #1: in-place remote lock update propagates only via the snapshot", () => {
	/** A remote-style conductor: locks start undefined and are mutated in place (like RemoteRunner). */
	class InPlaceRemote implements Conductor {
		readonly id = "remote-like";
		readonly label = "Remote-like";
		locks: readonly LockName[] | undefined = undefined; // NOT readonly here — mutated in place
		conduct(_view: ConductorView): Command[] | null {
			return [];
		}
	}

	it("tail-size: in-place mutation alone is inert; reconcileLocks flips the reactive protectedFromIndex", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(20_000); // the whole small session is the protected tail → protectedFromIndex 0
		const c = new InPlaceRemote();
		s.attach(c); // attaches collaboratively (locks undefined)
		expect(s.protectedFromIndex).toBe(0); // collaborative: all protected
		expect(s.isLocked("tail-size")).toBe(false);

		// Locks arrive over the wire and are written IN PLACE on the attached runner (no reassign).
		c.locks = Object.freeze(["tail-size"] as LockName[]);

		// Without reconcileLocks the snapshot is still empty — the derived must NOT have moved.
		// (This is the crux: reading the conductor's mutated field directly would lie; the host
		// deliberately keeps the snapshot as the single reactive source until reconcile runs.)
		expect(s.protectedFromIndex).toBe(0);
		expect(s.isLocked("tail-size")).toBe(false);

		// The hello handler calls reconcileLocks(), which syncs the snapshot.
		s.reconcileLocks();
		expect(s.protectedFromIndex).toBe(s.blocks.length); // tail handed to the conductor — reactive read updated
		expect(s.isLocked("tail-size")).toBe(true);
		expect(s.locks).toEqual(["tail-size"]); // public reactive accessor reflects the new set
	});

	it("human-steering: isLocked + the public locks accessor update after reconcile (in-place mutation)", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		const c = new InPlaceRemote();
		s.attach(c);
		expect(s.isLocked("human-steering")).toBe(false);
		expect(s.lockingConductorLabel).toBeNull();

		c.locks = Object.freeze(["human-steering"] as LockName[]); // in-place
		s.reconcileLocks();

		expect(s.isLocked("human-steering")).toBe(true);
		expect(s.locks).toEqual(["human-steering"]);
		expect(s.lockingConductorLabel).toBe("Remote-like"); // label resolves once locks are live
		// And the gate now actually bites: a human fold is refused under the freshly-known lock.
		s.fold("m0:p0");
		expect(s.get("m0:p0")!.override).toBeNull();
	});

	it("detach clears the snapshot so isLocked/locks go collaborative again", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		const c = new InPlaceRemote();
		s.attach(c);
		c.locks = Object.freeze(["human-steering", "tail-size"] as LockName[]);
		s.reconcileLocks();
		expect(s.isLocked("human-steering")).toBe(true);

		s.detach(); // kill switch unlocks everything
		expect(s.isLocked("human-steering")).toBe(false);
		expect(s.isLocked("tail-size")).toBe(false);
		expect(s.locks).toEqual([]);
	});
});

// ── Bug #2: detach freezes a tail-size conductor's folded group (new mechanism) ──────────
describe("ADR 0011 — detach freezes tail-size conductor's folded group (Bug #2)", () => {
	it("detach inherits tail (0), group survives as human-owned, budget not re-blown", () => {
		// 40 blocks × 1000 tok = 40 000 full tokens. Default protectTokens (20 000) would
		// normally protect ~20 newest blocks. Under tail-size (tailTokens=0) the conductor
		// owns the whole context, so the group can span any blocks.
		const s = makeStore(Array.from({ length: 40 }, (_, i) => blk(i)));
		// Do NOT call setProtect — keep the default 20 000 token tail.

		const c = new LockingConductor(["tail-size"]); // tailTokens=0
		// Group m36..m39 — spans what would be the re-protected tail on snap-back.
		c.cmds = [{ kind: "group", ids: ["m36:p0", "m37:p0", "m38:p0", "m39:p0"] }];
		s.attach(c);

		expect(s.groups.length).toBe(1);
		expect(s.groups[0].folded).toBe(true);
		expect(s.liveTokens).toBeLessThan(s.fullTokens);

		const foldedLive = s.liveTokens;

		s.detach();

		// liveTokens stays close to the folded level — no snap-back (tail inherited as 0).
		expect(Math.abs(s.liveTokens - foldedLive)).toBeLessThan(10);
		// Belt-and-suspenders: still meaningfully below full.
		expect(s.liveTokens).toBeLessThan(s.fullTokens - 2000);

		// NEW MECHANISM: inherited tail keeps protectedFromIndex at blocks.length.
		expect(s.protectTokens).toBe(0);
		expect(s.protectedFromIndex).toBe(s.blocks.length);

		// The group survives as a human-owned fold. No frozen flag (that field is gone).
		expect(s.groups.length).toBe(1);
		expect(s.groups[0].folded).toBe(true);
		expect(s.groups[0].by).toBe("you");
		expect(s.isFolded(s.get("m38:p0")!)).toBe(true);
		// Members keep override===null — no individual `override:"folded"` was stamped.
		expect(s.get("m38:p0")!.override).toBeNull();
	});

	it("A: no view↔wire divergence — a non-foldable group member is never individually folded after detach", () => {
		// 40 blocks × 1000 tok. m36 = tool_call (non-foldable), m37 = its tool_result, m38+m39 = text.
		const blocks = Array.from({ length: 40 }, (_, i) => blk(i));
		blocks[36] = blk(36, "tool_call", 1000, { callId: "c1", toolName: "x" });
		blocks[37] = blk(37, "tool_result", 1000, { callId: "c1" });
		const s = makeStore(blocks);
		// Do NOT call setProtect — keep default 20 000 token tail.

		const c = new LockingConductor(["tail-size"]); // tailTokens=0
		// Group m36..m39: includes a tool_call (non-foldable kind) and a tool_result + two text.
		c.cmds = [{ kind: "group", ids: ["m36:p0", "m37:p0", "m38:p0", "m39:p0"] }];
		s.attach(c);
		expect(s.groups.length).toBe(1);
		expect(s.groups[0].folded).toBe(true);

		s.detach();

		// Invariant: for every block, if it reads folded AND is NOT a member of a surviving
		// folded group, then it must be wire-foldable (no illegal per-block fold on user/tool_call).
		// The group survives (no snap-back thanks to inherited tail), so every folded block is a
		// group member — the loop body is vacuously satisfied, and remains as a regression guard.
		const foldedGroupMemberIds = new Set<string>();
		for (const g of s.groups) {
			if (g.folded) for (const id of g.memberIds) foldedGroupMemberIds.add(id);
		}
		for (const b of s.blocks) {
			if (s.isFolded(b) && !foldedGroupMemberIds.has(b.id)) {
				expect(wireFoldable(b), `block ${b.id} (kind=${b.kind}) is individually folded but not wire-foldable`).toBe(true);
			}
		}

		// Specifically: m36 (tool_call) must NOT be individually folded.
		const m36 = s.get("m36:p0")!;
		expect(m36.override).toBeNull(); // no per-block fold
		expect(m36.autoFolded).toBe(false);
		// It reads folded because the group still exists.
		expect(s.isFolded(m36)).toBe(true);
		expect(s.groups.length).toBe(1);

		// Anti-divergence guard.
		expect(wireFoldable(m36)).toBe(false); // a tool_call is never individually wire-foldable
		expect(s.groupOf(m36)?.folded).toBe(true); // folded ONLY as a member of the surviving group

		// Budget is still preserved.
		expect(s.liveTokens).toBeLessThan(s.fullTokens - 2000);
	});

	it("B: surviving human group + dissolve returns members to live (no stale fold leak)", () => {
		// 40 blocks. Group over m2..m5 — older than what would be the re-protected tail.
		const blocks = Array.from({ length: 40 }, (_, i) => blk(i));
		// Put a user block at m2 and a tool_call+tool_result pair at m3..m4.
		blocks[2] = blk(2, "user", 1000);
		blocks[3] = blk(3, "tool_call", 1000, { callId: "c2", toolName: "y" });
		blocks[4] = blk(4, "tool_result", 1000, { callId: "c2" });
		const s = makeStore(blocks);

		const c = new LockingConductor(["tail-size"]); // tailTokens=0
		c.cmds = [{ kind: "group", ids: ["m2:p0", "m3:p0", "m4:p0", "m5:p0"] }];
		s.attach(c);
		expect(s.groups.length).toBe(1);
		expect(s.groups[0].folded).toBe(true);

		s.detach();

		// Group survives as human-owned.
		expect(s.groups.length).toBe(1);
		expect(s.groups[0].by).toBe("you");

		// Human dissolves it.
		s.deleteGroup(s.groups[0].id);

		// Every former member must be NOT folded — no stale per-block fold leak.
		for (const id of ["m2:p0", "m3:p0", "m4:p0", "m5:p0"]) {
			const b = s.get(id)!;
			expect(b.override, `${id} should have override===null after group dissolved`).toBeNull();
			expect(s.isFolded(b), `${id} should not be folded after group dissolved`).toBe(false);
		}
	});

	it("C: position-one — human grows the tail over a detach-frozen group → group is pruned", () => {
		// 40 blocks, default tail, conductor groups m36..m39 (recent), detach inherits tail=0.
		const s = makeStore(Array.from({ length: 40 }, (_, i) => blk(i)));
		// Keep default 20k tail.
		const c = new LockingConductor(["tail-size"]); // tailTokens=0
		c.cmds = [{ kind: "group", ids: ["m36:p0", "m37:p0", "m38:p0", "m39:p0"] }];
		s.attach(c);
		s.detach();

		// After detach: protectTokens=0, group survives.
		expect(s.protectTokens).toBe(0);
		expect(s.groups.length).toBe(1);

		// Human grows the tail to 20k. m36..m39 are now in the protected tail.
		// pruneProtectedGroups fires and drops the group.
		s.setProtect(20_000);

		expect(s.groups.length).toBe(0); // group pruned (position one)
		for (const id of ["m36:p0", "m37:p0", "m38:p0", "m39:p0"]) {
			const b = s.get(id)!;
			expect(s.isProtected(b), `${id} should be protected after setProtect(20000)`).toBe(true);
			expect(s.isFolded(b), `${id} should not be folded after group pruned`).toBe(false);
		}
		expect(s.liveTokens).toBe(s.fullTokens); // clean — nothing folded
	});

	it("D: inheritance consequence — subsequent collaborative conductor runs with inherited protectTokens=0", () => {
		// After detaching the tailTokens=0 group conductor (protectTokens now 0), attach a new
		// collaborative conductor (no locks). It defers to the inherited protectTokens (0) — so
		// protectedFromIndex = blocks.length, and the group SURVIVES (not pruned, no tail to grow
		// over). Then the human sets a tail and the group is pruned.
		const s = makeStore(Array.from({ length: 40 }, (_, i) => blk(i)));
		const c = new LockingConductor(["tail-size"]); // tailTokens=0
		c.cmds = [{ kind: "group", ids: ["m36:p0", "m37:p0", "m38:p0", "m39:p0"] }];
		s.attach(c);
		s.detach();

		// Attach a new collaborative conductor (no locks, folds nothing).
		s.attach(new LockingConductor([]));

		// protectTokens inherited 0 → no host tail → protectedFromIndex = blocks.length.
		expect(s.protectedFromIndex).toBe(s.blocks.length);
		// Group survives (nothing to prune it — no protected tail overlaps it).
		expect(s.groups.length).toBe(1);

		// Human grows the tail → group pruned.
		s.setProtect(20_000);
		expect(s.groups.length).toBe(0);
		for (const id of ["m36:p0", "m37:p0", "m38:p0", "m39:p0"]) {
			const b = s.get(id)!;
			expect(s.isProtected(b)).toBe(true);
			expect(s.isFolded(b)).toBe(false);
		}
	});

	it("E: after human grows the tail, protected blocks cannot be folded/grouped", () => {
		// After detach (protectTokens 0, group survives), human grows tail via setProtect(20000)
		// → m36..m39 become protected, group is pruned. Then attempting to fold/group them fails.
		const s = makeStore(Array.from({ length: 40 }, (_, i) => blk(i)));
		const c = new LockingConductor(["tail-size"]); // tailTokens=0
		c.cmds = [{ kind: "group", ids: ["m36:p0", "m37:p0", "m38:p0", "m39:p0"] }];
		s.attach(c);
		s.detach();
		s.setProtect(20_000); // grow tail → m36..m39 protected, group pruned (Test C)

		expect(s.groups.length).toBe(0);
		for (const id of ["m36:p0", "m37:p0", "m38:p0", "m39:p0"]) {
			expect(s.isProtected(s.get(id)!)).toBe(true);
		}

		// Attempting createGroup over protected content is refused (createGroup has a tail guard).
		const g = s.createGroup("m36:p0", "m39:p0");
		expect(g).toBeNull(); // refused — spans protected tail
		expect(s.groups.length).toBe(0);

		// Attempting individual fold of a protected block is also refused.
		s.fold("m38:p0");
		expect(s.get("m38:p0")!.override).toBeNull(); // refused — protected

		// m36..m39 stay live and protected.
		for (const id of ["m36:p0", "m37:p0", "m38:p0", "m39:p0"]) {
			const b = s.get(id)!;
			expect(s.isProtected(b)).toBe(true);
			expect(s.isFolded(b)).toBe(false);
		}
		expect(s.groups.some((g2) => g2.folded && g2.memberIds.includes("m38:p0"))).toBe(false);
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
