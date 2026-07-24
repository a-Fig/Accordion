/*
 * types.ts — the shared vocabulary of the engine.
 *
 * The atomic unit is a BLOCK: a typed slice of a single message. One assistant
 * message explodes into several blocks (its thinking, its reply text, each tool
 * call). A tool call and the tool result that answers it are SEPARATE blocks —
 * they are shown together but fold independently, because their value to the
 * agent decays at very different rates. See VISION.md.
 *
 * Part of the framework-free `core/` package — the single source of truth for
 * Accordion's canonical context state. The same `Block`/`Group` shapes flow
 * through the app (local, read-only browsing) and the extension (authoritative,
 * live). No Svelte, no runes, no runtime dependencies.
 */

export type BlockKind =
	| "user" // the human's instruction/intent — highest durable value
	| "text" // an assistant reply / conclusion
	| "thinking" // ephemeral assistant reasoning
	| "tool_call" // WHAT the agent did (tiny, durable record of an action)
	| "tool_result"; // WHAT the agent saw (often huge, decays fast)

/**
 * Who last changed a block's fold state.
 *  - `"you"`   — a human hand action (sets `override`).
 *  - `"agent"` — the live agent's `unfold` tool (a sticky `unfolded` override).
 *  - `"auto"`  — an attached context strategy (a conductor). A strategy fold sets
 *    `autoFolded` / `subst` and leaves `override` null, so a human can always re-override
 *    and human overrides always beat strategy ops.
 */
export type Actor = "you" | "agent" | "auto";

/**
 * A manual override that the automatic folder must respect:
 *  - "pinned"   — locked full; never auto-folds (a protection on top of Full).
 *  - "folded"   — force-folded by hand; stays folded regardless of budget.
 *  - "unfolded" — held open by hand; protected from auto-fold but not a hard pin.
 *  - null       — handed to the automatic folder (the attached strategy).
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

	// --- mutable, reactive state (the OVERLAY) -----------------------------
	override: Override;
	/**
	 * Set by an attached context strategy (`by:"auto"`); only meaningful when `override` is
	 * null. A strategy fold sets this true (and leaves `override` null) so humans can always
	 * re-override; the map/transcript renderers and `isFolded` read it after `override`.
	 */
	autoFolded: boolean;
	/** Who last touched this block's fold state. */
	by: Actor | null;
	/**
	 * Strategy-substituted content (ADR 0007). When set, this is exactly what a folded block
	 * renders / the agent receives — the strategy's own summary or replacement (via a `replace`
	 * op). Distinct from `override`, which stays the HUMAN's alone: a strategy never writes
	 * `override`, only `subst` (+ `autoFolded`). Cleared to baseline when a human takes over the
	 * block or on `resetAll`. Absent → a folded block falls back to the engine's per-kind
	 * `digest()`.
	 */
	subst?: string;
}

/**
 * A multiblock fold (ADR 0006). A group is an ENGINE OVERLAY, never a `Block`: it
 * references a CONTIGUOUS, non-overlapping run of member blocks (by id) that a human (or a
 * strategy) collapses into a single tile. `folded` is the group's own state, orthogonal to
 * each member's per-block override — folding the group collapses the range; unfolding it
 * returns the members to their own fold state. The id is `g:<firstMemberDurableId>`; its
 * agent-unfold handle is `foldCode(id)`. Invariants (enforced at creation, Truth's group op):
 * contiguous · non-overlapping · flat (members are blocks, never groups) · ≥1 member
 * (relaxed from ≥2 so a lone block can be dropped/summarized — must still collapse at least
 * one member, i.e. not be all-stragglers) · entirely older than the protected tail.
 * `memberIds` is in conversation (block) order.
 *
 * `by` is provenance: who created the group (`"you"` human, `"auto"` a strategy). Optional
 * only so legacy / test-constructed literals stay valid; the group op always sets it.
 */
export interface Group {
	id: string;
	memberIds: string[];
	folded: boolean;
	/** Who created this group. Optional; the group op always sets it (default `"you"`). */
	by?: Actor;
	/**
	 * Optional summary override for the collapsed run:
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
