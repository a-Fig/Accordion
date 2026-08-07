import { describe, it, expect } from "vitest";
import { Truth } from "./truth";
import type { Block, ParsedSession } from "./types";
import { linearize, wireToBlock, type PiMessage } from "./wire";
import { foldCode } from "./digest";

const META = { format: "pi" as const, title: "t", cwd: "", model: "" };

function blk(id: string, kind: Block["kind"] = "text", order = 0, tokens = 1000, extra: Partial<Block> = {}): Block {
	return { id, kind, turn: order + 1, order, text: `${id} ` + "x".repeat(tokens * 4), tokens, override: null, autoFolded: false, by: null, ...extra };
}
function bulk(blocks: Block[]): Truth {
	const parsed: ParsedSession = { meta: META, blocks, lineCount: 0, skipped: 0 };
	return new Truth(parsed);
}
function live(): Truth {
	return new Truth({ meta: META, blocks: [], lineCount: 0, skipped: 0 });
}
/** N durable, foldable text blocks (`a:b<i>:p0`). */
function seq(n: number, tokens = 1000): Block[] {
	return Array.from({ length: n }, (_, i) => blk(`a:b${i}:p0`, "text", i, tokens));
}

describe("Truth — append", () => {
	it("is idempotent by id and preserves fold state on a re-send", () => {
		const t = bulk(seq(3));
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "you");
		expect(t.isFolded(t.get("a:b0:p0")!)).toBe(true);
		t.append([blk("a:b0:p0", "text", 0)]); // re-send same id
		expect(t.blocks.length).toBe(3);
		expect(t.get("a:b0:p0")!.override).toBe("folded"); // not clobbered
	});
	it("emits an appended event with the fresh blocks and post-change rev", () => {
		const t = live();
		const events: any[] = [];
		t.onEvent((e) => events.push(e));
		t.append(seq(2));
		expect(events.length).toBe(1);
		expect(events[0].type).toBe("appended");
		expect(events[0].blocks.length).toBe(2);
		expect(events[0].rev).toBe(t.rev);
	});
});

describe("Truth — human fold semantics", () => {
	it("a human fold sets override:folded, by:you", () => {
		const t = bulk(seq(3));
		t.setProtect(0);
		const r = t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "you");
		expect(r.results[0].applied).toBe(true);
		const b = t.get("a:b0:p0")!;
		expect(b.override).toBe("folded");
		expect(b.by).toBe("you");
	});
	it("refuses a protected block (clamp: protected) and a non-foldable kind (clamp: not-foldable)", () => {
		const t = bulk([blk("u:1", "user", 0), blk("a:b1:p0", "text", 1), blk("a:b2:p0", "text", 2)]);
		t.setProtect(1500); // protect newest ~2 (indices 1,2)
		const protectedRes = t.apply([{ kind: "fold", ids: ["a:b2:p0"] }], "you");
		expect(protectedRes.results[0].clamped).toBe("protected");
		t.setProtect(0);
		const userRes = t.apply([{ kind: "fold", ids: ["u:1"] }], "you");
		expect(userRes.results[0].clamped).toBe("not-foldable");
	});
});

describe("Truth — strategy (auto) fold semantics", () => {
	it("a strategy fold sets autoFolded, leaves override null, by:auto", () => {
		const t = bulk(seq(3));
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto");
		const b = t.get("a:b0:p0")!;
		expect(b.override).toBe(null);
		expect(b.autoFolded).toBe(true);
		expect(b.by).toBe("auto");
		expect(t.isFolded(b)).toBe(true);
	});
	it("a human override beats a strategy op (clamp: human-override)", () => {
		const t = bulk(seq(3));
		t.setProtect(0);
		t.apply([{ kind: "pin", ids: ["a:b0:p0"] }], "you"); // human pin
		const r = t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto"); // strategy tries to fold
		expect(r.results[0].clamped).toBe("human-override");
		expect(t.isFolded(t.get("a:b0:p0")!)).toBe(false); // pin wins
	});
	it("a strategy `auto` op restores its own fold but is refused on a human-held block", () => {
		const t = bulk(seq(3));
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto");
		t.apply([{ kind: "auto", ids: ["a:b0:p0"] }], "auto"); // strategy restore
		expect(t.isFolded(t.get("a:b0:p0")!)).toBe(false);
		t.apply([{ kind: "fold", ids: ["a:b1:p0"] }], "you"); // human fold
		const r = t.apply([{ kind: "auto", ids: ["a:b1:p0"] }], "auto"); // strategy can't clear it
		expect(r.results[0].clamped).toBe("human-override");
		expect(t.isFolded(t.get("a:b1:p0")!)).toBe(true);
	});
});

