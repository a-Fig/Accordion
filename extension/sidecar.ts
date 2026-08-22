/*
 * sidecar.ts — host the UNCHANGED pi extension (`accordion.ts`) for a harness that is NOT pi.
 *
 * The contract is `docs/sidecar-protocol.md` (v1). A host harness — today the mistral-vibe fork —
 * spawns `node <ACCORDION_REPO>/extension/sidecar.mjs` with cwd = the session cwd and speaks
 * JSON-lines over stdin/stdout. This file:
 *
 *   1. redirects `process.stdout.write` itself to STDERR before any extension code runs (stdout is
 *      the protocol channel and NOTHING else may ever be written to it),
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
// Capture the real writer, then REDIRECT THE STREAM ITSELF. Overriding only console.log/info/debug
// leaves a whole class of leaks open — console.dir/table/group/count, `util.debuglog`, a dependency
// writing to the stream directly — and any one of them would inject a non-JSON line into the
// protocol channel and desync the harness's reader. After this, everything except `send()` (which
// holds `realStdoutWrite`) lands on stderr. The console overrides below are then redundant but kept
// as defence in depth, and because they keep the intent legible.
(process.stdout as { write: (...a: any[]) => boolean }).write = (...args: any[]) =>
	(process.stderr.write as (...a: any[]) => boolean).apply(process.stderr, args);
console.log = (...a: unknown[]) => console.error(...a);
console.info = (...a: unknown[]) => console.error(...a);
console.debug = (...a: unknown[]) => console.error(...a);

import { basename } from "node:path";
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
/**
 * The current system prompt text, fed to `ctx.getSystemPrompt()`.
 *
 * `""` (not null) once we have seen a conversion with NO leading system message: `accordion.ts`'s
 * `refreshFromCtx` only assigns when `getSystemPrompt()` returns a STRING, so returning `undefined`
 * would leave a previously-captured prompt standing as a stale bolted block whose tokens keep
 * counting (M6). `Truth.setSystemPrompt("", 0)` rewrites that block to empty/zero-token instead.
 * Known residual: `Truth` has no "remove the block" path, so a cleared prompt leaves an EMPTY bolted
 * block rather than no block at all — see docs/sidecar-protocol.md.
 */
let systemPromptText: string | null = null;
/** The ORIGINAL system LLMMessage (source index 0 only), re-inserted at index 0, unchanged. */
let systemSource: LLMMessage | null = null;
/** The source array of the most recent tagged conversion (the back-conversion basis). */
let lastSource: LLMMessage[] = [];
/**
 * What each source index of `lastSource` became, so `fromPi` can rebuild the wire without ever
 * DELETING a message (H1/H3/H4/M5):
 *   • "prompt"      — the leading system message; it is the bolted prompt, re-emitted at index 0.
 *   • "converted"   — it produced a PiMessage the extension can see, fold and group.
 *   • "passthrough" — the converter could not represent it (empty assistant turn, payload-only
 *                     reasoning, an id-less tool call, a duplicate tool_call_id, a LATER system
 *                     message). It never enters the pi array, so Accordion can neither fold nor drop
 *                     it — and `fromPi` re-interleaves the ORIGINAL at its source position.
 */
type SlotKind = "prompt" | "converted" | "passthrough";
let lastSlots: SlotKind[] = [];
/** What `ctx.sessionManager.buildSessionContext()` reports — the extension's view of history. */
let sessionMessages: PiMessage[] = [];
/** Cheap estimate of the last converted context, the `getContextUsage` fallback when no `usage` seen. */
let lastContextEst = 0;
/** The CURRENT folding arm, mirrored off the `onFoldingChanged` seam so `ready` can restate it. */
let foldingArm = false;
let helloSeen = false;
let shuttingDown = false;

/**
 * `RuntimeDependencies.harness` (accordion.ts) for this session — labels the registry entry
 * `harness: "vibe"` and (once known) a real title, for the Sessions sidebar's `pi | vibe | Claude
 * Code` source switcher (issue: sidecar sessions all showed up as the hardcoded pi title). Passed
 * to `accordionLive()` at IMPORT TIME, before any message has been read off stdin — so `title`
 * starts undefined and is filled in by the `hello` handler below, once the harness's session cwd is
 * known (post-chdir). This is safe because `accordion.ts` re-reads `dependencies.harness` fresh on
 * every `meta` rebuild (module load AND `session_start`) rather than caching it at call time, and
 * `session_start` is always sent strictly after `hello`/`ready` — so by the time it fires, this
 * mutation has already landed.
 */
