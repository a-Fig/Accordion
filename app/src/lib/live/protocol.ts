/*
 * protocol.ts — the wire contract between the pi extension and the Accordion GUI.
 *
 * This file is the SINGLE SOURCE OF TRUTH for the live link. It is imported by
 * both the GUI (app/src/lib/live/*) and the pi extension (extension/accordion.ts,
 * via a relative import) so the two can never drift. Keep it dependency-free and
 * types-only at runtime — no imports from the rest of the app.
 *
 * ── Roles (Milestone 1) ────────────────────────────────────────────────────
 *   • The pi EXTENSION hosts a WebSocket server on PORT (127.0.0.1).
 *   • The GUI webview connects as a WebSocket CLIENT.
 *   • "GUI drives, extension is thin": the extension never decides what to fold.
 *     It linearizes pi's in-memory messages into blocks, streams them, and applies
 *     whatever fold plan the GUI returns. The GUI runs the engine (the brain).
 *
 * ── Per-turn loop ──────────────────────────────────────────────────────────
 *   1. pi's `context` hook fires in the extension (before a model call).
 *   2. Extension sends `sync` with the blocks added since the last sync.
 *   3. GUI updates its live store, runs the engine, replies `plan { ops }`.
 *   4. Extension applies the ops to the real messages and returns them to pi.
 *      If no GUI is connected, or the reply times out, the extension passes the
 *      messages through UNMODIFIED (never corrupts context).
 *
 * Milestone 1 deliberately ships an EMPTY plan (`ops: []`) from the GUI: the loop
 * is proven end-to-end while never altering a single model call.
 */

/** Bump on any breaking change to the message shapes below. */
export const PROTOCOL_VERSION = 2;

/**
 * Browser dev-loop fallback port only. In the desktop ("pull") model each pi
 * session binds an EPHEMERAL port and advertises it via the registry (registry.ts),
 * which the app discovers — so this constant is NOT what a real session listens on.
 * It is just the default the browser manual-connect input pre-fills.
 */
export const DEFAULT_PORT = 4317;

/**
 * A serialisable block — the wire form of engine `Block`, minus the reactive
 * fold state (the GUI owns that). `id` is assigned by the extension using
 * durable, content-anchored identity — identical whether derived now or after
 * the message array shifts position:
 *   • `u:<timestamp>`                      — a user message
 *   • `a:<responseId|"t"+timestamp>:p<j>`  — part j of an assistant message
 *     (kind: thinking | text | tool_call); prefers responseId, falls back to timestamp
 *   • `r:<toolCallId>`                     — a tool_result message
 *   • `s:<timestamp>`                      — a summary/other message
 * Fallback (anchor field absent): positional `m<i>:u`, `m<i>:p<j>`, `m<i>:r`,
 * `m<i>:s` — ensures nothing crashes on malformed messages.
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

/** One fold instruction: replace block `id`'s content with `digestText`. */
export interface FoldOp {
	id: string;
	digestText: string;
}

// ── Server → client (extension → GUI) ────────────────────────────────────────

/** Sent once when the GUI connects. */
export interface HelloMessage {
	type: "hello";
	protocolVersion: number;
	sessionId: string;
	meta: { title: string; cwd: string; model: string; format: "pi" };
}

/**
 * Sent on every `context` hook. `blocks` are the blocks ADDED since the previous
 * sync (the whole context when `full` is true — i.e. the first sync, or after a
 * structural reset). `reqId` correlates the GUI's `plan` reply.
 */
export interface SyncMessage {
	type: "sync";
	reqId: number;
	full: boolean;
	blocks: WireBlock[];
}

/**
 * Sent by the extension to inform the GUI that a content part is forming (phase:
 * "start"), has finished (phase: "end"), or was aborted due to an error (phase:
 * "abort"). Carries NO content, NO token count — only identity (kind + contentIndex)
 * and the lifecycle phase. Drives presentation-only ghost state in the GUI.
 *
 * contentIndex: the assistantMessageEvent's contentIndex (0-based part index).
 * When contentIndex < 0 in an "abort" frame it means "clear ALL active ghosts."
 *
 * PROTOCOL_VERSION stays at 2 — this entire ADR 0003 ships as one unreleased
 * protocol version; do NOT bump again here.
 */
export interface StreamMessage {
	type: "stream";
	phase: "start" | "end" | "abort";
	kind: "thinking" | "text" | "tool_call";
	contentIndex: number;
}

export type ServerMessage = HelloMessage | SyncMessage | StreamMessage;

// ── Client → server (GUI → extension) ────────────────────────────────────────

/** The GUI's reply to a `sync`. `ops: []` means "fold nothing". */
export interface PlanMessage {
	type: "plan";
	reqId: number;
	ops: FoldOp[];
}

/** Optional: the GUI announcing itself (reserved; unused in M1). */
export interface AttachMessage {
	type: "attach";
	protocolVersion: number;
}

export type ClientMessage = PlanMessage | AttachMessage;

// ── Helpers ──────────────────────────────────────────────────────────────────

export function isServerMessage(v: unknown): v is ServerMessage {
	return !!v && typeof v === "object" && "type" in v && ((v as any).type === "hello" || (v as any).type === "sync" || (v as any).type === "stream");
}

export function isClientMessage(v: unknown): v is ClientMessage {
	return !!v && typeof v === "object" && "type" in v && ((v as any).type === "plan" || (v as any).type === "attach");
}
