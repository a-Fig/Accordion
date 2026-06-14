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
    // Every conductor — built-in included — lives in the top-level `conductors/` dir and
    // imports the contract as a sibling. The app reaches it through this alias (relative to
    // this SvelteKit project root, `app/`). Lands in `.svelte-kit/tsconfig.json` for
    // svelte-check; vite.config.js mirrors it for vitest + the production build.
    alias: {
      $conductors: "../conductors",
    },
  },
};

export default config;
