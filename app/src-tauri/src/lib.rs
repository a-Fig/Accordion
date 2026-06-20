// Native discovery for the "pull" connection model.
//
// The pi extension advertises each live session by writing
//   ~/.accordion/sessions/<id>.json
// and a one-shot focus request to
//   ~/.accordion/focus.json
// (see app/src/lib/live/registry.ts — these constants MUST stay in sync).
//
// A browser tab cannot read the filesystem, which is exactly why discovery lives
// here in native code. The webview calls these commands via `invoke`.

use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde_json::Value;
use tauri::Manager;

// Per-process cache for head-reads: path → (mtime_ms, title, cwd).
// Avoids re-reading unchanged files on every 3-second poll.
static HEAD_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, (u64, String, String)>>,
> = std::sync::OnceLock::new();

fn head_cache() -> std::sync::MutexGuard<
    'static,
    std::collections::HashMap<std::path::PathBuf, (u64, String, String)>,
> {
    HEAD_CACHE
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// `~/.accordion` — base of the registry. `ACCORDION_HOME` overrides the home dir
/// (kept in sync with the extension so both sides can be pointed at a temp dir).
fn registry_root() -> Option<PathBuf> {
    let home = std::env::var("ACCORDION_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(home_dir)?;
    Some(home.join(".accordion"))
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

/// Locate the `conductors/` directory relative to the running binary.
///
/// Resolution order:
/// 1. If `ACCORDION_CONDUCTORS_DIR` is set and points at a real directory, use it.
/// 2. Walk upward from `std::env::current_exe()`. The first ancestor that is the REPO ROOT —
///    i.e. it contains BOTH a `conductors/` and a sibling `app/` dir (this repo's signature) —
///    wins; return `<ancestor>/conductors`. Requiring `app/` too prevents matching an unrelated
///    `conductors/` folder higher in the tree and spawning an arbitrary binary from a foreign
///    `launch.json`.
///    (In a dev build the exe lives at `<repo>/app/src-tauri/target/{profile}/app.exe`,
///    so the walk lands on `<repo>/`, which contains both `conductors/` and `app/`.)
fn conductors_root() -> Option<PathBuf> {
    // 1. Env-var override — must be a real directory, not just any existing path.
    if let Ok(val) = std::env::var("ACCORDION_CONDUCTORS_DIR") {
        let p = PathBuf::from(&val);
        if p.is_dir() {
            return Some(p);
        }
    }

    // 2. Walk up from the binary, looking for the repo root (conductors/ + app/ siblings).
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?;
    loop {
        let candidate = dir.join("conductors");
        if candidate.is_dir() && dir.join("app").is_dir() {
            return Some(candidate);
        }
        match dir.parent() {
            Some(p) => dir = p,
            None => return None,
        }
    }
}

/// Managed state: map of conductor id → spawned child process handle.
struct ConductorProcs(std::sync::Mutex<std::collections::HashMap<String, std::process::Child>>);

/// Managed state: the single fake-pi mock-server child, if running. Launched from
/// Settings ("Fake pi session") so the desktop app can be exercised without real pi.
struct MockProc(std::sync::Mutex<Option<std::process::Child>>);

/// Browser control-panel port the mock server serves (CONTROL_PORT in mock-server.mjs,
/// defaulting to PORT+1 = 4318). Kept in lockstep with the extension's default.
const MOCK_CONTROL_PORT: u16 = 4318;

/// Locate the repo's `extension/` directory (home of `mock-server.mjs`).
///
/// Resolution mirrors `conductors_root()`:
/// 1. `ACCORDION_EXTENSION_DIR` if it points at a real directory.
/// 2. Walk upward from `current_exe()`; the first ancestor whose `extension/` holds
///    `mock-server.mjs` AND which has a sibling `app/` dir (the repo-root signature)
///    wins — return that `extension/`. Requiring `app/` too prevents matching some
///    unrelated `extension/` higher in the tree.
fn extension_root() -> Option<PathBuf> {
    if let Ok(val) = std::env::var("ACCORDION_EXTENSION_DIR") {
        let p = PathBuf::from(&val);
        if p.is_dir() {
            return Some(p);
        }
    }

    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?;
    loop {
        let candidate = dir.join("extension");
        if candidate.join("mock-server.mjs").is_file() && dir.join("app").is_dir() {
            return Some(candidate);
        }
        match dir.parent() {
            Some(p) => dir = p,
            None => return None,
        }
    }
}

/// Read every session descriptor. Returns raw JSON values; the app validates the
/// protocol/staleness (registry.ts `isLiveEntry`) so the rules live in one place.
#[tauri::command]
fn list_sessions() -> Vec<Value> {
    let mut out = Vec::new();
    let Some(root) = registry_root() else {
        return out;
    };
    let dir = root.join("sessions");
    let Ok(entries) = fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        // Skip half-written temp files (extension writes <id>.json.<pid>.tmp).
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                out.push(value);
            }
        }
    }
    out
}

