import { describe, it, expect, beforeEach } from "vitest";
import { AccordionStore } from "../../engine/store.svelte";
import type { Block, ParsedSession } from "../../engine/types";
import { getDraft, setDraft, clearDraft, clearAllDrafts } from "./digestDrafts";

/*
 * Finding D — a group id is `g:${memberIds[0]}` (`store.svelte.ts`'s `setGroupSummary` doc
 * comment) and gets REUSED whenever a later group starts at the same leading block. Deleting a
 * group only ungroups the Truth-side overlay (`store.deleteGroup`) — it never touched
 * `digestDrafts.ts`'s client-local unsaved-draft Map, so a draft typed but never saved could
 * resurrect onto an unrelated LATER group that happens to reuse the same derived id.
 *
 * The only place a group is actually deleted through the app's UI is `Inspector.svelte`'s two
 * Delete buttons, both now routed through its local `deleteGroup()` function, which calls
 * `clearDraft(id)` before `store.deleteGroup(id)` — see the doc comment on that function.
 * `Inspector.svelte` cannot itself be mounted here (no jsdom/@testing-library/svelte in this
 * repo's devDependencies), so this test exercises the exact sequence that function performs,
 * against the real `store.svelte.ts` and the real `digestDrafts.ts` — the same two modules the
 * component actually calls, not a reimplementation.
 */
function b(id: string, kind: Block["kind"], turn: number, order: number, tokens: number, callId?: string): Block {
	return { id, kind, turn, order, text: `${id} ${"x".repeat(tokens * 4)}`, tokens, callId, override: null, autoFolded: false, by: null };
}

function makeStore(): AccordionStore {
	const blocks: Block[] = [
		b("u:1", "user", 1, 0, 20),
		b("a:r1:p0", "thinking", 1, 1, 200), // first member of group #1 → id g:a:r1:p0
		b("a:r1:p1", "text", 1, 2, 200),
		b("a:r1:p2", "tool_call", 1, 3, 10, "c1"),
		b("r:c1", "tool_result", 1, 4, 3000, "c1"),
		b("u:2", "user", 2, 5, 20),
		b("a:r2:p0", "text", 3, 6, 50), // first member of group #2, once re-created at the same id
	];
	const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks, lineCount: 0, skipped: 0 };
	const s = new AccordionStore(parsed);
	s.setBudget(1_000_000);
	s.setProtect(0);
	return s;
}

/** Mirrors `Inspector.svelte`'s local `deleteGroup()` — the fix under test. */
function deleteGroupWithDraftCleanup(s: AccordionStore, id: string): void {
	clearDraft(id);
	s.deleteGroup(id);
}

/** The PRE-FIX behavior — `store.deleteGroup` alone, no draft cleanup. */
function deleteGroupWithoutDraftCleanup(s: AccordionStore, id: string): void {
	s.deleteGroup(id);
}

describe("Finding D — deleting a group must clear its unsaved draft, so a later group reusing the same id doesn't inherit it", () => {
	beforeEach(() => {
		clearAllDrafts();
	});

	it("(pre-fix behavior) a stale draft resurrects onto a new group that reuses the deleted group's id", () => {
		const s = makeStore();
		const g1 = s.createGroup("a:r1:p0", "r:c1")!;
		expect(g1.id).toBe("g:a:r1:p0");

		// The human types a digest but never saves it.
		setDraft(g1.id, "half-written thought, never saved", s.groupSummary(g1));
		expect(getDraft(g1.id)).toBe("half-written thought, never saved");

		deleteGroupWithoutDraftCleanup(s, g1.id);
		expect(s.groupById(g1.id)).toBeUndefined();
		// BUG: the draft Map entry outlives the group it was typed against.
		expect(getDraft(g1.id)).toBe("half-written thought, never saved");

		// A brand-new, semantically unrelated group is created, starting at the SAME leading block —
		// group ids are `g:${memberIds[0]}`, so this new group gets the identical id `g1` had.
		const g2 = s.createGroup("a:r1:p0", "u:2")!;
		expect(g2.id).toBe(g1.id);

		// BUG reproduced: the new, never-before-touched group appears to already have the old
		// group's unsaved draft.
		expect(getDraft(g2.id)).toBe("half-written thought, never saved");
	});

	it("(post-fix behavior) clearing the draft on delete means a reused id starts clean", () => {
		const s = makeStore();
		const g1 = s.createGroup("a:r1:p0", "r:c1")!;
		setDraft(g1.id, "half-written thought, never saved", s.groupSummary(g1));
		expect(getDraft(g1.id)).toBe("half-written thought, never saved");

		deleteGroupWithDraftCleanup(s, g1.id);
		expect(s.groupById(g1.id)).toBeUndefined();
		expect(getDraft(g1.id)).toBeUndefined(); // cleared immediately on delete

		const g2 = s.createGroup("a:r1:p0", "u:2")!;
		expect(g2.id).toBe(g1.id); // same derived id, reused

		// FIXED: the new group starts with no draft — it does not inherit the old one's leftovers.
		expect(getDraft(g2.id)).toBeUndefined();
	});

	it("(post-fix behavior) a draft for a DIFFERENT, still-live group is untouched by an unrelated delete", () => {
		const s = makeStore();
		const g1 = s.createGroup("a:r1:p0", "r:c1")!;
		const other = "some-other-block-id";
		setDraft(other, "unrelated in-flight draft", "committed");

		deleteGroupWithDraftCleanup(s, g1.id);

		expect(getDraft(other)).toBe("unrelated in-flight draft"); // untouched
	});
});
