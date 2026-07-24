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
	/** Return blocks to live/open. Human ("you"): a sticky `unfolded` override. Agent ("agent"):
	 *  unfold a folded block, staying sticky (cannot downgrade a human pin; ADR 0005). Strategy
	 *  ("auto"): behaves EXACTLY like `auto` — clears its own `autoFolded`/`subst` and writes NO
	 *  standing override. A strategy `unfold` must never leave an `unfolded` override, or it would
	 *  wedge itself out of its own block: `canFold`/`opAuto` both refuse a non-null override, so the
	 *  strategy could never re-fold what it just opened. */
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
	/** The block's id is a POSITIONAL fallback (`m<i>:…`), not a durable content anchor, so the
	 *  wire (`computeFoldOps`) would silently drop the fold and ship full content — accepting it
	 *  would fork UI/accounting from what the model actually receives. Only enforced with a live
	 *  wire attached (`wireAttached`), mirroring the durability-aware group accounting. */
	| "non-durable"
	/** The block is inside a folded group; the group overlay owns it. */
	| "grouped"
	/** A group op's ids were not a valid contiguous, ungrouped, ≥1-member run. */
	| "invalid-group"
	/** A targeted block/group changed since the op's `baseRev` (optimistic-concurrency stale). */
	| "stale"
	/** The op was a no-op (e.g. restoring an already-live block). */
	| "noop"
	/** The command's source surface is not the current controller — READ-ONLY enforcement refused it
	 *  before it reached Truth (ADR 0024, single-controller). NEVER produced by `Truth.apply` itself;
	 *  synthesized only at the extension's command ingress for a non-controller surface's ops. */
	| "read-only";

/** One op's outcome. `applied` is true iff it changed state; `clamped` explains a refusal. */
export interface OpResult {
	op: Op;
	applied: boolean;
	clamped?: ClampReason;
	/** Human-readable detail for logs; for an applied `group` op, the created group's id. */
	detail?: string;
	/**
	 * Per-id outcomes for a MULTI-ID op (`fold`/`unfold`/`pin`/`unpin`/`auto`). Absent for the
	 * single-id / global ops (`replace`/`group`/`ungroup`/`foldGroup`/`unfoldGroup`/`resetAll`/
	 * `freeze`), which are all-or-nothing and keep single-outcome semantics. The batch-level
	 * `applied`/`clamped` stay exactly what existing callers (conductors, clamp-UX) read: `applied`
	 * is "did ANY id apply". `perId` exists so the replica-facing event forwards ONLY the ids that
	 * actually applied on the host — a batch like `fold [A,B]` where B clamped `stale` used to
	 * forward the WHOLE op to a baseRev-less replica, which then applied B (the host refused it) and
	 * folded a block the model got whole; both sides still bump `rev` by exactly one, so the rev
	 * assertion never catches it. See `wireEventFromTruthEvent`.
	 */
	perId?: { id: string; applied: boolean; reason?: ClampReason }[];
}

/** The result of one `apply` transaction: the post-transaction rev + per-op outcomes. */
export interface TxnResult {
	/** The Truth rev after this transaction (unchanged if nothing applied). */
	rev: number;
	results: OpResult[];
}

/**
 * Op kinds that are HOST-ONLY — issued solely by the host's own conductor-detach kill switch,
 * NEVER accepted from a wire client (a GUI `ops` command or a conductor `propose`). Today only
 * `freeze`: it transfers every strategy-owned fold to the human WITHOUT the `human-steering` gate
 * (deliberately ungated — see the `freeze` Op doc above + `Truth.opFreeze`), so a wire client that
 * smuggled it in would seize a conductor's folds while the conductor still holds the lock — a
 * reachable bypass of a host-only privilege. Stripped at every wire entry point via
 * `applyGuardingHostOnly`. The host's own detach path calls `Truth.apply([{freeze}], …)` directly
 * and never routes through a wire entry point, so the kill switch itself is unaffected.
 */
export const HOST_ONLY_OP_KINDS: ReadonlySet<Op["kind"]> = new Set<Op["kind"]>(["freeze"]);

/**
 * True iff `op` is host-only and must be refused when it arrives from a wire client. Shape-safe:
 * an authorized-but-buggy client can send `ops:[null]` / a non-object, and this runs on the wire
 * ingress path — a raw `op.kind` deref would throw out of the WS callback and can kill the
 * extension process (a non-object is simply "not host-only", and gets caught by `isValidOp` next).
 */
