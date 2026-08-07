import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Standalone vitest config — deliberately does NOT load the SvelteKit plugin (no
// svelte-kit sync step). It DOES load the bare Svelte plugin so that `.svelte.ts`
// rune modules (e.g. engine/store.svelte.ts) compile; pure-TS tests (live mapping)
// are unaffected.
//
// Because the SvelteKit plugin is absent, kit's `$core` alias never gets injected here — so we
// mirror it explicitly (the framework-free `core/` package lives at the repo root, one level above
// this SvelteKit root). Both the bare alias (`$core` → the `core/` directory itself, matching
// vite.config.js / svelte.config.js — there is no `core/index.ts` barrel) and subpaths
// (`$core/truth`) must resolve. `server.fs.allow: [".."]` lets vitest read the parent dir, and the
// `../core` include glob runs the core package's own tests inside `npm run test`.
const coreDir = path.resolve(__dirname, "../core");
export default defineConfig({
	plugins: [svelte({ compilerOptions: { runes: true } })],
	resolve: {
		alias: [
			{ find: /^\$core$/, replacement: coreDir },
			{ find: /^\$core\//, replacement: `${coreDir}/` },
		],
	},
	server: {
		fs: { allow: [".."] },
	},
	test: {
		environment: "node",
		include: ["src/lib/**/*.test.ts", "../core/**/*.test.ts", "../conductors/**/*.test.ts"],
	},
});
