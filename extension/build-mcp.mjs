import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
await esbuild.build({
	entryPoints: [path.join(here, "mcp.ts")],
	outfile: path.join(here, "accordion-mcp.js"),
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	logLevel: "info",
});
