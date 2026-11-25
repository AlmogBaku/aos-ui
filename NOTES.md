# NOTES — sources, pins, deviations, open questions

Throwaway probe for ALM-109. Built on Linux (aarch64, no Xcode) on 2026-11-23.
Every non-obvious choice below cites the source it was checked against.
"Source" means the published crate/npm tarball of the pinned version (read
from `~/.cargo/registry` after `cargo fetch`, or the npm tarball), which is
what the Mac will compile.

## Pinned versions

Rust (`src-tauri/Cargo.toml`, exact `=` pins; full tree in `src-tauri/Cargo.lock`):

| crate | version | why |
|---|---|---|
| tauri | 2.12.7 | feature `dynamic-acl` (also a default feature) |
| tauri-build | 2.7.6 | app manifest for the shell's own commands |
| tauri-plugin-http | 2.9.0 | feature `unsafe-headers` |
| tauri-plugin-websocket | 2.5.0 | registered, permission never granted |
| tauri-plugin-deep-link | 2.6.3 | `aosprobe://` |
| tauri-plugin-opener | 2.7.3 | measurement 19 |
| tauri-plugin-process | 2.4.0 | relaunch for measurement 9 and the handler-mode switch |
| tauri-plugin-dialog | 2.8.4 | 15c save dialog, used from Rust only (no page permission) |
| tauri-plugin-fs | 2.7.1 | 15c write/read-back via its Rust `Fs::open`, Rust only (no page permission); already in the lock through the http plugin |
| tauri-plugin-notifications | 0.5.0-rc.17 | `default-features = false`, feature `push-notifications` |
| tokio-tungstenite | 0.29.0 | the websocket plugin's own client library and version |
| rustls | 0.23.46 | `ring` provider, as the websocket plugin installs |
| tokio | 1.54.1 | |
| futures-util | 0.3.34 | |
| serde / serde_json / url | 1.0.229 / 1.0.154 / 2.5.9 | |
| sha2 | 0.11.1 | 15c read-back hash (already in the lock) |

Resolved in the lock: wry 0.57.3, tauri-runtime-wry 2.12.5, tauri-utils 2.10.4,
tauri-codegen 2.7.6, tungstenite 0.29.0, reqwest 0.12.28 (http plugin).

npm (`package.json`, exact pins; full tree in `bun.lock`):
`@tauri-apps/api` 2.12.5, `@tauri-apps/cli` 2.12.6, `@tauri-apps/plugin-http`
2.9.0, `@tauri-apps/plugin-deep-link` 2.6.3, `@tauri-apps/plugin-opener` 2.7.3,
`@tauri-apps/plugin-process` 2.4.0, `@choochmeque/tauri-plugin-notifications-api`
0.5.0-rc.17, `vite` 8.3.8, `typescript` 7.0.2, `@types/bun` 1.4.5.
`@tauri-apps/plugin-websocket` is deliberately not installed: the page must not
use the plugin. No npm package was added for dialog/fs: the page never calls
them.

