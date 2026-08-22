/*
 * sidecar.ts — host the UNCHANGED pi extension (`accordion.ts`) for a harness that is NOT pi.
 *
 * The contract is `docs/sidecar-protocol.md` (v1). A host harness — today the mistral-vibe fork —
 * spawns `node <ACCORDION_HOME>/extension/sidecar.mjs` with cwd = the session cwd and speaks
 * JSON-lines over stdin/stdout. This file:
 *
 *   1. redirects console.log/info/debug to STDERR before any extension code runs (stdout is the
 *      protocol channel and NOTHING else may ever be written to it),
 *   2. shims the exact `pi` + `ctx` surface `accordion.ts` consumes (the same shape
 *      `extension/smoke.mjs` fakes),
 *   3. converts vibe-native `LLMMessage` JSON to pi's `PiMessage` shape on the way IN and back to
 *      the ORIGINAL LLMMessage JSON on the way OUT (see "Conversion" in the doc). The extension
 *      inside the sidecar only ever sees pi shapes; the Python side never learns pi's types.
 *
 * WHY THE BUNDLE SITS AT `extension/sidecar.mjs`, NEXT TO `accordion.js`
 * `accordion.ts` resolves four things relative to `import.meta.url`: the desktop app binary
 * (`repoAppCandidates`), the browser-served client root (`resolveClientRoot` → `dist/client` or
 * `../app/build`), its skill directories, and the out-of-process conductor runners
 * (`../conductors/ws`). Emitting the sidecar one directory deeper would silently break every one of
 * them (most visibly: no browser UI). The build therefore writes a SIBLING of `accordion.js`.
 *
 * NOTHING HERE IS PI-SPECIFIC BEYOND THE SHIM. Accordion is the first and only extension loaded
 * today, but the shim is the generic pi surface, so the harness ends up "pi-hook compatible" for
 * the hooks it can cheaply emit.
 */

// ── stdout discipline ────────────────────────────────────────────────────────
// FIRST statement of the module. `accordion.ts` is loaded via a DYNAMIC import below precisely so
// that this runs before any of its module-level code — a single stray `console.log` from an
// extension would corrupt the protocol stream and desync the harness's line reader.
const realStdoutWrite = process.stdout.write.bind(process.stdout);
console.log = (...a: unknown[]) => console.error(...a);
console.info = (...a: unknown[]) => console.error(...a);
console.debug = (...a: unknown[]) => console.error(...a);

import { estTokens } from "../core/tokens";
import { PROTOCOL_VERSION } from "../core/protocol";
import type { PiMessage, PiPart } from "../core/wire";

// ── wire I/O ─────────────────────────────────────────────────────────────────
/** Every message the sidecar emits goes through here (and ONLY here). */
function send(msg: Record<string, unknown>): void {
	let line: string;
	try {
		line = JSON.stringify(msg);
	} catch (err) {
		console.error("[sidecar] failed to serialize an outgoing message:", err);
		return;
	}
	try {
		realStdoutWrite(line + "\n");
	} catch (err) {
		console.error("[sidecar] failed to write to stdout:", err);
	}
}

// ── harness/session state ────────────────────────────────────────────────────
type Level = "info" | "warning" | "error";
const LEVELS = new Set<Level>(["info", "warning", "error"]);

/** The vibe-native message shape, modelled loosely (we only read the fields we convert). */
interface LLMMessage {
	role?: string;
	content?: unknown;
	reasoning_content?: unknown;
	reasoning_payloads?: unknown;
	tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> | null;
	tool_call_id?: string;
	name?: string;
	message_id?: string;
	[k: string]: unknown;
}

/**
 * The source-index tag we stamp on every converted PiMessage so `hook_result{messages}` can be
 * mapped back onto the ORIGINAL LLMMessage JSON (preserving images, `reasoning_payloads`,
 * `user_display_content`, `tool_result`, … byte for byte).
 *
 * It MUST be an ordinary enumerable string-keyed property, not a Symbol and not non-enumerable:
 * `core/wire.ts`'s `foldOne` clones a folded message with `{ ...m, content: parts }`, and object
 * spread copies exactly the own ENUMERABLE string/symbol keys. (Symbols would survive too, but a
 * plain key keeps this greppable and JSON-visible while debugging.) Messages `applyPlan` leaves
 * alone pass through BY REFERENCE, so they keep the tag trivially; the only untagged entries in the
 * output are the synthetic recap/summary messages a group collapse INSERTS — which is exactly the
 * signal we want (see `fromPi`). Verified against `applyPlan`/`foldOne` in `core/wire.ts`.
 */
