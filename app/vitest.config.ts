import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Standalone vitest config — deliberately does NOT load the SvelteKit plugin (no
// svelte-kit sync step). It DOES load the bare Svelte plugin so that `.svelte.ts`
// rune modules (e.g. engine/store.svelte.ts) compile; pure-TS tests (live mapping)
// are unaffected.
export default defineConfig({
	plugins: [svelte({ compilerOptions: { runes: true } })],
	test: {
		environment: "node",
		include: ["src/lib/**/*.test.ts"],
	},
});
