// Copies the values from probe.identity.json (the ONE file you edit) into the
// Tauri config and writes the macOS push-build files.
//
//   bun run configure
//
// Writes: src-tauri/tauri.conf.json (identifier, productName, window title,
// bundle.iOS.developmentTeam), src-tauri/Entitlements.macos-push.plist and
// src-tauri/tauri.macos-push.conf.json. Prints nothing secret.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? join(import.meta.dir, ".."));
const tauriDir = join(root, "src-tauri");

interface Identity {
  identifier: string;
  productName: string;
  appleTeamId: string;
  macosProvisioningProfile?: string;
}

const problems: string[] = [];
const identity = JSON.parse(readFileSync(join(root, "probe.identity.json"), "utf8")) as Identity;

const { identifier, productName, appleTeamId } = identity;
if (!/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/.test(identifier ?? ""))
  problems.push("identifier must be reverse-DNS with letters, digits, '-' and '.', e.g. com.yourname.aosprobe (no '_').");
if (identifier?.startsWith("com.example."))
  problems.push("identifier is still the placeholder com.example.*; use an App ID you registered (see README).");
if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(productName ?? ""))
  problems.push("productName must be 1-40 letters, digits, spaces, '.', '_' or '-'.");
if (!/^[A-Z0-9]{10}$/.test(appleTeamId ?? "") || appleTeamId === "XXXXXXXXXX")
  problems.push("appleTeamId must be your 10-character Apple Team ID (Xcode > Settings > Accounts, or developer.apple.com > Membership).");

let profile = (identity.macosProvisioningProfile ?? "").trim();
let apsEnvironment = "production";
if (profile) {
  if (!isAbsolute(profile)) problems.push("macosProvisioningProfile must be an absolute path.");
  else if (!existsSync(profile)) problems.push(`macosProvisioningProfile does not exist: ${profile}`);
  else {
    profile = realpathSync(profile);
    if (!relative(root, profile).startsWith("..")) problems.push("keep the provisioning profile outside this directory.");
    if (process.platform === "darwin") {
      // Read the entitlements Apple put in the profile, so the signature asks
      // for exactly what the profile allows.
      const decoded = spawnSync("security", ["cms", "-D", "-i", profile], { encoding: "utf8" });
      const xml = decoded.stdout ?? "";
      const value = (key: string) => xml.match(new RegExp(`<key>${key.replace(/\./g, "\\.")}</key>\\s*<string>([^<]*)</string>`))?.[1];
      const aps = value("com.apple.developer.aps-environment");
      const appId = value("com.apple.application-identifier");
      if (decoded.status !== 0) problems.push("could not decode the provisioning profile with `security cms -D -i`.");
      else {
        if (!aps) problems.push("the provisioning profile has no push entitlement; enable Push Notifications on the App ID and download a new Developer ID profile.");
        else apsEnvironment = aps;
        if (appId && appId !== `${appleTeamId}.${identifier}`)
          problems.push(`the provisioning profile is for ${appId}, not ${appleTeamId}.${identifier}.`);
      }
    }
  }
}

if (problems.length) {
  console.error("probe.identity.json needs attention:\n  - " + problems.join("\n  - "));
  process.exit(1);
}

// 1. tauri.conf.json
const confPath = join(tauriDir, "tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.identifier = identifier;
conf.productName = productName;
conf.app.windows[0].title = productName;
conf.bundle.iOS.developmentTeam = appleTeamId;
writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);

// 2 + 3. macOS push build files, only when a Developer ID provisioning profile
// is set: a signature that asks for the push entitlement without an embedded
// profile that grants it is killed by macOS at launch.
const entitlementsPath = join(tauriDir, "Entitlements.macos-push.plist");
const overlayPath = join(tauriDir, "tauri.macos-push.conf.json");
if (profile) {
  const plist = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<!-- Written by scripts/configure.ts for the Developer ID push build. -->`,
    `<plist version="1.0">`,
    `<dict>`,
    `\t<key>com.apple.security.device.audio-input</key>`,
    `\t<true/>`,
    `\t<key>com.apple.developer.aps-environment</key>`,
    `\t<string>${apsEnvironment}</string>`,
    `\t<key>com.apple.application-identifier</key>`,
    `\t<string>${appleTeamId}.${identifier}</string>`,
    `\t<key>com.apple.developer.team-identifier</key>`,
    `\t<string>${appleTeamId}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
  writeFileSync(entitlementsPath, plist);

  // merged by `bun run mac:push-app`
  const overlay: Record<string, unknown> = {
    bundle: {
      macOS: {
        entitlements: "Entitlements.macos-push.plist",
        files: { "embedded.provisionprofile": profile },
      },
    },
  };
  writeFileSync(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`);
} else {
  rmSync(entitlementsPath, { force: true });
  rmSync(overlayPath, { force: true });
}

console.log(`Configured ${productName} (${identifier}), team ${appleTeamId}.`);
console.log(profile ? `macOS push build files written (aps-environment ${apsEnvironment}).` : "macOS push build: no provisioning profile set, so `bun run mac:push-app` is disabled (it is only needed for the Mac push lines).");
console.log("If src-tauri/gen/apple already exists from an earlier identifier, delete it and run `bun run ios:init` again.");