/// Read every conductor descriptor. Returns raw JSON values; the app validates the
/// protocol/staleness (registry.ts `isLiveConductor`) so the rules live in one place.
#[tauri::command]
fn list_conductors() -> Vec<Value> {
    let mut out = Vec::new();
    let Some(root) = registry_root() else {
        return out;
    };
    let dir = root.join("conductors");
    let Ok(entries) = fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                out.push(value);
            }
        }
    }
    out
}

/// List conductors that can be launched from the app.
///
/// Scans each immediate subdirectory of `conductors_root()` for a `launch.json`
/// manifest. The parsed manifest (containing `id`, `label`, `command`, `args`) is
/// returned as-is. Dirs without a valid `launch.json` are silently skipped.
#[tauri::command]
fn list_launchable_conductors() -> Vec<Value> {
    let mut out = Vec::new();
    let Some(root) = conductors_root() else {
        return out;
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("launch.json");
        if let Ok(text) = fs::read_to_string(&manifest_path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                out.push(value);
            }
        }
    }
    out
}

/// Launch a conductor child process by id.
///
/// Reads `<conductors_root>/<id>/launch.json` for `command` and `args`, then
/// spawns the process in that directory. On Windows the child window is suppressed
/// (`CREATE_NO_WINDOW`). Stdio is redirected to null so child logs don't spam the
/// app's console. Idempotent: if the child for `id` is already running, returns Ok.
#[tauri::command]
fn launch_conductor(
    id: String,
    procs: tauri::State<'_, ConductorProcs>,
) -> Result<(), String> {
    // Check if already running.
    // Fix #6: if try_wait() returns Err (state unknown), treat the existing child as
    // possibly alive — do NOT remove-and-respawn (risks double process / port conflict).
    // Return Ok as if it's still running; this is the conservative safe choice.
    {
        let mut map = procs.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(child) = map.get_mut(&id) {
            match child.try_wait() {
                Ok(None) => return Ok(()), // still running
                Ok(Some(_)) => {
                    map.remove(&id); // cleanly exited — fall through to re-launch
                }
                Err(_) => return Ok(()), // state unknown — treat as alive, don't respawn
            }
        }
    }

    let root = conductors_root().ok_or_else(|| {
        "Could not locate the conductors directory. Set ACCORDION_CONDUCTORS_DIR to your checkout's conductors/ folder.".to_string()
    })?;

    let dir = root.join(&id);
    let manifest_path = dir.join("launch.json");
    let manifest_text = fs::read_to_string(&manifest_path)
        .map_err(|_| format!("No launch manifest for conductor '{id}'."))?;
    let manifest: Value = serde_json::from_str(&manifest_text)
        .map_err(|_| format!("No launch manifest for conductor '{id}'."))?;

    let command = manifest
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("launch.json for '{id}' is missing 'command'."))?
        .to_string();

    let args: Vec<String> = manifest
        .get("args")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    // Pre-flight: a Node conductor with a package.json but no installed node_modules will
    // crash the instant it tries to `import "ws"`. Catch that here with an actionable error
    // instead of spawning a process that dies in <400ms. Gate only when there IS a package.json
    // (declaring deps) so a future dependency-free conductor isn't blocked on a node_modules
    // that never exists; the `command == "node"` signal is implied — a deps-declaring conductor
    // is the case we care about regardless of how it's launched.
    // NOTE: checks only the leaf node_modules dir; hoisted deps in a workspace root won't be
    // caught, but the common single-package case is covered.
    if dir.join("package.json").is_file() && !dir.join("node_modules").is_dir() {
        return Err(format!(
            "Conductor '{id}' isn't set up yet. Run `npm install` in conductors/{id}/ first (attention-folder also needs the Python probe venv — see its README)."
        ));
    }

    let mut cmd = std::process::Command::new(&command);
    cmd.args(&args)
        .current_dir(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    // On Windows: suppress any console window the child might open.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!(
                "Could not start '{id}': '{command}' was not found on PATH. Install Node.js or add it to PATH."
            )
        } else {
            format!("Could not start '{id}': {e}")
        }
    })?;

    // Fix #5: insert the child into the map IMMEDIATELY after a successful spawn, BEFORE
    // the 400ms sleep. This way a concurrent RunEvent::Exit can find and kill it; without
    // this, a child that spawns during the sleep window would be orphaned on app exit.
    // Fix #4: if map.insert returns a previous Child for this id (concurrent launch TOCTOU),
    // kill and best-effort reap the OLD one so it can't hold the WS port as an orphan.
    {
        let mut map = procs.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut old) = map.insert(id.clone(), child) {
            let _ = old.kill();
            let _ = old.try_wait();
        }
    }
    // Lock is released here — we do NOT hold the mutex across the sleep.

    // Early-exit detection: a conductor that crashes on startup (e.g. an `import` that throws,
    // or deps that pre-flight didn't catch) dies almost immediately. Give it a brief moment,
    // then check whether it already exited — if so, surface that and remove the dead handle
    // instead of leaving the GUI to time out waiting for a heartbeat.
    // The crash happens in well under 400ms; this short block in a sync command is fine.
    std::thread::sleep(std::time::Duration::from_millis(400));

    let mut map = procs.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(child) = map.get_mut(&id) {
        match child.try_wait() {
            Ok(Some(status)) => {
                // Already exited — startup crash. Remove the dead handle.
                map.remove(&id);
                return Err(format!(
                    "Conductor '{id}' started but exited immediately ({status}). Check that its dependencies are installed (npm install in conductors/{id}/)."
                ));
            }
            // Fix #6 (post-spawn site): still running, or try_wait errored — treat as alive.
            // This matches the existing comment; state is preserved as-is.
            Ok(None) | Err(_) => {}
        }
    }
    // If the entry was removed by a concurrent stop_conductor during the sleep, that's fine —
    // the process was killed externally and we simply return Ok (the stop already handled it).
    Ok(())
}

