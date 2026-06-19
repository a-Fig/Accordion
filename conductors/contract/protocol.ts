/*
 * protocol.ts — the Accordion ↔ Conductor WIRE (ADR 0007).
 *
 * The in-process contract is `./conductor.ts` (`conduct(view) → Command[]`) — the main
 * way. This file is the ESCAPE HATCH: the JSON messages a conductor running as its own
 * process — in any language — exchanges with Accordion over a WebSocket.
 *
 * Topology: the CONDUCTOR hosts the WebSocket endpoint and Accordion connects to it as a
 * CLIENT. (The app is a webview; it cannot host a server. It is already a client to the
 * pi extension — this mirrors that.) A local conductor advertises its `ws://` URL in
 * `~/.accordion/conductors/<id>.json` (see `registry.ts`); a remote one is a URL the user
 * configures. Either way Accordion dials out.
 *
 * The command vocabulary (`Command`), clamp reports (`ClampReport`), and the per-block
 * view (`ViewBlock`) are all imported from the sibling contract so the wire and the
 * in-process apply path share ONE definition — there is no separate wire representation of
 * a block or a fold to drift out of sync. A `context/update`'s payload IS a `ConductorView`.
 *
 * Keep this dependency-free and runtime-pure (type-only imports, erased at build): a
 * conductor author copies these shapes; they should not have to vendor the whole engine.
 * See `docs/conductor-protocol.md` for a copy-paste reference conductor.
 */
import type { Command, ClampReport, ViewBlock, LockName } from "./conductor";

/**
 * Bumped on any breaking change to the messages below. Independent of the pi wire's
 * PROTOCOL_VERSION. History:
 *  - v2: initial conductor protocol (ConductorView, Command vocab, cap/request).
 *  - v3: conductor lock declarations in `conductor/hello` (ADR 0011) plus the
 *        "complete" capability for out-of-band model completions over the wire.
 */
export const CONDUCTOR_PROTOCOL_VERSION = 3;

/**
 * How much of each block's content a conductor wants to receive (declared in
 * `conductor/hello`). Trust is full once connected, so this is a bandwidth/own-preference
 * choice, NOT a security boundary:
 *  - "full"     — every block's complete text (the default; most conductors want this).
 *  - "shape"    — structure only: kind, tokens, a one-line preview. No full text.
 *  - "onDemand" — structure only, and fetch full text per block via the `getContent` capability.
 */
export type ContentMode = "full" | "shape" | "onDemand";

// One block as the conductor sees it is `ViewBlock`, defined ONCE in `./conductor.ts`
// and imported above — the in-process built-in and the wire consume the identical shape.

// ─── host → conductor ────────────────────────────────────────────────────────

/** First frame Accordion sends after connecting: who it is and what session it's steering. */
export interface HostHelloMessage {
	type: "host/hello";
	conductorProtocol: number;
	session: { title: string; model: string; cwd: string };
	budget: number;
	contextWindow: number | null;
}

/**
 * The context changed (a block streamed in, the budget or protect tail moved). The payload
 * IS a `ConductorView` — the same view the in-process built-in folder receives — plus a
 * monotonic `rev` the conductor echoes in its reply so the host can spot a reply to a stale
 * snapshot. Carries the full block list each time (the conductor's complete field of view).
 */
export interface ContextUpdateMessage {
	type: "context/update";
	rev: number;
	budget: number;
	contextWindow: number | null;
	liveTokens: number;
	/** First protected-tail index (host policy the conductor may honour or ignore). */
	protectedFromIndex: number;
	/** The protected-tail token target driving `protectedFromIndex`. */
	protectTokens: number;
	blocks: ViewBlock[];
}

/** What the host clamped from the conductor's last batch (provider-validity floor). */
export interface CommandResultMessage {
	type: "host/commandResult";
	rev: number;
	reports: ClampReport[];
}

/**
 * Answer to a `cap/request`. `ok:false` carries an `error` string instead of `value`.
 *
 * For a "complete" result:
 *  - `value` carries the completion text (the model's output).
 *  - `model` carries the model id that ran (resolved from `request.completion.model`).
 *  - `inputTokens` / `outputTokens` carry host-counted usage, when available — for the
 *    conductor's own accounting (e.g. tracking distillation spend across turns).
 *  - `error` is present (and `value` absent) when the call failed (no model link,
 *    key resolution error, model error, or the conductor closed before the reply arrived).
 */
export interface CapResultMessage {
	type: "cap/result";
	reqId: string;
	ok: boolean;
	value?: string | number;
	error?: string;
	/** Present on a successful "complete" result: the model id that actually ran. */
	model?: string;
	/** Present on a "complete" result: host-counted input token usage, when available. */
	inputTokens?: number;
	/** Present on a "complete" result: host-counted output token usage, when available. */
	outputTokens?: number;
}

