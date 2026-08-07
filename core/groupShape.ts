/*
 * groupShape.ts — the shared "which of these members can actually collapse" judgment.
 *
 * `Truth.classifyGroup` (core/truth.ts) decides, for a folded group, which of its member MESSAGES
 * the wire may genuinely remove: a message is removable only if every block it emits is durable
 * (with a live wire attached) and every tool-call/tool_result pair it holds is fully inside the
 * removal set, to a fixpoint. When that fixpoint leaves nothing removable the group has no
 * CARRIER, and `Truth.opGroup` rejects the whole op as `"nothing collapses (all stragglers)"`.
 *
 * That judgment now lives HERE, exported and pure, for the same reason `computeDegradedDropRuns`
 * was extracted to `core/wire.ts`: a conductor that proposes a group has to be able to ask the
 * question BEFORE it proposes, and a second, re-derived copy of the rule would silently drift from
 * the one Truth actually enforces. A conductor building a multi-run coverage plan (see
 * `conductors/in-process/agedSummaryConductor.ts`) must never propose a run whose carrier is
 * doomed: group ops are validated INDEPENDENTLY by `Truth.apply`, so a rejected summary-bearing
 * group next to an accepted sibling DROP silently removes content with no summary to stand in for
 * it. Same function in, same verdict out — drift is structurally impossible.
 *
 * Framework-free, dependency-free (only `isDurableId` from the wire's own id scheme).
 */
import type { BlockKind } from "./types";
import { isDurableId } from "./wire";

/**
 * The "message key" of a block id — the id with its assistant-part suffix removed, so every part
 * of one assistant message shares a key while scalar user/result/summary blocks stay their own
 * key. Two id regimes share the app (live `…:p<j>`, loaded `<eid>:<j>`); scalar durable ids like
 * `u:<ts>` / `s:<ts>` / `r:<callId>` must NOT be stripped.
 *
 * Lives here (with `core/truth.ts` re-exporting it, so every existing importer is unchanged)
 * because the collapse fixpoint below is defined per MESSAGE, not per block.
 */
export function messageKey(id: string): string {
	const live = id.match(/^(.*):p(?:\d+|\?)$/);
	if (live) return live[1];
	const parsed = id.match(/^(.+):\d+$/);
	if (parsed && !/^[a-z]:\d+$/.test(id)) return parsed[1];
	return id;
}

/**
 * The minimum a member needs for the collapse fixpoint: its id (durability + message key), its
 * kind and its `callId` (tool-pair balance). Satisfied structurally by both `Block` (Truth's own
 * log) and `ViewBlock` (what a conductor sees), so neither caller has to reshape anything.
 */
export interface GroupMemberShape {
	id: string;
	kind: BlockKind;
	callId?: string;
}

/**
 * The message keys among `members` that the wire may genuinely remove — the fixpoint `Truth`'s
 * group accounting and `Truth.opGroup`'s viability check both run.
 *
 * `requireDurable` mirrors `Truth.wireAttached`: with a live wire, a message emitting any
 * positional (non-durable) id can never be removed, because `computeGroupOps` would drop it and
 * the model would still receive the full content while the accounting showed it collapsed. A
 * non-wire session (demo / loaded transcript) has no wire to diverge from, so the gate is off.
 */
export function collapsibleMessageKeys(members: readonly GroupMemberShape[], requireDurable: boolean): Set<string> {
	const byMsg = new Map<string, GroupMemberShape[]>();
	for (const b of members) {
		const k = messageKey(b.id);
		const arr = byMsg.get(k);
		if (arr) arr.push(b);
		else byMsg.set(k, [b]);
	}
	const msgOrder = [...byMsg.keys()];
	const msgCalls = new Map<string, string[]>();
	const msgResults = new Map<string, string[]>();
	for (const k of msgOrder) {
		const calls: string[] = [];
		const results: string[] = [];
		for (const b of byMsg.get(k)!) {
			if (!b.callId) continue;
			if (b.kind === "tool_call") calls.push(b.callId);
			else if (b.kind === "tool_result") results.push(b.callId);
		}
		msgCalls.set(k, calls);
		msgResults.set(k, results);
	}
	const removable = new Set<string>();
	for (const k of msgOrder) {
		if (requireDurable && byMsg.get(k)!.some((b) => !isDurableId(b.id))) continue;
		removable.add(k);
	}
	// Fixpoint: keep a removal only if its tool pairs are fully inside the removal set. Dropping one
	// message can orphan another's pair half, so this repeats until nothing more is demoted.
	for (let changed = true; changed; ) {
		changed = false;
		const calls = new Set<string>();
		const results = new Set<string>();
		for (const k of msgOrder) {
			if (!removable.has(k)) continue;
			for (const c of msgCalls.get(k)!) calls.add(c);
			for (const c of msgResults.get(k)!) results.add(c);
		}
		for (const k of msgOrder) {
			if (!removable.has(k)) continue;
			if (msgCalls.get(k)!.some((c) => !results.has(c)) || msgResults.get(k)!.some((c) => !calls.has(c))) {
				removable.delete(k);
				changed = true;
			}
		}
	}
	return removable;
}

/**
 * Would a group over exactly `members` have a CARRIER — i.e. does anything actually collapse?
 * Equivalent to `Truth.classifyGroup(g).carrier !== null` (the carrier is the first member whose
 * message survives the fixpoint above, so a carrier exists iff the removable set is non-empty),
 * which is precisely the condition `Truth.opGroup` rejects on with
 * `"nothing collapses (all stragglers)"`.
 */
export function hasCollapsibleCarrier(members: readonly GroupMemberShape[], requireDurable: boolean): boolean {
	return collapsibleMessageKeys(members, requireDurable).size > 0;
}
