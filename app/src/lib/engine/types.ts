/*
 * types.ts — the shared vocabulary of the engine.
 *
 * The atomic unit is a BLOCK: a typed slice of a single message. One assistant
 * message explodes into several blocks (its thinking, its reply text, each tool
 * call). A tool call and the tool result that answers it are SEPARATE blocks —
 * they are shown together but fold independently, because their value to the
 * agent decays at very different rates. See VISION.md.
 */

export type BlockKind =
	| "user" // the human's instruction/intent — highest durable value
	| "text" // an assistant reply / conclusion
	| "thinking" // ephemeral assistant reasoning
	| "tool_call" // WHAT the agent did (tiny, durable record of an action)
	| "tool_result"; // WHAT the agent saw (often huge, decays fast)

/** Who last changed a block's fold state. */
export type Actor = "you" | "agent" | "auto" | "conductor";

/**
 * A manual override that the automatic folder must respect:
 *  - "pinned"   — locked full; never auto-folds (a protection on top of Full).
 *  - "folded"   — force-folded by hand; stays folded regardless of budget.
 *  - "unfolded" — held open by hand; protected from auto-fold but not a hard pin.
 *  - null       — handed to the automatic folder.
 */
export type Override = "pinned" | "folded" | "unfolded" | null;

export interface Block {
	/** Stable, unique id derived from the source message id + position. */
	id: string;
	kind: BlockKind;
	/** 1-based index of the user turn this block belongs to (0 = preamble). */
	turn: number;
	/** Global 0-based position in the conversation. */
	order: number;
	/** Full, normalized text content. Never mutated by folding. */
	text: string;
	/** Estimated token cost at full fidelity. */
	tokens: number;
	/** Tool name, for tool_call / tool_result blocks. */
	toolName?: string;
	/**
	 * Pairing key. For a tool_call it is the call's own id; for a tool_result it
	 * is the id of the call it answers. This is the provider-safety invariant: a
	 * folded result keeps this id, and a call may never be dropped while a result
	 * still references it.
	 */
	callId?: string;
	/** Model that produced an assistant block, if known. */
	model?: string;
	isError?: boolean;

	// --- mutable, reactive state -------------------------------------------
	override: Override;
	/** Set by the automatic folder; only meaningful when override is null. */
	autoFolded: boolean;
	/** Who last touched this block's fold state. */
	by: Actor | null;
	/**
	 * Conductor-substituted content (ADR 0007). When set, this is exactly what a folded
	 * block renders / the agent receives — the conductor's own digest or replacement
	 * (`""` = the "delete" form: emptied but kept in place). Distinct from `override`,
	 * which stays the HUMAN's alone: a conductor never writes `override`, only `subst`
	 * (+ `autoFolded`). Cleared to baseline on every conductor pass for `override === null`
	 * blocks. Absent → a folded block falls back to the engine's per-kind `digest()`.
	 */
	subst?: string;
}

/**
 * A multiblock fold (ADR 0006). A group is an ENGINE OVERLAY, never a `Block`: it
 * references a CONTIGUOUS, non-overlapping run of member blocks (by id) that the human
 * collapses into a single tile. `folded` is the group's own state, orthogonal to each
 * member's per-block override — folding the group collapses the range; unfolding it
 * returns the members to their own fold state. The id is `g:<firstMemberDurableId>`; its
 * agent-unfold handle is `foldCode(id)`. Invariants (enforced at creation, store.createGroup):
 * contiguous · non-overlapping · flat (members are blocks, never groups) · ≥1 member
 * (relaxed from ≥2 so a lone block can be dropped/summarized — must still collapse at least
 * one member, i.e. not be all-stragglers) · entirely older than the protected tail.
 * `memberIds` is in conversation (block) order.
 *
 * `by` is provenance: who created the group. A HUMAN group (`by:"you"`) is durable — it
 * survives every conductor pass untouched. A conductor/auto group (`by:"auto"`/`"conductor"`,
 * or absent) is owned by the active strategy: it is cleared at the start of each conductor
 * pass and rebuilt from that pass's `group` commands, so a conductor that stops asking for a
 * group (returns `[]`, or is detached) no longer strands it folded. Optional only so legacy /
 * test-constructed literals stay valid; `createGroup` always sets it (default `"you"`).
 */
export interface Group {
	id: string;
	memberIds: string[];
	folded: boolean;
	/**
	 * Who created this group. `"you"` or absent ⇒ preserved (treated as human/legacy): never
	 * touched by a conductor pass. `"auto"` or `"conductor"` ⇒ conductor-owned: cleared at the
	 * start of each conductor pass (`clearConductorState`) and rebuilt from that pass's `group`
	 * commands, so a group the conductor stops asking for is not left stranded. `createGroup`
	 * always sets it (default `"you"`).
	 */
	by?: Actor;
	/**
	 * Conductor-supplied summary override (mirrors `GroupCommand.digest`):
	 *   - `undefined` → default recap via `groupDigest` (unchanged behavior).
	 *   - `null` or `""` → DROP: the run is removed from the wire, no message inserted.
	 *   - Non-empty string → that exact string is used as the summary verbatim.
	 */
	digest?: string | null;
}

export interface SessionMeta {
	format: "pi" | "claude" | "unknown";
	title: string;
	cwd: string;
	model: string;
}

export interface ParsedSession {
	meta: SessionMeta;
	blocks: Block[];
	/** Diagnostics. */
	lineCount: number;
	skipped: number;
}
