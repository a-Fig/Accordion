/*
 * mock-server.mjs — a fake pi session for testing CONDUCTORS, driven from a browser.
 *
 * Tricks the Accordion DESKTOP app into thinking it's attached to a live pi session,
 * and gives you a browser control panel to play/pause/restart it and change its speed.
 * The only fake thing is the agent on the far end — the app's conductor runs for real
 * against the evolving store.
 *
 * Three faces on one process:
 *   1. pi-wire WebSocket (PORT)        — what Accordion connects to (protocol v5).
 *   2. registry advertisement          — writes ~/.accordion/sessions/<id>.json with a
 *      heartbeat so the DESKTOP app discovers it in the sidebar (the desktop build has
 *      no manual-port box; discovery is the only door). Deleted on shutdown.
 *   3. control HTTP + WS (CONTROL_PORT) — serves control.html and a command channel so a
 *      browser tab can play/pause/restart and slide TPS live.
 *
 * One shared generation clock drives every connected app. Folding lives in the app's
 * store (substitution, not removal), so a conductor's decisions are visible in the app
 * regardless — this fake never applies the returned plan (it just logs it). A conductor's
 * out-of-band completeRequest gets junk; connect real pi and it becomes a real response.
 *
 * Usage:
 *   cd extension && node mock-server.mjs        # starts paused; open the control URL
 *   (in another shell) cd app && npm run tauri dev   # the DESKTOP app (needs cargo on PATH)
 *   → open http://localhost:4318 in a browser, click the session in Accordion's sidebar,
 *     then hit Play in the browser.
 *
 * Env knobs:
 *   PORT=4317          pi-wire port advertised in the registry
 *   CONTROL_PORT=4318  browser control panel (http + ws)
 *   TPS=60             initial generation speed, tokens/sec (live-adjustable in the UI)
 *   CW=60000           context window → budget the app snaps to (smaller = more pressure)
 *   GROW=1             1 = context grows across loops; 0 = reset the store each loop
 *   SAMPLE=<path>      override the session file
 *
 * Selftest (no sockets): node mock-server.mjs --selftest
 */
import { WebSocketServer } from "ws";
import { createJiti } from "jiti";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);

// Load the app's REAL modules so the wire/registry can never silently desync from a
// version bump (the rot that killed the old mock: a hard-coded protocolVersion 1).
const { parse } = await jiti.import("../app/src/lib/engine/parse.ts");
const { PROTOCOL_VERSION, DEFAULT_PORT } = await jiti.import("../app/src/lib/live/protocol.ts");
const { isDurableId } = await jiti.import("../app/src/lib/live/mapping.ts");
const { REGISTRY_PROTOCOL, REGISTRY_DIR, SESSIONS_SUBDIR, FOCUS_FILE, HEARTBEAT_INTERVAL_MS } = await jiti.import(
	"../app/src/lib/live/registry.ts",
);

// ── config ───────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || DEFAULT_PORT);
const CONTROL_PORT = Number(process.env.CONTROL_PORT || PORT + 1);
const CW = Number(process.env.CW || 60_000);
const GROW = process.env.GROW !== "0";
const SAMPLE = process.env.SAMPLE || path.join(__dirname, "../app/static/sample-session.jsonl");
const JUNK = "[stub completion] fake pi — connect a real pi session for a real model response.";

const est = (s) => Math.ceil((s || "").length / 4) + 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GENERATED = new Set(["thinking", "text", "tool_call"]); // typed by the model; the rest commit instantly

// ── load + re-id the recorded session into wire blocks ─────────────────────────
// parse() reads the JSONL correctly but emits engine ids ("<eid>:u", "<eid>:r",
// "<eid>:<part>"). The wire fold guard (isDurableId) only accepts the prefix form
// (u:/a:/r:/s:). So prefix by kind, keeping the original id as the unique tail.
function kindPrefix(kind) {
	if (kind === "user") return "u";
	if (kind === "tool_result") return "r";
	return "a"; // thinking / text / tool_call all live on the assistant message
}

