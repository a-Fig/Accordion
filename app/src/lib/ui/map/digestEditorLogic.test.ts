import { describe, it, expect } from "vitest";
import { foldTag } from "$core/digest";
import { committedFromDraft, isEmptied } from "./digestEditorLogic";

/*
 * Finding C — `DigestEditor`'s "emptied" prediction must be computed from what `save()` will
 * ACTUALLY commit (`committedFromDraft`, i.e. `stripFoldTags(draft).trim()`), not the raw
 * textarea value. A tagged engine digest is seeded into the box WITH its `{#code FOLDED}` tag; if
 * a user deletes everything else, the raw draft is still non-empty (the tag text itself), so a
 * naive `draft.trim().length === 0` check never fires — no "removes these messages" / "saves as
 * {empty}" warning shows — even though save() silently commits a drop (group) or `{empty}`
 * (block). These tests exercise the exact functions `DigestEditor.svelte` imports and calls, so
 * they test the real code path, not a reimplementation.
 */
describe("Finding C — emptied/committed must be predicted from the stripped, not raw, draft", () => {
	const tag = foldTag("g:block1"); // "{#<code> FOLDED}"

	it("a draft that is only the leading tag commits to nothing (group: real drop)", () => {
		const draft = `${tag}\n`; // user deleted everything except the tag itself
		const committed = committedFromDraft(draft);
		expect(committed).toBe("");
		expect(isEmptied(committed, "drop")).toBe(true);
	});

	it("a draft that is only the leading tag commits to nothing (block: {empty} sentinel)", () => {
		const draft = tag;
		const committed = committedFromDraft(draft);
		expect(committed).toBe("");
		expect(isEmptied(committed, "sentinel")).toBe(true);
	});

	it("the raw draft is NOT empty by itself — this is exactly the trap: a naive draft.trim() check misses it", () => {
		const draft = tag;
		expect(draft.trim().length).toBeGreaterThan(0); // documents the bug this predicate avoids
		expect(committedFromDraft(draft).length).toBe(0); // the fix: strip first, THEN check
	});

	it("real remaining text after the tag is not emptied", () => {
		const draft = `${tag}the human's own summary`;
		const committed = committedFromDraft(draft);
		expect(committed).toBe("the human's own summary");
		expect(isEmptied(committed, "drop")).toBe(false);
		expect(isEmptied(committed, "sentinel")).toBe(false);
	});

	it("whitespace around a tag-only draft still commits to nothing", () => {
		const draft = `   ${tag}   \n\n  `;
		expect(isEmptied(committedFromDraft(draft), "drop")).toBe(true);
	});

	it("a doubled tag (fixed-point strip) also commits to nothing", () => {
		const draft = `${tag}${tag}`;
		expect(committedFromDraft(draft)).toBe("");
	});
});
