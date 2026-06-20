import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import { BuiltinConductor } from "$conductors";
import type { Conductor, ConductorView, Command, ConductorHost } from "$conductors/contract";
import type { Block, ParsedSession } from "./types";
import { digest, digestTokens } from "./digest";

/*
 * The conductor SEAM (ADR 0007): the store runs whatever strategy is attached, clamps
 * its commands to the one host floor (provider-validity), and lets the human always win.
 * The built-in's byte-identical behaviour is pinned separately in conductor.builtin.test.ts;
 * this file pins the seam itself — attach/detach, substitution, and clamping.
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

/** A conductor whose desired state the test sets directly — to drive the full pass. */
class StubConductor implements Conductor {
	readonly id = "stub";
	readonly label = "Stub";
	cmds: Command[] | null = [];
	lastSnapshot: ConductorView | null = null;
	conduct(view: ConductorView): Command[] | null {
		this.lastSnapshot = view;
		return this.cmds;
	}
}

/** Async in-process conductor test double: returns `null` while "thinking", then pokes host. */
class AsyncStubConductor implements Conductor {
	readonly id = "async-stub";
	readonly label = "Async Stub";
	cmds: Command[] | null = null;
	host: ConductorHost | null = null;
	conductCalls = 0;
	attachCalls = 0;
	detachCalls = 0;
	attach(host: ConductorHost): void {
		this.attachCalls++;
		this.host = host;
	}
	detach(): void {
		this.detachCalls++;
	}
	conduct(_view: ConductorView): Command[] | null {
		this.conductCalls++;
		return this.cmds;
	}
}

class ThrowLifecycleConductor extends StubConductor {
	throwAttach = false;
	throwDetach = false;
	attach(_host: ConductorHost): void {
		if (this.throwAttach) throw new Error("attach boom");
	}
	detach(): void {
		if (this.throwDetach) throw new Error("detach boom");
	}
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("conductor seam — attach / detach", () => {
	// ADR 0011 §6: detach is the KILL SWITCH — it FREEZES the current folded view (so leaving
	// can't blow the budget) and unlocks, rather than resetting to raw. The frozen folds become
	// sticky human-owned folds, individually reversible with no conductor running.
	it("detach() freezes the current folded view (sticky, human-owned) instead of going raw", () => {
		const s = makeStore(Array.from({ length: 6 }, (_, i) => blk(i)));
		s.setProtect(2000);
		s.setBudget(2500); // 6000 live > budget → built-in must fold
		const foldedBefore = s.foldedCount;
		expect(foldedBefore).toBeGreaterThan(0);
		const frozenIds = s.blocks.filter((b) => s.isFolded(b)).map((b) => b.id);

		s.detach();
		// The exact folded view persists — same blocks, now human-owned.
		expect(s.foldedCount).toBe(foldedBefore);
		for (const id of frozenIds) {
			const b = s.get(id)!;
			expect(s.isFolded(b)).toBe(true);
			expect(b.override).toBe("folded");
			expect(b.by).toBe("you");
			expect(b.subst).toBeUndefined(); // folds to the engine digest, individually reversible
		}
		// No conductor is running and the frozen folds are reversible by hand.
		expect(s.conductor).toBe(null);
		s.unfold(frozenIds[0]);
		expect(s.isFolded(s.get(frozenIds[0])!)).toBe(false);
	});

	it("re-attaching a fresh built-in re-folds (frozen human folds persist + builtin authors on top)", () => {
		const s = makeStore(Array.from({ length: 6 }, (_, i) => blk(i)));
		s.setProtect(2000);
		s.setBudget(2500);
		s.detach();
		// Frozen, not raw: the prior fold set is preserved as human folds.
		expect(s.foldedCount).toBeGreaterThan(0);

		s.attach(new BuiltinConductor());
		expect(s.foldedCount).toBeGreaterThan(0);
		expect(s.liveTokens).toBeLessThanOrEqual(s.budget);
	});

	it("no conductor never invents folding even over budget", () => {
		const s = makeStore(Array.from({ length: 6 }, (_, i) => blk(i)));
		s.detach();
		s.setProtect(2000);
		s.setBudget(2500);
		expect(s.foldedCount).toBe(0); // raw, even though wildly over budget
	});
});

describe("conductor seam — human overrides always win", () => {
	it("a human pin survives a conductor fold of the same block", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.pin("m0:p0");

		const stub = new StubConductor();
		stub.cmds = [{ kind: "fold", ids: ["m0:p0", "m1:p0"] }];
		s.attach(stub);

		expect(s.isFolded(s.get("m0:p0")!)).toBe(false); // pinned → conductor refused
		expect(s.get("m0:p0")!.override).toBe("pinned");
		expect(s.isFolded(s.get("m1:p0")!)).toBe(true); // un-held → conductor folds it
		expect(s.get("m1:p0")!.by).toBe("auto"); // attribution is now uniform across all conductors
	});

	it("a human manual fold survives a conductor pass that folds nothing", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.fold("m0:p0"); // human fold

		const stub = new StubConductor();
		stub.cmds = []; // conductor wants nothing folded
		s.attach(stub);

		expect(s.isFolded(s.get("m0:p0")!)).toBe(true);
		expect(s.get("m0:p0")!.override).toBe("folded");
	});
});

