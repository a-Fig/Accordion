/*
 * smoke.mjs — exercise the Phase B extension without running pi.
 *
 * The extension is now the AUTHORITY: it hosts an in-process Truth per session and pi's `context`
 * hook is a LOCAL operation against it. This drives the extension with a mock `pi`, discovers the
 * session's ephemeral port from the registry file, connects a real WS client, and checks the v12
 * protocol end to end:
 *   • hello → snapshot → the replica-building handshake (empty + with-history snapshots)
 *   • the LOCAL context hook: passthrough (folding off) + folding-enabled wire serialization
 *   • command → commandResult + the echoed `event` stream (config / folding / ops)
 *   • unfold / recall resolved LOCALLY against the Truth (work with zero extra clients)
 *   • telemetry emission (per-hook duration) + /__accordion/meta
 *   • the WS authorization + payload-bound hardening (unchanged from before)
 *   • the discovery contract (registry advertise / focus request / browser serving / shutdown)
 *
 * Run: node smoke.mjs
 */
import { createJiti } from "jiti";
import { WebSocket } from "ws";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Point the registry at a throwaway dir BEFORE loading the extension (it reads ACCORDION_HOME at
// module load) so we never touch the real ~/.accordion.
const HOME = path.join(os.tmpdir(), `accordion-smoke-${process.pid}`);
process.env.ACCORDION_HOME = HOME;
// Prevent the /accordion command smoke assertion from launching a real developer build.
process.env.ACCORDION_APP_PATH = path.join(HOME, "missing-accordion-app.exe");
const SESSIONS_DIR = path.join(HOME, ".accordion", "sessions");
const FOCUS_PATH = path.join(HOME, ".accordion", "focus.json");

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./accordion.ts");
const accordionLive = mod.default;
if (typeof accordionLive !== "function") throw new Error("default export is not a function");
// Compute fold codes exactly as the engine does (to correlate a folded digest to its unfold code).
const { foldCode } = await jiti.import("../core/digest.ts");

const fails = [];

async function waitFor(predicate, ms, label) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 15));
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
let unfoldTool = null;
let recallTool = null;
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
	model: { id: "test/model", contextWindow: 1000 },
	getContextUsage: () => ({ tokens: 42, contextWindow: 1000 }),
};
handlers.session_start({}, ctx);

// the server binds an ephemeral port asynchronously, then advertises itself
await waitFor(() => fs.existsSync(SESSIONS_DIR) && fs.readdirSync(SESSIONS_DIR).some((f) => f.endsWith(".json")), 3000, "registry entry");
const entry = readOnlyEntry();
if (!(entry.port > 0)) fails.push(`registry port not assigned (got ${entry.port})`);
if (entry.registryProtocol !== 1) fails.push(`registry protocol mismatch (${entry.registryProtocol})`);
if (entry.model !== "test/model") fails.push(`model not captured (${entry.model})`);
if (entry.protocolVersion !== 13) fails.push(`protocol version expected 13, got ${entry.protocolVersion}`);
const PORT = entry.port;

// Durable-id messages (a:/u: prefixes) the whole protocol flow builds on.
const T0 = Date.now();
const USER_ID = `u:${T0}`;
const ASST_ID = "a:resp-abc:p0";
const FOLLOWUP_ID = `u:${T0 + 2}`;
const ASST_TEXT = "ORIGINAL ASSISTANT TEXT — long enough that folding it to a short digest actually saves tokens, and recall returns this full original body verbatim.";
const messages = [
	{ role: "user", content: "do the thing", timestamp: T0 },
	{ role: "assistant", content: [{ type: "text", text: ASST_TEXT }], responseId: "resp-abc", timestamp: T0 + 1 },
];
const messagesPlus = [...messages, { role: "user", content: "and another", timestamp: T0 + 2 }];

// passthrough invariant: with NO client attached, the LOCAL context hook must return undefined
// (pi keeps its original messages — folding is off by default). It STILL ingests the messages so
// the view is live: this populates the Truth so the client below attaches to a session WITH history.
{
	const ret = await Promise.resolve(handlers.context({ messages }, ctx));
	if (ret !== undefined) fails.push("context hook altered messages with no client attached / folding off");
}

