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

/** The three steering controls a conductor may take exclusive control of (ADR 0011). */
export type LockName = "human-steering" | "agent-unfold" | "tail-size";

/** All lockable controls, in canonical order (for UIs that render the lock table). */
export const LOCK_NAMES: readonly LockName[] = ["human-steering", "agent-unfold", "tail-size"];

/** JSON-shaped telemetry payloads a conductor may attach to display-only status. */
export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

/** True if `locks` claims `name`. The single predicate the host/UI use to test a lock. */
export function hasLock(locks: readonly LockName[] | undefined, name: LockName): boolean {
	return !!locks && locks.includes(name);
}

/** True if `locks` declares any lock at all (exclusive vs collaborative). */
export function isExclusive(locks: readonly LockName[] | undefined): boolean {
	return !!locks && locks.length > 0;
}

/** One block as every conductor sees it — pure serializable data, identical in-process and on the wire. */
export interface ViewBlock {
	id: string;
	/** Stable provider-message grouping key. Blocks with the same key snap together in groups. */
	messageKey?: string;
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
 *
 * `digest` controls the summary text the host uses for this group:
 *   - `undefined` → the host's default recap summary (`groupDigest`). Byte-identical to
 *     today's behavior — existing conductors are unaffected.
 *   - `null` OR `""` → **DROP**: the run is removed from the wire, and NO replacement
 *     message is inserted. The agent never sees those blocks. This is the second deliberate
 *     exception to the "content substitution, never structural removal" rule stated in this
 *     file's header (the first being the existing group→summary removal); like that exception
 *     it is whole-message, pair-balanced, and re-derived defensively on the wire.
 *   - A non-empty string → that exact string is used as the summary verbatim, like
 *     `FoldCommand.digest` (no tag added).
 */
export interface GroupCommand {
	kind: "group";
	ids: string[];
	digest?: string | null;
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
	/** A group command's ids were not a valid contiguous, ungrouped, ≥1-member run. */
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

// ─── Host capabilities ────────────────────────────────────────────────────────

/**
 * The set of optional services the host MAY offer to a conductor. Not all hosts support
 * all capabilities: a headless test harness might omit "complete"; a read-only transcript
 * viewer has no live model link. Always call `host.can(id)` before depending on one.
 *
 *  - "complete"     — run an out-of-band model completion (requires a live session model).
 *  - "countTokens"  — synchronous token estimate using the host's tokenizer.
 *  - "digest"       — the engine's per-kind folded digest for a known block id.
 *  - "compress"     — extractive prose compression (e.g. Bear-2) of a single block of text.
 */
export type HostCapabilityId = "complete" | "countTokens" | "digest" | "compress";

/**
 * A provider-agnostic request to the host to run a model completion off to the side.
 * This is NEVER on the `conduct()` hot path — it is fire-and-forget from the conductor's
 * perspective: kick it off, stash the result in instance state when it resolves, call
 * `host.requestRerun()` to trigger a fresh `conduct()` pass that emits the commands.
 */
export interface CompletionRequest {
	/** Optional system instruction — e.g. a compaction template or persona. */
	system?: string;
	/** The user-role content to operate on — e.g. aged context blocks to summarize. */
	prompt: string;
	/**
	 * Soft cap on the number of output tokens. The host may silently clamp this to its
	 * own ceiling (model limits, safety margins). Omit to use the host default.
	 */
	maxOutputTokens?: number;
	/**
	 * Abort signal the host will fire if the in-flight call should be cancelled (e.g.
	 * because the conductor is being detached or swapped). The conductor should hold a
	 * reference to an `AbortController`, pass its `signal` here, and call
	 * `controller.abort()` from `detach()` so stale completions do not race back.
	 */
	signal?: AbortSignal;
	/**
	 * Which model to use. `"current"` (the default, applied when omitted) means "whatever
	 * model the user's live session is running" — this is the ONLY value honored in this
	 * version. A specific model id string is RESERVED for future use and is not yet plumbed
	 * through the wire; it is currently treated as `"current"` rather than selecting a
	 * different model.
	 */
	model?: "current" | string;
}

/** The fulfilled result of a `CompletionRequest`. */
export interface CompletionResult {
	/** The model's full text output. */
	text: string;
	/** The model id that actually ran (resolved from `request.model`). */
	model: string;
	/**
	 * Host-counted input token usage for this call, when the host can supply it.
	 * Conductors that want to budget their own model calls can use this to track spend.
	 */
	inputTokens?: number;
	/** Host-counted output token usage for this call, when available. */
	outputTokens?: number;
}

/**
 * Host services available to an in-process conductor. The object is deliberately tiny and
 * dependency-free so the contract remains importable everywhere the wire contract is used.
 *
 * The async pattern: `conduct(view)` is and MUST remain synchronous. A conductor that
 * needs model work starts `host.complete(req)` in the background, returns `null` to hold
 * its previous state, stores the completion result on its instance when it resolves, then
 * calls `host.requestRerun()` so the host re-enters `conduct()` on a later microtask.
 *
 * `requestRerun()` captures the conductor/epoch that received this host handle; stale
 * calls from a detached conductor are ignored.
 */
export interface ConductorHost {
	/** Is `capability` available right now? */
	can(capability: HostCapabilityId): boolean;
	/** Run an out-of-band model completion asynchronously; reject if unavailable. */
	complete(req: CompletionRequest): Promise<CompletionResult>;
	/**
	 * Optional extractive-compression capability (e.g. The Token Company's Bear-2). Returns
	 * a subsequence-compressed version of `text`: a small classifier deletes low-signal tokens,
	 * so the output is shorter prose the agent can still read directly. Deterministic for a
	 * given input. Implemented app-side (Tauri HTTP), NOT on the pi wire — so it is only
	 * present in the desktop app with an API key configured. Always gate calls on
	 * `can("compress")`; the promise rejects if the capability is unavailable or the upstream
	 * call fails. The aggressiveness level is fixed by the host implementation (not a parameter
	 * here), keeping this surface minimal.
	 */
	compress?(text: string): Promise<string>;
	/** Synchronous token estimate for `text`, using the host's tokenizer. */
	countTokens(text: string): number;
	/** The engine's per-kind folded digest for block `id`, or `null` if unknown. */
	digestOf(id: string): string | null;
	/** Surface display-only conductor status to the human; `null`/empty clears it. */
	setStatus(text: string | null, metrics?: Record<string, number | string | boolean>, details?: JSONValue): void;
	/** Ask the host to re-run `conduct()` after async work completes. */
	requestRerun(): void;
}

/**
 * A context-management strategy. The built-in folder is one; a remote WebSocket
 * conductor is wrapped in another. The host calls `conduct()` whenever the context
 * changes (a block streamed in, the budget moved, the protect tail resized).
 *
 * Return value:
 *  - `Command[]` — the conductor's complete desired state; the host resets to baseline
 *    and applies it.
 *  - `[]` — explicitly clear to raw (nothing folded).
 *  - `null` — "hold": the host reuses the last non-null command batch. It still rebuilds
 *    from baseline and re-enforces invariants, so new blocks not named in that batch arrive
 *    raw. Used by an async conductor that is still thinking; it must never block a model call.
 *
 * `conduct()` MUST be synchronous and side-effect-free with respect to the view.
 * In-process conductors can use `attach(host)` / `detach()` and `host.requestRerun()`
 * for async work; out-of-process conductors do the same through a synchronous runner
 * (see `RemoteRunner` in the live layer).
 */
export interface Conductor {
	/** Stable identifier, e.g. "builtin" or a remote session id. Drives actor attribution. */
	readonly id: string;
	/** Human-facing label for the switcher UI. */
	readonly label: string;
	/**
	 * Involvement locks (ADR 0011): the steering controls this conductor takes EXCLUSIVE
	 * control of. Undefined / empty ⇒ **collaborative** (the default — human and agent
	 * overrides always win, today's behavior). A non-empty subset ⇒ **exclusive**: the host
	 * gates the named controls from the human/agent, the human's only recourse is detach
	 * (the kill switch), and `tail-size` hands the conductor ownership of the protected tail —
	 * it declares the tail size via `tailTokens` (`0` ⇒ no tail, may fold any block; `> 0` ⇒
	 * folds inside its own declared tail are still refused `protected`).
	 * Never includes observation, budget, the agent's `recall`, or detach — those are sacred.
	 */
	readonly locks?: readonly LockName[];
	/**
	 * How much tail the conductor wants while holding the `tail-size` lock (ADR 0011).
	 * Semantics parallel the human's `protectTokens`: a token target driving the same
	 * walk-back algorithm. **0 (or omitted) = "own the whole context, no protected tail"**
	 * — every block arrives with `protected: false`, and the conductor may fold freely into
	 * recent reasoning (today's tail-size behavior). **N > 0 = "protect the newest ~N tokens
	 * of tail"** — the host's walk-back algorithm protects the newest blocks summing to N
	 * tokens (same 25% overflow cap as the human's tail), so those blocks arrive with
	 * `protected: true` and the conductor folds only older content. Ignored entirely if the
	 * conductor does not hold the `tail-size` lock. Remote conductors (WebSocket) always read
	 * as 0 (whole-context ownership); remote-wire `tailTokens` support is a follow-up.
	 */
	readonly tailTokens?: number;
	/**
	 * Optional lifecycle hook for in-process conductors that need host services. Called when
	 * the store attaches this conductor, before the first `conduct()` pass. Synchronous
	 * conductors can ignore it.
	 */
	attach?(host: ConductorHost): void;
	/**
	 * Optional lifecycle hook called when the store detaches or replaces this conductor.
	 * A conductor that kicks off `host.complete()` calls should cancel them here (e.g. via
	 * the `AbortSignal` it passed in `CompletionRequest.signal`) so stale completions do not
	 * call `host.requestRerun()` after the conductor is gone.
	 */
	detach?(): void;
	conduct(view: ConductorView): Command[] | null;
}
