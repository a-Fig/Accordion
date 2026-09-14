/*
 * digestEditorLogic.ts — pure prediction helpers for `DigestEditor.svelte`.
 *
 * Pulled out of the component (rather than left inline in its `$derived`s) for the same reason
 * `stripFoldTags` itself lives in `core/digest.ts` and not the widget (see CLAUDE.md's "the tag is
 * the handle"): a plain function is trivially unit-testable without a DOM/component-render
 * environment, which this repo does not have wired up (no jsdom / @testing-library/svelte). The
 * component imports these directly, so a test against them is a test against the exact code path
 * the editor runs — not a reimplementation that could drift.
 */
import { EMPTY_DIGEST, stripFoldTags } from "$core/digest";

/**
 * What `DigestEditor.save()` will actually commit for a given textarea value — the draft with any
 * leading `{#code FOLDED}` tag(s) stripped, mirroring `Truth.opFold`/`opGroup`'s human branches
 * (same `stripFoldTags` helper, so the two agree byte-for-byte).
 *
 * `emptied` and the live cost readout MUST be computed from this, not the raw draft: the box is
 * seeded with the current digest, which for an engine-authored fold/recap starts with its own tag.
 * If a user deletes everything but that leading tag, `draft.trim()` alone is still non-empty (the
 * tag text is falsy-non-empty) even though `save()` — via this exact function — commits a drop
 * (group) or `{empty}` (block). Without predicting off the SAME value `save()` uses, the "removes
 * these messages" / "saves as {empty}" warning silently fails to show for that case.
 */
export function committedFromDraft(draft: string): string {
	return stripFoldTags(draft).trim();
}

/**
 * Will saving `committed` (see `committedFromDraft`) read as "emptied" — i.e. does it collapse to
 * nothing, or (for a block) to the `{empty}` sentinel itself? `{empty}` is a saved state, not an
 * empty field: the block is standing in for itself with three tokens, and clearing the box
 * entirely is how a human ASKS for that, so both read as "emptied".
 */
export function isEmptied(committed: string, emptyMeans: "sentinel" | "drop"): boolean {
	return committed.length === 0 || (emptyMeans === "sentinel" && committed === EMPTY_DIGEST);
}