/// Stop a running conductor child process.
///
/// Kills the child (if present), reaps it, and best-effort removes its heartbeat
/// file from the registry. Idempotent — stopping an unknown id is fine.
#[tauri::command]
fn stop_conductor(
    id: String,
    procs: tauri::State<'_, ConductorProcs>,
) -> Result<(), String> {
    let child = {
        let mut map = procs.0.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&id)
    };
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }

    // Best-effort: remove the heartbeat file so discovery doesn't see a stale entry.
    if let Some(root) = registry_root() {
        let hb = root.join("conductors").join(format!("{id}.json"));
        let _ = fs::remove_file(hb);
    }

    Ok(())
}

/// Launch the fake-pi mock server (`node extension/mock-server.mjs`).
///
/// Spawns the process detached (CREATE_NO_WINDOW on Windows, stdio → null), tracks the
/// single child in `MockProc`, and returns the browser control-panel port so the caller
/// can open it. Idempotent: if a child is already alive, returns the port without
/// re-spawning. A short post-spawn check surfaces an immediate crash (e.g. missing deps)
/// as an actionable error instead of a phantom "running" state.
#[tauri::command]
fn launch_mock_session(procs: tauri::State<'_, MockProc>) -> Result<u16, String> {
    // Already running? (Mirrors launch_conductor's try_wait handling.)
    {
        let mut slot = procs.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(child) = slot.as_mut() {
            match child.try_wait() {
                Ok(None) => return Ok(MOCK_CONTROL_PORT), // still running
                Ok(Some(_)) => {
                    *slot = None; // cleanly exited — fall through to re-launch
                }
                Err(_) => return Ok(MOCK_CONTROL_PORT), // state unknown — treat as alive
            }
        }
    }

    let dir = extension_root().ok_or_else(|| {
        "Could not locate the extension/ directory. Set ACCORDION_EXTENSION_DIR to your checkout's extension/ folder.".to_string()
    })?;

    // Pre-flight: the mock needs `ws` + `jiti` from extension/node_modules; without them it
    // dies the instant it `import`s. Catch that with a clear message rather than a silent crash.
    if !dir.join("node_modules").is_dir() {
        return Err(
            "The fake pi session isn't set up yet. Run `npm install` in extension/ first.".to_string(),
        );
    }

    let mut cmd = std::process::Command::new("node");
    cmd.arg("mock-server.mjs")
        .current_dir(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Could not start the fake pi session: 'node' was not found on PATH. Install Node.js or add it to PATH.".to_string()
        } else {
            format!("Could not start the fake pi session: {e}")
        }
    })?;

    // Insert immediately so a concurrent app-exit can find and kill it. If a racing launch
    // already stored a child, kill the older one so it can't orphan-hold the WS port.
    {
        let mut slot = procs.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut old) = slot.replace(child) {
            let _ = old.kill();
            let _ = old.try_wait();
        }
    }

    // Early-exit detection: a bad spawn (e.g. deps that pre-flight missed) dies in well
    // under 400ms. Give it a beat, then report if it already exited.
    std::thread::sleep(std::time::Duration::from_millis(400));
    {
        let mut slot = procs.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(child) = slot.as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                *slot = None;
                return Err(format!(
                    "The fake pi session started but exited immediately ({status}). Check that extension/ deps are installed (npm install)."
                ));
            }
        }
    }

    Ok(MOCK_CONTROL_PORT)
}