function loadBaseBlocks() {
	const raw = fs.readFileSync(SAMPLE, "utf8");
	const { meta, blocks } = parse(raw);
	const turnSpan = blocks.reduce((m, b) => Math.max(m, b.turn), 0) + 1;
	return { meta, blocks, turnSpan, orderSpan: blocks.length };
}

// Project an engine block → a fresh WireBlock for loop N. Ids and callIds are made unique
// per loop while preserving the durable prefix and the call/result pairing (both halves
// get the same #L<loop> callId suffix). turn/order offset so growth stays monotonic.
function toWire(b, loop, turnSpan, orderSpan) {
	return {
		id: `${kindPrefix(b.kind)}:L${loop}:${b.id}`,
		kind: b.kind,
		turn: b.turn + loop * turnSpan,
		order: b.order + loop * orderSpan,
		text: b.text,
		tokens: b.tokens,
		...(b.toolName != null ? { toolName: b.toolName } : {}),
		...(b.callId != null ? { callId: `${b.callId}#L${loop}` } : {}),
		...(b.model != null ? { model: b.model } : {}),
		...(b.isError ? { isError: true } : {}),
	};
}

const { meta, blocks, turnSpan, orderSpan } = loadBaseBlocks();

// ── selftest: validate the pipeline without opening a socket ───────────────────
if (process.argv.includes("--selftest")) {
	const hist = {};
	for (const b of blocks) hist[b.kind] = (hist[b.kind] || 0) + 1;
	const wire = blocks.map((b) => toWire(b, 0, turnSpan, orderSpan));
	const foldable = wire.filter((w) => w.kind === "thinking" || w.kind === "text" || w.kind === "tool_result");
	const allFoldableDurable = foldable.every((w) => isDurableId(w.id));
	const totalTokens = wire.reduce((s, w) => s + w.tokens, 0);
	const callIds = new Set(wire.filter((w) => w.kind === "tool_call").map((w) => w.callId));
	const orphanResults = wire.filter((w) => w.kind === "tool_result" && w.callId && !callIds.has(w.callId)).length;
	console.log("title:", meta.title, "| model:", meta.model);
	console.log("blocks:", blocks.length, "| kinds:", JSON.stringify(hist));
	console.log("turnSpan:", turnSpan, "| total tokens:", totalTokens);
	console.log("first ids:", wire.slice(0, 5).map((w) => w.id));
	console.log("all foldable ids durable:", allFoldableDurable);
	console.log("orphan tool_results (want 0):", orphanResults);
	if (!allFoldableDurable || orphanResults > 0) {
		console.error("SELFTEST FAILED");
		process.exit(1);
	}
	console.log("SELFTEST OK");
	process.exit(0);
}

// ── shared generation state ────────────────────────────────────────────────────
let playing = false; // start paused (drive it from the browser)
let tps = Math.max(1, Number(process.env.TPS || 60));
let epoch = 0; // bumped on Restart to invalidate any in-flight block
let loop = 0;
let idx = 0;
let emitted = []; // wire blocks emitted in the current epoch (caught-up sync for late joiners)
let reqId = 0;
const startedAt = Date.now();

const apps = new Set(); // pi-wire clients (Accordion)
const controls = new Set(); // browser control clients

const sessionId = "fake-" + process.pid;
const send = (ws, obj) => {
	try {
		ws.send(JSON.stringify(obj));
	} catch {
		/* socket gone */
	}
};
const broadcastApps = (obj) => {
	const s = JSON.stringify(obj);
	for (const ws of apps)
		try {
			ws.send(s);
		} catch {
			/* gone */
		}
};

function statusObj() {
	const cur = blocks[idx];
	return {
		type: "status",
		playing,
		tps,
		loop,
		grow: GROW,
		turn: cur ? cur.turn + loop * turnSpan : 0,
		blocksStreamed: emitted.length,
		totalTokens: emitted.reduce((s, b) => s + b.tokens, 0),
		budget: CW,
		appsConnected: apps.size,
		sessionTitle: meta.title,
		sessionBlocks: blocks.length,
	};
}
function pushStatus() {
	const s = JSON.stringify(statusObj());
	for (const ws of controls)
		try {
			ws.send(s);
		} catch {
			/* gone */
		}
}

