import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import { BuiltinConductor } from "$conductors";
import type { Conductor, ConductorView, Command } from "$conductors/contract";
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

describe("conductor seam — attach / detach", () => {
	it("detach() makes the context raw (nothing folded)", () => {
		const s = makeStore(Array.from({ length: 6 }, (_, i) => blk(i)));
		s.setProtect(2000);
		s.setBudget(2500); // 6000 live > budget → built-in must fold
		expect(s.foldedCount).toBeGreaterThan(0);

		s.detach();
		expect(s.foldedCount).toBe(0);
		expect(s.blocks.every((b) => !s.isFolded(b))).toBe(true);
		expect(s.blocks.every((b) => b.subst === undefined)).toBe(true);
		expect(s.liveTokens).toBe(s.fullTokens);
	});

	it("re-attaching a fresh built-in restores folding", () => {
		const s = makeStore(Array.from({ length: 6 }, (_, i) => blk(i)));
		s.setProtect(2000);
		s.setBudget(2500);
		s.detach();
		expect(s.foldedCount).toBe(0);

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

	it("clears a conductor group on detach()", () => {
		const s = makeStore(Array.from({ length: 4 }, (_, i) => blk(i)));
		s.setProtect(0);
		const stub = new StubConductor();
		stub.cmds = [{ kind: "group", ids: ["m0:p0", "m1:p0"] }];
		s.attach(stub);
		expect(s.groups.length).toBe(1);

		s.detach();
		expect(s.groups.length).toBe(0); // detaching the conductor removes its group
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