const SRC = "__accordionSrcIndex";

let model: { id?: string; provider?: string; contextWindow?: number } = {};
/** Latest `usage` message, consumed by `ctx.getContextUsage()` and the calibration pairing. */
let usage: { promptTokens?: number; completionTokens?: number; contextWindow?: number } | null = null;
/**
 * Calibration pairing window. Set by a `usage` message, CLEARED by the next `context` request and
 * consumed by the next assistant `message_end`. So a usage report only ever pairs with an assistant
 * message finalized after it and before the next model call — see the report / the doc's `usage` row.
 */
let pendingUsage: { input: number; output: number } | null = null;
/** The current system prompt text (from the vibe `system` message), fed to `ctx.getSystemPrompt()`. */
let systemPromptText: string | null = null;
/** The ORIGINAL system LLMMessage, re-inserted at index 0 of every replacement wire, unchanged. */
let systemSource: LLMMessage | null = null;
/** The source array + converted PiMessages of the most recent conversion (back-conversion basis). */
let lastSource: LLMMessage[] = [];
/** What `ctx.sessionManager.buildSessionContext()` reports — the extension's view of history. */
let sessionMessages: PiMessage[] = [];
/** Cheap estimate of the last converted context, the `getContextUsage` fallback when no `usage` seen. */
let lastContextEst = 0;
let shuttingDown = false;

// ── the `pi` shim ────────────────────────────────────────────────────────────
type Handler = (event: any, ctx: any) => unknown;
const handlers = new Map<string, Handler>();
const tools = new Map<string, any>();
const commands = new Map<string, any>();
const flagDefs = new Map<string, any>();
const flagValues = new Map<string, unknown>();

const pi = {
	on(name: string, fn: Handler) {
		handlers.set(name, fn);
	},
	registerTool(def: any) {
		if (def && typeof def.name === "string") tools.set(def.name, def);
	},
	registerCommand(name: string, def: any) {
		if (typeof name === "string") commands.set(name, def);
	},
	registerFlag(name: string, def: any) {
		flagDefs.set(name, def ?? {});
	},
	getFlag(name: string) {
		if (flagValues.has(name)) return flagValues.get(name);
		return flagDefs.get(name)?.default;
	},
	appendEntry(entry: unknown) {
		send({ type: "append_entry", entry: entry as Record<string, unknown> });
	},
};

// ── the `ctx` shim ───────────────────────────────────────────────────────────
const ctx = {
	ui: {
		notify(message: unknown, level?: unknown) {
			const lvl = LEVELS.has(level as Level) ? (level as Level) : "info";
			send({ type: "notify", message: String(message ?? ""), level: lvl });
		},
		setStatus(_key: unknown, text?: unknown) {
			send({ type: "status", text: String(text ?? "") });
		},
		theme: { fg: (_color: unknown, s: unknown) => s },
	},
	get model() {
		return model;
	},
	getContextUsage() {
		if (usage) {
			const t = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
			return { tokens: t, contextWindow: usage.contextWindow ?? model.contextWindow };
		}
		// v1 fallback the protocol allows: our own estimate of the last converted context.
		return { tokens: lastContextEst, contextWindow: model.contextWindow };
	},
	getSystemPrompt() {
		return systemPromptText ?? undefined;
	},
	sessionManager: {
		// `accordion.ts:readSessionMessages` prefers this (pi's own resolver). Returning the last
		// converted array is the sidecar's equivalent: exactly what the next model call would see.
		buildSessionContext() {
			return { messages: sessionMessages };
		},
	},
	// Conductor `complete()` relay is NOT wired in v1. `runCompletion` resolves credentials through
	// this before it ever reaches `dependencies.complete`, so declining here is the single, clear
	// rejection point — the conductor sees `could not resolve API key: <reason>` instead of a
	// TypeError from a missing shim. See the report / doc follow-up.
	modelRegistry: {
		async getApiKeyAndHeaders() {
			return {
				ok: false,
				error: "the Accordion sidecar does not relay conductor completions (no provider credentials); see docs/sidecar-protocol.md",
			};
		},
	},
};

