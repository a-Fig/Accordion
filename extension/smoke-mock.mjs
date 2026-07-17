/*
 * smoke-mock.mjs — verify extension/mock-server.mjs speaks the CURRENT wire protocol end to end.
 *
 * mock-server.mjs is a repo-only dev tool (not an npm artifact — see extension/package.json's
 * `files`), so this script is deliberately NOT wired into package.json's smoke/prepack chain. Run
 * directly:
 *
 *   node smoke-mock.mjs
 *
 * Spawns the mock as a real child process — exactly how `launch_mock_session` in
 * app/src-tauri/src/lib.rs launches it — then drives it as a real WS client and checks:
 *   • hello.protocolVersion matches the LIVE core/protocol.ts PROTOCOL_VERSION (imported here too,
 *     never hardcoded — this assertion would fail loudly the day the two ever drift)
 *   • the snapshot hydrates via core/replica.ts's hydrateSnapshot into a rev-aligned replica Truth
 *   • every subsequent `event` replays onto that replica with its rev staying in lockstep
 *   • a `fold` command round-trips: the host echoes an "ops" event AND a commandResult, and the
 *     replica shows the block folded after replaying
 */
import { createJiti } from "jiti";
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const { PROTOCOL_VERSION } = await jiti.import("../core/protocol.ts");
const { hydrateSnapshot, applyWireEvent } = await jiti.import("../core/replica.ts");

const HOME = path.join(os.tmpdir(), `accordion-mock-smoke-${process.pid}`);
const PORT = 39000 + (process.pid % 900);
const CONTROL_PORT = PORT + 1;
const SESSIONS_DIR = path.join(HOME, ".accordion", "sessions");

const fails = [];
const child = spawn(
	process.execPath,
	[path.join(__dirname, "mock-server.mjs")],
	{
		env: { ...process.env, ACCORDION_HOME: HOME, PORT: String(PORT), CONTROL_PORT: String(CONTROL_PORT), TPS: "100000", GROW: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	},
);
let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += d.toString()));
child.stderr.on("data", (d) => (stderr += d.toString()));

async function waitFor(predicate, ms, label) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`timed out waiting for ${label}`);
}

// The registry entry appears the instant the mock's module body runs (writeEntry() is called
// before the WS server's async `listen()` resolves) — a real client only ever dials after polling
// discovery on a ~1s cadence, but this script dials immediately, so retry through the (sub-100ms)
// window where the socket isn't accepting connections yet.
function connectWs(url, { tries = 60, delayMs = 50 } = {}) {
	return new Promise((resolve, reject) => {
		let attempt = 0;
		const tryOnce = () => {
			attempt++;
			const sock = new WebSocket(url);
			const onError = () => {
				sock.removeAllListeners();
				if (attempt >= tries) {
					reject(new Error(`could not connect to ${url} after ${tries} attempts`));
					return;
				}
				setTimeout(tryOnce, delayMs);
			};
			sock.once("open", () => {
				sock.removeListener("error", onError);
				resolve(sock);
			});
			sock.once("error", onError);
		};
		tryOnce();
	});
}

function finish() {
	try {
		child.kill("SIGTERM");
	} catch {
		/* already gone */
	}
	try {
		fs.rmSync(HOME, { recursive: true, force: true });
	} catch {
		/* best-effort cleanup */
	}
	if (fails.length) {
		console.error("FAILS:\n" + fails.map((f) => " - " + f).join("\n"));
		console.error("\n--- child stdout ---\n" + stdout);
		console.error("--- child stderr ---\n" + stderr);
		process.exitCode = 1;
	} else {
		console.log("smoke-mock: OK — hello/snapshot/replica hydrate, event replay stays rev-aligned, fold command round-trips (event + commandResult).");
	}
}