describe("Truth — replace op (subst)", () => {
	it("recoverable replace prepends the fold tag; non-recoverable is verbatim", () => {
		const t = bulk(seq(2));
		t.setProtect(0);
		t.apply([{ kind: "replace", id: "a:b0:p0", content: "short", recoverable: true }], "auto");
		expect(t.digestOf(t.get("a:b0:p0")!)).toMatch(/^\{#[0-9a-z]{6} FOLDED\} short$/);
		t.apply([{ kind: "replace", id: "a:b1:p0", content: "verbatim", recoverable: false }], "auto");
		expect(t.digestOf(t.get("a:b1:p0")!)).toBe("verbatim");
	});
	it("an empty replace folds to the engine digest, not a blank part", () => {
		const t = bulk(seq(2));
		t.setProtect(0);
		t.apply([{ kind: "replace", id: "a:b0:p0", content: "" }], "auto");
		const b = t.get("a:b0:p0")!;
		expect(b.subst).toBeUndefined();
		expect(t.digestOf(b)).toMatch(/^\{#[0-9a-z]{6} FOLDED\}/); // the engine digest
	});
});

describe("Truth — protected working tail", () => {
	it("walk-back with a 25% overflow cap", () => {
		const t = bulk([blk("a:b0:p0", "text", 0, 1000), blk("a:b1:p0", "text", 1, 25_000), blk("a:b2:p0", "text", 2, 5000), blk("a:b3:p0", "text", 3, 6000), blk("a:b4:p0", "text", 4, 7000)]);
		t.setProtect(20_000); // cap = 25k
		expect(t.protectedFromIndex()).toBe(2);
		expect(t.protectedTokens()).toBe(18_000);
	});
	it("a human fold the tail grows over heals back to live", () => {
		const t = bulk(seq(5));
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["a:b1:p0"] }], "you");
		expect(t.isFolded(t.get("a:b1:p0")!)).toBe(true);
		t.setProtect(1_000_000); // cover everything
		expect(t.isFolded(t.get("a:b1:p0")!)).toBe(false); // healed
		expect(t.get("a:b1:p0")!.override).toBe(null);
	});
});

describe("Truth — birth-fold", () => {
	it("canFold(protected block): allowed for a strategy on an UNSENT block, refused for a human", () => {
		const t = live();
		t.append(seq(5)); // live → all unsent (sentThroughOrder = -1)
		t.setProtect(2000); // protect the newest ~2 blocks
		const newest = t.blocks[t.blocks.length - 1];
		expect(t.isProtected(newest)).toBe(true);
		expect(t.sent(newest)).toBe(false);
		expect(t.canFold(newest, "auto")).toBe(true); // birth-fold exemption
		expect(t.canFold(newest, "you")).toBe(false); // human never exempt in the tail
		const r = t.apply([{ kind: "fold", ids: [newest.id] }], "auto");
		expect(r.results[0].applied).toBe(true);
		expect(t.isFolded(t.get(newest.id)!)).toBe(true);
	});
	it("a birth-folded block STAYS folded when the tail later grows over it", () => {
		const t = live();
		t.append(seq(6));
		t.setProtect(2000);
		const newest = t.blocks[t.blocks.length - 1];
		t.apply([{ kind: "fold", ids: [newest.id] }], "auto"); // birth-fold (protected + unsent)
		expect(t.isFolded(t.get(newest.id)!)).toBe(true);
		t.setProtect(1_000_000); // tail grows to cover everything
		expect(t.isProtected(t.get(newest.id)!)).toBe(true);
		expect(t.isFolded(t.get(newest.id)!)).toBe(true); // survives — never seen whole
	});
	it("a strategy fold of a SENT (non-birth) block heals when the tail grows over it", () => {
		const t = live();
		t.append(seq(10));
		t.markSent(9); // everything sent whole
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto"); // fold an old, sent, unprotected block
		expect(t.isFolded(t.get("a:b0:p0")!)).toBe(true);
		t.setProtect(1_000_000); // tail grows over it
		expect(t.isFolded(t.get("a:b0:p0")!)).toBe(false); // heals — the model saw it whole
	});
	it("bulk-loaded sessions are never fresh (no birth-fold on already-sent history)", () => {
		const t = bulk(seq(5)); // constructor marks all sent
		t.setProtect(2000);
		const newest = t.blocks[t.blocks.length - 1];
		expect(t.sent(newest)).toBe(true);
		expect(t.canFold(newest, "auto")).toBe(false); // protected + sent → no exemption
	});
});

describe("Truth — groups", () => {
	it("group op collapses a run; ungroup restores; the created group id is reported", () => {
		const t = bulk([blk("a:b0:p0", "text", 0), blk("a:b1:p0", "text", 1), blk("a:b2:p0", "text", 2), blk("a:b3:p0", "text", 3), blk("a:b4:p0", "text", 4)]);
		t.setProtect(0);
		const r = t.apply([{ kind: "group", ids: ["a:b1:p0", "a:b2:p0"] }], "you");
		expect(r.results[0].applied).toBe(true);
		const gid = r.results[0].detail!;
		expect(t.groupById(gid)?.folded).toBe(true);
		expect(t.isFolded(t.get("a:b1:p0")!)).toBe(true); // collapsed member reads folded
		t.apply([{ kind: "ungroup", groupId: gid }], "you");
		expect(t.groupById(gid)).toBeUndefined();
	});
	it("a strategy group refuses to sweep a human-held block", () => {
		const t = bulk(seq(5));
		t.setProtect(0);
		t.apply([{ kind: "pin", ids: ["a:b2:p0"] }], "you");
		const r = t.apply([{ kind: "group", ids: ["a:b1:p0", "a:b3:p0"] }], "auto");
		expect(r.results[0].clamped).toBe("human-override");
	});
});

describe("Truth — strategy unpin cannot clear a human pin (S2)", () => {
	it("a strategy/agent unpin on a HUMAN-owned pin clamps human-override; the pin stays", () => {
		const t = bulk(seq(3));
		t.setProtect(0);
		t.apply([{ kind: "pin", ids: ["a:b0:p0"] }], "you");
		const r = t.apply([{ kind: "unpin", ids: ["a:b0:p0"] }], "auto");
		expect(r.results[0].clamped).toBe("human-override");
		expect(t.get("a:b0:p0")!.override).toBe("pinned"); // pin intact
	});
	it("a strategy unpin on a STRATEGY-owned pin applies", () => {
		const t = bulk([blk("a:b0:p0", "text", 0, 1000, { override: "pinned", by: "auto" })]);
		t.setProtect(0);
		const r = t.apply([{ kind: "unpin", ids: ["a:b0:p0"] }], "auto");
		expect(r.results[0].applied).toBe(true);
		expect(t.get("a:b0:p0")!.override).toBe(null);
	});
});

describe("Truth — resetAll batched with other ops (N6)", () => {
	it("emits an ops-applied event for the non-reset op AND a reset event, instead of swallowing the fold", () => {
		const t = bulk(seq(3));
		t.setProtect(0);
		const events: any[] = [];
		t.onEvent((e) => events.push(e));
		const r = t.apply([{ kind: "fold", ids: ["a:b0:p0"] }, { kind: "resetAll" }], "you");
		expect(r.results[0].applied).toBe(true); // the fold applied
		expect(r.results[1].applied).toBe(true); // the reset applied
		expect(events.map((e) => e.type)).toEqual(["ops-applied", "reset"]);
		expect(events[0].results.length).toBe(1);
		expect(events[0].results[0].op.kind).toBe("fold");
	});
});

describe("Truth — locks (ADR 0011)", () => {
	it("human-steering clamps human ops as `locked`; a strategy op still applies", () => {
		const t = bulk(seq(3));
		t.setProtect(0);
		t.setLocks(["human-steering"], "host");
		expect(t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "you").results[0].clamped).toBe("locked");
		expect(t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto").results[0].applied).toBe(true);
	});
	it("agent-unfold clamps the agent's unfold only; recall is never gated (read-only)", () => {
		const t = bulk(seq(3));
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto");
		t.setLocks(["agent-unfold"], "host");
		expect(t.apply([{ kind: "unfold", ids: ["a:b0:p0"] }], "agent").results[0].clamped).toBe("locked");
		// a human unfold still works (separate axis)
		expect(t.apply([{ kind: "unfold", ids: ["a:b0:p0"] }], "you").results[0].applied).toBe(true);
	});
	it("tail-size drives protectedFromIndex; setProtect becomes a no-op", () => {
		const t = bulk(seq(10));
		t.setProtect(20_000);
		expect(t.protectedFromIndex()).toBe(0);
		t.setLocks(["tail-size"], "host", 3000);
		expect(t.protectedFromIndex()).toBe(7); // newest 3×1000 protected
		const before = t.protectTokens;
		t.setProtect(5000);
		expect(t.protectTokens).toBe(before); // human can't resize under the lock
		expect(t.activeTailTokens).toBe(3000);
	});
	it("setLocks releases holds in the newly-locked domain; clearLocks restores steering", () => {
		const t = bulk(seq(4));
		t.setProtect(0);
		t.apply([{ kind: "pin", ids: ["a:b0:p0"] }], "you");
		t.setLocks(["human-steering"], "host");
		expect(t.get("a:b0:p0")!.override).toBe(null); // released
		t.clearLocks();
		expect(t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "you").results[0].applied).toBe(true);
	});
});