// ── conversion: vibe LLMMessage → pi PiMessage ───────────────────────────────
/** Concatenate the text of a vibe `content` value (string, or a list of typed chunks). */
function vibeText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const c of content) {
			if (typeof c === "string") parts.push(c);
			else if (c && typeof c === "object" && typeof (c as any).text === "string") parts.push((c as any).text);
			// images / non-text chunks are dropped from the VIEW; the wire keeps them (fromPi
			// only ever overwrites `content` when the text actually changed).
		}
		return parts.join("");
	}
	return "";
}

/** Read the text of a PiMessage (string content, or the text parts of an array content). */
function piText(m: PiMessage): string {
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		const parts: string[] = [];
		for (const p of m.content as PiPart[]) {
			if (p && (p as any).type === "text" && typeof (p as any).text === "string") parts.push((p as any).text);
		}
		return parts.join("");
	}
	return "";
}

/** Read the thinking text of a PiMessage, or null when it carries no thinking part. */
function piThinking(m: PiMessage): string | null {
	if (!Array.isArray(m.content)) return null;
	for (const p of m.content as PiPart[]) {
		if (p && (p as any).type === "thinking" && typeof (p as any).thinking === "string") return (p as any).thinking;
	}
	return null;
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === "object") return raw as Record<string, unknown>;
	if (typeof raw === "string") {
		try {
			const v = JSON.parse(raw);
			if (v && typeof v === "object") return v as Record<string, unknown>;
		} catch {
			/* a non-JSON argument string is kept verbatim under a single key so the fingerprint
			   still covers it (it is never sent back to the harness — tool_calls pass through
			   untouched in `fromPi`). */
		}
		return { __raw: raw };
	}
	return {};
}

/**
 * Convert ONE vibe message. Returns null for a `system` message (it is the bolted system PROMPT,
 * not a PiMessage — `ctx.getSystemPrompt()` carries it) and for anything that yields no wire
 * content at all.
 *
 * `srcIndex >= 0` stamps the back-conversion tag; pass -1 for a conversion whose output never
 * returns to the harness (`message_end` / `agent_end` / `turn_end` ingest paths).
 */
function toPiOne(m: LLMMessage, srcIndex: number): PiMessage | null {
	if (!m || typeof m !== "object") return null;
	const role = typeof m.role === "string" ? m.role : "user";
	const messageId = typeof m.message_id === "string" ? m.message_id : undefined;
	const tag = srcIndex >= 0 ? { [SRC]: srcIndex } : {};

	if (role === "system") return null;

	if (role === "assistant") {
		const parts: PiPart[] = [];
		// Payload-bearing reasoning is provider-opaque: it must never be represented (and therefore
		// never folded), or restoring it would produce a wire the provider rejects.
		const reasoning = m.reasoning_content;
		if (m.reasoning_payloads == null && typeof reasoning === "string" && reasoning.length > 0) {
			parts.push({ type: "thinking", thinking: reasoning });
		}
		const text = vibeText(m.content);
		if (text.length > 0) parts.push({ type: "text", text });
		for (const tc of m.tool_calls ?? []) {
			if (!tc) continue;
			parts.push({
				type: "toolCall",
				id: typeof tc.id === "string" ? tc.id : "",
				name: typeof tc.function?.name === "string" ? tc.function.name : "",
				arguments: parseToolArgs(tc.function?.arguments),
			});
		}
		if (!parts.length) return null;
		// `responseId` is `blockId`'s first anchor for assistant parts; vibe has one id per message,
		// so both fields carry it (the doc's Conversion section).
		return { role: "assistant", content: parts, responseId: messageId, messageId, ...tag } as PiMessage;
	}

	if (role === "tool") {
		const callId = typeof m.tool_call_id === "string" ? m.tool_call_id : undefined;
		const isError = m.is_error === true || m.isError === true;
		return {
			role: "toolResult",
			toolCallId: callId,
			toolName: typeof m.name === "string" ? m.name : undefined,
			content: vibeText(m.content),
			isError,
			messageId,
			...tag,
		} as PiMessage;
	}

	// `user`, and anything else (a `context_boundary:"compaction"` message included — the doc says
	// those ride as ordinary user messages).
	return { role: "user", content: vibeText(m.content), messageId, ...tag } as PiMessage;
}

