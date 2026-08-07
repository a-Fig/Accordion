/*
 * protocol.ts — the Phase-B wire contract between the pi extension and Accordion clients.
 *
 * Framework-free, dependency-free, types-only at runtime. Lives in `core/` so BOTH the
 * authoritative Truth host (the extension) and every replica client (the GUI) import ONE
 * definition and can never drift. `app/src/lib/live/protocol.ts` is a re-export shim.
 *
 * ── Phase B model (the truth moved into the extension) ──────────────────────────────
 * The extension hosts an authoritative `Truth` per session. pi's `context` hook is now a
 * LOCAL operation against that in-process Truth — there is no 250ms plan round trip. A
 * client is a REPLICA + remote control:
 *
 *   1. connect → `hello` (protocol version, session meta, accepted role).
 *   2. `snapshot` — full serialized state; the client builds a rev-aligned replica Truth.
 *   3. `event` — a REPLAYABLE INPUT (append / ops / config / locks / sent / reset), each
 *      stamped with the host's post-mutation `rev`. The replica replays the input through
 *      its own Truth and asserts `replica.rev === event.rev`; a mismatch ⇒ request a fresh
 *      snapshot. Events carry inputs, never derived state (Phase A review).
 *   4. `command` (client→server) — the client NEVER mutates optimistically. It sends ops /
 *      config dials; the host applies them to the authoritative Truth (which emits events to
 *      ALL clients) and replies `commandResult`. The loopback echo is sub-millisecond, so the
 *      replica mutates ONLY via the event stream — no double-apply reconciliation.
 *
 * unfold / recall are resolved LOCALLY against the host Truth (they work with zero clients),
 * so their old request/result round-trip message types are gone. Telemetry (`telemetry`)
 * replaces the plan-outcome ack: it streams the `context` hook duration after every hook.
 *
 * History:
 *  - v4–v10: the "GUI drives, extension is thin" plan-round-trip protocol (sync/plan,
 *    unfoldRequest/Result, recallRequest/Result, armed/armedAck, passthrough). All removed.
 *  - v11: Phase B. The extension is authoritative. `hello`/`snapshot`/`event`/`telemetry`/
 *    `commandResult`/`folding`/`recall`/`stream` (server→client) and `command`
 *    (client→server). PROTOCOL_VERSION bumped so a pre-B client cannot pair silently — both
 *    peers reject on a strict `protocolVersion !== PROTOCOL_VERSION`.
 *  - v12: `SnapshotState` gained `birthFolded`. Without it, a replica hydrated after a
 *    birth-fold started with an empty birth-fold set, so its very next housekeep healed the
 *    block locally while the host kept it folded — a silent divergence `rev` bookkeeping alone
 *    couldn't catch (both sides still bump by exactly one). Bumped so a pre-v12 peer (which
 *    would silently drop the field) cannot pair with a v12 host/client that assumes it's there.
 *  - v13: Phase C groundwork. A second client `Role` — `"conductor"` — can now attach as a
 *    RESIDENT strategy (in-extension live host or an out-of-process remote SDK) instead of a
 *    passive GUI replica: `hello` advertises the catalog of available conductors
 *    (`HelloMessage.conductors`); `conductorState`/`conductorStatus` broadcast to every client;
 *    `wireDeparting`/`turnCommitted` notify the attached conductor of the same host-lifecycle
 *    moments `TestHost.departWire`/`commitTurn` fire in-process; `propose`/`proposeResult` and
 *    `completeRequest`/`completeResult` carry the conductor's `ConductorHost.propose`/`complete`
 *    calls over the wire; `setConductorStatus` carries `ConductorHost.setStatus`; `WireCommand`
 *    gains `selectConductor` (GUI picker → host attach/detach). Bumped so a pre-v13 peer (which
 *    has none of this vocabulary) cannot pair with a v13 host/client that assumes it's there.
 *  - v14: wire-departing hold correlation + completion abort forwarding.
 *      • `wireDeparting` gains a unique `holdId`; a NEW client→server `holdRelease { holdId }` ends
 *        the hold. Release is now tied to the conductor's wire-departing HANDLER SETTLING (mirroring
 *        the in-process semantics), NOT to any `propose`. The old convention — the first `propose`
 *        after `wireDeparting` released the hold — could not distinguish the handler's own proposal
 *        from a concurrent background-tick proposal (e.g. thermocline's prepare epoch), so a
 *        background propose racing the hold released it before the handler's last-moment fold landed.
 *        The host releases ONLY on `holdRelease` carrying the CURRENT `holdId`; a stale/unknown id is
 *        ignored, a timeout still releases + counts, and a late `holdRelease` after timeout is a no-op.
 *        A `propose` is now just an ordinary proposal (an empty-ops `propose` no longer means "release").
 *      • A NEW client→server `cancelComplete { reqId }` forwards a conductor's `complete()` abort
 *        (the SDK wired its `AbortSignal` → `cancelComplete`) so the host aborts the in-flight
 *        completion's controller for that `reqId` (unknown/settled reqIds are ignored).
 *    Bumped so a pre-v14 peer (which has neither the `holdId` correlation nor the new client messages)
 *    cannot pair with a v14 host/client that assumes them.
 */