/// Stop the fake-pi mock server if running. Idempotent. A hard kill skips the mock's own
/// registry cleanup, but the app reaps the stale session descriptor after STALE_AFTER_MS.
#[tauri::command]
fn stop_mock_session(procs: tauri::State<'_, MockProc>) -> Result<(), String> {
    let child = {
        let mut slot = procs.0.lock().unwrap_or_else(|e| e.into_inner());
        slot.take()
    };
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
    Ok(())
}

/// Report whether the fake-pi mock server is currently running (reaps a dead handle).
#[tauri::command]
fn mock_session_running(procs: tauri::State<'_, MockProc>) -> bool {
    let mut slot = procs.0.lock().unwrap_or_else(|e| e.into_inner());
    match slot.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(None) => true,
            Ok(Some(_)) => {
                *slot = None;
                false
            }
            Err(_) => true,
        },
        None => false,
    }
}

/// Delete a stale/dead session descriptor (the app reaps when a heartbeat lapses).
#[tauri::command]
fn reap_session(session_id: String) -> bool {
    // Guard against path traversal: only a bare file name, never a path.
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return false;
    }
    let Some(root) = registry_root() else {
        return false;
    };
    let path = root.join("sessions").join(format!("{session_id}.json"));
    fs::remove_file(path).is_ok()
}

/// Read-and-consume the `/accordion` focus request (delete so it fires once).
#[tauri::command]
fn take_focus_request() -> Option<Value> {
    let root = registry_root()?;
    let path = root.join("focus.json");
    let text = fs::read_to_string(&path).ok()?;
    match serde_json::from_str::<Value>(&text) {
        Ok(value) => {
            let _ = fs::remove_file(&path); // consume only a well-formed request
            Some(value)
        }
        // Leave a corrupt/partial file in place so a transient bad write is retried on the
        // next tick (or overwritten by the next /accordion) instead of silently lost.
        Err(_) => None,
    }
}