describe("conductor seam — substitution", () => {
	it("fold with no digest falls back to the engine digest (recovery tag preserved)", () => {
		const s = makeStore(Array.from({ length: 3 }, (_, i) => blk(i)));
		s.setProtect(0);
		const stub = new StubConductor();
		stub.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		s.attach(stub);

		const b = s.get("m0:p0")!;
		expect(s.isFolded(b)).toBe(true);
		expect(s.digestOf(b)).toContain("FOLDED"); // engine digest carries {#code FOLDED}
		expect(b.subst).toBeUndefined();
	});

	it("replace substitutes arbitrary content; '' folds to the engine digest (smallest wire-safe form)", () => {
		const s = makeStore(Array.from({ length: 3 }, (_, i) => blk(i)));
		s.setProtect(0);
		const stub = new StubConductor();
		stub.cmds = [
			{ kind: "replace", id: "m0:p0", content: "see summary above" },
			{ kind: "replace", id: "m1:p0", content: "" },
		];
		s.attach(stub);

		const a = s.get("m0:p0")!;
		expect(s.isFolded(a)).toBe(true);
		expect(s.digestOf(a)).toBe("see summary above");

		const e = s.get("m1:p0")!;
		expect(s.isFolded(e)).toBe(true);
		// An empty replacement can't be sent on the wire (an empty content part is invalid), so
		// the host folds it to the engine digest — the smallest wire-safe form — never literal "".
		// The view then matches exactly what the agent receives (no empty-digest divergence).
		expect(s.digestOf(e)).toBe(digest(e));
		expect(s.digestOf(e)).not.toBe("");
		expect(s.effTokens(e)).toBe(digestTokens(e));
	});

	it("restore returns a conductor-folded block to live", () => {
		const s = makeStore(Array.from({ length: 3 }, (_, i) => blk(i)));
		s.setProtect(0);
		const stub = new StubConductor();
		stub.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		s.attach(stub);
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true);

		stub.cmds = [{ kind: "restore", ids: ["m0:p0"] }];
		s.refold();
		expect(s.isFolded(s.get("m0:p0")!)).toBe(false);
	});
});