The notifications plugin is a pre-release: crates.io/npm `latest` is
0.5.0-rc.17 and the current README documents `0.5` with APNs behind
`push-notifications` (<https://github.com/Choochmeque/tauri-plugin-notifications/blob/main/README.md>);
the last stable is 0.4.6.

## How each requirement was met (with sources)

**Runtime http grant.** `connect(address)` parses a strict https origin
(`src-tauri/src/origin.rs`) and calls `Manager::add_capability` with a
`CapabilityBuilder` bound to window `main`, `local(true)`, permission
`http:default` scoped to `{ "url": "<origin>" }`.
- API: <https://docs.rs/tauri/2.12.7/tauri/trait.Manager.html#method.add_capability>,
  `tauri-2.12.7/src/lib.rs` (`#[cfg(feature = "dynamic-acl")] fn add_capability`),
  `src/ipc/capability_builder.rs`.
- The scope entry is a URLPattern; an empty path becomes `*`, search and hash
  become `*`, host and port stay exact (`tauri-plugin-http-2.9.0/src/scope.rs`,
  `parse_url_pattern`). The parser rejects every pattern character so the
  person's input cannot widen it.
- There is no API to remove a runtime capability, so grants accumulate for the
  process lifetime; only a restart drops them. That is what measurement 9 tests.
- `add_capability` unwraps the resolution result
  (`src/ipc/authority.rs:180`), so an unknown permission name panics. The names
  used were validated by a successful `cargo check` (tauri-build resolves
  `capabilities/main.json`; a deliberately misspelt permission makes it fail).
- No static http scope and no wildcard anywhere: `capabilities/main.json` has
  no http permission at all. The page's only static network-ish permissions are
  the shell's own commands.

**Stored address.** Memory (`Shell.stored`) plus `probe-address.json` in
`app_config_dir()`. On launch `setup` re-validates the file and grants only that
origin.

**Socket path.** The websocket plugin's Rust API is only `init()` and
`Builder::tls_connector()`; its `connect`/`send` commands and connection
manager are private (`tauri-plugin-websocket-2.5.0/src/lib.rs:164`, and the
docs page shows no Rust connect: <https://v2.tauri.app/plugin/websocket/>). So
wrapping the plugin from Rust is **not possible**; the shell dials with the same
library the plugin uses (tokio-tungstenite 0.29.0, rustls 0.23 + ring, webpki
roots = the plugin's default `rustls-tls` feature). The plugin is still
registered, but `websocket:*` is never granted; measurement 8 invokes
`plugin:websocket|connect` directly as a negative control.
`socket_open(url)` accepts only `wss://` on exactly the stored host and port, no
credentials, no fragment (`origin.rs`, `socket_target`). The upgrade request
carries only Host, Connection, Upgrade, Sec-WebSocket-Version and
Sec-WebSocket-Key (`tungstenite-0.29.0/src/handshake/client.rs`, `generate_request`).

**App commands are ACL-checked.** `build.rs` declares an app manifest. Without
one, Tauri lets *local* pages call any app command
(`tauri-2.12.7/src/webview/mod.rs:2080`). The capability grants
`allow-connect`, `allow-socket-open`, ... to window `main`, local only.

**Capabilities.** One file, `capabilities/main.json`: `local: true`,
`windows: ["main"]`, no `remote`, listed explicitly in
`app.security.capabilities`.

**tauri.conf.json.** Validated against the CLI 2.12.6 JSON schema (also with
the push overlay merged).
- CSP is the hand-written string from the brief;
  `app.security.dangerousDisableAssetCspModification: true` (key and
  `bool | string[]` shape: `tauri-utils-2.10.4/src/config.rs`,
  `DisabledCspModificationKind`; <https://v2.tauri.app/reference/config/>).
  Vite emits no inline script (`modulePreload.polyfill: false`,
  `assetsInlineLimit: 0`), so `script-src 'self'` holds without nonces.
- Window: `titleBarStyle: "Overlay"`, `hiddenTitle: true`,
  `dragDropEnabled: false` (tauri-utils `WindowConfig`).
- `plugins.http.scopeRedirects: true` — see deviation 2.
- Deep link: `plugins.deep-link.mobile: [{ scheme: ["aosprobe"], appLink: false }]`
  and `desktop.schemes` (<https://v2.tauri.app/plugin/deep-linking/>,
  `tauri-plugin-deep-link-2.6.3/src/config.rs`). On macOS deep links only work
  for a bundled app installed in /Applications (same page).
- Info.plist: `src-tauri/Info.plist` (microphone text,
  `ITSAppUsesNonExemptEncryption=false`, `en`/`he` localizations) is merged by
  the CLI into the iOS Info.plist (`tauri-cli-2.12.6/src/mobile/ios/build.rs:246-269`,
  `dev.rs:227-249`) and by the bundler into the macOS one.
- `bundle.macOS.minimumSystemVersion: "13.0"`: `tauri build` exports it as
  `MACOSX_DEPLOYMENT_TARGET` (`tauri-cli/src/build.rs:118`) and the
  notifications plugin's Swift package requires macOS 13.
  `bundle.iOS.minimumSystemVersion: "15.0"` for the same package's `.iOS(.v15)`.

**The one place to edit.** `probe.identity.json` → `bun run configure` writes
`identifier`, `productName`, window title and `bundle.iOS.developmentTeam`
(the CLI also honours `APPLE_DEVELOPMENT_TEAM`,
`tauri-cli/src/mobile/ios/mod.rs:212`). JSON has no comments, hence a separate
file plus a script rather than "edit these lines".

**Bundled page in every run.** `tauri dev` without `devUrl` starts a built-in
static server at `http://localhost:1430` (`tauri-cli-2.12.6/src/dev.rs:239`),
which would make the page origin `http://`. All scripts pass
`--no-dev-server`; with no dev URL, codegen embeds `frontendDist`
(`tauri-codegen-2.7.6/src/context.rs:178`) and the page loads from
`tauri://localhost`. The page header warns if it is not.

**iOS push entitlement and localized strings.** Tauri has no config key for iOS
entitlements (`IosConfig` fields: template, frameworks, developmentTeam,
bundleVersion, minimumSystemVersion, infoPlist), and `bundle.resources` is
copied into the `assets` folder reference (`tauri-cli/src/mobile/ios/mod.rs:466`,
`templates/mobile/ios/project.yml`), not the bundle root where iOS resolves
`loc-key`. XcodeGen only runs at `ios init` (`tauri-cli/src/mobile/ios/project.rs:205`).
Hence `scripts/ios-after-init.sh`: PlistBuddy adds `aps-environment=development`,
copies `en.lproj`/`he.lproj` into `gen/apple/<name>_iOS/`, reruns XcodeGen.
On macOS the same strings go to `Contents/Resources/<lang>.lproj` through
`bundle.resources`. Apple: loc keys are looked up in the app bundle's
`Localizable.strings`
(<https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification>,
read through its JSON data endpoint because the page is script-rendered).

**macOS push (Developer ID).** The plugin uses its native macOS backend (the
only one with APNs) only when `notify-rust` is off
(`tauri-plugin-notifications-0.5.0-rc.17/src/lib.rs`, `cfg(all(target_os = "macos", not(feature = "notify-rust")))`),
and refuses outside an app bundle (`src/macos.rs`, `validation::require_bundle`).
The push build needs: Developer ID Application certificate
(<https://v2.tauri.app/distribute/sign/macos/>), a Developer ID provisioning
profile for the App ID with Push enabled, embedded via
`bundle.macOS.files: { "embedded.provisionprofile": <path> }`, and entitlements
`com.apple.developer.aps-environment` (value read from the profile by
`configure` on a Mac, else `production`), `com.apple.application-identifier`,
`com.apple.developer.team-identifier`, plus
`com.apple.security.device.audio-input` because Hardened Runtime is on. The
overlay is only written when a profile path is set, because a signature that
claims the push entitlement without a matching embedded profile is killed at
launch.

**send-push.sh.** Token-based APNs: ES256 JWT with `kid`, `iss`, `iat`;
`authorization: bearer`; HTTP/2 POST to `/3/device/<token>`; `apns-topic`,
`apns-push-type: alert`, `apns-priority: 10`
(<https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns>,
<https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns>,
both read through Apple's JSON data endpoint). openssl's DER signature is
converted to raw r||s in bash (bash 3.2 compatible). JWT and token go to curl
through a mode-600 temp config file, never argv/stdout. Custom keys
`agentId`/`sessionId` are top-level strings because the iOS plugin forwards
only top-level string values of `userInfo` on a tap
(`ios/Sources/NotificationHandler.swift:78`, `extraStrings`).

**Push behaviour that shapes the tests** (plugin source, iOS):
- a push that arrives while the app is in the foreground is not displayed
  (`NotificationHandler.swift:51`, `willPresent` returns no options) — 21 needs
  the app closed;
- a tap before any listener exists is queued and delivered when
  `onNotificationClicked` registers (`NotificationHandler.swift:158`); the page
  registers it at startup;
- `registerForPushNotifications` requests permission, then waits up to 10 s for
  the token (`NotificationPlugin.swift:163`).

## Fix-path rows (added 2026-11-25)

Requirement: everything the web app does (microphone, uploads, downloads, …)
must work in the app, so where Tauri's default fails the probe also measures
the fix. Rows now: 37 (22 original measurements + 9r + 14 new).

**Shell handler mode.** A webview download handler and a media permission
handler change Tauri's default, which rows 11 and 15 measure. So they are
installed only when `probe-shell-mode.json` (app config dir) says
`{"handlers": true}`; the "Shell handlers" card writes it (`set_handlers`) and
relaunches. To make this possible the main window has `"create": false` and is
built in `setup` with `WebviewWindowBuilder::from_config`
(<https://docs.rs/tauri/2.12.7/tauri/webview/struct.WebviewWindowBuilder.html#method.from_config>;
`create` documented in `tauri-utils-2.10.4/src/config.rs`, WindowConfig). Rows
that need the other mode report N/A instead of measuring the wrong thing.

**11b — media permission handler.** `WebviewWindowBuilder::on_permission_request`
(<https://docs.rs/tauri/2.12.7/tauri/webview/struct.WebviewWindowBuilder.html#method.on_permission_request>):
"macOS / iOS: Fully supported via WKUIDelegate's requestMediaCapturePermission".
The shell answers `Microphone`/`Camera` with `Allow`, everything else
`Default`, and logs each call (`shell_log`), so 11b says whether it was asked.
Note the baseline: with no handler wry already answers `Grant`
(`wry-0.57.3/src/wkwebview/class/wry_web_view_ui_delegate.rs:173`), and a
handler returning `Default` maps to WebKit's own prompt; the doc also says the
handler only fires for requests WebKit has not already decided. 11 and 11b now
also report `navigator.mediaDevices`, `enumerateDevices()` counts before and
after, `MediaRecorder.isTypeSupported` for `audio/mp4`, `audio/webm`,
`audio/webm;codecs=opus`, and a playback the person marks heard / not heard.

**15c — native save (the path the real app will use).** One app command,
`save_native`: the page sends the bytes as the raw IPC body with a `file-name`
header; the shell shows the save dialog (`tauri-plugin-dialog`
`FileDialogBuilder::blocking_save_file`,
<https://docs.rs/tauri-plugin-dialog/2.8.4/tauri_plugin_dialog/struct.FileDialogBuilder.html#method.blocking_save_file>,
<https://v2.tauri.app/plugin/dialog/>: "On iOS, a `file://<path>` URIs are
returned"), writes with the fs plugin's Rust `Fs::open`
(<https://docs.rs/tauri-plugin-fs/2.7.1/tauri_plugin_fs/struct.Fs.html#method.open>;
its iOS doc: "will automatically start accessing a security-scoped resource if
the path is a file URL", `tauri-plugin-fs-2.7.1/src/ios.rs`), reads the same
path back (size + sha256), then on iOS calls
`stop_accessing_security_scoped_resource`. Why Rust and not the page's
`dialog.save` + `fs.writeFile`: both use the same fs code on iOS, but the JS
route needs `dialog:allow-save` and `fs:allow-write-file` (plus the dialog's
runtime scope grant, `tauri-plugin-dialog-2.8.4/src/commands.rs:252`), and the
read-back would need `fs:allow-read-file`. Here the page gets neither a write
nor a read primitive, only "save these bytes where the person chooses".
Source detail that matters on iOS: the save dialog is
`UIDocumentPickerViewController(url:in: .exportToService)` of an empty
placeholder it first writes to the app's Documents folder
(`ios/Sources/DialogPlugin.swift:138-176`), so the returned URL is the
exported copy and the probe measures whether a later write to it lands. The
placeholder stays in Documents. The two cases are a deterministic 1 MiB
binary (15c1) and a short UTF-8 text with non-Latin characters (15c2); the
person also marks whether the file is really there.

**15d — download handler.** `WebviewWindowBuilder::on_download`
(<https://docs.rs/tauri/2.12.7/tauri/webview/struct.WebviewWindowBuilder.html#method.on_download>;
`DownloadEvent` docs: "macOS: The second parameter indicating the path the
file was saved to is always empty, due to API limitations"). wry's WKWebView
download delegate is not macOS-only (`wry-0.57.3/src/wkwebview/mod.rs:623-641`,
WKDownload needs iOS 14.5+ / macOS 11.3+, `navigation.rs:71`), so iOS is
measured, not marked N/A. On `Requested` the shell sets the destination to the
app's location (iOS: `document_dir()`; elsewhere: `download_dir()`), records it,
and on `Finished` checks the file on disk itself, because the reported path may
be empty. Three cases: blob `<a download>`, data `<a download>`, and a plain
link to the listener's new `/attachment` endpoint (`Content-Disposition:
attachment`; with a handler wry turns that response into a download,
`navigation.rs`, `navigation_policy_response`). Without a handler the
attachment would be displayed in place of the app page, so it is only in 15d.

**15e — share sheet.** Measured through the Web Share API
(`navigator.canShare({files})`, `navigator.share`,
<https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share>). A
native share-sheet plugin is N/A: Tauri has no official one.

**23a–d — uploads.** `<input type="file">` single, `multiple`,
`accept="image/*"` (the person marks which sources the iOS sheet offers), and
on the Mac an HTML5 drop with `dragDropEnabled: false` (the page prevents the
default drop elsewhere so a missed drop cannot navigate away). Each file is
read with both `Blob.arrayBuffer()` and `FileReader`, then POSTed through the
native http path to the listener, which answers with byte count + sha256
(`/upload`). wry implements the macOS open panel
(`wry_web_view_ui_delegate.rs`, `runOpenPanelWithParameters`); on iOS WebKit
presents its own picker.

**24 playback, 25 clipboard, 26 wake lock.** A generated 0.8 s WAV from a blob
URL played via `new Audio()` right after a tap and 3 s after it (new element,
no new gesture), plus `AudioContext` state at load and after a tap +
`resume()`. Clipboard: `writeText` + `readText` round trip, a PNG through
`ClipboardItem` (promise form, which WebKit accepts inside the gesture), and
`document.execCommand('copy')`, each on its own button so a consumed gesture
cannot hide which one fails
(<https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API>). Wake lock:
`navigator.wakeLock.request('screen')`
(<https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API>).

**Permissions added** (capability `main`, local, window `main`):
`allow-set-handlers` (write the mode file), `allow-shell-log` (read the
handlers' call log), `allow-save-native` (15c). No `dialog:*` and no `fs:*`
permission, so no standing fs path scope and no read permission; the dialog
and fs plugins are registered for the shell's own Rust use only.

**Info.plist keys added.** Shared (`src-tauri/Info.plist`):
`NSCameraUsageDescription` — "required if your app uses APIs that access the
device's camera"
(<https://developer.apple.com/documentation/bundleresources/information-property-list/nscamerausagedescription>);
the "Take Photo" option of a file input is such an API and the app is
terminated without the key. `NSPhotoLibraryUsageDescription`
(<https://developer.apple.com/documentation/bundleresources/information-property-list/nsphotolibraryusagedescription>)
— possibly unnecessary because WebKit's photo picker runs out of process, but
added so a missing key cannot crash 23c; the device run shows whether a prompt
appears. iOS only (`src-tauri/Info.ios.plist`, merged after Info.plist by the
CLI, `tauri-cli-2.12.6/src/mobile/ios/build.rs:252`): `UIFileSharingEnabled`
and `LSSupportsOpeningDocumentsInPlace`
(<https://developer.apple.com/documentation/bundleresources/information-property-list/uifilesharingenabled>,
<https://developer.apple.com/documentation/bundleresources/information-property-list/lssupportsopeningdocumentsinplace>),
so the app's Documents folder, where 15d saves on iOS, shows up in the Files
app for the person to check. (The fs plugin docs also ask for a
`PrivacyInfo.xcprivacy` file-timestamp declaration, which matters for App
Store submission only, not for these dev builds:
<https://v2.tauri.app/plugin/file-system/>.)

**Listener.** New `/attachment?run=` (text body, `Content-Disposition:
attachment; filename="alm109-probe-attachment.txt"`), counted per run in
`/hits`; the selftest checks both.

## Deviations from the brief

1. **Websocket wrapping**: not possible (above); same library instead.
2. **Redirects**: the http plugin follows any redirect by default and checks
   the scope only on the first URL unless `plugins.http.scopeRedirects: true`
   (`tauri-plugin-http-2.9.0/src/config.rs:25`, `commands.rs:190,338`; not on
   the docs page <https://v2.tauri.app/plugin/http-client/>). The probe sets it
   to `true` (the secure setting the real design needs), so measurement 5
   tests that configuration. It also records what `maxRedirections: 0` returns.
   Without this setting 5 would be expected to FAIL.
3. **Downloads (15)** keep Tauri's default as the baseline: no `on_download`
   handler, and wry then cancels `<a download>` navigations
   (`wry-0.57.3/src/wkwebview/navigation.rs:87`), so "nothing happened" is the
   expected answer. 15c (native save) and 15d (download handler, handlers ON)
   measure the paths that can work.
4. **IPv6 literal listener addresses are rejected** by the strict parser (the
   http scope is a URLPattern, where `[` `]` are syntax). Tailnet names and
   IPv4 work.
5. **Clear results** uses a double press: wry does not implement the JS
   `confirm()` panel, so `confirm()` would always return false.
6. **Results persistence**: results live in `probe-state.json` in the app
   config dir (via two extra shell commands), not in WebKit storage, so a
   storage failure (measurement 16) cannot erase the report.
7. **Getting the probe**: the README now clones the probe branch instead of
   rsync; `node_modules`, `dist`, `src-tauri/target` and `src-tauri/gen` are
   git-ignored, and `bun install` runs on the Mac.
8. **Report privacy**: besides the token rule, the report replaces the
   listener's tailnet host name with `<listener-host>`, hides any 32+ char hex
   run, and records header *names* only (Tailscale Serve adds
   `Tailscale-User-*` identity headers; the listener masks their values in its
   log and echo too).
9. **Measurement 9 second origin** is `https://example.com` (granted for one
   run with an extra `grant_for_this_run` command that grants without
   storing), so no second listener is needed. While that grant is active,
   5 and 8 refuse to run.
10. **Extra rows**: `9r` (did the process plugin's relaunch reopen the app);
    8 also checks a different port on the listener host and a
    `wss://<host>@example.com` credentials trick.

## Verified here (Linux, aarch64)

| step | command | result |
|---|---|---|
| JS install | `bun install` | exit 0 |
| typecheck | `bun run typecheck` (page, listener, scripts) | exit 0 |
| web build | `bun run build` | exit 0, one external module script, no inline script |
| listener | `bun run listener:selftest` | exit 0, 28/28 checks (25 MiB upload hash, stream 20 reads over ~3.8 s, CSP per variant, ws hello/tick/status/close 4001, leak log, attachment header + count) |
| Rust | `cargo check` | fails as expected: no `pkg-config`/webkit2gtk on this host (not installed, per brief) |
| Rust | `PKG_CONFIG=<stub that answers yes> cargo check` | exit 0. A check does not link, so this type-checks `lib.rs`, `native.rs`, `origin.rs`, `build.rs`, `generate_context!` and the capability file against the real crates (Linux cfg only; iOS/macOS-only code paths of plugins are not compiled). Proven able to fail: an injected type error and a misspelt permission both make it exit 101. |
| origin rules | `origin.rs` tests in a standalone harness (url 2.5.9) | 3/3 pass; a mutation (scheme check disabled) makes them fail |
| config | `tauri.conf.json` (+ push overlay) against the CLI 2.12.6 schema | valid |
| send-push.sh | throwaway P-256 key, fake `curl` on PATH | 60/60 JWTs verify with WebCrypto (ES256, kid/iss/iat), URL/topic/push-type right; token and JWT never on stdout; key inside the probe dir refused |
| configure.ts | scratch copy | placeholders refused; values written; push files only with a profile |
| frame script | sandbox.html top-level in WebKit and Chromium (Playwright Docker image) | both run; outer + inner srcdoc report; no bridge objects; `ipc://` fetch fails |
| page | built page in WebKit and Chromium with a mocked Tauri bridge | renders 37 rows, 18 cards and 3 file inputs, no page errors; clicking 11, 15c1, 15d1, 24a, 25c and 26 records results (15d1 correctly N/A with handlers OFF); report text builds |

The stub was a 15-line `/bin/sh` script that prints `-l<name>` for every package and exits 0; the origin harness was a scratch crate with `#[path = "…/src-tauri/src/origin.rs"] mod origin;` and `url = "=2.5.9"`. Both lived in /tmp and are deleted.

Not possible here: building or running anything for Apple, `cargo test` of the
full crate (needs linking), and every measurement itself.

## Could not confirm from docs or source (the device run decides)

- Whether a WKWebView custom-scheme IPC request delivers a 25 MB body intact
  (1). Tauri sends it as the raw body of an `ipc://` request.
- Whether Tailscale Serve and reqwest pass 200 ms chunks through unbuffered (2).
- Whether WebKit honours `frame-ancestors tauri://localhost` / `tauri:` for a
  custom-scheme parent, and what `event.origin` the frame sees for a
  `tauri://localhost` parent (12, 13). Tauri's capabilities page only says that
  "On Linux and Android, Tauri is unable to distinguish between requests from
  an embedded `<iframe>` and the window itself"
  (<https://v2.tauri.app/security/capabilities/>); macOS/iOS are not stated.
  From source: Tauri's IPC scripts are main-frame only
  (`tauri-2.12.7/src/manager/webview.rs:161`), wry's `window.ipc` shim is
  main-frame only, but `window.webkit.messageHandlers.ipc` is a WebKit
  content-world handler visible to all frames; wry passes the *frame's* URL as
  the IPC origin (`wkwebview/class/wry_web_view_delegate.rs:49`) and Tauri
  rejects calls without the per-launch invoke key (`webview/mod.rs:2011`).
  Measurement 14 probes all of these paths and asks the listener whether
  anything leaked.
- Whether a socket survives 60 s in the background on iOS (6).
- Whether the WebKit microphone prompt reappears: wry grants WebKit's media
  capture request itself when no handler is set
  (`wry_web_view_ui_delegate.rs:173`), so only the OS prompt is expected, once
  (11).
- Whether `localStorage`/cookies persist for `tauri://localhost` (16).
- Whether `getCurrent()` returns the cold-start URL on iOS/macOS (18).
- Whether the process plugin can relaunch on iOS: `AppHandle::restart` spawns
  the current binary and exits (`tauri-2.12.7/src/process.rs:74`), which iOS
  does not allow, so a plain exit is expected (9r).
- Whether the iOS notification delegate is installed early enough to receive
  the tap that cold-launches the app (22): the plugin sets
  `UNUserNotificationCenter.delegate` when the plugin object is created during
  Tauri setup (`ios/Sources/NotificationManager.swift`), and whether that is
  before `didFinishLaunching` returns is not visible from source.
- 11b: whether WebKit asks the shell at all for a `tauri://localhost` page,
  and whether `Allow` changes anything compared with wry's built-in `Grant`.
- 15c on iOS: whether writing to the URL returned by the export picker
  succeeds after the export (the plugin returns the exported copy's URL and
  the fs plugin starts security-scoped access on open); and whether a read
  back of that URL is allowed. On macOS the save panel returns a plain path.
- 15d: whether `Finished` reports a path on iOS (the doc says macOS never
  does), and whether WebKit calls the handler for `blob:` and `data:` URLs.
- 23c: whether the photo picker needs `NSPhotoLibraryUsageDescription` at all.
- 24: whether WKWebView under Tauri requires a gesture for `<audio>` playback
  (wry's media playback settings were not traced in source).
- 25/26: clipboard read prompts and Screen Wake Lock availability inside
  WKWebView (MDN documents them for Safari, not for embedded WKWebView).
- `xcodegen` installation: the CLI calls `xcodegen` but no install step was
  found in tauri-cli; the README installs it with Homebrew.
- Apple pages are script-rendered; their content was read through Apple's
  documentation JSON endpoint, not the HTML page.

## Decisions for the person

- Keep `scopeRedirects: true` (deviation 2) or measure the default too?
- The notifications plugin is a release candidate; acceptable for the real
  design, or wait for 0.5.0?
