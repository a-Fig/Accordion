/*
 * build-remote-sdk.mjs — bundle the out-of-process conductor SDK into a single flat, runnable ESM
 * file at conductors/thermocline/remote-sdk.mjs, so the thermocline runner can actually import it.
 *
 * WHY A BUNDLE: `conductors/thermocline/runner.mjs` is a plain `.mjs` the extension spawns with
 * `node runner.mjs`. Node 22 can type-strip a single `.ts` file, but `core/conductor/remote.ts`
 * (and `conductors/thermocline/thermocline.ts`) reach the rest of `core/` through EXTENSIONLESS
 * relative imports (the `moduleResolution: "bundler"` convention the app/tsconfig relies on), which
 * Node's own ESM resolver never infers — so a bare `import("../../core/conductor/remote.ts")` fails
 * several frames deep in core/'s graph. esbuild's bundler resolution DOES infer those extensions, so
 * we pre-bundle remote.ts + thermocline.ts + their whole core/ graph into one flat ESM here (mirroring
 * how build-extension.mjs bundles accordion.ts). The runner then imports `./remote-sdk.mjs` directly.
 *
 * The output re-exports exactly what the runner needs:
 *   • runRemoteConductor  (core/conductor/remote.ts — the WS-client SDK)
 *   • ThermoclineConductor (conductors/thermocline/thermocline.ts — the strategy the runner drives)
 *
 * What stays EXTERNAL (never bundled):
 *   • ws — the SDK dials with Node 22+'s global `WebSocket`, never the `ws` package; `ws` must not be
 *     bundled or required (mandated) so the bundle runs under plain `node` with no node_modules.
 *   • typebox / @earendil-works/* — peer-provided by pi; not in the SDK graph today, listed for parity
 *     with build-extension.mjs so an accidental future import never gets inlined.
 *   • Node builtins (node:child_process, node:fs, …) — external by default on platform=node.
 *
 * Run: node ./build-remote-sdk.mjs   (or `npm run build:remote-sdk`)
 * Prereq: `npm install` in this directory so esbuild is available.
 *
 * The generated conductors/thermocline/remote-sdk.mjs is a COMMITTED artifact (repo precedent:
 * extension/accordion.js). It is repo-checkout-only this phase — NOT part of the npm tarball.
 */
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const outfile = path.resolve(repoRoot, "conductors", "thermocline", "remote-sdk.mjs");

const banner = `// remote-sdk.mjs — GENERATED ARTIFACT, DO NOT EDIT BY HAND.
// Bundled from core/conductor/remote.ts + conductors/thermocline/thermocline.ts (and their core/
// graph) by extension/build-remote-sdk.mjs. Regenerate with:
//     node extension/build-remote-sdk.mjs      (or: npm --prefix extension run build:remote-sdk)
// Flat ESM, runnable under plain \`node\` (Node 22+ ships the global WebSocket the SDK dials with).
// \`ws\` is intentionally NOT bundled/required. Exports: runRemoteConductor, ThermoclineConductor.`;

const result = await esbuild.build({
	// Pin the build's working directory so the bundle's source-path comments (and therefore the
	// committed artifact's bytes) are identical no matter which directory the script is run from —
	// drift checks diff this file against a fresh regeneration.
	absWorkingDir: repoRoot,
	stdin: {
		contents:
			'export { runRemoteConductor } from "./core/conductor/remote";\n' +
			'export { ThermoclineConductor } from "./conductors/thermocline/thermocline";\n',
		resolveDir: repoRoot,
		sourcefile: "remote-sdk-entry.ts",
		loader: "ts",
	},
	outfile,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	sourcemap: false,
	banner: { js: banner },
	external: ["ws", "typebox", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
	logLevel: "info",
});

if (result.errors.length) {
	console.error(`build-remote-sdk: ${result.errors.length} error(s)`);
	process.exit(1);
}
console.log(`build-remote-sdk: core/conductor/remote.ts (+ thermocline graph) → ${outfile}`);
