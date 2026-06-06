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
import * as os from "node:os";
import * as path from "node:path";

// Point the registry at a throwaway dir BEFORE loading the extension (it reads
// ACCORDION_HOME at module load) so we never touch the real ~/.accordion.
const HOME = path.join(os.tmpdir(), `accordion-smoke-${process.pid}`);
process.env.ACCORDION_HOME = HOME;
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
const pi = {
	on: (name, fn) => (handlers[name] = fn),
	registerCommand: (name, def) => {
		if (name === "accordion") accordionCmd = def.handler;
	},
	appendEntry: () => {},
};
accordionLive(pi);
const ctx = {
	ui: { setStatus() {}, notify() {}, theme: { fg: (_c, s) => s } },
	getModel: () => ({ id: "test/model", contextWindow: 1000 }),
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
} else {
	fails.push("accordion command was not registered");
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
			ws.send(JSON.stringify({ type: "plan", reqId: m.reqId, ops: [{ id: "a:resp-abc:p0", digestText: "FOLDED" }] }));
			setTimeout(() => {
				clearTimeout(timeout);
				resolve();
			}, 150);
		}
	});
});

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
	const protectedText = contextReturn.messages[3]?.content?.[0]?.text;
	if (protectedText !== "second reply") fails.push("recent message was unexpectedly altered");
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
		`hello ✓  attach-flush(${seen.flushBlocks} blocks on connect) ✓  plan applied per-block ✓  backstop ✓  ` +
		`message_end committed-streaming ✓  tool-loop (2 msgs/turn) ✓  no-dup after context ✓  ` +
		`empty-leading-part dedup ✓  agent_end live-view ✓  shutdown cleanup ✓  ` +
		`stream(start/end/abort) ✓  no-content-on-frame ✓  delta-dropped ✓  ` +
		`message_end ghost-sweep ✓  agent_end ghost-sweep ✓  ` +
			`resumed-session attach-flush ✓  getBranch fallback ✓`,
);
process.exit(0);
