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

fn head_cache(
) -> std::sync::MutexGuard<'static, std::collections::HashMap<std::path::PathBuf, (u64, String, String)>>
{
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
            files.push(FileInfo { path, folder_name: folder_name.clone(), mtime_ms, size });
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
                        let text_from_content = if let Some(s) = msg
                            .get("content")
                            .and_then(|v| v.as_str())
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
    let root = fs::canonicalize(&projects_root)
        .map_err(|e| format!("projects root unavailable: {e}"))?;
    let target = fs::canonicalize(&path).map_err(|e| format!("cannot resolve path: {e}"))?;
    if !target.starts_with(&root) {
        return Err(format!("forbidden path (outside projects root): {path}"));
    }
    if target.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        return Err(format!("not a .jsonl transcript: {path}"));
    }
    fs::read_to_string(&target).map_err(|e| format!("read failed: {e}"))
}

/// Bring the main window to the foreground (used when a focus request fires).
#[tauri::command]
fn focus_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            reap_session,
            take_focus_request,
            focus_window,
            list_claude_sessions,
            read_claude_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
