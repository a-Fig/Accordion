/*
 * smoke.mjs — exercise the extension's WS loop + registry without running pi.
 *
 * Loads accordion.ts via jiti (the same loader pi uses → proves the cross-package
 * relative imports resolve), drives it with a mock `pi`, discovers the session's
 * ephemeral port from the registry file it writes, connects a real WS client as
 * the "GUI", and checks hello → sync → plan → apply plus the discovery contract
 * (registry advertise / focus request / shutdown cleanup).
 *
 * Run: node smoke.mjs
 */
import { createJiti } from "jiti";
import { WebSocket } from "ws";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Point the registry at a throwaway dir BEFORE loading the extension (it reads
// ACCORDION_HOME at module load) so we never touch the real ~/.accordion.
const HOME = path.join(os.tmpdir(), `accordion-smoke-${process.pid}`);
process.env.ACCORDION_HOME = HOME;
// Prevent the /accordion command smoke assertion from launching a real developer
// build via the repo-local default candidates. An explicit-but-missing path must
// stop fallback, which is also one of the launcher contract's safety rules.
process.env.ACCORDION_APP_PATH = path.join(HOME, "missing-accordion-app.exe");
const SESSIONS_DIR = path.join(HOME, ".accordion", "sessions");
const FOCUS_PATH = path.join(HOME, ".accordion", "focus.json");

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./accordion.ts");
const accordionLive = mod.default;
if (typeof accordionLive !== "function") throw new Error("default export is not a function");

async function waitFor(predicate, ms, label) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`timed out waiting for ${label}`);
}
function readOnlyEntry() {
	const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
	if (files.length !== 1) throw new Error(`expected 1 registry entry, found ${files.length}`);
	return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, files[0]), "utf8"));
}

// ── mock pi ──────────────────────────────────────────────────────────────────
const handlers = {};
let accordionCmd = null;
let unfoldTool = null; // captured registerTool def for the `unfold` tool (M3)
let recallTool = null; // captured registerTool def for the `recall` tool (ADR 0011)
const flags = new Map();
const notifications = [];
const pi = {
	on: (name, fn) => (handlers[name] = fn),
	registerFlag: (name, def) => flags.set(name, def?.default),
	getFlag: (name) => flags.get(name),
	registerCommand: (name, def) => {
		if (name === "accordion") accordionCmd = def.handler;
	},
	registerTool: (def) => {
		if (def && def.name === "unfold") unfoldTool = def;
		if (def && def.name === "recall") recallTool = def;
	},
	appendEntry: () => {},
};
accordionLive(pi);
const ctx = {
	ui: { setStatus() {}, notify(message, type) { notifications.push({ message, type }); }, theme: { fg: (_c, s) => s } },
	// Mirror the REAL pi ExtensionContext: `model` is a property (getter), not a
	// `getModel()` method; `getContextUsage()` is the method.
	model: { id: "test/model", contextWindow: 1000 },
	getContextUsage: () => ({ tokens: 42, contextWindow: 1000 }),
};
handlers.session_start({}, ctx);

// the server binds an ephemeral port asynchronously, then advertises itself
await waitFor(() => fs.existsSync(SESSIONS_DIR) && fs.readdirSync(SESSIONS_DIR).some((f) => f.endsWith(".json")), 3000, "registry entry");
const entry = readOnlyEntry();
const fails = [];
if (!(entry.port > 0)) fails.push(`registry port not assigned (got ${entry.port})`);
if (entry.registryProtocol !== 1) fails.push(`registry protocol mismatch (${entry.registryProtocol})`);
if (entry.model !== "test/model") fails.push(`model not captured (${entry.model})`);
if (entry.tokens !== 42) fails.push(`tokens not captured (${entry.tokens})`);
const PORT = entry.port;

// passthrough invariant: with NO GUI attached, the context hook must return
// undefined (pi keeps its original messages) and never touch them.
{
	const probe = [{ role: "user", content: "no gui yet" }];
	const ret = await Promise.resolve(handlers.context({ messages: probe }, ctx));
	if (ret !== undefined) fails.push("context hook altered messages with no GUI attached");
}

// /accordion writes a one-shot focus request
if (accordionCmd) {
	await Promise.resolve(accordionCmd("", ctx));
	if (!fs.existsSync(FOCUS_PATH)) fails.push("/accordion did not write a focus request");
	else {
		const req = JSON.parse(fs.readFileSync(FOCUS_PATH, "utf8"));
		if (req.sessionId !== entry.sessionId) fails.push("focus request sessionId mismatch");
	}
	const note = notifications.at(-1);
	if (note?.type !== "warning" || !note.message.includes("ACCORDION_APP_PATH does not point to an executable"))
		fails.push("/accordion did not warn for an invalid explicit ACCORDION_APP_PATH");
} else {
	fails.push("accordion command was not registered");
}

// ── browser-served extension: HTTP static surface on the SAME ephemeral port ──
// The extension now ALSO serves the SvelteKit browser build over HTTP on `PORT`,
// gated by a per-session token. We harvest the token from the /accordion notify
// line (`Browser: http://127.0.0.1:<port>/?token=<token>`) — the token lives in a
// closure, so the command's own output is the intended, side-effect-free way to get
// it. Assertions:
//   • /__accordion/meta is reachable WITHOUT a token (ungated) → 200 JSON served:true
//   • a static file request WITHOUT a token → 403 (the gate works)
//   • GET /?token=<token> → 200 (index.html), IF app/build/index.html exists; else skip
//     the index assertion with a printed note (meta + 403 still prove the surface + gate)
{
	const browserLine = notifications.map((n) => n.message).reverse().find((m) => m.includes("Browser: http"));
	const tokenMatch = browserLine && browserLine.match(/token=([0-9a-f]+)/);
	const TOKEN = tokenMatch ? tokenMatch[1] : null;
	if (!TOKEN) fails.push("/accordion did not surface a Browser URL carrying a token");

	const httpGet = (urlPath, headers = {}) =>
		new Promise((resolve, reject) => {
			const r = http.get({ host: "127.0.0.1", port: PORT, path: urlPath, headers }, (res) => {
				let buf = "";
				res.on("data", (d) => (buf += d));
				res.on("end", () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
			});
			r.on("error", reject);
		});

	// meta — UNGATED, must answer 200 JSON with served:true even with no token.
	const meta = await httpGet("/__accordion/meta");
	if (meta.status !== 200) fails.push(`/__accordion/meta (no token) returned ${meta.status}, expected 200`);
	else {
		let parsed = null;
		try { parsed = JSON.parse(meta.body); } catch { /* fall through */ }
		if (!parsed || parsed.served !== true) fails.push("/__accordion/meta did not return JSON with served:true");
		if (parsed && parsed.sessionId !== entry.sessionId) fails.push("/__accordion/meta sessionId mismatch");
	}

	// static file request WITHOUT a token → 403 (the gate works).
	const noToken = await httpGet("/");
	if (noToken.status !== 403) fails.push(`GET / without a token returned ${noToken.status}, expected 403`);

	// GET /?token=<token> → 200 index.html (only if the build exists).
	if (TOKEN) {
		const buildIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "build", "index.html");
		const indexExists = fs.existsSync(buildIndex);
		if (indexExists) {
			const ok = await httpGet(`/?token=${TOKEN}`);
			if (ok.status !== 200) fails.push(`GET /?token=<valid> returned ${ok.status}, expected 200`);
			const setCookie = ok.headers["set-cookie"];
			if (!setCookie || !String(setCookie).includes(`accordion_token=${TOKEN}`))
				fails.push("GET /?token=<valid> did not mint the accordion_token cookie");
			// Cookie-only auth (no query token) must ALSO pass the gate.
			const viaCookie = await httpGet("/", { Cookie: `accordion_token=${TOKEN}` });
			if (viaCookie.status !== 200) fails.push(`GET / with cookie auth returned ${viaCookie.status}, expected 200`);
		} else {
			console.log("NOTE: app/build/index.html absent — skipping the index 200 assertion (meta + 403 still verified). Run `npm run build` in app/ to cover it.");
		}
	}
}

