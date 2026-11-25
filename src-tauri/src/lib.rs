//! ALM-109 device probe shell.
//!
//! Mirrors the design under test:
//! - the page has NO static http scope; `connect(address)` grants the http plugin
//!   scope for exactly one strict https origin at run time (`Manager::add_capability`,
//!   tauri `dynamic-acl` feature) and stores that origin in memory and in the app
//!   config dir; on launch only the stored origin is granted again;
//! - the page never gets the websocket plugin's `connect` permission; the
//!   `socket_*` commands below are the only way it opens a socket, and they dial
//!   only `wss://<stored host:port>/...`.
//!
//! `native.rs` holds the fix-path pieces (download handler, media permission
//! handler, native save); see the comment there for the shell mode.

mod native;
mod origin;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex, OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use serde::Serialize;
use tauri::{
    ipc::{CapabilityBuilder, Channel},
    AppHandle, Manager, Runtime, State,
};
use tokio_tungstenite::{
    tungstenite::{
        client::IntoClientRequest,
        protocol::{frame::coding::CloseCode, CloseFrame},
        Message,
    },
    MaybeTlsStream, WebSocketStream,
};

const MAIN_WINDOW: &str = "main";
const ADDRESS_FILE: &str = "probe-address.json";
const STATE_FILE: &str = "probe-state.json";

/// Wall-clock time this process started; lets the page tell a real restart
/// from a page reload.
static PROCESS_STARTED_MS: OnceLock<u64> = OnceLock::new();

type WsSink = SplitSink<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>, Message>;

#[derive(Default)]
struct Shell {
    /// The one stored origin (memory copy of `probe-address.json`).
    stored: Mutex<Option<String>>,
    /// Every origin granted to the http plugin during this process lifetime.
    /// Runtime capabilities cannot be removed again, so this only grows.
    granted: Mutex<Vec<String>>,
    sockets: tokio::sync::Mutex<HashMap<u32, WsSink>>,
    next_socket: AtomicU32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellStatus {
    stored: Option<String>,
    granted: Vec<String>,
    os: &'static str,
    arch: &'static str,
    tauri_version: &'static str,
    app_version: String,
    identifier: String,
    config_dir: Option<String>,
    process_started_ms: u64,
    /// Whether this process runs with the webview handlers (11b, 15d).
    handlers: bool,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SocketEvent {
    Text { data: String },
    Binary { len: usize },
    Close { code: Option<u16>, reason: Option<String> },
    Error { message: String },
    Ended,
}

fn config_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))
}

fn grant_http<R: Runtime>(app: &AppHandle<R>, shell: &Shell, origin: &str) -> Result<(), String> {
    let mut granted = shell.granted.lock().map_err(|_| "lock poisoned")?;
    if granted.iter().any(|g| g == origin) {
        return Ok(());
    }
    // One capability per origin, bound to the main window, local content only.
    // The scope entry is the bare origin; the http plugin turns an empty path
    // into `*` (any path on that origin) and keeps host and port exact.
    let capability = CapabilityBuilder::new(format!("runtime-http-{}", granted.len() + 1))
        .window(MAIN_WINDOW)
        .local(true)
        .permission_scoped(
            "http:default",
            vec![serde_json::json!({ "url": origin })],
            Vec::<serde_json::Value>::new(),
        );
    app.add_capability(capability).map_err(|e| e.to_string())?;
    granted.push(origin.to_string());
    Ok(())
}

