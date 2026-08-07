/*
 * ops.ts — the FROZEN Op vocabulary + clamp/txn result shapes.
 *
 * `Truth.apply(ops, by, baseRev?)` is the single write path for every overlay mutation —
 * human, agent, and strategy alike. An `Op` is a declarative request; `Truth` applies it
 * atomically-per-op with clamping, never throwing on bad input, and returns one `OpResult`
 * per op describing exactly what happened.
 *
 * The `by: Actor` argument to `apply` (NOT carried on the op) decides authority:
 *   • "you"   — a human hand action. Sets `override`; gated by the `human-steering` lock.
 *   • "agent" — the live agent's `unfold` tool. Gated by the `agent-unfold` lock.
 *   • "auto"  — an attached context strategy. Sets `autoFolded`/`subst`, leaves `override`
 *     null, and is clamped by any human override (never the reverse).
 */
import type { Actor } from "./types";

export type Op =
	/** Collapse blocks to a digest. `digest` (a verbatim string) overrides the engine's
	 *  per-kind digest; omit it to use the engine digest. A human fold sets `override:"folded"`;
	 *  a strategy fold (by:"auto") sets `autoFolded` and leaves `override` null. */
	| { kind: "fold"; ids: string[]; digest?: string }
	/** Return blocks to live/open. Human: a sticky `unfolded` override. Agent: unfold a folded
	 *  block (cannot downgrade a human pin). */
	| { kind: "unfold"; ids: string[] }
	/** Human hard pin — locked full, never auto-folds. */
	| { kind: "pin"; ids: string[] }
	/** Remove a hard pin. */
	| { kind: "unpin"; ids: string[] }
	/** Clear the caller's fold contribution and hand the block back to the strategy. A human
	 *  `auto` clears a human override; a strategy `auto` clears its own `autoFolded`/`subst`
	 *  (refused if a human override owns the block). */
	| { kind: "auto"; ids: string[] }
	/** Substitute a block's content with arbitrary text (strategy-only). `content:""` folds to
	 *  the engine digest. `recoverable` (default true) prepends the `{#code FOLDED}` tag so the
	 *  agent can unfold/recall the original; `false` = verbatim, non-recoverable. */
	| { kind: "replace"; id: string; content: string; recoverable?: boolean }
	/** Collapse a contiguous run into ONE summary entry (snapped to whole messages).
	 *  `summary` undefined/absent → the engine's default recap (tagged); `null`/`""` → DROP
	 *  (no wire message); a non-empty string → that exact summary verbatim (no tag). */
	| { kind: "group"; ids: string[]; summary?: string | null }
	/** Delete a group (members return to their own fold state). */
	| { kind: "ungroup"; groupId: string }
	/** Collapse an existing (open) group. */
	| { kind: "foldGroup"; groupId: string }
	/** Expand a folded group. */
	| { kind: "unfoldGroup"; groupId: string }
	/** Clear every override + strategy fold AND dissolve every group — back to raw. */
	| { kind: "resetAll" }
	/** Conductor-detach kill switch (Phase C). Host-only — issued on conductor detach BEFORE
	 *  `clearLocks()`, never from a human click. Converts every currently strategy-owned fold
	 *  (`autoFolded === true`, `override === null`, not inside a folded group) into a
	 *  human-owned fold (`override:"folded"`, `by:"you"`), preserving `subst` byte-identical —
	 *  the point is that the conductor's substituted digest survives the ownership transfer.
	 *  Every currently FOLDED group with `by === "auto"` is reassigned `by:"you"`. Idempotent
	 *  (a second freeze is a no-op). Deliberately never gated by `isLocked("human-steering")`:
	 *  it runs precisely while the conductor's lock is still held, immediately before release. */
	| { kind: "freeze" };

/** Why an op could not be applied verbatim. Never thrown — always reported. */
export type ClampReason =
	/** No block/group with that id exists. */
	| "unknown-id"
	/** A human override owns the block; a strategy op cannot beat it. */
	| "human-override"
	/** An involvement lock refuses this actor's action (human-steering / agent-unfold). */
	| "locked"
	/** The block is inside the protected working tail (and not birth-fold-eligible). */
	| "protected"
	/** The block's KIND is not foldable on the wire (user / tool_call). */
	| "not-foldable"
	/** The block is inside a folded group; the group overlay owns it. */
	| "grouped"
	/** A group op's ids were not a valid contiguous, ungrouped, ≥1-member run. */
	| "invalid-group"
	/** A targeted block/group changed since the op's `baseRev` (optimistic-concurrency stale). */
	| "stale"
	/** The op was a no-op (e.g. restoring an already-live block). */
	| "noop";

/** One op's outcome. `applied` is true iff it changed state; `clamped` explains a refusal. */
export interface OpResult {
	op: Op;
	applied: boolean;
	clamped?: ClampReason;
	/** Human-readable detail for logs; for an applied `group` op, the created group's id. */
	detail?: string;
}

/** The result of one `apply` transaction: the post-transaction rev + per-op outcomes. */
export interface TxnResult {
	/** The Truth rev after this transaction (unchanged if nothing applied). */
	rev: number;
	results: OpResult[];
}

/** Convenience: did any op in the transaction actually change state? */
export function anyApplied(r: TxnResult): boolean {
	return r.results.some((x) => x.applied);
}

export type { Actor };
