/*
 * store.digest.test.ts — the store actions behind the editable folded digest.
 *
 * `setBlockDigest` and `setGroupSummary` are what the UI's `DigestEditor` calls. The interesting
 * behaviour is at the edges: what an EMPTY box means (different at block vs group granularity),
 * what `null` means (restore the engine's own text), and that a group summary rewrite keeps the
 * group's identity — and therefore any handle an agent is already holding.
 */
import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import { EMPTY_DIGEST, foldCode, hasFoldTag } from "$core/digest";
import type { Block, ParsedSession } from "./types";

function b(id: string, kind: Block["kind"], turn: number, order: number, tokens: number, callId?: string): Block {
	return { id, kind, turn, order, text: `${id} ${"x".repeat(tokens * 4)}`, tokens, callId, override: null, autoFolded: false, by: null };
}

function makeStore(): AccordionStore {
	const blocks: Block[] = [
		b("u:1", "user", 1, 0, 100),
		b("a:r1:p0", "thinking", 1, 1, 800),
		b("a:r1:p1", "text", 1, 2, 600),
		b("a:r1:p2", "tool_call", 1, 3, 100, "c1"),
		b("r:c1", "tool_result", 1, 4, 3000, "c1"),
		b("u:2", "user", 2, 5, 100),
	];
	const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks, lineCount: 0, skipped: 0 };
	const s = new AccordionStore(parsed);
	s.setBudget(1_000_000);
	s.setProtect(0);
	return s;
}

describe("setBlockDigest", () => {
	it("writes the human's text and folds a still-live block in one call", () => {
		const s = makeStore();
		expect(s.isFolded(s.get("r:c1")!)).toBe(false);
		s.setBlockDigest("r:c1", "  ran the tests, all green  ");
		const blk = s.get("r:c1")!;
		expect(s.isFolded(blk)).toBe(true);
		expect(s.digestOf(blk)).toBe("ran the tests, all green"); // trimmed
	});

	it("an empty box saves as the {empty} sentinel, never as nothing", () => {
		const s = makeStore();
		s.setBlockDigest("r:c1", "   \n  ");
		expect(s.digestOf(s.get("r:c1")!)).toBe(EMPTY_DIGEST);
		// A truly empty digestText would be dropped by `applyPlan` and the block would ship WHOLE.
		const op = s.computeFoldOps().find((o) => o.id === "r:c1");
		expect(op?.digestText).toBe(EMPTY_DIGEST);
	});

	it("null restores the engine digest, tag and all", () => {
		const s = makeStore();
		s.setBlockDigest("r:c1", "mine");
		expect(hasFoldTag(s.digestOf(s.get("r:c1")!))).toBe(false);
		s.setBlockDigest("r:c1", null);
		const blk = s.get("r:c1")!;
		expect(blk.subst).toBeUndefined();
		expect(hasFoldTag(s.digestOf(blk))).toBe(true);
		expect(s.isFolded(blk)).toBe(true); // still folded — only the TEXT went back to auto
	});

	it("strips a tag the user edited around, so the agent cannot undo the edit", () => {
		const s = makeStore();
		s.fold("r:c1"); // engine digest — arrives in the editor already tagged
		const seeded = s.digestOf(s.get("r:c1")!);
		expect(hasFoldTag(seeded)).toBe(true);

		// The editor strips before sending AND `opFold` strips again; either alone is enough, but the
		// UI needs its copy so `typed` predicts the committed value and Save clears itself.
		s.setBlockDigest("r:c1", seeded.replace(/^\S+ /, "kept the tag by accident: "));
		expect(hasFoldTag(s.digestOf(s.get("r:c1")!))).toBe(false);
	});

	it("takes the block over from a conductor that folded it", () => {
		const s = makeStore();
		s.fold("r:c1", "auto", "conductor's summary");
		expect(s.get("r:c1")!.by).toBe("auto");
		expect(s.get("r:c1")!.override).toBeNull();

		s.setBlockDigest("r:c1", "no, mine");
		const blk = s.get("r:c1")!;
		expect(blk.override).toBe("folded");
		expect(blk.by).toBe("you");

		// And the conductor cannot take it back: every strategy write refuses on a human override.
		s.fold("r:c1", "auto", "let me back in");
		expect(s.digestOf(s.get("r:c1")!)).toBe("no, mine");
	});
});

