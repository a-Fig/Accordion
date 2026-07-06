/*
 * store.recall.test.ts — behavioural tests for the conductor `recall` command (ADR 0018).
 *
 * A recall keeps a block FOLDED (its digest keeps costing only the digest) but injects the block's
 * ORIGINAL full text at a stable tail anchor on the wire — the conductor analog of the agent's
 * `recall` tool, and cache-safe where an unfold would force a prompt-cache miss. The recall is the
 * ONE command exempt from the full-state reset model: it persists until explicitly released
 * (`restore`), the block is unfolded, or the block leaves the store.
 *
 * Driven through the REAL `AccordionStore` (`applyCommands`/`refold`), not a MockHost — a
 * conductor-only unit test would miss the host's own clamps entirely (store.host.test.ts design
 * note, PR #49 regression). Mirrors store.birthfold.test.ts's harness.
 */
import { describe, it, expect } from "vitest";
import { AccordionStore, recallInjection } from "./store.svelte";
import { substTokens } from "./digest";
import { computeRecallOps } from "../live/plan";
import type { Conductor, ConductorView, Command } from "$conductors/contract";
import type { Block, ParsedSession } from "./types";

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

/** Bulk-loaded (transcript) construction — every block reads fresh=false (already sent). */
function makeStore(blocks: Block[]): AccordionStore {
	const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks, lineCount: 0, skipped: 0 };
	return new AccordionStore(parsed);
}

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

/** A session with an old, large tool_result plus later blocks so a durable tail anchor exists. */
function session(): Block[] {
	return [
		blk("u:1", "user", 1, 0, 500),
		blk("a:r1:p0", "text", 1, 1, 300),
		blk("a:r1:p1", "tool_call", 1, 2, 100, { callId: "c1" }),
		blk("r:c1", "tool_result", 1, 3, 6000, { callId: "c1" }),
		blk("u:2", "user", 2, 4, 400),
		blk("a:r2:p0", "text", 2, 5, 300),
	];
}

// ── (a) fold then recall — stays folded, tracked, counted, isRecalled true ────

describe("recall — fold then recall a tool_result", () => {
	it("keeps it folded, records the recall, adds recalledTokens, reports isRecalled", () => {
		const s = makeStore(session());
		s.setProtect(0); // nothing protected → r:c1 is foldable
		const c = new StubConductor();
		c.cmds = [{ kind: "fold", ids: ["r:c1"] }, { kind: "recall", ids: ["r:c1"] }];
		s.attach(c);

		const b = s.get("r:c1")!;
		expect(s.isFolded(b)).toBe(true); // recall did NOT unfold it
		expect(s.isRecalled("r:c1")).toBe(true);
		expect(s.lastReports.some((r) => r.ids.includes("r:c1"))).toBe(false); // no clamp

		// liveTokens includes the full-text injection on top of the folded digest.
		const inj = substTokens(recallInjection(b));
		expect(s.recalledTokens).toBe(inj);
		// The injection is charged on top of the folded view (folded digest << full block).
		expect(s.recalledTokens).toBeGreaterThan(0);

		// The wire op is emitted with the frozen anchor and the labeled text.
		const ops = computeRecallOps(s);
		expect(ops.length).toBe(1);
		expect(ops[0].id).toBe("r:c1");
		expect(ops[0].afterId).toBe("a:r2:p0"); // newest non-grouped durable block
		expect(ops[0].text).toBe(recallInjection(b));
	});
});

// ── (b) sticky: next pass omits the recall → STILL recalled ───────────────────

describe("recall — sticky across passes", () => {
	it("stays recalled when a later batch folds but omits the recall command", () => {
		const s = makeStore(session());
		s.setProtect(0);
		const c = new StubConductor();
		c.cmds = [{ kind: "fold", ids: ["r:c1"] }, { kind: "recall", ids: ["r:c1"] }];
		s.attach(c);
		expect(s.isRecalled("r:c1")).toBe(true);
		const anchorBefore = computeRecallOps(s)[0].afterId;

		// Next pass: keep folding r:c1 but DROP the recall command from the batch.
		c.cmds = [{ kind: "fold", ids: ["r:c1"] }];
		s.refold();
		expect(s.isRecalled("r:c1")).toBe(true); // omission does NOT drop it (cache-safe stickiness)
		expect(computeRecallOps(s)[0].afterId).toBe(anchorBefore); // anchor unchanged
	});
});

// ── (c) restore releases the recall ──────────────────────────────────────────

