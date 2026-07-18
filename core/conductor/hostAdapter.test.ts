/*
 * hostAdapter.test.ts — the shared TruthEvent → HostEvent derivation (`./hostAdapter`), extracted
 * from `TestHost` in Phase C so the in-extension live host and the remote SDK host can reuse it
 * verbatim. `testhost.test.ts`-equivalent coverage lives in the conductor suites that exercise
 * `TestHost` end to end (`core/conductors/**`, `conductors/thermocline/**`, `./view.test.ts`); this
 * file targets the extracted functions directly, in isolation from any host lifecycle.
 */
import { describe, it, expect } from "vitest";
import { Truth } from "../truth";
import type { Block, ParsedSession } from "../types";
import { viewBlockOf, stateChangeFromOp, hostEventsFromTruthEvent, recallHostEvent, wireDepartingEvent } from "./hostAdapter";
import type { HostEvent } from "./contract";

const META = { format: "pi" as const, title: "t", cwd: "", model: "" };

function blk(id: string, order: number, tokens = 1000, extra: Partial<Block> = {}): Block {
	return { id, kind: "text", turn: order + 1, order, text: `${id} ` + "x".repeat(tokens * 4), tokens, override: null, autoFolded: false, by: null, ...extra };
}
function seq(n: number, tokens = 1000): Block[] {
	return Array.from({ length: n }, (_, i) => blk(`a:b${i}:p0`, i, tokens));
}
function bulk(blocks: Block[]): Truth {
	const parsed: ParsedSession = { meta: META, blocks, lineCount: 0, skipped: 0 };
	return new Truth(parsed);
}
function live(): Truth {
	return new Truth({ meta: META, blocks: [], lineCount: 0, skipped: 0 });
}

// ── viewBlockOf ───────────────────────────────────────────────────────────────

describe("viewBlockOf — per-block projection fidelity", () => {
	it("carries kind/turn/order/tokens/toolName/callId/isError straight from the block", () => {
		const t = bulk([blk("r:c1", 0, 500, { kind: "tool_result", toolName: "read", callId: "c1", isError: true })]);
		const b = t.get("r:c1")!;
		const v = viewBlockOf(t, b);
		expect(v.id).toBe("r:c1");
		expect(v.kind).toBe("tool_result");
		expect(v.turn).toBe(1);
		expect(v.order).toBe(0);
		expect(v.tokens).toBe(500);
		expect(v.toolName).toBe("read");
		expect(v.callId).toBe("c1");
		expect(v.isError).toBe(true);
		expect(v.text).toBe(b.text);
	});

	it("held/folded reflect a human override; foldedTokens mirrors Truth.foldedTokensOf (the digest/subst size, hypothetical even when live)", () => {
		const t = bulk(seq(2, 1000));
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "you");
		const b0 = t.get("a:b0:p0")!;
		const v = viewBlockOf(t, b0);
		expect(v.held).toBe(true);
		expect(v.folded).toBe(true);
		expect(v.foldedTokens).toBe(t.foldedTokensOf(b0));
		expect(v.foldedTokens).toBeLessThan(v.tokens);
		const b1 = t.get("a:b1:p0")!;
		const liveView = viewBlockOf(t, b1);
		expect(liveView.held).toBe(false);
		expect(liveView.folded).toBe(false);
		expect(liveView.foldedTokens).toBe(t.foldedTokensOf(b1)); // digest size, even though b1 is live
	});

	it("grouped is true for a member of a FOLDED group and false once the group is unfolded", () => {
		const t = bulk(seq(3, 1000));
		t.setProtect(0);
		const r = t.apply([{ kind: "group", ids: ["a:b0:p0", "a:b1:p0"] }], "you");
		const gid = r.results[0].detail!;
		expect(viewBlockOf(t, t.get("a:b0:p0")!).grouped).toBe(true);
		t.apply([{ kind: "unfoldGroup", groupId: gid }], "you");
		expect(viewBlockOf(t, t.get("a:b0:p0")!).grouped).toBe(false);
	});

	it("protected reflects the protected working tail; sent reflects the sent cursor", () => {
		const t = live();
		t.append(seq(3, 1000));
		t.setProtect(1_000_000); // protect everything
		expect(viewBlockOf(t, t.get("a:b2:p0")!).protected).toBe(true);
		expect(viewBlockOf(t, t.get("a:b2:p0")!).sent).toBe(false);
		t.markSent(2);
		expect(viewBlockOf(t, t.get("a:b2:p0")!).sent).toBe(true);
	});
});

// ── stateChangeFromOp ─────────────────────────────────────────────────────────

describe("stateChangeFromOp — Op → StateChange mapping", () => {
	it("maps every steering op kind to its StateChange `what`", () => {
		expect(stateChangeFromOp({ kind: "fold", ids: ["x"] }, "you")).toEqual({ id: "x", what: "fold", by: "you" });
		expect(stateChangeFromOp({ kind: "replace", id: "x", content: "c" }, "auto")).toEqual({ id: "x", what: "replace", by: "auto" });
		expect(stateChangeFromOp({ kind: "unfold", ids: ["x"] }, "agent")).toEqual({ id: "x", what: "unfold", by: "agent" });
		expect(stateChangeFromOp({ kind: "auto", ids: ["x"] }, "auto")).toEqual({ id: "x", what: "unfold", by: "auto" });
		expect(stateChangeFromOp({ kind: "pin", ids: ["x"] }, "you")).toEqual({ id: "x", what: "pin", by: "you" });
		expect(stateChangeFromOp({ kind: "unpin", ids: ["x"] }, "you")).toEqual({ id: "x", what: "unpin", by: "you" });
		expect(stateChangeFromOp({ kind: "group", ids: ["x", "y"] }, "you")).toEqual({ groupId: "x|y", what: "group", by: "you" });
		expect(stateChangeFromOp({ kind: "ungroup", groupId: "g1" }, "you")).toEqual({ groupId: "g1", what: "ungroup", by: "you" });
		expect(stateChangeFromOp({ kind: "foldGroup", groupId: "g1" }, "you")).toEqual({ groupId: "g1", what: "group", by: "you" });
		expect(stateChangeFromOp({ kind: "unfoldGroup", groupId: "g1" }, "you")).toEqual({ groupId: "g1", what: "ungroup", by: "you" });
		expect(stateChangeFromOp({ kind: "resetAll" }, "you")).toEqual({ what: "unfold", by: "you" });
	});

	it("`freeze` maps to null — host bookkeeping, never a steering signal", () => {
		expect(stateChangeFromOp({ kind: "freeze" }, "you")).toBeNull();
	});
});