// /accordion writes a one-shot focus request + surfaces the browser token
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

// Recover the browser token from the /accordion notify line for the token-gated surfaces below.
const browserLine = notifications.map((n) => n.message).reverse().find((m) => m.includes("Browser: http"));
const TOKEN = browserLine && (browserLine.match(/token=([0-9a-f]+)/) || [])[1];
if (!TOKEN) fails.push("/accordion did not surface a Browser URL carrying a token");

// ── browser-served HTTP surface (unchanged from before) ─────────────────────
{
	const httpGet = (urlPath, headers = {}) =>
		new Promise((resolve, reject) => {
			const r = http.get({ host: "127.0.0.1", port: PORT, path: urlPath, headers }, (res) => {
				let buf = "";
				res.on("data", (d) => (buf += d));
				res.on("end", () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
			});
			r.on("error", reject);
		});

	// meta — UNGATED, must answer 200 JSON with served:true even with no token. Phase B: it now
	// carries a `telemetry` object instead of `planOutcomes`.
	const meta = await httpGet("/__accordion/meta");
	if (meta.status !== 200) fails.push(`/__accordion/meta (no token) returned ${meta.status}, expected 200`);
	else {
		let parsed = null;
		try { parsed = JSON.parse(meta.body); } catch { /* fall through */ }
		if (!parsed || parsed.served !== true) fails.push("/__accordion/meta did not return JSON with served:true");
		if (parsed && parsed.sessionId !== entry.sessionId) fails.push("/__accordion/meta sessionId mismatch");
		if (parsed && (!parsed.telemetry || typeof parsed.telemetry.hookCount !== "number"))
			fails.push("/__accordion/meta did not expose a telemetry object with a numeric hookCount");
	}

	// static file request WITHOUT a token → 403.
	const noToken = await httpGet("/");
	if (noToken.status !== 403) fails.push(`GET / without a token returned ${noToken.status}, expected 403`);

	const COOKIE_NAME = `accordion_token_p${PORT}`;
	if (TOKEN) {
		const buildIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "build", "index.html");
		if (fs.existsSync(buildIndex)) {
			const ok = await httpGet(`/?token=${TOKEN}`);
			if (ok.status !== 200) fails.push(`GET /?token=<valid> returned ${ok.status}, expected 200`);
			const setCookie = ok.headers["set-cookie"];
			if (!setCookie || !String(setCookie).includes(`${COOKIE_NAME}=${TOKEN}`))
				fails.push(`GET /?token=<valid> did not mint the ${COOKIE_NAME} cookie (got: ${setCookie})`);
			const wrongPortCookie = await httpGet("/", { Cookie: `accordion_token_p${PORT + 1}=${TOKEN}` });
			if (wrongPortCookie.status !== 403) fails.push(`GET / with a wrong-port cookie returned ${wrongPortCookie.status}, expected 403`);
			const viaCookie = await httpGet("/", { Cookie: `${COOKIE_NAME}=${TOKEN}` });
			if (viaCookie.status !== 200) fails.push(`GET / with cookie auth returned ${viaCookie.status}, expected 200`);
		} else {
			console.log("NOTE: app/build/index.html absent — skipping the index 200 assertion (meta + 403 still verified). Run `npm run build` in app/ to cover it.");
		}
	}

	// ── multi-session discovery: /__accordion/sessions (token-gated) ─────────────
	const sessionsNoToken = await httpGet("/__accordion/sessions");
	if (sessionsNoToken.status !== 403) fails.push(`GET /__accordion/sessions without a token returned ${sessionsNoToken.status}, expected 403`);

	if (TOKEN) {
		const otherEntry = {
			registryProtocol: 1, protocolVersion: entry.protocolVersion, sessionId: "s-other-999", port: 54321,
			pid: 999999, cwd: "/tmp/other-project", title: "other pi session", model: "other/model",
			tokens: null, contextWindow: null, startedAt: Date.now(), heartbeatAt: Date.now(),
		};
		const staleEntry = { ...otherEntry, sessionId: "s-stale-111", heartbeatAt: Date.now() - 60_000 };
		const corruptPath = path.join(SESSIONS_DIR, "s-corrupt-222.json");
		const otherPath = path.join(SESSIONS_DIR, "s-other-999.json");
		const stalePath = path.join(SESSIONS_DIR, "s-stale-111.json");
		try {
			fs.writeFileSync(otherPath, JSON.stringify(otherEntry));
			fs.writeFileSync(stalePath, JSON.stringify(staleEntry));
			fs.writeFileSync(corruptPath, "{ not valid json,,,");
			const withToken = await httpGet(`/__accordion/sessions?token=${TOKEN}`);
			if (withToken.status !== 200) fails.push(`GET /__accordion/sessions with token returned ${withToken.status}, expected 200`);
			else {
				let parsed = null;
				try { parsed = JSON.parse(withToken.body); } catch { /* fall through */ }
				const listed = Array.isArray(parsed?.sessions) ? parsed.sessions : null;
				if (!listed) fails.push("/__accordion/sessions did not return a JSON { sessions: [...] } body");
				else {
					if (!listed.some((s) => s.sessionId === entry.sessionId)) fails.push("/__accordion/sessions did not list this session's own entry");
					if (!listed.some((s) => s.sessionId === "s-other-999")) fails.push("/__accordion/sessions did not list a sibling session's entry");
					if (listed.some((s) => s.sessionId === "s-stale-111")) fails.push("/__accordion/sessions listed a stale-heartbeat sibling");
					if (listed.some((s) => s.sessionId === "s-corrupt-222")) fails.push("/__accordion/sessions somehow parsed the corrupt sibling file");
				}
			}
			await waitFor(() => !fs.existsSync(stalePath), 1000, "stale sibling reaped from disk").catch(
				() => fails.push("/__accordion/sessions did not reap the stale sibling's registry file"),
			);
		} finally {
			for (const p of [otherPath, stalePath, corruptPath]) {
				try { fs.unlinkSync(p); } catch { /* already gone */ }
			}
		}
	}
}

