import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [sveltekit()],

  // The top-level `conductors/` dir lives OUTSIDE this SvelteKit root (`app/`). The kit
  // alias in svelte.config.js feeds svelte-check + the SvelteKit build, but vitest reads
  // THIS config directly and may skip kit's alias injection — so mirror `$conductors` here
  // and allow the dev/build server to read the parent dir.
  resolve: {
    alias: {
      $conductors: path.resolve(__dirname, "../conductors"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // Let the dev/build server read `../conductors` (one level above the SvelteKit root).
    fs: {
      allow: [".."],
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