import type { Actor, Group, Override } from "./types";
import type { LockName } from "./locks";
import type { Op, OpResult } from "./ops";

/** Bump on any breaking change to the message shapes below. */
export const PROTOCOL_VERSION = 14;

/**
 * Browser dev-loop fallback port only. In the desktop ("pull") model each pi session binds an
 * EPHEMERAL port and advertises it via the registry, which clients discover — so this constant
 * is NOT what a real session listens on. It is the default the browser manual-connect pre-fills.
 */
export const DEFAULT_PORT = 4317;

/**
 * A serialisable block — the wire form of engine `Block`, minus the reactive overlay (which
 * travels separately in a snapshot's `overlay`, and is reconstructed by replaying events). `id`
 * is durable, content-anchored identity (see core/wire.ts → blockId):
 *   • `u:<timestamp>`                      — a user message
 *   • `a:<responseId|"t"+timestamp>:p<j>`  — part j of an assistant message (thinking|text|tool_call)
 *   • `r:<toolCallId>`                     — a tool_result message
 *   • `s:<timestamp>`                      — a summary/other message
 * Fallback (anchor absent): positional `m<i>:u|p<j>|r|s`.
 */
export interface WireBlock {
	id: string;
	kind: "user" | "text" | "thinking" | "tool_call" | "tool_result";
	turn: number;
	order: number;
	text: string;
	tokens: number;
	toolName?: string;
	callId?: string;
	model?: string;
	isError?: boolean;
}

/**
 * One in-place fold instruction: replace block `id`'s content with `digestText` (carrying a
 * leading `{#<code> FOLDED}` recovery tag). Consumed by `applyPlan` when the host serializes the
 * wire under `foldingEnabled`. Not a wire MESSAGE type in v12 — folding is computed host-side —
 * but kept here as the shared shape `Truth.serializeWire` / `applyPlan` exchange.
 */
export interface FoldOp {
	id: string;
	digestText: string;
}

/**
 * One group-collapse instruction (ADR 0006) — the only op that changes the message count.
 * `summaryText === null` means DROP (remove the run, insert nothing). Like `FoldOp`, an internal
 * shape of the host's `serializeWire`, not a v12 wire message.
 */
export interface GroupOp {
	id: string;
	memberIds: string[];
	summaryText: string | null;
}

/** The client role declared at connect. `conductor` is carried through auth + tagged for Phase C. */
export type Role = "gui" | "conductor";

/** Session identity a client renders in its header. */
export interface SessionMetaWire {
	title: string;
	cwd: string;
	model: string;
	contextWindow: number | null;
	format: "pi";
}

/**
 * One entry in the available-conductor catalog the host advertises (Phase C). This is the SINGLE
 * source of truth for the GUI's conductor picker — the host, not the GUI, knows what conductors
 * exist (in-process built-ins, an attached remote SDK) and what each one claims.
 */
export interface ActiveConductorMeta {
	id: string;
	label: string;
	description?: string;
	locks: LockName[];
	tailTokens: number;
	holdWireUpToMs: number;
	/** True iff this conductor runs out-of-process over the wire (a remote SDK), not in-extension. */
	remote: boolean;
}

/** One block's overlay in a snapshot (only blocks whose overlay differs from the fresh default). */
export interface WireOverlay {
	id: string;
	override: Override;
	autoFolded: boolean;
	by: Actor | null;
	subst?: string;
}

/**
 * The full serialized state a client (re)builds a replica Truth from. Rev-aligned: after adopting
 * this, the replica's `rev` equals `rev`, so subsequent event replays assert-match. `foldingEnabled`
 * is host-side (not a Truth field) but travels here so a reconnecting client sees the current arm.
 */