// ── the Phase B protocol: hello / snapshot / event / command / commandResult ─────
// A native (no-Origin) WS client is tokenless-authorized. It collects every server frame by type.
function connectClient() {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
	const inbox = { hello: [], snapshot: [], event: [], telemetry: [], commandResult: [], folding: [], recall: [], stream: [] };
	ws.on("message", (d) => {
		let m;
		try { m = JSON.parse(d.toString()); } catch { return; }
		(inbox[m.type] ||= []).push(m);
	});
	let seq = 0;
	const sendCmd = (cmd) => ws.send(JSON.stringify({ type: "command", seq: ++seq, cmd }));
	return { ws, inbox, sendCmd };
}

// Client A connects to the session that now has history → hello + snapshot(with the 2 blocks).
const a = connectClient();
await waitFor(() => a.inbox.hello.length > 0, 2000, "client A hello").catch(() => fails.push("client A never received hello"));
await waitFor(() => a.inbox.snapshot.length > 0, 2000, "client A snapshot").catch(() => fails.push("client A never received a snapshot"));
{
	const hello = a.inbox.hello[0];
	if (hello && hello.protocolVersion !== 13) fails.push(`hello.protocolVersion expected 13, got ${hello?.protocolVersion}`);
	if (hello && hello.role !== "gui") fails.push(`hello.role expected "gui", got ${hello?.role}`);
	const snap = a.inbox.snapshot[0];
	const ids = snap ? snap.state.blocks.map((x) => x.id) : [];
	if (!ids.includes(USER_ID) || !ids.includes(ASST_ID)) fails.push(`snapshot missing block ids (got ${JSON.stringify(ids)})`);
	if (snap && snap.state?.foldingEnabled !== false) fails.push("snapshot.foldingEnabled should default to false");
	if (snap && snap.state?.wireAttached !== true) fails.push("snapshot.wireAttached should be true for a live pi session");
}