function emitBlock(wire) {
	emitted.push(wire);
	broadcastApps({ type: "sync", reqId: ++reqId, full: false, blocks: [wire], contextWindow: CW });
}

// Restart: rewind to the top and reset every connected app's store (full:true).
function doRestart() {
	epoch++;
	loop = 0;
	idx = 0;
	emitted = [];
	broadcastApps({ type: "sync", reqId: ++reqId, full: true, blocks: [], contextWindow: CW });
	pushStatus();
}

// Interruptible paced wait: accumulate "token-time" so a live TPS change takes effect
// mid-block, and bail the instant we're paused or a Restart bumped the epoch.
async function pacedWait(tokens, myEpoch) {
	let progress = 0;
	const slice = 50;
	while (progress < tokens) {
		if (!playing || epoch !== myEpoch) return false;
		await sleep(slice);
		progress += tps * (slice / 1000);
	}
	return playing && epoch === myEpoch;
}

async function genLoop() {
	for (;;) {
		if (!playing) {
			await sleep(80);
			continue;
		}
		const myEpoch = epoch;
		const wire = toWire(blocks[idx], loop, turnSpan, orderSpan);

		if (GENERATED.has(wire.kind)) {
			broadcastApps({ type: "stream", phase: "start", kind: wire.kind, contentIndex: idx });
			const ok = await pacedWait(wire.tokens, myEpoch);
			broadcastApps({ type: "stream", phase: "abort", kind: wire.kind, contentIndex: -1 }); // sweep ghost
			if (!ok) continue; // paused or restarted mid-gen → re-gen this block (or top) later
			emitBlock(wire);
		} else {
			if (epoch !== myEpoch) continue;
			emitBlock(wire); // tool_result / user commit instantly
			await sleep(10);
		}

		idx++;
		if (idx >= blocks.length) {
			idx = 0;
			loop++;
			if (!GROW) {
				// reset each loop: clear the apps' stores and our caught-up cache.
				epoch++;
				emitted = [];
				broadcastApps({ type: "sync", reqId: ++reqId, full: true, blocks: [], contextWindow: CW });
			}
		}
		pushStatus();
	}
}

// ── registry advertisement (desktop discovery) ─────────────────────────────────
// Real usage writes to the real ~/.accordion so the desktop app discovers it; tests set
// ACCORDION_HOME to a throwaway dir (mirrors smoke.mjs) to avoid touching it.
const accordionHome = process.env.ACCORDION_HOME || os.homedir();
const sessionsDir = path.join(accordionHome, REGISTRY_DIR, SESSIONS_SUBDIR);
const entryPath = path.join(sessionsDir, sessionId + ".json");
function writeEntry() {
	const entry = {
		registryProtocol: REGISTRY_PROTOCOL,
		protocolVersion: PROTOCOL_VERSION,
		sessionId,
		port: PORT,
		pid: process.pid,
		cwd: meta.cwd || "fake://sample",
		title: meta.title || "FAKE pi session",
		model: meta.model || "fake-model",
		tokens: emitted.reduce((s, b) => s + b.tokens, 0) || null,
		contextWindow: CW,
		startedAt,
		heartbeatAt: Date.now(),
	};
	try {
		fs.writeFileSync(entryPath, JSON.stringify(entry));
	} catch {
		/* best-effort, never blocks */
	}
}
function removeEntry() {
	try {
		fs.unlinkSync(entryPath);
	} catch {
		/* already gone */
	}
}
// Simulate `/accordion`: write the one-shot focus request the app polls for. The desktop
// app consumes it (take_focus_request), selects THIS session, and foregrounds its window.
const focusPath = path.join(accordionHome, REGISTRY_DIR, FOCUS_FILE);
function writeFocus() {
	try {
		fs.writeFileSync(focusPath, JSON.stringify({ sessionId, ts: Date.now() }));
		console.log("focus request written (simulated /accordion)");
	} catch {
		/* best-effort */
	}
}
fs.mkdirSync(sessionsDir, { recursive: true });
writeEntry();
const heartbeat = setInterval(writeEntry, HEARTBEAT_INTERVAL_MS);