// 4 messages with real timestamps and responseIds so the WS round-trip exercises
// the durable id path (a:/u:/r: prefixes) rather than the positional fallback.
const T0 = Date.now();
const sample = [
	{ role: "user", content: "do the thing", timestamp: T0 },
	{ role: "assistant", content: [{ type: "text", text: "ORIGINAL ASSISTANT TEXT" }], responseId: "resp-abc", timestamp: T0 + 1 },
	{ role: "user", content: "and another", timestamp: T0 + 2 },
	{ role: "assistant", content: [{ type: "text", text: "second reply" }], responseId: "resp-def", timestamp: T0 + 3 },
];

// ── attach-flush regression: a GUI connecting to a session that ALREADY has
// history must receive those blocks IMMEDIATELY on connect (a full sync right
// after hello), WITHOUT the user sending a message — i.e. with NO `context` hook
// firing after hello. Bug: `/accordion` in a session with history used to stay
// empty until the first message, because only `context` (which fires before the
// next model call) streamed the backlog.
//
// Establish the history while DETACHED so what the GUI receives on connect is
// purely the cached snapshot being flushed — not a freshly-driven context.
handlers.context({ messages: sample }, ctx); // no GUI yet → passthrough; caches lastMessages

const seen = { hello: false, flushOnAttach: false, flushBlocks: 0, contextSync: false, contextBlocks: 0 };
let contextReturn;

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("smoke timed out")), 3000);
	let flushSeen = false;
	ws.on("error", reject);
	ws.on("message", async (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "hello") {
			seen.hello = true;
			// Deliberately do NOT fire `context` here — the backlog flush must arrive on
			// its own, driven purely by the connection (the whole point of the fix).
		} else if (m.type === "sync" && !flushSeen) {
			// FIRST sync after hello = the attach-flush of the cached history.
			flushSeen = true;
			seen.flushOnAttach = true;
			seen.flushBlocks = m.blocks.length;
			// Now drive one real `context` turn to exercise fold-apply. The cursor is
			// already at the backlog length, so this sync carries only deltas (0 here) —
			// folding still applies to the outgoing messages regardless of what's fresh.
			contextReturn = await Promise.resolve(handlers.context({ messages: sample }, ctx));
		} else if (m.type === "sync") {
			seen.contextSync = true;
			seen.contextBlocks = m.blocks.length;
			// Use durable id (a:<responseId>:p0) — exercises the Phase-1 id path
			// Also send a GROUP op (ADR 0006) collapsing m0 (user, durable u:<T0>) into one
			// summary entry — exercises range-collapse end to end.
			ws.send(
				JSON.stringify({
					type: "plan",
					reqId: m.reqId,
					ops: [{ id: "a:resp-abc:p0", digestText: "FOLDED" }],
					groups: [{ id: `g:u:${T0}`, memberIds: [`u:${T0}`], summaryText: "GROUPSUM" }],
				}),
			);
			setTimeout(() => {
				clearTimeout(timeout);
				resolve();
			}, 150);
		}
	});
});

// With a GUI attached, /accordion should only write focus.json and report the
// snapshotted attached state. It must NOT try the launcher path, even when the
// explicit ACCORDION_APP_PATH remains invalid from the detached smoke above.
if (accordionCmd) {
	await Promise.resolve(accordionCmd("", ctx));
	const note = notifications.at(-1);
	if (note?.type !== "info" || !note.message.includes("Accordion focus requested for this session."))
		fails.push("/accordion did not skip launch while the GUI was already attached");
	if (!note?.message.includes("Live link: attached")) fails.push("/accordion did not report the snapshotted attached live-link state");
	if (note?.message.includes("ACCORDION_APP_PATH does not point to an executable"))
		fails.push("/accordion tried invalid ACCORDION_APP_PATH despite an attached GUI");
}

// ── Phase 3: message_end committed streaming ─────────────────────────────────
// A new assistant message arriving via message_end must reach the GUI as a sync
// BEFORE any subsequent `context` hook fires. Then a subsequent `context` that
// includes the same message must NOT produce duplicate blocks (cursor alignment +
// GUI dedup together hold).

// The `context` hook above left lastMessages = sample (4 messages, 4+ blocks).
// Simulate: a new assistant reply finishes (message_end fires with the new msg).
const msgEndMsg = {
	role: "assistant",
	content: [{ type: "text", text: "COMMITTED REPLY VIA MESSAGE_END" }],
	responseId: "resp-ghi",
	timestamp: T0 + 10,
};

let messageEndSync = null;
await new Promise((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("message_end sync timed out")), 2000);
	ws.removeAllListeners("message");
	ws.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "sync") {
			messageEndSync = m;
			clearTimeout(timeout);
			resolve();
		}
	});
	// Fire the message_end hook directly (mimics pi firing it after finalization)
	handlers.message_end({ message: msgEndMsg }, ctx);
});

if (!messageEndSync) fails.push("message_end did not push a view sync");
else if (!messageEndSync.blocks?.some((b) => b.text === "COMMITTED REPLY VIA MESSAGE_END"))
	fails.push("message_end sync missing the committed block");
else if (!messageEndSync.blocks?.some((b) => b.id === "a:resp-ghi:p0"))
	fails.push("message_end sync block does not carry durable id a:resp-ghi:p0");

// Record how many blocks the GUI has seen so far (sentCount reflects this)
const blockCountAfterMessageEnd = messageEndSync ? messageEndSync.blocks.length : 0;

// ── model_select: a /model swap pushes the new context window to the GUI ──────
// `/model` fires model_select with the NEW model. The extension must adopt its
// contextWindow and push it immediately to the connected GUI as a view-only sync
// (no blocks, no plan awaited) so the budget tracks the swap before the next turn.
let modelSwapSync = null;
await new Promise((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("model_select sync timed out")), 2000);
	ws.removeAllListeners("message");
	ws.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "sync" && m.contextWindow === 2000) {
			modelSwapSync = m;
			clearTimeout(timeout);
			resolve();
		}
	});
	handlers.model_select({ model: { id: "test/model-2", contextWindow: 2000 }, previousModel: undefined, source: "set" });
});
if (!modelSwapSync) fails.push("model_select did not push a sync carrying the new contextWindow (2000)");
else if (modelSwapSync.blocks.length !== 0)
	fails.push(`model_select push must carry no blocks (got ${modelSwapSync.blocks.length})`);

// ── Phase 3 (tool loop): TWO messages finish before the next `context` ───────
// The critical case the single-message test above does NOT cover: in a tool turn
// the assistant message (with a tool call) AND its tool result both end before the
// next `context` fires. Both must stream live with correct global numbering —
// appending only the latest to a stale snapshot would drop the assistant message
// and then SKIP the tool result (its cursor check finds nothing new) until the next
// `context` caught up. This asserts both stream immediately.
const aTool = {
	role: "assistant",
	content: [
		{ type: "text", text: "CALLING THE TOOL" },
		{ type: "toolCall", id: "call-xyz", name: "bash", arguments: { cmd: "ls" } },
	],
	responseId: "resp-tool",
	timestamp: T0 + 11,
};
const rTool = {
	role: "toolResult",
	toolCallId: "call-xyz",
	toolName: "bash",
	content: [{ type: "text", text: "TOOL OUTPUT" }],
	timestamp: T0 + 12,
};

async function fireMessageEndExpectSync(msg, label) {
	let sync = null;
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`${label} sync timed out`)), 2000);
		ws.removeAllListeners("message");
		ws.on("message", (data) => {
			const m = JSON.parse(data.toString());
			if (m.type === "sync") {
				sync = m;
				clearTimeout(timeout);
				resolve();
			}
		});
		handlers.message_end({ message: msg }, ctx);
	});
	return sync;
}