/**
 * Convert a whole vibe array. Captures the system prompt + its original message as a side effect
 * (both are needed to answer a `context` request) and records a cheap token estimate for the
 * `getContextUsage` fallback.
 */
function toPi(messages: unknown, tagged: boolean): PiMessage[] {
	const src = Array.isArray(messages) ? (messages as LLMMessage[]) : [];
	const out: PiMessage[] = [];
	let sysText: string | null = null;
	let sysMsg: LLMMessage | null = null;
	let est = 0;
	src.forEach((m, i) => {
		if (m && m.role === "system") {
			sysText = vibeText(m.content);
			sysMsg = m;
			est += estTokens(sysText);
			return;
		}
		const pm = toPiOne(m, tagged ? i : -1);
		if (pm) {
			out.push(pm);
			est += estTokens(piText(pm)) + estTokens(piThinking(pm) ?? "");
		}
	});
	if (tagged) {
		lastSource = src;
		lastContextEst = est;
		// A harness that stops sending a system message clears the prompt: `Truth.setSystemPrompt`
		// is the only writer of the bolted block, and a stale prompt would keep counting tokens.
		systemPromptText = sysText;
		systemSource = sysMsg;
	}
	return out;
}

// ── back-conversion: pi PiMessage → the ORIGINAL vibe LLMMessage ─────────────
/**
 * Rebuild the vibe wire from the extension's replacement PiMessage array.
 *
 * Every message that still carries the `SRC` tag is emitted as its ORIGINAL LLMMessage JSON with
 * ONLY `content` / `reasoning_content` overwritten — and only when the text actually changed, so an
 * untouched message keeps its exact original `content` value (chunk lists, images and all). An
 * UNTAGGED message is a recap/summary the wire INSERTED (a group collapse, or the role-validity
 * floor's stub) and becomes a minimal LLMMessage.
 *
 * The system message is re-inserted at index 0 byte-identical, because `toPi` removed it (it is the
 * bolted system PROMPT, never a PiMessage — `Truth` folds nothing there by definition).
 */
function fromPi(out: PiMessage[]): LLMMessage[] {
	const result: LLMMessage[] = [];
	if (systemSource) result.push(systemSource);
	for (const m of out) {
		const idx = (m as any)[SRC];
		const orig = typeof idx === "number" ? lastSource[idx] : undefined;
		if (!orig) {
			// DEVIATION from the doc's literal `{role:"user", content}`: the inserted message keeps
			// its own role mapped to assistant/user. `applyPlan` picks that role deliberately to
			// keep the surviving wire role-valid (no leading non-user, no same-role adjacency);
			// forcing every insert to "user" would re-introduce the exact adjacency its
			// role-validity floor exists to prevent. See the report.
			result.push({ role: m.role === "assistant" ? "assistant" : "user", content: piText(m) });
			continue;
		}
		const next: LLMMessage = { ...orig };
		const newText = piText(m);
		if (newText !== vibeText(orig.content)) next.content = newText;
		const newThinking = piThinking(m);
		if (newThinking !== null && newThinking !== orig.reasoning_content) next.reasoning_content = newThinking;
		result.push(next);
	}
	return result;
}

// ── hook dispatch ────────────────────────────────────────────────────────────
function applyModelFrom(m: unknown): void {
	if (!m || typeof m !== "object") return;
	const src = m as { id?: string; provider?: string; contextWindow?: number };
	model = {
		id: typeof src.id === "string" ? src.id : model.id,
		provider: typeof src.provider === "string" ? src.provider : model.provider,
		contextWindow: typeof src.contextWindow === "number" && src.contextWindow > 0 ? src.contextWindow : model.contextWindow,
	};
}

async function call(name: string, event: unknown): Promise<unknown> {
	const fn = handlers.get(name);
	if (!fn) return undefined;
	return await fn(event, ctx);
}