describe("setGroupSummary", () => {
	it("rewrites the summary and KEEPS the group id (so an agent handle survives)", () => {
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		const before = foldCode(g.id);

		s.setGroupSummary(g.id, "the whole investigation, in one line");
		const after = s.groupById(g.id);
		expect(after).toBeDefined();
		expect(foldCode(after!.id)).toBe(before);
		expect(s.groupSummary(after!)).toBe("the whole investigation, in one line");
		expect(after!.memberIds).toEqual(g.memberIds);
		expect(after!.folded).toBe(true);
	});

	it("an empty box is a REAL drop at group granularity", () => {
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		s.setGroupSummary(g.id, "");
		const after = s.groupById(g.id)!;
		expect(s.isDropGroup(after)).toBe(true);
		// A drop emits no message at all — unlike a block, where empty means `{empty}`.
		expect(s.computeGroupOps().find((o) => o.id === g.id)?.summaryText).toBeNull();
	});

	it("null restores the engine's default recap", () => {
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1", "you", "custom")!;
		expect(s.groupSummary(s.groupById(g.id)!)).toBe("custom");

		s.setGroupSummary(g.id, null);
		const summary = s.groupSummary(s.groupById(g.id)!);
		expect(hasFoldTag(summary)).toBe(true);
		expect(summary).toContain("group ·");
	});

	it("un-drops a drop group when text is typed back in", () => {
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		s.setGroupSummary(g.id, "");
		expect(s.isDropGroup(s.groupById(g.id)!)).toBe(true);

		s.setGroupSummary(g.id, "actually, keep a note of this");
		const after = s.groupById(g.id)!;
		expect(s.isDropGroup(after)).toBe(false);
		expect(s.groupSummary(after)).toBe("actually, keep a note of this");
	});

	it("does NOT resurrect a fold state the user did not ask for — open groups stay open", () => {
		// `opGroup` hardcodes `folded: true`, so a summary edit on an OPEN group would silently
		// collapse live wire content. The Inspector only offers the editor on a FOLDED group; this
		// pins the engine behaviour that makes that gate necessary, so the gate is never "cleaned up".
		const s = makeStore();
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		s.unfoldGroup(g.id);
		expect(s.groupById(g.id)!.folded).toBe(false);

		s.setGroupSummary(g.id, "text edit on an open group");
		expect(s.groupById(g.id)!.folded).toBe(true); // ← why the UI must not offer this
	});

	it("is a no-op on an unknown group id", () => {
		const s = makeStore();
		const before = s.groups.length;
		s.setGroupSummary("g:nope", "hello");
		expect(s.groups.length).toBe(before);
	});

	// Review finding: `setGroupSummary` sends `[{ungroup}, {group}]` as one batch so an agent handle
	// survives a summary edit. `Truth.apply` is NOT atomic — if the `ungroup` half commits and the
	// paired `group` half is then clamped, the group used to vanish silently with no error surfaced.
	//
	// The reported repro (`setProtect` alone, after group creation) turns out to be blocked earlier:
	// `pruneProtectedGroups` runs on every housekeeping pass and already destroys a group whose members
	// fall in the protected tail, well before `setGroupSummary` is ever called — so that path was never
	// actually reachable through `setGroupSummary`. The REAL path is `opGroup`'s own `snappedRange`
	// widening the edit's effective range at rewrite time: a group created over an INCOMPLETE multi-part
	// assistant message survives later `append()`s of sibling parts (`pruneProtectedGroups` only checks
	// the group's own already-narrow stored `memberIds`, never re-derives a wider range) and survives a
	// `setProtect` move that doesn't reach past that narrow stored range — but `setGroupSummary`'s
	// internal regroup re-snaps to the FULL message (pulling in the now-appended sibling part), and if
	// that wider range now reaches into the protected tail, `opGroup` clamps it as `"protected"` — after
	// the `ungroup` half already committed.
	it("a mid-edit widen into the protected tail must not destroy the group (Truth.apply is not atomic)", () => {
		// Group created over only the first TWO parts of a three-part assistant message.
		const early: Block[] = [b("u:1", "user", 1, 0, 100), b("a:r1:p0", "thinking", 1, 1, 800), b("a:r1:p1", "text", 1, 2, 600)];
		const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks: early, lineCount: 0, skipped: 0 };
		const s = new AccordionStore(parsed);
		s.setBudget(1_000_000);
		s.setProtect(0);

		const g = s.createGroup("a:r1:p0", "a:r1:p1")!;
		expect(g).not.toBeNull();
		expect(s.groups.length).toBe(1);

		// The rest of the assistant turn streams in later: the message's own third part (same
		// `messageKey`, so `snappedRange` will later pull it into a regroup) plus its tool result and
		// the next user turn.
		s.appendBlocks([b("a:r1:p2", "tool_call", 1, 3, 100, "c1"), b("r:c1", "tool_result", 1, 4, 3000, "c1"), b("u:2", "user", 2, 5, 100)]);
		expect(s.groups.length).toBe(1); // pruneProtectedGroups: group's own narrow range is still safe

		// The human drags the protect dial. It lands past the newly-arrived sibling part but not past
		// the group's own (still narrow) stored range — so the group survives this move too.
		s.setProtect(3150);
		expect(s.groups.length).toBe(1);
		const beforeEdit = s.groupById(g.id)!;
		expect(beforeEdit.memberIds).toEqual(["a:r1:p0", "a:r1:p1"]);

		// Now the edit: setGroupSummary's internal regroup re-snaps via snappedRange, widening to
		// include "a:r1:p2" (same messageKey) — which sits at/past the now-moved protected boundary.
		// Pre-fix, this silently destroyed the group. Post-fix, the whole rewrite is refused atomically
		// and the original group survives untouched.
		s.setGroupSummary(g.id, "my own words");

		const after = s.groupById(g.id);
		expect(after).toBeDefined(); // not destroyed
		expect(s.groups.length).toBe(1);
		expect(after!.memberIds).toEqual(["a:r1:p0", "a:r1:p1"]); // unchanged, not silently widened either
		expect(after!.folded).toBe(true);
		// The edit itself was refused (protected range can't be rewritten right now) — so the summary
		// must be exactly what it was before the attempted edit, not the human's new text.
		expect(s.groupSummary(after!)).toBe(s.groupSummary(beforeEdit));
	});
});