const aToolSync = await fireMessageEndExpectSync(aTool, "tool-call message_end");
if (!aToolSync) fails.push("tool-call message_end did not push a sync");
else if (!aToolSync.blocks?.some((b) => b.id === "a:resp-tool:p1" && b.kind === "tool_call"))
	fails.push("tool-call message_end sync missing the tool_call block");

const rToolSync = await fireMessageEndExpectSync(rTool, "tool-result message_end");
if (!rToolSync) fails.push("tool-result message_end did not push a sync (multi-message-per-turn regression)");
else if (!rToolSync.blocks?.some((b) => b.id === "r:call-xyz" && b.text === "TOOL OUTPUT"))
	fails.push("tool-result message_end sync missing the tool_result block (streamed against a stale snapshot)");

// Now fire the reconciling `context` that includes ALL of these messages (full
// array). The cursor has already advanced past them, so the GUI must receive NO
// new blocks for any already-committed message — no duplicates, not doubled.
const afterContext = [...sample, msgEndMsg, aTool, rTool];
let noopSync = null;
let contextSyncReceived = false;
await new Promise((resolve, reject) => {
	const timeout = setTimeout(() => {
		// No sync is the expected outcome if nothing is new — resolve successfully
		resolve();
	}, 400);
	ws.removeAllListeners("message");
	ws.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "sync") {
			contextSyncReceived = true;
			noopSync = m;
			// Reply with empty plan so the context hook resolves
			ws.send(JSON.stringify({ type: "plan", reqId: m.reqId, ops: [] }));
		}
	});
	// Fire context with the full array (including the already-committed message)
	handlers.context({ messages: afterContext }, ctx);
});

if (contextSyncReceived && noopSync?.blocks?.length > 0) {
	// A sync arrived — check that the already-committed block was not re-sent.
	// If the cursor was correct, the sync should carry 0 blocks (or only truly new
	// blocks). If it carries the committed message block again, that is a duplicate.
	const alreadyCommitted = ["a:resp-ghi:p0", "a:resp-tool:p0", "a:resp-tool:p1", "r:call-xyz"];
	const committedResent = noopSync.blocks.some((b) => alreadyCommitted.includes(b.id));
	if (committedResent)
		fails.push("context after message_end re-sent an already-committed block (cursor gap / duplicate)");
}

// ── Phase 3 regression: empty-leading-part message must not double-commit ─────
// A message whose part 0 is empty emits NO `:p0` block (linearize drops empty
// non-result parts). A dedup probe that only checked `:p0` would think the message
// is absent and re-stream it. Commit such a message via context, then fire a
// DUPLICATE message_end for it and assert its real block (`:p1`) is NOT re-sent.
const emptyP0Msg = {
	role: "assistant",
	content: [
		{ type: "text", text: "" }, // empty p0 → no block emitted
		{ type: "text", text: "REAL CONTENT AT P1" },
	],
	responseId: "resp-empty",
	timestamp: T0 + 15,
};
const withEmpty = [...afterContext, emptyP0Msg];
await new Promise((resolve) => {
	const timeout = setTimeout(resolve, 600);
	ws.removeAllListeners("message");
	ws.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "sync") {
			ws.send(JSON.stringify({ type: "plan", reqId: m.reqId, ops: [] }));
			clearTimeout(timeout);
			setTimeout(resolve, 100); // let the context hook settle
		}
	});
	handlers.context({ messages: withEmpty }, ctx);
});

let dupSync = null;
await new Promise((resolve) => {
	ws.removeAllListeners("message");
	ws.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "sync") dupSync = m;
	});
	handlers.message_end({ message: emptyP0Msg }, ctx); // DUPLICATE — already committed
	setTimeout(resolve, 300); // no sync is the expected outcome
});
if (dupSync && dupSync.blocks?.some((b) => b.id === "a:resp-empty:p1"))
	fails.push("duplicate message_end for an empty-leading-part message re-sent its block (probe missed it)");

// agent_end view-sync: a completed assistant reply must reach the GUI WITHOUT the
// user sending another message (i.e. with NO further `context` hook firing).
let agentEndSync = null;
await new Promise((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("agent_end view-sync timed out")), 2000);
	ws.removeAllListeners("message");
	ws.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "sync") {
			agentEndSync = m;
			clearTimeout(timeout);
			resolve();
		}
	});
	// afterTurn includes one more message beyond the prior state to guarantee something new
	const afterTurn = [...withEmpty, { role: "assistant", content: [{ type: "text", text: "LLM REPLY AFTER TURN" }], responseId: "resp-jkl", timestamp: T0 + 20 }];
	handlers.agent_end({ messages: afterTurn }, ctx);
});
if (!agentEndSync) fails.push("agent_end did not push a view sync");
else if (!agentEndSync.blocks?.some((b) => b.text === "LLM REPLY AFTER TURN"))
	fails.push("agent_end sync missing the post-turn assistant block");
else if (agentEndSync.blocks?.some((b) => b.id === "a:resp-ghi:p0"))
	fails.push("agent_end sync re-sent the already-committed message_end block (double-send)");
ws.close(); // done with the Phase 1-3 socket

// ── Phase 4: ghost / stream frame assertions ─────────────────────────────────
// Reconnect a fresh GUI so the ghost tests start from a clean slate (sentCount
// reset, no pending frames from the previous sub-tests).
const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((resolve, reject) => {
	const t = setTimeout(() => reject(new Error("ws2 connect timed out")), 2000);
	ws2.on("error", reject);
	ws2.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "hello") { clearTimeout(t); resolve(); }
	});
});

// ── 4a: text_start → stream{phase:start, kind:text} ──────────────────────────
let streamStart = null;
await new Promise((resolve, reject) => {
	const t = setTimeout(() => reject(new Error("stream start frame timed out")), 1000);
	ws2.removeAllListeners("message");
	ws2.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "stream") { streamStart = m; clearTimeout(t); resolve(); }
	});
	handlers.message_update({ assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
});
if (!streamStart) fails.push("message_update text_start did not produce a stream frame");
else {
	if (streamStart.phase !== "start") fails.push(`stream start frame has wrong phase: ${streamStart.phase}`);
	if (streamStart.kind !== "text") fails.push(`stream start frame has wrong kind: ${streamStart.kind}`);
	if (streamStart.contentIndex !== 0) fails.push(`stream start frame has wrong contentIndex: ${streamStart.contentIndex}`);
	if ("text" in streamStart || "content" in streamStart || "tokens" in streamStart)
		fails.push("stream frame MUST NOT carry text/content/tokens fields (invariant violation)");
}

// ── 4b: text_end → stream{phase:end, kind:text} ──────────────────────────────
let streamEnd = null;
await new Promise((resolve, reject) => {
	const t = setTimeout(() => reject(new Error("stream end frame timed out")), 1000);
	ws2.removeAllListeners("message");
	ws2.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "stream") { streamEnd = m; clearTimeout(t); resolve(); }
	});
	handlers.message_update({ assistantMessageEvent: { type: "text_end", contentIndex: 0 } });
});
if (!streamEnd) fails.push("message_update text_end did not produce a stream frame");
else {
	if (streamEnd.phase !== "end") fails.push(`stream end frame has wrong phase: ${streamEnd.phase}`);
	if (streamEnd.kind !== "text") fails.push(`stream end frame has wrong kind: ${streamEnd.kind}`);
	if ("text" in streamEnd || "content" in streamEnd || "tokens" in streamEnd)
		fails.push("stream end frame MUST NOT carry text/content/tokens fields");
}

