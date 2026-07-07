/*
 * store.birthfold.test.ts — behavioural tests for the birth-fold exemption (#43, ADR 0017).
 *
 * A fresh, oversized `tool_result` is born INSIDE the protected working tail the instant it
 * streams in (the tail is a token-target walk-back from the newest block, so a huge new block
 * often falls inside it on its very first pass). Without an exemption, every conductor without
 * the `tail-size` lock is refused by `substOne`'s "protected" clamp and the model sees the
 * block at full size on its first call. The exemption: a NEVER-SENT block may be folded/
 * replaced despite protection, and the exemption stays sticky (via `birthFolded`) for as long
 * as the block remains in the tail — because commands re-apply from a raw baseline every pass
 * (ADR 0007), a fresh-only exemption would un-fold itself the instant `markSent()` advances.
 *
 * Driven through the REAL `AccordionStore` (`applyCommands`/`refold`), not a MockHost — a
 * conductor-only unit test would miss the host's own protected-tail clamp entirely (see
 * store.host.test.ts's design note and PR #49's regression).
 */
import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import { computeFoldOps } from "../live/plan";
import type { Conductor, ConductorView, Command } from "$conductors/contract";
import type { Block, ParsedSession } from "./types";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Durable, message-anchored ids so fixtures mirror real live-wire id shapes. */
function blk(id: string, kind: Block["kind"], turn: number, order: number, tokens = 1000, extra: Partial<Block> = {}): Block {
	return {
		id,
		kind,
		turn,
		order,
		text: `${id} ` + "x".repeat(tokens * 4),
		tokens,
		override: null,
		autoFolded: false,
		by: null,
		...extra,
	};
}

/** Bulk-loaded (transcript) construction — every block present at construction reads
 *  fresh=false (issue #43, PM correction (h)): a parsed session was already fully sent. */
function makeStore(blocks: Block[]): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks,
		lineCount: 0,
		skipped: 0,
	};
	return new AccordionStore(parsed);
}

/**
 * LIVE-style construction: an empty store (mirrors `liveClient`'s hello/full-sync path),
 * with `blocks` streamed in via `appendBlocks` exactly like the real live link. This is the
 * only construction path where `fresh` can ever read true — a bulk load marks everything
 * sent at construction (h), so birth-fold scenarios must go through this helper.
 */
function makeLiveStore(blocks: Block[]): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks: [],
		lineCount: 0,
		skipped: 0,
	};
	const s = new AccordionStore(parsed);
	s.appendBlocks(blocks);
	return s;
}

/** A conductor whose desired command batch the test controls directly, to drive a full pass. */
class StubConductor implements Conductor {
	readonly id = "stub";
	readonly label = "Stub";
	cmds: Command[] | null = [];
	lastView: ConductorView | null = null;
	conduct(view: ConductorView): Command[] | null {
		this.lastView = view;
		return this.cmds;
	}
}

/** A small session: an old user turn, then a huge fresh tool_result as the newest block. */
function sessionWithFreshResult(resultTokens = 8000): Block[] {
	return [
		blk("u:1", "user", 1, 0, 500),
		blk("a:r1:p0", "text", 1, 1, 500),
		blk("a:r1:p1", "tool_call", 1, 2, 200, { callId: "c1" }),
		blk("r:c1", "tool_result", 1, 3, resultTokens, { callId: "c1" }),
	];
}

// ── (a) fresh oversized tool_result in the tail: conductor may fold it ────────

describe("birth-fold — fresh block inside the protected tail", () => {
	it("a conductor CAN fold a fresh, protected, oversized tool_result — not clamped protected", () => {
		const s = makeLiveStore(sessionWithFreshResult(8000));
		s.setProtect(20_000); // small session — the whole thing (1200 + 8000) sits in the tail
		expect(s.isProtected(s.get("r:c1")!)).toBe(true);

		const before = s.liveTokens;
		const conductor = new StubConductor();
		conductor.cmds = [{ kind: "fold", ids: ["r:c1"] }];
		s.attach(conductor);

		// Applied, not clamped "protected".
		expect(s.lastReports.some((r) => r.ids.includes("r:c1") && r.reason === "protected")).toBe(false);
		expect(s.isFolded(s.get("r:c1")!)).toBe(true);
		expect(s.liveTokens).toBeLessThan(before);

		// The wire ops include it — the agent actually receives the folded form.
		const ops = computeFoldOps(s);
		expect(ops.some((o) => o.id === "r:c1")).toBe(true);
	});

	it("the view's fresh flag is true for a never-sent block and false for the rest", () => {
		const s = makeLiveStore(sessionWithFreshResult(8000));
		s.setProtect(20_000);
		const conductor = new StubConductor();
		s.attach(conductor);

		const view = conductor.lastView!;
		const result = view.blocks.find((b) => b.id === "r:c1")!;
		expect(result.fresh).toBe(true);
	});
});

