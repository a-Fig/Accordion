/*
 * humanDigest.test.ts — the human-authored folded digest (editable digest feature).
 *
 * The contract under test, in one line: THE TAG IS THE HANDLE. `Truth.opFold`'s human branch
 * stores `op.digest` verbatim and prepends no `{#code FOLDED}` tag, and `agentView` treats that
 * absence as "the agent was never given a way to ask about this block". Omitting `digest` puts the
 * engine digest — and its tag — back.
 */
import { describe, it, expect } from "vitest";
import { Truth } from "./truth";
import { EMPTY_DIGEST, foldCode, foldTag, hasFoldTag } from "./digest";
import { resolveUnfold, resolveRecall } from "./agentView";
import type { Block, ParsedSession } from "./types";

const META = { format: "pi" as const, title: "t", cwd: "", model: "" };

function blk(id: string, kind: Block["kind"], order: number, tokens: number, callId?: string): Block {
	return {
		id,
		kind,
		turn: 1,
		order,
		text: `${id} ${"x".repeat(tokens * 4)}`,
		tokens,
		callId,
		override: null,
		autoFolded: false,
		by: null,
	};
}

/** A Truth with a foldable text block and a tool pair, protect off so nothing is in the tail. */
function makeTruth(): Truth {
	const blocks: Block[] = [
		blk("u:1", "user", 0, 20),
		blk("a:r1:p0", "text", 1, 400),
		blk("a:r1:p1", "tool_call", 2, 10, "c1"),
		blk("r:c1", "tool_result", 3, 900, "c1"),
		blk("u:2", "user", 4, 20),
	];
	const parsed: ParsedSession = { meta: META, blocks, lineCount: 0, skipped: 0 };
	const t = new Truth(parsed);
	t.setProtect(0);
	return t;
}

const TEXT_ID = "a:r1:p0";

describe("human-authored digest", () => {
	it("stores the human's text verbatim, with no fold tag prepended", () => {
		const t = makeTruth();
		const r = t.apply([{ kind: "fold", ids: [TEXT_ID], digest: "the build passed" }], "you");
		expect(r.results[0].applied).toBe(true);

		const b = t.get(TEXT_ID)!;
		expect(t.digestOf(b)).toBe("the build passed");
		expect(hasFoldTag(t.digestOf(b))).toBe(false);
		// Human authorship, not a strategy fold — the human owns the block.
		expect(b.override).toBe("folded");
		expect(b.by).toBe("you");
	});

	it("re-folding with a different digest REWRITES it in place", () => {
		const t = makeTruth();
		t.apply([{ kind: "fold", ids: [TEXT_ID], digest: "first" }], "you");
		t.apply([{ kind: "fold", ids: [TEXT_ID], digest: "second" }], "you");
		expect(t.digestOf(t.get(TEXT_ID)!)).toBe("second");
	});

	it("omitting `digest` restores the ENGINE digest and its tag", () => {
		const t = makeTruth();
		t.apply([{ kind: "fold", ids: [TEXT_ID], digest: "mine" }], "you");
		expect(hasFoldTag(t.digestOf(t.get(TEXT_ID)!))).toBe(false);

		// The "put the auto-generated message back" path.
		t.apply([{ kind: "fold", ids: [TEXT_ID] }], "you");
		const b = t.get(TEXT_ID)!;
		expect(b.subst).toBeUndefined();
		expect(hasFoldTag(t.digestOf(b))).toBe(true);
		expect(t.digestOf(b).startsWith(`{#${foldCode(TEXT_ID)} FOLDED}`)).toBe(true);
	});

	it("a human unfold clears the authored text (the client keeps the draft, not Truth)", () => {
		const t = makeTruth();
		t.apply([{ kind: "fold", ids: [TEXT_ID], digest: "mine" }], "you");
		t.apply([{ kind: "unfold", ids: [TEXT_ID] }], "you");
		expect(t.get(TEXT_ID)!.subst).toBeUndefined();
	});

	it("counts the authored text's real size, not the engine digest's", () => {
		const t = makeTruth();
		const long = "y".repeat(400); // ~100 est tokens, far above any engine digest
		t.apply([{ kind: "fold", ids: [TEXT_ID], digest: long }], "you");
		const b = t.get(TEXT_ID)!;
		expect(t.effTokens(b)).toBe(t.foldedTokensOf(b));
		expect(t.effTokens(b)).toBeGreaterThan(100);
		// Still cheaper than the block whole — but the readout must reflect what was actually written.
		expect(t.effTokens(b)).toBeLessThan(b.tokens);
	});

	it("is refused inside the protected working tail, like any other human fold", () => {
		const t = makeTruth();
		t.setProtect(1_000_000); // everything is tail
		const r = t.apply([{ kind: "fold", ids: [TEXT_ID], digest: "mine" }], "you");
		expect(r.results[0].applied).toBe(false);
		expect(r.results[0].clamped).toBe("protected");
	});

	it("is refused under a human-steering lock", () => {
		const t = makeTruth();
		t.setLocks(["human-steering"], "test conductor");
		const r = t.apply([{ kind: "fold", ids: [TEXT_ID], digest: "mine" }], "you");
		expect(r.results[0].applied).toBe(false);
		expect(r.results[0].clamped).toBe("locked");
	});
});

