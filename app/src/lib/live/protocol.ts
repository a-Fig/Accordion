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

/**
 * Bump on any breaking change to the message shapes below. History:
 *  - v4: group collapse ops (`GroupOp`, `PlanMessage.groups`).
 *  - v5: recall tool (`recallRequest` / `recallResult`) plus completion relay
 *        (`completeRequest` / `completeResult`) for out-of-band model completions.
 */
export const PROTOCOL_VERSION = 5;

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

/**
 * One fold instruction: replace block `id`'s content with `digestText`.
 *
 * Since protocol v3, `digestText` carries a leading `{#<code> FOLDED}` tag (a short
 * hash of the block's durable id) so the live agent can SEE that this content was
 * compacted (not lost) and ask for it back via the `unfold` tool, passing that same
 * code. The tag is produced by the ENGINE's `digest()` (so the GUI renders, and
 * token-accounts, the exact string the agent receives — one source of truth); the
 * GUI's `computeFoldOps` sends `store.digestOf(b)` verbatim and the extension
 * substitutes it opaquely.
 */
export interface FoldOp {
	id: string;
	digestText: string;
}

/**
 * One group-collapse instruction (ADR 0006) — the ONLY op that changes the message count
 * (every `FoldOp` is in-place). It replaces the messages of a contiguous block range with
 * ONE synthetic summary message. `memberIds` are the durable block ids the GUI deems safely
 * collapsible (stragglers/protected already excluded); `summaryText` is the single entry's
 * text, carrying the group's `{#<code> FOLDED}` tag where `code = foldCode(group.id)` — ONE
 * handle for the whole range, so the agent restores it all with one `unfold` code.
 *
 * `summaryText === null` means DROP: the run is removed from the wire and NO replacement
 * message is inserted. The agent never sees those blocks. Phase A (tool-pair balancing) still
 * applies — only whole, balanced messages are removed. Phase B simply emits nothing.
 *
 * Provider safety lives on BOTH sides (defense in depth, like `FoldOp`): the extension's
 * `applyPlan` re-derives tool-pair balance independently and only removes WHOLE, balanced,
 * durable messages — on ANY doubt the affected messages pass through untouched. The wire
 * trusts the engine's plan (the engine is the single foldability gate and never folds a
 * protected block), so no separate wire-side position backstop is applied. Safe because
 * `applyPlan`'s output feeds the model only; the GUI's block sync and `sentCount` cursor
 * run off the un-collapsed `linearize`, so a removal can never desync the view.
 */
export interface GroupOp {
	id: string;
	memberIds: string[];
	/** `null` = drop (remove the run, insert no message); non-null string = the summary text. */
	summaryText: string | null;
}

// ── Server → client (extension → GUI) ────────────────────────────────────────

/** Sent once when the GUI connects. */
export interface HelloMessage {
	type: "hello";
	protocolVersion: number;
	sessionId: string;
	meta: { title: string; cwd: string; model: string; contextWindow: number | null; format: "pi" };
}

/**
 * Sent on every `context` hook. `blocks` are the blocks ADDED since the previous
 * sync (the whole context when `full` is true — i.e. the first sync, or after a
 * structural reset). `reqId` correlates the GUI's `plan` reply. `contextWindow`
 * is the model's total token capacity (best-effort; absent from old extensions).
 */