// ── 4c: thinking_start → stream{phase:start, kind:thinking} ─────────────────
let streamThinking = null;
await new Promise((resolve, reject) => {
	const t = setTimeout(() => reject(new Error("thinking_start frame timed out")), 1000);
	ws2.removeAllListeners("message");
	ws2.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "stream") { streamThinking = m; clearTimeout(t); resolve(); }
	});
	handlers.message_update({ assistantMessageEvent: { type: "thinking_start", contentIndex: 1 } });
});
if (!streamThinking) fails.push("message_update thinking_start did not produce a stream frame");
else if (streamThinking.kind !== "thinking") fails.push(`thinking_start kind wrong: ${streamThinking.kind}`);

// ── 4d: toolcall_start → stream{phase:start, kind:tool_call} ─────────────────
let streamTool = null;
await new Promise((resolve, reject) => {
	const t = setTimeout(() => reject(new Error("toolcall_start frame timed out")), 1000);
	ws2.removeAllListeners("message");
	ws2.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "stream") { streamTool = m; clearTimeout(t); resolve(); }
	});
	handlers.message_update({ assistantMessageEvent: { type: "toolcall_start", contentIndex: 2 } });
});
if (!streamTool) fails.push("message_update toolcall_start did not produce a stream frame");
else if (streamTool.kind !== "tool_call") fails.push(`toolcall_start kind wrong: ${streamTool.kind}`);

// ── 4e: error → stream{phase:abort, contentIndex:-1} (sweep) ─────────────────
let streamAbort = null;
await new Promise((resolve, reject) => {
	const t = setTimeout(() => reject(new Error("stream abort frame timed out")), 1000);
	ws2.removeAllListeners("message");
	ws2.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "stream") { streamAbort = m; clearTimeout(t); resolve(); }
	});
	handlers.message_update({ assistantMessageEvent: { type: "error", contentIndex: 0 } });
});
if (!streamAbort) fails.push("message_update error did not produce a stream abort frame");
else {
	if (streamAbort.phase !== "abort") fails.push(`error event should produce phase:abort, got ${streamAbort.phase}`);
	if (streamAbort.contentIndex !== -1) fails.push(`error abort sweep should have contentIndex:-1, got ${streamAbort.contentIndex}`);
}

// 4e': an `aborted` stream event must ALSO sweep (invariant #3 — ghost vanishes on
// abort, no committed block is coming).
let streamAborted = null;
await new Promise((resolve, reject) => {
	const t = setTimeout(() => reject(new Error("aborted sweep frame timed out")), 1000);
	ws2.removeAllListeners("message");
	ws2.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "stream") { streamAborted = m; clearTimeout(t); resolve(); }
	});
	handlers.message_update({ assistantMessageEvent: { type: "aborted", contentIndex: 0 } });
});
if (!streamAborted || streamAborted.phase !== "abort" || streamAborted.contentIndex !== -1)
	fails.push("message_update 'aborted' did not produce an abort sweep frame");

// ── 4f: token delta events must NOT produce a stream frame ────────────────────
// The token-delta firehose must be dropped at the source; no frame must cross wire.
let spuriousFrame = null;
await new Promise((resolve) => {
	ws2.removeAllListeners("message");
	ws2.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "stream") spuriousFrame = m;
	});
	handlers.message_update({ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: { text: "hello" } } });
	handlers.message_update({ assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: { thinking: "hmm" } } });
	setTimeout(resolve, 150); // give frames time to arrive if they were sent
});
if (spuriousFrame) fails.push(`token delta must NOT produce a stream frame — got phase:${spuriousFrame.phase} for a delta event`);

// ── 4g: message_end sends an abort sweep BEFORE the sync ─────────────────────
// Spawn a ghost, fire message_end, and assert: first frame is stream abort, then sync.
// This guarantees the GUI clears ghost placeholders before receiving the real blocks.
// First: spawn a ghost so there is actually something to sweep.
await new Promise((resolve, reject) => {
	const t = setTimeout(() => reject(new Error("ghost spawn frame timed out for 4g")), 1000);
	ws2.removeAllListeners("message");
	ws2.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "stream" && m.phase === "start") { clearTimeout(t); resolve(); }
	});
	handlers.message_update({ assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
});

const phase4gFrames = [];
await new Promise((resolve, reject) => {
	const t = setTimeout(() => { clearTimeout(t); resolve(); }, 500);
	ws2.removeAllListeners("message");
	ws2.on("message", (data) => {
		const m = JSON.parse(data.toString());
		phase4gFrames.push(m);
		if (m.type === "sync") { clearTimeout(t); resolve(); }
	});
	// Fire message_end with a new message so it generates both abort + sync.
	handlers.message_end({
		message: {
			role: "assistant",
			content: [{ type: "text", text: "GHOST SWEEP TEST" }],
			responseId: "resp-sweep",
			timestamp: T0 + 50,
		}
	}, ctx);
});
const abortFrame = phase4gFrames.find((m) => m.type === "stream" && m.phase === "abort");
const syncFrame  = phase4gFrames.find((m) => m.type === "sync");
if (!abortFrame) fails.push("message_end did not send an abort sweep frame (backstop missing)");
if (!syncFrame)  fails.push("message_end did not send a sync after the abort sweep");
if (abortFrame && syncFrame) {
	const abortIdx = phase4gFrames.indexOf(abortFrame);
	const syncIdx  = phase4gFrames.indexOf(syncFrame);
	if (abortIdx > syncIdx)
		fails.push("message_end abort sweep arrived AFTER the sync — ghost may flash briefly over the real block");
}

// ── 4h: agent_end sends an abort sweep ───────────────────────────────────────
// Spawn a ghost, then fire agent_end and assert an abort sweep arrives.
await new Promise((resolve, reject) => {
	const t = setTimeout(() => reject(new Error("ghost spawn for 4h timed out")), 1000);
	ws2.removeAllListeners("message");
	ws2.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "stream" && m.phase === "start") { clearTimeout(t); resolve(); }
	});
	handlers.message_update({ assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
});

let agentEndAbort = null;
await new Promise((resolve) => {
	const t = setTimeout(resolve, 500);
	ws2.removeAllListeners("message");
	ws2.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "stream" && m.phase === "abort") {
			agentEndAbort = m;
			clearTimeout(t);
			resolve();
		}
		// Ignore the sync that agent_end sends after the abort.
		if (m.type === "sync") ws2.send(JSON.stringify({ type: "plan", reqId: m.reqId, ops: [] }));
	});
	const afterTurn2 = [{ role: "assistant", content: [{ type: "text", text: "AGENT END SWEEP" }], responseId: "resp-ae2", timestamp: T0 + 60 }];
	handlers.agent_end({ messages: afterTurn2 }, ctx);
});
if (!agentEndAbort) fails.push("agent_end did not send a ghost abort sweep (backstop missing)");
else if (agentEndAbort.contentIndex !== -1)
	fails.push(`agent_end abort sweep should have contentIndex:-1, got ${agentEndAbort.contentIndex}`);

// Ensure fully detached before the resume sub-tests (server-side `client` is cleared
// on the socket's close event, which is async after ws2.close()).
await new Promise((resolve) => { ws2.on("close", resolve); ws2.close(); });
await new Promise((r) => setTimeout(r, 50));

