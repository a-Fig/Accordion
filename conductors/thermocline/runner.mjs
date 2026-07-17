// runner.mjs — the Phase-C out-of-process entry point for the Thermocline conductor.
//
// THIS IS A THIN STUB. The owner's decision is that Thermocline runs OUT OF PROCESS: the pi
// extension spawns THIS file in its own Node process (Phase C), and a remote SDK mirrors the live
// session's Truth into a local `ConductorHost` here. The `ThermoclineConductor` class is written
// ONLY against `ConductorHost` (see thermocline.ts), so it does not know or care whether its host
// is the in-process TestHost (today's unit tests) or the Phase-C remote host (this runner) — it is
// the SAME class either way.
//
// ── What Phase C must provide (the exact surface this runner expects) ──────────────────────────
//
//   import { runRemoteConductor } from "<core>/conductor/remote";
//
//   runRemoteConductor(conductor, {
//     port:  Number(process.env.ACCORDION_PORT),   // loopback port the extension advertises
//     token: process.env.ACCORDION_TOKEN,          // bearer for the token-gated WS upgrade
//     signal,                                      // optional AbortSignal for teardown
//   }): Promise<void>
//
//   • It dials ws://127.0.0.1:${ACCORDION_PORT} with Authorization: Bearer ${ACCORDION_TOKEN}.
//   • It builds a local `ConductorHost` that mirrors the remote Truth (streaming TruthEvents into
//     HostEvents) and proxies `propose` / `complete` / `stats` / `setStatus` over the wire.
//   • It calls `conductor.attach(host)` after the first sync, pumps events, and calls
//     `conductor.detach()` on disconnect/teardown. host.complete is relayed to the agent's model
//     out-of-band (ADR 0013), NEVER on the pre-model-call hook.
//
// ── Spawn env (what the extension sets when launching this runner) ─────────────────────────────
//   ACCORDION_PORT   — required: the loopback WS port for this session.
//   ACCORDION_TOKEN  — required: the bearer token minted for this conductor.
//   ACCORDION_HOME   — optional: overrides the persistence root (~/.accordion). Passed through to
//                      the conductor's `persistDir`.
//   ATTN_PROBE_PYTHON / ATTN_PROBE_SCRIPT — optional probe overrides (see scorer.ts).
//
// ── Lifecycle ─────────────────────────────────────────────────────────────────────────────────
//   spawn → this runner connects → attach on first sync → run until the WS closes or SIGINT/SIGTERM
//   → detach (aborts in-flight completions + probe, discards a pending prepare) → exit 0.
//
// Until the remote SDK lands, this stub imports it defensively and exits gracefully with a clear
// message if it is absent — so a premature Phase-C spawn is a no-op, not a crash.

const PORT = Number(process.env.ACCORDION_PORT);
const TOKEN = process.env.ACCORDION_TOKEN;

function log(msg) {
	process.stderr.write(`[thermocline runner] ${msg}\n`);
}

async function main() {
	if (!PORT || !TOKEN) {
		log("ACCORDION_PORT and ACCORDION_TOKEN must both be set — refusing to start. (SDK not present exit.)");
		process.exit(0);
	}

	// TODO(Phase C): the remote SDK does not exist yet. When it lands, this import resolves and the
	// runner wires env → host → conductor. Until then, importing it throws and we exit gracefully.
	let runRemoteConductor;
	try {
		// The path is relative to the built runner location; Phase C decides whether the conductor is
		// run from source via a TS loader or from a compiled bundle. Both resolve `core/conductor/remote`.
		({ runRemoteConductor } = await import("../../core/conductor/remote.js"));
	} catch {
		log("remote conductor SDK (core/conductor/remote) not present yet — Phase C has not landed. Exiting 0.");
		process.exit(0);
	}

	// The conductor class is host-agnostic. Phase C's build makes this import resolvable at runtime
	// (compiled .js or a TS loader). Kept inside main() so the SDK-absent path above never reaches it.
	const { ThermoclineConductor } = await import("./thermocline.js");
	const conductor = new ThermoclineConductor({
		// Phase C supplies a stable session key so the deep zone persists per session.
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
