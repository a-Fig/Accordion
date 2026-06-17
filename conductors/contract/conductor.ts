/*
 * conductor.ts — the Accordion ↔ Conductor contract (ADR 0007).
 *
 * A "conductor" is an interchangeable context-management strategy. Conductors are
 * first-party — they ship in this repo (or a fork). The default is the built-in
 * auto-folder (`../builtin/builtin.ts`); anyone adds another — in-process (the main
 * way) or, as an escape hatch, over a WebSocket in any language — and it speaks the
 * SAME vocabulary, defined here. There is no third party and no trust boundary.
 *
 * The whole contract is the in-process shape of one pure idea:
 *
 *     conduct(view) → Command[]
 *
 * The host hands the conductor a read-only VIEW of the context; the conductor replies
 * with COMMANDS describing the context it wants. The host clamps those commands to the
 * one floor it enforces — provider-validity, "the message must always stay sendable" —
 * applies them, and reports back anything it had to clamp.
 *
 * The `ConductorView` below is the ONE public surface every conductor consumes — the
 * built-in folder included. It is pure, serializable data: identical in-process and on
 * the wire (`conductorProtocol.ts` carries the very same `ViewBlock`s). The built-in is
 * therefore the worked example, programmed against exactly the surface anyone else gets;
 * there is no privileged richer input. That is the whole point of this module.
 *
 * This module is deliberately dependency-free and runes-free — it imports NOTHING from
 * the engine, so the kind union is defined locally. It must be importable by the engine,
 * by the live wire layer, and — via the shared `conductorProtocol.ts` — by an
 * out-of-process conductor. Keep it that way: no Svelte, no `$state`, no Node/Tauri APIs.
 */

/** The block kinds, mirrored from the engine so this contract has zero engine dependency. */
export type ConductorBlockKind = "user" | "text" | "thinking" | "tool_call" | "tool_result";

/** One block as every conductor sees it — pure serializable data, identical in-process and on the wire. */
export interface ViewBlock {
	id: string;
	kind: ConductorBlockKind;
	turn: number;
	order: number;
	tokens: number; // full token cost
	foldedTokens: number; // token cost if folded — the digest size for a foldable kind, or full tokens for a non-foldable kind (which can't shrink) — so a conductor needn't compute it
	toolName?: string;
	callId?: string;
	isError?: boolean;
	held: boolean; // a human override (pin / manual fold / manual unfold) owns this block
	folded: boolean; // currently rendered folded in the view
	protected: boolean; // inside the protected working tail
	grouped: boolean; // member of a folded group (host owns it)
	text?: string; // full content (in-process, or wire wants:"full")
	preview?: string; // one-line taste (wire wants:"shape"/"onDemand")
}

/**
 * A read-only view of the context the conductor reasons over — the single public surface,
 * pure data. The host owns it; a conductor MUST treat everything here as immutable.
 *
 * `liveTokens` is the baseline the conductor folds down FROM: the host has already cleared
 * the previous conductor pass, so it reflects the human's overrides and any folded groups
 * but NO conductor folds. `protectedFromIndex`/`protectTokens` surface the host's protected
 * working tail as POLICY (the built-in treats it as a hard "don't fold past here" line; a
 * conductor may ignore it, but folding into the tail may be reverted by host healing).
 */
export interface ConductorView {
	/** Every block, in conversation order. The conductor's whole field of view. */
	blocks: ViewBlock[];
	/** Token budget for the live context window. */
	budget: number;
	/** The model's total context window as reported by the host, or null if unknown. */
	contextWindow: number | null;
	/** Live token cost at the moment the view is built — the baseline to fold down from. */
	liveTokens: number;
	/** Index of the first block in the host's protected working tail. `blocks.length` ⇒ no tail. */
	protectedFromIndex: number;
	/** The protected-tail token target driving `protectedFromIndex`. */
	protectTokens: number;
}

/**
 * The command vocabulary. Every command is CONTENT SUBSTITUTION, never structural
 * removal — a block is never spliced out of the conversation, only its content
 * changes. That single rule is what makes broken states unrepresentable: a
 * `tool_call`/`tool_result` pair can never orphan, because neither block can vanish.
 *
 * Commands accumulate into a persistent "current state". Each `conduct()` return is
 * the conductor's COMPLETE desired state (the host resets to baseline, then applies
 * the batch) — so to change one block a conductor re-sends its whole intention. The
 * imperative form is chosen so a conductor can also work declaratively internally and
 * emit a quick burst of commands to reach its target.
 */
export type Command =
	| FoldCommand
	| ReplaceCommand
	| GroupCommand
	| RestoreCommand
	| PinCommand;