// ── resumed-session attach: history must flush on connect with NO hooks firing ──
// The real "session with history" case is a RESUMED session: pi loads a prior session
// file and fires `session_start` (reason "resume") — but no `context`/`agent_end` has
// run yet, so the cached `lastMessages` is empty. The extension must read the live
// history straight from `ctx.sessionManager` (buildSessionContext, or getBranch
// fallback) so the attach flush still carries the whole conversation.
//
// We seed `latestCtx` via a DETACHED `context` hook (messages:[]) carrying a ctx whose
// sessionManager exposes the prior history. (Using `context` rather than a second
// `session_start` avoids minting a new sessionId / perturbing the registry, while
// exercising the exact attach-time read path the connection handler uses.) Then we
// connect a fresh GUI and assert the flush carries the session-manager history with
// NO further hook firing.
const resumeHistory = [
	{ role: "user", content: "resumed: first question", timestamp: T0 + 1000 },
	{ role: "assistant", content: [{ type: "text", text: "RESUMED PRIOR REPLY" }], responseId: "resp-resume-1", timestamp: T0 + 1001 },
	{ role: "user", content: "resumed: follow up", timestamp: T0 + 1002 },
];
const resumeCtx = {
	...ctx,
	// pi's authoritative resolver — the preferred path in readSessionMessages()
	sessionManager: { buildSessionContext: () => ({ messages: resumeHistory, thinkingLevel: "high", model: null }) },
};
handlers.context({ messages: [] }, resumeCtx); // detached → passthrough; sets latestCtx=resumeCtx

let resumeFlush = null;
let resumeStrayContext = false;
const ws3 = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("resume attach timed out")), 2000);
	ws3.on("error", reject);
	ws3.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "sync") {
			if (resumeFlush) resumeStrayContext = true; // a second sync would mean a hook fired
			else {
				resumeFlush = m;
				setTimeout(() => { clearTimeout(timeout); resolve(); }, 150); // settle window
			}
		}
	});
});
await new Promise((resolve) => { ws3.on("close", resolve); ws3.close(); });
if (!resumeFlush) fails.push("resumed session: GUI received no history flush on attach (reads sessionManager?)");
else {
	if (!resumeFlush.full) fails.push("resumed session: attach flush should be a full sync");
	if (!resumeFlush.blocks?.some((b) => b.text === "RESUMED PRIOR REPLY"))
		fails.push("resumed session: attach flush missing the prior assistant reply");
	if (!resumeFlush.blocks?.some((b) => b.id === "a:resp-resume-1:p0"))
		fails.push("resumed session: attach flush block missing durable id a:resp-resume-1:p0");
	if (resumeFlush.blocks?.length < 3)
		fails.push(`resumed session: attach flush carried too few blocks: ${resumeFlush.blocks?.length}`);
}
if (resumeStrayContext) fails.push("resumed session: an extra sync arrived — flush should not require a context hook");

// getBranch fallback: when buildSessionContext is absent, readSessionMessages must
// reconstruct from the active branch's message entries (leaf→root → reversed).
const branchHistory = [
	{ role: "user", content: "branch q", timestamp: T0 + 2000 },
	{ role: "assistant", content: [{ type: "text", text: "BRANCH FALLBACK REPLY" }], responseId: "resp-branch-1", timestamp: T0 + 2001 },
];
const branchCtx = {
	...ctx,
	// getBranch returns entries leaf→root; the reader must reverse to chronological
	sessionManager: { getBranch: () => [...branchHistory].reverse().map((message, i) => ({ type: "message", id: `e${i}`, message })) },
};
handlers.context({ messages: [] }, branchCtx); // detached → sets latestCtx=branchCtx
let branchFlush = null;
const ws4 = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("branch-fallback attach timed out")), 2000);
	ws4.on("error", reject);
	ws4.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "sync" && !branchFlush) { branchFlush = m; setTimeout(() => { clearTimeout(timeout); resolve(); }, 150); }
	});
});
await new Promise((resolve) => { ws4.on("close", resolve); ws4.close(); });
if (!branchFlush) fails.push("getBranch fallback: no flush on attach");
else {
	if (branchFlush.blocks?.[0]?.kind !== "user")
		fails.push("getBranch fallback: chronological order wrong (first block should be the user message)");
	if (!branchFlush.blocks?.some((b) => b.id === "a:resp-branch-1:p0"))
		fails.push("getBranch fallback: attach flush missing reconstructed block a:resp-branch-1:p0");
}

// ── Phase 0 (ADR 0003): anchor-less / POSITIONAL id round-trip + guard ───────
// Everything above feeds messages WITH timestamps/responseIds, so every id is
// durable (u:/a:/r:). This scenario proves the OTHER branch: a message with NO
// anchor fields streams with a POSITIONAL id (m<i>:…), and the applyPlan guard
// refuses to fold it (and refuses an empty-digest op) so pi's messages come back
// UNCHANGED. We use a fresh GUI so sentCount resets to 0 → the first context sync
// after attach carries the WHOLE array (positional block included).
//
// Determinism: positional ids are pure functions of array index, and we drive the
// `context` hook directly with a fixed array, so the ids below are exact. The
// anchor-less assistant sits at index 0 (→ m0:p0). The durable-id guard refuses
// any fold op for it regardless of its position (no responseId/timestamp → no
// durable anchor → positional id → guard drops the op).
const posTarget = { role: "assistant", content: [{ type: "text", text: "ANCHORLESS ORIGINAL" }] }; // NO responseId / timestamp
const posMsgs = [
	posTarget, // index 0 → positional id m0:p0
	{ role: "user", content: "pos pad 1", timestamp: T0 + 3000 },
	{ role: "user", content: "pos pad 2", timestamp: T0 + 3001 },
];

// Seed the cache while DETACHED (passthrough) so the upcoming attach-flush is built
// purely from this anchor-less array — exactly the pattern the resume/history tests
// above use. The flush then carries the POSITIONAL block (sentCount starts at 0 on
// connect, so the whole array streams).
handlers.context({ messages: posMsgs }, ctx); // detached → passthrough; caches lastMessages = posMsgs

let posFlush = null; // attach-flush sync (carries the full anchor-less array)
let posContextReturn = null;
const ws5 = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("positional-id round-trip timed out")), 3000);
	ws5.on("error", reject);
	ws5.on("message", async (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "sync" && !posFlush) {
			// FIRST sync after hello = the attach-flush of the cached anchor-less history.
			posFlush = m;
			// Now drive one ATTACHED context turn (same array) to exercise the fold-apply
			// return path. Reply with a plan targeting BOTH the positional id (guard:
			// non-durable) and an empty-digest op (guard: empty digest). Neither may be
			// applied, so the messages the hook returns to pi must equal the originals.
			posContextReturn = await Promise.resolve(handlers.context({ messages: posMsgs }, ctx));
			setTimeout(() => { clearTimeout(timeout); resolve(); }, 200); // let the hook resolve
		} else if (m.type === "sync") {
			// The attached context turn's sync (0 deltas — flush already sent everything).
			// Reply so its requestPlan resolves and the hook returns.
			ws5.send(JSON.stringify({
				type: "plan",
				reqId: m.reqId,
				ops: [
					{ id: "m0:p0", digestText: "FOLD THE POSITIONAL BLOCK" }, // refused: positional id
					{ id: "u:" + (T0 + 3000), digestText: "" },               // refused: empty digest
				],
			}));
		}
	});
});
await new Promise((resolve) => { ws5.on("close", resolve); ws5.close(); });

// Part 1 — the anchor-less path round-trips with a POSITIONAL id.
if (!posFlush) fails.push("anchor-less path: never received the attach-flush sync");
else {
	const posBlock = posFlush.blocks?.find((b) => b.text === "ANCHORLESS ORIGINAL");
	if (!posBlock) fails.push("anchor-less path: flush missing the anchor-less assistant block");
	else if (!posBlock.id.startsWith("m")) fails.push(`anchor-less path: block id is not positional (got ${posBlock.id})`);
	else if (posBlock.id !== "m0:p0") fails.push(`anchor-less path: expected positional id m0:p0, got ${posBlock.id}`);
}

