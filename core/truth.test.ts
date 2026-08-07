import { describe, it, expect } from "vitest";
import { Truth } from "./truth";
import type { Block, ParsedSession } from "./types";
import { linearize, wireToBlock, type PiMessage } from "./wire";
import { foldCode } from "./digest";
import { wireEventFromTruthEvent, applyWireEvent, serializeSnapshot, hydrateSnapshot } from "./replica";
import type { WireEvent } from "./protocol";

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

describe("Truth — freeze (conductor-detach kill switch, Phase C)", () => {
	it("converts a strategy fold with a custom subst into a human-owned fold, subst preserved byte-identical", () => {
		const t = bulk(seq(3));
		t.setProtect(0);
		t.apply([{ kind: "replace", id: "a:b0:p0", content: "custom recap", recoverable: false }], "auto");
		const substBefore = t.get("a:b0:p0")!.subst;
		expect(substBefore).toBe("custom recap");
		const r = t.apply([{ kind: "freeze" }], "you");
		expect(r.results[0].applied).toBe(true);
		const b = t.get("a:b0:p0")!;
		expect(b.override).toBe("folded");
		expect(b.by).toBe("you");
		expect(b.subst).toBe(substBefore); // byte-identical — never cleared like a normal human fold
		expect(t.isFolded(b)).toBe(true);
	});

	it("reassigns an auto-owned FOLDED group to \"you\"; an open (unfolded) auto group is left alone", () => {
		const t = bulk(seq(6));
		t.setProtect(0);
		const gr = t.apply([{ kind: "group", ids: ["a:b1:p0", "a:b2:p0"] }], "auto");
		const gid = gr.results[0].detail!;
		const gr2 = t.apply([{ kind: "group", ids: ["a:b4:p0", "a:b5:p0"] }], "auto");
		const gid2 = gr2.results[0].detail!;
		t.apply([{ kind: "unfoldGroup", groupId: gid2 }], "auto"); // opened — not currently folded
		expect(t.groupById(gid)!.by).toBe("auto");
		expect(t.groupById(gid2)!.by).toBe("auto");

		t.apply([{ kind: "freeze" }], "you");
		expect(t.groupById(gid)!.by).toBe("you"); // folded auto group → reassigned
		expect(t.groupById(gid2)!.by).toBe("auto"); // unfolded — freeze doesn't touch it
	});

	it("leaves existing human folds and pins untouched", () => {
		const t = bulk(seq(3));
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "you");
		t.apply([{ kind: "pin", ids: ["a:b1:p0"] }], "you");
		const r = t.apply([{ kind: "freeze" }], "you");
		expect(r.results[0].applied).toBe(false); // nothing strategy-owned to convert
		expect(t.get("a:b0:p0")!.override).toBe("folded");
		expect(t.get("a:b0:p0")!.by).toBe("you");
		expect(t.get("a:b1:p0")!.override).toBe("pinned");
		expect(t.get("a:b1:p0")!.by).toBe("you");
	});

	it("is idempotent — a second freeze is a no-op and does not bump rev", () => {
		const t = bulk(seq(3));
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto");
		t.apply([{ kind: "freeze" }], "you");
		const rev = t.rev;
		const r = t.apply([{ kind: "freeze" }], "you");
		expect(r.results[0].applied).toBe(false);
		expect(r.results[0].clamped).toBe("noop");
		expect(t.rev).toBe(rev);
	});

	it("succeeds while the human-steering lock is HELD — must NOT clamp (it runs immediately before clearLocks)", () => {
		const t = bulk(seq(3));
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto");
		t.setLocks(["human-steering"], "conductor-x");
		const r = t.apply([{ kind: "freeze" }], "you");
		expect(r.results[0].applied).toBe(true);
		expect(r.results[0].clamped).toBeUndefined();
		expect(t.get("a:b0:p0")!.override).toBe("folded");
		expect(t.get("a:b0:p0")!.by).toBe("you");
	});

	it("replays identically on a second Truth via the ops-applied event stream (replica replay)", () => {
		const host = live();
		const events: WireEvent[] = [];
		host.onEvent((e) => {
			const w = wireEventFromTruthEvent(e);
			if (w) events.push(w);
		});
		host.append(seq(4));
		host.setProtect(0);
		host.apply([{ kind: "replace", id: "a:b0:p0", content: "recap", recoverable: false }], "auto");
		host.apply([{ kind: "group", ids: ["a:b1:p0", "a:b2:p0"] }], "auto");
		const r = host.apply([{ kind: "freeze" }], "you");
		expect(r.results[0].applied).toBe(true);

		const replica = live();
		for (const w of events) applyWireEvent(replica, w);

		expect(replica.rev).toBe(host.rev);
		expect(replica.get("a:b0:p0")!.override).toBe(host.get("a:b0:p0")!.override);
		expect(replica.get("a:b0:p0")!.by).toBe(host.get("a:b0:p0")!.by);
		expect(replica.get("a:b0:p0")!.subst).toBe(host.get("a:b0:p0")!.subst);
		expect(replica.get("a:b1:p0")!.override).toBe(host.get("a:b1:p0")!.override);
		expect(replica.groups.length).toBe(host.groups.length);
		expect(replica.groups[0]?.by).toBe(host.groups[0]?.by);
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

// A structural-divergence rebuild (tree-nav / compaction / another extension rewriting messages)
// used to construct a bare `new Truth(...)`, silently dropping every human/host fold, pin, group,
// and dial — even for block ids that survived the rebuild untouched. `Truth.rebuildFrom` is the
// fix: it carries per-block overlay + `birthFolded` membership for surviving ids, scalar dials,
// and any group whose members ALL survive, onto a freshly-built Truth.
describe("Truth — rebuildFrom (rebuild-preserving overlay)", () => {
	it("a fold + pin + group + custom protectTokens/budget + birth-folded block all survive a rebuild when every id survives", () => {
		const host = live();
		host.append(seq(6, 1000));
		host.setProtect(2000); // protects the newest ~2 (indices 4, 5)
		host.apply([{ kind: "pin", ids: ["a:b0:p0"] }], "you");
		host.apply([{ kind: "fold", ids: ["a:b1:p0"] }], "you");
		const groupRes = host.apply([{ kind: "group", ids: ["a:b2:p0", "a:b3:p0"] }], "you");
		expect(groupRes.results[0].applied).toBe(true);
		host.apply([{ kind: "fold", ids: ["a:b5:p0"] }], "auto"); // birth-fold: protected + unsent
		host.setBudget(55_000);

		// Sanity on the host itself before rebuilding.
		expect(host.get("a:b5:p0")!.autoFolded).toBe(true);
		expect(host.birthFoldedIds).toContain("a:b5:p0");
		expect(host.isFolded(host.get("a:b5:p0")!)).toBe(true);

		// Simulate pi re-linearizing the SAME messages into a fresh block list (no overlay) — every
		// id survives, in the same order.
		const fresh = seq(6, 1000);
		const next = Truth.rebuildFrom(host, { meta: META, blocks: fresh, lineCount: 0, skipped: 0 });

		expect(next.get("a:b0:p0")!.override).toBe("pinned");
		expect(next.get("a:b0:p0")!.by).toBe("you");
		expect(next.get("a:b1:p0")!.override).toBe("folded");
		expect(next.get("a:b1:p0")!.by).toBe("you");

		expect(next.groups.length).toBe(1);
		expect(next.groups[0].memberIds).toEqual(["a:b2:p0", "a:b3:p0"]);
		expect(next.groups[0].folded).toBe(true);

		expect(next.protectTokens).toBe(2000);
		expect(next.budget).toBe(55_000);

		// The birth-fold survives — carried into `next`'s OWN birthFolded set — even though
		// `rebuildFrom` runs a housekeep pass at the end (which would otherwise heal any OTHER
		// autoFolded block still sitting in the protected tail).
		expect(next.birthFoldedIds).toContain("a:b5:p0");
		expect(next.isFolded(next.get("a:b5:p0")!)).toBe(true);
	});

	it("drops a group when any member id disappears, but keeps the overlay of ids that DO survive", () => {
		const host = live();
		host.append(seq(5, 1000));
		host.setProtect(0);
		host.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "you");
		const groupRes = host.apply([{ kind: "group", ids: ["a:b2:p0", "a:b3:p0"] }], "you");
		expect(groupRes.results[0].applied).toBe(true);
		expect(host.groups.length).toBe(1);

		// "a:b3:p0" (a group member) does NOT survive the rebuild; everything else does.
		const fresh = [blk("a:b0:p0", "text", 0, 1000), blk("a:b1:p0", "text", 1, 1000), blk("a:b2:p0", "text", 2, 1000), blk("a:b4:p0", "text", 3, 1000)];
		const next = Truth.rebuildFrom(host, { meta: META, blocks: fresh, lineCount: 0, skipped: 0 });

		expect(next.blocks.length).toBe(4);
		expect(next.get("a:b3:p0")).toBeUndefined(); // gone — nothing to carry
		expect(next.groups.length).toBe(0); // dropped — not every member survived
		expect(next.get("a:b0:p0")!.override).toBe("folded"); // surviving overlay still carried
		expect(next.get("a:b0:p0")!.by).toBe("you");
	});

	it("carries over lock state (locks + holder + enforced tail tokens)", () => {
		const host = live();
		host.append(seq(3, 1000));
		host.setProtect(0);
		host.setLocks(["tail-size"], "conductor-x", 5000);

		const fresh = seq(3, 1000);
		const next = Truth.rebuildFrom(host, { meta: META, blocks: fresh, lineCount: 0, skipped: 0 });

		expect(next.locks).toEqual(["tail-size"]);
		expect(next.lockHolder).toBe("conductor-x");
		expect(next.activeTailTokens).toBe(5000);
	});

	it("prev === null (the very first build) skips carryover entirely — a fresh Truth, not polluted by ANY prior state", () => {
		const fresh = seq(3, 1000);
		const next = Truth.rebuildFrom(null, { meta: META, blocks: fresh, lineCount: 0, skipped: 0 });
		expect(next.budget).toBe(70_000); // the class default, not some leaked value
		expect(next.protectTokens).toBe(20_000);
		expect(next.groups.length).toBe(0);
		expect(next.get("a:b0:p0")!.override).toBe(null);
	});
});

// ── F2 (S5): a divergence rebuild used to construct `new Truth(...)`, whose constructor marks
// every block sent (bulk-born) — so a rebuild silently killed birth-fold for genuinely-unsent
// blocks. `rebuildFrom` now carries the sent frontier.
describe("Truth — rebuildFrom carries the sent frontier (S5)", () => {
	it("a mid-turn UNSENT block stays unsent (birth-foldable) across a rebuild; sent blocks stay sent", () => {
		const host = live();
		host.append(seq(3, 1000)); // live → orders 0,1,2 all unsent
		host.markSent(1); // orders 0,1 sent; order 2 still unsent (mid-turn)
		expect(host.sent(host.get("a:b2:p0")!)).toBe(false);

		const fresh = seq(3, 1000); // same ids re-linearized, no overlay
		const next = Truth.rebuildFrom(host, { meta: META, blocks: fresh, lineCount: 0, skipped: 0 });

		expect(next.sent(next.get("a:b0:p0")!)).toBe(true);
		expect(next.sent(next.get("a:b1:p0")!)).toBe(true);
		expect(next.sent(next.get("a:b2:p0")!)).toBe(false); // NOT marked sent by the rebuild

		next.setProtect(1_000_000); // protect everything
		expect(next.isProtected(next.get("a:b2:p0")!)).toBe(true);
		expect(next.canFold(next.get("a:b2:p0")!, "auto")).toBe(true); // birth-fold survives
		expect(next.canFold(next.get("a:b0:p0")!, "auto")).toBe(false); // sent → no exemption
	});

	it("a genuinely NEW block the rebuild introduces is unsent", () => {
		const host = live();
		host.append(seq(2, 1000));
		host.markSent(1); // both sent
		const fresh = seq(3, 1000); // a:b2:p0 is new
		const next = Truth.rebuildFrom(host, { meta: META, blocks: fresh, lineCount: 0, skipped: 0 });
		expect(next.sent(next.get("a:b0:p0")!)).toBe(true);
		expect(next.sent(next.get("a:b1:p0")!)).toBe(true);
		expect(next.sent(next.get("a:b2:p0")!)).toBe(false); // new → unsent
	});

	// F1 × F2: a rebuild in the continuation window (another extension rewrites `event.messages`
	// while a fresh giant tool_result is still in flight) must not strip doorman's birth-fold moment.
	it("F1×F2: a rebuild in the continuation window preserves the birth-fold opportunity", () => {
		const host = live();
		host.append([blk("u:1", "user", 0, 5), blk("a:c1:p0", "tool_call", 1, 5), blk("r:big", "tool_result", 2, 8000)]);
		expect(host.sent(host.get("r:big")!)).toBe(false);

		const fresh = [blk("u:1", "user", 0, 5), blk("a:c1:p0", "tool_call", 1, 5), blk("r:big", "tool_result", 2, 8000)];
		const next = Truth.rebuildFrom(host, { meta: META, blocks: fresh, lineCount: 0, skipped: 0 });

		const big = next.get("r:big")!;
		expect(next.sent(big)).toBe(false); // survived the rebuild unsent
		expect(next.isProtected(big)).toBe(true); // a giant fresh result is in the protected tail
		expect(next.canFold(big, "auto")).toBe(true); // ← doorman's birth-fold is still reachable
		const r = next.apply([{ kind: "fold", ids: ["r:big"] }], "auto");
		expect(r.results[0].applied).toBe(true);
		expect(next.isFolded(next.get("r:big")!)).toBe(true);
	});
});

// ── F5 (S3): `rebuildFrom` used to keep any group whose members all survived, without revalidating
// contiguity. The wire emits one summary per CONTIGUOUS run while accounting charges one — a
// reordered group diverges the two. `rebuildFrom` now drops a non-contiguous carried group.
describe("Truth — rebuildFrom drops a non-contiguous group (S3)", () => {
	it("a reorder-rebuild that scatters a group's members drops the group", () => {
		const host = live();
		host.append(seq(5, 1000));
		host.setProtect(0);
		const gr = host.apply([{ kind: "group", ids: ["a:b1:p0", "a:b2:p0"] }], "you");
		expect(gr.results[0].applied).toBe(true);
		expect(host.groups.length).toBe(1);

		// a:b3 slips between the two members — every member survives, but they are no longer a run.
		const fresh = [
			blk("a:b0:p0", "text", 0, 1000),
			blk("a:b1:p0", "text", 1, 1000),
			blk("a:b3:p0", "text", 2, 1000),
			blk("a:b2:p0", "text", 3, 1000),
			blk("a:b4:p0", "text", 4, 1000),
		];
		const next = Truth.rebuildFrom(host, { meta: META, blocks: fresh, lineCount: 0, skipped: 0 });

		expect(next.get("a:b1:p0")).toBeDefined(); // members survive as blocks
		expect(next.get("a:b2:p0")).toBeDefined();
		expect(next.groups.length).toBe(0); // group dropped — no longer contiguous
		expect(next.computeGroupOps().length).toBe(0); // accounting matches the wire (no group either)
	});

	it("keeps a group whose members stay contiguous after a rebuild", () => {
		const host = live();
		host.append(seq(5, 1000));
		host.setProtect(0);
		const gr = host.apply([{ kind: "group", ids: ["a:b1:p0", "a:b2:p0"] }], "you");
		expect(gr.results[0].applied).toBe(true);
		const next = Truth.rebuildFrom(host, { meta: META, blocks: seq(5, 1000), lineCount: 0, skipped: 0 });
		expect(next.groups.length).toBe(1);
		expect(next.groups[0].memberIds).toEqual(["a:b1:p0", "a:b2:p0"]);
	});
});

// ── F3 (S2): `healProtected` used to run TWO branches — clearing an `override:"folded"` but leaving
// `autoFolded`/`subst` residue (a frozen fold half-healed), and zeroing `by` for any `autoFolded`
// block without checking `override` (corrupting a human pin's provenance). One coherent pass now.
describe("Truth — healProtected coherent heal (S2)", () => {
	it("fully heals a FROZEN fold (override:folded + autoFolded + subst) the tail grows over — no residue", () => {
		const t = live();
		t.append(seq(4, 1000));
		t.setProtect(0);
		t.apply([{ kind: "replace", id: "a:b0:p0", content: "recap", recoverable: false }], "auto"); // autoFolded + subst
		t.apply([{ kind: "freeze" }], "you"); // → override:folded + autoFolded + subst
		const frozen = t.get("a:b0:p0")!;
		expect(frozen.override).toBe("folded");
		expect(frozen.autoFolded).toBe(true);
		expect(frozen.subst).toBe("recap");

		t.setProtect(1_000_000); // tail grows over everything → heal
		const healed = t.get("a:b0:p0")!;
		expect(healed.override).toBe(null);
		expect(healed.autoFolded).toBe(false); // NOT left as residue (the old half-heal bug)
		expect(healed.subst).toBeUndefined();
		expect(healed.by).toBe(null);
		expect(t.isFolded(healed)).toBe(false); // fully live, not half-folded
	});

	it("never zeroes a PIN's provenance when the tail grows over it", () => {
		const t = live();
		t.append(seq(4, 1000));
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto"); // autoFolded:true, by:auto
		t.apply([{ kind: "pin", ids: ["a:b0:p0"] }], "you"); // override:pinned, by:you (autoFolded residue stays)
		expect(t.get("a:b0:p0")!.override).toBe("pinned");
		expect(t.get("a:b0:p0")!.by).toBe("you");

		t.setProtect(1_000_000); // tail grows over it
		const after = t.get("a:b0:p0")!;
		expect(after.override).toBe("pinned"); // pin intact
		expect(after.by).toBe("you"); // provenance NOT zeroed (the old else-if bug)
		expect(t.isFolded(after)).toBe(false);
	});

	it("still heals an ordinary human fold and an ordinary (sent) strategy fold the tail grows over", () => {
		const t = live();
		t.append(seq(6, 1000));
		t.markSent(5); // all sent — the strategy fold is NOT a birth-fold
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "you");
		t.apply([{ kind: "fold", ids: ["a:b1:p0"] }], "auto");
		expect(t.isFolded(t.get("a:b0:p0")!)).toBe(true);
		expect(t.isFolded(t.get("a:b1:p0")!)).toBe(true);
		t.setProtect(1_000_000);
		expect(t.isFolded(t.get("a:b0:p0")!)).toBe(false);
		expect(t.get("a:b0:p0")!.override).toBe(null);
		expect(t.isFolded(t.get("a:b1:p0")!)).toBe(false);
	});
});

// ── F4 (S1): `opFold`/`opReplace`/`canFold` accepted a positional (non-durable) id that
// `computeFoldOps` silently drops — UI/accounting said folded, the model got full content. Now
// refused with a `non-durable` clamp, but only with a live wire attached (nothing to diverge from
// otherwise), mirroring the wire-conditional group accounting.
describe("Truth — non-durable-id fold gate (S1)", () => {
	it("refuses a fold/replace on a positional id under a live wire; the block stays live everywhere", () => {
		const t = live();
		t.wireAttached = true;
		t.append([blk("m0:p0", "text", 0, 1000), blk("a:b1:p0", "text", 1, 1000)]);
		t.setProtect(0);

		const rf = t.apply([{ kind: "fold", ids: ["m0:p0"] }], "you");
		expect(rf.results[0].clamped).toBe("non-durable");
		expect(t.isFolded(t.get("m0:p0")!)).toBe(false);

		const rr = t.apply([{ kind: "replace", id: "m0:p0", content: "x" }], "auto");
		expect(rr.results[0].clamped).toBe("non-durable");
		expect(t.isFolded(t.get("m0:p0")!)).toBe(false);

		expect(t.canFold(t.get("m0:p0")!, "you")).toBe(false);
		expect(t.canFold(t.get("m0:p0")!, "auto")).toBe(false);
		expect(t.computeFoldOps().length).toBe(0); // wire agrees — nothing folded

		// a DURABLE id still folds under the same live wire (no over-blocking)
		const rd = t.apply([{ kind: "fold", ids: ["a:b1:p0"] }], "you");
		expect(rd.results[0].applied).toBe(true);
		expect(t.isFolded(t.get("a:b1:p0")!)).toBe(true);
	});

	it("a non-wire (demo/CC/file) session still allows folding a positional id — no wire to diverge from", () => {
		const t = bulk([blk("m0:p0", "text", 0, 1000)]); // wireAttached defaults false
		t.setProtect(0);
		const r = t.apply([{ kind: "fold", ids: ["m0:p0"] }], "you");
		expect(r.results[0].applied).toBe(true);
		expect(t.isFolded(t.get("m0:p0")!)).toBe(true);
	});
});

// ── F6 (S4): a strategy `unfold` (by:"auto") used to take the human hold-open branch, writing an
// `unfolded` override that `canFold`/`opAuto` then refuse — the strategy wedged itself out of its
// own block. A strategy unfold now behaves exactly like `auto`.
describe("Truth — strategy unfold behaves like auto (S4)", () => {
	it("auto-unfold then auto-fold succeeds — a strategy can never wedge itself out", () => {
		const t = live();
		t.append(seq(3, 1000));
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto");
		expect(t.isFolded(t.get("a:b0:p0")!)).toBe(true);
		const u = t.apply([{ kind: "unfold", ids: ["a:b0:p0"] }], "auto");
		expect(u.results[0].applied).toBe(true);
		expect(t.get("a:b0:p0")!.override).toBe(null); // NO standing override (unlike a human unfold)
		expect(t.get("a:b0:p0")!.autoFolded).toBe(false);
		expect(t.isFolded(t.get("a:b0:p0")!)).toBe(false);
		const rf = t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto"); // re-fold: not wedged
		expect(rf.results[0].applied).toBe(true);
		expect(t.isFolded(t.get("a:b0:p0")!)).toBe(true);
	});

	it("a human unfold still writes a sticky `unfolded` override (unchanged)", () => {
		const t = live();
		t.append(seq(3, 1000));
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto");
		t.apply([{ kind: "unfold", ids: ["a:b0:p0"] }], "you");
		expect(t.get("a:b0:p0")!.override).toBe("unfolded");
		expect(t.get("a:b0:p0")!.by).toBe("you");
	});

	it("agent unfold stays sticky (ADR 0005) — an auto-fold after it still refuses", () => {
		const t = live();
		t.append(seq(3, 1000));
		t.setProtect(0);
		t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto");
		const au = t.apply([{ kind: "unfold", ids: ["a:b0:p0"] }], "agent");
		expect(au.results[0].applied).toBe(true);
		expect(t.get("a:b0:p0")!.override).toBe("unfolded"); // agent override IS sticky
		const rf = t.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto");
		expect(rf.results[0].clamped).toBe("human-override"); // strategy still refused
		expect(t.isFolded(t.get("a:b0:p0")!)).toBe(false);
	});
});

// ── F7 (P1-5): on detach, `clearLocks` dropped the enforced tail and the next housekeep pruned a
// handoff-style whole-session group and healed freeze-converted folds — the freeze guarantee failed
// exactly when a tail-size conductor detached with a large human tail waiting. `clearLocks({
// inheritTail:true })` adopts the enforced tail so the protected boundary does not snap back.
describe("Truth — clearLocks inheritTail (freeze-safe detach, P1-5)", () => {
	it("inheritTail adopts the enforced (zero) tail so frozen work survives housekeep", () => {
		const t = live();
		t.append(seq(6, 1000));
		t.setProtect(20_000); // the human dial that would otherwise snap back over everything
		t.setLocks(["human-steering", "tail-size"], "handoff", 0); // zero-tail conductor
		expect(t.protectedFromIndex()).toBe(6); // zero tail → nothing protected

		t.apply([{ kind: "replace", id: "a:b0:p0", content: "recap", recoverable: false }], "auto");
		const gr = t.apply([{ kind: "group", ids: ["a:b1:p0", "a:b3:p0"] }], "auto");
		expect(gr.results[0].applied).toBe(true);

		t.apply([{ kind: "freeze" }], "you"); // transfer ownership to the human
		t.clearLocks({ inheritTail: true });

		expect(t.protectTokens).toBe(0); // inherited the enforced tail — did NOT snap back to 20k
		expect(t.locks.length).toBe(0);
		expect(t.groups.length).toBe(1); // the whole-session group survives
		expect(t.get("a:b0:p0")!.override).toBe("folded");
		expect(t.get("a:b0:p0")!.subst).toBe("recap"); // byte-identical
		expect(t.isFolded(t.get("a:b0:p0")!)).toBe(true);
	});

	it("plain clearLocks() keeps the legacy snap-back — frozen work in the re-expanded tail is pruned/healed", () => {
		const t = live();
		t.append(seq(6, 1000));
		t.setProtect(1_000_000); // a big human tail that WILL snap back over everything
		t.setLocks(["human-steering", "tail-size"], "handoff", 0);
		t.apply([{ kind: "replace", id: "a:b0:p0", content: "recap", recoverable: false }], "auto");
		const gr = t.apply([{ kind: "group", ids: ["a:b1:p0", "a:b3:p0"] }], "auto");
		expect(gr.results[0].applied).toBe(true);
		t.apply([{ kind: "freeze" }], "you");
		t.clearLocks(); // legacy — no inherit

		expect(t.protectTokens).toBe(1_000_000); // snapped back to the human dial
		expect(t.groups.length).toBe(0); // pruned (now inside the re-expanded protected tail)
		expect(t.isFolded(t.get("a:b0:p0")!)).toBe(false); // healed
	});

	it("inheritTail emits a config event carrying the inherited protectTokens (replicas can track it)", () => {
		const t = live();
		t.append(seq(3, 1000));
		t.setProtect(20_000);
		t.setLocks(["tail-size"], "handoff", 4000);
		const events: any[] = [];
		t.onEvent((e) => events.push(e));
		t.clearLocks({ inheritTail: true });
		const config = events.find((e) => e.type === "config" && e.protectTokens !== undefined);
		expect(config).toBeDefined();
		expect(config.protectTokens).toBe(4000);
		expect(t.protectTokens).toBe(4000);
	});
});

// ── Fix #1: per-id op outcomes. `eachId` used to collapse a multi-id op into ONE `{applied:true}`
// result, and `wireEventFromTruthEvent` forwarded the WHOLE op (including ids the host individually
// clamped) to a baseRev-less replica, which then applied an id the host refused. Both sides still
// bump `rev` by exactly one, so the rev assertion never catches the state fork.
describe("Truth — per-id op outcomes (fix #1)", () => {
	it("a multi-id op records each id's outcome; batch applied/clamped stay backward-compatible", () => {
		const t = live();
		t.append(seq(3, 1000));
		t.setProtect(0);
		const base = t.rev;
		t.apply([{ kind: "pin", ids: ["a:b1:p0"] }], "you"); // touch B → stale relative to base; A untouched
		const r = t.apply([{ kind: "fold", ids: ["a:b0:p0", "a:b1:p0"] }], "you", base);
		expect(r.results[0].applied).toBe(true); // batch-level: ANY id applied (unchanged for old callers)
		expect(r.results[0].clamped).toBeUndefined();
		expect(r.results[0].perId).toEqual([
			{ id: "a:b0:p0", applied: true },
			{ id: "a:b1:p0", applied: false, reason: "stale" },
		]);
		expect(t.isFolded(t.get("a:b0:p0")!)).toBe(true); // A folded
		expect(t.get("a:b1:p0")!.override).toBe("pinned"); // B stale-refused, unchanged
	});

	it("a fully-clamped multi-id op reports applied:false with per-id reasons", () => {
		const t = live();
		t.append(seq(3, 1000));
		t.setProtect(0);
		const r = t.apply([{ kind: "unpin", ids: ["a:b0:p0", "a:b1:p0"] }], "you"); // nothing pinned → all noop
		expect(r.results[0].applied).toBe(false);
		expect(r.results[0].clamped).toBe("noop");
		expect(r.results[0].perId).toEqual([
			{ id: "a:b0:p0", applied: false, reason: "noop" },
			{ id: "a:b1:p0", applied: false, reason: "noop" },
		]);
	});

	// The silent-divergence repro through the actual replica replay: the host clamps ONE id `stale`
	// (a baseRev-only refusal a baseRev-less replica cannot reproduce). Pre-fix the whole op was
	// forwarded, so the replica unfolded a PINNED block the host left pinned — diverging while both
	// revs still advanced by one. This assertion FAILS pre-fix (replica B would be "unfolded").
	it("forwards only the applied ids so a per-id stale clamp cannot diverge a baseRev-less replica", () => {
		const host = live();
		const events: WireEvent[] = [];
		host.onEvent((e) => {
			const w = wireEventFromTruthEvent(e);
			if (w) events.push(w);
		});
		host.append(seq(3, 1000));
		host.setProtect(0);
		host.apply([{ kind: "fold", ids: ["a:b0:p0"] }], "auto"); // A strategy-folded (override null, unfoldable)
		const base = host.rev;
		host.apply([{ kind: "pin", ids: ["a:b1:p0"] }], "you"); // B pinned; touched since base → stale vs base
		const r = host.apply([{ kind: "unfold", ids: ["a:b0:p0", "a:b1:p0"] }], "you", base);
		expect(r.results[0].perId).toEqual([
			{ id: "a:b0:p0", applied: true },
			{ id: "a:b1:p0", applied: false, reason: "stale" },
		]);
		expect(host.get("a:b1:p0")!.override).toBe("pinned"); // host kept B pinned

		const replica = live();
		for (const w of events) applyWireEvent(replica, w);

		expect(replica.rev).toBe(host.rev); // rev aligned — it was even PRE-fix, which is the trap
		expect(replica.get("a:b0:p0")!.override).toBe(host.get("a:b0:p0")!.override); // both unfolded
		expect(replica.get("a:b1:p0")!.override).toBe("pinned"); // NOT unfolded — pre-fix diverged here
	});
});

// ── Fix #2: sent-frontier carry across a rebuild. The scalar `sentThroughOrder` is an `order`
// prefix, so a fresh block inserted BEFORE already-sent blocks drags the frontier back and, by the
// prefix alone, reclassifies those sent blocks never-sent (birth-fold-eligible again). `rebuildFrom`
// now carries per-id sent-ness in `carriedSent`; `sent` is the union of the two.
describe("Truth — rebuildFrom carries per-id sent-ness across an insert-before rebuild (fix #2)", () => {
	it("a fresh block inserted BEFORE sent blocks does not reclassify them never-sent", () => {
		const host = live();
		host.append(seq(2, 1000)); // A(order0), B(order1)
		host.markSent(1); // both sent
		expect(host.sent(host.get("a:b0:p0")!)).toBe(true);
		expect(host.sent(host.get("a:b1:p0")!)).toBe(true);

		// Divergence rebuild inserts X BEFORE A and B; A/B keep their durable ids but shift to orders 1,2.
		const fresh = [
			blk("a:new:p0", "text", 0, 1000), // X — brand new, unsent
			blk("a:b0:p0", "text", 1, 1000), // A — was sent
			blk("a:b1:p0", "text", 2, 1000), // B — was sent
		];
		const next = Truth.rebuildFrom(host, { meta: META, blocks: fresh, lineCount: 0, skipped: 0 });

		expect(next.sentThroughOrder).toBe(-1); // the scalar frontier IS dragged back to -1 by X…
		expect(next.sent(next.get("a:b0:p0")!)).toBe(true); // …but A stays sent (carried) — pre-fix: false
		expect(next.sent(next.get("a:b1:p0")!)).toBe(true); // …and B stays sent (carried)  — pre-fix: false
		expect(next.sent(next.get("a:new:p0")!)).toBe(false); // X is genuinely unsent
		expect(next.carriedSentIds).toEqual(expect.arrayContaining(["a:b0:p0", "a:b1:p0"]));

		next.setProtect(1_000_000); // protect everything
		expect(next.canFold(next.get("a:b0:p0")!, "auto")).toBe(false); // sent → NOT birth-foldable
		expect(next.canFold(next.get("a:new:p0")!, "auto")).toBe(true); // genuinely fresh → birth-foldable
	});
});

// ── Fix #3: `rebuildFrom` carried `old.subst` unconditionally. When a rebuild is triggered by a
// same-id CONTENT rewrite (pi replaced the text under a stable id), the carried subst is a summary
// of the OLD text — the wire keeps emitting a stale digest. Drop the subst on a text change; the
// fold survives and re-digests from the fresh text.
describe("Truth — rebuildFrom drops a stale subst on a content rewrite (fix #3)", () => {
	it("a same-id CONTENT rewrite drops the carried custom subst; the fold re-digests from fresh text", () => {
		const host = live();
		host.append(seq(2, 1000));
		host.setProtect(0);
		host.apply([{ kind: "replace", id: "a:b0:p0", content: "OLD summary of old text", recoverable: false }], "auto");
		expect(host.get("a:b0:p0")!.subst).toBe("OLD summary of old text");

		// Rebuild where a:b0:p0 keeps its id but its TEXT changed (pi rewrote the block content).
		const fresh = [blk("a:b0:p0", "text", 0, 1000, { text: "brand new different content" }), blk("a:b1:p0", "text", 1, 1000)];
		const next = Truth.rebuildFrom(host, { meta: META, blocks: fresh, lineCount: 0, skipped: 0 });

		const b = next.get("a:b0:p0")!;
		expect(b.subst).toBeUndefined(); // stale custom subst dropped
		expect(b.autoFolded).toBe(true); // still a strategy fold — it re-digests from fresh text
		expect(next.isFolded(b)).toBe(true);
		expect(next.digestOf(b)).not.toBe("OLD summary of old text");
		expect(next.digestOf(b)).toMatch(/^\{#[0-9a-z]{6} FOLDED\}/); // the engine digest, freshly computed

		// Contrast: an IDENTICAL-text rebuild carries the subst unchanged (the pre-existing behavior).
		const same = Truth.rebuildFrom(host, { meta: META, blocks: seq(2, 1000), lineCount: 0, skipped: 0 });
		expect(same.get("a:b0:p0")!.subst).toBe("OLD summary of old text");
	});
});

// ── Fix #4: `rebuildFrom` kept a contiguous carried group's OLD `memberIds` array order even when
// the rebuild reordered the surviving members. `memberIds` is documented "in conversation order"
// (the wire and `classifyGroup` both iterate it), so it must be re-derived from the new block order.
describe("Truth — rebuildFrom re-derives reordered group member order (fix #4)", () => {
	it("a group kept across a rebuild that reorders its (still-contiguous) members re-derives memberIds", () => {
		const host = live();
		host.append(seq(4, 1000)); // A B C D
		host.setProtect(0);
		const gr = host.apply([{ kind: "group", ids: ["a:b1:p0", "a:b2:p0"] }], "you"); // members [B, C]
		expect(gr.results[0].applied).toBe(true);
		expect(host.groups[0].memberIds).toEqual(["a:b1:p0", "a:b2:p0"]);

		// Rebuild reorders B and C — they stay ADJACENT (so the group is kept): new order [A, C, B, D].
		const fresh = [
			blk("a:b0:p0", "text", 0, 1000),
			blk("a:b2:p0", "text", 1, 1000), // C now before B
			blk("a:b1:p0", "text", 2, 1000), // B
			blk("a:b3:p0", "text", 3, 1000),
		];
		const next = Truth.rebuildFrom(host, { meta: META, blocks: fresh, lineCount: 0, skipped: 0 });

		expect(next.groups.length).toBe(1); // still contiguous → kept
		// Pre-fix kept the STALE ["a:b1:p0","a:b2:p0"]; the fix re-derives to the new block order [C, B].
		expect(next.groups[0].memberIds).toEqual(["a:b2:p0", "a:b1:p0"]);
	});
});

// ── Fix #5: the config dials used to accept non-finite input. NaN survives `Math.max`/`Math.round`
// and JSON serializes NaN/Infinity as `null` on the wire — poisoning the dial and forking replicas.
describe("Truth — config dials refuse non-finite input (fix #5)", () => {
	it("setBudget / setProtect / setContextWindow ignore NaN and Infinity (no poison, no rev bump, no event)", () => {
		const t = bulk(seq(3));
		const budget0 = t.budget;
		const protect0 = t.protectTokens;
		const rev0 = t.rev;
		const events: any[] = [];
		t.onEvent((e) => events.push(e));

		t.setBudget(NaN);
		t.setBudget(Infinity);
		t.setProtect(NaN);
		t.setContextWindow(NaN);
		expect(t.budget).toBe(budget0); // unchanged, not NaN
		expect(t.protectTokens).toBe(protect0);
		expect(t.contextWindow).toBe(null);
		expect(t.rev).toBe(rev0); // no rev bump
		expect(events.length).toBe(0); // no config event to fork replicas

		t.setBudget(50_000); // a real value still applies
		expect(t.budget).toBe(50_000);
	});
});

// Issue #11 stage 1 (ADR 0025): the `calibration` dial — default, raw-snap (no clamp/smoothing),
// non-finite/non-positive refusal (same guard shape as the other config dials), the display-only
// `calTokens` helper, and survival across `rebuildFrom` + a snapshot/replica round trip.
describe("Truth — calibration (issue #11 stage 1)", () => {
	it("defaults to 1, and calTokens is the identity at the default", () => {
		const t = bulk(seq(2, 1000));
		expect(t.calibration).toBe(1);
		expect(t.calTokens(1234)).toBe(1234);
	});

	it("setCalibration raw-snaps (no clamp, no smoothing) and emits a config event", () => {
		const t = bulk(seq(2, 1000));
		const events: any[] = [];
		t.onEvent((e) => events.push(e));
		const rev0 = t.rev;

		t.setCalibration(1.5);
		expect(t.calibration).toBe(1.5);
		expect(t.calTokens(1000)).toBe(1500);
		expect(t.rev).toBe(rev0 + 1);
		expect(events.at(-1)).toMatchObject({ type: "config", calibration: 1.5 });

		// A SECOND observation overwrites the first outright — no averaging/EMA toward it.
		t.setCalibration(0.8);
		expect(t.calibration).toBe(0.8);
		expect(t.rev).toBe(rev0 + 2);
	});

	it("refuses non-finite / non-positive input — no poison, no rev bump, no event (same guard shape as setBudget/setProtect)", () => {
		const t = bulk(seq(2, 1000));
		const rev0 = t.rev;
		const events: any[] = [];
		t.onEvent((e) => events.push(e));

		t.setCalibration(NaN);
		t.setCalibration(Infinity);
		t.setCalibration(0);
		t.setCalibration(-1.2);
		expect(t.calibration).toBe(1); // unchanged, not poisoned
		expect(t.rev).toBe(rev0);
		expect(events.length).toBe(0);
	});

	// Stage 1's version of this test asserted calibration NEVER reached canFold/protectedFromIndex/
	// stats() — the whole point of stage 2 (issue #11, ADR 0025) is to flip exactly that. This
	// rewritten test checks what genuinely stays invariant (the protect(0) shortcut, and the literal
	// dial fields of `stats()`) alongside what now legitimately moves (`stats().liveTokens`/
	// `fullTokens`). See the two dedicated tests below for `protectedFromIndex` itself moving under a
	// non-zero protect target.
	it("with protectTokens=0 the tail-boundary shortcut stays calibration-invariant, but stats() liveTokens/fullTokens are now calibrated (stage 2)", () => {
		const t = bulk(seq(4, 1000));
		t.setProtect(0); // target===0 short-circuits computeProtectedFromIndex before it ever reads calibration
		const pfiBefore = t.protectedFromIndex();
		const canFoldBefore = t.canFold(t.get("a:b0:p0")!);
		const statsBefore = t.stats();

		t.setCalibration(3.7);

		// The protect(0) shortcut is untouched by the dial — same boundary, same fold verdict.
		expect(t.protectedFromIndex()).toBe(pfiBefore);
		expect(t.canFold(t.get("a:b0:p0")!)).toBe(canFoldBefore);

		const statsAfter = t.stats();
		// budget / protectTokens / contextWindow / protectedFromIndex / blockCount are literal dial
		// values / structural facts — untouched by the multiplier (see `TruthStats`'s doc comment).
		expect(statsAfter.budget).toBe(statsBefore.budget);
		expect(statsAfter.protectTokens).toBe(statsBefore.protectTokens);
		expect(statsAfter.contextWindow).toBe(statsBefore.contextWindow);
		expect(statsAfter.protectedFromIndex).toBe(statsBefore.protectedFromIndex);
		expect(statsAfter.blockCount).toBe(statsBefore.blockCount);
		// liveTokens/fullTokens ARE calibrated (stage 2) — the whole point of issue #11.
		expect(statsAfter.liveTokens).toBe(t.calTokens(statsBefore.liveTokens));
		expect(statsAfter.fullTokens).toBe(t.calTokens(statsBefore.fullTokens));
		expect(statsAfter.fullTokens).toBe(Math.round(statsBefore.fullTokens * 3.7));
	});

	it("protectedFromIndex moves under a non-1 calibration (stage 2): the SAME real protectTokens target maps to a SMALLER raw-estimate region as k grows", () => {
		const t = bulk(seq(5, 1000)); // 5 blocks, 1000 raw tokens each
		t.setProtect(2500); // a REAL 2500-token target

		// k=1: raw-equivalent target is still 2500, cap 3125 — walking from the newest block backward,
		// 3 blocks (3000 raw) crosses the target before the cap does — tail = indices [2,3,4].
		expect(t.protectedFromIndex()).toBe(2);

		t.setCalibration(2);
		// raw-equivalent target is now 2500/2 = 1250 (cap 1562.5): 2 blocks (2000 raw) already exceed
		// the CAP before reaching a 3rd, so the walk stops early — tail shrinks to just [4]. This is
		// the intended effect: once real tokens run higher than the raw estimate, FEWER raw-estimated
		// blocks are needed to satisfy the same real-token protection target.
		expect(t.protectedFromIndex()).toBe(4);
	});

	it("protectedFromIndex boundary is IDENTICAL between the host and a JSON-round-tripped replica under a non-1 calibration (stage 2 determinism)", () => {
		const host = live();
		host.append(seq(6, 1000));
		host.setProtect(2500);
		host.setCalibration(1.375);
		const hostPfi = host.protectedFromIndex();

		// Sanity: calibration genuinely moved the boundary versus k=1, so this test isn't vacuous.
		const atDefault = live();
		atDefault.append(seq(6, 1000));
		atDefault.setProtect(2500);
		expect(hostPfi).not.toBe(atDefault.protectedFromIndex());

		// Round-trip through JSON (not just object assignment) — any finite double survives
		// `JSON.stringify`/`JSON.parse` exactly (the shortest-round-tripping-decimal guarantee), which
		// is the same path `calibration` takes over the real WS wire.
		const wireState = JSON.parse(JSON.stringify(serializeSnapshot(host, false)));
		const replica = hydrateSnapshot(META, wireState);
		expect(replica.calibration).toBe(host.calibration);
		expect(replica.protectedFromIndex()).toBe(hostPfi);
	});

	it("survives rebuildFrom (carried like budget/protectTokens), and a fresh build (prev === null) stays at the default", () => {
		const host = live();
		host.append(seq(3, 1000));
		host.setCalibration(1.42);

		const fresh = seq(3, 1000);
		const next = Truth.rebuildFrom(host, { meta: META, blocks: fresh, lineCount: 0, skipped: 0 });
		expect(next.calibration).toBe(1.42);

		const firstBuild = Truth.rebuildFrom(null, { meta: META, blocks: fresh, lineCount: 0, skipped: 0 });
		expect(firstBuild.calibration).toBe(1); // not polluted by ANY prior state
	});

	it("round-trips through serializeSnapshot → hydrateSnapshot (replica replay parity)", () => {
		const host = live();
		host.append(seq(2, 1000));
		host.setCalibration(2.25);

		const state = serializeSnapshot(host, false);
		expect(state.calibration).toBe(2.25);

		const replica = hydrateSnapshot(META, state);
		expect(replica.calibration).toBe(2.25);
		expect(replica.rev).toBe(host.rev);

		// A stale-format peer that omits `calibration` (pre-v18) falls back to the safe cold-start
		// default rather than forking on `undefined` — never a decision-affecting divergence.
		const stale = hydrateSnapshot(META, { ...state, calibration: undefined });
		expect(stale.calibration).toBe(1);
	});

	it("a config event carrying ONLY calibration replays via applyWireEvent without touching the other dials", () => {
		const host = live();
		host.append(seq(2, 1000));
		const budget0 = host.budget;
		const protect0 = host.protectTokens;

		const events: WireEvent[] = [];
		const off = host.onEvent((e) => {
			const w = wireEventFromTruthEvent(e);
			if (w) events.push(w);
		});
		host.setCalibration(1.1);
		off();
		const cfgEv = events.find((e) => e.kind === "config");
		expect(cfgEv).toMatchObject({ kind: "config", calibration: 1.1 });
		expect((cfgEv as any).budget).toBeUndefined();
		expect((cfgEv as any).protectTokens).toBeUndefined();

		const replica = live();
		replica.append(seq(2, 1000));
		applyWireEvent(replica, cfgEv!);
		expect(replica.calibration).toBe(1.1);
		expect(replica.budget).toBe(budget0);
		expect(replica.protectTokens).toBe(protect0);
	});
});