const harnessDeps: { kind: "vibe"; title?: string } = { kind: "vibe" };

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
		// `null` = we have never converted anything, so we genuinely do not know — return undefined
		// and let the extension keep whatever it has. `""` = we HAVE converted and there was no
		// system message: that is a positive "cleared" signal and must reach `Truth` (M6).
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

/** Per-conversion anchor bookkeeping — see `toPiOne`'s duplicate-id handling (M5). */
interface AnchorScope {
	seenMessageIds: Set<string>;
	seenToolCallIds: Set<string>;
}
function newScope(): AnchorScope {
	return { seenMessageIds: new Set(), seenToolCallIds: new Set() };
}

/**
 * Convert ONE vibe message, or return `null` meaning UNREPRESENTABLE — the message carries no wire
 * content Accordion can model as blocks.
 *
 * `null` is never "delete it": every caller keeps the original and re-emits it verbatim (the
 * `"passthrough"` slot). Because such a message contributes no blocks, Accordion can neither fold
 * nor group-drop it, so passing it straight through is exactly right. The cases:
 *
 *   • a `system` message (the leading one is the bolted PROMPT; any later one is a passthrough — a
 *     `Truth` has exactly ONE system block, so hoisting or overwriting with a later one would
 *     delete or relocate real content: H3);
 *   • an assistant turn with nothing representable — empty content, payload-bearing reasoning only,
 *     an aborted empty turn, non-text-only content chunks (H1);
 *   • an assistant turn carrying a tool call with NO `id` (H4). `core/wire.ts messageInfo` records a
 *     call only when the toolCall part has a non-empty id, so an id-less call is invisible to the
 *     tool-pair fixpoint that keeps a group drop from orphaning its `tool` result. Making the whole
 *     message a passthrough keeps it — and therefore its pairing — off the removable set entirely;
 *   • a `tool` message repeating an ALREADY-SEEN `tool_call_id` (M5). `blockId` maps both to
 *     `r:<id>`, so `Truth.append` would drop the second while `applyPlan` folded BOTH — silent
 *     content loss. Suppressing the id instead is not an option here: `messageInfo` needs it for
 *     pair balance, so the duplicate becomes a passthrough.
 *
 * A duplicate `message_id` on a user/assistant/other message is handled differently: the id is
 * SUPPRESSED (no `messageId`, no `responseId`) so `blockId` falls back to its positional
 * `m<i>:…` form, which `isDurableId` rejects and `canFold` therefore refuses to fold. The message
 * stays fully visible in the map — just unfoldable — rather than mis-foldable (M5).
 *
 * `srcIndex >= 0` stamps the back-conversion tag; pass -1 for a conversion whose output never
 * returns to the harness (`message_end` / `agent_end` ingest paths).
 */
