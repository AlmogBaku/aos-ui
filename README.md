# ALM-109 device probe

A throwaway Tauri 2 app for iPhone and Mac, plus a small listener. Its report
has 37 rows: the 22 original WebKit/Tauri measurements (plus 9r), and the
rows that check everything the web app does — microphone, uploads, downloads,
playback, clipboard, wake lock — including, where Tauri's default fails, the
fix path (11b permission handler, 15c native save, 15d download handler).
Every line says **PASS**, **FAIL** or **N/A** (could not be measured, with
the reason) and what was actually observed.

> **Never paste the APNs `.p8` key or the device token into chat, a ticket or
> a file in this directory.** The app's report never contains the token (only
> its length and first 4 characters), and `send-push.sh` never prints either.

What you need: a Mac with Xcode, an iPhone, a paid Apple Developer account,
and Tailscale on both devices. Budget about an hour the first time (the first
Rust build alone takes several minutes per platform).

---

## 1. Prerequisites on the Mac

From the Tauri prerequisites page (<https://v2.tauri.app/start/prerequisites/>):

1. **Xcode** from the Mac App Store; open it once so it finishes installing.
   Add your Apple ID in Xcode > Settings > Accounts.
2. **Homebrew**: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
3. **CocoaPods** and **XcodeGen**: `brew install cocoapods xcodegen`
4. **Rust** (stable 1.88 or newer; this probe was checked with 1.98):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   rustup update stable
   rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim
   ```
5. **Bun** (checked with 1.4.2): `curl -fsSL https://bun.sh/install | bash`
6. On the iPhone: install **Tailscale** and sign in to the same tailnet, and
   turn on **Developer Mode** (Settings > Privacy & Security > Developer Mode).
7. In the tailnet admin console, MagicDNS and HTTPS certificates must be on
   (`tailscale serve` needs them).

## 2. Get the probe on the Mac

```bash
git clone --branch almogbaku/alm-109-device-probe --single-branch \
  https://github.com/AlmogBaku/aos-ui.git alm-109-probe
cd alm-109-probe
bun install
```

This branch holds only the probe. It is throwaway and is never merged. The
repository is public: commit nothing from `probe.identity.json` edits, signing
files or results back to it.

## 3. Apple-side setup (once)

In <https://developer.apple.com/account/resources>:

1. **App ID**: Identifiers > + > App IDs > App. Choose an explicit Bundle ID,
   for example `com.yourname.aosprobe`, and tick **Push Notifications**.
2. **APNs auth key**: Keys > + > tick **Apple Push Notifications service
   (APNs)** (if asked, allow both Sandbox and Production). Download
   `AuthKey_<KEYID>.p8` — Apple lets you download it **once**. Keep it
   **outside** this directory, for example:
   ```bash
   mkdir -p ~/Secure && mv ~/Downloads/AuthKey_*.p8 ~/Secure/ && chmod 600 ~/Secure/AuthKey_*.p8
   ```
   Note the 10-character Key ID shown on the key's page.
3. Your **Team ID** (10 characters) is under Membership details.
4. Only for the Mac push lines (20–22 on macOS): a **Developer ID
   Application** certificate in your keychain (only the Account Holder can
   create one), and a **Developer ID provisioning profile** for the App ID
   (Profiles > + > Distribution > Developer ID). Download the
   `.provisionprofile` to somewhere outside this directory, e.g. `~/Secure/`.

## 4. The three values to fill in

Edit **`probe.identity.json`** (the only file you edit):

| Key | Value |
|---|---|
| `identifier` | the App ID's Bundle ID from step 3.1 |
| `productName` | the app name, e.g. `AOS Probe` |
| `appleTeamId` | your Team ID from step 3.3 |
| `macosProvisioningProfile` | optional: absolute path of the Developer ID profile from step 3.4 |

Then:

```bash
bun run configure
```

This writes the values into `src-tauri/tauri.conf.json` (bundle identifier,
app name, `bundle > iOS > developmentTeam`) and, if a profile is set, the Mac
push-build files. Run it again whenever you change the file.

## 5. Start the listener and put it on the tailnet

On the Mac (or any tailnet machine with Bun), in this directory:

```bash
bun run listener 8443          # serves http://127.0.0.1:8443 only, logs headers
```

In a second terminal on the same machine:

```bash
tailscale serve status         # note any mappings you already have
tailscale serve --bg --https=8443 http://127.0.0.1:8443
tailscale serve status         # shows https://<machine>.<tailnet>.ts.net:8443
```

The listener address you type into the app is that origin, for example
`https://my-mac.tail1234.ts.net:8443` — no path, no trailing text. Check it
from the iPhone's Safari: `https://<machine>.<tailnet>.ts.net:8443/healthz`
should say `alm-109 probe listener ok`.

Optional self-check of the listener (runs on 127.0.0.1, no tailnet):
`bun run listener:selftest`.

## 6. Build and run

All commands run in this directory. Every run serves the bundled page at
`tauri://localhost` (the scripts pass `--no-dev-server`; the app's header
warns if the page origin is anything else).

### iPhone (do this first; it covers everything)

```bash
bun run ios:init         # creates src-tauri/gen/apple (once per identifier)
bun run ios:after-init   # adds the push entitlement + localized strings, regenerates the Xcode project
bun run ios:dev          # builds, installs and launches on the connected iPhone (pick it when asked)
```

If the device is not offered, use `bun run ios:open` instead, pick the iPhone
in Xcode's toolbar and press Run (keep the terminal running while Xcode is
open). If you change `probe.identity.json` later: `bun run configure`, delete
`src-tauri/gen/apple`, then repeat these three commands.

