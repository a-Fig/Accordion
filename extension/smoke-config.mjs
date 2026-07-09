/*
 * smoke-config.mjs — Feature B coverage (issue #58): configurable plan timeout,
 * armed (blocking) mode, and defensive env parsing.
 *
 * The timeout/deadline knobs are read ONCE at module init (ACCORDION_PLAN_TIMEOUT_MS /
 * ACCORDION_PLAN_DEADLINE_MS), so each scenario must run in its OWN process with the env
 * pre-set. Whether a request BLOCKS is no longer an env flag — it follows the client's
 * ARMED state over the wire, so the armed scenario's driver sends {type:"armed",armed:true}
 * after connecting. This file is both the orchestrator (no ACCORDION_SMOKE_SCENARIO → spawn a
 * child per scenario) and the driver (ACCORDION_SMOKE_SCENARIO set → run that one scenario
 * in-process and exit 0/1). It complements smoke.mjs, which covers the default-env paths.
 *
 * Run: node smoke-config.mjs
 */
import { spawn } from "node:child_process";
import { createJiti } from "jiti";
import { WebSocket } from "ws";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCENARIO = process.env.ACCORDION_SMOKE_SCENARIO;

// Each scenario: the env it needs at module init + the timing/log expectations.
// `band` is the acceptable elapsed-ms range for the plan wait before fallback — wide
// enough for timer jitter, tight enough to catch a broken parse (NaN → setTimeout fires
// at ~0ms) or the wrong wait being used (steering ignored / custom value dropped).
const SCENARIOS = {
	// Armed (the client declares armed:true over the wire) uses the long DEADLINE (600ms here),
	// logs LOUDLY via console.error, and still falls back to the last known plan. 600ms is
	// unmistakably past the 250 default, so hitting the band proves the deadline (not the short
	// timeout) governed the wait. `arm` tells the driver to send the armed message after connect.
	steering: {
		env: { ACCORDION_PLAN_DEADLINE_MS: "600" },
		arm: true,
		band: [430, 4000],
		wantError: true,
		wantWarn: false,
		wantStaleFold: true,
	},
	// Invalid values must fall back to the 250 default (NOT NaN → immediate fire). Disarmed
	// (no armed message sent), so the short-timeout path logs via console.warn.
	"env-defaults": {
		env: { ACCORDION_PLAN_TIMEOUT_MS: "not-a-number", ACCORDION_PLAN_DEADLINE_MS: "-5" },
		band: [150, 400],
		wantError: false,
		wantWarn: true,
		wantStaleFold: true,
	},
	// A valid custom timeout (120ms) is honored — the band excludes the 250 default.
	"custom-timeout": {
		env: { ACCORDION_PLAN_TIMEOUT_MS: "120" },
		band: [50, 230],
		wantError: false,
		wantWarn: true,
		wantStaleFold: true,
	},
};

// ── orchestrator ─────────────────────────────────────────────────────────────
if (!SCENARIO) {
	const names = Object.keys(SCENARIOS);
	const results = await Promise.all(
		names.map(
			(name) =>
				new Promise((resolve) => {
					const home = path.join(os.tmpdir(), `accordion-cfg-${process.pid}-${name}`);
					const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
						env: {
							...process.env,
							ACCORDION_SMOKE_SCENARIO: name,
							ACCORDION_HOME: home,
							// A missing explicit app path stops the /accordion launcher fallback (unused here).
							ACCORDION_APP_PATH: path.join(home, "missing.exe"),
							...SCENARIOS[name].env,
						},
						stdio: ["ignore", "pipe", "pipe"],
					});
					let out = "";
					child.stdout.on("data", (d) => (out += d.toString()));
					child.stderr.on("data", (d) => (out += d.toString()));
					child.on("close", (code) => resolve({ name, code, out: out.trim() }));
				}),
		),
	);
	let failed = false;
	for (const r of results) {
		const line = r.out.split("\n").filter(Boolean).at(-1) ?? "(no output)";
		if (r.code === 0) {
			console.log(`  ✓ ${r.name}: ${line}`);
		} else {
			failed = true;
			console.error(`  ✗ ${r.name} (exit ${r.code}): ${r.out || "(no output)"}`);
		}
	}
	if (failed) {
		console.error("SMOKE-CONFIG FAIL");
		process.exit(1);
	}
	console.log("SMOKE-CONFIG PASS — armed deadline (armed over the wire) ✓  env defaults (invalid → 250) ✓  custom timeout honored ✓");
	process.exit(0);
}

