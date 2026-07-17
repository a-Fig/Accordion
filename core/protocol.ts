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
 */
import type { Actor, Group, Override } from "./types";
import type { LockName } from "./locks";
import type { Op, OpResult } from "./ops";

/** Bump on any breaking change to the message shapes below. */
export const PROTOCOL_VERSION = 11;

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
 * wire under `foldingEnabled`. Not a wire MESSAGE type in v11 — folding is computed host-side —
 * but kept here as the shared shape `Truth.serializeWire` / `applyPlan` exchange.
 */
export interface FoldOp {
	id: string;
	digestText: string;
}

/**
 * One group-collapse instruction (ADR 0006) — the only op that changes the message count.
 * `summaryText === null` means DROP (remove the run, insert nothing). Like `FoldOp`, an internal
 * shape of the host's `serializeWire`, not a v11 wire message.
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

/** Streamed after every `context` hook — the local-path timing that replaced the plan round trip. */
export interface TelemetryMessage {
	type: "telemetry";
	lastHookMs: number;
	maxHookMs: number;
	p95HookMs: number;
	rebuilds: number;
	hookCount: number;
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

export type ServerMessage =
	| HelloMessage
	| SnapshotMessage
	| EventMessage
	| FoldingMessage
	| RecallObservationMessage
	| TelemetryMessage
	| CommandResultMessage
	| StreamMessage;

// ── Client → server ──────────────────────────────────────────────────────────

/**
 * A remote-control command. `ops` always carry `by:"you"` server-side (a client is a human hand).
 * Config dials are their own kinds. The host applies against the current rev and replies
 * `commandResult`; there is NO optimistic apply — the replica mutates only via the echoed events.
 */
export type WireCommand =
	| { kind: "ops"; ops: Op[] }
	| { kind: "setBudget"; value: number }
	| { kind: "setProtect"; value: number }
	| { kind: "setFolding"; value: boolean };

export interface CommandMessage {
	type: "command";
	seq: number;
	cmd: WireCommand;
}

export type ClientMessage = CommandMessage;

// ── Helpers ────────────────────────────────────────────────────────────────

const SERVER_TYPES = new Set(["hello", "snapshot", "event", "folding", "recall", "telemetry", "commandResult", "stream"]);

export function isServerMessage(v: unknown): v is ServerMessage {
	if (!v || typeof v !== "object" || !("type" in v)) return false;
	return SERVER_TYPES.has((v as { type: unknown }).type as string);
}

export function isClientMessage(v: unknown): v is ClientMessage {
	return !!v && typeof v === "object" && (v as { type?: unknown }).type === "command";
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
