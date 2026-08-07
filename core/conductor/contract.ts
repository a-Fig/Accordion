/*
 * contract.ts — the FROZEN conductor-v2 contract.
 *
 * A conductor is an async RESIDENT context-management strategy: it attaches to a host, subscribes
 * to events, and proposes diff-op transactions. This is the surface OTHER agents build conductor
 * implementations against, in parallel with the rest of Phase A — every member here is stable and
 * documented. Deviations need the coordinator's sign-off.
 *
 * The host is authoritative over the Truth; a conductor only ever PROPOSES (`host.propose`) and is
 * clamped. It observes through `host.on(...)` (HostEvents) and reads through the host's queries.
 *
 * Framework-free: plain TypeScript, no Svelte, no runtime deps. The same contract is honored by
 * the app-side host (local, read-only browsing) and the extension-side host (authoritative, live).
 */
import type { LockName } from "../locks";
import type { Actor } from "../types";
import type { Op, TxnResult } from "../ops";
import type { TruthStats } from "../truth";

export type { LockName, Op, TxnResult, TruthStats, Actor };

/** JSON-shaped telemetry payloads a conductor may attach to display-only status. */
export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

/**
 * One block as every conductor sees it — pure serializable data, identical in-process and (in
 * Phase B) on the wire. This is the old contract's `ViewBlock` plus `sent`.
 */
export interface ViewBlock {
	id: string;
	/** Stable provider-message grouping key. Blocks with the same key snap together in groups. */
	messageKey?: string;
	kind: "user" | "text" | "thinking" | "tool_call" | "tool_result";
	turn: number;
	order: number;
	/** Full token cost. */
	tokens: number;
	/** Token cost if folded — the digest/subst size for a foldable kind, else full tokens. */
	foldedTokens: number;
	toolName?: string;
	callId?: string;
	isError?: boolean;
	/** A human override (pin / manual fold / manual unfold) owns this block. */
	held: boolean;
	/** Currently rendered folded in the view. */
	folded: boolean;
	/** Inside the protected working tail. */
	protected: boolean;
	/** Member of a folded group (the host owns it). */
	grouped: boolean;
	/**
	 * Has this block's content already crossed the wire to the model in an applied plan? A block
	 * that has never been sent whole is birth-fold-eligible (a strategy may fold it even inside the
	 * protected tail — there is nothing to yank). ADR 0018's `fresh`, inverted.
	 */
	sent: boolean;
	/** Full content (always present in-process). */
	text?: string;
	/** One-line taste (present when the host serves shape-only). */
	preview?: string;
}

/**
 * A single provenance-tagged change to the standing view. Delivered in `state-changed` so a
 * conductor can react to human/agent edits (e.g. veto graduation when the agent has been reaching
 * back into a block).
 */
export interface StateChange {
	id?: string;
	groupId?: string;
	what: "fold" | "unfold" | "pin" | "unpin" | "group" | "ungroup" | "replace" | "protect" | "budget" | "recall";
	by: Actor;
}

/**
 * One folded/foldable multiblock group as every conductor sees it — the group-enumeration
 * counterpart of `ViewBlock`/`blocks()`. `by` is provenance (who created the group); `summary`
 * mirrors the group op's own digest-override contract (`undefined` → default recap, `null`/`""` →
 * dropped from the wire, a non-empty string → verbatim).
 */
export interface GroupInfo {
	id: string;
	memberIds: readonly string[];
	folded: boolean;
	by: Actor | null;
	summary?: string | null;
}

/**
 * Events the host pushes to a subscribed conductor. A conductor reacts asynchronously and proposes
 * transactions; it never blocks a model call.
 */
export type HostEvent =
	/** New blocks entered the log. */
	| { type: "blocks-appended"; blocks: readonly ViewBlock[]; rev: number; liveTokens: number; budget: number }
	/** A turn settled — the canonical re-plan trigger for turn-based strategies. */
	| { type: "turn-committed"; turn: number; rev: number }
	/** A human/agent edit changed the standing view (provenance included). */
	| { type: "state-changed"; changes: readonly StateChange[]; rev: number }
	/** The wire is about to depart to the model. A strategy that declares `holdWireUpToMs > 0` may
	 *  propose a last-moment fold; `freshIds` are blocks never yet sent whole. `holdId` (v14,
	 *  optional/additive) uniquely tags this hold — the host mints it and, on the REMOTE seam, the SDK
	 *  echoes it in `holdRelease` when the handler settles; an in-process host resolves on handler
	 *  settle regardless, so the field is informational there. Absent (e.g. `TestHost.departWire`,
	 *  which resolves purely on the returned promise) means the host isn't using id correlation. */
	| { type: "wire-departing"; rev: number; liveTokens: number; budget: number; freshIds: readonly string[]; holdId?: number }
	/** The host state was rebuilt (structural reset / reconnect); rebuild any tracked desired state. */
	| { type: "resync"; rev: number };