describe("conductor seam — clamp reports (provider-validity floor)", () => {
	it("reports an unknown id instead of throwing", () => {
		const s = makeStore([blk(0), blk(1)]);
		const reports = s.applyCommands([{ kind: "fold", ids: ["ghost:p0"] }], "conductor");
		expect(reports).toHaveLength(1);
		expect(reports[0].reason).toBe("unknown-id");
	});

	it("reports a human-override conflict and leaves the human's choice intact", () => {
		const s = makeStore([blk(0), blk(1)]);
		s.setProtect(0);
		s.pin("m0:p0");
		const reports = s.applyCommands([{ kind: "fold", ids: ["m0:p0"] }], "conductor");
		expect(reports[0].reason).toBe("human-override");
		expect(s.get("m0:p0")!.override).toBe("pinned");
		expect(s.isFolded(s.get("m0:p0")!)).toBe(false);
	});

	it("reports an invalid group (fewer than two blocks)", () => {
		const s = makeStore([blk(0), blk(1)]);
		const reports = s.applyCommands([{ kind: "group", ids: ["m0:p0"] }], "conductor");
		expect(reports[0].reason).toBe("invalid-group");
	});

	// (2) MAJOR regression: a conductor must NEVER fold a protected-tail block — protection
	// is absolute. With protectTokens covering the whole session every block is protected, so
	// even the newest id must be clamped, not folded.
	it("clamps a fold of a protected-tail block with reason 'protected' and leaves it live", () => {
		const s = makeStore([blk(0), blk(1)]);
		// default protectTokens (20k) > total fixture tokens (2k) → all blocks protected
		expect(s.protectedFromIndex).toBe(0);
		const newest = s.blocks[s.blocks.length - 1].id;

		const reports = s.applyCommands([{ kind: "fold", ids: [newest] }], "auto");
		expect(reports).toHaveLength(1);
		expect(reports[0].reason).toBe("protected");
		expect(reports[0].ids).toEqual([newest]);
		expect(s.isFolded(s.get(newest)!)).toBe(false); // stays live & full
	});

	it("clamps a replace of a protected-tail block with reason 'protected'", () => {
		const s = makeStore([blk(0), blk(1)]);
		const newest = s.blocks[s.blocks.length - 1].id;
		const reports = s.applyCommands([{ kind: "replace", id: newest, content: "x" }], "auto");
		expect(reports[0].reason).toBe("protected");
		expect(s.isFolded(s.get(newest)!)).toBe(false);
		expect(s.get(newest)!.subst).toBeUndefined();
	});

	// (3) MINOR regression: restoring/pinning an already-live block must REPORT a noop, not
	// silently swallow it — the contract documents the reason as reachable.
	it("reports 'noop' when restoring an already-live block", () => {
		const s = makeStore([blk(0), blk(1)]);
		s.setProtect(0);
		const reports = s.applyCommands([{ kind: "restore", ids: ["m0:p0"] }], "auto");
		expect(reports).toHaveLength(1);
		expect(reports[0].reason).toBe("noop");
	});

	it("reports 'noop' when pinning an already-live block", () => {
		const s = makeStore([blk(0), blk(1)]);
		s.setProtect(0);
		const reports = s.applyCommands([{ kind: "pin", ids: ["m1:p0"] }], "auto");
		expect(reports[0].reason).toBe("noop");
	});
});

