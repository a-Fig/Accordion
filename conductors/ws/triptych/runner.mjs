// runner.mjs — the out-of-process entry point for the Triptych conductor.
//
// Same pattern as ../thermocline/runner.mjs (see its banner for the full rationale): the pi
// extension spawns THIS file in its own Node process; the remote SDK mirrors the live session's
// Truth into a local ConductorHost here; the TriptychConductor class is written only against
// ConductorHost and cannot tell this host from the in-process TestHost the unit tests use.
//
// The committed `./triptych-sdk.mjs` bundle (emitted by `extension/build-remote-sdk.mjs`) carries
// the conductor class + its core/ graph, dependency-free. The tree-sitter engine is NOT in the
// bundle: `./skeleton.mjs` is imported here, dynamically, and INJECTED into the conductor — it
// needs this directory's node_modules (`web-tree-sitter` + `tree-sitter-wasms`), so:
//
//     cd conductors/ws/triptych && npm install     # one-time, repo checkouts only
//
// A missing install fails the spawn loudly (nonzero exit + a clear stderr line the extension
// surfaces via conductorStatus) rather than silently degrading.
//
// Spawn env (set by the extension): ACCORDION_PORT (required), ACCORDION_TOKEN (required).

const PORT = Number(process.env.ACCORDION_PORT);
const TOKEN = process.env.ACCORDION_TOKEN;

function log(msg) {
	process.stderr.write(`[triptych runner] ${msg}\n`);
}

async function main() {
	if (!PORT || !TOKEN) {
		log("ACCORDION_PORT and ACCORDION_TOKEN must both be set — refusing to start.");
		process.exit(1);
	}

	const { runRemoteConductor, TriptychConductor } = await import("./triptych-sdk.mjs");

	let skeletonizer;
	try {
		skeletonizer = (await import("./skeleton.mjs")).default;
	} catch (err) {
		log(`cannot load the tree-sitter skeleton engine: ${err?.message ?? err}`);
		log("run `npm install` in conductors/ws/triptych/ (web-tree-sitter + tree-sitter-wasms), then re-select Triptych.");
		process.exit(1);
	}

	const conductor = new TriptychConductor(skeletonizer);

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