describe("the seeded-digest trap (review finding: the editor pre-fills WITH the tag)", () => {
	// The editor seeds its box with the CURRENT digest, so an engine digest arrives already carrying
	// `{#code FOLDED}`. A user who edits that text rather than replacing it wholesale would commit a
	// still-tagged "human" digest — leaving the block agent-reachable and the whole contract false in
	// the single most common flow. `opFold` strips the leading tag on the human path so it cannot.
	it("strips a leading tag the human edited around, keeping the block unreachable", () => {
		const t = makeTruth();
		t.apply([{ kind: "fold", ids: [TEXT_ID] }], "you"); // plain fold → engine digest, tagged
		const seeded = t.digestOf(t.get(TEXT_ID)!);
		expect(hasFoldTag(seeded)).toBe(true);

		// Exactly what the editor sends back when the user edits the body and leaves the tag alone.
		const edited = `${foldTag(TEXT_ID)} I rewrote this`;
		t.apply([{ kind: "fold", ids: [TEXT_ID], digest: edited }], "you");

		const after = t.digestOf(t.get(TEXT_ID)!);
		expect(after).toBe("I rewrote this");
		expect(hasFoldTag(after)).toBe(false);
		expect(resolveUnfold(t, [foldCode(TEXT_ID)]).missing).toEqual([foldCode(TEXT_ID)]);
		expect(t.isFolded(t.get(TEXT_ID)!)).toBe(true); // the agent could not undo it
	});

	it("a digest that is ONLY a tag falls back to the engine digest", () => {
		const t = makeTruth();
		t.apply([{ kind: "fold", ids: [TEXT_ID], digest: foldTag(TEXT_ID) }], "you");
		expect(t.get(TEXT_ID)!.subst).toBeUndefined();
	});

	it("a FOREIGN tag does not make a block reachable by its own code", () => {
		// `hasFoldTag` would pass this (there IS a tag); only an OWN-tag check refuses it. A pasted or
		// fabricated tag must not re-open the accidental-restore path.
		const t = makeTruth();
		t.apply([{ kind: "replace", id: TEXT_ID, content: `${foldTag("r:c1")} not my tag`, recoverable: false }], "auto");
		const wire = t.digestOf(t.get(TEXT_ID)!);
		expect(hasFoldTag(wire)).toBe(true); // the weak check is fooled
		expect(resolveUnfold(t, [foldCode(TEXT_ID)]).missing).toEqual([foldCode(TEXT_ID)]);
		expect(t.isFolded(t.get(TEXT_ID)!)).toBe(true);
	});

	it("strips at GROUP granularity too, in Truth and not just in the widget", () => {
		// The group editor seeds its box with the current summary, and the default recap is tagged —
		// the identical trap one layer down. The strip has to live HERE, because `sanitizeOps` passes
		// a raw `group` command's `summary` through untouched.
		const t = makeTruth();
		const r0 = t.apply([{ kind: "group", ids: ["a:r1:p0", "r:c1"] }], "you");
		const gid = r0.results[0].detail!;
		expect(hasFoldTag(t.groupSummary(t.groupById(gid)!))).toBe(true); // default recap: tagged

		// Regroup the way an edited-around-the-tag save would.
		const t2 = makeTruth();
		const edited = `${foldTag("g:a:r1:p0")} I summarized this myself`;
		const r = t2.apply([{ kind: "group", ids: ["a:r1:p0", "r:c1"], summary: edited }], "you");
		const gid2 = r.results[0].detail!;
		expect(gid2).toBe("g:a:r1:p0");
		expect(t2.groupSummary(t2.groupById(gid2)!)).toBe("I summarized this myself");
		expect(resolveUnfold(t2, [foldCode(gid2)]).missing).toEqual([foldCode(gid2)]);
		expect(t2.groupById(gid2)!.folded).toBe(true); // the agent could not undo it
	});

	it("a STRATEGY group summary keeps its tag — thermocline's strata stay recall-able", () => {
		const t = makeTruth();
		const tagged = `${foldTag("g:a:r1:p0")} stratum`;
		const r = t.apply([{ kind: "group", ids: ["a:r1:p0", "r:c1"], summary: tagged }], "auto");
		const gid = r.results[0].detail!;
		expect(t.groupSummary(t.groupById(gid)!)).toBe(tagged); // NOT stripped
		expect(resolveUnfold(t, [foldCode(gid)]).missing).toEqual([]);
	});

	it("strips to a FIXED POINT, so a doubled tag leaves no residual handle", () => {
		const t = makeTruth();
		const doubled = `${foldTag(TEXT_ID)} ${foldTag(TEXT_ID)} words`;
		t.apply([{ kind: "fold", ids: [TEXT_ID], digest: doubled }], "you");
		expect(t.digestOf(t.get(TEXT_ID)!)).toBe("words");
		expect(resolveUnfold(t, [foldCode(TEXT_ID)]).missing).toEqual([foldCode(TEXT_ID)]);
	});

	it("a STRATEGY fold-with-digest keeps its tag — ViewConductor authors its own handle", () => {
		const t = makeTruth();
		const tagged = `${foldTag(TEXT_ID)} conductor's own handle`;
		t.apply([{ kind: "fold", ids: [TEXT_ID], digest: tagged }], "auto");
		expect(t.digestOf(t.get(TEXT_ID)!)).toBe(tagged); // NOT stripped
		expect(resolveUnfold(t, [foldCode(TEXT_ID)]).missing).toEqual([]);
	});
});