describe("Finding A — clearing a tagged group's digest to a drop must revoke the agent's handle", () => {
	// Reviewer's confirmed repro: human groups blocks the agent already has a working tag for → the
	// wire carries `{#code FOLDED} group · N blocks · ...` (the agent now knows this code) → human
	// clears the group's digest box in the Inspector (`setGroupSummary(id, "")`, a REAL drop at group
	// granularity) → `Group.digest === null`, nothing on the wire → the agent tries `recall`/`unfold`
	// with the SAME code it already knew. Pre-fix, `groupAgentReachable` treated EVERY drop group as
	// reachable, so the agent could still pull back the full original content the human just told the
	// engine to drop — the strongest human curation action (drop) was MORE reachable than a weaker one
	// (a custom summary). Post-fix, a drop that truly vanishes must be unreachable.
	//
	// The layout deliberately puts a LIVE assistant turn ("a:r2:p0") between the group and the next
	// user turn — NOT another user turn immediately after — so dropping the group does not trip the
	// role-validity floor's same-role-adjacency guard. That guard is a SEPARATE, legitimate carve-out
	// (see the "a drop group stays reachable" test in core/humanDigest.test.ts): this test is deliberately
	// shaped to avoid it, so it exercises the genuine-silent-drop case Finding A is actually about.
	function makeReachabilityStore(): AccordionStore {
		const blocks: Block[] = [
			b("u:1", "user", 1, 0, 20),
			b("a:r1:p0", "thinking", 1, 1, 200),
			b("a:r1:p1", "text", 1, 2, 200),
			b("a:r1:p2", "tool_call", 1, 3, 10, "c1"),
			b("r:c1", "tool_result", 1, 4, 3000, "c1"),
			b("a:r2:p0", "text", 2, 5, 50), // live assistant turn AFTER the group — keeps the drop role-valid
			b("u:2", "user", 3, 6, 20),
		];
		const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks, lineCount: 0, skipped: 0 };
		const s = new AccordionStore(parsed);
		s.setBudget(1_000_000);
		s.setProtect(0);
		return s;
	}

	it("recall/unfold on the known code no longer succeed once the group is dropped", () => {
		const s = makeReachabilityStore();
		const g = s.createGroup("a:r1:p0", "r:c1")!;
		expect(g).not.toBeNull();

		// The agent has already been shown this on the wire: the default recap is tagged, and (via
		// the read-only `recall`, which never mutates) it can pull the full original content right now.
		const summary = s.groupSummary(s.groupById(g.id)!);
		expect(hasFoldTag(summary)).toBe(true);
		const code = foldCode(g.id);
		const preDrop = s.resolveRecall([code]);
		expect(preDrop.missing).toEqual([]);
		expect(preDrop.restored[0]?.text.length).toBeGreaterThan(0);

		// The human clears the box — a REAL drop at group granularity (unlike a per-block digest,
		// which becomes `{empty}` instead).
		s.setGroupSummary(g.id, "");
		const dropped = s.groupById(g.id)!;
		expect(s.isDropGroup(dropped)).toBe(true);
		expect(s.groupSummary(dropped)).toBe(""); // nothing on the wire at all

		// The agent tries the SAME code it already knew. Pre-fix this succeeded (recall handed back
		// the full original text; unfold restored the whole range). Post-fix, both must fail.
		const recall = s.resolveRecall([code]);
		expect(recall.missing).toEqual([code]);
		expect(recall.restored).toEqual([]);

		const unfold = s.resolveUnfold([code]);
		expect(unfold.missing).toEqual([code]);
		expect(unfold.restored).toEqual([]);
		expect(s.groupById(g.id)!.folded).toBe(true); // still folded — unfold did NOT succeed
	});
});