describe("conductor seam — group command", () => {
	it("collapses a contiguous run via the existing group machinery", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		const stub = new StubConductor();
		stub.cmds = [{ kind: "group", ids: ["m0:p0", "m1:p0"] }];
		s.attach(stub);

		expect(s.groups.length).toBe(1);
		expect(s.groups[0].folded).toBe(true);
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true);
		expect(s.isFolded(s.get("m1:p0")!)).toBe(true);
	});

	// (1) BLOCKER regression: a conductor group must be cleared once the conductor stops
	// asking for it — otherwise it strands folded forever (clearConductorState never dropped it).
	it("clears a conductor group when the conductor returns [] (clear to raw)", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		const stub = new StubConductor();
		stub.cmds = [{ kind: "group", ids: ["m0:p0", "m1:p0"] }];
		s.attach(stub);
		expect(s.groups.length).toBe(1); // group exists

		stub.cmds = []; // conductor now wants raw
		s.refold();
		expect(s.groups.length).toBe(0); // group is gone — not stranded
		expect(s.isFolded(s.get("m0:p0")!)).toBe(false);
		expect(s.isFolded(s.get("m1:p0")!)).toBe(false);
	});

	// ADR 0011 §6: detach FREEZES — a folded conductor group is reassigned to the human
	// (by:"you") so the frozen view persists; it is NOT cleared to raw. (Programmatic raw via
	// `attach(null)` still clears it — covered by the "clear to raw" group tests above.)
	it("freezes a folded conductor group on detach() (reassigned to the human, not cleared)", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		const stub = new StubConductor();
		stub.cmds = [{ kind: "group", ids: ["m0:p0", "m1:p0"] }];
		s.attach(stub);
		expect(s.groups.length).toBe(1);

		s.detach();
		expect(s.groups.length).toBe(1); // group preserved (frozen), now human-owned
		expect(s.groups[0].by).toBe("you");
		expect(s.groups[0].folded).toBe(true);
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true); // still collapsed
		expect(s.conductor).toBe(null);
		// The human can now reverse it (delete the frozen group).
		s.deleteGroup(s.groups[0].id);
		expect(s.groups.length).toBe(0);
	});

	it("attach(null) — the programmatic go-raw — still clears a conductor group", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		const stub = new StubConductor();
		stub.cmds = [{ kind: "group", ids: ["m0:p0", "m1:p0"] }];
		s.attach(stub);
		expect(s.groups.length).toBe(1);

		s.attach(null); // programmatic raw (NOT the kill switch) → conductor group dropped
		expect(s.groups.length).toBe(0);
		expect(s.blocks.every((b) => !s.isFolded(b))).toBe(true);
	});

	it("a HUMAN group survives a conductor pass and is logged once", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		// Human creates a group directly (by:"you" default).
		const hg = s.createGroup("m0:p0", "m1:p0")!;
		expect(s.groups.length).toBe(1);
		expect(hg.by).toBe("you");
		const humanGroupLogs = s.log.filter((e) => e.action === "grouped").length;
		expect(humanGroupLogs).toBe(1); // human group logged exactly once

		// A conductor attaches and folds elsewhere — must not disturb the human group.
		const stub = new StubConductor();
		stub.cmds = [{ kind: "fold", ids: ["m2:p0"] }];
		s.attach(stub);

		expect(s.groups.length).toBe(1); // human group preserved
		expect(s.groups[0].by).toBe("you");
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true); // still collapsed by its group
		expect(s.log.filter((e) => e.action === "grouped").length).toBe(1); // no extra "grouped" emit

		// And the conductor going raw still leaves the human group intact.
		stub.cmds = [];
		s.refold();
		expect(s.groups.length).toBe(1);
		expect(s.groups[0].by).toBe("you");
	});

	it("a conductor group recreated every pass does NOT spam the activity log", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		const stub = new StubConductor();
		stub.cmds = [{ kind: "group", ids: ["m0:p0", "m1:p0"] }];
		s.attach(stub);
		s.refold();
		s.refold(); // several passes rebuild the same group each time
		expect(s.log.filter((e) => e.action === "grouped").length).toBe(0); // conductor groups emit nothing
	});

	it("refuses to group over a human-held block (human always wins)", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		s.pin("m1:p0"); // human pins a block inside the conductor's intended range

		const reports = s.applyCommands([{ kind: "group", ids: ["m0:p0", "m2:p0"] }], "conductor");

		expect(reports.some((r) => r.reason === "human-override")).toBe(true);
		expect(s.groups.length).toBe(0); // no group created — the whole command is refused
		expect(s.isFolded(s.get("m1:p0")!)).toBe(false); // pinned block stays live & full
		expect(s.get("m1:p0")!.override).toBe("pinned");
	});
});

describe("conductor seam — hold last state (null)", () => {
	it("re-applies the last batch across an append, leaving new blocks raw", () => {
		const s = makeStore(Array.from({ length: 3 }, (_, i) => blk(i)));
		s.setProtect(0);
		const stub = new StubConductor();
		stub.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		s.attach(stub);
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true);

		// Conductor goes silent (still thinking) and a new block streams in.
		stub.cmds = null;
		s.appendBlocks([blk(9)]);

		expect(s.isFolded(s.get("m0:p0")!)).toBe(true); // held
		expect(s.isFolded(s.get("m9:p0")!)).toBe(false); // new content arrives raw
	});
});