describe("Truth — rev, sent, baseRev", () => {
	it("rev bumps monotonically on every state change and every event carries it", () => {
		const t = bulk(seq(3));
		t.setProtect(0);
		const r0 = t.rev;
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "you");
		expect(t.rev).toBe(r0 + 1);
		t.setBudget(50_000);
		expect(t.rev).toBe(r0 + 2);
	});
	it("a no-op transaction does not bump rev or emit", () => {
		const t = bulk(seq(3));
		t.setProtect(0);
		const events: any[] = [];
		t.onEvent((e) => events.push(e));
		const rev = t.rev;
		const r = t.apply([{ kind: "unpin", ids: ["a:b0:p0"] }], "you"); // nothing pinned → noop
		expect(r.results[0].clamped).toBe("noop");
		expect(t.rev).toBe(rev);
		expect(events.length).toBe(0);
	});
	it("baseRev clamps a stale op", () => {
		const t = bulk(seq(3));
		t.setProtect(0);
		const base = t.rev;
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto"); // b0 changes since base
		const r = t.apply([{ kind: "auto", ids: ["a:b0:p0"] }], "auto", base);
		expect(r.results[0].clamped).toBe("stale");
	});
	it("markSent advances the cursor and emits a sent event", () => {
		const t = live();
		t.append(seq(3));
		expect(t.sent(t.get("a:b1:p0")!)).toBe(false);
		t.markSent(1);
		expect(t.sent(t.get("a:b1:p0")!)).toBe(true);
		expect(t.sent(t.get("a:b2:p0")!)).toBe(false);
	});
});

describe("Truth — serializeWire", () => {
	it("folds a block on the wire from the current state", () => {
		const messages: PiMessage[] = [
			{ role: "user", content: "hi", timestamp: 1 },
			{ role: "assistant", timestamp: 2, responseId: "r1", content: [{ type: "text", text: "a long reply here" }] as any },
			{ role: "toolResult", toolCallId: "c1", toolName: "read", content: "big file body", timestamp: 3 },
		];
		const t = bulk(linearize(messages).map(wireToBlock));
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["r:c1"] }], "you");
		const out = t.serializeWire(messages);
		expect((out[2].content as any)[0].text).toBe(t.digestOf(t.get("r:c1")!));
	});
});

describe("Truth — stats", () => {
	it("reports the aggregate readout", () => {
		const t = bulk(seq(4, 1000));
		t.setProtect(0);
		const before = t.stats();
		expect(before.blockCount).toBe(4);
		expect(before.fullTokens).toBe(4000);
		expect(before.liveTokens).toBe(4000);
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "you");
		expect(t.stats().liveTokens).toBeLessThan(before.liveTokens);
	});
});
