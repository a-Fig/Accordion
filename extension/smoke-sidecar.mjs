/*
 * smoke-sidecar.mjs — end-to-end exercise of the stdio sidecar (docs/sidecar-protocol.md v1).
 *
 * Spawns the BUILT bundle (`extension/sidecar.mjs`) as a real child process with an isolated HOME,
 * speaks JSON-lines at it exactly like the mistral-vibe fork will, and checks the contract.
 *
 * SCENARIO 1 (the long-lived session)
 *   • hello → ready (tools unfold+recall with serialized JSON-Schema parameters, command accordion)
 *   • session_start with vibe-native LLMMessages → a correct ~/.accordion registry entry
 *   • context with folding OFF → hook_result{messages:null} (passthrough)
 *   • a real GUI WebSocket client steering the session: durable block ids derived from `message_id`
 *     / `tool_call_id`, setProtect / setFolding / fold
 *   • the `folding` seam (the sidecar is not a WS client, so it learns the arm through
 *     RuntimeDependencies.onFoldingChanged)
 *   • context with folding ON → the folded blocks come back as ORIGINAL vibe LLMMessage JSON with
 *     ONLY content / reasoning_content overwritten: message_id, tool_calls, reasoning_payloads and
 *     the system message at index 0 all survive byte-identical
 *   • tool{name:"recall"} → the ORIGINAL folded text; unknown tool/command answer instead of hanging
 *   • command{name:"accordion"} → notify lines then command_result
 *   • THE NO-MESSAGE-LEFT-BEHIND CASES — every one of these asserts `out.length === in.length`, the
 *     shapes the converter cannot represent as blocks and therefore used to DELETE from the wire:
 *       H1  an assistant turn with only payload-bearing reasoning / empty content
 *       H2  a context request with an empty or absent `messages` (must not wipe the Truth)
 *       H3  a SECOND system message mid-conversation (never hoisted, never overwritten)
 *       H4  a tool call with no `id` (would orphan its result through the pair fixpoint)
 *       M5  a duplicate `message_id` (unfoldable, not mis-foldable) and a duplicate `tool_call_id`
 *       M6  a harness that stops sending a system message (stale bolted prompt must not stand)
 *       M8  a repeat `hello` restates the CURRENT folding arm, not a hardcoded false
 *   • shutdown → exit 0, registry entry removed
 *
 * SCENARIO 2 — M7: a terminating SIGNAL still runs the full teardown (POSIX; on Windows the same
 *   `shutdown()` is exercised through stdin EOF, since Node cannot deliver SIGTERM there at all).
 * SCENARIO 3 — L12: an over-long stdin line is dropped and the reader RESYNCS at the next newline.
 *
 * Run: node ./build-sidecar.mjs && node smoke-sidecar.mjs      (npm run smoke:sidecar)
 */
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(here, "sidecar.mjs");
if (!fs.existsSync(BUNDLE)) {
	console.error(`smoke-sidecar: ${BUNDLE} not found — run \`node ./build-sidecar.mjs\` first.`);
	process.exit(1);
}

const fails = [];
const DEBUG = process.env.SMOKE_SIDECAR_DEBUG === "1";
const ROOT = path.join(os.tmpdir(), `accordion-sidecar-smoke-${process.pid}`);

async function waitFor(predicate, ms, label) {
	const start = Date.now();
	for (;;) {
		const v = predicate();
		if (v) return v;
		if (Date.now() - start >= ms) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 15));
	}
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Spawn one sidecar with a private HOME. Returns the child plus a parsed-message inbox; a stdout
 * line that is NOT JSON is recorded as a protocol violation (the channel carries JSON-lines only).
 */
function spawnSidecar(name, extraEnv = {}) {
	const home = path.join(ROOT, name);
	const cwd = path.join(home, "session-cwd");
	fs.mkdirSync(cwd, { recursive: true });
	const child = spawn(process.execPath, [BUNDLE], {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			ACCORDION_HOME: home,
			// Never bind the real fixed door port from a test, and never launch a real desktop build.
			ACCORDION_DOOR_PORT: "0",
			ACCORDION_APP_PATH: path.join(home, "missing-accordion-app.exe"),
			...extraEnv,
		},
	});
	const inbox = [];
	const state = { exitCode: null, stdoutViolation: null, stderr: "" };
	let buf = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buf += chunk;
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const raw = buf.slice(0, nl).replace(/\r$/, "");
			buf = buf.slice(nl + 1);
			if (!raw.trim()) continue;
			try {
				inbox.push(JSON.parse(raw));
			} catch {
				state.stdoutViolation ??= raw;
			}
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (d) => {
		state.stderr += d;
		if (DEBUG) process.stderr.write(`[${name} stderr] ${d}`);
	});
	child.on("exit", (code) => (state.exitCode = code));
	return {
		name,
		child,
		inbox,
		state,
		home,
		cwd,
		sessionsDir: path.join(home, ".accordion", "sessions"),
		send: (msg) => child.stdin.write(JSON.stringify(msg) + "\n"),
		find: (type, pred = () => true) => () => inbox.find((m) => m.type === type && pred(m)),
		entries: () => {
			const dir = path.join(home, ".accordion", "sessions");
			if (!fs.existsSync(dir)) return [];
			return fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
		},
	};
}

