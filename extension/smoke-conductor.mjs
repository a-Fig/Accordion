/*
 * smoke-conductor.mjs — the REAL out-of-process conductor spawn e2e (Phase C).
 *
 * Sibling to smoke.mjs, driven the same way (mock pi hooks + a real WS GUI client), but exercising
 * the one path smoke.mjs does not: a SPAWN conductor. It drives the actual runner spawn — the
 * extension launches `node conductors/thermocline/runner.mjs`, which imports the committed
 * remote-sdk.mjs bundle, dials the session's loopback WS as `role=conductor`, mirrors the live Truth,
 * and drives the real ThermoclineConductor. No part of the spawn/attach/propose path is faked.
 *
 * Scenario:
 *   1. Boot the extension, feed a small live history, connect a GUI client.
 *   2. hello advertises thermocline with remote:true (its runner resolves on disk).
 *   3. Pour a large over-budget synthetic history into the Truth (tiny budget → deep aged region).
 *   4. selectConductor thermocline → REAL child spawn; conductorState broadcasts remote:true.
 *   5. Fire context hooks (turnCommitted/wireDeparting reach the child) until the child — attached
 *      over the real socket, holding its snapshot — proposes real age-based GROUP ops (strata) that
 *      land in Truth. The Python probe is forced absent, so the strategy degrades to its age-based
 *      fallback (deterministic, no LLM) — verified by its actual grouping behavior, not by faking.
 *      (P1-6: the extension now fires an initial turnCommitted the instant the child attaches, so the
 *      first pass runs without waiting for a real turn — strata typically land on the very first hook.)
 *   6. wireDeparting holds release promptly via the v14 `holdRelease { holdId }` message (sent when
 *      the child's wire-departing handler settles) — hold telemetry stays sane (0 timeouts).
 *   7. selectConductor null → the child is killed, locks clear, and the freeze kill-switch preserves
 *      the strata as human-owned groups.
 *
 * The probe is made genuinely unavailable (ATTN_PROBE_PYTHON → a nonexistent binary) so the spawn
 * fails fast and the age-based fallback is what carries the strategy — a real degradation, not a stub.
 *
 * Run: node smoke-conductor.mjs   (also chained after smoke.mjs in the `smoke` npm script)
 */
import { createJiti } from "jiti";
import { WebSocket } from "ws";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOME = path.join(os.tmpdir(), `accordion-smoke-conductor-${process.pid}`);
process.env.ACCORDION_HOME = HOME;
process.env.ACCORDION_APP_PATH = path.join(HOME, "missing-accordion-app.exe");
// Force the attention probe to be genuinely unavailable: the runner's scorer will spawn this,
// fail instantly (ENOENT), reject, and the strategy degrades to its age-based fallback. This is a
// real absent-probe path, not a faked spawn — the runner, its attach, and its proposes are all real.
process.env.ATTN_PROBE_PYTHON = path.join(HOME, "no-such-python-binary");

const SESSIONS_DIR = path.join(HOME, ".accordion", "sessions");
const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./accordion.ts");
const accordionLive = mod.default;
if (typeof accordionLive !== "function") throw new Error("default export is not a function");