// ── hostEventsFromTruthEvent ──────────────────────────────────────────────────

describe("hostEventsFromTruthEvent — TruthEvent → HostEvent[] mapping", () => {
	it("appended → one blocks-appended event carrying liveTokens/budget", () => {
		const t = live();
		let captured: HostEvent[] = [];
		t.onEvent((e) => (captured = hostEventsFromTruthEvent(t, e)));
		t.append(seq(2, 1000));
		expect(captured.length).toBe(1);
		expect(captured[0]).toMatchObject({ type: "blocks-appended", liveTokens: t.stats().liveTokens, budget: t.budget });
		expect((captured[0] as Extract<HostEvent, { type: "blocks-appended" }>).blocks.map((b) => b.id)).toEqual(["a:b0:p0", "a:b1:p0"]);
	});

	it("ops-applied (a real fold) → one state-changed event with the fold StateChange", () => {
		const t = bulk(seq(2, 1000));
		t.setProtect(0);
		let captured: HostEvent[] = [];
		t.onEvent((e) => (captured = hostEventsFromTruthEvent(t, e)));
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "you");
		expect(captured).toEqual([{ type: "state-changed", changes: [{ id: "a:b0:p0", what: "fold", by: "you" }], rev: t.rev }]);
	});

	it("ops-applied where the ONLY applied op is `freeze` → maps to NO HostEvent (empty array)", () => {
		const t = bulk(seq(2, 1000));
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto"); // strategy-owned fold to freeze
		let captured: HostEvent[] = [];
		t.onEvent((e) => (captured = hostEventsFromTruthEvent(t, e)));
		const r = t.apply([{ kind: "freeze" }], "you");
		expect(r.results[0].applied).toBe(true); // the freeze DID change Truth state
		expect(captured).toEqual([]); // but it carries no conductor-facing signal
	});

	it("config (budget) → state-changed what:budget; config (protectTokens) → what:protect", () => {
		const t = bulk(seq(2, 1000));
		let captured: HostEvent[] = [];
		t.onEvent((e) => (captured = hostEventsFromTruthEvent(t, e)));
		t.setBudget(50_000);
		expect(captured).toEqual([{ type: "state-changed", changes: [{ what: "budget", by: "you" }], rev: t.rev }]);
		t.setProtect(0);
		expect(captured).toEqual([{ type: "state-changed", changes: [{ what: "protect", by: "you" }], rev: t.rev }]);
	});

	it("reset → resync", () => {
		const t = bulk(seq(2, 1000));
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "you");
		let captured: HostEvent[] = [];
		t.onEvent((e) => (captured = hostEventsFromTruthEvent(t, e)));
		t.apply([{ kind: "resetAll" }], "you");
		expect(captured).toEqual([{ type: "resync", rev: t.rev }]);
	});

	it("locks and sent map to NO HostEvent in Phase A/B/C", () => {
		const t = bulk(seq(2, 1000));
		let captured: HostEvent[] | null = null;
		t.onEvent((e) => (captured = hostEventsFromTruthEvent(t, e)));
		t.setLocks(["human-steering"], "host");
		expect(captured).toEqual([]);
		const live2 = live();
		live2.append(seq(2, 1000));
		let captured2: HostEvent[] | null = null;
		live2.onEvent((e) => (captured2 = hostEventsFromTruthEvent(live2, e)));
		live2.markSent(0);
		expect(captured2).toEqual([]);
	});
});

// ── recallHostEvent ───────────────────────────────────────────────────────────

describe("recallHostEvent", () => {
	it("synthesizes one state-changed event with a `recall` StateChange per id", () => {
		const e = recallHostEvent(["a:b0:p0", "a:b1:p0"], "agent", 7);
		expect(e).toEqual({
			type: "state-changed",
			changes: [
				{ id: "a:b0:p0", what: "recall", by: "agent" },
				{ id: "a:b1:p0", what: "recall", by: "agent" },
			],
			rev: 7,
		});
	});
});

// ── wireDepartingEvent ────────────────────────────────────────────────────────

describe("wireDepartingEvent", () => {
	it("lastOrder is null and freshIds is empty when Truth has no blocks yet", () => {
		const t = live();
		const { event, lastOrder } = wireDepartingEvent(t);
		expect(lastOrder).toBeNull();
		expect(event.freshIds).toEqual([]);
		expect(event.rev).toBe(t.rev);
	});

	it("freshIds lists every never-sent block; lastOrder is the newest block's order", () => {
		const t = live();
		t.append(seq(3, 1000));
		t.markSent(0); // b0 sent, b1/b2 still fresh
		const { event, lastOrder } = wireDepartingEvent(t);
		expect(event.freshIds).toEqual(["a:b1:p0", "a:b2:p0"]);
		expect(lastOrder).toBe(2);
		expect(event.liveTokens).toBe(t.stats().liveTokens);
		expect(event.budget).toBe(t.budget);
	});
});