/// Discover recent Claude Code transcript files under `~/.claude/projects/`.
///
/// Each immediate child of `projects/` that is a directory (a project folder) is
/// scanned for top-level `*.jsonl` files; nested dirs (e.g. `subagents/`) are skipped.
/// Results are sorted newest-first by mtime; only the 50 most-recent are returned.
/// A head-read (up to 96 KB) extracts a title and cwd from each file's JSONL lines.
#[tauri::command]
fn list_claude_sessions() -> Vec<Value> {
    // 1. Resolve the projects root.
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    let projects_root = home.join(".claude").join("projects");
    let Ok(project_dirs) = fs::read_dir(&projects_root) else {
        return Vec::new();
    };

    // 2. Collect (path, mtime_ms, size) for every top-level *.jsonl in each project dir.
    struct FileInfo {
        path: PathBuf,
        folder_name: String,
        mtime_ms: u64,
        size: u64,
    }

    let mut files: Vec<FileInfo> = Vec::new();

    for proj_entry in project_dirs.flatten() {
        let proj_path = proj_entry.path();
        // Only directories are project folders.
        let Ok(proj_meta) = fs::metadata(&proj_path) else {
            continue;
        };
        if !proj_meta.is_dir() {
            continue;
        }
        let folder_name = proj_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        let Ok(entries) = fs::read_dir(&proj_path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // Skip subdirectories (e.g. subagents/).
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                continue;
            }
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            // Extract mtime as milliseconds since UNIX_EPOCH.
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let size = meta.len();
            files.push(FileInfo {
                path,
                folder_name: folder_name.clone(),
                mtime_ms,
                size,
            });
        }
    }

    // 3. Sort descending by mtime, keep newest 50.
    files.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    files.truncate(50);

    // 4. Head-read each of the 50 to extract title and cwd.
    let mut out: Vec<Value> = Vec::new();

    for fi in &files {
        let session_id = fi
            .path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let file_path_str = fi.path.to_string_lossy().to_string();

        // Check the per-process head-read cache before touching disk.
        // Key: (path, mtime_ms) — a changed mtime means the file content may differ.
        let cached = {
            let cache = head_cache();
            cache
                .get(&fi.path)
                .filter(|(cached_mtime, _, _)| *cached_mtime == fi.mtime_ms)
                .map(|(_, t, c)| (t.clone(), c.clone()))
        };

        let (resolved_title, cwd) = if let Some((title, cwd)) = cached {
            (title, cwd)
        } else {
            // Read up to 96 KB (ai-title observed at ≤33 KB; 96 KB gives safe headroom).
            const HEAD_BYTES: u64 = 96 * 1024;
            let raw_bytes: Vec<u8> = if fi.size <= HEAD_BYTES {
                match fs::read(&fi.path) {
                    Ok(b) => b,
                    Err(_) => continue,
                }
            } else {
                use std::io::Read;
                let Ok(mut f) = fs::File::open(&fi.path) else {
                    continue;
                };
                let mut buf = vec![0u8; HEAD_BYTES as usize];
                // File is guaranteed >= HEAD_BYTES, so read_exact fills the buffer.
                // On an unexpected I/O error keep whatever partial bytes were written
                // rather than panicking; the lossy decode below handles null padding.
                let _ = f.read_exact(&mut buf);
                buf
            };

            // Lossily convert so a truncated multibyte sequence at the boundary doesn't panic.
            let text = String::from_utf8_lossy(&raw_bytes);
            let lines: Vec<&str> = text.lines().collect();

            let mut title: Option<String> = None;
            let mut cwd = String::new();
            let mut first_user_text: Option<String> = None;

            for line in &lines {
                let Ok(obj) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                let obj_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");

                // Extract cwd from any object that carries it (Claude Code user messages do).
                if cwd.is_empty() {
                    if let Some(c) = obj.get("cwd").and_then(|v| v.as_str()) {
                        if !c.is_empty() {
                            cwd = c.to_string();
                        }
                    }
                }

                // Title priority: (1) ai-title, (2) summary, (3) first user message.
                if title.is_none() {
                    if obj_type == "ai-title" {
                        if let Some(s) = obj.get("aiTitle").and_then(|v| v.as_str()) {
                            if !s.is_empty() {
                                title = Some(s.chars().take(80).collect());
                            }
                        }
                    } else if obj_type == "summary" {
                        if let Some(s) = obj.get("summary").and_then(|v| v.as_str()) {
                            if !s.is_empty() {
                                title = Some(s.chars().take(80).collect());
                            }
                        }
                    }
                }

                if title.is_none() && first_user_text.is_none() && obj_type == "user" {
                    if let Some(msg) = obj.get("message") {
                        let text_from_content = if let Some(s) =
                            msg.get("content").and_then(|v| v.as_str())
                        {
                            // Plain string content.
                            Some(s.to_string())
                        } else if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
                            // Array of content blocks — use first text block.
                            arr.iter()
                                .find(|block| {
                                    block.get("type").and_then(|t| t.as_str()) == Some("text")
                                })
                                .and_then(|block| block.get("text").and_then(|t| t.as_str()))
                                .map(|s| s.to_string())
                        } else {
                            None
                        };
                        if let Some(t) = text_from_content {
                            if !t.trim().is_empty() {
                                first_user_text = Some(t.chars().take(80).collect());
                            }
                        }
                    }
                }

                // Stop scanning once we have a title (or fallback) and cwd.
                if (title.is_some() || first_user_text.is_some()) && !cwd.is_empty() {
                    break;
                }
            }

            let resolved_title = title
                .or(first_user_text)
                .unwrap_or_else(|| "(untitled)".to_string());

            // Update the cache; Mutex is locked only for this insert, not across the read.
            {
                let mut cache = head_cache();
                cache.insert(
                    fi.path.clone(),
                    (fi.mtime_ms, resolved_title.clone(), cwd.clone()),
                );
            }

            (resolved_title, cwd)
        };

        // project: basename of cwd (split on / and \), or fallback to folder name.
        let project = if !cwd.is_empty() {
            cwd.split(['/', '\\'])
                .filter(|s| !s.is_empty())
                .last()
                .unwrap_or(&fi.folder_name)
                .to_string()
        } else {
            fi.folder_name.clone()
        };

        out.push(serde_json::json!({
            "sessionId": session_id,
            "filePath": file_path_str,
            "title": resolved_title,
            "cwd": cwd,
            "project": project,
            "mtime": fi.mtime_ms,
            "size": fi.size
        }));
    }

    // Prune the cache to only the paths seen in this scan, bounding growth over time.
    {
        let seen: std::collections::HashSet<&std::path::PathBuf> =
            files.iter().map(|fi| &fi.path).collect();
        let mut cache = head_cache();
        cache.retain(|path, _| seen.contains(path));
    }

    out
}