// Fire the LOCAL context hook with an APPENDED follow-up → passthrough (undefined) + the new block
// streams to A as an `appended` event (O(Δ) suffix, no rebuild), plus a `sent` event and telemetry.
{
	a.inbox.event.length = 0;
	a.inbox.telemetry.length = 0;
	const ret = await Promise.resolve(handlers.context({ messages: messagesPlus }, ctx));
	if (ret !== undefined) fails.push("context hook (folding off) altered the model messages");
	await waitFor(() => a.inbox.event.some((e) => e.event?.kind === "appended"), 2000, "appended event").catch(
		() => fails.push("client A never received an appended event from the context hook"),
	);
	const appended = a.inbox.event.find((e) => e.event?.kind === "appended");
	const ids = appended ? appended.event.blocks.map((x) => x.id) : [];
	if (!ids.includes(FOLLOWUP_ID)) fails.push(`appended event missing the follow-up block id (got ${JSON.stringify(ids)})`);
	if (ids.includes(USER_ID)) fails.push("appended event re-sent an already-present block (suffix append is not O(Δ))");
	if (!a.inbox.event.some((e) => e.event?.kind === "sent")) fails.push("context hook did not emit a `sent` event");
	if (!a.inbox.telemetry.length) fails.push("context hook did not stream telemetry");
	const tel = a.inbox.telemetry.at(-1);
	if (tel && (typeof tel.lastHookMs !== "number" || tel.hookCount < 1)) fails.push(`telemetry frame malformed (${JSON.stringify(tel)})`);
}

// Client B connects AFTER more history → its snapshot carries all 3 blocks (hydration path).
const b = connectClient();
await waitFor(() => b.inbox.snapshot.length > 0, 2000, "client B snapshot").catch(() => fails.push("client B never received a snapshot"));
{
	const snap = b.inbox.snapshot[0];
	const ids = snap ? snap.state.blocks.map((x) => x.id) : [];
	if (!ids.includes(USER_ID) || !ids.includes(ASST_ID) || !ids.includes(FOLLOWUP_ID))
		fails.push(`with-history snapshot missing block ids (got ${JSON.stringify(ids)})`);
}

// Commands: setProtect 0 (so the block is foldable), setFolding true, then fold the assistant text.
// Each yields a commandResult to the sender AND a broadcast `event` (config / folding / ops) to ALL.
{
	a.inbox.commandResult.length = 0;
	a.inbox.event.length = 0;
	a.inbox.folding.length = 0;
	b.inbox.event.length = 0;
	b.inbox.folding.length = 0;

	a.sendCmd({ kind: "setProtect", value: 0 });
	a.sendCmd({ kind: "setFolding", value: true });
	a.sendCmd({ kind: "ops", ops: [{ kind: "fold", ids: [ASST_ID] }] });

	await waitFor(() => a.inbox.commandResult.length >= 3, 2000, "3 commandResults").catch(
		() => fails.push(`expected >=3 commandResults, got ${a.inbox.commandResult.length}`),
	);
	// The folding toggle echoes a `folding` message to BOTH clients.
	await waitFor(() => a.inbox.folding.some((f) => f.enabled === true) && b.inbox.folding.some((f) => f.enabled === true), 2000, "folding echo").catch(
		() => fails.push("setFolding did not broadcast a `folding` message to all clients"),
	);
	// The fold applied → an `ops` event with the fold op reaches both replicas.
	await waitFor(() => a.inbox.event.some((e) => e.event?.kind === "ops") && b.inbox.event.some((e) => e.event?.kind === "ops"), 2000, "ops event").catch(
		() => fails.push("fold command did not broadcast an `ops` event to all clients"),
	);
	const opsEvent = a.inbox.event.find((e) => e.event?.kind === "ops");
	if (opsEvent && (opsEvent.event.by !== "you" || opsEvent.event.ops?.[0]?.kind !== "fold"))
		fails.push(`ops event malformed (${JSON.stringify(opsEvent.event)})`);
	// commandResults carry the resulting rev.
	if (a.inbox.commandResult.some((r) => typeof r.rev !== "number")) fails.push("a commandResult lacked a numeric rev");
}

