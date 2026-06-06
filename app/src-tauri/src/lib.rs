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

use serde_json::Value;
use tauri::Manager;

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
            focus_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