export function isHostOnlyOp(op: unknown): boolean {
	return !!op && typeof op === "object" && HOST_ONLY_OP_KINDS.has((op as { kind?: unknown }).kind as Op["kind"]);
}

/** Every valid `Op` kind — the structural gate below vets an unknown value against exactly these. */
const OP_KINDS: ReadonlySet<string> = new Set<Op["kind"]>([
	"fold", "unfold", "pin", "unpin", "auto", "replace", "group", "ungroup", "foldGroup", "unfoldGroup", "resetAll", "freeze",
]);

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Structural validity of ONE op arriving from a WIRE CLIENT (a GUI `ops` command or a conductor
 * `propose`). `isServerMessage`/`isClientMessage` vet only the message `type` tag — an authorized
 * peer may still send a malformed `ops` array (`[null]`, a bad `kind`, non-string ids). Handing
 * that to `Truth.apply` dereferences `op.kind` inside `applyOne`'s switch and THROWS out of the WS
 * callback, which can take down the extension process. This is the shape gate the extension's
 * ingress runs FIRST, before `applyGuardingHostOnly`/`Truth.apply`, so a malformed op is dropped,
 * never thrown on.
 *
 * Ops carry NO numeric fields (only ids / content / kind), so there is nothing to range-check here;
 * the finite-number checks live in `sanitizeCommand` (protocol.ts), which guards the `setBudget`/
 * `setProtect` dial values.
 */
export function isValidOp(op: unknown): op is Op {
	if (!op || typeof op !== "object") return false;
	const o = op as Record<string, unknown>;
	if (typeof o.kind !== "string" || !OP_KINDS.has(o.kind)) return false;
	switch (o.kind) {
		case "fold":
			return isStringArray(o.ids) && (o.digest === undefined || typeof o.digest === "string");
		case "unfold":
		case "pin":
		case "unpin":
		case "auto":
			return isStringArray(o.ids);
		case "group":
			return isStringArray(o.ids) && (o.summary === undefined || o.summary === null || typeof o.summary === "string");
		case "replace":
			return typeof o.id === "string" && typeof o.content === "string" && (o.recoverable === undefined || typeof o.recoverable === "boolean");
		case "ungroup":
		case "foldGroup":
		case "unfoldGroup":
			return typeof o.groupId === "string";
		case "resetAll":
		case "freeze":
			return true;
		default:
			return false;
	}
}

/**
 * Sanitize an `ops` payload of unknown shape into a well-formed `Op[]`, dropping any structurally
 * invalid element (`isValidOp`). Returns `null` when the payload is not even an array (the caller
 * should ignore the whole command). An empty array back means "every element was invalid" —
 * distinct from `null` (not an array at all). Additive primitive for the extension's WS ingress;
 * nothing on this branch wires it yet (Wave 2).
 */
export function sanitizeOps(ops: unknown): Op[] | null {
	if (!Array.isArray(ops)) return null;
	return ops.filter(isValidOp);
}

/**
 * Apply a batch of ops that arrived from a WIRE CLIENT (a GUI `ops` command or a conductor
 * `propose`), refusing any host-only op (`freeze`) at the entry point instead of handing it to
 * `Truth.apply`. A refused op is reported honestly as a `locked` clamp in the returned
 * `TxnResult.results`, in its ORIGINAL op position — the client sees exactly which op was refused
 * and why, never a silent drop. The surviving (allowed) ops are applied through `apply` (the
 * caller's closure over `Truth.apply(allowed, by, baseRev)`) and their per-op results are threaded
 * back into place; the returned `rev` is the real post-apply rev. When no op is host-only this is a
 * straight pass-through (no array churn).
 */
export function applyGuardingHostOnly(ops: Op[], apply: (allowed: Op[]) => TxnResult): TxnResult {
	if (!ops.some(isHostOnlyOp)) return apply(ops);
	const allowed = ops.filter((op) => !isHostOnlyOp(op));
	const inner = apply(allowed);
	const results: OpResult[] = [];
	let ai = 0;
	for (const op of ops) {
		if (isHostOnlyOp(op)) results.push({ op, applied: false, clamped: "locked", detail: "host-only op refused at wire entry" });
		else results.push(inner.results[ai++]);
	}
	return { rev: inner.rev, results };
}

export type { Actor };
