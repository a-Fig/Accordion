/*
 * build-client.mjs — copy the Accordion app's static browser build into the
 * extension for publishing.
 *
 * The extension serves the SvelteKit build over HTTP on its ephemeral port (see
 * accordion.ts → handleHttp). In the repo dev layout it serves straight from
 * ../app/build; when the extension is PUBLISHED as a package the app source isn't
 * present, so we vendor the build into ./dist/client (the first directory
 * resolveClientRoot() probes). This script produces that copy.
 *
 * Run: node ./build-client.mjs   (or `npm run build:client`)
 * Prereq when called directly: run `npm run build` in ../app first so app/build exists.
 * The package-level `npm run build` / `npm pack` path runs that app build for you.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "app", "build");
const dest = path.resolve(here, "dist", "client");

let srcOk = false;
try {
	srcOk = fs.statSync(src).isDirectory();
} catch {
	srcOk = false;
}
if (!srcOk) {
	console.error(`build-client: no app build found at ${src}`);
	console.error("Run `npm run build` inside app/ first, then re-run `npm run build:client`.");
	process.exit(1);
}

// Clean the destination so a stale prior build can't leave orphaned files behind.
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.cpSync(src, dest, { recursive: true });

console.log(`build-client: copied ${src} → ${dest}`);