describe("recall — restore is the explicit opt-out", () => {
	it("restore(id) releases the recall", () => {
		const s = makeStore(session());
		s.setProtect(0);
		const c = new StubConductor();
		c.cmds = [{ kind: "fold", ids: ["r:c1"] }, { kind: "recall", ids: ["r:c1"] }];
		s.attach(c);
		expect(s.isRecalled("r:c1")).toBe(true);

		// Stop folding it and explicitly restore → recall released, block live.
		c.cmds = [{ kind: "restore", ids: ["r:c1"] }];
		s.refold();
		expect(s.isRecalled("r:c1")).toBe(false);
		expect(s.recalledTokens).toBe(0);
		expect(s.isFolded(s.get("r:c1")!)).toBe(false);
	});
});

// ── (d) human unfold auto-drops the recall (no double count) ──────────────────

describe("recall — human unfold auto-drops it", () => {
	it("a hand-unfold releases the recall so its tokens are not double-counted", () => {
		const s = makeStore(session());
		s.setProtect(0);
		const c = new StubConductor();
		c.cmds = [{ kind: "fold", ids: ["r:c1"] }, { kind: "recall", ids: ["r:c1"] }];
		s.attach(c);
		expect(s.isRecalled("r:c1")).toBe(true);

		s.unfold("r:c1", "you"); // human unfolds → block live → recall must drop
		expect(s.isFolded(s.get("r:c1")!)).toBe(false);
		expect(s.isRecalled("r:c1")).toBe(false);
		expect(s.recalledTokens).toBe(0);
		// The conductor keeps asking to fold+recall, but the human override wins and no recall revives.
		s.refold();
		expect(s.isRecalled("r:c1")).toBe(false);
	});
});

// ── (e) clamps: not-recallable, unknown-id, re-recall noop ────────────────────

describe("recall — clamps and idempotence", () => {
	it("recall of a never-folded block clamps not-recallable", () => {
		const s = makeStore(session());
		s.setProtect(0);
		const c = new StubConductor();
		c.cmds = [{ kind: "recall", ids: ["r:c1"] }]; // NOT folded first
		s.attach(c);
		expect(s.isRecalled("r:c1")).toBe(false);
		expect(s.lastReports.some((r) => r.command === "recall" && r.ids.includes("r:c1") && r.reason === "not-recallable")).toBe(true);
	});

	it("recall of an unknown id clamps unknown-id", () => {
		const s = makeStore(session());
		s.setProtect(0);
		const c = new StubConductor();
		c.cmds = [{ kind: "recall", ids: ["nope"] }];
		s.attach(c);
		expect(s.lastReports.some((r) => r.command === "recall" && r.ids.includes("nope") && r.reason === "unknown-id")).toBe(true);
	});

	it("re-recall of an already-recalled block is a silent no-op; the anchor is unchanged", () => {
		const s = makeStore(session());
		s.setProtect(0);
		const c = new StubConductor();
		c.cmds = [{ kind: "fold", ids: ["r:c1"] }, { kind: "recall", ids: ["r:c1"] }];
		s.attach(c);
		const anchor = computeRecallOps(s)[0].afterId;

		// Two recall commands in one batch for the same id → second is a no-op, no clamp report.
		c.cmds = [{ kind: "fold", ids: ["r:c1"] }, { kind: "recall", ids: ["r:c1"] }, { kind: "recall", ids: ["r:c1"] }];
		s.refold();
		expect(s.isRecalled("r:c1")).toBe(true);
		expect(computeRecallOps(s)[0].afterId).toBe(anchor); // anchor frozen, not re-chosen
		expect(s.lastReports.some((r) => r.command === "recall" && r.reason !== "noop")).toBe(false);
	});
});

// ── (f) detach clears recalls ─────────────────────────────────────────────────

describe("recall — detach clears recalls", () => {
	it("detach drops all recalls (one-time cache miss, like freezing folds)", () => {
		const s = makeStore(session());
		s.setProtect(0);
		const c = new StubConductor();
		c.cmds = [{ kind: "fold", ids: ["r:c1"] }, { kind: "recall", ids: ["r:c1"] }];
		s.attach(c);
		expect(s.isRecalled("r:c1")).toBe(true);

		s.detach();
		expect(s.isRecalled("r:c1")).toBe(false);
		expect(s.recalledTokens).toBe(0);
	});
});

// ── (g) #43 interaction: a birth-folded fresh tool_result can be recalled ──────

describe("recall — composes with birth-fold (#43)", () => {
	it("a fresh, protected, birth-folded tool_result can also be recalled", () => {
		// LIVE construction so r:c1 is fresh and born inside the protected tail.
		const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks: [], lineCount: 0, skipped: 0 };
		const s = new AccordionStore(parsed);
		s.appendBlocks(session());
		s.setProtect(20_000); // whole small session sits in the protected tail
		expect(s.isProtected(s.get("r:c1")!)).toBe(true);

		const c = new StubConductor();
		// Birth-fold the fresh protected result, then recall it — both compose.
		c.cmds = [{ kind: "fold", ids: ["r:c1"] }, { kind: "recall", ids: ["r:c1"] }];
		s.attach(c);

		expect(s.isFolded(s.get("r:c1")!)).toBe(true); // birth-folded despite protection
		expect(s.isRecalled("r:c1")).toBe(true); // and recalled to the tail
		expect(s.lastReports.some((r) => r.ids.includes("r:c1"))).toBe(false); // neither clamped
		const ops = computeRecallOps(s);
		expect(ops.length).toBe(1);
		expect(ops[0].id).toBe("r:c1");
	});
});