// ── (b) sticky exemption survives markSent() ──────────────────────────────────

describe("birth-fold — sticky exemption across passes", () => {
	it("stays folded after markSent() even though the block is no longer fresh", () => {
		const s = makeLiveStore(sessionWithFreshResult(8000));
		s.setProtect(20_000); // block stays in the tail across this test

		const conductor = new StubConductor();
		conductor.cmds = [{ kind: "fold", ids: ["r:c1"] }];
		s.attach(conductor);
		expect(s.isFolded(s.get("r:c1")!)).toBe(true);

		// The model has now "seen" everything up to the newest block.
		s.markSent();
		// isFresh is private; assert indirectly via the next conduct() pass's view.
		s.refold(); // re-run the same conductor pass (cmds unchanged)

		const view = conductor.lastView!;
		const result = view.blocks.find((b) => b.id === "r:c1")!;
		// No longer fresh by the raw definition, but the sticky exemption still reads true...
		expect(result.fresh).toBe(true);
		// ...and the fold itself survived the pass (not re-clamped "protected").
		expect(s.isFolded(s.get("r:c1")!)).toBe(true);
		expect(s.lastReports.some((r) => r.ids.includes("r:c1") && r.reason === "protected")).toBe(false);
	});
});

// ── (c) aging out of the tail: ordinary fold rules resume, exemption pruned ───

describe("birth-fold — pruned once the block leaves the protected tail", () => {
	it("an ordinary (non-exempt) fold still works once the block ages out of the tail", () => {
		const s = makeLiveStore(sessionWithFreshResult(8000));
		s.setProtect(20_000);
		const conductor = new StubConductor();
		conductor.cmds = [{ kind: "fold", ids: ["r:c1"] }];
		s.attach(conductor);
		s.markSent();
		expect(s.isFolded(s.get("r:c1")!)).toBe(true);

		// Shrink the tail so r:c1 is no longer protected — it ages out normally.
		s.setProtect(0);
		expect(s.isProtected(s.get("r:c1")!)).toBe(false);
		// A normal (non-birth) fold still applies with no clamp at all.
		expect(s.isFolded(s.get("r:c1")!)).toBe(true);
		expect(s.lastReports.some((r) => r.ids.includes("r:c1"))).toBe(false);
	});
});

// ── (d) human unfold wins over a birth-folded block ───────────────────────────

describe("birth-fold — human override wins", () => {
	it("a human unfold beats a birth-folded block and the conductor cannot re-fold it", () => {
		const s = makeLiveStore(sessionWithFreshResult(8000));
		s.setProtect(20_000);
		const conductor = new StubConductor();
		conductor.cmds = [{ kind: "fold", ids: ["r:c1"] }];
		s.attach(conductor);
		expect(s.isFolded(s.get("r:c1")!)).toBe(true);

		s.unfold("r:c1", "you");
		expect(s.isFolded(s.get("r:c1")!)).toBe(false);

		// The conductor still asks to fold it every pass; the human wins every time.
		s.refold();
		expect(s.isFolded(s.get("r:c1")!)).toBe(false);
		expect(s.lastReports.some((r) => r.ids.includes("r:c1") && r.reason === "human-override")).toBe(true);

		// And it stays unfolded across further passes (markSent doesn't resurrect the conductor's claim).
		s.markSent();
		s.refold();
		expect(s.isFolded(s.get("r:c1")!)).toBe(false);
	});
});

// ── (e) the exemption is narrow: non-fresh, non-birth-folded protected blocks still clamp ─