The app stays installed after the run; for the "closed app" tests quit it
(swipe it away in the app switcher) and open it from the home screen.

### Mac

- Quick run (no deep links, no push): `bun run mac:dev`
- Installed app (deep links work; push N/A):
  ```bash
  bun run mac:app
  cp -R "src-tauri/target/debug/bundle/macos/AOS Probe.app" /Applications/
  open "/Applications/AOS Probe.app"
  ```
  (Use your `productName` in the path if you changed it.)
- **Developer ID signed build for the push lines** (needs step 3.4 and
  `macosProvisioningProfile` set, then `bun run configure`):
  ```bash
  security find-identity -v -p codesigning     # copy the "Developer ID Application: ..." name
  export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
  bun run mac:push-app
  cp -R "src-tauri/target/release/bundle/macos/AOS Probe.app" /Applications/
  open "/Applications/AOS Probe.app"
  ```
  What this build needs for push: the Developer ID certificate, the Developer
  ID provisioning profile embedded as `Contents/embedded.provisionprofile`
  (done by the config overlay), and the entitlements
  `com.apple.developer.aps-environment` (value taken from the profile, normally
  `production`), `com.apple.application-identifier` and
  `com.apple.developer.team-identifier` (written by `bun run configure`).
  Hardened Runtime is on, with `com.apple.security.device.audio-input` for the
  microphone. Notarization is not needed to run a build you made on this Mac.
  This build talks to the **production** APNs server, so use
  `--env production` with `send-push.sh`.

If macOS still says the app "can't be opened", check
`codesign -dv --entitlements - "/Applications/AOS Probe.app"` and tell us what
it prints (it contains no secrets).

## 7. Run the tests, in this order