describe("EMPTY_DIGEST — the emptied block", () => {
	it("rides the wire as a real, non-empty substitution", () => {
		const t = makeTruth();
		t.apply([{ kind: "fold", ids: ["r:c1"], digest: EMPTY_DIGEST }], "you");
		expect(t.digestOf(t.get("r:c1")!)).toBe(EMPTY_DIGEST);

		// The load-bearing part: `computeFoldOps` drops any op with an empty digestText, which would
		// ship the block WHOLE. `{empty}` is non-empty, so the fold genuinely reaches the model.
		const ops = t.computeFoldOps();
		const op = ops.find((o) => o.id === "r:c1");
		expect(op).toBeDefined();
		expect(op!.digestText).toBe(EMPTY_DIGEST);
	});

	it("is far cheaper than the block, but never free", () => {
		const t = makeTruth();
		const b = t.get("r:c1")!;
		t.apply([{ kind: "fold", ids: ["r:c1"], digest: EMPTY_DIGEST }], "you");
		expect(t.effTokens(b)).toBeLessThan(15);
		expect(t.effTokens(b)).toBeGreaterThan(0);
	});
});

describe("agent reachability follows the tag", () => {
	it("cannot unfold or recall a human-authored digest, even on a code match", () => {
		const t = makeTruth();
		t.apply([{ kind: "fold", ids: [TEXT_ID], digest: "the build passed" }], "you");
		const code = foldCode(TEXT_ID);

		// The agent never SEES this code (no tag rides the wire), but a `foldCode` hash collision
		// with some other block's visible tag would hand it one. Neither path may reach the block.
		expect(resolveUnfold(t, [code]).missing).toEqual([code]);
		expect(resolveUnfold(t, [code]).restored).toEqual([]);
		expect(resolveRecall(t, [code]).missing).toEqual([code]);
		expect(t.isFolded(t.get(TEXT_ID)!)).toBe(true); // untouched
	});

	it("CAN unfold the engine digest — restoring auto hands the handle back", () => {
		const t = makeTruth();
		const code = foldCode(TEXT_ID);
		t.apply([{ kind: "fold", ids: [TEXT_ID], digest: "mine" }], "you");
		expect(resolveUnfold(t, [code]).missing).toEqual([code]);

		t.apply([{ kind: "fold", ids: [TEXT_ID] }], "you"); // restore auto
		const r = resolveUnfold(t, [code]);
		expect(r.missing).toEqual([]);
		expect(r.restored[0].ids).toEqual([TEXT_ID]);
		expect(t.isFolded(t.get(TEXT_ID)!)).toBe(false);
	});

	it("cannot reach a conductor's NON-recoverable replace either", () => {
		const t = makeTruth();
		t.apply([{ kind: "replace", id: TEXT_ID, content: "verbatim", recoverable: false }], "auto");
		const code = foldCode(TEXT_ID);
		expect(hasFoldTag(t.digestOf(t.get(TEXT_ID)!))).toBe(false);
		expect(resolveUnfold(t, [code]).missing).toEqual([code]);
	});

	it("CAN reach a conductor's recoverable replace (the tag is prepended for it)", () => {
		const t = makeTruth();
		t.apply([{ kind: "replace", id: TEXT_ID, content: "summary" }], "auto");
		const code = foldCode(TEXT_ID);
		expect(hasFoldTag(t.digestOf(t.get(TEXT_ID)!))).toBe(true);
		expect(resolveUnfold(t, [code]).missing).toEqual([]);
	});
});