export interface SnapshotState {
	blocks: WireBlock[];
	overlay: WireOverlay[];
	groups: Group[];
	budget: number;
	contextWindow: number | null;
	protectTokens: number;
	locks: LockName[];
	lockHolder: string | null;
	tailTokens: number;
	sentThroughOrder: number;
	wireAttached: boolean;
	foldingEnabled: boolean;
	/**
	 * Ids a strategy birth-folded (folded while protected AND not-yet-sent) — see `Truth`'s
	 * `birthFolded` field. Must round-trip through a snapshot: `healProtected` skips exactly
	 * these ids when the protected tail grows over them, and a replica that lost this set would
	 * heal a block the host still keeps folded (v12; see the History note above).
	 */
	birthFolded: string[];
	rev: number;
}

/**
 * A replayable Truth input, stamped with the host's post-mutation `rev`. The replica replays the
 * input through its own Truth (append / apply / config setter / markSent) and asserts its rev
 * matches — a mismatch means it dropped or diverged and it requests a fresh snapshot.
 *
 *   • appended — new blocks entered the log (wire form; overlay is default). Replay: append.
 *   • ops      — an `apply` transaction; `ops` are ONLY the ops that actually applied on the host
 *                (clamped/no-op ops are dropped so a baseRev-less replica replay never resurrects
 *                a stale op). Replay: apply(ops, by).
 *   • config   — one config dial moved. Replay: the matching setter.
 *   • locks    — the involvement lock-set changed (Phase C). Replay: setLocks/clearLocks.
 *   • sent     — the sent cursor advanced. Replay: markSent.
 *   • reset    — a wholesale reset. Replay: apply([{resetAll}], by).
 */
export type WireEvent =
	| { kind: "appended"; blocks: WireBlock[]; rev: number }
	| { kind: "ops"; by: Actor; ops: Op[]; rev: number }
	| { kind: "config"; budget?: number; contextWindow?: number | null; protectTokens?: number; rev: number }
	| { kind: "locks"; locks: LockName[]; holder: string | null; tailTokens: number; rev: number }
	| { kind: "sent"; throughOrder: number; rev: number }
	| { kind: "reset"; by: Actor; rev: number };

// ── Server → client ──────────────────────────────────────────────────────────

/** Sent once when a client connects. `role` echoes the accepted role (default "gui"). */
export interface HelloMessage {
	type: "hello";
	protocolVersion: number;
	sessionId?: string;
	role: Role;
	meta: SessionMetaWire;
	/** The available-conductor catalog (Phase C) — omitted/undefined on a host with none attached
	 *  or not yet advertising one; the GUI picker renders from this, never from local knowledge. */
	conductors?: ActiveConductorMeta[];
}

/** Full state to (re)build a replica Truth. Sent right after hello and on any forced resnapshot. */
export interface SnapshotMessage {
	type: "snapshot";
	state: SnapshotState;
}

/** One replayable Truth input. */
export interface EventMessage {
	type: "event";
	event: WireEvent;
}

/** The host-side folding-enabled flag changed (armed semantics; default OFF). */
export interface FoldingMessage {
	type: "folding";
	enabled: boolean;
}

/**
 * The live agent called `recall` (a pure READ resolved locally against the host Truth). Surfaced
 * so clients/conductors can observe it; it changes NO Truth state (no rev), so it is not a
 * `WireEvent`. `ids` are the block ids whose content was read.
 */
export interface RecallObservationMessage {
	type: "recall";
	ids: string[];
	by: Actor;
}

/**
 * Streamed after every `context` hook — the local-path timing that replaced the plan round trip.
 * `lastHoldMs`/`holdTimeouts` (v13) cover the NEW `wire-departing` hold window (`holdWireUpToMs`):
 * how long the host held the departing wire for the attached conductor's last-moment proposal on
 * the most recent hook, and how many times that hold has hit its timeout and passed through
 * without one, over the session's lifetime.
 */
export interface TelemetryMessage {
	type: "telemetry";
	lastHookMs: number;
	maxHookMs: number;
	p95HookMs: number;
	rebuilds: number;
	hookCount: number;
	lastHoldMs: number;
	holdTimeouts: number;
}

/** The host's reply to a `command`. The client uses it for clamp UX only; state arrives via events. */
export interface CommandResultMessage {
	type: "commandResult";
	seq: number;
	results: OpResult[];
	rev: number;
}

