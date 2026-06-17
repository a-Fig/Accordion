/*
 * plan.ts — turn the engine's LOCAL fold decisions into provider-safe wire ops.
 *
 * The engine (AccordionStore) already decides, per block, whether it is folded —
 * that is the brain. This module is the thin, PURE translation layer that mirrors
 * those decisions into the `FoldOp`s the GUI sends back to the pi extension over
 * the live link ("GUI drives, extension is thin"). No Svelte runes, no `$state`,
 * no side effects: given a store, it just reads and returns a plan.
 *
 * It emits one op per block that the store currently folds, BUT only after two
 * defense-in-depth filters on top of the extension's own `applyPlan` kind checks:
 *   • KIND filter — only `text | thinking | tool_result` are ever folded.
 *     A `tool_call` is never folded (altering/removing it orphans its result →
 *     provider 400); a `user` block (the human's intent) is never folded.
 *   • DURABLE-ID guard — only blocks with a durable, content-anchored id
 *     (`isDurableId`) are folded. A positional fallback id is not stable once the
 *     message array shifts (folding makes it non-append-only), so we must never
 *     instruct a fold we can't durably re-identify.
 * It also skips any op whose digest is empty, so a fold never empties a content
 * part. These checks duplicate the extension's safety net on purpose: both sides
 * enforce the invariant so neither alone is a single point of failure.
 *
 * Ops follow block order, matching the conversation's linear order.
 */
import type { AccordionStore } from "../engine/store.svelte";
import type { Block } from "../engine/types";
import type { FoldOp, GroupOp, UnfoldRestored, RecallContent } from "./protocol";
import { isDurableId } from "./mapping";
import { foldCode, wireFoldable } from "../engine/digest";

/**
 * Compute the fold plan for the current store state: one `FoldOp` per block that
 * the engine folds AND that passes the kind / durable-id / non-empty-digest
 * guards. Pure read; the store is never mutated. Ops preserve block order.
 */
export function computeFoldOps(store: AccordionStore): FoldOp[] {
	const ops: FoldOp[] = [];
	for (const b of store.blocks) {
		if (!store.isFolded(b)) continue;
		// A FOLDED group's members are collapsed by their GroupOp (the whole message is removed
		// and replaced by the summary). Emitting a per-block FoldOp here too is redundant on the
		// wire (applyPlan removes the message before any in-place fold runs) AND a trap — the op
		// would carry the block's own digest, divergent from the group summary. Skip them.
		if (store.groupOf(b)?.folded) continue;
		if (!wireFoldable(b)) continue; // never user / tool_call — the ONE shared foldability gate
		if (!isDurableId(b.id)) continue; // durable-id safety guard
		const digestText = store.digestOf(b);
		if (!digestText) continue; // never empty a content part
		ops.push({ id: b.id, digestText });
	}
	return ops;
}

/**
 * Compute the group-collapse ops for the current store state (ADR 0006): one `GroupOp` per
 * FOLDED group. `memberIds` is the group's durable member ids — the GUI's *intent*; the
 * extension's `applyPlan` independently re-derives which whole, balanced messages it may
 * actually remove (a non-durable member is dropped here too, since a positional id is not
 * stable across array shifts). `summaryText` is the engine's
 * single-source-of-truth recap, carrying the one `{#code FOLDED}` tag for the whole range.
 * Pure read; the store is never mutated.
 */
export function computeGroupOps(store: AccordionStore): GroupOp[] {
	const out: GroupOp[] = [];
	for (const g of store.groups) {
		if (!g.folded) continue;
		const memberIds = g.memberIds.filter(isDurableId);
		if (!memberIds.length) continue; // nothing durably removable
		const summaryText = store.groupSummary(g);
		if (!summaryText) continue;
		out.push({ id: g.id, memberIds, summaryText });
	}
	return out;
}

/** Short, human-readable label for an unfold confirmation (e.g. "tool_result read_file · turn 12"). */
export function blockLabel(b: Block): string {
	const where = b.turn > 0 ? `turn ${b.turn}` : "preamble";
	return b.toolName ? `${b.kind} ${b.toolName} · ${where}` : `${b.kind} · ${where}`;
}

/**
 * Resolve an agent `unfold` request against the live store (protocol v3). For each
 * `code` the agent sent (read from a `{#<code> FOLDED}` tag), restore EVERY folded
 * block carrying that code and record it; a code that matches no folded block is
 * reported in `missing`.
 *
 * Why all matches: the code is a short hash of the durable id (see `foldCode`), so it
 * can rarely collide. Restoring every folded block that shares the code is the cheap,
 * stateless way to handle that — an extra restored block is harmless (it only shows the
 * model more of its own content).
 *
 * Restoring uses `store.unfold(id, "agent")` — a sticky override (protected from
 * auto-refold) with provenance "agent" so the activity log shows the agent pulled it
 * back and the human stays the source of truth (free to re-fold it). Guarding on
 * `isFolded` is the safety pillar: the agent can only restore what was actually folded,
 * so it can never downgrade a human pin or flip an auto-managed block to a sticky
 * agent-unfold. It can request, never force. This MUTATES the store; the restored
 * content reaches the model at the next `context` hook (the block drops out of
 * `computeFoldOps`). Pure of the wire — the caller sends the result.
 */