/**
 * Something happened that the conductor should know about but did not initiate:
 *  - "agentUnfold"   — the live agent called `unfold` and pulled blocks back to full;
 *  - "humanOverride" — the human pinned/folded/unfolded by hand (their choice always wins).
 *
 * `ids` are BLOCK IDS in both cases (the same ids that appear in `ViewBlock.id`), so a
 * conductor can correlate them directly against the blocks it received in `context/update`.
 * For `agentUnfold`, all block ids that mapped to the restored fold codes are included (a
 * short hash can rarely collide, so multiple ids per code are possible).
 */
export interface HostEventMessage {
	type: "host/event";
	event: "agentUnfold" | "humanOverride";
	ids: string[];
	detail?: string;
}

export type HostMessage =
	| HostHelloMessage
	| ContextUpdateMessage
	| CommandResultMessage
	| CapResultMessage
	| HostEventMessage;

// ─── conductor → host ────────────────────────────────────────────────────────

/** The conductor's opening frame: identity + what content it wants. */
export interface ConductorHelloMessage {
	type: "conductor/hello";
	conductorProtocol: number;
	id: string;
	label: string;
	wants?: { content: ContentMode };
	/** Involvement locks this conductor declares (ADR 0011). Omitted/empty ⇒ collaborative. */
	locks?: LockName[];
}

/**
 * The conductor's complete desired state, as imperative commands. The host resets to the
 * raw baseline and applies this batch, so each message is a full intention (not a diff).
 * `rev` (if set) is the `context/update` it is responding to.
 */
export interface ConductorCommandsMessage {
	type: "conductor/commands";
	rev?: number;
	commands: Command[];
}

/**
 * Ask the host to do something only it can (it owns the engine + tokenizer + model
 * link). The host answers with a `cap/result` carrying the same `reqId`.
 *  - "summarize"   — engine digest for `ids` (a single block, or a group head).
 *  - "countTokens" — token estimate for `text`.
 *  - "getContent"  — full text of block `ids[0]` (for `wants:"onDemand"`).
 *  - "getDigest"   — the engine's per-kind folded digest for block `ids[0]` (incl. the {#code FOLDED} tag).
 *  - "complete"    — run a model completion on the user's live session model; the host
 *                    fulfils it via `ConductorHost.complete` (see `conductor.ts`). The
 *                    result arrives in `cap/result.value` (the completion text), with
 *                    optional `model`/`inputTokens`/`outputTokens` usage fields. Rejected
 *                    (ok:false) if no live model link or the model call fails.
 *
 * NOTE on AbortSignal: `AbortSignal` is NOT serializable, so wire-side per-request
 * cancellation is NOT supported in this version. A wire conductor that no longer wants a
 * result should simply ignore the arriving `cap/result` by `reqId`. The in-process path
 * (`ConductorHost.complete`) supports `AbortSignal` fully via `CompletionRequest.signal`.
 */
export interface CapRequestMessage {
	type: "cap/request";
	reqId: string;
	capability: "summarize" | "countTokens" | "getContent" | "getDigest" | "complete";
	ids?: string[];
	text?: string;
	/**
	 * Present when `capability === "complete"`. The prompt to run — same semantics as
	 * `CompletionRequest` in `conductor.ts` (system/prompt/maxOutputTokens), but without
	 * the in-process-only `signal` and `model` fields. The host uses the user's live
	 * session model.
	 */
	completion?: {
		system?: string;
		prompt: string;
		maxOutputTokens?: number;
	};
}

/**
 * Display-only telemetry the conductor wants the host to surface to a human. PURELY
 * informational: the host renders `text` (and may use `metrics`) somewhere unobtrusive and
 * does NOTHING else — it never folds, alters commands, or triggers a model call on this.
 *
 * Generic by design (no privileged surface): any conductor may emit it, the host treats the
 * payload opaquely, and a conductor that never sends one simply shows no readout. Additive
 * and non-breaking — it carries no `rev` and expects no reply, so an older host that doesn't
 * recognise the type just ignores it.
 *  - "text"    — a one-line human summary (e.g. "82% full · holding · band 70–90% · 14 folded").
 *  - "metrics" — optional structured key/values, for a host that wants to render them itself.
 */
export interface ConductorStatusMessage {
	type: "conductor/status";
	text?: string;
	metrics?: Record<string, number | string | boolean>;
}

export type ConductorMessage =
	| ConductorHelloMessage
	| ConductorCommandsMessage
	| CapRequestMessage
	| ConductorStatusMessage;

// ─── guards ───────────────────────────────────────────────────────────────────

export function isConductorMessage(m: unknown): m is ConductorMessage {
	if (!m || typeof m !== "object") return false;
	const t = (m as { type?: unknown }).type;
	return (
		t === "conductor/hello" ||
		t === "conductor/commands" ||
		t === "cap/request" ||
		t === "conductor/status"
	);
}

export function isHostMessage(m: unknown): m is HostMessage {
	if (!m || typeof m !== "object") return false;
	const t = (m as { type?: unknown }).type;
	return (
		t === "host/hello" ||
		t === "context/update" ||
		t === "host/commandResult" ||
		t === "cap/result" ||
		t === "host/event"
	);
}
