//! Shell pieces for the "fix path" measurements:
//! - 11b: a webview media-capture permission handler (`on_permission_request`);
//! - 15c: native save (save dialog + write + read-back, all in Rust);
//! - 15d: a webview download handler (`on_download`).
//!
//! Both webview handlers change Tauri's default behaviour, and rows 11 and 15
//! measure that default. So they are installed only when the persisted shell
//! mode says so; switching the mode needs a restart (the main window is built
//! in `setup` from its config entry, which has `"create": false`).

use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{
    webview::{DownloadEvent, PermissionKind, PermissionResponse},
    AppHandle, Manager, Runtime, State, Url,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

const MODE_FILE: &str = "probe-shell-mode.json";
const MAX_SAVE_BYTES: usize = 64 * 1024 * 1024;

/// Whether this process was started with the webview handlers installed.
pub struct HandlerMode(pub bool);

#[derive(Default)]
pub struct HandlerLog {
    entries: Mutex<Vec<LogEntry>>,
    /// Destination assigned on `Requested`, keyed by download URL, so
    /// `Finished` can check the file even where WebKit reports no path.
    assigned: Mutex<HashMap<String, PathBuf>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    kind: &'static str,
    detail: String,
    url: Option<String>,
    path: Option<String>,
    success: Option<bool>,
    on_disk_bytes: Option<u64>,
    at_ms: u64,
}

impl HandlerLog {
    fn push(&self, mut entry: LogEntry) {
        entry.at_ms = now_ms();
        if let Ok(mut entries) = self.entries.lock() {
            entries.push(entry);
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn mode_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(MODE_FILE))
}

/// Reads the persisted mode; anything unreadable means "off" (Tauri defaults).
pub fn handlers_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    mode_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("handlers").and_then(|h| h.as_bool()))
        .unwrap_or(false)
}

/// Persists the mode for the NEXT launch; the page then relaunches.
#[tauri::command]
pub fn set_handlers<R: Runtime>(app: AppHandle<R>, on: bool) -> Result<(), String> {
    let path = mode_path(&app).ok_or("no app config dir")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    std::fs::write(&path, serde_json::json!({ "handlers": on }).to_string())
        .map_err(|e| format!("write mode: {e}"))
}

#[tauri::command]
pub fn shell_log(log: State<'_, HandlerLog>) -> Vec<LogEntry> {
    log.entries.lock().map(|e| e.clone()).unwrap_or_default()
}

// --- 11b -------------------------------------------------------------------

pub fn on_permission<R: Runtime>(app: &AppHandle<R>, kind: PermissionKind) -> PermissionResponse {
    let response = match kind {
        PermissionKind::Microphone | PermissionKind::Camera => PermissionResponse::Allow,
        _ => PermissionResponse::Default,
    };
    app.state::<HandlerLog>().push(LogEntry {
        kind: "permission",
        detail: format!("{kind:?} -> {response:?}"),
        url: None,
        path: None,
        success: None,
        on_disk_bytes: None,
        at_ms: 0,
    });
    response
}

// --- 15d -------------------------------------------------------------------

/// The app's own download location: Documents on iOS (visible in the Files
/// app with UIFileSharingEnabled), Downloads elsewhere.
fn download_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    #[cfg(target_os = "ios")]
    let dir = app.path().document_dir();
    #[cfg(not(target_os = "ios"))]
    let dir = app.path().download_dir();
    dir.or_else(|_| app.path().app_data_dir()).ok()
}

fn safe_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .take(80)
        .collect();
    cleaned.trim_start_matches('.').to_string()
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (1..1000)
        .map(|n| dir.join(format!("{stem}-{n}{ext}")))
        .find(|p| !p.exists())
        .unwrap_or(candidate)
}

/// Enough of the URL to tell the cases apart, without host names or contents.
fn describe_url(url: &Url) -> String {
    match url.scheme() {
        "data" => format!("{}...", url.as_str().chars().take(32).collect::<String>()),
        "blob" => "blob: object URL".into(),
        "http" | "https" => format!("{}://<host>{}", url.scheme(), url.path()),
        other => format!("{other}: URL"),
    }
}