/**
 * Collapse blocks to a digest. With no `digest`, the host uses its own per-kind digest
 * (and the agent-recoverable `{#code FOLDED}` tag). With a `digest`, that exact string
 * is what the view shows and the agent receives.
 */
export interface FoldCommand {
	kind: "fold";
	ids: string[];
	digest?: string;
}

/**
 * Substitute a block's content with arbitrary text the conductor chose. The block stays in
 * place (so its callId/pairing is intact). `content: ""` means "shrink to nothing": an empty
 * content part can't be sent to the provider, so the host folds the block to its standard
 * `{#code FOLDED}` digest (the smallest wire-safe form) — guaranteeing the view always matches
 * what the agent receives. Only `text`/`thinking`/`tool_result` fold; a `replace` on a
 * `user`/`tool_call` is clamped `not-foldable`.
 */
export interface ReplaceCommand {
	kind: "replace";
	id: string;
	content: string;
}

/**
 * Collapse a CONTIGUOUS run of blocks into a single summary entry (summary-on-head,
 * the rest emptied — never removed). The group covers the contiguous run from the FIRST
 * to the LAST named id, snapped outward to whole messages — so any blocks BETWEEN the
 * first and last id are swept into the group even if you did not name them, and a partly-
 * named message is rounded up to its whole. To collapse a non-contiguous set, issue
 * separate `group` commands per run, or `replace`/empty individual blocks instead.
 */
export interface GroupCommand {
	kind: "group";
	ids: string[];
}

/** Return blocks to full, live content (undo a fold/replace). No-op on human-held blocks. */
export interface RestoreCommand {
	kind: "restore";
	ids: string[];
}

/**
 * Assert that blocks should stay live and open. In the full-state model this is
 * usually implicit (anything not folded is live), but `pin` lets a conductor be
 * explicit — e.g. force a block live that an earlier command in the same batch folded.
 * It never overrides a human pin (that override is the human's alone).
 */
export interface PinCommand {
	kind: "pin";
	ids: string[];
}

/**
 * What the host did when a command could not be applied verbatim. Never thrown, never
 * silently dropped: the host clamps to the nearest safe form (or a no-op) and returns
 * one report per affected command so the conductor can learn and adapt.
 */
export interface ClampReport {
	/** The command kind that was clamped. */
	command: Command["kind"];
	/** The block id(s) involved, for correlation. */
	ids: string[];
	/** Machine-readable reason. */
	reason: ClampReason;
	/** Human-readable detail for logs. */
	detail: string;
}

export type ClampReason =
	/** No block with that id exists (vanished in a resync, or never existed). */
	| "unknown-id"
	/** A human override (pin / manual fold / manual unfold) owns this block; human wins. */
	| "human-override"
	/** The block is inside a folded group; the group overlay owns it. */
	| "grouped"
	/** A group command's ids were not a valid contiguous, ungrouped, ≥2-member run. */
	| "invalid-group"
	/** The block is inside the protected working tail; protection is absolute, the host won't fold it. */
	| "protected"
	/**
	 * The block's KIND is not foldable on the wire — only `text` / `thinking` / `tool_result`
	 * fold; `user` (intent) and `tool_call` (folding it would orphan its result) never do. A
	 * `fold`/`replace` targeting such a block is refused and reported, never silently applied
	 * (which would let the view show a fold the agent never actually receives).
	 */
	| "not-foldable"
	/** The op was a no-op (e.g. restoring an already-live block). */
	| "noop";

/**
 * A context-management strategy. The built-in folder is one; a remote WebSocket
 * conductor is wrapped in another. The host calls `conduct()` whenever the context
 * changes (a block streamed in, the budget moved, the protect tail resized).
 *
 * Return value:
 *  - `Command[]` — the conductor's complete desired state; the host resets to baseline
 *    and applies it.
 *  - `[]` — explicitly clear to raw (nothing folded).
 *  - `null` — "hold": the host keeps the last applied state untouched. Used by an
 *    async (remote) conductor that is still thinking; it must never block a model call.
 *
 * `conduct()` MUST be synchronous and side-effect-free with respect to the view.
 * An out-of-process conductor does its async work off to the side and feeds the result
 * back through a synchronous runner (see `RemoteRunner` in the live layer).
 */
export interface Conductor {
	/** Stable identifier, e.g. "builtin" or a remote session id. Drives actor attribution. */
	readonly id: string;
	/** Human-facing label for the switcher UI. */
	readonly label: string;
	conduct(view: ConductorView): Command[] | null;
}