describe("birth-fold — exemption is narrow", () => {
	it("a non-fresh, never-birth-folded block inside the tail still clamps protected", () => {
		const s = makeLiveStore(sessionWithFreshResult(8000));
		s.setProtect(20_000);
		// Mark everything sent BEFORE any conductor ever tries to fold r:c1, so it never earns
		// the sticky exemption in the first place.
		s.markSent();

		const conductor = new StubConductor();
		conductor.cmds = [{ kind: "fold", ids: ["r:c1"] }];
		s.attach(conductor);

		expect(s.isFolded(s.get("r:c1")!)).toBe(false);
		expect(s.lastReports.some((r) => r.ids.includes("r:c1") && r.reason === "protected")).toBe(true);
	});
});

// ── (f) fresh user / tool_call are never eligible (kind gate still applies) ───

describe("birth-fold — kind gate still applies to fresh blocks", () => {
	// Protection is turned OFF here to isolate the kind gate: a fresh user/tool_call is still
	// PROTECTED under setProtect(20_000) (the whole tiny session sits in the tail), and
	// `birthFoldEligible` is kind-gated FIRST — so a protected, non-foldable, fresh block
	// reports "protected", not "not-foldable" (the protected check runs before the kind check
	// in `substOne`, unchanged from pre-#43 ordering). With protection off, the kind gate is
	// the only thing left standing between "fresh" and "folded."
	it("a fresh user block is never foldable, birth-fold or not", () => {
		const s = makeLiveStore(sessionWithFreshResult(8000));
		s.setProtect(0);
		const conductor = new StubConductor();
		conductor.cmds = [{ kind: "fold", ids: ["u:1"] }];
		s.attach(conductor);

		expect(s.isFolded(s.get("u:1")!)).toBe(false);
		expect(s.lastReports.some((r) => r.ids.includes("u:1") && r.reason === "not-foldable")).toBe(true);
	});

	it("a fresh tool_call block is never foldable, birth-fold or not", () => {
		const s = makeLiveStore(sessionWithFreshResult(8000));
		s.setProtect(0);
		const conductor = new StubConductor();
		conductor.cmds = [{ kind: "fold", ids: ["a:r1:p1"] }];
		s.attach(conductor);

		expect(s.isFolded(s.get("a:r1:p1")!)).toBe(false);
		expect(s.lastReports.some((r) => r.ids.includes("a:r1:p1") && r.reason === "not-foldable")).toBe(true);
	});

	it("a fresh, PROTECTED user block reports protected, not not-foldable (protected check runs first)", () => {
		const s = makeLiveStore(sessionWithFreshResult(8000));
		s.setProtect(20_000); // whole tiny session sits in the tail
		const conductor = new StubConductor();
		conductor.cmds = [{ kind: "fold", ids: ["u:1"] }];
		s.attach(conductor);

		expect(s.isFolded(s.get("u:1")!)).toBe(false);
		expect(s.lastReports.some((r) => r.ids.includes("u:1") && r.reason === "protected")).toBe(true);
	});
});

// ── (g) healProtected does not heal a birth-fold ──────────────────────────────

describe("birth-fold — healProtected leaves it alone", () => {
	it("a birth-folded block is not force-unfolded by the protected-tail healer", () => {
		const s = makeLiveStore(sessionWithFreshResult(8000));
		s.setProtect(20_000);
		const conductor = new StubConductor();
		conductor.cmds = [{ kind: "fold", ids: ["r:c1"] }];
		s.attach(conductor);
		expect(s.isFolded(s.get("r:c1")!)).toBe(true);

		// Re-run refold several times (healProtected runs on every pass) — a birth-fold has
		// override === null (it's conductor-owned, not a human override), so `healProtected`
		// (which only reverts b.override === "folded") must never touch it.
		s.refold();
		s.refold();
		expect(s.isFolded(s.get("r:c1")!)).toBe(true);
		expect(s.get("r:c1")!.override).toBe(null);
	});
});

// ── (h) bulk-loaded (transcript) blocks read fresh=false ──────────────────────

describe("birth-fold — bulk-loaded sessions are never fresh", () => {
	it("every block in a constructor-loaded (non-live) session reads fresh=false", () => {
		const s = makeStore(sessionWithFreshResult(8000));
		s.setProtect(20_000); // put r:c1 in the tail so fresh would matter if it were true
		const conductor = new StubConductor();
		s.attach(conductor);

		const view = conductor.lastView!;
		for (const b of view.blocks) expect(b.fresh).toBe(false);
	});

	it("a bulk-loaded protected oversized tool_result is therefore NOT birth-foldable", () => {
		const s = makeStore(sessionWithFreshResult(8000));
		s.setProtect(20_000);
		const conductor = new StubConductor();
		conductor.cmds = [{ kind: "fold", ids: ["r:c1"] }];
		s.attach(conductor);

		// No exemption for a block that was already fully part of the loaded transcript.
		expect(s.isFolded(s.get("r:c1")!)).toBe(false);
		expect(s.lastReports.some((r) => r.ids.includes("r:c1") && r.reason === "protected")).toBe(true);
	});
});