pub fn on_download<R: Runtime>(app: &AppHandle<R>, event: DownloadEvent<'_>) -> bool {
    let log = app.state::<HandlerLog>();
    match event {
        DownloadEvent::Requested { url, destination } => {
            let suggested = destination
                .file_name()
                .and_then(|n| n.to_str())
                .map(safe_name)
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| "download".into());
            let original = destination.display().to_string();
            if let Some(dir) = download_dir(app) {
                let _ = std::fs::create_dir_all(&dir);
                *destination = unique_path(&dir, &suggested);
            }
            if let Ok(mut assigned) = log.assigned.lock() {
                assigned.insert(url.to_string(), destination.clone());
            }
            log.push(LogEntry {
                kind: "download-requested",
                detail: format!("WebKit suggested {original}"),
                url: Some(describe_url(&url)),
                path: Some(destination.display().to_string()),
                success: None,
                on_disk_bytes: None,
                at_ms: 0,
            });
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            let assigned = log.assigned.lock().ok().and_then(|mut a| a.remove(url.as_str()));
            let on_disk_bytes = assigned
                .as_ref()
                .and_then(|p| std::fs::metadata(p).ok())
                .map(|m| m.len());
            log.push(LogEntry {
                kind: "download-finished",
                detail: format!(
                    "path reported by the webview: {}; destination assigned: {}",
                    path.as_ref()
                        .map(|p| format!("{:?}", p.display().to_string()))
                        .unwrap_or_else(|| "none".into()),
                    assigned
                        .as_ref()
                        .map(|p| p.display().to_string())
                        .unwrap_or_else(|| "unknown".into())
                ),
                url: Some(describe_url(&url)),
                path: path.map(|p| p.display().to_string()),
                success: Some(success),
                on_disk_bytes,
                at_ms: 0,
            });
            true
        }
        _ => true,
    }
}

// --- 15c -------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReport {
    cancelled: bool,
    path_form: String,
    path: String,
    bytes_written: u64,
    written_sha256: String,
    read_back_bytes: Option<u64>,
    read_back_sha256: Option<String>,
    read_back_error: Option<String>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Shows the native save dialog for `file-name` (request header), writes the
/// raw request body to the place the person chose, then reads it back. The
/// page gets no dialog or fs permission: this command is the whole path.
#[tauri::command]
pub async fn save_native<R: Runtime>(
    app: AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<SaveReport, String> {
    let name = request
        .headers()
        .get("file-name")
        .and_then(|v| v.to_str().ok())
        .map(safe_name)
        .filter(|n| !n.is_empty())
        .ok_or("missing or invalid file-name header")?;
    let bytes: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(raw) => raw.clone(),
        tauri::ipc::InvokeBody::Json(json) => {
            serde_json::from_value(json.clone()).map_err(|e| format!("body: {e}"))?
        }
    };
    if bytes.len() > MAX_SAVE_BYTES {
        return Err(format!("body larger than {MAX_SAVE_BYTES} bytes"));
    }

    // Blocks this worker thread until the person answers; never the main thread.
    let Some(path) = app.dialog().file().set_file_name(&name).blocking_save_file() else {
        return Ok(SaveReport {
            cancelled: true,
            path_form: String::new(),
            path: String::new(),
            bytes_written: 0,
            written_sha256: String::new(),
            read_back_bytes: None,
            read_back_sha256: None,
            read_back_error: None,
        });
    };
    let path_form = match &path {
        FilePath::Url(url) => format!("{} URL", url.scheme()),
        FilePath::Path(_) => "absolute path".to_string(),
    };
    let shown = path.to_string();

    let fs = app.fs();
    let mut options = OpenOptions::new();
    options.read(false).write(true).create(true).truncate(true);
    let mut file = fs
        .open(path.clone(), options)
        .map_err(|e| format!("open for writing failed ({path_form} {shown}): {e}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.flush())
        .map_err(|e| format!("write failed ({path_form} {shown}): {e}"))?;
    let _ = file.sync_all();
    drop(file);

    let read_back = fs.read(path.clone());
    #[cfg(target_os = "ios")]
    let _ = fs.stop_accessing_security_scoped_resource(path.clone());

    let (read_back_bytes, read_back_sha256, read_back_error) = match read_back {
        Ok(data) => (Some(data.len() as u64), Some(sha256_hex(&data)), None),
        Err(e) => (None, None, Some(e.to_string())),
    };
    Ok(SaveReport {
        cancelled: false,
        path_form,
        path: shown,
        bytes_written: bytes.len() as u64,
        written_sha256: sha256_hex(&bytes),
        read_back_bytes,
        read_back_sha256,
        read_back_error,
    })
}