// ═════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — the long-lived session
// ═════════════════════════════════════════════════════════════════════════════
const S = spawnSidecar("main");

// ── canned vibe session (realistic LLMMessage JSON per vibe/core/types.py) ────
const SYSTEM = { role: "system", content: "You are a helpful coding assistant.", message_id: "vm-sys-0" };
const THINK_TEXT =
	"ORIGINAL REASONING — long enough that folding it to a short digest genuinely saves tokens, and long enough that a recall of it is unmistakably the full original body rather than a digest.";
const TOOL_TEXT =
	"ORIGINAL TOOL RESULT — a big file read, long enough that folding it to a short digest genuinely saves tokens, and unmistakable when recall returns it verbatim.";
const USER = { role: "user", content: "read config.toml and summarize it", message_id: "vm-user-1" };
const ASST_CALL = {
	role: "assistant",
	content: "Reading the file now.",
	reasoning_content: THINK_TEXT,
	reasoning_payloads: null,
	tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"config.toml"}' } }],
	message_id: "vm-asst-1",
};
const TOOL = { role: "tool", content: TOOL_TEXT, tool_call_id: "call-1", name: "read_file", message_id: "vm-tool-1" };
const ASST_TEXT = {
	role: "assistant",
	content: "config.toml sets the model and the temperature.",
	reasoning_content: null,
	reasoning_payloads: null,
	tool_calls: null,
	message_id: "vm-asst-2",
};
const MESSAGES = [SYSTEM, USER, ASST_CALL, TOOL, ASST_TEXT];
// Durable block ids `core/wire.ts blockId()` derives from these (messageId / toolCallId anchors).
const THINK_ID = "a:vm-asst-1:p0";
const TOOLRESULT_ID = "r:call-1";

// ── hello → ready ────────────────────────────────────────────────────────────
S.send({
	type: "hello",
	v: 1,
	harness: "vibe",
	harnessVersion: "0.0.0-smoke",
	sessionId: "vibe-smoke-session",
	cwd: S.cwd,
	model: { id: "mistral/devstral-smoke", provider: "mistral", contextWindow: 128000 },
	flags: {},
});
const ready = await waitFor(S.find("ready"), 5000, "ready").catch((e) => {
	fails.push(String(e.message));
	return null;
});
if (ready) {
	console.log("ready payload observed:\n" + JSON.stringify(ready, null, 2).slice(0, 4000));
	if (ready.v !== 1) fails.push(`ready.v expected 1, got ${ready.v}`);
	if (typeof ready.protocolVersion !== "number") fails.push("ready.protocolVersion is not a number");
	const toolNames = (ready.tools || []).map((t) => t.name).sort();
	if (toolNames.join(",") !== "recall,unfold") fails.push(`ready.tools expected unfold+recall, got ${JSON.stringify(toolNames)}`);
	for (const t of ready.tools || []) {
		if (!t.description) fails.push(`ready tool ${t.name} has no description`);
		if (!t.parameters || t.parameters.type !== "object" || !t.parameters.properties?.codes)
			fails.push(`ready tool ${t.name} parameters is not a serialized JSON Schema with a \`codes\` property (got ${JSON.stringify(t.parameters)})`);
	}
	if (!(ready.commands || []).some((c) => c.name === "accordion")) fails.push(`ready.commands missing "accordion" (got ${JSON.stringify(ready.commands)})`);
	if (!Array.isArray(ready.flags)) fails.push("ready.flags is not an array");
}
// The initial arm must be announced explicitly (setFolding only fires the seam on a real change).
// `ready` and this line are two separate writes, so they can land in two stdout chunks — wait.
await waitFor(S.find("folding", (m) => m.enabled === false), 3000, "the initial folding{enabled:false}").catch((e) => fails.push(String(e.message)));

