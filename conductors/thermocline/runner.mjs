// runner.mjs — the Phase-C out-of-process entry point for the Thermocline conductor.
//
// The owner's decision is that Thermocline runs OUT OF PROCESS: the pi extension spawns THIS file in
// its own Node process, and the remote SDK mirrors the live session's Truth into a local
// `ConductorHost` here. The `ThermoclineConductor` class is written ONLY against `ConductorHost` (see
// thermocline.ts), so it does not know or care whether its host is the in-process TestHost (unit
// tests) or the remote host (this runner) — it is the SAME class either way.
//
// ── How the SDK is loaded (why the `.mjs` bundle) ──────────────────────────────────────────────
// Node 22 can type-strip a single `.ts` file, but `core/conductor/remote.ts` (and thermocline.ts)
// reach the rest of `core/` through EXTENSIONLESS relative imports (the `moduleResolution: "bundler"`
// convention), which Node's own ESM resolver never infers — so a bare `import` of the `.ts` fails
// several frames deep in core/'s graph. `extension/build-remote-sdk.mjs` pre-bundles remote.ts +
// thermocline.ts + their core/ graph into the flat, committed `./remote-sdk.mjs` (mirroring how
// `extension/accordion.js` is a committed bundle). This runner imports THAT — no TS loader, no
// node_modules, plain `node`.
//
// ── Spawn env (what the extension sets when launching this runner) ─────────────────────────────
//   ACCORDION_PORT   — required: the loopback WS port for this session.
//   ACCORDION_TOKEN  — required: the single-use bearer token minted for this conductor.
//   ACCORDION_SESSION_KEY — optional: stable session key so the deep zone persists per session.
//   ACCORDION_HOME   — optional: overrides the persistence root (~/.accordion). Read by the
//                      ThermoclineConductor constructor via `process.env.ACCORDION_HOME`.
//   ATTN_PROBE_PYTHON / ATTN_PROBE_SCRIPT — optional attention-probe overrides, read straight from
//                      `process.env` by scorer.ts (inherited here — nothing to wire).
//
// ── Lifecycle ─────────────────────────────────────────────────────────────────────────────────
//   spawn → dial ws://127.0.0.1:${ACCORDION_PORT}/?role=conductor&token=${ACCORDION_TOKEN} → attach on
//   first sync → pump events until the WS closes or SIGINT/SIGTERM → detach (aborts in-flight
//   completions + probe, discards a pending prepare) → exit 0. Any thrown/rejected startup failure
//   (protocol/role mismatch, missing env, an unresolvable bundle) exits NONZERO.

import { runRemoteConductor, ThermoclineConductor } from "./remote-sdk.mjs";

const PORT = Number(process.env.ACCORDION_PORT);
const TOKEN = process.env.ACCORDION_TOKEN;

function log(msg) {
	process.stderr.write(`[thermocline runner] ${msg}\n`);
}

async function main() {
	if (!PORT || !TOKEN) {
		log("ACCORDION_PORT and ACCORDION_TOKEN must both be set — refusing to start.");
		process.exit(1);
	}

	const conductor = new ThermoclineConductor({
		// The extension supplies a stable session key so the deep zone persists per session.
		sessionKey: process.env.ACCORDION_SESSION_KEY ?? null,
	});

	const controller = new AbortController();
	const shutdown = () => controller.abort();
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	log(`connecting to ws://127.0.0.1:${PORT} …`);
	await runRemoteConductor(conductor, { port: PORT, token: TOKEN, signal: controller.signal });
	log("disconnected — exiting.");
	process.exit(0);
}

main().catch((err) => {
	log(`fatal: ${err?.message ?? err}`);
	process.exit(1);
});