/**
 * Ghost lifecycle frame (unchanged from earlier protocols): a content part is forming ("start"),
 * finished ("end"), or aborted ("abort"). Presentation-only; carries no content or tokens.
 * `contentIndex < 0` on an "abort" frame means "clear ALL active ghosts."
 */
export interface StreamMessage {
	type: "stream";
	phase: "start" | "end" | "abort";
	kind: "thinking" | "text" | "tool_call";
	contentIndex: number;
}

/**
 * Broadcast to EVERY client (not just the conductor role) whenever the host's attached conductor
 * changes — attach, detach, or a swap. `active: null` means no conductor is attached (context is
 * raw / human-only). The GUI's status strip and picker both render from this, never from a locally
 * tracked guess, so every client agrees on who (if anyone) is driving.
 */
export interface ConductorStateMessage {
	type: "conductorState";
	active: ActiveConductorMeta | null;
}

/**
 * Broadcast to EVERY client: the attached conductor's display-only status line/metrics changed
 * (`ConductorHost.setStatus`, echoed from the conductor's `setConductorStatus` command). `text:
 * null` clears it. Purely presentational — carries no Truth state.
 */
export interface ConductorStatusMessage {
	type: "conductorStatus";
	text: string | null;
	metrics?: Record<string, number | string | boolean>;
}

/**
 * Sent ONLY to the client holding the `"conductor"` role: the wire is about to depart to the
 * model. The wire host-adapter equivalent (`hostAdapter.ts → wireDepartingEvent`) already computes
 * the same `rev`/`liveTokens`/`budget`/`freshIds`; `holdMs` is this attached conductor's own
 * `holdWireUpToMs` — how long the host will wait before letting the wire depart unchanged. `holdId`
 * (v14) uniquely identifies THIS hold: the conductor ends it by sending `holdRelease { holdId }` the
 * moment its wire-departing handler settles — NOT via a `propose` (see the v14 History note). A
 * GUI-role client never receives this (it has no last-moment proposal to make).
 */
export interface WireDepartingMessage {
	type: "wireDeparting";
	rev: number;
	liveTokens: number;
	budget: number;
	freshIds: string[];
	holdMs: number;
	holdId: number;
}

/** Sent ONLY to the conductor-role client: a turn settled — the canonical re-plan trigger. */
export interface TurnCommittedMessage {
	type: "turnCommitted";
	turn: number;
	rev: number;
}

/** Sent ONLY to the conductor-role client: the reply to its `propose` command. */
export interface ProposeResultMessage {
	type: "proposeResult";
	seq: number;
	rev: number;
	results: OpResult[];
}

/** Sent ONLY to the conductor-role client: the reply to its `completeRequest` (out-of-band model
 *  completion). `ok:false` means the call was unavailable/failed — `error` carries why. */
export interface CompleteResultMessage {
	type: "completeResult";
	reqId: number;
	ok: boolean;
	text?: string;
	model?: string;
	inputTokens?: number;
	outputTokens?: number;
	error?: string;
}

export type ServerMessage =
	| HelloMessage
	| SnapshotMessage
	| EventMessage
	| FoldingMessage
	| RecallObservationMessage
	| TelemetryMessage
	| CommandResultMessage
	| StreamMessage
	| ConductorStateMessage
	| ConductorStatusMessage
	| WireDepartingMessage
	| TurnCommittedMessage
	| ProposeResultMessage
	| CompleteResultMessage;

// ── Client → server ──────────────────────────────────────────────────────────

/**
 * A remote-control command. `ops` always carry `by:"you"` server-side (a client is a human hand).
 * Config dials are their own kinds. The host applies against the current rev and replies
 * `commandResult`; there is NO optimistic apply — the replica mutates only via the echoed events.
 * `selectConductor` (v13) drives the host's attach/detach — `id: null` detaches whatever is
 * currently attached, `id: "<conductorId>"` attaches (swapping out any prior attach first).
 */
export type WireCommand =
	| { kind: "ops"; ops: Op[] }
	| { kind: "setBudget"; value: number }
	| { kind: "setProtect"; value: number }
	| { kind: "setFolding"; value: boolean }
	| { kind: "selectConductor"; id: string | null };

export interface CommandMessage {
	type: "command";
	seq: number;
	cmd: WireCommand;
}

/**
 * A conductor-role client's transaction proposal (v13) — the wire form of `ConductorHost.propose`.
 * The host applies against `baseRev` and replies `proposeResult` (never a `commandResult`; a
 * conductor's ops are attributed `by:"auto"`/the conductor's own actor, never `"you"`).
 */