describe("group summaries", () => {
	it("a human's untagged summary is unreachable; a drop group stays reachable", () => {
		const t = makeTruth();
		const r = t.apply([{ kind: "group", ids: ["a:r1:p0", "r:c1"], summary: "I handled this already" }], "you");
		const gid = r.results[0].detail!;
		expect(resolveUnfold(t, [foldCode(gid)]).missing).toEqual([foldCode(gid)]);

		// A DROP group emits no message, yet must stay reachable: the role-validity floor can
		// degrade it to a `roleFloorRecap` stub that carries `foldTag(g.id)` on purpose.
		const t2 = makeTruth();
		const r2 = t2.apply([{ kind: "group", ids: ["a:r1:p0", "r:c1"], summary: null }], "you");
		const gid2 = r2.results[0].detail!;
		expect(t2.isDropGroup(t2.groupById(gid2)!)).toBe(true);
		expect(resolveUnfold(t2, [foldCode(gid2)]).missing).toEqual([]);
	});

	it("the default recap is tagged, so it stays reachable", () => {
		const t = makeTruth();
		const r = t.apply([{ kind: "group", ids: ["a:r1:p0", "r:c1"] }], "you");
		const gid = r.results[0].detail!;
		expect(hasFoldTag(t.groupSummary(t.groupById(gid)!))).toBe(true);
		expect(resolveUnfold(t, [foldCode(gid)]).missing).toEqual([]);
	});
});