describe("conductor seam — in-process async rerun hook", () => {
	it("lets an in-process conductor request a fresh pass after returning null", async () => {
		const s = makeStore(Array.from({ length: 3 }, (_, i) => blk(i)));
		s.setProtect(0);
		const stub = new AsyncStubConductor();
		stub.cmds = null; // still computing: attach pass should hold raw
		s.attach(stub);

		expect(stub.attachCalls).toBe(1);
		expect(stub.host).not.toBeNull();
		expect(s.isFolded(s.get("m0:p0")!)).toBe(false);

		stub.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		stub.host!.requestRerun();
		await flushMicrotasks();

		expect(s.isFolded(s.get("m0:p0")!)).toBe(true);
		expect(s.get("m0:p0")!.by).toBe("auto");
	});

	it("debounces a burst of async rerun requests into one conductor pass", async () => {
		const s = makeStore(Array.from({ length: 3 }, (_, i) => blk(i)));
		s.setProtect(0);
		const stub = new AsyncStubConductor();
		s.attach(stub);
		const before = stub.conductCalls;

		stub.host!.requestRerun();
		stub.host!.requestRerun();
		stub.host!.requestRerun();
		await flushMicrotasks();

		expect(stub.conductCalls).toBe(before + 1);
	});

	it("ignores stale rerun requests after the conductor is replaced", async () => {
		const s = makeStore(Array.from({ length: 3 }, (_, i) => blk(i)));
		s.setProtect(0);
		const oldConductor = new AsyncStubConductor();
		s.attach(oldConductor);
		const oldHost = oldConductor.host!;
		const oldCalls = oldConductor.conductCalls;

		const replacement = new StubConductor();
		replacement.cmds = [];
		s.attach(replacement);
		expect(oldConductor.detachCalls).toBe(1);

		oldConductor.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		oldHost.requestRerun();
		await flushMicrotasks();

		expect(oldConductor.conductCalls).toBe(oldCalls); // stale host poke did not re-enter it
		expect(s.isFolded(s.get("m0:p0")!)).toBe(false); // replacement's raw state remains
	});

	it("ignores a rerun that was queued before the conductor was replaced", async () => {
		const s = makeStore(Array.from({ length: 3 }, (_, i) => blk(i)));
		s.setProtect(0);
		const oldConductor = new AsyncStubConductor();
		s.attach(oldConductor);
		const oldCalls = oldConductor.conductCalls;
		oldConductor.host!.requestRerun(); // queued while oldConductor is still active

		const replacement = new StubConductor();
		replacement.cmds = [];
		s.attach(replacement); // invalidates the queued old-host callback before it runs
		await flushMicrotasks();

		expect(oldConductor.conductCalls).toBe(oldCalls);
		expect(s.isFolded(s.get("m0:p0")!)).toBe(false);
	});

	it("a queued stale rerun cannot clear the next conductor's debounce latch", async () => {
		const s = makeStore(Array.from({ length: 3 }, (_, i) => blk(i)));
		s.setProtect(0);
		const oldConductor = new AsyncStubConductor();
		s.attach(oldConductor);
		oldConductor.host!.requestRerun(); // stale callback will run before the new callback

		const nextConductor = new AsyncStubConductor();
		s.attach(nextConductor);
		const nextCalls = nextConductor.conductCalls;
		nextConductor.host!.requestRerun();
		nextConductor.host!.requestRerun();
		await flushMicrotasks();

		expect(nextConductor.conductCalls).toBe(nextCalls + 1);
	});

	it("ignores stale rerun requests after plain detach", async () => {
		const s = makeStore(Array.from({ length: 3 }, (_, i) => blk(i)));
		s.setProtect(0);
		const stub = new AsyncStubConductor();
		s.attach(stub);
		const host = stub.host!;
		const calls = stub.conductCalls;

		s.detach();
		stub.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		host.requestRerun();
		await flushMicrotasks();

		expect(stub.conductCalls).toBe(calls);
		expect(s.isFolded(s.get("m0:p0")!)).toBe(false);
	});

	it("calls detach lifecycle when a conductor is detached", () => {
		const s = makeStore(Array.from({ length: 2 }, (_, i) => blk(i)));
		const stub = new AsyncStubConductor();
		s.attach(stub);
		s.detach();
		expect(stub.detachCalls).toBe(1);
	});

	it("logs and continues when attach lifecycle throws", () => {
		const s = makeStore(Array.from({ length: 2 }, (_, i) => blk(i)));
		s.setProtect(0);
		const stub = new ThrowLifecycleConductor();
		stub.throwAttach = true;
		stub.cmds = [{ kind: "fold", ids: ["m0:p0"] }];

		expect(() => s.attach(stub)).not.toThrow();
		expect(s.log.some((e) => e.action === "conductor attach error" && e.detail === "attach boom")).toBe(true);
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true); // conduct still ran after the lifecycle error
	});

	it("logs and continues when detach lifecycle throws", () => {
		const s = makeStore(Array.from({ length: 2 }, (_, i) => blk(i)));
		s.setProtect(0);
		const stub = new ThrowLifecycleConductor();
		stub.throwDetach = true;
		stub.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		s.attach(stub);
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true);

		expect(() => s.detach()).not.toThrow();
		expect(s.log.some((e) => e.action === "conductor detach error" && e.detail === "detach boom")).toBe(true);
		expect(s.conductor).toBe(null);
		expect(s.isFolded(s.get("m0:p0")!)).toBe(true); // kill-switch detach still froze the view
		expect(s.get("m0:p0")!.by).toBe("you");
	});
});