// ── session_start → the registry entry ───────────────────────────────────────
S.send({ type: "session_start", reason: "start", messages: MESSAGES });
const entry = await waitFor(
	() => {
		const f = S.entries();
		if (f.length !== 1) return null;
		try {
			const e = JSON.parse(fs.readFileSync(path.join(S.sessionsDir, f[0]), "utf8"));
			return e.port > 0 ? e : null;
		} catch {
			return null;
		}
	},
	5000,
	"registry entry with a bound port",
).catch((e) => {
	fails.push(String(e.message));
	return null;
});
if (entry) {
	if (entry.model !== "mistral/devstral-smoke") fails.push(`registry model not captured (got ${JSON.stringify(entry.model)})`);
	if (entry.contextWindow !== 128000) fails.push(`registry contextWindow not captured (got ${entry.contextWindow})`);
	if (path.resolve(entry.cwd) !== path.resolve(S.cwd)) fails.push(`registry cwd expected ${S.cwd}, got ${entry.cwd}`);
	if (typeof entry.title !== "string" || !entry.title) fails.push(`registry title missing (got ${JSON.stringify(entry.title)})`);
	if (entry.harness !== "vibe") fails.push(`registry harness expected "vibe" (got ${JSON.stringify(entry.harness)})`);
	if (entry.title !== `vibe · ${path.basename(S.cwd)}`) fails.push(`registry title expected "vibe · <cwd basename>" (got ${JSON.stringify(entry.title)})`);
}
const PORT = entry?.port;

// ── context, folding OFF → passthrough ───────────────────────────────────────
S.send({ type: "context", req: "ctx-1", messages: MESSAGES, model: { id: "mistral/devstral-smoke", contextWindow: 128000 } });
{
	const r = await waitFor(S.find("hook_result", (m) => m.req === "ctx-1"), 5000, "hook_result for ctx-1").catch((e) => {
		fails.push(String(e.message));
		return null;
	});
	if (r && r.messages !== null) fails.push(`folding OFF should reply messages:null, got ${JSON.stringify(r.messages)?.slice(0, 200)}`);
}

// ── a GUI client steers the session over the live link ───────────────────────
let ws = null;
const wsInbox = { hello: [], snapshot: [], event: [], commandResult: [], controller: [] };
if (PORT) {
	ws = new WebSocket(`ws://127.0.0.1:${PORT}/?surface=surface-sidecar-smoke&label=Smoke%20surface`);
	ws.on("message", (d) => {
		let m;
		try {
			m = JSON.parse(d.toString());
		} catch {
			return;
		}
		(wsInbox[m.type] ||= []).push(m);
	});
	await waitFor(() => wsInbox.snapshot.length > 0, 5000, "GUI snapshot").catch((e) => fails.push(String(e.message)));
	const snap = wsInbox.snapshot[0];
	const ids = snap ? snap.state.blocks.map((b) => b.id) : [];
	// The whole point of `messageId` in blockId(): vibe has no timestamps, so without it these
	// would all be positional `m<i>:…` ids that `canFold` refuses to fold.
	for (const want of ["u:vm-user-1", THINK_ID, "a:vm-asst-1:p1", "a:vm-asst-1:p2", TOOLRESULT_ID, "a:vm-asst-2:p0"]) {
		if (!ids.includes(want)) fails.push(`snapshot missing durable block id ${want} (got ${JSON.stringify(ids)})`);
	}
	// The system message became the BOLTED system block, not a conversation block.
	const sys = snap?.state.blocks.find((b) => b.kind === "system");
	if (!sys) fails.push("the vibe system message did not become a bolted `system` block");
	else if (sys.text !== SYSTEM.content) fails.push(`system block text mismatch (got ${JSON.stringify(sys.text)})`);

	let seq = 0;
	const sendCmd = (cmd) => ws.send(JSON.stringify({ type: "command", seq: ++seq, cmd }));
	ws.send(JSON.stringify({ type: "claimController" }));
	await waitFor(() => wsInbox.controller.some((c) => c.surfaceId === "surface-sidecar-smoke"), 3000, "controller lease").catch((e) =>
		fails.push(String(e.message)),
	);
	sendCmd({ kind: "setProtect", value: 0 });
	sendCmd({ kind: "setFolding", value: true });
	sendCmd({ kind: "ops", ops: [{ kind: "fold", ids: [THINK_ID, TOOLRESULT_ID] }] });
	await waitFor(() => wsInbox.commandResult.length >= 3, 3000, "3 commandResults").catch((e) => fails.push(String(e.message)));
	const refused = wsInbox.commandResult.filter((r) => r.refused);
	if (refused.length) fails.push(`a steering command was refused: ${JSON.stringify(refused)}`);
}