export interface SyncMessage {
	type: "sync";
	reqId: number;
	full: boolean;
	blocks: WireBlock[];
	contextWindow?: number | null;
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

/**
 * Sent by the extension when the live AGENT calls the `unfold` tool, asking the GUI
 * to restore folded blocks to full content (protocol v3 — "the agent can pull its
 * own context back"). `codes` are the short fold codes the agent read from the
 * `{#<code> FOLDED}` tags in its context. The GUI resolves each code to every folded
 * block carrying it (a code can rarely collide → restore all matches) and marks them
 * unfolded (sticky; provenance "agent"), then replies via `unfoldResult` (correlated
 * by `reqId`).
 *
 * This is a STATE change only: the restored content reaches the model at the NEXT
 * `context` hook (the unfolded block simply no longer appears in the fold plan), so the
 * agent's past context changes on its next turn. We deliberately do NOT echo the full
 * content back in the tool result for now — testing whether the past-context change
 * alone suffices (echoing is a documented fallback).
 */
export interface UnfoldRequestMessage {
	type: "unfoldRequest";
	reqId: number;
	codes: string[];
}

/**
 * Sent by the extension when the live AGENT calls the `recall` tool (protocol v5 —
 * ADR 0011). `recall` is the agent's counterpart to the human's "peek": an UNBLOCKABLE
 * read that returns a folded block's ORIGINAL full content AS a tool result THIS turn,
 * WITHOUT mutating the standing view (no override created, the block stays folded). It
 * is the safety net that makes locking the agent's `unfold` non-blinding, so it is never
 * gated by any lock.
 *
 * `codes` are the short fold codes the agent read from the `{#<code> FOLDED}` tags. The
 * GUI resolves each code to every folded block carrying it and returns the full content
 * (NOT the lossy digest) in the `recallResult` reply — the defining difference from
 * `unfoldRequest`, which schedules a state change and echoes nothing.
 */
export interface RecallRequestMessage {
	type: "recallRequest";
	reqId: number;
	codes: string[];
}

/**
 * Extension → GUI: the result of a `completeRequest` (protocol v5).
 *
 * `reqId` correlates 1-to-1 with the `completeRequest` that triggered this. `ok:false`
 * means the completion failed (no model available, key resolution error, the model itself
 * errored, etc.) — `error` describes what went wrong and `text`/`model` are absent.
 *
 * On success (`ok:true`):
 *  - `text` is the model's full text output.
 *  - `model` is the model id that actually ran.
 *  - `inputTokens` / `outputTokens` are usage counts, when the extension can supply them.
 */
export interface CompleteResultMessage {
	type: "completeResult";
	reqId: number;
	ok: boolean;
	text?: string;
	model?: string;
	inputTokens?: number;
	outputTokens?: number;
	/** Present when ok:false — a human-readable description of the failure. */
	error?: string;
}

export type ServerMessage = HelloMessage | SyncMessage | StreamMessage | UnfoldRequestMessage | RecallRequestMessage | CompleteResultMessage;

// ── Client → server (GUI → extension) ────────────────────────────────────────

/** The GUI's reply to a `sync`. `ops: []` (and no `groups`) means "fold nothing". */
export interface PlanMessage {
	type: "plan";
	reqId: number;
	ops: FoldOp[];
	/** Group-collapse ops (ADR 0006). Optional/additive — omitted ⇒ no group collapse. */
	groups?: GroupOp[];
}

/**
 * GUI → extension: ask the extension to run an out-of-band model completion (protocol v5).
 *
 * This is a SEPARATE model invocation — independent of the agent's own turn. It is
 * designed for a conductor that needs the host's model link (e.g. to summarize aged
 * context blocks). Hard invariants:
 *
 *  - This call MUST NEVER block or alter the agent's own model call or the `context`
 *    hook. The extension fulfils it on a side channel, completely outside the
 *    sync→plan→apply loop.
 *  - "Extension is thin" — the extension makes NO folding decision. It runs exactly the
 *    completion it is handed and returns the raw result. Strategy lives in the GUI.
 *  - `reqId` is GUI-assigned (monotonic integer). The extension echoes it in
 *    `completeResult` so the GUI can match responses even if multiple requests overlap.
 */
export interface CompleteRequestMessage {
	type: "completeRequest";
	reqId: number;
	/** Optional system instruction (e.g. a compaction persona or template). */
	system?: string;
	/** The user-role content to operate on (e.g. aged context blocks to summarize). */
	prompt: string;
	/**
	 * Requested cap on output tokens. The extension clamps this to the model's own
	 * max-output ceiling before forwarding — so a conductor can safely pass any positive
	 * number without risking a provider rejection. The model enforces the (clamped) value
	 * as a hard cap; over-long output is truncated, not rejected. Omit to use the model
	 * default.
	 */
	maxOutputTokens?: number;
}

/** One block restored by an `unfoldResult`. */
export interface UnfoldRestored {
	/** The fold code the agent referenced (the block now held unfolded). */
	code: string;
	kind: WireBlock["kind"];
	/** Short human label for a useful confirmation, e.g. "tool_result read_file · turn 12". */
	label: string;
	/** The block ids this restore actually touched (≥1; >1 on a hash collision or a group unfold). */
	ids: string[];
}

/**
 * The GUI's reply to an `unfoldRequest` (protocol v3). `restored` lists the blocks
 * that resolved and are now held unfolded (NO content — the content returns to the
 * agent at its next `context` hook); `missing` lists codes the GUI could not resolve
 * to any folded block (unknown, or already full). The extension formats this into the
 * `unfold` tool's confirmation for the agent.
 */
export interface UnfoldResultMessage {
	type: "unfoldResult";
	reqId: number;
	restored: UnfoldRestored[];
	missing: string[];
}

/** One block's original full content returned by a `recallResult` (ADR 0011). */
export interface RecallContent {
	/** The fold code the agent referenced (the block stays folded — recall is read-only). */
	code: string;
	/** Short human label, e.g. "tool_result read_file · turn 12" or "group · 4 blocks". */
	label: string;
	/** The block's ORIGINAL full text (NOT the folded digest) — for a group, its members joined. */
	text: string;
	/** The block ids this content covers (≥1; >1 on a hash collision or a group recall). */
	ids: string[];
}

/**
 * The GUI's reply to a `recallRequest` (protocol v5, ADR 0011). `restored` carries the
 * ORIGINAL full content of each matched folded block (the agent gets it back THIS turn,
 * like a `read_file` result); `missing` lists codes the GUI could not resolve to any
 * folded block (unknown, or already full). This is a PURE READ — recall NEVER changes
 * fold state, so the standing view is untouched (the block stays folded in context).
 */
export interface RecallResultMessage {
	type: "recallResult";
	reqId: number;
	restored: RecallContent[];
	missing: string[];
}

export type ClientMessage = PlanMessage | UnfoldResultMessage | RecallResultMessage | CompleteRequestMessage;

// ── Helpers ──────────────────────────────────────────────────────────────────

export function isServerMessage(v: unknown): v is ServerMessage {
	if (!v || typeof v !== "object" || !("type" in v)) return false;
	const t = (v as any).type;
	return t === "hello" || t === "sync" || t === "stream" || t === "unfoldRequest" || t === "recallRequest" || t === "completeResult";
}