try {
	// The mock writes its registry entry synchronously at startup (before opening the WS server in
	// practice it's the reverse, but this is a reliable "the process is alive and has run its
	// startup path" signal, same pattern smoke.mjs uses for the real extension).
	await waitFor(() => fs.existsSync(SESSIONS_DIR) && fs.readdirSync(SESSIONS_DIR).some((f) => f.endsWith(".json")), 8000, "registry entry");

	const ws = await connectWs(`ws://127.0.0.1:${PORT}`);
	const inbox = { hello: [], snapshot: [], event: [], commandResult: [], telemetry: [] };
	let replica = null;
	let foldableBlock = null;
	ws.on("message", (d) => {
		let m;
		try {
			m = JSON.parse(d.toString());
		} catch {
			return;
		}
		(inbox[m.type] ||= []).push(m);
		if (m.type === "event" && replica) {
			applyWireEvent(replica, m.event);
			if (replica.rev !== m.event.rev) fails.push(`replica rev ${replica.rev} !== event rev ${m.event.rev} after replaying a "${m.event.kind}" event`);
			if (m.event.kind === "appended" && !foldableBlock) {
				foldableBlock = m.event.blocks.find((b) => b.kind === "text" || b.kind === "thinking" || b.kind === "tool_result") ?? null;
			}
		}
	});

	await waitFor(() => inbox.hello.length > 0, 3000, "hello");
	await waitFor(() => inbox.snapshot.length > 0, 3000, "snapshot");

	const hello = inbox.hello[0];
	if (hello.protocolVersion !== PROTOCOL_VERSION) fails.push(`hello.protocolVersion expected ${PROTOCOL_VERSION}, got ${hello.protocolVersion}`);
	if (hello.role !== "gui") fails.push(`hello.role expected "gui", got ${hello.role}`);
	if (hello.conductors !== undefined && hello.conductors.length !== 0) fails.push(`hello.conductors expected empty/absent, got ${JSON.stringify(hello.conductors)}`);

	const snap = inbox.snapshot[0];
	replica = hydrateSnapshot({ format: "pi", title: hello.meta.title, cwd: hello.meta.cwd, model: hello.meta.model }, snap.state);
	if (replica.rev !== snap.state.rev) fails.push(`hydrated replica rev ${replica.rev} !== snapshot rev ${snap.state.rev}`);
	if (snap.state.wireAttached !== true) fails.push("snapshot.wireAttached should be true for a simulated live pi session");
	if (snap.state.foldingEnabled !== false) fails.push("snapshot.foldingEnabled should default to false");

	// A freshly-streamed block sits inside the protected working tail (default protectTokens =
	// 20_000) — a human fold is REFUSED there by design (Truth.canFold), same as the real live
	// session. Drop the tail to 0 first so the fold below exercises the actual clamp-free path
	// rather than tripping the (correct, unrelated) protected-tail invariant.
	let seq = 0;
	ws.send(JSON.stringify({ type: "command", seq: ++seq, cmd: { kind: "setProtect", value: 0 } }));
	await waitFor(() => replica.protectTokens === 0, 3000, "protectTokens to drop to 0");

	// Play the mock (it starts paused) via the control channel so genLoop actually appends blocks.
	const controlWs = await connectWs(`ws://127.0.0.1:${CONTROL_PORT}/ws`);
	controlWs.send(JSON.stringify({ cmd: "play" }));

	await waitFor(() => foldableBlock !== null, 8000, "a foldable appended block");

	const foldSeq = ++seq;
	ws.send(JSON.stringify({ type: "command", seq: foldSeq, cmd: { kind: "ops", ops: [{ kind: "fold", ids: [foldableBlock.id] }] } }));
	await waitFor(() => inbox.commandResult.some((r) => r.seq === foldSeq), 3000, "commandResult for the fold");

	const cr = inbox.commandResult.find((r) => r.seq === foldSeq);
	if (!cr.results?.[0]?.applied) fails.push(`fold command was not applied (results: ${JSON.stringify(cr.results)})`);

	const foldEventSeen = inbox.event.some(
		(e) => e.event.kind === "ops" && e.event.ops.some((o) => o.kind === "fold" && o.ids?.includes(foldableBlock.id)),
	);
	if (!foldEventSeen) fails.push('no echoed "ops" event carried the fold for the folded block');

	const rb = replica.get(foldableBlock.id);
	if (!rb) fails.push(`replica lost track of block ${foldableBlock.id} after replay`);
	else if (!replica.isFolded(rb)) fails.push(`replica does not show block ${foldableBlock.id} as folded after replaying the fold`);

	// resnapshot round trip.
	const snapshotsBefore = inbox.snapshot.length;
	ws.send(JSON.stringify({ type: "resnapshot" }));
	await waitFor(() => inbox.snapshot.length > snapshotsBefore, 3000, "a fresh snapshot after resnapshot");

	ws.close();
	controlWs.close();
	finish();
} catch (err) {
	fails.push(String(err?.stack || err));
	finish();
}