// Part 2 — the applyPlan guard refuses both ops, so pi's messages are UNCHANGED.
if (!posContextReturn || !posContextReturn.messages) {
	// undefined return = passthrough = pi keeps its originals: that is ALSO a pass for
	// the guard (the empty effective plan never altered a model call).
	if (posContextReturn !== undefined) fails.push("anchor-less path: context hook returned an unexpected non-message value");
} else {
	const ret = posContextReturn.messages;
	if (ret[0]?.content?.[0]?.text !== "ANCHORLESS ORIGINAL")
		fails.push("anchor-less path: positional-id op was applied — guard failed to refuse a non-durable id");
	if (ret[1]?.content !== "pos pad 1")
		fails.push("anchor-less path: empty-digest op altered a message — guard failed to refuse it");
}

// ── M3: unfold tool + skill discovery ────────────────────────────────────────
// The agent can restore its own folded context. The `unfold` tool round-trips to the
// GUI: it sends `unfoldRequest`, the GUI replies `unfoldResult`, and the tool returns
// a confirmation (state-change-only — no content echo). Also assert the guards
// (no-ids, not-attached) and that `resources_discover` exposes the standalone skill.

// resources_discover must point pi at the standalone skill directory.
if (handlers.resources_discover) {
	const rd = await Promise.resolve(handlers.resources_discover({ type: "resources_discover", cwd: process.cwd(), reason: "startup" }, ctx));
	const paths = (rd && Array.isArray(rd.skillPaths)) ? rd.skillPaths : [];
	if (!paths.some((p) => p.endsWith(path.join("skills", "accordion-context-folding"))))
		fails.push(`resources_discover did not expose the accordion-context-folding skill dir (got ${JSON.stringify(paths)})`);
} else {
	fails.push("resources_discover handler was not registered");
}

if (!unfoldTool) {
	fails.push("unfold tool was not registered");
} else {
	// no codes → guidance, no round-trip
	const r0 = await unfoldTool.execute("tc0", { codes: [] }, undefined, undefined, ctx);
	if (!r0?.content?.[0]?.text?.includes("No fold codes")) fails.push("unfold([]) did not return the no-codes guidance");

	// not attached (no GUI connected here) → safe message, no hang
	const r1 = await unfoldTool.execute("tc1", { codes: ["3f9a2c"] }, undefined, undefined, ctx);
	if (!r1?.content?.[0]?.text?.includes("isn't attached")) fails.push("unfold while detached did not return the not-attached message");

	// attached round-trip: connect a GUI that answers unfoldRequest
	let sawUnfoldReq = null;
	const wsu = new WebSocket(`ws://127.0.0.1:${PORT}`);
	await new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("unfold attach timed out")), 2000);
		wsu.on("error", reject);
		wsu.on("message", (data) => {
			const m = JSON.parse(data.toString());
			if (m.type === "hello") { clearTimeout(t); resolve(); }
		});
	});
	wsu.removeAllListeners("message");
	wsu.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "unfoldRequest") {
			sawUnfoldReq = m;
			// restore the first code; report the rest missing
			wsu.send(JSON.stringify({
				type: "unfoldResult",
				reqId: m.reqId,
				restored: m.codes.slice(0, 1).map((code) => ({ code, kind: "tool_result", label: "tool_result grep · turn 3" })),
				missing: m.codes.slice(1),
			}));
		} else if (m.type === "sync") {
			// attach-flush / view syncs: answer with an empty plan so nothing hangs
			wsu.send(JSON.stringify({ type: "plan", reqId: m.reqId, ops: [] }));
		}
	});
	const r2 = await unfoldTool.execute("tc2", { codes: ["3f9a2c", "00abcd"] }, undefined, undefined, ctx);
	const txt = r2?.content?.[0]?.text ?? "";
	if (!sawUnfoldReq) fails.push("unfold (attached) did not send an unfoldRequest to the GUI");
	else if (!sawUnfoldReq.codes.includes("3f9a2c")) fails.push("unfoldRequest missing the requested code");
	else if (!sawUnfoldReq.codes.includes("00abcd")) fails.push("unfoldRequest dropped a leading-zero code");
	if (!txt.includes("Unfolded 1 block")) fails.push("unfold tool result did not confirm the restored block");
	if (!txt.includes("#3f9a2c")) fails.push("unfold tool result did not list the restored code");
	if (!txt.includes("#00abcd")) fails.push("unfold tool result did not report the missing code");
	await new Promise((resolve) => { wsu.on("close", resolve); wsu.close(); });
}

// ── ADR 0011: recall tool ────────────────────────────────────────────────────
// recall is the agent's UNBLOCKABLE READ: it returns a folded block's ORIGINAL full
// content AS the tool result THIS turn (the defining difference from unfold, which only
// confirms a scheduled state change). The tool round-trips: it sends `recallRequest`, the
// GUI replies `recallResult` with the full content + any missing codes, and the tool echoes
// that content back. Assert the no-codes / not-attached guards plus the attached round-trip.
if (!recallTool) {
	fails.push("recall tool was not registered");
} else {
	// no codes → guidance, no round-trip
	const c0 = await recallTool.execute("rc0", { codes: [] }, undefined, undefined, ctx);
	if (!c0?.content?.[0]?.text?.includes("No fold codes")) fails.push("recall([]) did not return the no-codes guidance");

	// not attached (no GUI connected here) → safe message, no hang
	const c1 = await recallTool.execute("rc1", { codes: ["3f9a2c"] }, undefined, undefined, ctx);
	if (!c1?.content?.[0]?.text?.includes("isn't attached")) fails.push("recall while detached did not return the not-attached message");

	// attached round-trip: connect a GUI that answers recallRequest with full content + a miss
	const RECALLED_TEXT = "THE ORIGINAL FULL TOOL RESULT CONTENT THAT WAS FOLDED";
	let sawRecallReq = null;
	const wsr = new WebSocket(`ws://127.0.0.1:${PORT}`);
	await new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("recall attach timed out")), 2000);
		wsr.on("error", reject);
		wsr.on("message", (data) => {
			const m = JSON.parse(data.toString());
			if (m.type === "hello") { clearTimeout(t); resolve(); }
		});
	});
	wsr.removeAllListeners("message");
	wsr.on("message", (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "recallRequest") {
			sawRecallReq = m;
			// return full content for the first code; report the rest missing
			wsr.send(JSON.stringify({
				type: "recallResult",
				reqId: m.reqId,
				restored: m.codes.slice(0, 1).map((code) => ({ code, label: "tool_result grep · turn 3", text: RECALLED_TEXT, ids: ["r:call1"] })),
				missing: m.codes.slice(1),
			}));
		} else if (m.type === "sync") {
			// attach-flush / view syncs: answer with an empty plan so nothing hangs
			wsr.send(JSON.stringify({ type: "plan", reqId: m.reqId, ops: [] }));
		}
	});
	const c2 = await recallTool.execute("rc2", { codes: ["3f9a2c", "00abcd"] }, undefined, undefined, ctx);
	const allText = (c2?.content ?? []).map((p) => p?.text ?? "").join("\n");
	if (!sawRecallReq) fails.push("recall (attached) did not send a recallRequest to the GUI");
	else if (!sawRecallReq.codes.includes("3f9a2c")) fails.push("recallRequest missing the requested code");
	else if (!sawRecallReq.codes.includes("00abcd")) fails.push("recallRequest dropped a leading-zero code");
	if (!allText.includes(RECALLED_TEXT)) fails.push("recall tool result did not echo the returned full content THIS turn");
	if (!allText.includes("#3f9a2c")) fails.push("recall tool result did not label the recalled code");
	if (!allText.includes("#00abcd")) fails.push("recall tool result did not report the missing code");
	await new Promise((resolve) => { wsr.on("close", resolve); wsr.close(); });
}

// ── issue #58: stale-plan fallback + empty-plan cache + rttMs stamp ───────────
// Feature A (stale-plan fallback) and Feature C (rttMs) run against the DEFAULT env
// (250ms timeout). Feature B (steering deadline + env parsing) is module-init env
// dependent and lives in smoke-config.mjs (spawned children). Here we drive the
// `context`/`message_end` hooks through a fresh GUI whose reply behavior we switch
// per scenario: reply-with-fold, reply-with-empty, or withhold (force timeout).

