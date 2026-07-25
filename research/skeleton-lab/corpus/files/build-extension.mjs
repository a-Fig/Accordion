/*
 * build-extension.mjs — bundle accordion.ts into a self-contained accordion.js
 * for publishing as a pi package.
 *
 * The source imports shared contract modules from ../app/src/lib/live/*
 * (mapping, protocol, registry) and the engine (types, tokens). Those live
 * outside the extension package and are NOT shipped in the npm tarball, so we
 * inline them here with esbuild. The output is a single ESM file at the
 * package root; the `pi` manifest points at ./accordion.js.
 *
 * What stays external (runtime require/import, resolved from node_modules):
 *   • ws                 — real runtime dependency (declared in `dependencies`)
 *   • typebox            — peer-provided by pi core
 *   • @earendil-works/*  — peer-provided by pi core (pi-ai is dynamically
 *                          imported at runtime for the completion relay)
 * Node builtins are external by default on platform=node.
 *
 * Run: node ./build-extension.mjs   (or `npm run build:extension`)
 * Prereq: `npm install` in this directory so esbuild is available.
 */
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "accordion.ts");
const outfile = path.resolve(here, "accordion.js");

const result = await esbuild.build({
	entryPoints: [entry],
	outfile,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	sourcemap: false,
	// Peer-provided (pi core + typebox) and the runtime dep `ws` stay as runtime
	// imports. @earendil-works/pi-ai is dynamically imported — leaving it
	// external preserves that dynamic import at runtime.
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
	console.error(`build-extension: ${result.errors.length} error(s)`);
	process.exit(1);
}
console.log(`build-extension: ${entry} → ${outfile}`);