Do the whole list on the iPhone, then again on the Mac. The app starts with
**shell handlers OFF** (Tauri's defaults); part B switches them on. The page
header and the "Shell handlers" card show the current mode, and rows that need
the other mode say so (N/A) instead of measuring the wrong thing.

**A. Handlers OFF (first launch)**

1. Type the listener address, press **Connect**, then **Run all** (covers 1–5,
   7, 8, 10, 12–14, 17). Measurement 1 sends 25 MB; give it a minute.
2. **6**: press 6a, wait for a tick, leave the app 60 s (iPhone: home screen;
   Mac: Cmd+M), come back, press 6b.
3. **11**: Record 2 s, mark whether a permission prompt appeared, press
   **Play last recording** and mark whether you heard it. Record once more and
   mark again.
4. **15**: press each download button and mark what happened (the baseline:
   no download handler).
5. **15c** (native save): press 15c1, save the file somewhere you can look
   (Mac: Desktop; iPhone: Browse > On My iPhone), check it exists, mark. Same
   for 15c2.
6. **15e**: press Share a file; if a sheet appears try "Save to Files"; mark.
7. **23** (uploads): 23a pick one file; 23b pick two or more; 23c (iPhone)
   tap the image picker, mark which options the sheet offers (Photo Library /
   Take Photo / Choose File), then pick a photo; 23d (Mac) drag a file from
   Finder onto the dashed box. Each pick is read and sent to the listener.
8. **24**: press 24a and mark heard/not heard; press 24b, wait 3 s for the
   tone, mark.
9. **25**: press 25a (on iPhone tap the Paste button if it appears), 25b and
   25c. **26**: press Request wake lock.
10. **19**: Open https://example.com/ and mark where it opened.
11. **18** (while running): open `aosprobe://agent-1/session-1` — iPhone: type
    it into Safari's address bar; Mac: `open 'aosprobe://agent-1/session-1'`.
12. **20**: Register for push, allow notifications, press **Copy full token**.
    On the Mac the token is now on the clipboard (from the iPhone via
    Universal Clipboard, same Apple ID with Handoff on).
13. Quit the app fully. **18** (cold start): open the same `aosprobe://` link
    again; the app opens and records it. Quit the app fully again.
14. **21/22**: with the app closed, on the Mac run (all values are arguments;
    the token comes straight from the clipboard and is never shown):
    ```bash
    scripts/send-push.sh --key-file ~/Secure/AuthKey_ABC123DEFG.p8 --key-id ABC123DEFG \
      --team-id <TEAMID> --bundle-id <identifier> --env sandbox --token "$(pbpaste)"
    ```
    `--env sandbox` for the iPhone dev build, `--env production` for the
    Developer ID Mac build. Look at the notification (21), then tap it (22):
    the app opens and records the payload. Then press the matching 21 button.
    To see the Hebrew text, set the iPhone language to Hebrew and send again.
15. **11** again after this restart (does the prompt come back?), and look at
    **16** (it is measured on every launch after the first).

**B. Handlers ON**

16. In the "Shell handlers" card press **Restart with handlers ON** (on the
    iPhone, open the app again if it does not come back by itself).
17. **11b**: Record, mark the prompt, play back, mark heard. The row also says
    whether the shell's permission handler was asked.
18. **15d**: press 15d1, 15d2 and 15d3 (connect first for 15d3). After each,
    look for the file (Mac: Downloads folder; iPhone: Files > On My iPhone >
    the app's folder) and mark there / not there.
19. Press **Restart with handlers OFF**.

**C. Last**

20. **9**: press 9a. The app grants example.com for this run, then asks to
    relaunch itself. If it does not come back by itself, open it again. On the
    next launch 9 is measured automatically; then press the matching 9r
    button.
21. Press **Copy results** (or **Show results as text** and copy it).

Results are kept across restarts; **Clear all results** (press twice) starts
over. Files the probe saved: delete them from Downloads / Desktop / Files
when you are done.

## 8. Send the report back

Paste the copied results text into the chat or ticket. It contains no key, no
token and no tailnet host name (the host is replaced by `<listener-host>`).
Please do not add screenshots of the token or of `send-push.sh` arguments.

## 9. Clean up

1. Delete the app: iPhone — long-press the icon > Remove App > Delete App
   (this also removes the files 15d saved in the app's folder).
   Mac — quit it, move `/Applications/AOS Probe.app` to the Trash, and remove
   its data: `rm -rf ~/Library/Application\ Support/<identifier> ~/Library/WebKit/<identifier> ~/Library/Caches/<identifier>`.
   Remove the files the probe saved: `rm -f ~/Downloads/alm109-probe-* ~/Desktop/alm109-probe-*`
   (and any you saved elsewhere with 15c).
2. Stop the listener (Ctrl+C) and remove only the mapping you added:
   ```bash
   tailscale serve --https=8443 off
   tailscale serve status        # should match what you noted before
   ```
3. Delete the directory: `rm -rf ./alm-109-probe`, and ask for the
   `almogbaku/alm-109-device-probe` branch to be deleted.
4. Optional, in the developer portal: revoke the APNs key and delete the App
   ID / provisioning profile if you made them only for this probe. Delete the
   `.p8` from `~/Secure` if you revoke the key.

## Troubleshooting

- `ios:dev` fails with a signing error: open `bun run ios:open`, select the
  `*_iOS` target > Signing & Capabilities, confirm your team, and that "Push
  Notifications" is listed. Then Run from Xcode.
- Swift build error mentioning `swiftbuild` while building the notifications
  plugin: `export TAURI_PLUGIN_SWIFT_BUILD_SYSTEM=native` and build again.
- `BadDeviceToken` from send-push.sh: `--env` does not match the build.
- Measurement 20 on `mac:dev` / `mac:app` reports N/A: expected; push on the
  Mac only works in the Developer ID build.