// ── computeRecallOps emits only for still-folded ids ─────────────────────────

describe("recall — computeRecallOps gating", () => {
	it("emits no op once the recalled block is no longer folded (pruned, so nothing to inject)", () => {
		const s = makeStore(session());
		s.setProtect(0);
		const c = new StubConductor();
		c.cmds = [{ kind: "fold", ids: ["r:c1"] }, { kind: "recall", ids: ["r:c1"] }];
		s.attach(c);
		expect(computeRecallOps(s).length).toBe(1);

		// Conductor stops folding r:c1 entirely; it settles live → recall auto-drops at pass end.
		c.cmds = [];
		s.refold();
		expect(s.isRecalled("r:c1")).toBe(false);
		expect(computeRecallOps(s).length).toBe(0);
	});

	it("every emitted op carries the frozen afterId anchor", () => {
		const s = makeStore(session());
		s.setProtect(0);
		const c = new StubConductor();
		c.cmds = [{ kind: "fold", ids: ["r:c1"] }, { kind: "recall", ids: ["r:c1"] }];
		s.attach(c);
		const ops = computeRecallOps(s);
		expect(ops.every((o) => typeof o.afterId === "string" && o.afterId.length > 0)).toBe(true);
	});
});

// ── recall of a non-foldable kind clamps not-recallable ───────────────────────

describe("recall — kind gate", () => {
	it("a user block is never recallable (never folds on the wire)", () => {
		const s = makeStore(session());
		s.setProtect(0);
		const c = new StubConductor();
		c.cmds = [{ kind: "recall", ids: ["u:1"] }];
		s.attach(c);
		expect(s.isRecalled("u:1")).toBe(false);
		expect(s.lastReports.some((r) => r.command === "recall" && r.ids.includes("u:1") && r.reason === "not-recallable")).toBe(true);
	});
});

// ── recalledTokens skips a not-currently-folded block (no mid-pass double count) ─

describe("recall — recalledTokens gates on isFolded", () => {
	it("a view built mid-lifecycle does not double-count full block + injection", () => {
		// The window: `clearConductorState` momentarily un-folds every conductor-owned block
		// before the conductor re-issues its folds, but the sticky `recalled` map survives the
		// reset (ADR 0018 §2). The view handed to `conduct()` is built in exactly that instant —
		// without the isFolded gate its `liveTokens` baseline would charge the FULL live block
		// PLUS the still-registered recall injection of the same content.
		const s = makeStore(session());
		s.setProtect(0);
		const c = new StubConductor();
		c.cmds = [{ kind: "fold", ids: ["r:c1"] }, { kind: "recall", ids: ["r:c1"] }];
		s.attach(c);
		expect(s.isRecalled("r:c1")).toBe(true);

		// Pass 2: the recall is still registered when the baseline view is built (all blocks
		// momentarily live) — its liveTokens must be the plain raw sum, injection NOT added.
		s.refold();
		expect(c.lastView!.liveTokens).toBe(s.fullTokens);

		// And at rest (block folded again) the injection is charged exactly once, as before.
		expect(s.isFolded(s.get("r:c1")!)).toBe(true);
		expect(s.recalledTokens).toBe(substTokens(recallInjection(s.get("r:c1")!)));
	});
});

// ── the anchor never splits a tool_call/tool_result pair ─────────────────────

describe("recall — anchor skips tool_call blocks", () => {
	it("resolves to an earlier non-tool_call block when the newest durable block is a tool_call", () => {
		// Newest block is an UNRESOLVED tool_call (its result has not streamed in yet) —
		// anchoring there would inject the synthetic user message BETWEEN call and result,
		// provider-invalid for providers that require the result to immediately follow.
		const blocks = [
			...session(),
			blk("a:r2:p1", "tool_call", 2, 6, 100, { callId: "c2" }),
		];
		const s = makeStore(blocks);
		s.setProtect(0);
		const c = new StubConductor();
		c.cmds = [{ kind: "fold", ids: ["r:c1"] }, { kind: "recall", ids: ["r:c1"] }];
		s.attach(c);

		expect(s.isRecalled("r:c1")).toBe(true);
		const ops = computeRecallOps(s);
		expect(ops.length).toBe(1);
		expect(ops[0].afterId).toBe("a:r2:p0"); // the newest NON-tool_call durable block, not a:r2:p1
	});
});
