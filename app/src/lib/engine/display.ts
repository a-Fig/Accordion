/*
 * display.ts — the grid's render list (ADR 0006 §3).
 *
 * `ContextMap` no longer maps `blocks` 1:1. It renders the rows this pure function
 * produces: a folded group becomes ONE parent tile standing in for its range; an open
 * group becomes a dull parent tile plus its member tiles wrapped in a band; everything
 * else is a plain block tile. Kept pure (no store, no runes) so the layout transform is
 * unit-testable on its own and the component stays thin.
 *
 * Groups are always entirely older than the protected tail, so a group never straddles
 * the grid's older/protected split — callers may safely build over either slice. A group
 * whose first member is absent from the given block list is dropped defensively (its
 * members render as nothing rather than as ungrouped strays), which only arises if an
 * invariant is already broken.
 */
import type { Block, Group } from "./types";

export type DisplayRow =
	| { type: "block"; block: Block }
	/** Folded group → render ONE parent tile (members hidden behind it). */
	| { type: "group"; group: Group; members: Block[] }
	/** Open group → render the dull parent at the band's left, then each member tile. */
	| { type: "groupOpen"; group: Group; members: Block[] };

export function buildDisplay(blocks: Block[], groups: Group[]): DisplayRow[] {
	const firstMember = new Map<string, Group>();
	const memberOf = new Map<string, Group>();
	for (const g of groups) {
		if (!g.memberIds.length) continue;
		firstMember.set(g.memberIds[0], g);
		for (const id of g.memberIds) memberOf.set(id, g);
	}
	const byId = new Map<string, Block>();
	for (const b of blocks) byId.set(b.id, b);

	const rows: DisplayRow[] = [];
	const emitted = new Set<Group>();
	for (const b of blocks) {
		const g = memberOf.get(b.id);
		if (!g) {
			rows.push({ type: "block", block: b });
			continue;
		}
		if (firstMember.get(b.id) === g) {
			// Emit the group once, at its first member; the rest of its range is skipped below.
			const members = g.memberIds.map((id) => byId.get(id)).filter((x): x is Block => !!x);
			rows.push(g.folded ? { type: "group", group: g, members } : { type: "groupOpen", group: g, members });
			emitted.add(g);
		} else if (!emitted.has(g)) {
			// A member whose group was never emitted (its first member is absent from this
			// slice — an invariant violation): render it as a plain block so no tile is lost.
			rows.push({ type: "block", block: b });
		}
		// else: already emitted with its group → skip (it's behind/inside the parent).
	}
	return rows;
}