describe("conductor seam — human takeover clears conductor substitution", () => {
	it("a human fold drops stale conductor text and restores the engine digest + recovery tag", () => {
		const s = makeStore(Array.from({ length: 3 }, (_, i) => blk(i)));
		s.setProtect(0);
		const stub = new StubConductor();
		stub.cmds = [{ kind: "replace", id: "m0:p0", content: "STALE-CONDUCTOR-TEXT" }];
		s.attach(stub);
		expect(s.digestOf(s.get("m0:p0")!)).toBe("STALE-CONDUCTOR-TEXT");

		s.fold("m0:p0"); // human takes control of the same block
		const b = s.get("m0:p0")!;
		expect(b.override).toBe("folded");
		expect(b.subst).toBeUndefined(); // conductor substitution cleared
		expect(s.digestOf(b)).toContain("FOLDED"); // engine digest with {#code FOLDED} recovery tag
		expect(s.digestOf(b)).not.toBe("STALE-CONDUCTOR-TEXT");
	});
});

describe("conductor seam — noop clamp report suppression", () => {
	it("a noop restore report is in lastReports but NOT in store.log for a conductor pass", () => {
		const s = makeStore([blk(0), blk(1)]);
		s.setProtect(0);
		// Attach a stub that always issues a restore on an already-live block (which is a noop).
		const stub = new StubConductor();
		stub.cmds = [{ kind: "restore", ids: ["m0:p0"] }]; // m0:p0 is live → noop
		s.attach(stub);

		// The noop report MUST be present in lastReports (the wire still needs it).
		expect(s.lastReports.some((r) => r.reason === "noop")).toBe(true);

		// But it must NOT appear in the activity log — suppress noop spam for auto passes.
		expect(s.log.some((e) => e.action.includes("noop"))).toBe(false);

		// Trigger another pass to confirm it doesn't accumulate across passes.
		s.refold();
		expect(s.log.some((e) => e.action.includes("noop"))).toBe(false);
	});
});

describe("conductor seam — humanOverride notification", () => {
	it("fires onHumanOverride for human actions but never for agent-provenance ones", () => {
		const s = makeStore(Array.from({ length: 3 }, (_, i) => blk(i)));
		s.setProtect(0);
		const calls: { ids: string[]; action: string }[] = [];
		s.onHumanOverride = (ids, action) => calls.push({ ids, action });

		s.pin("m0:p0");
		s.fold("m1:p0");
		s.unfold("m2:p0", "agent"); // agent provenance — must NOT notify a conductor of a "human" override

		expect(calls).toEqual([
			{ ids: ["m0:p0"], action: "pinned" },
			{ ids: ["m1:p0"], action: "folded" },
		]);
	});
});
