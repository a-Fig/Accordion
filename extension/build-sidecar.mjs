/*
 * build-sidecar.mjs — bundle sidecar.ts into extension/sidecar.mjs.
 *
 * The sidecar hosts the UNCHANGED accordion.ts pi extension for a harness that is not pi (today the
 * mistral-vibe fork), driven over stdin/stdout JSON-lines. See docs/sidecar-protocol.md.
 *
 * WHY THE OUTPUT IS A SIBLING OF accordion.js (and not extension/dist/sidecar.mjs)
 * accordion.ts resolves four things relative to `import.meta.url`: the desktop app binary
 * (repoAppCandidates → ../app/src-tauri/...), the browser-served client root (resolveClientRoot →
 * dist/client or ../app/build), its skill directories (skills/), and the out-of-process conductor
 * runners (../conductors/ws). The published accordion.js sits at the package root precisely so all
 * four resolve; a bundle one directory deeper would break every one of them (most visibly: no
 * browser UI). So the sidecar bundle lands next to accordion.js.
 *
 * Externals policy is identical to build-extension.mjs. UNLIKE the npm tarball, the sidecar runs
 * from a REPO CHECKOUT with extension/node_modules present, so `ws` resolves normally.
 * @earendil-works/pi-ai is dynamically imported by accordion.ts's completion relay only — the
 * sidecar declines conductor completions before that import is ever reached, so its absence can
 * never crash the process.
 *
 * Run: node ./build-sidecar.mjs   (or `npm run build:sidecar`)
 * Prereq: `npm install` in this directory so esbuild is available.
 */
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "sidecar.ts");
const outfile = path.resolve(here, "sidecar.mjs");

const result = await esbuild.build({
	entryPoints: [entry],
	outfile,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	sourcemap: false,
	external: [
		"ws",
		"typebox",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
	],
	logLevel: "info",
});

if (result.errors.length) {
	console.error(`build-sidecar: ${result.errors.length} error(s)`);
	process.exit(1);
}
console.log(`build-sidecar: ${entry} → ${outfile}`);
