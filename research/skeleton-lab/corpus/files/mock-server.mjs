/*
 * mock-server.mjs — a fake pi session for testing the live link + folding, driven from a browser.
 *
 * Tricks the Accordion DESKTOP app into thinking it's attached to a live pi session, and gives you
 * a browser control panel to play/pause/restart it and change its speed. The only fake thing is the
 * agent on the far end — this hosts a REAL `core/truth.ts` `Truth` instance and speaks the REAL
 * current wire protocol (`core/protocol.ts`), so the app's folding, groups, budget/protect dials,
 * and telemetry all run for real against a genuinely evolving Truth.
 *
 * Every module that carries protocol/session-state logic is loaded live via `jiti` — `Truth`,
 * `serializeSnapshot`/`hydrateSnapshot`/`wireEventFromTruthEvent`, `PROTOCOL_VERSION`, the registry
 * constants — straight from `core/` and `app/src/lib/live/`. Nothing is hard-coded or bundled, so
 * this file can never silently drift from a live protocol version bump: it always tracks whatever
 * `core/protocol.ts` currently exports.
 *
 * Deliberately NOT ported: conductor spawning. `hello.conductors` is omitted (the GUI's conductor
 * menu self-gates on an empty/absent catalog — see `ConductorMenu.svelte`), and every connection is
 * treated as role `"gui"`; a `?role=conductor` dial gets the same GUI treatment (there is nothing to
 * attach it to). `propose` / `completeRequest` / `setConductorStatus` are accepted but ignored.
 *
 * Three faces on one process:
 *   1. pi-wire WebSocket (PORT)        — what Accordion connects to. Speaks hello/snapshot/event/
 *      telemetry/commandResult/folding/stream (server→client) and command/resnapshot (client→server).
 *   2. registry advertisement          — writes ~/.accordion/sessions/<id>.json with a
 *      heartbeat so the DESKTOP app discovers it in the sidebar (the desktop build has
 *      no manual-port box; discovery is the only door). Deleted on shutdown.
 *   3. control HTTP + WS (CONTROL_PORT) — serves control.html and a command channel so a
 *      browser tab can play/pause/restart and slide TPS live.
 *
 * One shared generation clock drives every connected app. Folding lives in the app's/host's Truth
 * (substitution, not removal), so a connected GUI's own fold/group/pin actions round-trip for real
 * through this Truth exactly as they would through the extension.
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
 *   GROW=1             1 = context grows across loops; 0 = reset (fresh Truth) each loop
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
// The app's source imports core via the `$core` alias (svelte/vite/vitest all resolve it); jiti
// knows nothing about kit aliases, so mirror it here — otherwise loading any app module that
// touches `$core/*` (parse.ts → $core/tokens) dies with MODULE_NOT_FOUND.
const jiti = createJiti(import.meta.url, { alias: { $core: path.join(__dirname, "../core") } });

// Load the REAL protocol/Truth modules so this mock can never silently desync from a version bump
// (the rot that killed the previous mock: it spoke a hard-coded pre-v13 shape). Straight from
// `core/` — the same modules the extension (`accordion.ts`) itself imports.
const { Truth } = await jiti.import("../core/truth.ts");
const { serializeSnapshot, wireEventFromTruthEvent, hydrateSnapshot } = await jiti.import("../core/replica.ts");
const { PROTOCOL_VERSION, DEFAULT_PORT } = await jiti.import("../core/protocol.ts");
const { isDurableId } = await jiti.import("../core/wire.ts");
const { applyGuardingHostOnly } = await jiti.import("../core/ops.ts");
const { parse } = await jiti.import("../app/src/lib/engine/parse.ts");
const { REGISTRY_PROTOCOL, REGISTRY_DIR, SESSIONS_SUBDIR, FOCUS_FILE, HEARTBEAT_INTERVAL_MS } = await jiti.import(
	"../app/src/lib/live/registry.ts",
);

// ── config ───────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || DEFAULT_PORT);
const CONTROL_PORT = Number(process.env.CONTROL_PORT || PORT + 1);
const CW = Number(process.env.CW || 60_000);
const GROW = process.env.GROW !== "0";
const SAMPLE = process.env.SAMPLE || path.join(__dirname, "../app/static/sample-session.jsonl");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GENERATED = new Set(["thinking", "text", "tool_call"]); // typed by the model; the rest commit instantly

// ── load the recorded session into re-usable seed blocks ───────────────────────
// parse() reads the JSONL correctly but emits engine ids ("<eid>:u", "<eid>:r", "<eid>:<part>").
// The Truth's live-wire fold guard (isDurableId) only accepts the prefix form (u:/a:/r:/s:). So
// prefix by kind, keeping the original id as the unique tail.
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

// Project a seed engine Block → a fresh engine Block for loop N, ready for `Truth.append`. Ids and
// callIds are made unique per loop while preserving the durable prefix and the call/result pairing
// (both halves get the same #L<loop> callId suffix). turn/order offset so growth stays monotonic.
// override/autoFolded/by/subst reset to a fresh (never-touched) overlay — this is a NEW block, not
// a replay of one the Truth has seen before.
function toBlock(b, loop, turnSpan, orderSpan) {
	return {
		id: `${kindPrefix(b.kind)}:L${loop}:${b.id}`,
		kind: b.kind,
		turn: b.turn + loop * turnSpan,
		order: b.order + loop * orderSpan,
		text: b.text,
		tokens: b.tokens,
		toolName: b.toolName,
		callId: b.callId != null ? `${b.callId}#L${loop}` : undefined,
		model: b.model,
		isError: b.isError,
		override: null,
		autoFolded: false,
		by: null,
		subst: undefined,
	};
}

const { meta, blocks, turnSpan, orderSpan } = loadBaseBlocks();

// ── selftest: validate the pipeline without opening a socket ───────────────────
if (process.argv.includes("--selftest")) {
	const hist = {};
	for (const b of blocks) hist[b.kind] = (hist[b.kind] || 0) + 1;
	const loopBlocks = blocks.map((b) => toBlock(b, 0, turnSpan, orderSpan));
	const foldable = loopBlocks.filter((b) => b.kind === "thinking" || b.kind === "text" || b.kind === "tool_result");
	const allFoldableDurable = foldable.every((b) => isDurableId(b.id));
	const totalTokens = loopBlocks.reduce((s, b) => s + b.tokens, 0);
	const callIds = new Set(loopBlocks.filter((b) => b.kind === "tool_call").map((b) => b.callId));
	const orphanResults = loopBlocks.filter((b) => b.kind === "tool_result" && b.callId && !callIds.has(b.callId)).length;

	// Exercise the real Truth + snapshot/replica round trip (no sockets) — proves the actual
	// protocol pipeline this server drives at runtime, not just the seed-block shape.
	const t = new Truth({ meta: { format: "pi", title: meta.title || "", cwd: meta.cwd || "", model: meta.model || "" }, blocks: [], lineCount: 0, skipped: 0 });
	t.wireAttached = true;
	t.setContextWindow(CW);
	t.setBudget(CW);
	const revBefore = t.rev;
	t.append(loopBlocks);
	const revAfterAppend = t.rev;
	const snap = serializeSnapshot(t, false);
	const rebuilt = hydrateSnapshot(t.meta, snap);
	const roundTrips = rebuilt.rev === t.rev && rebuilt.blocks.length === t.blocks.length;

	console.log("title:", meta.title, "| model:", meta.model);
	console.log("blocks:", blocks.length, "| kinds:", JSON.stringify(hist));
	console.log("turnSpan:", turnSpan, "| total tokens:", totalTokens);
	console.log("protocol version:", PROTOCOL_VERSION);
	console.log("first ids:", loopBlocks.slice(0, 5).map((b) => b.id));
	console.log("all foldable ids durable:", allFoldableDurable);
	console.log("orphan tool_results (want 0):", orphanResults);
	console.log("truth rev progressed on append:", revBefore, "->", revAfterAppend);
	console.log("snapshot/hydrate round-trips:", roundTrips);
	if (!allFoldableDurable || orphanResults > 0 || revAfterAppend <= revBefore || !roundTrips) {
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
const startedAt = Date.now();

const apps = new Set(); // pi-wire clients (Accordion) currently attached
const controls = new Set(); // browser control clients
const sessionId = "fake-" + process.pid;
const send = (ws, obj) => {
	try {
		ws.send(JSON.stringify(obj));
	} catch {
		/* socket gone */
	}
};
function broadcastApps(obj) {
	const s = JSON.stringify(obj);
	for (const ws of apps) {
		if (ws.readyState !== 1 /* OPEN */) continue;
		try {
			ws.send(s);
		} catch {
			/* gone */
		}
	}
}