/** Call a hook and swallow anything it throws — a hook must never take the sidecar down. */
async function callSafe(name: string, event: unknown): Promise<unknown> {
	try {
		return await call(name, event);
	} catch (err) {
		console.error(`[sidecar] hook ${name} threw:`, err);
		return undefined;
	}
}

/**
 * The `context` hook — the ONE blocking request. It MUST answer, even on a throw (reply `null` =
 * passthrough), because the harness's model call is waiting on it behind a 250 ms timeout.
 */
async function handleContext(msg: any): Promise<void> {
	const req = msg.req;
	let reply: LLMMessage[] | null = null;
	try {
		applyModelFrom(msg.model);
		// Convert BEFORE dispatch: the handler reads the system prompt off `ctx.getSystemPrompt()`
		// (via `refreshFromCtx`) during the very call we are about to make.
		const converted = toPi(msg.messages, true);
		sessionMessages = converted;
		pendingUsage = null; // a new model call opens a fresh calibration window
		const ret = (await call("context", { messages: converted })) as { messages?: PiMessage[] } | undefined;
		if (ret && Array.isArray(ret.messages)) reply = fromPi(ret.messages);
	} catch (err) {
		console.error("[sidecar] context hook failed; replying passthrough:", err);
		reply = null;
	}
	if (req !== undefined) send({ type: "hook_result", req, messages: reply });
}

async function handleTool(msg: any): Promise<void> {
	const req = msg.req;
	const def = tools.get(String(msg.name));
	if (!def || typeof def.execute !== "function") {
		send({ type: "tool_result", req, content: `unknown tool: ${msg.name}`, isError: true });
		return;
	}
	try {
		const callId = typeof msg.toolCallId === "string" ? msg.toolCallId : `sidecar-${String(req)}`;
		const args = msg.args && typeof msg.args === "object" ? msg.args : {};
		const res = await def.execute(callId, args, new AbortController().signal, () => {}, ctx);
		const content = Array.isArray(res?.content)
			? res.content.filter((c: any) => c && c.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n")
			: typeof res?.content === "string"
				? res.content
				: "";
		send({ type: "tool_result", req, content, isError: res?.isError === true });
	} catch (err) {
		send({ type: "tool_result", req, content: `tool ${msg.name} failed: ${String(err)}`, isError: true });
	}
}

async function handleCommand(msg: any): Promise<void> {
	const req = msg.req;
	const def = commands.get(String(msg.name));
	if (!def || typeof def.handler !== "function") {
		send({ type: "command_result", req, ok: false, error: `unknown command: ${msg.name}` });
		return;
	}
	try {
		// `ctx.ui.notify` inside the handler already streams out as `notify` messages — they
		// therefore arrive strictly before this result, as the protocol requires.
		await def.handler(typeof msg.args === "string" ? msg.args : "", ctx);
		send({ type: "command_result", req, ok: true });
	} catch (err) {
		send({ type: "command_result", req, ok: false, error: String(err) });
	}
}

function sendReady(): void {
	send({
		type: "ready",
		v: 1,
		protocolVersion: PROTOCOL_VERSION,
		tools: [...tools.values()].map((t) => ({
			name: t.name,
			description: typeof t.description === "string" ? t.description : "",
			// typebox schemas ARE plain JSON Schema objects, so this serializes as-is.
			parameters: t.parameters ?? { type: "object", properties: {} },
		})),
		commands: [...commands.entries()].map(([name, def]) => ({
			name,
			description: typeof def?.description === "string" ? def.description : "",
		})),
		flags: [...flagDefs.entries()].map(([name, def]) => ({
			name,
			description: typeof def?.description === "string" ? def.description : "",
			default: def?.default ?? null,
		})),
	});
	// The arm is OFF at birth and `setFolding` only fires the seam on a real CHANGE, so state the
	// initial value explicitly — the harness must know from message one whether to run its own
	// compaction middleware.
	send({ type: "folding", enabled: false });
}

async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	await callSafe("session_shutdown", {});
	// Give stdout a beat to flush (a Windows pipe write is asynchronous) and let the extension's
	// servers close, then leave — an extension timer must never keep the sidecar alive.
	setTimeout(() => process.exit(0), 200);
}

