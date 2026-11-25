fn main() {
    // Declaring the app's own commands in an app manifest makes Tauri check
    // them against the capabilities too (without it, local pages may call any
    // app command). The generated permissions are `allow-<command>` with `_`
    // turned into `-`, e.g. `allow-socket-open`.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "connect",
            "grant_for_this_run",
            "shell_status",
            "socket_open",
            "socket_send",
            "socket_close",
            "state_load",
            "state_save",
            "set_handlers",
            "shell_log",
            "save_native",
        ]),
    ))
    .expect("tauri-build failed");
}