// ── the authoritative (fake) Truth ──────────────────────────────────────────────
// Mirrors accordion.ts's `buildTruth`: dials (wireAttached/contextWindow/budget) are set BEFORE
// subscribing so those internal bumps never ride a stray broadcast event, only the snapshot a
// (re)connecting client gets. `foldingEnabled` is host-side (not a Truth field), same as the
// extension — toggled by a GUI `setFolding` command, broadcast + carried in every snapshot.
let truth = null;
let unsubTruth = null;
let foldingEnabled = false;

function metaForTruth() {
	return { format: "pi", title: meta.title || "FAKE pi session", cwd: meta.cwd || "fake://sample", model: meta.model || "fake-model" };
}
function metaWire() {
	return { ...metaForTruth(), contextWindow: CW };
}
function setFolding(on) {
	if (foldingEnabled === on) return;
	foldingEnabled = on;
	broadcastApps({ type: "folding", enabled: foldingEnabled });
}
function buildTruth() {
	if (unsubTruth) {
		unsubTruth();
		unsubTruth = null;
	}
	const t = new Truth({ meta: metaForTruth(), blocks: [], lineCount: 0, skipped: 0 });
	t.wireAttached = true; // simulate a live pi wire (durability-aware group accounting)
	t.setContextWindow(CW);
	t.setBudget(CW);
	unsubTruth = t.onEvent((e) => {
		const ev = wireEventFromTruthEvent(e);
		if (ev) broadcastApps({ type: "event", event: ev });
	});
	truth = t;
}
buildTruth();