const fails = [];
async function waitFor(predicate, ms, label) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`timed out waiting for ${label}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mock pi (mirrors smoke.mjs) ────────────────────────────────────────────────
const handlers = {};
const flags = new Map();
const pi = {
	on: (name, fn) => (handlers[name] = fn),
	registerFlag: (name, def) => flags.set(name, def?.default),
	getFlag: (name) => flags.get(name),
	registerCommand: () => {},
	registerTool: () => {},
	appendEntry: () => {},
};
accordionLive(pi);
const ctx = {
	ui: { setStatus() {}, notify() {}, theme: { fg: (_c, s) => s } },
	model: { id: "test/model", contextWindow: 200_000 },
	getContextUsage: () => ({ tokens: 0, contextWindow: 200_000 }),
};
handlers.session_start({}, ctx);

await waitFor(() => fs.existsSync(SESSIONS_DIR) && fs.readdirSync(SESSIONS_DIR).some((f) => f.endsWith(".json")), 3000, "registry entry");
const entryFile = fs.readdirSync(SESSIONS_DIR).find((f) => f.endsWith(".json"));
const entry = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, entryFile), "utf8"));
const PORT = entry.port;
if (!(PORT > 0)) fails.push(`no ephemeral port assigned (${PORT})`);

// ── build a large, over-budget synthetic history of tool_call/tool_result PAIRS ──
// Pairs are the shape that forces L3 STRATA (age-based group ops): a tool_result run can only be
// compressed by grouping it (thermocline's own probe-absent test uses exactly this — `pairs(8)` →
// `groups.length >= 1`). Text turns would instead compress via individual `replace` folds, never
// exercising the group/strata path this e2e is here to prove.
const T0 = Date.now();
const PAIRS = 12;
const BIG = (i) => `tool output ${i}: ` + `result line ${i} `.repeat(1400); // ~ big result body
const messages = [];
for (let i = 0; i < PAIRS; i++) {
	messages.push({ role: "assistant", content: [{ type: "toolCall", id: `call-${i}`, name: "shell", arguments: {} }], responseId: `resp-${i}`, timestamp: T0 + i * 2 });
	messages.push({ role: "toolResult", toolCallId: `call-${i}`, toolName: "shell", content: BIG(i), isError: false, timestamp: T0 + i * 2 + 1 });
}

// Prime the Truth (no client yet, folding off → passthrough) so the first client snapshots history.
await Promise.resolve(handlers.context({ messages }, ctx));

// ── GUI client ──────────────────────────────────────────────────────────────────
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const inbox = { hello: [], snapshot: [], event: [], conductorState: [], conductorStatus: [], telemetry: [] };
ws.on("message", (d) => {
	let m;
	try { m = JSON.parse(d.toString()); } catch { return; }
	(inbox[m.type] ||= []).push(m);
});
let seq = 0;
const sendCmd = (cmd) => ws.send(JSON.stringify({ type: "command", seq: ++seq, cmd }));
const resnapshot = () => ws.send(JSON.stringify({ type: "resnapshot" }));

await waitFor(() => inbox.hello.length > 0, 3000, "gui hello").catch(() => fails.push("GUI never received hello"));
await waitFor(() => inbox.snapshot.length > 0, 3000, "gui snapshot").catch(() => fails.push("GUI never received a snapshot"));

// (2) hello advertises thermocline as a REMOTE (spawn) conductor.
{
	const hello = inbox.hello[0];
	const thermo = hello?.conductors?.find((c) => c.id === "thermocline");
	if (!thermo) fails.push(`hello did not advertise thermocline (got ${JSON.stringify(hello?.conductors?.map((c) => c.id))})`);
	else if (thermo.remote !== true) fails.push(`thermocline was not advertised as remote:true (got ${JSON.stringify(thermo)})`);
}

// (3) small protected tail + a budget far below the raw size → a deep aged region the strategy must
//     compress (mirrors thermocline's own probe-absent test: budget 30k, protect 300, pairs).
sendCmd({ kind: "setProtect", value: 300 });
sendCmd({ kind: "setBudget", value: 30000 });
sendCmd({ kind: "setFolding", value: true });
await sleep(150);

// (4) select thermocline → REAL spawn. conductorState broadcasts remote:true.
inbox.conductorState.length = 0;
sendCmd({ kind: "selectConductor", id: "thermocline" });
await waitFor(() => inbox.conductorState.some((m) => m.active?.id === "thermocline"), 3000, "thermocline conductorState").catch(
	() => fails.push("selectConductor(thermocline) did not broadcast a conductorState"),
);
{
	const cs = inbox.conductorState.find((m) => m.active?.id === "thermocline");
	if (cs && cs.active.remote !== true) fails.push(`thermocline conductorState.active.remote expected true (got ${JSON.stringify(cs.active)})`);
}

// (5) Drive context hooks until the REAL child — spawned, connected over the socket, holding its
//     snapshot — proposes age-based GROUP ops (strata) that land in Truth. Each hook fires
//     wireDeparting (a bounded hold) + turnCommitted to the child. The child needs a moment to spawn,
//     import the bundle, connect, and handshake, so we pump several hooks.
const seenGroupOp = () =>
	inbox.event.some((e) => e.event?.kind === "ops" && e.event.by === "auto" && (e.event.ops || []).some((o) => o.kind === "group"));
let pumped = 0;
const pumpDeadline = Date.now() + 15000;
while (Date.now() < pumpDeadline && !seenGroupOp()) {
	pumped++;
	// Each hook fires wireDeparting (bounded hold) + turnCommitted at the child; once the child has
	// spawned + connected + hydrated its snapshot, one of these ticks it into its emergency epoch.
	await Promise.resolve(handlers.context({ messages }, ctx));
	await sleep(400);
}
if (!seenGroupOp()) fails.push("the spawned thermocline runner never proposed a group op that landed in Truth");

// verify the strata are really in Truth (resnapshot the GUI replica and read groups).
let landedGroups = 0;
{
	inbox.snapshot.length = 0;
	resnapshot();
	await waitFor(() => inbox.snapshot.length > 0, 3000, "post-propose resnapshot").catch(() => fails.push("no resnapshot after conductor proposed"));
	const snap = inbox.snapshot.at(-1);
	const groups = snap?.state?.groups || [];
	landedGroups = groups.length;
	if (landedGroups < 1) fails.push("no groups (strata) landed in Truth after the conductor proposed");
	else if (!groups.every((g) => g.by === "auto")) fails.push(`a landed stratum was not authored by the conductor (by!=="auto"): ${JSON.stringify(groups.map((g) => g.by))}`);
}

// (5b) SECURITY (finding 1): a GUI `ops` command carrying a host-only `freeze` must NOT seize the
// conductor's strata while it holds human-steering. `freeze` is the detach-only kill switch —
// intentionally ungated in opFreeze — so it is stripped at the wire entry and reported as a `locked`
// clamp; the strata stay conductor-owned (by:"auto") until the REAL detach freeze runs in step (7).
if (landedGroups >= 1) {
	inbox.commandResult = [];
	sendCmd({ kind: "ops", ops: [{ kind: "freeze" }] });
	const freezeSeq = seq;
	await waitFor(() => (inbox.commandResult || []).some((m) => m.seq === freezeSeq), 3000, "freeze commandResult").catch(
		() => fails.push("GUI freeze command received no commandResult"),
	);
	const cr = (inbox.commandResult || []).find((m) => m.seq === freezeSeq);
	const frozenOp = cr?.results?.find((r) => r.op?.kind === "freeze");
	if (!frozenOp) fails.push("GUI freeze: no per-op result for the freeze op in the commandResult");
	else if (frozenOp.applied !== false || frozenOp.clamped !== "locked")
		fails.push(`GUI freeze was not clamped locked at the wire entry (got ${JSON.stringify(frozenOp)})`);
	// The strata must still be conductor-owned — the freeze did not transfer ownership to the human.
	inbox.snapshot.length = 0;
	resnapshot();
	await waitFor(() => inbox.snapshot.length > 0, 3000, "post-freeze resnapshot").catch(() => fails.push("no resnapshot after GUI freeze"));
	const afterFreeze = inbox.snapshot.at(-1)?.state?.groups || [];
	if (afterFreeze.some((g) => g.by !== "auto")) fails.push(`a GUI freeze seized a conductor stratum (by !== "auto"): ${JSON.stringify(afterFreeze.map((g) => g.by))}`);
}

// (6) hold telemetry sane: the child releases each wire-departing hold via the v14 dedicated
//     `holdRelease { holdId }` message — sent the instant its wire-departing handler settles (whether
//     that handler ran a real emergency propose or did nothing) — so timeouts stay at zero and the
//     last hold is well under the 200ms window. A propose NO LONGER releases the hold, so a background
//     tick's propose can't race it. The hold counters ride the streamed `telemetry` WS frame
//     (alongside the hook duration) — see accordion.ts broadcastTelemetry.
let holdTimeouts = null, lastHoldMs = null;
{
	// nudge one more hook so a fresh telemetry frame reflects the settled (post-strata) state.
	await Promise.resolve(handlers.context({ messages }, ctx));
	await waitFor(() => inbox.telemetry.length > 0, 2000, "telemetry frame").catch(() => fails.push("no telemetry frame streamed"));
	const tel = inbox.telemetry.at(-1);
	holdTimeouts = tel?.holdTimeouts;
	lastHoldMs = tel?.lastHoldMs;
	if (typeof holdTimeouts !== "number" || holdTimeouts !== 0) fails.push(`wire-departing hold timed out (holdTimeouts=${holdTimeouts}) — holdRelease should end each hold promptly`);
	if (typeof lastHoldMs !== "number" || lastHoldMs > 200) fails.push(`last wire-departing hold exceeded the 200ms window (lastHoldMs=${lastHoldMs})`);
}

// (7) detach → the child is killed, locks clear, and the freeze kill-switch preserves the strata as
//     human-owned groups (the deep zone survives detach).
inbox.conductorState.length = 0;
inbox.event.length = 0;
sendCmd({ kind: "selectConductor", id: null });
await waitFor(() => inbox.conductorState.some((m) => m.active === null), 3000, "thermocline detach").catch(
	() => fails.push("selectConductor(null) did not detach the spawned conductor"),
);
await waitFor(() => inbox.event.some((e) => e.event?.kind === "locks" && (e.event.locks || []).length === 0), 3000, "locks cleared on detach").catch(
	() => fails.push("detaching thermocline did not clear its locks"),
);
{
	// freeze: the strata survive as human-owned groups.
	inbox.snapshot.length = 0;
	resnapshot();
	await waitFor(() => inbox.snapshot.length > 0, 3000, "post-detach resnapshot").catch(() => fails.push("no resnapshot after detach"));
	const snap = inbox.snapshot.at(-1);
	const groups = snap?.state?.groups || [];
	if (groups.length < landedGroups) fails.push(`freeze did not preserve the strata across detach (before=${landedGroups}, after=${groups.length})`);
	if (groups.some((g) => g.by === "auto")) fails.push("after detach a stratum is still conductor-owned (freeze should transfer ownership to the human)");
}

console.log(`  spawn e2e: pumped ${pumped} hooks · strata landed=${landedGroups} · holdTimeouts=${holdTimeouts} · lastHoldMs=${lastHoldMs}ms (window 200ms)`);

// ── teardown ────────────────────────────────────────────────────────────────────
try { ws.close(); } catch { /* ignore */ }
await sleep(50);
handlers.session_shutdown({}, ctx); // also SIGTERM/SIGKILLs any surviving child
await sleep(200);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }

if (fails.length) {
	console.error(`\nSMOKE-CONDUCTOR FAILED (${fails.length}):`);
	for (const f of fails) console.error(`  ✗ ${f}`);
	process.exit(1);
}
console.log("\nsmoke-conductor: OK — real thermocline spawn → attach over the socket → age-based strata proposed into Truth → prompt holds → clean kill + freeze-preserved deep zone.");