// Mirrors pi's real `message_end` contract (MessageEndEventResult, see
// node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts): the
// runner's emitMessageEnd does `if (!handlerResult?.message) continue;` — a handler's
// return only takes effect wrapped as `{ message }`; a bare message is silently
// dropped. Applying that same gate to the raw handler return (rather than reading
// `.usage` straight off it) is what makes rttVal below actually depend on the
// extension returning the correct `{ message }` shape.
function unwrapMessageEnd(result) {
	if (!result?.message) return undefined;
	return result.message;
}
const stale = { primedFold: null, staleFold: null, emptyPass: undefined, afterEmptyPass: undefined, rtt: null, rtt2: null };
{
	const gui = new WebSocket(`ws://127.0.0.1:${PORT}`);
	let mode = "ignore"; // "fold" | "empty" | "drop" | "ignore"
	gui.on("message", (data) => {
		let m;
		try { m = JSON.parse(data.toString()); } catch { return; }
		if (m.type !== "sync") return;
		if (mode === "fold") gui.send(JSON.stringify({ type: "plan", reqId: m.reqId, ops: [{ id: "a:resp-abc:p0", digestText: "STALEFOLD" }], groups: [] }));
		else if (mode === "empty") gui.send(JSON.stringify({ type: "plan", reqId: m.reqId, ops: [], groups: [] }));
		// "drop"/"ignore" → deliberately no reply (the attach flush is an "ignore" sync)
	});
	await new Promise((res, rej) => { gui.on("open", res); gui.on("error", rej); });
	await new Promise((r) => setTimeout(r, 100)); // let the view-only attach flush settle

	// 1) Prime the cache: the GUI delivers a NON-EMPTY plan → lastPlan cached + applied.
	mode = "fold";
	stale.primedFold = await Promise.resolve(handlers.context({ messages: sample }, ctx));

	// 2) TIMEOUT → the extension must re-apply the LAST KNOWN plan, not pass through
	//    unfolded. The GUI withholds its reply; after the 250ms default wait the
	//    context hook falls back to the cached STALEFOLD plan.
	mode = "drop";
	stale.staleFold = await Promise.resolve(handlers.context({ messages: sample }, ctx));

	// 3) A delivered EMPTY plan (conductor wants no folds) must REPLACE the cached
	//    non-empty plan — a later timeout must then pass through unfolded, never
	//    resurrect the old fold.
	mode = "empty";
	stale.emptyPass = await Promise.resolve(handlers.context({ messages: sample }, ctx));
	mode = "drop";
	stale.afterEmptyPass = await Promise.resolve(handlers.context({ messages: sample }, ctx));

	// 4) rttMs stamp: a context wait stashes an RTT that the NEXT assistant message_end
	//    stamps onto usage.rttMs; a following assistant message with no preceding context
	//    wait gets NO field (the stash was consumed+cleared).
	mode = "fold";
	await Promise.resolve(handlers.context({ messages: sample }, ctx)); // stashes an RTT
	stale.rtt = await Promise.resolve(handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "RTT REPLY" }], responseId: "resp-rtt", timestamp: T0 + 5000 } }, ctx));
	stale.rtt2 = await Promise.resolve(handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "SECOND REPLY" }], responseId: "resp-rtt2", timestamp: T0 + 5001 } }, ctx));

	gui.close();
	await new Promise((r) => setTimeout(r, 50));
}
// Feature A: primed non-empty plan applied (resp-abc → STALEFOLD).
if (stale.primedFold?.messages?.[1]?.content?.[0]?.text !== "STALEFOLD")
	fails.push(`stale-fallback: primed plan did not fold resp-abc (got ${JSON.stringify(stale.primedFold?.messages?.[1]?.content?.[0]?.text)})`);
// Feature A: on timeout the STALE plan is re-applied instead of passthrough.
if (!stale.staleFold?.messages) fails.push("stale-fallback: timeout passed through unfolded instead of applying the last known plan");
else if (stale.staleFold.messages[1]?.content?.[0]?.text !== "STALEFOLD")
	fails.push(`stale-fallback: timeout did not re-apply the cached fold (got ${JSON.stringify(stale.staleFold.messages[1]?.content?.[0]?.text)})`);
// Feature A: a delivered empty plan passes through AND is cached (not overridden by the older plan).
if (stale.emptyPass !== undefined) fails.push("stale-fallback: delivered empty plan did not pass through");
if (stale.afterEmptyPass !== undefined)
	fails.push("stale-fallback: a timeout after a delivered EMPTY plan wrongly resurrected the older non-empty plan");
// Feature C: rttMs stamped on the assistant message following a context wait.
// Unwrapped via the runner's `{ message }` contract (see unwrapMessageEnd above) — a
// regression to the pre-fix bare-message return makes this undefined, failing the test.
const rttMessage = unwrapMessageEnd(stale.rtt);
const rttVal = rttMessage?.usage?.rttMs;
if (!(typeof rttVal === "number" && Number.isInteger(rttVal) && rttVal >= 0))
	fails.push(`rttMs: assistant message_end did not carry an integer usage.rttMs (got ${JSON.stringify(rttVal)})`);
if (rttMessage?.role !== "assistant") fails.push("rttMs: injected message must keep role assistant");
// Feature C: no preceding context wait → the stash was cleared → no rttMs field leaks.
const rtt2Message = unwrapMessageEnd(stale.rtt2);
if (rtt2Message && rtt2Message.usage && typeof rtt2Message.usage.rttMs === "number")
	fails.push("rttMs: a message with no preceding context RTT wrongly received a rttMs field (stale stash leaked)");