/// Read a Claude Code transcript's full text. Rust owns `~/.claude` access (the JS fs
/// plugin's scope does not cover programmatic reads of `~/.claude/projects/**`, only
/// dialog-picked files), so the file load + tail goes through here. The path is
/// confined to the projects root — a crafted `invoke` cannot read arbitrary disk.
#[tauri::command]
fn read_claude_session(path: String) -> Result<String, String> {
    let home = home_dir().ok_or_else(|| "no home directory".to_string())?;
    let projects_root = home.join(".claude").join("projects");
    // Canonicalize both sides so symlinks / `..` / mixed separators can't escape the
    // root (canonicalize requires the file to exist, which is what we want anyway).
    let root =
        fs::canonicalize(&projects_root).map_err(|e| format!("projects root unavailable: {e}"))?;
    let target = fs::canonicalize(&path).map_err(|e| format!("cannot resolve path: {e}"))?;
    if !target.starts_with(&root) {
        return Err(format!("forbidden path (outside projects root): {path}"));
    }
    if target.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        return Err(format!("not a .jsonl transcript: {path}"));
    }
    fs::read_to_string(&target).map_err(|e| format!("read failed: {e}"))
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Bring the main window to the foreground (used when a focus request fires).
#[tauri::command]
fn focus_window(app: tauri::AppHandle) {
    focus_main_window(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ConductorProcs(Default::default()))
        .manage(MockProc(Default::default()))
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            list_conductors,
            reap_session,
            take_focus_request,
            focus_window,
            list_claude_sessions,
            read_claude_session,
            list_launchable_conductors,
            launch_conductor,
            stop_conductor,
            launch_mock_session,
            stop_mock_session,
            mock_session_running
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Kill all conductor child processes on app exit to avoid orphaned nodes.
                //
                // Fix #3: kill ALL children first (before any waiting) so one stuck child
                // can't block the kill signals to the rest. Then do a bounded reap — loop
                // try_wait() with short sleeps rather than calling blocking wait(). If a
                // child still hasn't exited after ~500ms we move on; a hung child must not
                // prevent the app from shutting down.
                let state = app_handle.state::<ConductorProcs>();
                let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
                let mut children: Vec<std::process::Child> = map.drain().map(|(_, c)| c).collect();
                drop(map); // release the lock; no callers remain during Exit

                // Fold the fake-pi mock child (if any) into the same kill+reap pass.
                let mock = app_handle.state::<MockProc>();
                if let Some(c) = mock.0.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    children.push(c);
                }

                // Phase 1: issue kill() to every child without waiting.
                for child in &mut children {
                    let _ = child.kill();
                }

                // Phase 2: bounded reap — up to ~500ms per child via try_wait polling.
                const POLL_INTERVAL_MS: u64 = 25;
                const MAX_POLLS: u32 = 20; // 20 × 25ms = 500ms cap per child
                for mut child in children {
                    for _ in 0..MAX_POLLS {
                        match child.try_wait() {
                            Ok(Some(_)) => break,           // reaped
                            Ok(None) => {}                  // still running — keep polling
                            Err(_) => break,                // state unknown — move on
                        }
                        std::thread::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS));
                    }
                    // If the child still hasn't exited, drop it and move on.
                    // The OS will clean up the process once our handle is dropped.
                }
            }
        })
}
