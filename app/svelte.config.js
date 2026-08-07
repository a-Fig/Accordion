// Tauri doesn't have a Node.js server to do proper SSR
// so we use adapter-static with a fallback to index.html to put the site in SPA mode
// See: https://svelte.dev/docs/kit/single-page-apps
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      fallback: "index.html",
    }),
    // The framework-free `core/` package lives at the repo root, OUTSIDE this SvelteKit project
    // (`app/`). The app reaches it through this alias. Lands in `.svelte-kit/tsconfig.json` for
    // svelte-check; vite.config.js + vitest.config.ts mirror it for the build and for vitest.
    alias: {
      $core: "../core",
    },
  },
};

export default config;