// ── armed-over-wire: ARMED state (learned over the wire) drives blocking ──────
// The client sends {type:"armed", armed:bool}; the extension acks and switches its
// per-request plan wait between the short timeout (disarmed) and the hard deadline
// (armed). This replaces the old ACCORDION_STEERING env flag. Default env here:
// PLAN_TIMEOUT_MS=250, PLAN_DEADLINE_MS=10000. We never actually wait out the 10s
// deadline — we deliver the plan to unblock — but we DO prove an armed request blocks
// well past the 250ms short timeout that a disarmed request falls back at.
const armedSmoke = { ackTrue: null, ackFalse: null, disarmedMs: null, armedMs: null, inflightPendingPastTimeout: null, nextDisarmedMs: null };
{
	const gui = new WebSocket(`ws://127.0.0.1:${PORT}`);
	let lastAck = null;
	let lastSyncReqId = null;
	let replyMode = "ignore"; // "ignore" = withhold plan; "fold" = reply (optionally delayed)
	let planReplyDelayMs = 0;
	gui.on("message", (data) => {
		let m;
		try { m = JSON.parse(data.toString()); } catch { return; }
		if (m.type === "armedAck") { lastAck = m; return; }
		if (m.type !== "sync") return;
		lastSyncReqId = m.reqId;
		if (replyMode === "fold") {
			const deliver = () => { try { gui.send(JSON.stringify({ type: "plan", reqId: m.reqId, ops: [], groups: [] })); } catch { /* closed */ } };
			if (planReplyDelayMs > 0) setTimeout(deliver, planReplyDelayMs); else deliver();
		}
		// "ignore" → withhold (forces the fallback path / keeps the wait blocking)
	});
	await new Promise((res, rej) => { gui.on("open", res); gui.on("error", rej); });
	await new Promise((r) => setTimeout(r, 100)); // settle the view-only attach flush

	// 1) DISARMED (fresh connection defaults to disarmed): a withheld reply falls back at
	//    the SHORT timeout (~250ms). No armed message has been sent yet.
	replyMode = "ignore";
	let t0 = Date.now();
	await Promise.resolve(handlers.context({ messages: sample }, ctx));
	armedSmoke.disarmedMs = Date.now() - t0;

	// 2) Arm over the wire — the extension must ACK armed:true.
	gui.send(JSON.stringify({ type: "armed", armed: true }));
	await waitFor(() => lastAck?.armed === true, 1000, "armedAck(true)").catch(() => {});
	armedSmoke.ackTrue = lastAck;

	// 3) ARMED: a delayed reply (600ms — past the 250ms short timeout) must be WAITED for,
	//    proving the wait is deadline-scale and did not fall back at the short timeout.
	replyMode = "fold";
	planReplyDelayMs = 600;
	t0 = Date.now();
	await Promise.resolve(handlers.context({ messages: sample }, ctx));
	armedSmoke.armedMs = Date.now() - t0;

	// 4) Mid-toggle snapshot: a request that STARTS armed keeps blocking even if the client
	//    disarms mid-flight; only the NEXT request picks up the new (disarmed) value.
	//    Start an armed request with the reply withheld so it blocks on the deadline.
	replyMode = "ignore";
	planReplyDelayMs = 0;
	lastAck = null;
	let inflightResolved = false;
	const inflight = Promise.resolve(handlers.context({ messages: sample }, ctx)).then((r) => { inflightResolved = true; return r; });
	await new Promise((r) => setTimeout(r, 60)); // let the sync go out + the request register

	// Disarm mid-flight; wait for the ack so the module-level `armed` is now false.
	gui.send(JSON.stringify({ type: "armed", armed: false }));
	await waitFor(() => lastAck?.armed === false, 1000, "armedAck(false)").catch(() => {});
	armedSmoke.ackFalse = lastAck;

	// The in-flight request snapshotted armed=true, so it must STILL be blocking — NOT fallen
	// back at the 250ms short timeout. Assert it is unresolved comfortably past that window.
	await new Promise((r) => setTimeout(r, 350));
	armedSmoke.inflightPendingPastTimeout = !inflightResolved;

	// Unblock the in-flight request by answering its sync, so we don't wait the full deadline.
	if (lastSyncReqId !== null) gui.send(JSON.stringify({ type: "plan", reqId: lastSyncReqId, ops: [], groups: [] }));
	await inflight;

	// 5) The NEXT request snapshots armed=false → falls back at the SHORT timeout again.
	replyMode = "ignore";
	t0 = Date.now();
	await Promise.resolve(handlers.context({ messages: sample }, ctx));
	armedSmoke.nextDisarmedMs = Date.now() - t0;

	gui.close();
	await new Promise((r) => setTimeout(r, 50));
}
// armedAck round-trips.
if (!armedSmoke.ackTrue || armedSmoke.ackTrue.armed !== true) fails.push("armed: extension did not ack armed:true");
if (!armedSmoke.ackFalse || armedSmoke.ackFalse.armed !== false) fails.push("armed: extension did not ack armed:false");
// Disarmed default → short timeout (well under a second).
if (!(armedSmoke.disarmedMs !== null && armedSmoke.disarmedMs < 900))
	fails.push(`armed: disarmed wait ${armedSmoke.disarmedMs}ms did not fall back at the short timeout`);
// Armed → blocked past the short timeout for the 600ms delayed plan (deadline-scale).
if (!(armedSmoke.armedMs !== null && armedSmoke.armedMs >= 450))
	fails.push(`armed: armed wait ${armedSmoke.armedMs}ms fell back at the short timeout instead of blocking (deadline-scale expected)`);
// Mid-toggle: the in-flight armed request kept blocking despite a mid-flight disarm.
if (armedSmoke.inflightPendingPastTimeout !== true)
	fails.push("armed: in-flight request fell back at the short timeout after a mid-flight disarm (snapshot not honored)");
// Mid-toggle: the NEXT request picked up the disarmed value → short timeout again.
if (!(armedSmoke.nextDisarmedMs !== null && armedSmoke.nextDisarmedMs < 900))
	fails.push(`armed: request after disarm did not use the short timeout (${armedSmoke.nextDisarmedMs}ms)`);

// ── assertions ───────────────────────────────────────────────────────────────
if (!seen.hello) fails.push("never received hello");
if (!seen.flushOnAttach) fails.push("GUI received no history flush on attach (would stay empty until first message — the bug)");
if (seen.flushBlocks < 4) fails.push(`attach flush carried too few blocks: got ${seen.flushBlocks}, expected >=4`);
if (!seen.contextSync) fails.push("never received the post-flush context sync");
// Note: the post-flush context sync legitimately carries 0 delta blocks — the attach
// flush already delivered the whole history, so there is nothing fresh to re-send.
if (!contextReturn || !contextReturn.messages) fails.push("context hook did not return replacement messages");
else {
	const foldedText = contextReturn.messages[1]?.content?.[0]?.text;
	if (foldedText !== "FOLDED") fails.push(`a:resp-abc:p0 not folded — got ${JSON.stringify(foldedText)}`);
	const untargetedText = contextReturn.messages[3]?.content?.[0]?.text;
	if (untargetedText !== "second reply") fails.push("untargeted message (resp-def, no op in plan) was unexpectedly altered — structural passthrough broken");
	// Group collapse (ADR 0006): m0 (user "do the thing") was replaced by the one summary
	// entry; the array stays length 4 (one removed, one inserted) so the indices above hold.
	const groupText = contextReturn.messages[0]?.content?.[0]?.text;
	if (groupText !== "GROUPSUM") fails.push(`group did not collapse m0 to its summary — got ${JSON.stringify(groupText)}`);
	if (contextReturn.messages.some((mm) => mm?.content === "do the thing" || mm?.content?.[0]?.text === "do the thing"))
		fails.push("collapsed user message still present in the model array");
}

// shutdown must stop advertising (delete the registry entry)
handlers.session_shutdown({}, ctx);
await waitFor(() => !fs.existsSync(SESSIONS_DIR) || fs.readdirSync(SESSIONS_DIR).length === 0, 1000, "registry cleanup").catch(
	() => fails.push("session_shutdown did not delete the registry entry"),
);

// tidy the throwaway home
try {
	fs.rmSync(HOME, { recursive: true, force: true });
} catch {
	/* ignore */
}

if (fails.length) {
	console.error("SMOKE FAIL:\n - " + fails.join("\n - "));
	process.exit(1);
}
console.log(
	`SMOKE PASS — registry(port ${PORT}, model ✓, tokens ✓) ✓  no-GUI passthrough ✓  focus request ✓  ` +
		`hello ✓  attach-flush(${seen.flushBlocks} blocks on connect) ✓  plan applied per-block ✓  group collapse ✓  structural-passthrough ✓  ` +
		`message_end committed-streaming ✓  model-swap window-push ✓  tool-loop (2 msgs/turn) ✓  no-dup after context ✓  ` +
		`empty-leading-part dedup ✓  agent_end live-view ✓  shutdown cleanup ✓  ` +
		`stream(start/end/abort) ✓  no-content-on-frame ✓  delta-dropped ✓  ` +
		`message_end ghost-sweep ✓  agent_end ghost-sweep ✓  ` +
			`resumed-session attach-flush ✓  getBranch fallback ✓  ` +
				`anchor-less positional-id round-trip ✓  applyPlan guard (positional + empty-digest refused) ✓  ` +
					`unfold tool (no-ids / detached guards, attached round-trip) ✓  ` +
					`recall tool (no-ids / detached guards, content-echo round-trip) ✓  skill discovery ✓  ` +
					`stale-plan fallback (timeout re-applies last plan, empty plan not overridden) ✓  rttMs stamp ✓  ` +
						`armed-over-wire (ack, disarmed=short / armed=deadline, mid-toggle snapshot) ✓`,
);
process.exit(0);