export function resolveUnfold(store: AccordionStore, codes: string[]): { restored: UnfoldRestored[]; missing: string[] } {
	const restored: UnfoldRestored[] = [];
	const missing: string[] = [];
	for (const code of codes) {
		let hit = false;
		// A GROUP code (= foldCode(group.id)) restores the WHOLE range: unfold the group, so
		// its members reflow on the agent's next context (ADR 0006 §6). Checked first; a code
		// can in principle match both a group and a block (rare collision) → restore both.
		for (const g of store.groups) {
			if (g.folded && foldCode(g.id) === code) {
				store.unfoldGroup(g.id, "agent");
				// VERIFY it took (FIX 3): under the `agent-unfold` lock `unfoldGroup(…, "agent")`
				// is a no-op, so the group stays folded. Only count a restore that actually
				// happened — a refused one falls through to `missing`, never a false "restored".
				if (!store.groupById(g.id)?.folded) {
					restored.push({ code, kind: "text", label: `group · ${g.memberIds.length} blocks`, ids: g.memberIds });
					hit = true;
				}
			}
		}
		// Mirror EXACTLY the set `computeFoldOps` sends: folded, a foldable kind, and a
		// durable id. So the agent can only ever restore something it was actually shown a
		// `{#code FOLDED}` tag for — never a human pin, a locally-folded user/tool_call, or
		// a positional-id block that was never on the wire.
		const matches = store.blocks.filter((b) => store.isFolded(b) && wireFoldable(b) && isDurableId(b.id) && foldCode(b.id) === code);
		for (const b of matches) {
			// A member of a FOLDED group is controlled by the group, not per-block overrides —
			// `store.unfold` would no-op there (ADR 0006 §2). Route it through `unfoldGroup` so
			// the reported restore is never a lie. (In practice a collapsed member is removed
			// from the wire, so the agent only ever holds the group code — but keep the honesty
			// guarantee LOCAL to this resolver rather than relying on that.)
			const grp = store.groupOf(b);
			const grpFolded = grp?.folded ?? false;
			if (grpFolded) store.unfoldGroup(grp!.id, "agent");
			else store.unfold(b.id, "agent");
			// VERIFY the unfold actually took effect (FIX 3): under the `agent-unfold` lock both
			// `store.unfold` and `store.unfoldGroup` are no-ops, so the block stays folded. Only
			// report a restore that really happened; a refused one is dropped here and, if every
			// match for this code is refused, the code falls through to `missing`.
			const stillFolded = grpFolded ? (grp!.folded ?? false) : store.isFolded(b);
			if (stillFolded) continue;
			// ids reflects the ACTUAL restore set: if routed through unfoldGroup the whole group
			// is restored, not just the single member block (honesty guarantee). Captured before
			// the unfold call so the pre-unfold folded state is used for the branch decision.
			restored.push({ code, kind: b.kind, label: blockLabel(b), ids: grpFolded ? grp!.memberIds : [b.id] });
			hit = true;
		}
		if (!hit) missing.push(code);
	}
	return { restored, missing };
}

/**
 * Resolve an agent `recall` request against the live store (protocol v4, ADR 0011).
 * `recall` is the agent's counterpart to the human's "peek": an UNBLOCKABLE read that
 * returns a folded block's ORIGINAL full content so the agent can use it THIS turn —
 * WITHOUT changing what is standing in its context. The block stays folded.
 *
 * Critical differences from `resolveUnfold`:
 *   • READ-ONLY — this NEVER calls `store.unfold`/`unfoldGroup`/any mutator. No override
 *     is created; the matched block remains folded exactly as it was. (This is why recall
 *     is never lockable: it can't alter the standing view, so it is the safe-by-construction
 *     read that keeps a locked `unfold` from blinding the agent.)
 *   • ORIGINAL content — for a matched block we return `store.get(id)?.text` (the full,
 *     un-folded content), NOT `store.digestOf(b)` (the lossy folded substitution). Returning
 *     the digest would defeat recall's whole purpose: the agent already SEES the digest.
 *
 * Same match set as `resolveUnfold` / `computeFoldOps`: folded + a `FOLDABLE_KIND` + a
 * durable id + `foldCode(b.id) === code` for per-block matches; also folded groups via
 * `foldCode(g.id) === code` (a group returns its members' full original text joined). A
 * code matching nothing → `missing`. Pure of the wire — the caller sends the result.
 */
export function resolveRecall(store: AccordionStore, codes: string[]): { restored: RecallContent[]; missing: string[] } {
	const restored: RecallContent[] = [];
	const missing: string[] = [];
	for (const code of codes) {
		let hit = false;
		// A GROUP code (= foldCode(group.id)) recalls the WHOLE range: return the full original
		// text of every member, joined in conversation order. Checked first; a code can in
		// principle match both a group and a block (rare collision) → return both.
		for (const g of store.groups) {
			if (g.folded && foldCode(g.id) === code) {
				const text = g.memberIds
					.map((id) => store.get(id)?.text ?? "")
					.filter((t) => t.length > 0)
					.join("\n\n");
				restored.push({ code, label: `group · ${g.memberIds.length} blocks`, text, ids: g.memberIds });
				hit = true;
			}
		}
		// Mirror EXACTLY the set `computeFoldOps`/`resolveUnfold` use: folded, a foldable kind,
		// and a durable id — so the agent can only ever recall something it was actually shown a
		// `{#code FOLDED}` tag for.
		const matches = store.blocks.filter((b) => store.isFolded(b) && wireFoldable(b) && isDurableId(b.id) && foldCode(b.id) === code);
		for (const b of matches) {
			// A member of a FOLDED group is represented by its group on the wire (the agent only
			// holds the group code); skip per-block recall here so we don't double-report — the
			// group branch above already returns the full range.
			if (store.groupOf(b)?.folded) continue;
			// READ-ONLY: return the block's ORIGINAL full text, never the digest, and never mutate.
			restored.push({ code, label: blockLabel(b), text: store.get(b.id)?.text ?? b.text, ids: [b.id] });
			hit = true;
		}
		if (!hit) missing.push(code);
	}
	return { restored, missing };
}
