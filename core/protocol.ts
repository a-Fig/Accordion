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
 *  - v15: `SnapshotState` gained `carriedSent` (optional). A divergence rebuild that inserts a fresh
 *    block BEFORE already-sent blocks drags the scalar `sentThroughOrder` prefix frontier back,
 *    which by the `order`-prefix alone reclassifies those sent blocks never-sent; `carriedSent`
 *    preserves their sent-ness per-id, and the effective `Truth.sent` predicate is the union of the
 *    frontier and this set. Must round-trip or a replica reclassifies a sent block as fresh
 *    (birth-fold-eligible / back in `freshIds`) while both revs advance in lockstep — the same
 *    invisible-divergence class v12's `birthFolded` closed. Bumped so a pre-v15 peer (which neither
 *    sends nor expects the field) cannot pair with a v15 host/client that assumes it.
 *  - v16: single-controller + the stable door (ADR 0024, issue #66). `hello` gains `controller`
 *    (the current global lease + a `fresh` flag); a NEW client→server `claimController {}` takes the
 *    lease (allowed from any GUI socket — the human is the authority, takeover is never refused); a
 *    NEW server→client `controller { surfaceId, label }` broadcasts a lease change of hands. A GUI
 *    socket dials with `?surface`/`?label` identity params (sanitized like every other ingress), and
 *    `CommandResultMessage` gains `refused:"read-only"` — a mutating command from a surface that is
 *    not the fresh lease-holder is refused before it touches Truth. Bumped so a pre-v16 peer (which
 *    has none of this vocabulary) cannot pair with a v16 host/client that assumes it.
 *  - v17: a NEW server→client `notice { text }` — a minimal, generic informational toast broadcast
 *    to every connected GUI client. First (and so far only) use: pi compacted the session natively
 *    while folding was off (`session_compact` in extension/accordion.ts), so every attached UI —
 *    not just whoever reads the extension-local `ctx.ui.notify` — sees why the map just changed
 *    shape. Deliberately NOT the start of a notification framework: no `kind`, no queue, no
 *    client→server counterpart. Bumped so a pre-v17 peer (which doesn't know this type) still can't
 *    silently pair with a v17 host/client — same policy as every prior bump, even though an unknown
 *    message type alone is harmless (`isServerMessage`/a conductor's `default:` case both ignore it).
 */
import type { Actor, Group, Override } from "./types";
import type { LockName } from "./locks";
import { sanitizeOps, type Op, type OpResult } from "./ops";

/** Bump on any breaking change to the message shapes below. */
export const PROTOCOL_VERSION = 17;

/**
 * The DOOR: a fixed, well-known loopback port that exactly ONE extension binds at a time as an
 * ADDITIONAL listener (its per-session ephemeral port is unchanged), with automatic takeover when
 * the holder dies (ADR 0024). This is what makes `/accordion`'s URL stable across any single
 * session's death. Deliberately NOT the standard OTLP/gRPC collector port 4317 — that has a real
 * collision risk on dev machines.
 */
export const DOOR_PORT = 24317;

/**
 * Manual-connect pre-fill default. Points at the DOOR (a stable URL that survives any one session's
 * death), NOT a real ephemeral session port — in the desktop ("pull") model each session binds an
 * ephemeral port advertised via the registry, which clients discover. This constant is only the
 * value the browser manual-connect field pre-fills / falls back to.
 */
export const DEFAULT_PORT = DOOR_PORT;

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

/**
 * The current global controller lease as the host knows it (ADR 0024, single-controller). Exactly
 * one surface controls machine-wide, across ALL live pi sessions; every other surface is a live
 * READ-ONLY mirror. Carried on `hello` so a connecting GUI can decide silent auto-claim (no lease,
 * or `fresh:false`) vs. the takeover popup (`fresh` and a DIFFERENT surface). `fresh` = the lease's
 * `heartbeatAt` is within the staleness window — a stale lease is treated as uncontrolled.
 */
export interface ControllerInfo {
	surfaceId: string;
	label: string;
	fresh: boolean;
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
	/**
	 * Ids of blocks a divergence rebuild carried as ALREADY-sent even though they now sit above the
	 * scalar `sentThroughOrder` frontier (a freshly-inserted-earlier block dragged the prefix back) —
	 * see `Truth`'s `carriedSent`. Optional so a peer/test constructing a `SnapshotState` literal
	 * without it still type-checks (the v15 version bump is the real cross-version gate); a hydrating
	 * replica defaults it to `[]`, and the host serializer always emits it. Missing it would let a
	 * replica reclassify a sent block as fresh — birth-fold-eligible / back in `freshIds` — diverging
	 * from the host while both revs still advance in lockstep (the same class as v12's `birthFolded`).
	 */
	carriedSent?: string[];
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
	/** The current global controller lease (v16, ADR 0024), or `null` when no lease exists. Optional
	 *  so a pre-v16-shaped literal still type-checks (the version bump is the real cross-version gate);
	 *  a v16 host always emits it (possibly `null`). */
	controller?: ControllerInfo | null;
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
	/**
	 * v16 (ADR 0024): the whole command was refused BEFORE it touched the Truth because the sending
	 * surface is not the current fresh controller (READ-ONLY enforcement). For an `ops` command
	 * `results` additionally mirrors one `read-only` clamp per op (so per-tile clamp UX still works);
	 * this top-level flag is the uniform signal for the dial commands (setBudget/setProtect/
	 * setFolding/selectConductor) that carry no ops. `rev` is unchanged (nothing applied).
	 */
	refused?: "read-only";
}

/**
 * Broadcast to EVERY client of this extension whenever the global controller lease changes hands
 * (v16, ADR 0024): this extension's own `claimController` write, OR an external change observed via
 * the ~1s `controller.json` mtime poll. Carries the NEW holder's identity; a GUI compares
 * `surfaceId` to its own to decide "I gained control" vs. "someone took control from me" (demotion),
 * never a locally tracked guess. Staleness (holder went away) is NOT signalled here — it surfaces on
 * the next connect via `hello.controller.fresh:false`; a hard clear never happens (last write wins).
 */
export interface ControllerMessage {
	type: "controller";
	surfaceId: string;
	label: string;
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
 * Broadcast to EVERY connected GUI client (v17): a minimal, generic informational toast. First use
 * is `session_compact` in extension/accordion.ts, surfacing pi's native compaction (when folding was
 * off) beyond the existing extension-local `ctx.ui.notify`. Deliberately kept to a single `text`
 * field — this is not the start of a notification framework; add fields only when a second real use
 * needs them. No client→server counterpart, so it never goes through `sanitizeCommand` (that gate is
 * client→server ingress only).
 */
export interface NoticeMessage {
	type: "notice";
	text: string;
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
	| CompleteResultMessage
	| ControllerMessage
	| NoticeMessage;

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

/**
 * A GUI client's request to become the global controller (v16, ADR 0024). Allowed from ANY gui
 * socket — the human is the authority, so a takeover is never refused and last write wins on races.
 * Carries no payload: the claiming surface's identity is the socket's own `?surface`/`?label` dial
 * params, which the host already sanitized at connect. NOT a `command` (it is never gated by the
 * READ-ONLY controller check — that would make claiming impossible for a non-controller).
 */
export interface ClaimControllerMessage {
	type: "claimController";
}

export type ClientMessage =
	| CommandMessage
	| ResnapshotMessage
	| ProposeMessage
	| CompleteRequestMessage
	| SetConductorStatusMessage
	| HoldReleaseMessage
	| CancelCompleteMessage
	| ClaimControllerMessage;

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
	"controller",
	"notice",
]);

export function isServerMessage(v: unknown): v is ServerMessage {
	if (!v || typeof v !== "object" || !("type" in v)) return false;
	return SERVER_TYPES.has((v as { type: unknown }).type as string);
}

const CLIENT_TYPES = new Set(["command", "resnapshot", "propose", "completeRequest", "setConductorStatus", "holdRelease", "cancelComplete", "claimController"]);

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

/** A finite, ≥0 numeric dial value (`setBudget`/`setProtect`), or null if it isn't a usable number. */
function sanitizeDialValue(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : null;
}

/**
 * Validate + clamp a `WireCommand` arriving from a client into a safe, applyable command — or
 * `null` when it is unusable and the ingress should ignore it. `isClientMessage` vets only the
 * message `type` tag, so a `command` frame from an authorized-but-buggy client can still carry a
 * malformed `cmd`: a `setBudget`/`setProtect` with a NaN/Infinity/negative value poisons `Truth`'s
 * budget/protect state and forks replicas (JSON serializes NaN/Infinity as `null`), and an `ops`
 * command with a malformed array throws inside `Truth.apply`. This is the single ingress gate that
 * closes both: numeric dials are coerced to finite ≥0, and `ops` is passed through `sanitizeOps`
 * (dropping structurally invalid elements). Additive primitive for the extension's WS ingress;
 * nothing on this branch wires it yet (Wave 2). `Truth.setBudget` still floors budget to 1000
 * itself — this only guarantees the value is a real, non-poisoning number first.
 */
export function sanitizeCommand(cmd: unknown): WireCommand | null {
	if (!cmd || typeof cmd !== "object") return null;
	const c = cmd as Record<string, unknown>;
	switch (c.kind) {
		case "ops": {
			const ops = sanitizeOps(c.ops);
			return ops ? { kind: "ops", ops } : null;
		}
		case "setBudget": {
			const value = sanitizeDialValue(c.value);
			return value === null ? null : { kind: "setBudget", value };
		}
		case "setProtect": {
			const value = sanitizeDialValue(c.value);
			return value === null ? null : { kind: "setProtect", value };
		}
		case "setFolding":
			return typeof c.value === "boolean" ? { kind: "setFolding", value: c.value } : null;
		case "selectConductor":
			return c.id === null || typeof c.id === "string" ? { kind: "selectConductor", id: c.id } : null;
		default:
			return null;
	}
}

/** Bound on a surface id (`?surface=`) — comfortably longer than a UUID (36 chars). */
export const MAX_SURFACE_ID_LEN = 64;
/** Bound on a surface label (`?label=`) — e.g. "Desktop app" / "Browser tab". */
export const MAX_SURFACE_LABEL_LEN = 48;

/**
 * Validate + clamp a surface-id dial param (v16, ADR 0024). Each surface mints a per-tab UUID in
 * sessionStorage and sends it as `?surface=`; this is the SAME "authorized ≠ well-formed" ingress gate
 * `sanitizeCommand` is — a malformed/hostile value must never reach the `controller.json` lease file
 * or a `controller` broadcast. Accept only a bounded `[A-Za-z0-9._-]` token (covers a UUID and any
 * reasonable surface id); anything else → `null` (the socket is then treated as having no
 * identity and can never hold the lease).
 */
export function sanitizeSurfaceId(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const s = v.trim();
	if (!s || s.length > MAX_SURFACE_ID_LEN) return null;
	return /^[A-Za-z0-9._-]+$/.test(s) ? s : null;
}

/**
 * Validate + clamp a surface-label dial param (v16). Human-facing only (rendered in the READ-ONLY
 * chip / takeover popup), so it may contain spaces, but control characters are stripped and the
 * length is bounded before it can ride a broadcast to every client. Returns a safe non-empty label,
 * or `null` when nothing usable remains.
 */
export function sanitizeSurfaceLabel(v: unknown): string | null {
	if (typeof v !== "string") return null;
	// Keep printable chars only (drop C0 control chars + DEL by code point), then trim + cap
	// length before the label can ride a broadcast to every client.
	let s = "";
	for (const ch of v) {
		const code = ch.codePointAt(0);
		if (code !== undefined && code >= 0x20 && code !== 0x7f) s += ch;
	}
	s = s.trim().slice(0, MAX_SURFACE_LABEL_LEN);
	return s ? s : null;
}