// Fire the context hook WITH folding on → the wire is serialized: the assistant text is replaced by
// its `{#code FOLDED}` digest. Extract the code for the unfold/recall checks.
let foldCodeStr = null;
{
	const ret = await Promise.resolve(handlers.context({ messages: messagesPlus }, ctx));
	if (!ret || !Array.isArray(ret.messages)) fails.push("context hook (folding on) did not return replacement messages");
	else {
		const folded = ret.messages[1]?.content?.[0]?.text;
		if (typeof folded !== "string" || !folded.startsWith("{#") || !folded.includes("FOLDED"))
			fails.push(`assistant text was not folded to a FOLDED digest (got ${JSON.stringify(folded)})`);
		else foldCodeStr = (folded.match(/\{#([0-9a-z]{6}) FOLDED\}/) || [])[1] || null;
		// The user message (not folded, no op) must pass through unchanged.
		if (ret.messages[0]?.content !== "do the thing") fails.push("untargeted user message was altered by the wire serialization");
	}
	// Sanity: the code we extracted matches foldCode(ASST_ID).
	if (foldCodeStr && foldCode(ASST_ID) !== foldCodeStr)
		fails.push(`folded digest code ${foldCodeStr} != foldCode(${ASST_ID})=${foldCode(ASST_ID)}`);
}

// recall — LOCAL, read-only: returns the ORIGINAL full text while the block stays folded, and
// broadcasts a `recall` observation.
if (recallTool && foldCodeStr) {
	a.inbox.recall.length = 0;
	const res = await recallTool.execute("call-recall", { codes: [foldCodeStr] }, null, () => {}, ctx);
	const text = res?.content?.map((c) => c.text).join("\n") || "";
	if (!text.includes(ASST_TEXT)) fails.push("recall did not return the block's original full text");
	await waitFor(() => a.inbox.recall.length > 0, 1000, "recall observation").catch(
		() => fails.push("recall did not broadcast a `recall` observation"),
	);
} else if (!recallTool) {
	fails.push("recall tool was not registered");
}

// unfold — LOCAL: holds the block open. A subsequent context hook must NOT fold it.
if (unfoldTool && foldCodeStr) {
	const res = await unfoldTool.execute("call-unfold", { codes: [foldCodeStr] }, null, () => {}, ctx);
	const text = res?.content?.map((c) => c.text).join("\n") || "";
	if (!/Unfolded\s+1\s+block/i.test(text)) fails.push(`unfold did not confirm a restore (got ${JSON.stringify(text)})`);
	const ret = await Promise.resolve(handlers.context({ messages: messagesPlus }, ctx));
	const afterText = ret?.messages?.[1]?.content?.[0]?.text;
	if (afterText !== ASST_TEXT) fails.push(`after unfold the assistant text should be whole again (got ${JSON.stringify(afterText)})`);
} else if (!unfoldTool) {
	fails.push("unfold tool was not registered");
}

// telemetry accumulated across the several context hooks above.
{
	const meta = await new Promise((resolve, reject) => {
		http.get({ host: "127.0.0.1", port: PORT, path: "/__accordion/meta" }, (res) => {
			let buf = ""; res.on("data", (d) => (buf += d)); res.on("end", () => resolve(JSON.parse(buf)));
		}).on("error", reject);
	});
	if (!meta.telemetry || meta.telemetry.hookCount < 3) fails.push(`/__accordion/meta telemetry.hookCount expected >=3, got ${meta.telemetry?.hookCount}`);
	if (meta.telemetry && meta.telemetry.lastHookMs > 100) fails.push(`local context hook took ${meta.telemetry.lastHookMs}ms — expected the local path to be fast (<100ms)`);
	console.log(`  hook timing: last=${meta.telemetry.lastHookMs}ms max=${meta.telemetry.maxHookMs}ms p95=${meta.telemetry.p95HookMs}ms hooks=${meta.telemetry.hookCount} rebuilds=${meta.telemetry.rebuilds}`);
}

a.ws.close();
b.ws.close();
await new Promise((r) => setTimeout(r, 50));

// ── WebSocket authorization and payload bounds (unchanged) ──────────────────────
{
	const rawUpgrade = (requestTarget, { host = `127.0.0.1:${PORT}`, origin = null, cookie = null } = {}) =>
		new Promise((resolve) => {
			const socket = net.connect(PORT, "127.0.0.1");
			let firstLine = "";
			let settled = false;
			const finish = (value = firstLine || "(no response)") => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try { socket.destroy(); } catch { /* ignore */ }
				resolve(value);
			};
			const timer = setTimeout(() => finish(), 1500);
			socket.on("connect", () => socket.write(
				`GET ${requestTarget} HTTP/1.1\r\nHost: ${host}\r\n` +
				(origin ? `Origin: ${origin}\r\n` : "") +
				(cookie ? `Cookie: ${cookie}\r\n` : "") +
				"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
				"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
			));
			socket.on("data", (data) => {
				firstLine = (firstLine + data.toString()).split("\r\n")[0];
				if (firstLine) finish(firstLine);
			});
			socket.on("error", (error) => finish(`socket error: ${error.message}`));
		});

	const dialWs = (options = {}, suffix = "") =>
		new Promise((resolve) => {
			const candidate = new WebSocket(`ws://127.0.0.1:${PORT}${suffix}`, options);
			let settled = false;
			const finish = (result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try { candidate.close(); } catch { /* ignore */ }
				resolve(result);
			};
			const timer = setTimeout(() => finish({ open: false, timeout: true }), 1500);
			candidate.on("open", () => finish({ open: true }));
			candidate.on("unexpected-response", (_request, response) => finish({ open: false, status: response.statusCode }));
			candidate.on("error", (error) => finish({ open: false, error: error.message }));
		});

	const malformed = await rawUpgrade("http://x:999999/");
	if (!/\b400\b/.test(malformed)) fails.push(`ws-hardening: malformed target was not rejected 400 (${malformed})`);

	const hostile = await dialWs({ origin: "http://evil.example" });
	if (hostile.open || hostile.status !== 403) fails.push(`ws-hardening: hostile browser Origin was not rejected (${JSON.stringify(hostile)})`);
	const opaque = await dialWs({ origin: "null" });
	if (opaque.open || opaque.status !== 403) fails.push(`ws-hardening: opaque browser Origin was not rejected (${JSON.stringify(opaque)})`);
	const native = await dialWs();
	if (!native.open) fails.push(`ws-hardening: no-Origin native client was rejected (${JSON.stringify(native)})`);
	for (const origin of ["tauri://localhost", "https://tauri.localhost", "http://tauri.localhost"]) {
		const tauri = await dialWs({ origin });
		if (!tauri.open) fails.push(`ws-hardening: trusted Tauri Origin ${origin} was rejected (${JSON.stringify(tauri)})`);
	}
	const tauriDevDefault = await dialWs({ origin: "http://localhost:1420" });
	if (tauriDevDefault.open || tauriDevDefault.status !== 403)
		fails.push(`ws-hardening: Tauri dev Origin was trusted without explicit opt-in (${JSON.stringify(tauriDevDefault)})`);

	if (TOKEN) {
		const rebound = await rawUpgrade("/", { host: `evil.example:${PORT}`, origin: `http://evil.example:${PORT}` });
		if (!/\b403\b/.test(rebound)) fails.push(`ws-hardening: DNS-rebound Origin/Host was not rejected (${rebound})`);

		const endless = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"served":true'); });
		await new Promise((resolve, reject) => { endless.once("error", reject); endless.listen(0, "127.0.0.1", resolve); });
		const endlessPort = endless.address().port;
		const endlessProbe = await rawUpgrade("/", { origin: `http://127.0.0.1:${endlessPort}` });
		if (!/\b403\b/.test(endlessProbe)) fails.push(`ws-hardening: non-ending sibling probe was not bounded (${endlessProbe})`);
		await new Promise((resolve) => endless.close(resolve));

		const unrelated = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ served: true, sessionId: "forged-local-service", protocolVersion: entry.protocolVersion })); });
		await new Promise((resolve, reject) => { unrelated.once("error", reject); unrelated.listen(0, "127.0.0.1", resolve); });
		const unrelatedPort = unrelated.address().port;
		const crossPortCookie = await rawUpgrade("/", { origin: `http://127.0.0.1:${unrelatedPort}`, cookie: `accordion_token_p${PORT}=${TOKEN}` });
		await new Promise((resolve) => unrelated.close(resolve));
		if (!/\b403\b/.test(crossPortCookie)) fails.push(`ws-hardening: cross-port ambient cookie was accepted (${crossPortCookie})`);

		const servedCookie = await rawUpgrade("/", { origin: `http://127.0.0.1:${PORT}`, cookie: `accordion_token_p${PORT}=${TOKEN}` });
		if (!/\b101\b/.test(servedCookie)) fails.push(`ws-hardening: exact served Origin cookie was rejected (${servedCookie})`);
		const explicit = await dialWs({ origin: "http://evil.example" }, `/?token=${TOKEN}`);
		if (!explicit.open) fails.push(`ws-hardening: explicit bearer was rejected (${JSON.stringify(explicit)})`);

		const siblingId = "s-origin-smoke";
		const sibling = http.createServer((req, res) => {
			if (req.url === "/__accordion/meta") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ served: true, sessionId: siblingId, protocolVersion: entry.protocolVersion })); return; }
			res.writeHead(404); res.end();
		});
		await new Promise((resolve, reject) => { sibling.once("error", reject); sibling.listen(0, "127.0.0.1", resolve); });
		const siblingPort = sibling.address().port;
		const siblingPath = path.join(SESSIONS_DIR, `${siblingId}.json`);
		fs.writeFileSync(siblingPath, JSON.stringify({ ...entry, sessionId: siblingId, port: siblingPort, startedAt: Date.now(), heartbeatAt: Date.now() }));
		const liveSibling = await rawUpgrade("/", { origin: `http://127.0.0.1:${siblingPort}` });
		if (!/\b101\b/.test(liveSibling)) fails.push(`ws-hardening: live sibling Origin was rejected (${liveSibling})`);
		await new Promise((resolve) => sibling.close(resolve));
		try { fs.unlinkSync(siblingPath); } catch { /* cleanup */ }
		const staleSibling = await rawUpgrade("/", { origin: `http://127.0.0.1:${siblingPort}` });
		if (!/\b403\b/.test(staleSibling)) fails.push(`ws-hardening: stale sibling Origin retained authority (${staleSibling})`);

		const largeSiblingId = "s-origin-large";
		const largeSibling = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ served: true, sessionId: largeSiblingId, protocolVersion: entry.protocolVersion, padding: "x".repeat(17 * 1024) })); });
		await new Promise((resolve, reject) => { largeSibling.once("error", reject); largeSibling.listen(0, "127.0.0.1", resolve); });
		const largePort = largeSibling.address().port;
		const largePath = path.join(SESSIONS_DIR, `${largeSiblingId}.json`);
		fs.writeFileSync(largePath, JSON.stringify({ ...entry, sessionId: largeSiblingId, port: largePort, startedAt: Date.now(), heartbeatAt: Date.now() }));
		const largeProbe = await rawUpgrade("/", { origin: `http://127.0.0.1:${largePort}` });
		if (!/\b403\b/.test(largeProbe)) fails.push(`ws-hardening: oversized sibling metadata was accepted (${largeProbe})`);
		await new Promise((resolve) => largeSibling.close(resolve));
		try { fs.unlinkSync(largePath); } catch { /* cleanup */ }
	}

	const oversized = await new Promise((resolve) => {
		const candidate = new WebSocket(`ws://127.0.0.1:${PORT}`);
		const timer = setTimeout(() => resolve({ code: null, timeout: true }), 4000);
		candidate.on("open", () => candidate.send(Buffer.alloc(9 * 1024 * 1024, 0x61)));
		candidate.on("close", (code) => { clearTimeout(timer); resolve({ code }); });
		candidate.on("error", () => {});
	});
	if (oversized.code !== 1009) fails.push(`ws-hardening: oversized frame did not close with 1009 (${JSON.stringify(oversized)})`);
}

// shutdown must stop advertising (delete the registry entry)
handlers.session_shutdown({}, ctx);
await waitFor(() => !fs.existsSync(SESSIONS_DIR) || fs.readdirSync(SESSIONS_DIR).length === 0, 1000, "registry cleanup").catch(
	() => fails.push("session_shutdown did not delete the registry entry"),
);

// tidy the throwaway home
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }

if (fails.length) {
	console.error(`\nSMOKE FAILED (${fails.length}):`);
	for (const f of fails) console.error(`  ✗ ${f}`);
	process.exit(1);
}
console.log("\nsmoke: OK — Phase B protocol (hello/snapshot/event/command), local context hook, unfold/recall, telemetry, WS auth, discovery all passed.");