// ── driver: run exactly one scenario in-process (env already applied by the parent) ──
const spec = SCENARIOS[SCENARIO];
if (!spec) {
	console.error(`unknown scenario: ${SCENARIO}`);
	process.exit(1);
}

const HOME = process.env.ACCORDION_HOME;
const SESSIONS_DIR = path.join(HOME, ".accordion", "sessions");

async function waitFor(predicate, ms, label) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`timed out waiting for ${label}`);
}

// Count (and swallow) the extension's fallback logs so we can assert severity.
let errN = 0;
let warnN = 0;
console.warn = () => warnN++;
console.error = () => errN++;

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./accordion.ts");
const accordionLive = mod.default;

const handlers = {};
const pi = {
	on: (name, fn) => (handlers[name] = fn),
	registerFlag: () => {},
	getFlag: () => undefined,
	registerCommand: () => {},
	registerTool: () => {},
	appendEntry: () => {},
};
accordionLive(pi);
const ctx = {
	ui: { setStatus() {}, notify() {}, theme: { fg: (_c, s) => s } },
	model: { id: "test/model", contextWindow: 1000 },
	getContextUsage: () => ({ tokens: 42, contextWindow: 1000 }),
};
handlers.session_start({}, ctx);

await waitFor(() => fs.existsSync(SESSIONS_DIR) && fs.readdirSync(SESSIONS_DIR).some((f) => f.endsWith(".json")), 3000, "registry entry");
const entry = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, fs.readdirSync(SESSIONS_DIR).find((f) => f.endsWith(".json"))), "utf8"));
const PORT = entry.port;

const T0 = Date.now();
const sample = [
	{ role: "user", content: "do the thing", timestamp: T0 },
	{ role: "assistant", content: [{ type: "text", text: "ORIGINAL" }], responseId: "resp-abc", timestamp: T0 + 1 },
];

const gui = new WebSocket(`ws://127.0.0.1:${PORT}`);
let mode = "ignore"; // "fold" → reply once to prime the cache; "drop" → withhold (force fallback)
let armedAcked = false;
gui.on("message", (data) => {
	let m;
	try { m = JSON.parse(data.toString()); } catch { return; }
	if (m.type === "armedAck") { armedAcked = true; return; }
	if (m.type !== "sync") return;
	if (mode === "fold") gui.send(JSON.stringify({ type: "plan", reqId: m.reqId, ops: [{ id: "a:resp-abc:p0", digestText: "STALEFOLD" }], groups: [] }));
	// "drop"/"ignore" → no reply
});
await new Promise((res, rej) => { gui.on("open", res); gui.on("error", rej); });
await new Promise((r) => setTimeout(r, 100)); // settle the view-only attach flush
// Declare ARMED over the wire for the blocking scenario (replaces the old ACCORDION_STEERING
// env flag). Wait for the ack so the extension has adopted it before the timed request below.
if (spec.arm) {
	gui.send(JSON.stringify({ type: "armed", armed: true }));
	await waitFor(() => armedAcked, 1000, "armedAck");
}

// Prime the cache with a delivered fold, then withhold the next reply to force the
// timeout/deadline fallback and measure how long the wait took.
mode = "fold";
await Promise.resolve(handlers.context({ messages: sample }, ctx));
mode = "drop";
const t0 = Date.now();
const ret = await Promise.resolve(handlers.context({ messages: sample }, ctx));
const elapsed = Date.now() - t0;

gui.close();
handlers.session_shutdown({}, ctx);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }

const fails = [];
if (elapsed < spec.band[0] || elapsed > spec.band[1])
	fails.push(`plan wait ${elapsed}ms outside expected band [${spec.band[0]}, ${spec.band[1]}]`);
if (spec.wantError && errN < 1) fails.push("expected a console.error (armed deadline miss) but none fired");
if (!spec.wantError && errN > 0) fails.push(`unexpected console.error fired (${errN}) for a disarmed fallback`);
if (spec.wantWarn && warnN < 1) fails.push("expected a console.warn (timeout fallback) but none fired");
if (spec.wantStaleFold) {
	const folded = ret?.messages?.[1]?.content?.[0]?.text;
	if (folded !== "STALEFOLD") fails.push(`fallback did not re-apply the cached plan (got ${JSON.stringify(folded)})`);
}

if (fails.length) {
	process.stdout.write(`${SCENARIO}: FAIL — ${fails.join("; ")}\n`);
	process.exit(1);
}
process.stdout.write(`${SCENARIO}: waited ${elapsed}ms, errN=${errN} warnN=${warnN}, stale-fold applied\n`);
process.exit(0);
