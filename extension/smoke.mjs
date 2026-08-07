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
// v16 (ADR 0024): DISABLE the door for the MAIN extension so the existing HTTP/token/cookie/URL
// assertions stay byte-identical (the /accordion line then prints the ephemeral webToken URL, not the
// door URL). The door itself is exercised by a dedicated, self-contained section at the end that flips
// this env to a free port and races two fresh extension instances. `0` = door disabled.
process.env.ACCORDION_DOOR_PORT = "0";
// C1 regression seams (test-only): a FAST controller heartbeat and a SLOW poll. This makes the C1
// clobber test deterministic — after a foreign extension writes controller.json directly, a heartbeat
// is guaranteed to fire (before the slow poll could "rescue" a regressed heartbeat) so a heartbeat
// that re-asserted its stale cached holder would visibly clobber the foreign claim. Production never
// sets these (defaults: 2s heartbeat / 1s poll).
process.env.ACCORDION_CONTROLLER_HEARTBEAT_MS = "60";
process.env.ACCORDION_CONTROLLER_POLL_MS = "5000";
const SESSIONS_DIR = path.join(HOME, ".accordion", "sessions");
const FOCUS_PATH = path.join(HOME, ".accordion", "focus.json");
const CONTROLLER_PATH = path.join(HOME, ".accordion", "controller.json");

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./accordion.ts");
const accordionLive = mod.default;
if (typeof accordionLive !== "function") throw new Error("default export is not a function");
// Compute fold codes exactly as the engine does (to correlate a folded digest to its unfold code).
const { foldCode } = await jiti.import("../core/digest.ts");
// The LIVE protocol version, not a hardcoded literal — so a version bump doesn't silently desync
// this smoke test from `core/protocol.ts` (the same rationale as smoke-mock.mjs's import).
const { PROTOCOL_VERSION } = await jiti.import("../core/protocol.ts");

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
if (entry.protocolVersion !== PROTOCOL_VERSION) fails.push(`protocol version expected ${PROTOCOL_VERSION}, got ${entry.protocolVersion}`);
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
// v16 (ADR 0024): each client dials with a distinct surface identity (?surface&?label) so the
// single-controller lease has someone to attribute steering to; `claim()` sends `claimController`.
const SURFACE_A = "surface-aaaa-1111";
const SURFACE_B = "surface-bbbb-2222";
function connectClient(surfaceId = SURFACE_A, label = "Test surface") {
	const qs = `/?surface=${encodeURIComponent(surfaceId)}&label=${encodeURIComponent(label)}`;
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}${qs}`);
	const inbox = { hello: [], snapshot: [], event: [], telemetry: [], commandResult: [], folding: [], recall: [], stream: [], controller: [] };
	ws.on("message", (d) => {
		let m;
		try { m = JSON.parse(d.toString()); } catch { return; }
		(inbox[m.type] ||= []).push(m);
	});
	let seq = 0;
	const sendCmd = (cmd) => ws.send(JSON.stringify({ type: "command", seq: ++seq, cmd }));
	const claim = () => ws.send(JSON.stringify({ type: "claimController" }));
	return { ws, inbox, sendCmd, claim, surfaceId };
}

// Client A connects to the session that now has history → hello + snapshot(with the 2 blocks).
const a = connectClient(SURFACE_A, "Desktop app");
await waitFor(() => a.inbox.hello.length > 0, 2000, "client A hello").catch(() => fails.push("client A never received hello"));
await waitFor(() => a.inbox.snapshot.length > 0, 2000, "client A snapshot").catch(() => fails.push("client A never received a snapshot"));
// v16: A's hello arrives BEFORE anyone has claimed → controller is null. Then A claims control so
// that every steering command in the sections below (all issued by A) passes the READ-ONLY gate.
{
	const helloA = a.inbox.hello[0];
	if (helloA && helloA.controller != null) fails.push(`client A hello.controller should be null before any claim (got ${JSON.stringify(helloA.controller)})`);
}
a.claim();
await waitFor(() => a.inbox.controller.some((c) => c.surfaceId === SURFACE_A), 2000, "client A becomes controller").catch(
	() => fails.push("client A's claimController did not broadcast a controller frame naming its surface"),
);
{
	const hello = a.inbox.hello[0];
	if (hello && hello.protocolVersion !== PROTOCOL_VERSION) fails.push(`hello.protocolVersion expected ${PROTOCOL_VERSION}, got ${hello?.protocolVersion}`);
	if (hello && hello.role !== "gui") fails.push(`hello.role expected "gui", got ${hello?.role}`);
	// Phase C: hello advertises the available-conductor catalog (the GUI picker renders from this).
	if (hello && (!Array.isArray(hello.conductors) || !hello.conductors.some((c) => c.id === "doorman")))
		fails.push(`hello did not advertise the conductor catalog (got ${JSON.stringify(hello?.conductors)})`);
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
	// Phase C DEFAULT PATH: with no conductor attached, NO wire-departing hold is ever paid — the
	// telemetry's hold fields stay pinned at 0 and the hook stays sync-fast (identical to pre-Phase-C).
	if (tel && (tel.lastHoldMs !== 0 || tel.holdTimeouts !== 0))
		fails.push(`default path paid a hold with no conductor (lastHoldMs=${tel.lastHoldMs}, holdTimeouts=${tel.holdTimeouts})`);
}

// ── E1 (external review round): a same-id CONTENT rewrite must be visible to reconciliation ──
// Rewrite the already-ingested assistant message's TEXT while keeping every durable id identical
// (same responseId/timestamp) — simulates pi or a peer extension editing a message's content in
// place. Durable-id identity ALONE (the pre-fix behavior) would call this "no change" and
// `Truth.append`'s id-based idempotency would keep serving the STALE original text forever — the
// GUI, `recall`, and a folded block's wire digest would all silently drift from what the model
// actually now sees. Assert (1) the rewrite is detected as a structural divergence (telemetry's
// `rebuilds` increments, a fresh `snapshot` broadcasts) and (2) the block Truth now serves for that
// id is the NEW text, not the stale original.
{
	const fetchMeta = () =>
		new Promise((resolve, reject) => {
			http.get({ host: "127.0.0.1", port: PORT, path: "/__accordion/meta" }, (res) => {
				let buf = "";
				res.on("data", (d) => (buf += d));
				res.on("end", () => {
					try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
				});
			}).on("error", reject);
		});

	const REWRITTEN_TEXT = "REWRITTEN ASSISTANT TEXT — same durable id, different content (in-place rewrite).";
	const rewritten = [
		messagesPlus[0],
		{ ...messagesPlus[1], content: [{ type: "text", text: REWRITTEN_TEXT }] },
		messagesPlus[2],
	];

	const before = await fetchMeta();
	a.inbox.snapshot.length = 0;
	await Promise.resolve(handlers.context({ messages: rewritten }, ctx));
	await waitFor(() => a.inbox.snapshot.length > 0, 2000, "rebuild snapshot after same-id content rewrite").catch(
		() => fails.push("a same-id content rewrite did not trigger a rebuild snapshot"),
	);
	const after = await fetchMeta();
	if (!(after.telemetry.rebuilds > before.telemetry.rebuilds))
		fails.push(`same-id content rewrite did not increment telemetry.rebuilds (before=${before.telemetry.rebuilds}, after=${after.telemetry.rebuilds})`);

	const snap = a.inbox.snapshot.at(-1);
	const rewrittenBlock = snap?.state?.blocks?.find((b) => b.id === ASST_ID);
	if (!rewrittenBlock || rewrittenBlock.text !== REWRITTEN_TEXT)
		fails.push(`Truth did not adopt the rewritten content for ${ASST_ID} (got ${JSON.stringify(rewrittenBlock?.text)})`);

	// Restore the pristine content (itself another same-id rewrite, exercising the path a second time
	// in reverse) so everything below that depends on ASST_TEXT (recall / unfold / the fold-digest
	// checks) sees the ORIGINAL text again, as if the rewrite above never happened.
	await Promise.resolve(handlers.context({ messages: messagesPlus }, ctx));

	// sol P1 gap #1: a SAME-LENGTH in-place rewrite (fixed-width redaction) must ALSO be caught — the
	// OLD length-sum fingerprint was blind to it. With ASST_TEXT restored just above, swap it for an
	// EQUAL-LENGTH mask (identical char count, different bytes) and assert the reconcile still rebuilds.
	{
		const MASK = "*".repeat(ASST_TEXT.length); // same length as ASST_TEXT, different content
		const masked = [messagesPlus[0], { ...messagesPlus[1], content: [{ type: "text", text: MASK }] }, messagesPlus[2]];
		const beforeMask = await fetchMeta();
		a.inbox.snapshot.length = 0;
		await Promise.resolve(handlers.context({ messages: masked }, ctx));
		await waitFor(() => a.inbox.snapshot.length > 0, 2000, "rebuild after same-length rewrite").catch(
			() => fails.push("a SAME-LENGTH content rewrite did not trigger a rebuild (length-sum blind spot)"),
		);
		const afterMask = await fetchMeta();
		if (!(afterMask.telemetry.rebuilds > beforeMask.telemetry.rebuilds))
			fails.push(`same-length rewrite did not increment telemetry.rebuilds (before=${beforeMask.telemetry.rebuilds}, after=${afterMask.telemetry.rebuilds})`);
		const maskedBlock = a.inbox.snapshot.at(-1)?.state?.blocks?.find((b) => b.id === ASST_ID);
		if (!maskedBlock || maskedBlock.text !== MASK)
			fails.push(`Truth did not adopt the same-length masked content (got ${JSON.stringify(maskedBlock?.text)})`);
		// Restore ASST_TEXT once more so the fold/recall/unfold sections below resume from the original.
		await Promise.resolve(handlers.context({ messages: messagesPlus }, ctx));
	}
}

// ── E1 (cont.): tool-call ARGUMENT + tool_result isError rewrites (sol P1 gaps #2, #3) ──
// These gaps live in fields the OLD length-sum fingerprint never hashed: a tool_call's `arguments` (a
// structured value, excluded entirely) and a tool_result's `isError` flag (metadata). Build a baseline
// that CONTAINS a tool pair, ingest it (append — no rebuild), then mutate ONLY those fields under
// identical durable ids + identical visible text — each must still force a divergence rebuild. Restores
// messagesPlus at the end so the sections below resume from the pristine 3-message baseline.
{
	const fetchMeta = () =>
		new Promise((resolve, reject) => {
			http.get({ host: "127.0.0.1", port: PORT, path: "/__accordion/meta" }, (res) => {
				let buf = "";
				res.on("data", (d) => (buf += d));
				res.on("end", () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
			}).on("error", reject);
		});
	const TCALL_ID = "a:resp-e1tool:p0";
	const TRESULT_ID = "r:call-e1";
	const withTool = [
		...messagesPlus,
		{ role: "assistant", content: [{ type: "toolCall", id: "call-e1", name: "shell", arguments: { cmd: "ls" } }], responseId: "resp-e1tool", timestamp: T0 + 10 },
		{ role: "toolResult", toolCallId: "call-e1", toolName: "shell", content: "IDENTICAL RESULT TEXT", isError: false, timestamp: T0 + 11 },
	];
	// Baseline: append the tool pair as a suffix over messagesPlus (no rebuild — pure O(Δ) append).
	await Promise.resolve(handlers.context({ messages: withTool }, ctx));

	// gap #2: rewrite ONLY the tool_call arguments — same id, same name, same downstream result.
	const argRewrite = withTool.map((m) =>
		m.responseId === "resp-e1tool"
			? { ...m, content: [{ type: "toolCall", id: "call-e1", name: "shell", arguments: { cmd: "rm -rf /" } }] }
			: m,
	);
	{
		const before = await fetchMeta();
		a.inbox.snapshot.length = 0;
		await Promise.resolve(handlers.context({ messages: argRewrite }, ctx));
		await waitFor(() => a.inbox.snapshot.length > 0, 2000, "rebuild after tool-call arg rewrite").catch(
			() => fails.push("a tool-call ARGUMENT rewrite (same id) did not trigger a rebuild — arguments were unhashed"),
		);
		const after = await fetchMeta();
		if (!(after.telemetry.rebuilds > before.telemetry.rebuilds))
			fails.push(`tool-call arg rewrite did not increment telemetry.rebuilds (before=${before.telemetry.rebuilds}, after=${after.telemetry.rebuilds})`);
		const blk = a.inbox.snapshot.at(-1)?.state?.blocks?.find((x) => x.id === TCALL_ID);
		if (!blk || !String(blk.text).includes("rm -rf /"))
			fails.push(`Truth did not adopt the rewritten tool-call arguments (got ${JSON.stringify(blk?.text)})`);
	}

	// gap #3: flip ONLY isError on the tool_result — identical text, same id. `argRewrite` is now the
	// baseline (last ingested), so `errFlip` differs from it in EXACTLY the isError bit — nothing else.
	{
		const errFlip = argRewrite.map((m) => (m.toolCallId === "call-e1" ? { ...m, isError: true } : m));
		const before = await fetchMeta();
		a.inbox.snapshot.length = 0;
		await Promise.resolve(handlers.context({ messages: errFlip }, ctx));
		await waitFor(() => a.inbox.snapshot.length > 0, 2000, "rebuild after isError flip").catch(
			() => fails.push("a tool_result isError flip (identical text) did not trigger a rebuild — metadata was ignored"),
		);
		const after = await fetchMeta();
		if (!(after.telemetry.rebuilds > before.telemetry.rebuilds))
			fails.push(`isError flip did not increment telemetry.rebuilds (before=${before.telemetry.rebuilds}, after=${after.telemetry.rebuilds})`);
		const blk = a.inbox.snapshot.at(-1)?.state?.blocks?.find((x) => x.id === TRESULT_ID);
		if (blk && blk.isError !== true)
			fails.push(`Truth did not adopt the flipped isError for ${TRESULT_ID} (got ${JSON.stringify(blk?.isError)})`);
	}

	// Restore the pristine 3-message baseline (shorter → divergence rebuild) for the sections below.
	await Promise.resolve(handlers.context({ messages: messagesPlus }, ctx));
}

// Client B connects AFTER more history → its snapshot carries all 3 blocks (hydration path). B is a
// DIFFERENT surface, and A already holds the lease, so B connects as a live READ-ONLY mirror.
const b = connectClient(SURFACE_B, "Browser tab");
await waitFor(() => b.inbox.snapshot.length > 0, 2000, "client B snapshot").catch(() => fails.push("client B never received a snapshot"));
{
	const snap = b.inbox.snapshot[0];
	const ids = snap ? snap.state.blocks.map((x) => x.id) : [];
	if (!ids.includes(USER_ID) || !ids.includes(ASST_ID) || !ids.includes(FOLLOWUP_ID))
		fails.push(`with-history snapshot missing block ids (got ${JSON.stringify(ids)})`);
	// v16: B connects while A holds a FRESH lease → hello.controller names A and is fresh (the shape
	// a GUI reads to decide "someone else steers" → show the takeover popup rather than auto-claim).
	const helloB = b.inbox.hello[0];
	if (!helloB || !helloB.controller || helloB.controller.surfaceId !== SURFACE_A || helloB.controller.fresh !== true)
		fails.push(`client B hello.controller should name surface A as the fresh controller (got ${JSON.stringify(helloB?.controller)})`);
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

// ── Phase C: conductor host — select/detach, eager locks, wire-departing birth-fold ──
// Folding is ON from the earlier section and protect is 0 (so a fold is a normal, non-birth fold).
{
	// (0) folding OFF + a conductor attached → the wire is UNTOUCHED and NO hold is paid (the gate is
	//     foldingEnabled && holdWireUpToMs). Verify, then restore folding ON for the rest of the section.
	a.inbox.folding.length = 0;
	a.sendCmd({ kind: "setFolding", value: false });
	await waitFor(() => a.inbox.folding.some((f) => f.enabled === false), 1500, "folding off").catch(() => fails.push("setFolding(false) was not echoed"));
	a.inbox.conductorState = [];
	a.sendCmd({ kind: "selectConductor", id: "doorman" });
	await waitFor(() => (a.inbox.conductorState || []).some((m) => m.active?.id === "doorman"), 2000, "doorman attach (folding off)").catch(
		() => fails.push("selectConductor(doorman) did not attach while folding off"),
	);
	a.inbox.telemetry.length = 0;
	{
		const ret = await Promise.resolve(handlers.context({ messages: messagesPlus }, ctx));
		if (ret !== undefined) fails.push("folding OFF + conductor attached altered the wire (should pass through)");
		const tel = a.inbox.telemetry.at(-1);
		if (tel && tel.lastHoldMs !== 0) fails.push(`folding OFF + conductor attached paid a wire-departing hold (lastHoldMs=${tel.lastHoldMs})`);
	}
	a.sendCmd({ kind: "selectConductor", id: null });
	await waitFor(() => (a.inbox.conductorState || []).some((m) => m.active === null), 1500, "detach after folding-off check").catch(() => {});
	a.inbox.folding.length = 0;
	a.sendCmd({ kind: "setFolding", value: true });
	await waitFor(() => a.inbox.folding.some((f) => f.enabled === true), 1500, "folding on").catch(() => fails.push("setFolding(true) restore was not echoed"));

	// (1) Attach an in-process conductor that declares locks → eager setLocks broadcasts a `locks`
	//     event AND a conductorState. compaction-naive claims human-steering + agent-unfold.
	a.inbox.event.length = 0;
	a.inbox.conductorState = [];
	a.sendCmd({ kind: "selectConductor", id: "compaction-naive" });
	await waitFor(() => (a.inbox.conductorState || []).some((m) => m.active?.id === "compaction-naive"), 2000, "conductorState attach").catch(
		() => fails.push("selectConductor(compaction-naive) did not broadcast a conductorState"),
	);
	await waitFor(() => a.inbox.event.some((e) => e.event?.kind === "locks" && (e.event.locks || []).includes("human-steering")), 2000, "eager locks").catch(
		() => fails.push("selectConductor(compaction-naive) did not eager-acquire its declared locks"),
	);

	// (2) Detach (select none) → freeze + clearLocks → conductorState:null + a locks-cleared event.
	a.inbox.event.length = 0;
	a.inbox.conductorState = [];
	a.sendCmd({ kind: "selectConductor", id: null });
	await waitFor(() => (a.inbox.conductorState || []).some((m) => m.active === null), 2000, "conductorState detach").catch(
		() => fails.push("selectConductor(null) did not broadcast conductorState:null"),
	);
	await waitFor(() => a.inbox.event.some((e) => e.event?.kind === "locks" && (e.event.locks || []).length === 0), 2000, "locks cleared").catch(
		() => fails.push("selectConductor(null) did not clear the conductor's locks"),
	);

	// (3) Attach doorman (in-process, holdWireUpToMs) and append a GIANT prior-turn tool_result as a
	//     fresh suffix. The next context hook HOLDS the departing wire; doorman folds the giant, so it
	//     rides the wire as the short {#code FOLDED} digest — a strategy fold produced through the hold.
	const GIANT = "network request trace line — repeated many times to exceed the fold threshold. ".repeat(170);
	const toolMessages = [
		{ role: "assistant", content: [{ type: "toolCall", id: "call-giant", name: "shell", arguments: {} }], responseId: "resp-tool", timestamp: T0 + 3 },
		{ role: "toolResult", toolCallId: "call-giant", toolName: "shell", content: GIANT, isError: false, timestamp: T0 + 4 },
		{ role: "user", content: "third turn", timestamp: T0 + 5 },
		{ role: "assistant", content: [{ type: "text", text: "done" }], responseId: "resp-done", timestamp: T0 + 6 },
	];
	const doormanMessages = [...messagesPlus, ...toolMessages];

	a.inbox.conductorState = [];
	a.sendCmd({ kind: "selectConductor", id: "doorman" });
	await waitFor(() => (a.inbox.conductorState || []).some((m) => m.active?.id === "doorman"), 2000, "doorman attach").catch(
		() => fails.push("selectConductor(doorman) did not attach"),
	);
	{
		const ret = await Promise.resolve(handlers.context({ messages: doormanMessages }, ctx));
		const foldedResult = ret?.messages?.[4]?.content?.[0]?.text; // index 4 = the giant tool_result
		if (typeof foldedResult !== "string") fails.push("context hook (doorman) did not return replacement messages for the giant");
		else if (foldedResult.length >= GIANT.length) fails.push(`doorman did not fold the giant on the wire (len ${foldedResult.length} vs ${GIANT.length})`);
		else if (!foldedResult.startsWith("{#") && !foldedResult.startsWith("⟨")) fails.push(`doorman fold produced an unexpected wire body: ${JSON.stringify(foldedResult.slice(0, 40))}`);
	}

	// (4) Detach doorman → the freeze kill switch transfers the strategy fold to the human, so the
	//     NEXT hook (no conductor attached) STILL folds the giant on the wire (fold survived detach).
	a.inbox.conductorState = [];
	a.sendCmd({ kind: "selectConductor", id: null });
	await waitFor(() => (a.inbox.conductorState || []).some((m) => m.active === null), 2000, "doorman detach").catch(
		() => fails.push("selectConductor(null) after doorman did not detach"),
	);
	{
		const afterDetach = await Promise.resolve(handlers.context({ messages: doormanMessages }, ctx));
		const stillFolded = afterDetach?.messages?.[4]?.content?.[0]?.text;
		if (typeof stillFolded !== "string" || stillFolded.length >= GIANT.length)
			fails.push("after detach the freeze did not preserve doorman's fold as a human fold");
	}
}

// ── native-compaction suppression is gated on foldingEnabled, NOT attached() ────
// Folding is ARMED (true) here (Phase C step (0) restored it). A connected client (`a`) is attached
// throughout this block — the whole point of the policy is that attachment alone must NOT suppress.
{
	// (1) folding ON + client attached → suppressed, with the "armed" notify.
	notifications.length = 0;
	const armedRet = await Promise.resolve(handlers.session_before_compact({ reason: "threshold" }, ctx));
	if (!armedRet || armedRet.cancel !== true) fails.push("folding ON did not suppress native compaction (expected {cancel:true})");
	if (!notifications.some((n) => n.message.includes("suppressed"))) fails.push("folding-ON suppression did not notify");

	// (2) folding OFF + client attached → NOT suppressed (owner policy: a viewer with folding off
	//     leaves pi's own safety net intact) — pi runs its native compaction unhindered.
	a.inbox.folding.length = 0;
	a.sendCmd({ kind: "setFolding", value: false });
	await waitFor(() => a.inbox.folding.some((f) => f.enabled === false), 1500, "folding off (compaction section)").catch(
		() => fails.push("setFolding(false) was not echoed (compaction section)"),
	);
	notifications.length = 0;
	const offRet = await Promise.resolve(handlers.session_before_compact({ reason: "overflow" }, ctx));
	if (offRet !== undefined) fails.push("folding OFF still suppressed native compaction (attached() regression)");
	if (notifications.some((n) => n.message.includes("suppressed"))) fails.push("folding-OFF path unexpectedly emitted the suppression notify");

	// (3) session_compact (post-compaction) fires while a client IS attached → a quiet status notify,
	//     no cancellation possible (there's nothing to cancel — pi already saved the compaction).
	// (`session_compact` gating on `attached()` reuses the same primitive already exercised
	// extensively elsewhere in this file — e.g. the /accordion command's wasAttached branch above and
	// the READ-ONLY/controller sections below all depend on `attached()` being accurate — so a
	// dedicated "zero clients" rerun here is not repeated; it would require tearing down both `a` and
	// `b`, which every later section in this file depends on staying open.)
	notifications.length = 0;
	a.inbox.notice = [];
	b.inbox.notice = [];
	await Promise.resolve(handlers.session_compact({ reason: "overflow", fromExtension: false, willRetry: false }, ctx));
	if (!notifications.some((n) => n.message.includes("compacted"))) fails.push("session_compact (attached) did not notify about the native compaction");
	// v17: the SAME event also broadcasts a `notice` to every connected GUI client (not just whoever
	// is watching pi's own CLI) — assert both already-connected clients (`a`/`b`) receive it.
	await waitFor(() => (a.inbox.notice || []).length > 0 && (b.inbox.notice || []).length > 0, 2000, "notice broadcast on native compaction").catch(
		() => fails.push("session_compact did not broadcast a `notice` message to connected clients"),
	);
	if ((a.inbox.notice || []).some((n) => typeof n.text !== "string" || !n.text.includes("compacted")))
		fails.push("notice broadcast text did not mention the native compaction");

	// Restore folding ON for the sections that follow, which assume it.
	a.inbox.folding.length = 0;
	a.sendCmd({ kind: "setFolding", value: true });
	await waitFor(() => a.inbox.folding.some((f) => f.enabled === true), 1500, "folding on (compaction section restore)").catch(
		() => fails.push("setFolding(true) restore (compaction section) was not echoed"),
	);
}

// ── E2 (external review round): folding must reset to OFF on every session_start ──
// Folding is ARMED (true) at this point — Phase C step (0) above restored it after the folding-off
// hold check. `foldingEnabled` is a process-level closure var, separate from the Truth this handler
// already unconditionally tears down and rebuilds. Simulate a session swap (as pi fires for /new,
// /resume, /fork — and, since this handler already resets Truth/lastMessages/meta/sessionId for
// EVERY reason including "reload", a mere reload too — see accordion.ts's session_start comment for
// the full justification) and assert: (1) the arm resets WITHOUT a fresh opt-in, and (2) the
// already-attached clients — whose GUI toggle currently shows "on" — are told about the reset
// rather than being left to silently drift from the now-false internal state.
{
	a.inbox.folding.length = 0;
	b.inbox.folding.length = 0;
	handlers.session_start({ type: "session_start", reason: "new" }, ctx);
	await waitFor(
		() => a.inbox.folding.some((f) => f.enabled === false) && b.inbox.folding.some((f) => f.enabled === false),
		2000,
		"folding reset broadcast on session_start",
	).catch(() => fails.push("session_start did not broadcast folding:false to already-attached clients when folding had been armed"));

	const meta = await new Promise((resolve, reject) => {
		http.get({ host: "127.0.0.1", port: PORT, path: "/__accordion/meta" }, (res) => {
			let buf = ""; res.on("data", (d) => (buf += d)); res.on("end", () => resolve(JSON.parse(buf)));
		}).on("error", reject);
	});
	if (meta.telemetry?.foldingEnabled !== false) fails.push(`session_start did not reset foldingEnabled (meta reports ${meta.telemetry?.foldingEnabled})`);

	// session_start mints a NEW sessionId but — correctly, since /new et al. never restart the shared
	// WS/HTTP server — does not rewrite the registry file for it until the next heartbeat tick. Clean
	// up the ORIGINAL entry ourselves so the final shutdown assertion below (which expects an EMPTY
	// sessions dir) isn't tripped by a file orphaned by this simulated mid-test session swap — a
	// pre-existing registry-advertisement timing gap a real heartbeat interval papers over in
	// production, unrelated to this fix.
	try { fs.unlinkSync(path.join(SESSIONS_DIR, `${entry.sessionId}.json`)); } catch { /* already gone */ }
}

// ── E3 (external review round): sent-state must survive a context-hook error ──
// Append a fresh, not-yet-sent block via `message_end` — a SEPARATE hook from `context`, with no
// try/catch of its own, so it's a clean way to get a block into Truth whose `sentThroughOrder`
// cursor has not yet caught up to it. Then fire `context` with a deliberately messages-less event
// so `ingestMessages(undefined)` throws (`.length` on `undefined`) inside the hook's try — forcing
// the same passthrough/error path a real parse failure or Truth bug would take. Before the fix,
// `markSent` lived INSIDE the try, AFTER this risky work, so the throw skipped it entirely — even
// though pi still receives the messages it was given, RAW, on this path (the error path IS
// passthrough, not a dropped call). Assert (1) the error is genuinely taken (`hookErrors`
// increments) and (2) a `sent` event still reaches the client covering the newly appended block,
// proving `markSent`'s `finally` guarantee ran despite the throw.
{
	const fetchMeta3 = () =>
		new Promise((resolve, reject) => {
			http.get({ host: "127.0.0.1", port: PORT, path: "/__accordion/meta" }, (res) => {
				let buf = "";
				res.on("data", (d) => (buf += d));
				res.on("end", () => {
					try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
				});
			}).on("error", reject);
		});

	const metaBefore = await fetchMeta3();

	a.inbox.event.length = 0;
	handlers.message_end({ message: { role: "user", content: "e3 sent-state probe", timestamp: Date.now() } }, ctx);
	await waitFor(() => a.inbox.event.some((e) => e.event?.kind === "appended"), 2000, "E3 probe block appended").catch(
		() => fails.push("message_end did not append the E3 probe block"),
	);
	const appended = a.inbox.event.find((e) => e.event?.kind === "appended");
	const probeOrder = appended?.event?.blocks?.at(-1)?.order;
	if (typeof probeOrder !== "number") fails.push("E3 probe block's appended event lacked a numeric order");

	a.inbox.event.length = 0;
	// No `messages` key at all — event.messages is undefined, so ingestMessages(undefined) throws.
	const ret = await Promise.resolve(handlers.context({}, ctx));
	if (ret !== undefined) fails.push("the context hook's error path should return undefined (raw passthrough), not a replacement");

	await waitFor(() => a.inbox.event.some((e) => e.event?.kind === "sent"), 2000, "sent event after a hook error").catch(
		() => fails.push("markSent did not run on the context hook's error path — no `sent` event reached the client"),
	);
	const sentEvent = a.inbox.event.find((e) => e.event?.kind === "sent");
	if (sentEvent && typeof probeOrder === "number" && sentEvent.event.throughOrder < probeOrder)
		fails.push(`markSent on the error path did not cover the newly appended block (throughOrder=${sentEvent.event.throughOrder}, expected >= ${probeOrder})`);

	const metaAfter = await fetchMeta3();
	if (!(metaAfter.telemetry.hookErrors > metaBefore.telemetry.hookErrors))
		fails.push(`the messages-less context call did not increment hookErrors (before=${metaBefore.telemetry.hookErrors}, after=${metaAfter.telemetry.hookErrors})`);
}

// ── malformed ingress: authorized ≠ well-formed (sol P1/P2 #3) ──────────────────
// Client A is an AUTHORIZED GUI socket. An authorized peer is still allowed to be BUGGY: it can send
// a `setBudget:"hello"`/`"NaN"`/negative dial (which used to write `Truth.budget = NaN` → JSON-null →
// forked replicas) and an `ops:[null]` (which used to deref `op.kind` and THROW out of the WS message
// callback, killing the extension for every other connected client). Fire the whole barrage at the
// live session and assert the process stays up, nothing corrupts the Truth, the host-only `freeze` op
// is still stripped, and a normal command right after the garbage still applies — then restore the
// pristine budget so nothing downstream sees drift.
{
	const fetchMetaMal = () =>
		new Promise((resolve, reject) => {
			http.get({ host: "127.0.0.1", port: PORT, path: "/__accordion/meta" }, (res) => {
				let buf = "";
				res.on("data", (d) => (buf += d));
				res.on("end", () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
			}).on("error", reject);
		});
	// A resnapshot is the honest read of authoritative Truth state (budget/protectTokens/rev) — the
	// GUI resnapshot path never mutates, so before/after diffs isolate exactly what the garbage did.
	const resnap = async (label) => {
		a.inbox.snapshot.length = 0;
		a.ws.send(JSON.stringify({ type: "resnapshot" }));
		await waitFor(() => a.inbox.snapshot.length > 0, 2000, label);
		return a.inbox.snapshot.at(-1).state;
	};

	// An escaping throw in a `ws` message listener surfaces as a process uncaughtException, not a
	// rejection — capture BOTH so a regression (a boundary that stops catching) fails loudly here
	// instead of taking down the whole smoke run.
	const asyncErrors = [];
	const onRej = (r) => asyncErrors.push(`unhandledRejection: ${r?.message ?? r}`);
	const onExc = (e) => asyncErrors.push(`uncaughtException: ${e?.message ?? e}`);
	process.on("unhandledRejection", onRej);
	process.on("uncaughtException", onExc);

	const pristine = await resnap("malformed-ingress pristine snapshot").catch((e) => { fails.push(`malformed-ingress: could not read a pristine snapshot (${e.message})`); return null; });
	if (pristine) {
		a.inbox.commandResult.length = 0;
		// Seqs well above client A's own ++seq counter so each reply is matchable unambiguously.
		const G = 9000;
		const garbage = [
			{ seq: G + 1, cmd: null },                                   // cmd is not an object → refused
			{ seq: G + 2, cmd: { kind: "setBudget", value: "hello" } },  // non-numeric dial → refused
			{ seq: G + 3, cmd: { kind: "setBudget", value: "NaN" } },    // JSON can't carry NaN; the string is still non-numeric → refused
			{ seq: G + 4, cmd: { kind: "setBudget", value: "3.5" } },    // numeric-looking STRING is still not a number → refused
			{ seq: G + 5, cmd: { kind: "setBudget", value: -5 } },       // negative → coerced finite (0, then Truth floors) — safe, NOT a fork
			{ seq: G + 6, cmd: { kind: "ops", ops: [null] } },           // structurally-invalid op dropped → empty no-op batch
			{ seq: G + 7, cmd: { kind: "ops", ops: [{ kind: "freeze" }] } }, // host-only op → still stripped as a `locked` clamp
		];
		for (const g of garbage) a.ws.send(JSON.stringify({ type: "command", ...g }));

		// (1) Process alive + no throw escaped the callback: EVERY garbage frame is acked with a
		//     commandResult (a dropped/hung handler or a crash would leave one unanswered).
		await waitFor(() => garbage.every((g) => a.inbox.commandResult.some((r) => r.seq === g.seq)), 2000, "malformed-ingress acks").catch(
			() => fails.push("a malformed command did not receive a commandResult ack — the ingress handler dropped, hung, or crashed on it"),
		);
		if (a.ws.readyState !== 1) fails.push("client A socket died during the malformed ingress barrage (a throw escaped the WS callback)");

		// (2) The garbage did NOT corrupt the Truth: budget stays a real finite number and neither dial moved.
		const afterGarbage = await resnap("malformed-ingress post-garbage snapshot").catch(() => null);
		if (afterGarbage) {
			if (!Number.isFinite(afterGarbage.budget)) fails.push(`malformed ingress poisoned the budget to a non-finite value (${afterGarbage.budget}) — NaN reached Truth`);
			if (afterGarbage.budget !== pristine.budget) fails.push(`malformed ingress moved the budget (${pristine.budget} → ${afterGarbage.budget})`);
			if (afterGarbage.protectTokens !== pristine.protectTokens) fails.push(`malformed ingress moved protectTokens (${pristine.protectTokens} → ${afterGarbage.protectTokens})`);
		}

		// (3) Refusals match the clamp-UX shape: the four unusable commands come back with an
		//     empty-results commandResult at the UNCHANGED rev (Truth was never touched).
		for (const seq of [G + 1, G + 2, G + 3, G + 4]) {
			const r = a.inbox.commandResult.find((x) => x.seq === seq);
			if (!r || r.results.length !== 0 || r.rev !== pristine.rev)
				fails.push(`malformed command seq ${seq} was not refused cleanly (expected empty results at rev ${pristine.rev}, got ${JSON.stringify(r)})`);
		}

		// (4) The host-only `freeze` smuggled through an `ops` command is still stripped and reported
		//     as a `locked` clamp — sanitize must not open the ungated kill switch to a wire client.
		const freezeRes = a.inbox.commandResult.find((x) => x.seq === G + 7);
		if (!freezeRes || !freezeRes.results.some((o) => o.clamped === "locked" && o.op?.kind === "freeze"))
			fails.push(`the host-only freeze op was not stripped as a locked clamp (got ${JSON.stringify(freezeRes)})`);

		// (5) A NORMAL command right after the barrage still applies — the session is fully functional.
		a.ws.send(JSON.stringify({ type: "command", seq: G + 8, cmd: { kind: "setBudget", value: pristine.budget + 4000 } }));
		await waitFor(() => a.inbox.commandResult.some((r) => r.seq === G + 8), 2000, "valid command after barrage").catch(
			() => fails.push("the valid command after the garbage barrage received no commandResult"),
		);
		const afterValid = await resnap("malformed-ingress post-valid snapshot").catch(() => null);
		if (afterValid && afterValid.budget !== pristine.budget + 4000)
			fails.push(`the valid command after the barrage did not apply (budget ${afterValid?.budget}, expected ${pristine.budget + 4000})`);

		// (6) No throw was merely swallowed elsewhere: the ingress error counter stayed 0 (sanitize
		//     handled every case) and no async error fired during the barrage.
		const metaMal = await fetchMetaMal().catch(() => null);
		if (metaMal && metaMal.telemetry.ingressErrors !== 0)
			fails.push(`the malformed ingress barrage was caught as ${metaMal.telemetry.ingressErrors} throw(s) — sanitize should handle every case without throwing`);
		if (asyncErrors.length) fails.push(`the malformed ingress barrage produced ${asyncErrors.length} unhandled async error(s): ${asyncErrors.join("; ")}`);

		// Restore the pristine budget so nothing downstream sees drift (pristine-baseline restore).
		a.ws.send(JSON.stringify({ type: "command", seq: G + 9, cmd: { kind: "setBudget", value: pristine.budget } }));
		await waitFor(() => a.inbox.commandResult.some((r) => r.seq === G + 9), 2000, "budget restore").catch(() => {});
	}

	process.off("unhandledRejection", onRej);
	process.off("uncaughtException", onExc);
}

// ── v16 single-controller: READ-ONLY enforcement + takeover (ADR 0024) ──────────
// A holds the lease (claimed at connect). B is a different surface, so it is a live READ-ONLY mirror:
// its mutating commands must be refused with the typed "read-only" clamp WITHOUT touching the Truth.
// Then B claims control → A is demoted (receives a `controller` broadcast naming B) and A's own next
// command is refused. The human is always the authority, so B's takeover is never blocked.
{
	// (1) A NON-controller surface (B) cannot steer: a fold command comes back refused "read-only".
	b.inbox.commandResult.length = 0;
	b.sendCmd({ kind: "ops", ops: [{ kind: "fold", ids: [ASST_ID] }] });
	await waitFor(() => b.inbox.commandResult.length > 0, 2000, "B fold commandResult").catch(
		() => fails.push("client B's fold command received no commandResult"),
	);
	{
		const r = b.inbox.commandResult.at(-1);
		if (!r || r.refused !== "read-only") fails.push(`client B (non-controller) fold was not refused read-only (got ${JSON.stringify(r)})`);
		if (r && !(r.results || []).every((o) => o.clamped === "read-only"))
			fails.push(`client B's refused ops did not carry per-op read-only clamps (got ${JSON.stringify(r?.results)})`);
	}
	// A dial command from B (no ops) is ALSO refused, via the top-level flag (empty results).
	b.inbox.commandResult.length = 0;
	b.sendCmd({ kind: "setProtect", value: 12345 });
	await waitFor(() => b.inbox.commandResult.length > 0, 2000, "B setProtect commandResult").catch(
		() => fails.push("client B's setProtect command received no commandResult"),
	);
	{
		const r = b.inbox.commandResult.at(-1);
		if (!r || r.refused !== "read-only" || (r.results || []).length !== 0)
			fails.push(`client B (non-controller) setProtect was not refused read-only with empty results (got ${JSON.stringify(r)})`);
	}

	// (2) The human is the authority — B claims and takes over immediately. A (the prior controller)
	//     receives a `controller` broadcast naming B, and its own next command is now refused.
	a.inbox.controller.length = 0;
	b.inbox.controller.length = 0;
	b.claim();
	await waitFor(() => a.inbox.controller.some((c) => c.surfaceId === SURFACE_B), 2000, "A observes B's takeover").catch(
		() => fails.push("after B claimed, client A did not receive a controller broadcast naming surface B"),
	);
	if (!b.inbox.controller.some((c) => c.surfaceId === SURFACE_B))
		fails.push("client B did not receive its own controller broadcast after claiming");

	a.inbox.commandResult.length = 0;
	a.sendCmd({ kind: "ops", ops: [{ kind: "fold", ids: [ASST_ID] }] });
	await waitFor(() => a.inbox.commandResult.length > 0, 2000, "A fold commandResult after demotion").catch(
		() => fails.push("demoted client A's fold command received no commandResult"),
	);
	{
		const r = a.inbox.commandResult.at(-1);
		if (!r || r.refused !== "read-only") fails.push(`demoted client A's fold was not refused read-only (got ${JSON.stringify(r)})`);
	}

	// (3) The lease file on disk reflects B as the holder (the global blackboard, not just in-memory).
	try {
		const lease = JSON.parse(fs.readFileSync(CONTROLLER_PATH, "utf8"));
		if (lease.surfaceId !== SURFACE_B) fails.push(`controller.json holder should be surface B (got ${JSON.stringify(lease.surfaceId)})`);
	} catch (e) {
		fails.push(`could not read controller.json after B's claim (${e.message})`);
	}

	// Restore A as the controller so nothing downstream (only shutdown follows) is surprised.
	a.inbox.controller.length = 0;
	a.claim();
	await waitFor(() => a.inbox.controller.some((c) => c.surfaceId === SURFACE_A), 2000, "A reclaims control").catch(() => {});
}