async function handle(msg: any): Promise<void> {
	switch (msg.type) {
		// ── lifecycle ──────────────────────────────────────────────────────────
		case "hello": {
			applyModelFrom(msg.model);
			if (msg.flags && typeof msg.flags === "object") {
				for (const [k, v] of Object.entries(msg.flags)) flagValues.set(k, v);
			}
			// `session_start` captures `process.cwd()` for the registry entry; align it with the
			// harness's session cwd when the spawn used a different one. Best-effort.
			if (typeof msg.cwd === "string" && msg.cwd && msg.cwd !== process.cwd()) {
				try {
					process.chdir(msg.cwd);
				} catch (err) {
					console.error("[sidecar] could not chdir to the harness cwd:", err);
				}
			}
			sendReady();
			return;
		}
		case "shutdown":
			await shutdown();
			return;

		// ── pi hooks ───────────────────────────────────────────────────────────
		case "session_start": {
			// Seed the extension's view BEFORE the hook: `session_start` builds the Truth from
			// `ctx.sessionManager.buildSessionContext()`.
			sessionMessages = toPi(msg.messages, true);
			await callSafe("session_start", { reason: msg.reason ?? "start" });
			return;
		}
		case "session_shutdown":
			await shutdown();
			return;
		case "session_before_compact": {
			const ret = (await callSafe("session_before_compact", {})) as { cancel?: boolean } | undefined;
			if (msg.req !== undefined) send({ type: "hook_result", req: msg.req, cancel: ret?.cancel === true });
			return;
		}
		case "session_compact":
			await callSafe("session_compact", { summary: msg.summary });
			return;
		case "before_agent_start": {
			const ret = (await callSafe("before_agent_start", { prompt: msg.prompt })) as { systemPrompt?: string } | undefined;
			if (msg.req !== undefined) {
				const sp = typeof ret?.systemPrompt === "string" ? { systemPrompt: ret.systemPrompt } : {};
				send({ type: "hook_result", req: msg.req, ...sp });
			}
			return;
		}
		case "agent_start":
			await callSafe("agent_start", {});
			return;
		case "agent_end": {
			// Run-local messages, never returned to the harness → untagged conversion.
			const msgs = (Array.isArray(msg.messages) ? msg.messages : [])
				.map((m: LLMMessage) => toPiOne(m, -1))
				.filter((m: PiMessage | null): m is PiMessage => m !== null);
			await callSafe("agent_end", { messages: msgs });
			return;
		}
		case "turn_start":
			await callSafe("turn_start", { turnIndex: msg.turnIndex });
			return;
		case "turn_end":
			await callSafe("turn_end", {});
			return;
		case "message_start":
			await callSafe("message_start", {});
			return;
		case "message_update":
			// `accordion.ts` reads only `event.assistantMessageEvent` (stream lifecycle frames), which
			// vibe does not emit — dispatch anyway so a future harness that does is already wired.
			await callSafe("message_update", { assistantMessageEvent: msg.assistantMessageEvent });
			return;
		case "message_end": {
			const pm = toPiOne(msg.message ?? {}, -1);
			if (!pm) return;
			// Calibration pairing (opt-in, ADR 0025): attach the provider's real usage for the model
			// call this message came out of. `pendingUsage` is set by a `usage` message and cleared by
			// the next `context` request, so it can only ever describe THIS call.
			if (pm.role === "assistant" && pendingUsage) {
				(pm as any).usage = { input: pendingUsage.input, output: pendingUsage.output };
				pendingUsage = null;
			}
			await callSafe("message_end", { message: pm });
			return;
		}
		case "tool_execution_start":
			await callSafe("tool_execution_start", { toolCallId: msg.toolCallId, toolName: msg.toolName, args: msg.args });
			return;
		case "tool_execution_end":
			await callSafe("tool_execution_end", { toolCallId: msg.toolCallId, toolName: msg.toolName, result: msg.result, isError: msg.isError });
			return;
		case "tool_call": {
			const ret = (await callSafe("tool_call", { toolCallId: msg.toolCallId, toolName: msg.toolName, args: msg.args })) as
				| { block?: boolean; reason?: string; args?: object }
				| undefined;
			if (msg.req !== undefined) send({ type: "hook_result", req: msg.req, ...(ret && typeof ret === "object" ? ret : {}) });
			return;
		}
		case "context":
			await handleContext(msg);
			return;
		case "model_select": {
			applyModelFrom(msg.model);
			await callSafe("model_select", { model: msg.model, previous: msg.previous, source: msg.source });
			return;
		}
		case "resources_discover": {
			const ret = (await callSafe("resources_discover", {})) as
				| { skillPaths?: string[]; promptPaths?: string[]; themePaths?: string[] }
				| undefined;
			if (msg.req !== undefined) {
				send({
					type: "hook_result",
					req: msg.req,
					skillPaths: ret?.skillPaths ?? [],
					promptPaths: ret?.promptPaths ?? [],
					themePaths: ret?.themePaths ?? [],
				});
			}
			return;
		}
		case "usage": {
			const promptTokens = typeof msg.promptTokens === "number" ? msg.promptTokens : 0;
			const completionTokens = typeof msg.completionTokens === "number" ? msg.completionTokens : 0;
			usage = { promptTokens, completionTokens, contextWindow: typeof msg.contextWindow === "number" ? msg.contextWindow : undefined };
			if (promptTokens > 0) pendingUsage = { input: promptTokens, output: completionTokens };
			return;
		}

		// ── extension-registered things ────────────────────────────────────────
		case "tool":
			await handleTool(msg);
			return;
		case "command":
			await handleCommand(msg);
			return;

		default:
			console.error(`[sidecar] ignoring unknown message type: ${String(msg.type)}`);
	}
}