fn stored_origin(shell: &Shell) -> Result<String, String> {
    shell
        .stored
        .lock()
        .map_err(|_| "lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "no address stored; call connect first".to_string())
}

/// Grants the http scope for exactly `address` and stores it.
#[tauri::command]
fn connect<R: Runtime>(
    app: AppHandle<R>,
    shell: State<'_, Shell>,
    address: String,
) -> Result<String, String> {
    let origin = origin::parse_strict_https_origin(&address)?;
    grant_http(&app, &shell, &origin)?;
    let dir = config_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let body = serde_json::json!({ "origin": origin }).to_string();
    std::fs::write(dir.join(ADDRESS_FILE), body).map_err(|e| format!("write address: {e}"))?;
    *shell.stored.lock().map_err(|_| "lock poisoned")? = Some(origin.clone());
    Ok(origin)
}

/// Measurement 9 only: grants a second origin for this process lifetime WITHOUT
/// storing it, so a restart shows whether a runtime grant outlives the process.
#[tauri::command]
fn grant_for_this_run<R: Runtime>(
    app: AppHandle<R>,
    shell: State<'_, Shell>,
    address: String,
) -> Result<String, String> {
    let origin = origin::parse_strict_https_origin(&address)?;
    grant_http(&app, &shell, &origin)?;
    Ok(origin)
}

#[tauri::command]
fn shell_status<R: Runtime>(
    app: AppHandle<R>,
    shell: State<'_, Shell>,
    mode: State<'_, native::HandlerMode>,
) -> ShellStatus {
    ShellStatus {
        stored: shell.stored.lock().ok().and_then(|s| s.clone()),
        granted: shell.granted.lock().map(|g| g.clone()).unwrap_or_default(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        tauri_version: tauri::VERSION,
        app_version: app.package_info().version.to_string(),
        identifier: app.config().identifier.clone(),
        config_dir: config_dir(&app).ok().map(|p| p.display().to_string()),
        process_started_ms: PROCESS_STARTED_MS.get().copied().unwrap_or_default(),
        handlers: mode.0,
    }
}

/// Opens a socket to `url`, which must be `wss://` on the stored host and port.
/// Messages arrive on `on_event`; the returned id is used by send/close.
#[tauri::command]
async fn socket_open<R: Runtime>(
    app: AppHandle<R>,
    shell: State<'_, Shell>,
    url: String,
    on_event: Channel<SocketEvent>,
) -> Result<u32, String> {
    let stored = stored_origin(&shell)?;
    let target = origin::socket_target(&stored, &url)?;
    // `into_client_request` adds only Host, Connection, Upgrade,
    // Sec-WebSocket-Version and Sec-WebSocket-Key: no Origin header.
    let request = target
        .as_str()
        .into_client_request()
        .map_err(|e| e.to_string())?;
    let (stream, _response) =
        tokio_tungstenite::connect_async_tls_with_config(request, None, false, None)
            .await
            .map_err(|e| format!("socket connect failed: {e}"))?;
    let id = shell.next_socket.fetch_add(1, Ordering::Relaxed) + 1;
    let (sink, mut source) = stream.split();
    shell.sockets.lock().await.insert(id, sink);

    tauri::async_runtime::spawn(async move {
        while let Some(message) = source.next().await {
            let event = match message {
                Ok(Message::Text(text)) => SocketEvent::Text {
                    data: text.as_str().to_owned(),
                },
                Ok(Message::Binary(bytes)) => SocketEvent::Binary { len: bytes.len() },
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => continue,
                Ok(Message::Close(frame)) => SocketEvent::Close {
                    code: frame.as_ref().map(|f| u16::from(f.code)),
                    reason: frame.as_ref().map(|f| f.reason.as_str().to_owned()),
                },
                Err(e) => SocketEvent::Error {
                    message: e.to_string(),
                },
            };
            let stop = matches!(event, SocketEvent::Error { .. });
            let _ = on_event.send(event);
            if stop {
                break;
            }
        }
        app.state::<Shell>().sockets.lock().await.remove(&id);
        let _ = on_event.send(SocketEvent::Ended);
    });

    Ok(id)
}

#[tauri::command]
async fn socket_send(shell: State<'_, Shell>, id: u32, text: String) -> Result<(), String> {
    let mut sockets = shell.sockets.lock().await;
    let sink = sockets.get_mut(&id).ok_or("no such socket")?;
    sink.send(Message::text(text)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn socket_close(
    shell: State<'_, Shell>,
    id: u32,
    code: u16,
    reason: String,
) -> Result<(), String> {
    let mut sockets = shell.sockets.lock().await;
    let sink = sockets.get_mut(&id).ok_or("no such socket")?;
    sink.send(Message::Close(Some(CloseFrame {
        code: CloseCode::from(code),
        reason: reason.into(),
    })))
    .await
    .map_err(|e| e.to_string())
}

/// Probe results, kept in the app config dir so they survive restarts even if
/// WebKit storage does not (that is measurement 16).
#[tauri::command]
fn state_load<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let path = config_dir(&app)?.join(STATE_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

#[tauri::command]
fn state_save<R: Runtime>(app: AppHandle<R>, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("not JSON: {e}"))?;
    let dir = config_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    std::fs::write(dir.join(STATE_FILE), json).map_err(|e| format!("write state: {e}"))
}

/// On launch, grant only the stored origin again.
fn restore_stored_origin<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = config_dir(app) else { return };
    let Ok(text) = std::fs::read_to_string(dir.join(ADDRESS_FILE)) else {
        return;
    };
    let Some(origin) = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("origin").and_then(|o| o.as_str()).map(str::to_owned))
    else {
        return;
    };
    // Re-validate: the file is outside the binary and could have been edited.
    let Ok(origin) = origin::parse_strict_https_origin(&origin) else {
        return;
    };
    let shell = app.state::<Shell>();
    if grant_http(app, &shell, &origin).is_ok() {
        if let Ok(mut stored) = shell.stored.lock() {
            *stored = Some(origin);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default();
    let _ = PROCESS_STARTED_MS.set(now_ms);

    // The websocket plugin installs this provider too; doing it here makes the
    // shell's own dialer independent of plugin initialisation order.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .manage(Shell::default())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notifications::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(native::HandlerLog::default())
        .setup(|app| {
            restore_stored_origin(app.handle());
            // The main window has `"create": false` in tauri.conf.json and is
            // built here, so the webview handlers can be attached or not.
            let handlers = native::handlers_enabled(app.handle());
            app.manage(native::HandlerMode(handlers));
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == MAIN_WINDOW)
                .cloned()
                .ok_or("tauri.conf.json has no main window")?;
            let mut window = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
            if handlers {
                let for_downloads = app.handle().clone();
                let for_permissions = app.handle().clone();
                window = window
                    .on_download(move |_webview, event| native::on_download(&for_downloads, event))
                    .on_permission_request(move |_webview, kind| {
                        native::on_permission(&for_permissions, kind)
                    });
            }
            window.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connect,
            grant_for_this_run,
            shell_status,
            socket_open,
            socket_send,
            socket_close,
            state_load,
            state_save,
            native::set_handlers,
            native::shell_log,
            native::save_native,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the probe");
}