// ── (i) full-sync replay marked sent: appendBlocks(backlog, { sent: true }) ────

describe("birth-fold — a full-sync backlog replay is never fresh (reconnect protection bypass)", () => {
	it("appendBlocks(backlog, { sent: true }) on an empty store → nothing fresh, tail fold clamps protected", () => {
		// Mirror the GUI reconnect path exactly: a fresh EMPTY store (sentThroughOrder = -1),
		// a birth-folding conductor already attached, then the extension replays the WHOLE
		// history in one full:true sync — the appendBlocks call below runs the conduct pass
		// DURING the append, the exact window the bypass lived in.
		const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks: [], lineCount: 0, skipped: 0 };
		const s = new AccordionStore(parsed);
		s.setProtect(20_000); // whole small session will sit in the protected tail
		const conductor = new StubConductor();
		conductor.cmds = [{ kind: "fold", ids: ["r:c1"] }];
		s.attach(conductor);

		s.appendBlocks(sessionWithFreshResult(8000), { sent: true });

		// The replayed history was marked sent BEFORE the conduct pass: nothing reads fresh...
		const view = conductor.lastView!;
		for (const b of view.blocks) expect(b.fresh).toBe(false);
		// ...so the fold inside the tail clamps "protected" — no birth-fold, no sticky exemption.
		expect(s.isFolded(s.get("r:c1")!)).toBe(false);
		expect(s.lastReports.some((r) => r.ids.includes("r:c1") && r.reason === "protected")).toBe(true);

		// birthFolded stayed empty (assert indirectly — it's private): re-running the pass
		// still clamps protected; a sticky exemption would have let the fold through.
		s.refold();
		expect(s.isFolded(s.get("r:c1")!)).toBe(false);
		expect(s.lastReports.some((r) => r.ids.includes("r:c1") && r.reason === "protected")).toBe(true);
	});

	it("a subsequent plain appendBlocks (no flag) is fresh and birth-foldable as before", () => {
		const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks: [], lineCount: 0, skipped: 0 };
		const s = new AccordionStore(parsed);
		s.setProtect(20_000);
		const conductor = new StubConductor();
		conductor.cmds = [{ kind: "fold", ids: ["r:c2"] }];
		s.attach(conductor);
		s.appendBlocks(sessionWithFreshResult(8000), { sent: true }); // the reconnect backlog

		// A genuinely NEW oversized tool_result streams in afterwards — normal incremental sync.
		s.appendBlocks([
			blk("a:r2:p0", "tool_call", 2, 4, 200, { callId: "c2" }),
			blk("r:c2", "tool_result", 2, 5, 8000, { callId: "c2" }),
		]);

		// It reads fresh and the conductor birth-folds it despite protection.
		const view = conductor.lastView!;
		expect(view.blocks.find((b) => b.id === "r:c2")!.fresh).toBe(true);
		expect(s.isProtected(s.get("r:c2")!)).toBe(true);
		expect(s.isFolded(s.get("r:c2")!)).toBe(true);
		expect(s.lastReports.some((r) => r.ids.includes("r:c2") && r.reason === "protected")).toBe(false);
	});
});

// ── golden must stay green — sanity check that birth-fold plumbing is inert by default ──

describe("birth-fold — no behavior change when nothing is fresh (regression guard)", () => {
	it("a normal loaded session with the built-in conductor folds exactly as before (no fresh blocks in play)", () => {
		const s = makeStore(sessionWithFreshResult(500)); // small enough to fit budget, nothing folds
		expect(s.foldedCount).toBe(0);
	});
});

// ── (j) settling live across an applied plan drops the exemption (truth prune) ─