function toPiOne(m: LLMMessage, srcIndex: number, scope: AnchorScope): PiMessage | null {
	if (!m || typeof m !== "object") return null;
	const role = typeof m.role === "string" ? m.role : "user";
	const tag = srcIndex >= 0 ? { [SRC]: srcIndex } : {};

	// Duplicate message_id ⇒ suppress the anchor (positional, non-durable, unfoldable).
	const rawId = typeof m.message_id === "string" && m.message_id ? m.message_id : undefined;
	let messageId: string | undefined = rawId;
	if (rawId !== undefined) {
		if (scope.seenMessageIds.has(rawId)) messageId = undefined;
		else scope.seenMessageIds.add(rawId);
	}

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
			// H4: no usable id ⇒ the whole message is unrepresentable. Emitting `id:""` (or skipping
			// just this part) would leave a tool_call the pair fixpoint cannot see.
			if (typeof tc.id !== "string" || !tc.id) return null;
			parts.push({
				type: "toolCall",
				id: tc.id,
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
		const callId = typeof m.tool_call_id === "string" && m.tool_call_id ? m.tool_call_id : undefined;
		if (callId !== undefined) {
			if (scope.seenToolCallIds.has(callId)) return null; // M5 — duplicate `r:<id>`
			scope.seenToolCallIds.add(callId);
		}
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
 * Convert a whole vibe array for INGEST (`agent_end`) — untagged, no state captured, unrepresentable
 * messages simply contribute nothing (there is no wire to rebuild on this path).
 */
function toPiIngest(messages: unknown): PiMessage[] {
	const src = Array.isArray(messages) ? (messages as LLMMessage[]) : [];
	const scope = newScope();
	const out: PiMessage[] = [];
	src.forEach((m) => {
		const pm = toPiOne(m, -1, scope);
		if (pm) out.push(pm);
	});
	return out;
}

/**
 * Convert a whole vibe array and RECORD the back-conversion basis: `lastSource`, the per-index
 * `lastSlots` map, the system prompt + its original message, and a cheap token estimate for the
 * `getContextUsage` fallback. Every source index lands in exactly one slot, so `fromPi` can rebuild
 * the wire without ever losing a message.
 */
function toPiTagged(messages: LLMMessage[]): PiMessage[] {
	const scope = newScope();
	const out: PiMessage[] = [];
	const slots: SlotKind[] = new Array(messages.length).fill("passthrough");
	let sysText: string | null = null;
	let sysMsg: LLMMessage | null = null;
	let est = 0;
	messages.forEach((m, i) => {
		// H3: ONLY a system message at index 0 is the bolted prompt. `Truth` holds exactly one system
		// block; a later system message is content, and content is never hoisted or overwritten.
		if (i === 0 && m && m.role === "system") {
			sysText = vibeText(m.content);
			sysMsg = m;
			slots[i] = "prompt";
			est += estTokens(sysText);
			return;
		}
		const pm = toPiOne(m, i, scope);
		if (pm) {
			slots[i] = "converted";
			out.push(pm);
			est += estTokens(piText(pm)) + estTokens(piThinking(pm) ?? "");
		}
		// else: stays "passthrough" — re-emitted verbatim by `fromPi`.
	});
	lastSource = messages;
	lastSlots = slots;
	lastContextEst = est;
	// `""` (not null) when there is no leading system message: a positive "cleared" signal that
	// reaches `Truth.setSystemPrompt` — see `systemPromptText`'s declaration (M6).
	systemPromptText = sysText ?? "";
	systemSource = sysMsg;
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
 * The leading system message is re-inserted at index 0 byte-identical, because `toPiTagged` removed
 * it (it is the bolted system PROMPT, never a PiMessage — `Truth` folds nothing there by definition).
 *
 * PASSTHROUGH RE-INTERLEAVING (H1/H3/H4/M5). A source message the converter could not represent
 * produced no PiMessage and therefore no block, so it can appear in NEITHER the tagged output nor a
 * fold/group op — but it is still real wire content and MUST survive. `lastSlots` records where
 * those messages were; as we walk the output we flush every not-yet-emitted `"passthrough"` source
 * that sits before the message we are about to emit, then a final flush drains the tail. Converted
 * sources the wire deliberately DROPPED (a group collapse) are skipped by the same walk, because
 * only `"passthrough"` slots are ever re-emitted.
 */
function fromPi(out: PiMessage[]): LLMMessage[] {
	const result: LLMMessage[] = [];
	let nextSrc = 0;
	/** Emit every passthrough source in `[nextSrc, limit)` and advance the cursor past them. */
	const flushUpTo = (limit: number) => {
		while (nextSrc < limit) {
			if (lastSlots[nextSrc] === "passthrough") result.push(lastSource[nextSrc]);
			nextSrc++;
		}
	};
	if (systemSource) {
		result.push(systemSource);
		nextSrc = 1; // slot 0 is the prompt and has just been emitted
	}
	for (const m of out) {
		const idx = (m as any)[SRC];
		const orig = typeof idx === "number" ? lastSource[idx] : undefined;
		if (!orig) {
			// DEVIATION from the doc's literal `{role:"user", content}`: the inserted message keeps
			// its own role mapped to assistant/user. `applyPlan` picks that role deliberately to
			// keep the surviving wire role-valid (no leading non-user, no same-role adjacency);
			// forcing every insert to "user" would re-introduce the exact adjacency its
			// role-validity floor exists to prevent. See the doc.
			result.push({ role: m.role === "assistant" ? "assistant" : "user", content: piText(m) });
			continue;
		}
		flushUpTo(idx);
		const next: LLMMessage = { ...orig };
		const newText = piText(m);
		if (newText !== vibeText(orig.content)) next.content = newText;
		const newThinking = piThinking(m);
		if (newThinking !== null && newThinking !== orig.reasoning_content) next.reasoning_content = newThinking;
		result.push(next);
		// `Math.max`, not a bare assignment: the walk assumes non-decreasing source indices (nothing
		// in `applyPlan` reorders), and this keeps a future op that DID reorder from rewinding the
		// cursor and re-emitting an already-flushed passthrough twice.
		nextSrc = Math.max(nextSrc, idx + 1);
	}
	flushUpTo(lastSource.length);
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
	// H2: a malformed or EMPTY `messages` is not a context to fold — it is a request we cannot
	// answer. Reply passthrough BEFORE touching any state: converting it would coerce to `[]`, wipe
	// `lastSource`/`systemSource`/`sessionMessages`, and hand the extension an empty history that
	// `ingestMessages` reads as structural divergence — rebuilding the Truth down to nothing and
	// destroying every fold, group and dial in it.
	if (!Array.isArray(msg.messages) || msg.messages.length === 0) {
		console.error("[sidecar] context request carried no messages array; replying passthrough");
		if (req !== undefined) send({ type: "hook_result", req, messages: null });
		return;
	}
	let reply: LLMMessage[] | null = null;
	try {
		applyModelFrom(msg.model);
		// Convert BEFORE dispatch: the handler reads the system prompt off `ctx.getSystemPrompt()`
		// (via `refreshFromCtx`) during the very call we are about to make.
		const converted = toPiTagged(msg.messages as LLMMessage[]);
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
	// `setFolding` fires the seam only on a real CHANGE, so state the arm explicitly — the harness
	// must know from message one whether to run its own compaction middleware. `foldingArm`, not a
	// hardcoded `false`: a REPEAT `hello` (a harness that re-handshakes) must be told the CURRENT
	// arm, or it would switch its compaction middleware back on underneath a folding session (M8).
	send({ type: "folding", enabled: foldingArm });
}

async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	await callSafe("session_shutdown", {});
	// Prefer a NATURAL exit: on Windows a pipe write is asynchronous, so a hard `process.exit` can
	// truncate an in-flight stdout write (L14). Stop reading, set the code, and let the loop drain
	// once the extension's servers and timers are gone. The backstop timer is `unref`'d, so it never
	// keeps the process alive on its own — it only fires if something DID linger, which it then
	// kills rather than hanging the harness's `proc.wait()`.
	process.exitCode = 0;
	try {
		process.stdin.destroy();
	} catch {
		/* already gone */
	}
	const backstop = setTimeout(() => process.exit(0), 2000);
	(backstop as { unref?: () => void }).unref?.();
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
			// Registry-entry title (harnessDeps, above): computed HERE — after the chdir just above —
			// so it reflects the real session cwd. Only set once: a repeat `hello` (M8) must not
			// overwrite an already-observed title with a possibly different cwd basis, since the
			// session itself hasn't restarted.
			if (!harnessDeps.title) {
				try {
					const base = basename(process.cwd());
					harnessDeps.title = base ? `vibe · ${base}` : "vibe session";
				} catch {
					harnessDeps.title = "vibe session";
				}
			}
			// IDEMPOTENT (M8): a repeat `hello` re-answers with the CURRENT surface and the CURRENT
			// folding arm — it never resets session state, and never claims the arm is off when it is
			// on. Everything above is itself idempotent (same model, same flags, same cwd).
			if (helloSeen) console.error("[sidecar] repeat hello — re-answering ready with the current state");
			helloSeen = true;
			sendReady();
			return;
		}
		case "shutdown":
			await shutdown();
			return;

		// ── pi hooks ───────────────────────────────────────────────────────────
		case "session_start": {
			// Seed the extension's view BEFORE the hook: `session_start` builds the Truth from
			// `ctx.sessionManager.buildSessionContext()`. An EMPTY array is legitimate here (a fresh
			// session), unlike `context` — so no H2-style guard.
			sessionMessages = toPiTagged(Array.isArray(msg.messages) ? (msg.messages as LLMMessage[]) : []);
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
		case "session_compact": {
			// L9: `accordion.ts`'s handler reconciles the Truth against
			// `ctx.sessionManager.buildSessionContext()` and then TELLS THE USER it rebuilt the map to
			// match. Left alone, that would read our STALE pre-compaction `sessionMessages` — a claimed
			// rebuild that silently reproduces exactly the history compaction just removed. So the
			// harness SHOULD send the post-compaction `messages`; when it does, refresh first. When it
			// does not, hand over `[]`, which the handler's own `if (msgs.length > 0)` guard skips —
			// it then only notifies, and the next `context` reconciles for real.
			if (Array.isArray(msg.messages) && msg.messages.length > 0) {
				sessionMessages = toPiTagged(msg.messages as LLMMessage[]);
			} else {
				sessionMessages = [];
			}
			await callSafe("session_compact", { summary: msg.summary });
			return;
		}
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
		case "agent_end":
			// Run-local messages, never returned to the harness → untagged INGEST conversion.
			await callSafe("agent_end", { messages: toPiIngest(msg.messages) });
			return;
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
			// A fresh scope per message: duplicate-anchor suppression is a WITHIN-ARRAY concern, and a
			// single message can never collide with itself.
			const pm = toPiOne(msg.message ?? {}, -1, newScope());
			if (!pm) return; // unrepresentable ⇒ no blocks to append; the wire keeps it via `fromPi`
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
 * Hard cap on ONE unterminated line (L12). A harness bug or a corrupt pipe could otherwise stream
 * newline-free bytes forever and grow this string until the process dies of memory pressure —
 * taking the whole map with it. 64 MB is far above any plausible `context` payload.
 */
const MAX_LINE_BYTES = (() => {
	// Test seam, mirroring `ACCORDION_DOOR_PORT`/`ACCORDION_HOME`: the smoke suite trips the cap with
	// a small value instead of streaming 64 MB. Production never sets it.
	const raw = Number(process.env.ACCORDION_SIDECAR_MAX_LINE);
	return Number.isSafeInteger(raw) && raw > 0 ? raw : 64 * 1024 * 1024;
})();
/** True while we are throwing bytes away up to the next newline, after tripping the cap. */
let discardingLine = false;
let discardWarned = false;

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
			// Resync: the tail of an over-long line is garbage, never a message.
			if (discardingLine) {
				discardingLine = false;
				continue;
			}
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
		// No newline in sight and the buffer is over the cap ⇒ drop what we hold and skip to the next
		// newline. Warned ONCE: a runaway producer would otherwise spam stderr as hard as it spams us.
		if (buffer.length > MAX_LINE_BYTES) {
			if (!discardWarned) {
				discardWarned = true;
				console.error(`[sidecar] a single stdin line exceeded ${MAX_LINE_BYTES} bytes — dropping it and resyncing at the next newline`);
			}
			buffer = "";
			discardingLine = true;
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

// M7: a harness that reaches for `proc.terminate()` / Ctrl-C (or a closing terminal) must still get
// the full teardown — without this, the default disposition kills us outright and LEAKS the registry
// entry (`~/.accordion/sessions/<id>.json`), so the app lists a dead session until its heartbeat goes
// stale, and the bound loopback server dies without closing. `shutdown` is idempotent, so overlapping
// signals are harmless.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
	try {
		process.on(sig, () => void shutdown());
	} catch {
		// SIGHUP is not raisable on every platform; never let registration failure abort startup.
	}
}

// ── load the extension ───────────────────────────────────────────────────────
// DYNAMIC, so the console redirection at the top of this file is already in effect. The lazy
// `@earendil-works/pi-ai` import inside `accordion.ts` is only reached by the (unwired) completion
// relay, and `runCompletion` declines before it via the `modelRegistry` shim above — so its absence
// from `extension/node_modules` can never crash the sidecar.
const { default: accordionLive } = await import("./accordion");
accordionLive(pi as any, {
	onFoldingChanged: (enabled: boolean) => {
		foldingArm = enabled; // mirrored so a repeat `hello` restates the CURRENT arm (M8)
		send({ type: "folding", enabled });
	},
	harness: harnessDeps,
});

// Every `register*` call has now run, so `ready` (emitted by the `hello` handler) can describe the
// real tool/command/flag surface. Only now do we start reading the harness.
startReadLoop();