// ── the read loop ────────────────────────────────────────────────────────────
/**
 * Messages are processed strictly in arrival order: each `handle` is chained onto the previous
 * one's completion. Without this, an `await` inside `handle` would let a later line's handler
 * interleave — e.g. a `context` request converting `lastSource` out from under an in-flight one,
 * or a `message_end` ingesting before the `session_start` that builds the Truth.
 */
let queue: Promise<void> = Promise.resolve();
function enqueue(msg: any): void {
	queue = queue.then(() => handle(msg)).catch((err) => {
		// Belt and braces: `handle` already guards each hook, so reaching here means a bug in the
		// dispatch itself. It must still never break the loop.
		console.error("[sidecar] message handling failed:", err);
	});
}

let buffer = "";
/**
 * Attached only AFTER the extension has registered everything (see the bottom of this file): stdin
 * stays paused until a `data` listener exists, so nothing the harness wrote is lost, and no `hello`
 * can be dispatched against a half-registered `pi` shim.
 */
function startReadLoop(): void {
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		buffer += chunk;
		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const raw = buffer.slice(0, nl).replace(/\r$/, "");
			buffer = buffer.slice(nl + 1);
			if (!raw.trim()) continue;
			let msg: any;
			try {
				msg = JSON.parse(raw);
			} catch (err) {
				console.error("[sidecar] ignoring unparseable line:", err);
				continue;
			}
			if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
				console.error("[sidecar] ignoring a line with no string `type`");
				continue;
			}
			enqueue(msg);
		}
	});
	process.stdin.on("end", () => {
		enqueue({ type: "shutdown" });
	});
	process.stdin.on("error", (err) => {
		console.error("[sidecar] stdin error:", err);
		enqueue({ type: "shutdown" });
	});
}

// Nothing may escape into stdout, and nothing may take the process down mid-session: the harness
// treats a dead sidecar as "bridge absent" and loses the whole map, so we log and carry on.
process.on("uncaughtException", (err) => console.error("[sidecar] uncaught exception:", err));
process.on("unhandledRejection", (err) => console.error("[sidecar] unhandled rejection:", err));

// ── load the extension ───────────────────────────────────────────────────────
// DYNAMIC, so the console redirection at the top of this file is already in effect. The lazy
// `@earendil-works/pi-ai` import inside `accordion.ts` is only reached by the (unwired) completion
// relay, and `runCompletion` declines before it via the `modelRegistry` shim above — so its absence
// from `extension/node_modules` can never crash the sidecar.
const { default: accordionLive } = await import("./accordion");
accordionLive(pi as any, {
	onFoldingChanged: (enabled: boolean) => send({ type: "folding", enabled }),
});

// Every `register*` call has now run, so `ready` (emitted by the `hello` handler) can describe the
// real tool/command/flag surface. Only now do we start reading the harness.
startReadLoop();