// The `folding` seam: the sidecar is NOT a WS client, so this can only have come from
// RuntimeDependencies.onFoldingChanged.
await waitFor(() => S.inbox.some((m) => m.type === "folding" && m.enabled === true), 3000, "folding{enabled:true} on stdout").catch((e) =>
	fails.push(`${e.message} — the onFoldingChanged seam did not reach the harness`),
);

// ── context, folding ON → back-converted vibe LLMMessages ────────────────────
let toolFoldCode = null;
S.send({ type: "context", req: "ctx-2", messages: MESSAGES, model: { id: "mistral/devstral-smoke", contextWindow: 128000 } });
{
	const r = await waitFor(S.find("hook_result", (m) => m.req === "ctx-2"), 5000, "hook_result for ctx-2").catch((e) => {
		fails.push(String(e.message));
		return null;
	});
	const out = r?.messages;
	if (!Array.isArray(out)) {
		fails.push(`folding ON should reply a messages array, got ${JSON.stringify(r?.messages)?.slice(0, 200)}`);
	} else {
		if (out.length !== MESSAGES.length) fails.push(`expected ${MESSAGES.length} messages back, got ${out.length}`);
		// (1) the system message rides at index 0, byte-identical.
		if (!eq(out[0], SYSTEM)) fails.push(`system message not re-inserted byte-identical (got ${JSON.stringify(out[0])})`);
		// (2) the user message is untouched.
		if (!eq(out[1], USER)) fails.push(`untargeted user message was altered (got ${JSON.stringify(out[1])})`);
		// (3) the assistant tool-call message: reasoning_content folded to a digest, EVERYTHING else
		//     preserved — content, tool_calls, reasoning_payloads, message_id.
		const a = out[2] || {};
		if (typeof a.reasoning_content !== "string" || !/^\{#[0-9a-z]{6} FOLDED\}/.test(a.reasoning_content))
			fails.push(`assistant reasoning_content was not folded to a digest (got ${JSON.stringify(a.reasoning_content)?.slice(0, 160)})`);
		if (a.content !== ASST_CALL.content) fails.push(`assistant content changed when only its thinking was folded (got ${JSON.stringify(a.content)})`);
		if (!eq(a.tool_calls, ASST_CALL.tool_calls)) fails.push(`assistant tool_calls not preserved (got ${JSON.stringify(a.tool_calls)})`);
		if (a.reasoning_payloads !== null) fails.push(`assistant reasoning_payloads not preserved (got ${JSON.stringify(a.reasoning_payloads)})`);
		if (a.message_id !== "vm-asst-1") fails.push(`assistant message_id not preserved (got ${JSON.stringify(a.message_id)})`);
		// (4) the tool message: content folded, tool_call_id / name / message_id preserved.
		const t = out[3] || {};
		if (typeof t.content !== "string" || !/^\{#([0-9a-z]{6}) FOLDED\}/.test(t.content))
			fails.push(`tool result content was not folded to a digest (got ${JSON.stringify(t.content)?.slice(0, 160)})`);
		else toolFoldCode = t.content.match(/\{#([0-9a-z]{6}) FOLDED\}/)[1];
		if (t.tool_call_id !== "call-1" || t.name !== "read_file" || t.message_id !== "vm-tool-1")
			fails.push(`tool message identity fields not preserved (got ${JSON.stringify(t)?.slice(0, 200)})`);
		// (5) the trailing assistant message was NOT folded and is byte-identical.
		if (!eq(out[4], ASST_TEXT)) fails.push(`unfolded trailing assistant message was altered (got ${JSON.stringify(out[4])})`);
		// (6) every message_id survived, in order.
		const gotIds = out.map((m) => m.message_id);
		const wantIds = MESSAGES.map((m) => m.message_id);
		if (!eq(gotIds, wantIds)) fails.push(`message_ids not preserved in order: ${JSON.stringify(gotIds)} != ${JSON.stringify(wantIds)}`);
	}
}

// ── the recall tool over the protocol ────────────────────────────────────────
if (toolFoldCode) {
	S.send({ type: "tool", req: "tool-1", name: "recall", args: { codes: [toolFoldCode] } });
	const r = await waitFor(S.find("tool_result", (m) => m.req === "tool-1"), 5000, "tool_result for recall").catch((e) => {
		fails.push(String(e.message));
		return null;
	});
	if (r) {
		if (r.isError !== false) fails.push(`recall reported isError=${r.isError}`);
		if (typeof r.content !== "string" || !r.content.includes(TOOL_TEXT)) fails.push(`recall did not return the original tool text (got ${JSON.stringify(r.content)?.slice(0, 200)})`);
	}
} else {
	fails.push("no fold code recovered — skipped the recall check");
}

// ── an unknown tool must answer, not hang ────────────────────────────────────
S.send({ type: "tool", req: "tool-2", name: "no-such-tool", args: {} });
{
	const r = await waitFor(S.find("tool_result", (m) => m.req === "tool-2"), 3000, "tool_result for an unknown tool").catch((e) => {
		fails.push(String(e.message));
		return null;
	});
	if (r && r.isError !== true) fails.push("an unknown tool should answer isError:true");
}

// ── the /accordion command: notify lines, then command_result ────────────────
{
	// Scope the notify search to messages emitted AFTER this request was sent, so an unrelated
	// earlier notify (a startup warning, a `notice`) can never satisfy the assertion.
	const before = S.inbox.length;
	S.send({ type: "command", req: "cmd-1", name: "accordion", args: "" });
	const r = await waitFor(S.find("command_result", (m) => m.req === "cmd-1"), 8000, "command_result for accordion").catch((e) => {
		fails.push(String(e.message));
		return null;
	});
	if (r && r.ok !== true) fails.push(`the accordion command failed: ${JSON.stringify(r)}`);
	const after = S.inbox.slice(before);
	const notifyIdx = after.findIndex((m) => m.type === "notify");
	const resultIdx = after.findIndex((m) => m.type === "command_result" && m.req === "cmd-1");
	if (notifyIdx < 0) fails.push("the accordion command emitted no `notify`");
	else if (resultIdx >= 0 && notifyIdx > resultIdx) fails.push("`notify` must arrive before `command_result`");
}
// An unknown command must answer too.
S.send({ type: "command", req: "cmd-2", name: "nope", args: "" });
{
	const r = await waitFor(S.find("command_result", (m) => m.req === "cmd-2"), 3000, "command_result for an unknown command").catch((e) => {
		fails.push(String(e.message));
		return null;
	});
	if (r && r.ok !== false) fails.push("an unknown command should answer ok:false");
}

// ═════════════════════════════════════════════════════════════════════════════
// THE NO-MESSAGE-LEFT-BEHIND CASES
// Folding is ARMED from here on, so every `context` reply is a real back-conversion. Each case
// asserts `out.length === in.length` first: that single invariant is what "the bridge never deletes
// a message" reduces to.
// ═════════════════════════════════════════════════════════════════════════════
let caseSeq = 0;
/** Send one `context` with an arbitrary shape and return the replied LLMMessage array (or null). */
async function contextCase(label, messages) {
	const req = `case-${++caseSeq}`;
	S.send({ type: "context", req, messages, model: { id: "mistral/devstral-smoke", contextWindow: 128000 } });
	const r = await waitFor(S.find("hook_result", (m) => m.req === req), 5000, `hook_result for ${label}`).catch((e) => {
		fails.push(String(e.message));
		return null;
	});
	return r ? r.messages : null;
}
/** The shared length assertion. Returns the array when it is usable, else null. */
function expectSameLength(label, out, input) {
	if (!Array.isArray(out)) {
		fails.push(`${label}: expected a messages array, got ${JSON.stringify(out)?.slice(0, 200)}`);
		return null;
	}
	if (out.length !== input.length) {
		fails.push(`${label}: MESSAGE LOST — sent ${input.length}, got back ${out.length}: ${JSON.stringify(out.map((m) => m?.message_id ?? m?.role))}`);
		return null;
	}
	return out;
}

// ── H2: an empty / absent `messages` must reply null and NOT touch the Truth ──
{
	const snapsBefore = wsInbox.snapshot.length;
	S.send({ type: "context", req: "h2-empty", messages: [], model: { id: "mistral/devstral-smoke" } });
	const a = await waitFor(S.find("hook_result", (m) => m.req === "h2-empty"), 5000, "hook_result for h2-empty").catch((e) => {
		fails.push(String(e.message));
		return null;
	});
	if (a && a.messages !== null) fails.push(`H2: an empty messages array must reply null, got ${JSON.stringify(a.messages)?.slice(0, 200)}`);
	S.send({ type: "context", req: "h2-absent", model: { id: "mistral/devstral-smoke" } });
	const b = await waitFor(S.find("hook_result", (m) => m.req === "h2-absent"), 5000, "hook_result for h2-absent").catch((e) => {
		fails.push(String(e.message));
		return null;
	});
	if (b && b.messages !== null) fails.push(`H2: an absent messages field must reply null, got ${JSON.stringify(b.messages)?.slice(0, 200)}`);
	// A wipe would rebuild the Truth from nothing and force every client to resnapshot.
	await settle();
	if (wsInbox.snapshot.length !== snapsBefore) fails.push("H2: an empty context request forced a resnapshot — the Truth was rebuilt/wiped");
	// And the session must still be intact: the original wire still round-trips whole.
	const out = await contextCase("H2 recovery", MESSAGES);
	expectSameLength("H2 recovery", out, MESSAGES);
	if (Array.isArray(out) && !eq(out[0], SYSTEM)) fails.push("H2: the system prompt did not survive the empty request");
}

// ── H1: an assistant turn the converter cannot represent survives untouched ──
{
	const OPAQUE = {
		role: "assistant",
		content: "",
		reasoning_content: "provider-opaque chain of thought",
		// payload-bearing ⇒ never representable as a thinking block, so this message has NO blocks
		reasoning_payloads: [{ signature: "opaque-sig-1", data: "AAAA" }],
		tool_calls: null,
		message_id: "vm-opaque-1",
	};
	const EMPTY_TURN = { role: "assistant", content: "", reasoning_content: null, reasoning_payloads: null, tool_calls: null, message_id: "vm-empty-1" };
	const input = [SYSTEM, USER, OPAQUE, EMPTY_TURN, ASST_TEXT];
	const out = expectSameLength("H1", await contextCase("H1", input), input);
	if (out) {
		if (!eq(out[2], OPAQUE)) fails.push(`H1: the payload-bearing reasoning message was altered or replaced (got ${JSON.stringify(out[2])?.slice(0, 240)})`);
		if (!eq(out[3], EMPTY_TURN)) fails.push(`H1: the empty assistant turn was altered or replaced (got ${JSON.stringify(out[3])?.slice(0, 240)})`);
		if (!eq(out[0], SYSTEM)) fails.push("H1: the system message moved");
	}
}

// ── H3: a SECOND system message is content, never the bolted prompt ──────────
{
	const SYSTEM2 = { role: "system", content: "MID-CONVERSATION SYSTEM NOTE — must not be hoisted or dropped.", message_id: "vm-sys-mid" };
	const input = [SYSTEM, USER, SYSTEM2, ASST_TEXT];
	const out = expectSameLength("H3", await contextCase("H3", input), input);
	if (out) {
		if (!eq(out[0], SYSTEM)) fails.push(`H3: index 0 is no longer the leading system message (got ${JSON.stringify(out[0])?.slice(0, 200)})`);
		if (!eq(out[2], SYSTEM2)) fails.push(`H3: the mid-conversation system message was dropped or relocated (got ${JSON.stringify(out[2])?.slice(0, 200)})`);
	}
}

// ── H4: a tool call with no `id` keeps its whole message off the block set ───
{
	const CALL_NO_ID = {
		role: "assistant",
		content: "calling without an id",
		reasoning_content: null,
		reasoning_payloads: null,
		tool_calls: [{ type: "function", function: { name: "read_file", arguments: "{}" } }], // no `id`
		message_id: "vm-noid-1",
	};
	const RESULT_NO_ID = { role: "tool", content: "result for the id-less call", tool_call_id: "", name: "read_file", message_id: "vm-noid-2" };
	const input = [SYSTEM, USER, CALL_NO_ID, RESULT_NO_ID, ASST_TEXT];
	const out = expectSameLength("H4", await contextCase("H4", input), input);
	if (out) {
		if (!eq(out[2], CALL_NO_ID)) fails.push(`H4: the id-less tool call message was altered (got ${JSON.stringify(out[2])?.slice(0, 240)})`);
		if (!eq(out[3], RESULT_NO_ID)) fails.push(`H4: the orphan-risk tool result was altered (got ${JSON.stringify(out[3])?.slice(0, 240)})`);
	}
}

// ── M5: duplicate message_id ⇒ unfoldable, not mis-foldable; both bodies live ─
{
	const DUP_A = { role: "user", content: "FIRST BODY under the duplicated id", message_id: "vm-dup" };
	const DUP_B = { role: "user", content: "SECOND BODY under the duplicated id", message_id: "vm-dup" };
	const input = [SYSTEM, DUP_A, ASST_TEXT, DUP_B];
	const snapsBefore = wsInbox.snapshot.length;
	const out = expectSameLength("M5 message_id", await contextCase("M5 message_id", input), input);
	if (out) {
		if (out[1].content !== DUP_A.content || out[3].content !== DUP_B.content)
			fails.push(`M5: a duplicated message_id cross-contaminated the two bodies (got ${JSON.stringify([out[1].content, out[3].content])})`);
	}
	// The SECOND occurrence must carry a POSITIONAL (non-durable) block id, which `canFold` refuses:
	// exactly one `u:vm-dup` may exist, and the duplicate shows up as `m<i>:u`.
	await waitFor(() => wsInbox.snapshot.length > snapsBefore, 3000, "resnapshot after the duplicate-id rebuild").catch(() => {});
	const ids = wsInbox.snapshot.at(-1)?.state.blocks.map((b) => b.id) ?? [];
	if (ids.filter((id) => id === "u:vm-dup").length !== 1) fails.push(`M5: expected exactly one durable u:vm-dup block, got ${JSON.stringify(ids)}`);
	if (!ids.some((id) => /^m\d+:u$/.test(id))) fails.push(`M5: the duplicate did not fall back to a positional (unfoldable) id (got ${JSON.stringify(ids)})`);
}

// ── M5: duplicate tool_call_id ⇒ the repeat rides through as a passthrough ───
{
	const CALL = {
		role: "assistant",
		content: "one call",
		reasoning_content: null,
		reasoning_payloads: null,
		tool_calls: [{ id: "dup-call", type: "function", function: { name: "read_file", arguments: "{}" } }],
		message_id: "vm-dupcall-1",
	};
	const R1 = { role: "tool", content: "FIRST result body", tool_call_id: "dup-call", name: "read_file", message_id: "vm-dupcall-r1" };
	const R2 = { role: "tool", content: "SECOND result body under the same call id", tool_call_id: "dup-call", name: "read_file", message_id: "vm-dupcall-r2" };
	const input = [SYSTEM, USER, CALL, R1, R2, ASST_TEXT];
	const out = expectSameLength("M5 tool_call_id", await contextCase("M5 tool_call_id", input), input);
	if (out && (out[3].content !== R1.content || out[4].content !== R2.content))
		fails.push(`M5: a duplicated tool_call_id cross-contaminated the two results (got ${JSON.stringify([out[3].content, out[4].content])})`);
}

// ── M6: the harness stops sending a system message ──────────────────────────
{
	const input = [USER, ASST_TEXT];
	const snapsBefore = wsInbox.snapshot.length;
	const out = expectSameLength("M6", await contextCase("M6", input), input);
	if (out) {
		if (!eq(out[0], USER)) fails.push(`M6: a system message was invented at index 0 (got ${JSON.stringify(out[0])?.slice(0, 200)})`);
	}
	// The stale bolted prompt must not still be standing with its tokens counted.
	await waitFor(() => wsInbox.snapshot.length > snapsBefore, 3000, "resnapshot after the no-system rebuild").catch(() => {});
	const sys = wsInbox.snapshot.at(-1)?.state.blocks.find((b) => b.kind === "system");
	if (sys && sys.text) fails.push(`M6: the stale system prompt is still standing (${JSON.stringify(sys.text)?.slice(0, 120)}, ${sys.tokens} tokens)`);
}

// ── M8: a repeat `hello` restates the CURRENT arm, not a hardcoded false ────
{
	const before = S.inbox.length;
	S.send({ type: "hello", v: 1, harness: "vibe", sessionId: "vibe-smoke-session", cwd: S.cwd, model: { id: "mistral/devstral-smoke", contextWindow: 128000 } });
	await waitFor(() => S.inbox.slice(before).some((m) => m.type === "ready"), 3000, "ready for the repeat hello").catch((e) => fails.push(String(e.message)));
	const f = S.inbox.slice(before).find((m) => m.type === "folding");
	if (!f) fails.push("M8: the repeat hello did not restate the folding arm");
	else if (f.enabled !== true) fails.push(`M8: the repeat hello reported folding ${f.enabled} while the arm is ON — the harness would switch its compaction back on`);
}

// An unknown message type is ignored, never fatal.
S.send({ type: "definitely-not-a-real-type", req: "x" });
S.send({ type: "usage", promptTokens: 1234, completionTokens: 56, contextWindow: 128000 });

// ── shutdown → exit 0 ────────────────────────────────────────────────────────
try {
	ws?.close();
} catch {
	/* ignore */
}
S.send({ type: "shutdown" });
await waitFor(() => S.state.exitCode !== null, 8000, "sidecar exit").catch((e) => fails.push(String(e.message)));
if (S.state.exitCode !== 0) fails.push(`sidecar exited with code ${S.state.exitCode}, expected 0`);
if (S.entries().length) fails.push("the registry entry was not removed on shutdown");
if (S.state.stdoutViolation !== null) fails.push(`stdout carried a non-JSON line: ${JSON.stringify(S.state.stdoutViolation.slice(0, 200))}`);

// ═════════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — M7: a terminating signal still runs the full teardown
// ═════════════════════════════════════════════════════════════════════════════
{
	const T = spawnSidecar("signal");
	T.send({ type: "hello", v: 1, harness: "vibe", sessionId: "sig", cwd: T.cwd, model: { id: "m/sig", contextWindow: 1000 } });
	await waitFor(T.find("ready"), 5000, "signal-scenario ready").catch((e) => fails.push(String(e.message)));
	T.send({ type: "session_start", reason: "start", messages: MESSAGES });
	await waitFor(() => T.entries().length === 1, 5000, "signal-scenario registry entry").catch((e) => fails.push(String(e.message)));

	if (process.platform === "win32") {
		// Node cannot DELIVER SIGTERM on Windows (`process.kill` maps to TerminateProcess and the
		// handler never runs), so the signal path itself is untestable here. Exercise the same
		// `shutdown()` through the other unprompted-teardown route the harness can trigger — stdin EOF.
		console.log("  note: SIGTERM delivery is not possible on win32 — asserting the stdin-EOF teardown instead");
		// The signal path itself cannot be exercised here, so guard it structurally: without this a
		// future deletion of the handlers would pass forever on a Windows-only run.
		const bundle = fs.readFileSync(BUNDLE, "utf8");
		for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
			if (!bundle.includes(sig)) fails.push(`M7: the built sidecar registers no ${sig} handler (teardown would leak the registry entry on POSIX)`);
		}
		T.child.stdin.end();
	} else {
		T.child.kill("SIGTERM");
	}
	await waitFor(() => T.state.exitCode !== null, 8000, "signal-scenario exit").catch((e) => fails.push(String(e.message)));
	if (T.state.exitCode !== 0) fails.push(`M7: teardown exited with code ${T.state.exitCode}, expected 0`);
	if (T.entries().length) fails.push("M7: the registry entry leaked — the session stays listed as live after termination");
	if (T.state.stdoutViolation !== null) fails.push(`M7: stdout carried a non-JSON line: ${JSON.stringify(T.state.stdoutViolation.slice(0, 200))}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — L12: an over-long stdin line is dropped, and the reader resyncs
// ═════════════════════════════════════════════════════════════════════════════
{
	const CAP = 4096;
	const B = spawnSidecar("bigline", { ACCORDION_SIDECAR_MAX_LINE: String(CAP) });
	// Handshake FIRST, so the reader is provably live before the flood — otherwise the three writes
	// below can coalesce into one pipe chunk that happens to contain a newline, the cap never trips,
	// and the case silently tests nothing.
	B.send({ type: "hello", v: 1, harness: "vibe", sessionId: "big", cwd: B.cwd, model: { id: "m/big", contextWindow: 1000 } });
	await waitFor(B.find("ready"), 5000, "bigline ready").catch((e) => fails.push(String(e.message)));

	// A newline-free flood past the cap. Unbounded, this grows until the process dies of memory
	// pressure; capped, the buffer is dropped and the reader starts discarding to the next newline.
	B.child.stdin.write("x".repeat(CAP * 3));
	await waitFor(() => B.state.stderr.includes("exceeded"), 5000, "the over-long-line warning").catch((e) =>
		fails.push(`L12: ${e.message} — the stdin buffer cap never tripped`),
	);
	// The tail of the doomed line must be discarded as garbage, not parsed as a message...
	B.child.stdin.write('{"type":"tool","req":"resync-bait","name":"recall","args":{}}\n');
	// ...and the reader must then RESYNC: this ordinary request has to be answered normally.
	B.send({ type: "tool", req: "after-resync", name: "no-such-tool", args: {} });
	await waitFor(B.find("tool_result", (m) => m.req === "after-resync"), 5000, "a tool_result after the resync").catch((e) =>
		fails.push(`L12: ${e.message} — the reader did not resync after dropping an over-long line`),
	);
	if (B.inbox.some((m) => m.req === "resync-bait"))
		fails.push("L12: the tail of a dropped over-long line was parsed as a message instead of being discarded");
	if (B.state.stdoutViolation !== null) fails.push(`L12: stdout carried a non-JSON line: ${JSON.stringify(B.state.stdoutViolation.slice(0, 200))}`);
	B.send({ type: "shutdown" });
	await waitFor(() => B.state.exitCode !== null, 8000, "bigline exit").catch((e) => fails.push(String(e.message)));
	if (B.state.exitCode !== 0) fails.push(`L12: exited with code ${B.state.exitCode}, expected 0`);
}

// ── report ───────────────────────────────────────────────────────────────────
try {
	fs.rmSync(ROOT, { recursive: true, force: true });
} catch {
	/* best-effort */
}
if (fails.length) {
	console.error(`\nsmoke-sidecar: ${fails.length} failure(s):`);
	for (const f of fails) console.error(`  ✗ ${f}`);
	process.exit(1);
}
console.log("\nsmoke-sidecar: all checks passed");
process.exit(0);