function applyCommand(cmd) {
	if (!truth) return { results: [], rev: 0 };
	switch (cmd.kind) {
		case "ops": {
			const r = applyGuardingHostOnly(Array.isArray(cmd.ops) ? cmd.ops : [], (allowed) => truth.apply(allowed, "you"));
			return { results: r.results, rev: r.rev };
		}
		case "setBudget":
			truth.setBudget(cmd.value);
			return { results: [], rev: truth.rev };
		case "setProtect":
			truth.setProtect(cmd.value);
			return { results: [], rev: truth.rev };
		case "setFolding":
			setFolding(!!cmd.value);
			return { results: [], rev: truth.rev };
		case "selectConductor":
			// The advertised catalog is empty — nothing to attach. A polite no-op; in practice the
			// GUI's conductor menu never even sends this (it self-gates on the empty catalog).
			return { results: [], rev: truth.rev };
		default:
			return { results: [], rev: truth.rev };
	}
}

function statusObj() {
	const cur = blocks[idx];
	return {
		type: "status",
		playing,
		tps,
		loop,
		grow: GROW,
		turn: cur ? cur.turn + loop * turnSpan : 0,
		blocksStreamed: truth.blocks.length,
		totalTokens: truth.fullTokens(),
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

function emitBlock(block) {
	truth.append([block]);
}

// Restart: rewind to the top with a BRAND NEW Truth (mirrors a structural-divergence rebuild) and
// force every connected client to resnapshot — a fresh `snapshot` message fully rehydrates a
// replica, so there is no bespoke "full sync" message needed on top of the real protocol.
function doRestart() {
	epoch++;
	loop = 0;
	idx = 0;
	buildTruth();
	broadcastApps({ type: "snapshot", state: serializeSnapshot(truth, foldingEnabled) });
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
		const block = toBlock(blocks[idx], loop, turnSpan, orderSpan);

		if (GENERATED.has(block.kind)) {
			broadcastApps({ type: "stream", phase: "start", kind: block.kind, contentIndex: idx });
			const ok = await pacedWait(block.tokens, myEpoch);
			broadcastApps({ type: "stream", phase: "abort", kind: block.kind, contentIndex: -1 }); // sweep any ghost
			if (!ok) continue; // paused or restarted mid-gen → re-gen this block (or top) later
			emitBlock(block);
		} else {
			if (epoch !== myEpoch) continue;
			emitBlock(block); // tool_result / user commit instantly
			await sleep(10);
		}

		idx++;
		if (idx >= blocks.length) {
			idx = 0;
			loop++;
			if (!GROW) {
				// reset each loop: fresh Truth + forced resnapshot, same shape as a Restart.
				epoch++;
				buildTruth();
				broadcastApps({ type: "snapshot", state: serializeSnapshot(truth, foldingEnabled) });
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
		tokens: truth ? truth.fullTokens() : null,
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
// Loopback-only bind, no token/origin gating — same story the previous mock had. This is a
// same-machine dev tool, never the real extension's WS surface (that hardening lives in
// accordion.ts and is untouched here).
const piWss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
piWss.on("connection", (ws) => {
	apps.add(ws);
	console.log(`Accordion connected (${apps.size} attached)`);
	// Every connection is treated as role "gui" — this mock never spawns a conductor, so a
	// `?role=conductor` dial would have nothing to attach to. `conductors` is omitted from hello;
	// the GUI's conductor menu self-gates on an empty/absent catalog.
	send(ws, { type: "hello", protocolVersion: PROTOCOL_VERSION, sessionId, role: "gui", meta: metaWire() });
	send(ws, { type: "snapshot", state: serializeSnapshot(truth, foldingEnabled) });
	// Seed the client's latency badge immediately (this mock never runs a real `context` hook, so
	// every field but the shape itself stays 0 — the protocol only requires the shape).
	send(ws, { type: "telemetry", lastHookMs: 0, maxHookMs: 0, p95HookMs: 0, rebuilds: 0, hookCount: 0, lastHoldMs: 0, holdTimeouts: 0 });
	pushStatus();

	ws.on("message", (d) => {
		let m;
		try {
			m = JSON.parse(d.toString());
		} catch {
			return;
		}
		if (m?.type === "command" && typeof m.seq === "number" && m.cmd && typeof m.cmd === "object") {
			const { results, rev } = applyCommand(m.cmd);
			send(ws, { type: "commandResult", seq: m.seq, results, rev });
		} else if (m?.type === "resnapshot") {
			send(ws, { type: "snapshot", state: serializeSnapshot(truth, foldingEnabled) });
		}
		// propose / completeRequest / setConductorStatus: no conductor ever attaches here — ignored.
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
// Periodic telemetry so a connected app's LATENCY badge stays populated rather than going stale
// after the connect-time seed. This mock never runs a real `context` hook, so every field but the
// shape stays 0 — the protocol only requires the shape.
setInterval(() => {
	if (apps.size) broadcastApps({ type: "telemetry", lastHookMs: 0, maxHookMs: 0, p95HookMs: 0, rebuilds: 0, hookCount: 0, lastHoldMs: 0, holdTimeouts: 0 });
}, 2000);

void genLoop();

console.log(
	`fake pi ready (paused)\n` +
		`  session : "${meta.title}" — ${blocks.length} blocks, advertised as ${sessionId}\n` +
		`  protocol: v${PROTOCOL_VERSION} (core/protocol.ts, loaded live via jiti)\n` +
		`  pi-wire : ws://127.0.0.1:${PORT}   (desktop app discovers it via ~/.accordion)\n` +
		`  control : http://localhost:${CONTROL_PORT}   ← open this in a browser\n` +
		`  TPS=${tps}  CW=${CW}  GROW=${GROW ? 1 : 0}`,
);
