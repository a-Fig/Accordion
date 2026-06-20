# Contributing to Accordion

This guide gets a new contributor from a fresh clone to a running dev build and a
clean quality gate. For *what* the product is, read [VISION.md](VISION.md); for *how
the code is organized and the conventions to follow*, read [CLAUDE.md](CLAUDE.md) — it
is the authoritative guide to working in this codebase.

The active surface is the desktop app in **`app/`** (Tauri 2 + SvelteKit), the pi
extension in **`extension/`** (the live link), and the conductor strategies in
**`conductors/`**.

---

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| **Node.js** | 20 LTS (≥18) | ships with `npm`, which this repo uses |
| **Rust** | stable, via [rustup](https://rustup.rs) | builds the Tauri native layer (`app/src-tauri`) |
| **pi** | latest | only needed to work on the **live link** (optional) |

Tauri also needs platform system libraries. Install them once — the official list is the
source of truth: **https://v2.tauri.app/start/prerequisites/**. In short:

- **Windows** — [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
  (preinstalled on Win 11) and the **Microsoft C++ Build Tools** (the "Desktop development
  with C++" workload), which provide the MSVC linker Rust needs.
- **macOS** — Xcode Command Line Tools: `xcode-select --install`.
- **Linux (Debian/Ubuntu)** — `webkit2gtk-4.1`, `build-essential`, `curl`, `wget`, `file`,
  `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` (package names
  vary by distro — follow the Tauri prerequisites page).

Verify your toolchain:

```bash
node -v      # v20.x (or ≥18)
cargo -V     # any recent stable
```

---

## 2. Clone & install

```bash
git clone https://github.com/a-Fig/accordion.git
cd accordion

# the desktop app
cd app && npm install

# the pi extension (only if you'll touch the live link)
cd ../extension && npm install
```

The first `npm run tauri dev` / `cargo` invocation also compiles the Rust crates, which
can take a few minutes on a cold checkout. That's normal.

---

## 3. Run it

From `app/`:

```bash
npm run tauri dev   # the native desktop window — REQUIRED for live session discovery
```

`tauri dev` starts the Vite dev server and the native shell together (hot-reload on save).

For pure UI iteration you can skip the native shell:

```bash
npm run dev         # browser only → http://localhost:1420
```

The browser build can't read the `~/.accordion/` registry, so live session discovery is
disabled there — it falls back to a manual-port Connect box and the bundled demo. Use the
**desktop** app for anything involving live sessions.

> Both `npm run dev` and `npm run tauri dev` want **port 1420** — run only one at a time.

---

## 4. Quality gate (run before every push)

Keep all of these clean. CI parity is on you locally.

```bash
# from app/
npm run check       # svelte-check / typecheck — must be 0 errors / 0 warnings
npm run test        # vitest — unit tests for the risky live / mapping / engine logic
npm run build       # production SPA build must succeed

# the native discovery layer
cd src-tauri && cargo check

# the pi extension (from extension/)
cd ../../extension && node smoke.mjs   # drives the extension via jiti + a real WS client
```

Production installer (when you need a real bundle): `npm run tauri build` from `app/`.

---

## 5. The live link (optional — only for live-session work)

To watch a running pi session in the app you must register the extension with pi. This
edits **your own** pi config:

Add this repo's extension to `~/.pi/agent/settings.json`:

```json
{ "extensions": ["<absolute-path-to-repo>/extension/accordion.ts"] }
```

Then run `pi` in any project. It advertises itself in `~/.accordion/sessions/` and shows
up in the app's **Sessions** sidebar within ~1s — click it (or run `/accordion` in that
terminal to foreground the app on it) and its context populates live. Folding is preview-only
by default; use the header's **Folding** toggle to opt in to steering the live agent's
context.

### Keeping the `/accordion` app binary current

`/accordion` does **not** run a dev server — it launches a pre-built binary. The extension
(`extension/accordion.ts → resolveAccordionApp`) picks the first one it finds, in this order:

1. the `--accordion-app <path>` pi flag, then the `ACCORDION_APP_PATH` env var (explicit overrides);
2. an installed bundle — `%LOCALAPPDATA%\Programs\Accordion\Accordion.exe`, `Program Files\Accordion\…`, etc.;
3. the repo build outputs, **release first**: `app/src-tauri/target/release/app.exe`, then `…/target/debug/app.exe`.

With no installed bundle (the common dev setup), it launches the **repo release build**. A Tauri
*release* build **bakes the SvelteKit frontend in at compile time** — so merging new UI to `main`
does *not* update what `/accordion` shows. You must rebuild the binary. The checkout that matters
is the one whose path is registered in `~/.pi/agent/settings.json → extensions` (that path's repo
root is where `target/release/app.exe` is resolved).

To refresh it after `main` moves:

```powershell
# 0. Close any open Accordion window first — a running app.exe locks the file and the
#    linker will fail to overwrite it. (Check: Get-Process app,Accordion -ErrorAction SilentlyContinue)

# 1. Update the registered checkout to the new main
cd "<the repo whose extension/accordion.ts is in settings.json>"
git checkout main
git pull

# 2. Install deps — easy to forget, and a missing new dependency fails the build at the
#    Vite step (e.g. the design-system overhaul added @fontsource-variable/inter).
cd app
npm install

# 3. Rebuild. cargo must be on PATH (see Platform gotchas).
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:USERPROFILE\.rustup\bin;$env:PATH"
npm run tauri build -- --no-bundle   # builds target/release/app.exe; --no-bundle skips
                                     # the slower MSI/NSIS installers /accordion doesn't use
```

The fresh binary lands at `app/src-tauri/target/release/app.exe` — the exact path `/accordion`
launches. No reload needed for the *app*; the next `/accordion` opens the new build. (If the
**extension** code itself changed, restart pi so it reloads `accordion.ts`.)

> Drop `-- --no-bundle` if you also want the distributable installers
> (`target/release/bundle/…`). A clean release compile takes ~2 min.

---

## 6. Contribution workflow

- **Branch off `main`.** Never commit directly to `main`.
- Make your change with the quality gate passing. Match existing conventions — see
  [CLAUDE.md](CLAUDE.md) (Svelte 5 runes, the engine-is-source-of-truth rule, the tile-grid
  performance constraints, the visual grammar).
- **Push your branch and open a Pull Request.** Maintainers handle merging to `main` and
  merging PRs.
- **This repo is public — never commit secrets.** The dev sample once contained a live API
  key; scan your staged diff before pushing and never paste real keys into sample data.

---

## 7. Platform gotchas

- **Windows + Git Bash:** `cargo` is often not on the Bash `PATH`. Run native commands from
  **PowerShell**, prepending cargo to PATH:
  ```powershell
  $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:USERPROFILE\.rustup\bin;$env:PATH"
  npm run tauri dev
  ```
- **Port 1420** is single-use. Free it before switching dev modes:
  ```powershell
  Get-NetTCPConnection -LocalPort 1420 | Stop-Process
  ```
- **`LF will be replaced by CRLF`** warnings from Git on Windows are benign.

---

Questions, ideas, and benchmarks welcome. 🪗
