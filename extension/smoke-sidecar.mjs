/*
 * smoke-sidecar.mjs — end-to-end exercise of the stdio sidecar (docs/sidecar-protocol.md v1).
 *
 * Spawns the BUILT bundle (`extension/sidecar.mjs`) as a real child process with an isolated HOME,
 * speaks JSON-lines at it exactly like the mistral-vibe fork will, and checks the contract:
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
 *   • tool{name:"recall"} → the ORIGINAL folded text
 *   • command{name:"accordion"} → notify lines then command_result
 *   • shutdown → exit 0
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

const HOME = path.join(os.tmpdir(), `accordion-sidecar-smoke-${process.pid}`);
const SESSION_CWD = path.join(HOME, "session-cwd");
fs.mkdirSync(SESSION_CWD, { recursive: true });
const SESSIONS_DIR = path.join(HOME, ".accordion", "sessions");

const fails = [];
const DEBUG = process.env.SMOKE_SIDECAR_DEBUG === "1";

// ── spawn ────────────────────────────────────────────────────────────────────
const child = spawn(process.execPath, [BUNDLE], {
	cwd: SESSION_CWD,
	stdio: ["pipe", "pipe", "pipe"],
	env: {
		...process.env,
		HOME,
		USERPROFILE: HOME,
		ACCORDION_HOME: HOME,
		// Never bind the real fixed door port from a test, and never launch a real desktop build.
		ACCORDION_DOOR_PORT: "0",
		ACCORDION_APP_PATH: path.join(HOME, "missing-accordion-app.exe"),
	},
});

const inbox = [];
let stdoutBuf = "";
let stdoutViolation = null;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	stdoutBuf += chunk;
	let nl;
	while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
		const raw = stdoutBuf.slice(0, nl).replace(/\r$/, "");
		stdoutBuf = stdoutBuf.slice(nl + 1);
		if (!raw.trim()) continue;
		try {
			inbox.push(JSON.parse(raw));
		} catch {
			// The protocol's hardest rule: stdout carries JSON-lines and NOTHING else.
			stdoutViolation ??= raw;
		}
	}
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => {
	if (DEBUG) process.stderr.write(`[sidecar stderr] ${d}`);
});
let exitCode = null;
child.on("exit", (code) => (exitCode = code));

function send(msg) {
	child.stdin.write(JSON.stringify(msg) + "\n");
}
async function waitFor(predicate, ms, label) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		const v = predicate();
		if (v) return v;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error(`timed out waiting for ${label}`);
}
const find = (type, pred = () => true) => () => inbox.find((m) => m.type === type && pred(m));

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
send({
	type: "hello",
	v: 1,
	harness: "vibe",
	harnessVersion: "0.0.0-smoke",
	sessionId: "vibe-smoke-session",
	cwd: SESSION_CWD,
	model: { id: "mistral/devstral-smoke", provider: "mistral", contextWindow: 128000 },
	flags: {},
});
const ready = await waitFor(find("ready"), 5000, "ready").catch((e) => {
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
await waitFor(find("folding", (m) => m.enabled === false), 3000, "the initial folding{enabled:false}").catch((e) => fails.push(String(e.message)));

// ── session_start → the registry entry ───────────────────────────────────────
send({ type: "session_start", reason: "start", messages: MESSAGES });
const entry = await waitFor(
	() => {
		if (!fs.existsSync(SESSIONS_DIR)) return null;
		const f = fs.readdirSync(SESSIONS_DIR).filter((x) => x.endsWith(".json"));
		if (f.length !== 1) return null;
		try {
			const e = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f[0]), "utf8"));
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
	if (path.resolve(entry.cwd) !== path.resolve(SESSION_CWD)) fails.push(`registry cwd expected ${SESSION_CWD}, got ${entry.cwd}`);
	if (typeof entry.title !== "string" || !entry.title) fails.push(`registry title missing (got ${JSON.stringify(entry.title)})`);
}
const PORT = entry?.port;

// ── context, folding OFF → passthrough ───────────────────────────────────────
send({ type: "context", req: "ctx-1", messages: MESSAGES, model: { id: "mistral/devstral-smoke", contextWindow: 128000 } });
{
	const r = await waitFor(find("hook_result", (m) => m.req === "ctx-1"), 5000, "hook_result for ctx-1").catch((e) => {
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
await waitFor(() => inbox.some((m) => m.type === "folding" && m.enabled === true), 3000, "folding{enabled:true} on stdout").catch((e) =>
	fails.push(`${e.message} — the onFoldingChanged seam did not reach the harness`),
);

// ── context, folding ON → back-converted vibe LLMMessages ────────────────────
let toolFoldCode = null;
send({ type: "context", req: "ctx-2", messages: MESSAGES, model: { id: "mistral/devstral-smoke", contextWindow: 128000 } });
{
	const r = await waitFor(find("hook_result", (m) => m.req === "ctx-2"), 5000, "hook_result for ctx-2").catch((e) => {
		fails.push(String(e.message));
		return null;
	});
	const out = r?.messages;
	if (!Array.isArray(out)) {
		fails.push(`folding ON should reply a messages array, got ${JSON.stringify(r?.messages)?.slice(0, 200)}`);
	} else {
		if (out.length !== MESSAGES.length) fails.push(`expected ${MESSAGES.length} messages back, got ${out.length}`);
		// (1) the system message rides at index 0, byte-identical.
		if (JSON.stringify(out[0]) !== JSON.stringify(SYSTEM)) fails.push(`system message not re-inserted byte-identical (got ${JSON.stringify(out[0])})`);
		// (2) the user message is untouched.
		if (JSON.stringify(out[1]) !== JSON.stringify(USER)) fails.push(`untargeted user message was altered (got ${JSON.stringify(out[1])})`);
		// (3) the assistant tool-call message: reasoning_content folded to a digest, EVERYTHING else
		//     preserved — content, tool_calls, reasoning_payloads, message_id.
		const a = out[2] || {};
		if (typeof a.reasoning_content !== "string" || !/^\{#[0-9a-z]{6} FOLDED\}/.test(a.reasoning_content))
			fails.push(`assistant reasoning_content was not folded to a digest (got ${JSON.stringify(a.reasoning_content)?.slice(0, 160)})`);
		if (a.content !== ASST_CALL.content) fails.push(`assistant content changed when only its thinking was folded (got ${JSON.stringify(a.content)})`);
		if (JSON.stringify(a.tool_calls) !== JSON.stringify(ASST_CALL.tool_calls)) fails.push(`assistant tool_calls not preserved (got ${JSON.stringify(a.tool_calls)})`);
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
		if (JSON.stringify(out[4]) !== JSON.stringify(ASST_TEXT)) fails.push(`unfolded trailing assistant message was altered (got ${JSON.stringify(out[4])})`);
		// (6) every message_id survived, in order.
		const gotIds = out.map((m) => m.message_id);
		const wantIds = MESSAGES.map((m) => m.message_id);
		if (JSON.stringify(gotIds) !== JSON.stringify(wantIds)) fails.push(`message_ids not preserved in order: ${JSON.stringify(gotIds)} != ${JSON.stringify(wantIds)}`);
	}
}

// ── the recall tool over the protocol ────────────────────────────────────────
if (toolFoldCode) {
	send({ type: "tool", req: "tool-1", name: "recall", args: { codes: [toolFoldCode] } });
	const r = await waitFor(find("tool_result", (m) => m.req === "tool-1"), 5000, "tool_result for recall").catch((e) => {
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
send({ type: "tool", req: "tool-2", name: "no-such-tool", args: {} });
{
	const r = await waitFor(find("tool_result", (m) => m.req === "tool-2"), 3000, "tool_result for an unknown tool").catch((e) => {
		fails.push(String(e.message));
		return null;
	});
	if (r && r.isError !== true) fails.push("an unknown tool should answer isError:true");
}

// ── the /accordion command: notify lines, then command_result ────────────────
send({ type: "command", req: "cmd-1", name: "accordion", args: "" });
{
	const r = await waitFor(find("command_result", (m) => m.req === "cmd-1"), 8000, "command_result for accordion").catch((e) => {
		fails.push(String(e.message));
		return null;
	});
	if (r && r.ok !== true) fails.push(`the accordion command failed: ${JSON.stringify(r)}`);
	const notifyIdx = inbox.findIndex((m) => m.type === "notify");
	const resultIdx = inbox.findIndex((m) => m.type === "command_result" && m.req === "cmd-1");
	if (notifyIdx < 0) fails.push("the accordion command emitted no `notify`");
	else if (resultIdx >= 0 && notifyIdx > resultIdx) fails.push("`notify` must arrive before `command_result`");
}
// An unknown command must answer too.
send({ type: "command", req: "cmd-2", name: "nope", args: "" });
{
	const r = await waitFor(find("command_result", (m) => m.req === "cmd-2"), 3000, "command_result for an unknown command").catch((e) => {
		fails.push(String(e.message));
		return null;
	});
	if (r && r.ok !== false) fails.push("an unknown command should answer ok:false");
}

// An unknown message type is ignored, never fatal.
send({ type: "definitely-not-a-real-type", req: "x" });
send({ type: "usage", promptTokens: 1234, completionTokens: 56, contextWindow: 128000 });

// ── shutdown → exit 0 ────────────────────────────────────────────────────────
try {
	ws?.close();
} catch {
	/* ignore */
}
send({ type: "shutdown" });
await waitFor(() => exitCode !== null, 8000, "sidecar exit").catch((e) => fails.push(String(e.message)));
if (exitCode !== 0) fails.push(`sidecar exited with code ${exitCode}, expected 0`);
if (fs.existsSync(SESSIONS_DIR) && fs.readdirSync(SESSIONS_DIR).some((f) => f.endsWith(".json")))
	fails.push("the registry entry was not removed on shutdown");

if (stdoutViolation !== null) fails.push(`stdout carried a non-JSON line: ${JSON.stringify(stdoutViolation.slice(0, 200))}`);

// ── report ───────────────────────────────────────────────────────────────────
try {
	child.kill();
} catch {
	/* already gone */
}
try {
	fs.rmSync(HOME, { recursive: true, force: true });
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