let shuttingDown = false;
function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	clearInterval(heartbeat);
	removeEntry();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", removeEntry);

// ── pi-wire server (Accordion connects here) ───────────────────────────────────
const piWss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
piWss.on("connection", (ws) => {
	apps.add(ws);
	console.log(`Accordion connected (${apps.size} attached)`);
	send(ws, {
		type: "hello",
		protocolVersion: PROTOCOL_VERSION,
		sessionId,
		meta: { title: meta.title || "FAKE pi session", cwd: meta.cwd || "", model: meta.model || "fake-model", contextWindow: CW, format: "pi" },
	});
	// Catch a mid-stream joiner up to the current state.
	send(ws, { type: "sync", reqId: ++reqId, full: true, blocks: emitted, contextWindow: CW });
	pushStatus();

	ws.on("message", (d) => {
		let m;
		try {
			m = JSON.parse(d.toString());
		} catch {
			return;
		}
		if (m.type === "completeRequest") {
			send(ws, {
				type: "completeResult",
				reqId: m.reqId,
				ok: true,
				text: JUNK,
				model: "fake-model",
				inputTokens: est(m.system) + est(m.prompt),
				outputTokens: est(JUNK),
			});
			console.log(`completeRequest #${m.reqId} → junk`);
		} else if (m.type === "plan") {
			const n = (m.ops?.length || 0) + (m.groups?.length || 0);
			if (n) console.log(`plan #${m.reqId}: ${m.ops?.length || 0} folds, ${m.groups?.length || 0} groups (logged, not applied)`);
		}
		// unfoldResult / recallResult: the app answering an agent tool the fake never called — ignore.
	});
	ws.on("close", () => {
		apps.delete(ws);
		console.log(`Accordion disconnected (${apps.size} attached)`);
		pushStatus();
	});
});

// ── control server (browser panel) ─────────────────────────────────────────────
const controlHtmlPath = path.join(__dirname, "control.html");
const httpServer = http.createServer((req, res) => {
	if (req.url === "/" || req.url === "/index.html") {
		fs.readFile(controlHtmlPath, (err, buf) => {
			if (err) {
				res.writeHead(500);
				res.end("control.html missing");
				return;
			}
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(buf);
		});
	} else {
		res.writeHead(404);
		res.end("not found");
	}
});
const controlWss = new WebSocketServer({ server: httpServer, path: "/ws" });
controlWss.on("connection", (ws) => {
	controls.add(ws);
	send(ws, statusObj());
	ws.on("message", (d) => {
		let m;
		try {
			m = JSON.parse(d.toString());
		} catch {
			return;
		}
		switch (m.cmd) {
			case "play":
				playing = true;
				break;
			case "pause":
				playing = false;
				break;
			case "restart":
				doRestart();
				break;
			case "focus":
				writeFocus();
				break;
			case "tps":
				if (Number.isFinite(m.value)) tps = Math.max(1, Math.min(100_000, m.value));
				break;
		}
		pushStatus();
	});
	ws.on("close", () => controls.delete(ws));
});
httpServer.listen(CONTROL_PORT, "127.0.0.1");

// Periodic status so the UI's "turn / blocks streamed" stays live while playing.
setInterval(() => {
	if (controls.size) pushStatus();
}, 1000);

void genLoop();

console.log(
	`fake pi ready (paused)\n` +
		`  session : "${meta.title}" — ${blocks.length} blocks, advertised as ${sessionId}\n` +
		`  pi-wire : ws://127.0.0.1:${PORT}   (desktop app discovers it via ~/.accordion)\n` +
		`  control : http://localhost:${CONTROL_PORT}   ← open this in a browser\n` +
		`  TPS=${tps}  CW=${CW}  GROW=${GROW ? 1 : 0}`,
);
