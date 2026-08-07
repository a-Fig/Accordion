import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [sveltekit()],

  // The framework-free `core/` package lives OUTSIDE this SvelteKit root (`app/`). The kit alias
  // in svelte.config.js feeds svelte-check + the SvelteKit build; mirror `$core` here so the
  // dev/build server resolves it too. `server.fs.allow: [".."]` already permits reading it.
  resolve: {
    alias: {
      $core: path.resolve(__dirname, "../core"),
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
    // Allow the dev/build server to read one level above the SvelteKit root (the repo root).
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