export interface ProposeMessage {
	type: "propose";
	seq: number;
	baseRev: number;
	ops: Op[];
}

/**
 * A conductor-role client's out-of-band completion request (v13) — the wire form of
 * `ConductorHost.complete`. The host resolves it against the live session's model and replies
 * `completeResult` tagged with the same `reqId`.
 */
export interface CompleteRequestMessage {
	type: "completeRequest";
	reqId: number;
	system?: string;
	prompt: string;
	maxOutputTokens?: number;
	model?: string;
}

/** A conductor-role client's display-only status update (v13) — the wire form of
 *  `ConductorHost.setStatus`. The host echoes it to every client as `conductorStatus`. */
export interface SetConductorStatusMessage {
	type: "setConductorStatus";
	text: string | null;
	metrics?: Record<string, number | string | boolean>;
}

/**
 * A conductor-role client's wire-departing hold RELEASE (v14). Sent the instant the conductor's
 * `wire-departing` handler settles (resolve OR reject), mirroring the in-process semantics where the
 * hold resolves when the handler's returned promise settles. `holdId` echoes the `wireDeparting`
 * message this releases; the host releases the departing wire ONLY on a matching CURRENT `holdId`,
 * ignores a stale/unknown one, and treats a `holdRelease` arriving after the hold already timed out
 * as a no-op. This REPLACES the old "first `propose` releases the hold" convention — a `propose` is
 * now always just an ordinary proposal, never a hold-release signal.
 */
export interface HoldReleaseMessage {
	type: "holdRelease";
	holdId: number;
}

/**
 * A conductor-role client's completion ABORT (v14) — the wire form of aborting a `complete()` call's
 * `AbortSignal`. The SDK sends this when the signal the conductor passed to `host.complete` fires;
 * the host aborts the in-flight completion's `AbortController` for that `reqId`. An unknown/settled
 * `reqId` is ignored (the completion already resolved, or never existed on this socket).
 */
export interface CancelCompleteMessage {
	type: "cancelComplete";
	reqId: number;
}

/**
 * Ask the host for a fresh `snapshot`. Sent when a replica detects it has diverged — a replayed
 * event's rev didn't match, or a `reset` event arrived (which the client resnapshots rather than
 * replaying, sidestepping any batched-transaction rev ambiguity). Idempotent + cheap.
 */
export interface ResnapshotMessage {
	type: "resnapshot";
}

export type ClientMessage =
	| CommandMessage
	| ResnapshotMessage
	| ProposeMessage
	| CompleteRequestMessage
	| SetConductorStatusMessage
	| HoldReleaseMessage
	| CancelCompleteMessage;

// ── Helpers ────────────────────────────────────────────────────────────────

const SERVER_TYPES = new Set([
	"hello",
	"snapshot",
	"event",
	"folding",
	"recall",
	"telemetry",
	"commandResult",
	"stream",
	"conductorState",
	"conductorStatus",
	"wireDeparting",
	"turnCommitted",
	"proposeResult",
	"completeResult",
]);

export function isServerMessage(v: unknown): v is ServerMessage {
	if (!v || typeof v !== "object" || !("type" in v)) return false;
	return SERVER_TYPES.has((v as { type: unknown }).type as string);
}

const CLIENT_TYPES = new Set(["command", "resnapshot", "propose", "completeRequest", "setConductorStatus", "holdRelease", "cancelComplete"]);

export function isClientMessage(v: unknown): v is ClientMessage {
	if (!v || typeof v !== "object" || !("type" in v)) return false;
	return CLIENT_TYPES.has((v as { type: unknown }).type as string);
}

const WIRE_KINDS = new Set(["user", "text", "thinking", "tool_call", "tool_result"]);

/**
 * Element-level guard for a `WireBlock`. `isServerMessage` vets only the `type` tag, and an
 * authorized peer may still be malformed — a bad element must be dropped at the pump, not thrown
 * from `wireToBlock` nor fed into the store as NaN token accounting.
 */
export function isWireBlock(v: unknown): v is WireBlock {
	if (!v || typeof v !== "object") return false;
	const b = v as Record<string, unknown>;
	return (
		typeof b.id === "string" &&
		typeof b.kind === "string" &&
		WIRE_KINDS.has(b.kind) &&
		typeof b.turn === "number" &&
		typeof b.order === "number" &&
		typeof b.text === "string" &&
		typeof b.tokens === "number"
	);
}