/**
 * A provider-agnostic request to run a model completion off to the side. Never on any hot path:
 * the conductor awaits it, stashes the result, and re-runs its pass to emit the derived ops.
 */
export interface CompletionRequest {
	/** Optional system instruction — e.g. a compaction template or persona. */
	system?: string;
	/** The user-role content to operate on — e.g. aged context blocks to summarize. */
	prompt: string;
	/** Soft cap on output tokens; the host may clamp to its own ceiling. Omit for the host default. */
	maxOutputTokens?: number;
	/** Abort signal the host fires if the in-flight call should be cancelled (detach / swap). */
	signal?: AbortSignal;
	/** Which model to use. `"current"` (default) = the live session's model — the only honored value. */
	model?: "current" | string;
}

/** The fulfilled result of a `CompletionRequest`. */
export interface CompletionResult {
	/** The model's full text output. */
	text: string;
	/** The model id that actually ran (resolved from `request.model`). */
	model: string;
	/** Host-counted input token usage, when available. */
	inputTokens?: number;
	/** Host-counted output token usage, when available. */
	outputTokens?: number;
}

/**
 * Host services available to a resident conductor. Tiny and dependency-free. Unlike the old
 * contract there is no `can(capability)`: the authoritative host (the extension) always has a live
 * model, so a conductor treats a REJECTED/failed `complete()` promise as the "unavailable" path.
 */
export interface ConductorHost {
	/** Subscribe to host events. Returns an unsubscribe. The handler may be async. */
	on(fn: (e: HostEvent) => void | Promise<void>): () => void;
	/** Read one block as a ViewBlock, or undefined if unknown. */
	get(id: string): ViewBlock | undefined;
	/** Every block, in conversation order. */
	blocks(): readonly ViewBlock[];
	/** Every group, in creation order. The group-enumeration counterpart of `blocks()`. */
	groups(): readonly GroupInfo[];
	/** The full original text of a block (never the folded substitution), or null if unknown. */
	textOf(id: string): string | null;
	/** Aggregate readout of the current state. */
	stats(): TruthStats;
	/** Synchronous token estimate using the host's tokenizer. */
	countTokens(text: string): number;
	/** The engine's per-kind folded digest for block `id`, or null if unknown. */
	digestOf(id: string): string | null;
	/** Run an out-of-band model completion. Rejects if the model is unavailable or the call fails. */
	complete(req: CompletionRequest): Promise<CompletionResult>;
	/** Surface display-only conductor status to the human; `null`/empty clears it. */
	setStatus(text: string | null, metrics?: Record<string, number | string | boolean>): void;
	/**
	 * Propose a transaction against `baseRev`; the host clamps and returns per-op results.
	 * Async by contract (async-by-default is this contract's philosophy, and out-of-process
	 * hosts are a mandate): an IN-PROCESS host applies the ops synchronously the instant `propose`
	 * is invoked and resolves the `TxnResult` on a microtask; an OUT-OF-PROCESS host resolves it
	 * after the `propose`→`proposeResult` wire round trip. Every caller `await`s it.
	 */
	propose(txn: { baseRev: number; ops: Op[] }): Promise<TxnResult>;
}

/**
 * A context-management strategy. The host `attach`es it (handing over the host services), pushes
 * events, and `detach`es it on swap/teardown. Everything is additive: a conductor that locks
 * nothing is collaborative (today's behavior); a non-empty `locks` set is exclusive (ADR 0011).
 */
export interface Conductor {
	/** Stable identifier — drives actor attribution and the switcher UI. */
	readonly id: string;
	/** Human-facing label for the switcher UI. */
	readonly label: string;
	/** Optional one-line description of the strategy. */
	readonly description?: string;
	/** Involvement locks this conductor claims (ADR 0011). Undefined/empty ⇒ collaborative. */
	readonly locks?: readonly LockName[];
	/** Tail target while holding `tail-size` (0/omitted ⇒ own the whole context). */
	readonly tailTokens?: number;
	/** Max time the host may hold the departing wire for a last-moment proposal. Default 0. */
	readonly holdWireUpToMs?: number;
	/** Called once when the host attaches this conductor, before any event fires. */
	attach(host: ConductorHost): void;
	/** Called when the host detaches/replaces this conductor. Cancel in-flight completions here. */
	detach(): void;
}
