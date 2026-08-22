/*
 * agentView.ts — the live agent's `unfold` / `recall` resolution, run LOCALLY against the
 * authoritative Truth (Phase B). Previously this lived app-side (live/plan.ts, resolving against
 * the store over a WS round trip); it now resolves in-process in the extension so unfold/recall
 * work with zero clients connected. Framework-free, pure over a `Truth`.
 *
 *   unfold — MUTATES: holds each matched folded block open (sticky, provenance "agent"); the
 *            content returns to the model on its next context hook. The agent can only unfold what
 *            is actually folded — never downgrade a human pin.
 *   recall — READ-ONLY: returns a folded block's ORIGINAL full content (never the digest); never
 *            touches fold state. The safe-by-construction read that keeps a locked unfold from
 *            blinding the agent.
 */
import type { Block, Group } from "./types";
import type { Truth } from "./truth";
import { foldCode, wireFoldable, hasOwnFoldTag } from "./digest";
import { isDurableId } from "./wire";

/** One block/group restored by `resolveUnfold`. */
export interface UnfoldRestored {
	code: string;
	kind: Block["kind"];
	label: string;
	/** The block ids this restore actually touched (≥1; >1 on a hash collision or a group unfold). */
	ids: string[];
}

/** One block/group's original content returned by `resolveRecall`. */
export interface RecallContent {
	code: string;
	label: string;
	/** The block's ORIGINAL full text (NOT the folded digest) — for a group, its members joined. */
	text: string;
	ids: string[];
}

/** Short, human-readable label for a confirmation (e.g. "tool_result read_file · turn 12"). */
export function blockLabel(b: Block): string {
	const where = b.turn > 0 ? `turn ${b.turn}` : "preamble";
	return b.toolName ? `${b.kind} ${b.toolName} · ${where}` : `${b.kind} · ${where}`;
}

/**
 * Is this folded BLOCK reachable by an agent handle at all?
 *
 * The wire text the model receives is the only place a `{#code FOLDED}` tag ever appears, so a
 * digest not carrying THIS BLOCK'S OWN tag is one the agent was never handed a working code for — a human-authored digest, or a
 * conductor's non-recoverable `replace`. Without this guard a `foldCode` hash collision with some
 * OTHER block's visible tag would restore (or read out) content the human deliberately replaced
 * with their own words. `foldCode` is a 6-char base36 hash, so collisions are rare but real, and
 * `resolveUnfold` restores EVERY match for a code by design — exactly the path a collision rides.
 *
 * Mirrors the rest of the match set (`isFolded` / `wireFoldable` / `isDurableId`) so unfold, recall,
 * and the wire serialization all agree on which blocks carry a handle.
 */
function agentReachable(truth: Truth, b: Block): boolean {
	return hasOwnFoldTag(truth.digestOf(b), b.id);
}

/**
 * Is this folded GROUP reachable by an agent handle?
 *
 * The same tag-presence rule as `agentReachable`, over the summary the group actually emits — a
 * VERBATIM summary is reachable exactly when whoever wrote it included a tag. A conductor
 * routinely does (see `plan.groups` — a custom summary carrying `{#code FOLDED}` is a supported,
 * tested shape); a human typing into the digest editor does not, which is what makes their words
 * invisible to `unfold`/`recall`.
 *
 * The one carve-out is a DROP group, whose `groupSummary` is `""` — it emits no message at all,
 * yet it MUST stay reachable: the role-validity floor can degrade it to a `roleFloorRecap` stub
 * that deliberately carries `foldTag(g.id)` precisely so an agent `unfold` of that stub resolves
 * back to this group.
 */
function groupAgentReachable(truth: Truth, g: Group): boolean {
	return truth.isDropGroup(g) || hasOwnFoldTag(truth.groupSummary(g), g.id);
}

/**
 * Resolve an agent `unfold` request against the Truth. For each code (read from a `{#<code> FOLDED}`
 * tag) restore EVERY folded block/group carrying it, and record it; a code matching nothing folded
 * is reported in `missing`. A group is unfolded whole (its members reflow next context). Every
 * restore is VERIFIED to have taken effect — the engine can refuse (agent-unfold lock, already
 * open) — so a refused code falls through to `missing`, never a false "restored".
 */
export function resolveUnfold(truth: Truth, codes: string[]): { restored: UnfoldRestored[]; missing: string[] } {
	const restored: UnfoldRestored[] = [];
	const missing: string[] = [];
	for (const code of codes) {
		let hit = false;
		// A GROUP code restores the WHOLE range. Checked first; a code can in principle match both a
		// group and a block (rare collision) → restore both.
		for (const g of truth.groups) {
			if (g.folded && groupAgentReachable(truth, g) && foldCode(g.id) === code) {
				truth.apply([{ kind: "unfoldGroup", groupId: g.id }], "agent");
				if (!truth.groupById(g.id)?.folded) {
					restored.push({ code, kind: "text", label: `group · ${g.memberIds.length} blocks`, ids: g.memberIds.slice() });
					hit = true;
				}
			}
		}
		// Mirror EXACTLY the set the wire serialization folds: folded, a foldable kind, a durable id.
		const matches = truth.blocks.filter(
			(b) => truth.isFolded(b) && wireFoldable(b) && isDurableId(b.id) && agentReachable(truth, b) && foldCode(b.id) === code,
		);
		for (const b of matches) {
			const grp = truth.groupOf(b);
			const grpFolded = grp?.folded ?? false;
			if (grpFolded) truth.apply([{ kind: "unfoldGroup", groupId: grp!.id }], "agent");
			else truth.apply([{ kind: "unfold", ids: [b.id] }], "agent");
			const stillFolded = grpFolded ? (truth.groupById(grp!.id)?.folded ?? false) : truth.isFolded(b);
			if (stillFolded) continue;
			restored.push({ code, kind: b.kind, label: blockLabel(b), ids: grpFolded ? grp!.memberIds.slice() : [b.id] });
			hit = true;
		}
		if (!hit) missing.push(code);
	}
	return { restored, missing };
}

/**
 * Resolve an agent `recall` request against the Truth — a pure READ. Returns each matched folded
 * block's ORIGINAL full content (never the digest, never a mutation). Same match set as
 * `resolveUnfold` / the wire fold; a group returns its members' full text joined.
 */
export function resolveRecall(truth: Truth, codes: string[]): { restored: RecallContent[]; missing: string[] } {
	const restored: RecallContent[] = [];
	const missing: string[] = [];
	for (const code of codes) {
		let hit = false;
		for (const g of truth.groups) {
			if (g.folded && groupAgentReachable(truth, g) && foldCode(g.id) === code) {
				const text = g.memberIds
					.map((id) => truth.get(id)?.text ?? "")
					.filter((t) => t.length > 0)
					.join("\n\n");
				restored.push({ code, label: `group · ${g.memberIds.length} blocks`, text, ids: g.memberIds.slice() });
				hit = true;
			}
		}
		const matches = truth.blocks.filter(
			(b) => truth.isFolded(b) && wireFoldable(b) && isDurableId(b.id) && agentReachable(truth, b) && foldCode(b.id) === code,
		);
		for (const b of matches) {
			if (truth.groupOf(b)?.folded) continue; // the group branch already returns the whole range
			restored.push({ code, label: blockLabel(b), text: truth.get(b.id)?.text ?? b.text, ids: [b.id] });
			hit = true;
		}
		if (!hit) missing.push(code);
	}
	return { restored, missing };
}