describe("birth-fold — sent whole once, protected again forever", () => {
	it("a block that settled LIVE across a planned sync can no longer be re-folded while protected", () => {
		const s = makeLiveStore(sessionWithFreshResult(8000));
		s.setProtect(20_000);
		const conductor = new StubConductor();
		conductor.cmds = [{ kind: "fold", ids: ["r:c1"] }];
		s.attach(conductor);
		expect(s.isFolded(s.get("r:c1")!)).toBe(true);
		s.markSent(); // pass 1 applied: r:c1 rode the wire FOLDED — exemption survives

		conductor.cmds = []; // pass 2: the conductor stops folding it — it settles live
		s.refold();
		expect(s.isFolded(s.get("r:c1")!)).toBe(false);
		s.markSent(); // pass 2 applied: r:c1 crossed the wire WHOLE — the model has seen it

		conductor.cmds = [{ kind: "fold", ids: ["r:c1"] }]; // pass 3: try to re-fold
		s.refold();
		// The stale exemption is gone: protection clamps like for any other seen block.
		expect(s.isFolded(s.get("r:c1")!)).toBe(false);
		expect(s.lastReports.some((r) => r.ids.includes("r:c1") && r.reason === "protected")).toBe(true);
	});
});

// ── (k) detach freezes an active birth-fold in place (no heal, no budget re-blow) ─

describe("birth-fold — detach freezes the fold instead of popping it open", () => {
	it("the oversized block stays folded through detach and subsequent refolds", () => {
		const s = makeLiveStore(sessionWithFreshResult(8000));
		s.setProtect(20_000);
		const conductor = new StubConductor();
		conductor.cmds = [{ kind: "fold", ids: ["r:c1"] }];
		s.attach(conductor);
		expect(s.isFolded(s.get("r:c1")!)).toBe(true);
		const before = s.liveTokens;

		s.detach();

		const b = s.get("r:c1")!;
		expect(s.isFolded(b)).toBe(true); // frozen human-owned, NOT healed back to full
		expect(b.override).toBe("folded");
		expect(b.by).toBe("you");
		expect(s.liveTokens).toBe(before); // the budget detach protects did not re-blow
		expect(s.log.some((e) => e.action === "unfolded (protected)")).toBe(false);

		// And the frozen view is stable across further conductor-less passes.
		s.refold();
		expect(s.isFolded(s.get("r:c1")!)).toBe(true);
	});
});

// ── (l) the exemption belongs to the block's wire history, not to one conductor ─

describe("birth-fold — exemption survives a conductor swap while never seen whole", () => {
	it("a different conductor may keep folding a block the model has never seen whole", () => {
		const s = makeLiveStore(sessionWithFreshResult(8000));
		s.setProtect(20_000);
		const a = new StubConductor();
		a.cmds = [{ kind: "fold", ids: ["r:c1"] }];
		s.attach(a);
		expect(s.isFolded(s.get("r:c1")!)).toBe(true);
		s.markSent(); // applied FOLDED — the model has still never seen it whole

		const b = new StubConductor();
		b.cmds = [{ kind: "fold", ids: ["r:c1"] }];
		s.attach(b); // swap conductors — the exemption is the block's, not A's

		expect(s.isFolded(s.get("r:c1")!)).toBe(true);
		expect(s.lastReports.some((r) => r.ids.includes("r:c1") && r.reason === "protected")).toBe(false);
	});
});

// ── (m) disarmed folding: a raw-wire planned sync drops ALL exemptions ─────────

describe("birth-fold — rawWire markSent (folding disarmed) clears the exemption", () => {
	it("a view-folded block whose call rode a RAW wire cannot be re-folded once protected", () => {
		const s = makeLiveStore(sessionWithFreshResult(8000));
		s.setProtect(20_000);
		const conductor = new StubConductor();
		conductor.cmds = [{ kind: "fold", ids: ["r:c1"] }];
		s.attach(conductor);
		expect(s.isFolded(s.get("r:c1")!)).toBe(true); // view-folded…

		// …but folding is DISARMED: the client replied with an EMPTY plan, so the model call
		// carried r:c1 WHOLE. The exemption must die with that call, even though the view
		// still renders the fold at this instant (the disarm→arm leak, adversarial review).
		s.markSent({ rawWire: true });

		conductor.cmds = [{ kind: "fold", ids: ["r:c1"] }];
		s.refold();
		expect(s.isFolded(s.get("r:c1")!)).toBe(false); // protection clamps like any seen block
		expect(s.lastReports.some((r) => r.ids.includes("r:c1") && r.reason === "protected")).toBe(true);
	});
});