// ── C1 regression: a FOREIGN extension's fresh claim must NOT be clobbered by THIS extension's
//    heartbeat (which formerly re-asserted its stale in-memory holder). We stand in for "another
//    extension" by writing controller.json DIRECTLY (atomic write-rename) with a DIFFERENT surfaceId
//    and a fresh heartbeat, while A (a local surface) is still connected as the prior holder. With the
//    fast-heartbeat / slow-poll seams set at the top of this file, a heartbeat is guaranteed to fire
//    (before the slow poll) after the foreign write — so a REGRESSED heartbeat would clobber it here.
{
	const FOREIGN_SURFACE = "surface-foreign-9999";
	a.inbox.controller.length = 0; // A is the current holder (just reclaimed above) + connected
	const writeForeignLease = () => {
		const lease = { registryProtocol: 1, surfaceId: FOREIGN_SURFACE, label: "Foreign surface", claimedAt: Date.now(), heartbeatAt: Date.now() };
		const tmp = `${CONTROLLER_PATH}.foreign-${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(lease));
		fs.renameSync(tmp, CONTROLLER_PATH);
	};
	writeForeignLease();
	// (b) THIS extension observes the foreign claim (via its heartbeat's fresh disk re-read) and
	//     broadcasts the change of hands to A.
	await waitFor(() => a.inbox.controller.some((c) => c.surfaceId === FOREIGN_SURFACE), 3000, "A observes the foreign claim").catch(
		() => fails.push("C1: extension did not broadcast the foreign controller claim it observed on disk"),
	);
	// Give several MORE heartbeat intervals a chance to (wrongly) re-assert surface A over the foreign lease.
	await new Promise((r) => setTimeout(r, 400));
	// (a) controller.json STILL names the foreign surface — the heartbeat never wrote surface A back over it.
	try {
		const lease = JSON.parse(fs.readFileSync(CONTROLLER_PATH, "utf8"));
		if (lease.surfaceId !== FOREIGN_SURFACE)
			fails.push(`C1: the heartbeat CLOBBERED a foreign claim — controller.json names ${JSON.stringify(lease.surfaceId)}, expected ${FOREIGN_SURFACE}`);
	} catch (e) {
		fails.push(`C1: could not read controller.json after the foreign claim (${e.message})`);
	}
	// (c) A (connected here, but no longer the on-disk holder) is now refused read-only.
	a.inbox.commandResult.length = 0;
	a.sendCmd({ kind: "ops", ops: [{ kind: "fold", ids: [ASST_ID] }] });
	await waitFor(() => a.inbox.commandResult.length > 0, 2000, "A fold commandResult after the foreign claim").catch(
		() => fails.push("C1: demoted client A's fold received no commandResult after the foreign claim"),
	);
	{
		const r = a.inbox.commandResult.at(-1);
		if (!r || r.refused !== "read-only")
			fails.push(`C1: after a foreign claim, local surface A's fold was not refused read-only (got ${JSON.stringify(r)})`);
	}
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

	// PHASE C: a `?role=conductor` socket is authorized SOLELY by the single-use pending attach token
	// — role confers NO privilege. No conductor is selected here, so there is no pending token, and
	// EVERY conductor dial must be rejected 403: no token, a wrong/stale token, the old native
	// no-Origin path (byte-open for GUI), and even the GUI web token.
	const condNoToken = await dialWs({}, "/?role=conductor");
	if (condNoToken.open || condNoToken.status !== 403) fails.push(`ws-hardening: conductor role without a token was not rejected (${JSON.stringify(condNoToken)})`);
	const condWrongToken = await dialWs({}, "/?role=conductor&token=deadbeefdeadbeef00000000");
	if (condWrongToken.open || condWrongToken.status !== 403) fails.push(`ws-hardening: conductor role with a wrong/stale token was not rejected (${JSON.stringify(condWrongToken)})`);
	if (TOKEN) {
		const condGuiToken = await dialWs({}, `/?role=conductor&token=${TOKEN}`);
		if (condGuiToken.open || condGuiToken.status !== 403)
			fails.push(`ws-hardening: the GUI web token authorized a conductor socket (token confers no conductor privilege) (${JSON.stringify(condGuiToken)})`);
	}

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

// ── v16 the stable door: bind / stand-down / takeover / foreign occupant (ADR 0024) ──
// Self-contained: flips ACCORDION_DOOR_PORT to a free port (the MAIN extension's door stayed disabled
// via "0" at the top) and races FRESH extension instances for it, in-process. Covers: (a) one
// extension binds the door and answers /__accordion/meta on it; (b) a second Accordion extension
// stands down (does NOT double-bind) and its /accordion offers the SHARED door URL; (c) when the
// holder exits, the standing-by extension claims the door within a few retry ticks; (d) a foreign
// (non-Accordion) occupant makes an extension stand down permanently and fall back to its ephemeral URL.
{
	const freePort = () =>
		new Promise((resolve, reject) => {
			const srv = net.createServer();
			srv.once("error", reject);
			srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
		});
	const doorMeta = (doorPort) =>
		new Promise((resolve) => {
			const r = http.get({ host: "127.0.0.1", port: doorPort, path: "/__accordion/meta" }, (res) => {
				let buf = ""; res.on("data", (d) => (buf += d));
				res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
			});
			r.on("error", () => resolve(null));
			r.setTimeout(1000, () => { r.destroy(); resolve(null); });
		});
	// waitFor above calls its predicate SYNCHRONOUSLY (a returned Promise is always truthy); the door
	// checks need to await an async probe, so use this async-aware poller instead. Returns true/false.
	const waitForAsync = async (pred, ms) => {
		const start = Date.now();
		while (Date.now() - start < ms) {
			if (await pred()) return true;
			await new Promise((r) => setTimeout(r, 50));
		}
		return false;
	};
	const makeCtx = (notes) => ({
		ui: { setStatus() {}, notify(message, type) { notes.push({ message, type }); }, theme: { fg: (_c, s) => s } },
		model: { id: "door/model", contextWindow: 1000 },
		getContextUsage: () => ({ tokens: 0, contextWindow: 1000 }),
	});
	const makeExtension = () => {
		const h = {};
		const notes = [];
		let cmd = null;
		const flg = new Map();
		const mpi = {
			on: (name, fn) => (h[name] = fn),
			registerFlag: (name, def) => flg.set(name, def?.default),
			getFlag: (name) => flg.get(name),
			registerCommand: (name, def) => { if (name === "accordion") cmd = def.handler; },
			registerTool: () => {},
			appendEntry: () => {},
		};
		accordionLive(mpi);
		return { h, notes, ctx: makeCtx(notes), get cmd() { return cmd; } };
	};

	const DOOR = await freePort();
	process.env.ACCORDION_DOOR_PORT = String(DOOR);
	process.env.ACCORDION_DOOR_RETRY_MS = "150"; // fast takeover for the test

	// (a) Extension X starts and becomes the door holder.
	const X = makeExtension();
	X.h.session_start({ type: "session_start", reason: "startup" }, X.ctx);
	let doorSid1 = null;
	if (!(await waitForAsync(async () => { const m = await doorMeta(DOOR); if (m?.served === true) { doorSid1 = m.sessionId; return true; } return false; }, 4000)))
		fails.push("no extension bound the door port after startup");
	if (doorSid1 && typeof doorSid1 !== "string") fails.push("door /__accordion/meta returned a non-string sessionId");

	// (b) Extension Y starts against the SAME door: it must stand down (X keeps the door), and Y's
	//     /accordion must still offer the stable door URL (proving it detected the live door + shares the secret).
	const Y = makeExtension();
	Y.h.session_start({ type: "session_start", reason: "startup" }, Y.ctx);
	await new Promise((r) => setTimeout(r, 400)); // let Y's EADDRINUSE probe + stand-down resolve
	{
		const m = await doorMeta(DOOR);
		if (!m || m.sessionId !== doorSid1) fails.push(`a second extension did not stand down — the door holder changed unexpectedly (was ${doorSid1}, now ${m?.sessionId})`);
	}
	await Promise.resolve(Y.cmd?.("", Y.ctx));
	{
		const line = Y.notes.map((n) => n.message).reverse().find((msg) => msg.includes("Browser: http"));
		if (!line || !line.includes(`http://127.0.0.1:${DOOR}/?token=`))
			fails.push(`standing-by extension Y's /accordion did not offer the stable door URL (got ${JSON.stringify(line)})`);
	}

	// (c) X exits → it releases the door → Y's retry claims it within a few ticks (holder changes).
	X.h.session_shutdown({}, X.ctx);
	if (!(await waitForAsync(async () => { const m = await doorMeta(DOOR); return m?.served === true && m.sessionId && m.sessionId !== doorSid1; }, 4000)))
		fails.push("after the door holder exited, the standing-by extension did not take over the door");

	// (d) A FOREIGN (non-Accordion) occupant → a fresh extension stands down permanently and falls
	//     back to its OWN ephemeral URL (never advertises the foreign port as the door).
	const foreignPort = await freePort();
	const foreign = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("not accordion"); });
	await new Promise((resolve, reject) => { foreign.once("error", reject); foreign.listen(foreignPort, "127.0.0.1", resolve); });
	process.env.ACCORDION_DOOR_PORT = String(foreignPort);
	const Z = makeExtension();
	Z.h.session_start({ type: "session_start", reason: "startup" }, Z.ctx);
	await new Promise((r) => setTimeout(r, 500)); // let Z's probe classify the occupant as foreign
	await Promise.resolve(Z.cmd?.("", Z.ctx));
	{
		const line = Z.notes.map((n) => n.message).reverse().find((msg) => msg.includes("Browser: http"));
		if (!line) fails.push("extension Z (foreign door occupant) printed no Browser URL");
		else if (line.includes(`127.0.0.1:${foreignPort}/`)) fails.push("extension Z advertised the FOREIGN-occupied port as the door URL");
		else if (!line.includes("Browser: http://127.0.0.1:")) fails.push(`extension Z did not fall back to an ephemeral Browser URL (got ${JSON.stringify(line)})`);
	}

	// (e)/(f)/(g) door-secret crash recovery (F2, ADR 0024 §8): the old "wx" open-then-write could
	// leave a permanently INVALID file (creator crashed between open and write) that every later
	// extension read once, failed to validate, and gave up on — no door, forever. The rework must
	// recover: reap a STALE invalid file and re-create atomically (tmp+link), and while the secret is
	// unresolved the door must NOT bind (gated), with the bounded retry re-kicking the bind when it
	// resolves.
	const DOOR_SECRET = path.join(HOME, ".accordion", "door-secret");
	const HEX64 = /^[0-9a-f]{64}$/i;
	const backdate = () => { const past = (Date.now() - 60_000) / 1000; fs.utimesSync(DOOR_SECRET, past, past); };

	// (e) A pre-existing EMPTY door-secret (simulated crashed creator; old mtime) → the extension
	//     reaps it, creates a valid secret, and the door still comes up on that recovered secret.
	fs.writeFileSync(DOOR_SECRET, "");
	backdate();
	const DOOR_E = await freePort();
	process.env.ACCORDION_DOOR_PORT = String(DOOR_E);
	const W1 = makeExtension();
	W1.h.session_start({ type: "session_start", reason: "startup" }, W1.ctx);
	if (!(await waitForAsync(async () => (await doorMeta(DOOR_E))?.served === true, 4000)))
		fails.push("door-secret recovery (empty file): the door never came up after a crashed-creator empty secret file");
	{
		let onDisk = "";
		try { onDisk = fs.readFileSync(DOOR_SECRET, "utf8").trim(); } catch { /* leave empty */ }
		if (!HEX64.test(onDisk)) fails.push(`door-secret recovery (empty file): on-disk secret is still invalid (${JSON.stringify(onDisk.slice(0, 20))})`);
		await Promise.resolve(W1.cmd?.("", W1.ctx));
		const line = W1.notes.map((n) => n.message).reverse().find((msg) => msg.includes("Browser: http"));
		if (!line || !line.includes(`http://127.0.0.1:${DOOR_E}/?token=${onDisk}`))
			fails.push(`door-secret recovery (empty file): /accordion did not print the door URL with the RECOVERED secret (got ${JSON.stringify(line)})`);
	}
	W1.h.session_shutdown({}, W1.ctx);

	// (f) Same recovery from GARBAGE content (not 64-hex; old mtime).
	fs.writeFileSync(DOOR_SECRET, "deadbeef-not-a-valid-secret\n");
	backdate();
	const DOOR_F = await freePort();
	process.env.ACCORDION_DOOR_PORT = String(DOOR_F);
	const W2 = makeExtension();
	W2.h.session_start({ type: "session_start", reason: "startup" }, W2.ctx);
	if (!(await waitForAsync(async () => (await doorMeta(DOOR_F))?.served === true, 4000)))
		fails.push("door-secret recovery (garbage file): the door never came up after a garbage secret file");
	{
		let onDisk = "";
		try { onDisk = fs.readFileSync(DOOR_SECRET, "utf8").trim(); } catch { /* leave empty */ }
		if (!HEX64.test(onDisk)) fails.push(`door-secret recovery (garbage file): on-disk secret is still invalid (${JSON.stringify(onDisk.slice(0, 20))})`);
	}
	W2.h.session_shutdown({}, W2.ctx);

	// (g) A YOUNG invalid file (current mtime — possibly a live writer, so it must NOT be reaped):
	//     the door must stay DOWN while the secret is unresolved (the bind is gated on a valid
	//     secret), and when the file later becomes valid (the "writer" completes), the bounded retry
	//     adopts it and re-kicks the door bind — the door comes up bearing EXACTLY that secret.
	fs.writeFileSync(DOOR_SECRET, ""); // young: NOT backdated
	const DOOR_G = await freePort();
	process.env.ACCORDION_DOOR_PORT = String(DOOR_G);
	process.env.ACCORDION_DOOR_SECRET_RETRY_MS = "50"; // fast retry ticks for the test
	const W3 = makeExtension();
	W3.h.session_start({ type: "session_start", reason: "startup" }, W3.ctx);
	await new Promise((r) => setTimeout(r, 250)); // several retry ticks elapse against the invalid file
	if ((await doorMeta(DOOR_G))?.served === true)
		fails.push("door-secret gate: the door bound while the secret file was still invalid (empty)");
	const LATE_SECRET = "ab".repeat(32); // the simulated writer completes with a valid 64-hex secret
	fs.writeFileSync(DOOR_SECRET, LATE_SECRET);
	if (!(await waitForAsync(async () => (await doorMeta(DOOR_G))?.served === true, 4000)))
		fails.push("door-secret retry: the door did not come up after the secret file became valid");
	else {
		await Promise.resolve(W3.cmd?.("", W3.ctx));
		const line = W3.notes.map((n) => n.message).reverse().find((msg) => msg.includes("Browser: http"));
		if (!line || !line.includes(`http://127.0.0.1:${DOOR_G}/?token=${LATE_SECRET}`))
			fails.push(`door-secret retry: /accordion did not print the door URL with the late-resolved secret (got ${JSON.stringify(line)})`);
	}
	W3.h.session_shutdown({}, W3.ctx);
	delete process.env.ACCORDION_DOOR_SECRET_RETRY_MS;

	// Cleanup: shut down the door-test extensions (deletes their registry entries) + the foreign server,
	// and disable the door again so the main shutdown/cleanup below sees a quiet, empty sessions dir.
	Y.h.session_shutdown({}, Y.ctx);
	Z.h.session_shutdown({}, Z.ctx);
	await new Promise((resolve) => foreign.close(resolve));
	process.env.ACCORDION_DOOR_PORT = "0";
	await new Promise((r) => setTimeout(r, 200));
}

// shutdown must stop advertising (delete the registry entry)
handlers.session_shutdown({}, ctx);
await waitFor(() => !fs.existsSync(SESSIONS_DIR) || fs.readdirSync(SESSIONS_DIR).length === 0, 1500, "registry cleanup").catch(
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
