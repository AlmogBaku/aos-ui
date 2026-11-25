#!/usr/bin/env bash
# Run once on the Mac after `bun run ios:init` (and again after any re-init):
#   bun run ios:after-init
#
# 1. Adds the push entitlement (aps-environment = development) to the
#    generated iOS entitlements file. Tauri has no config key for iOS
#    entitlements; Xcode's automatic signing then requests a provisioning
#    profile that includes Push Notifications.
# 2. Copies en.lproj / he.lproj (Localizable.strings) into the generated app
#    folder so they land at the root of the app bundle, where iOS looks up an
#    APNs loc-key. (`bundle.resources` would put them under assets/ instead.)
# 3. Regenerates the Xcode project with XcodeGen so it picks up the new files.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
apple="$root/src-tauri/gen/apple"

if [[ ! -f "$apple/project.yml" ]]; then
  echo "No $apple/project.yml. Run 'bun run ios:init' first." >&2
  exit 1
fi

shopt -s nullglob
targets=("$apple"/*_iOS)
shopt -u nullglob
if [[ ${#targets[@]} -ne 1 || ! -d "${targets[0]}" ]]; then
  echo "Expected exactly one *_iOS folder in $apple, found ${#targets[@]}." >&2
  exit 1
fi
target="${targets[0]}"
name="$(basename "$target")"
entitlements="$target/$name.entitlements"
if [[ ! -f "$entitlements" ]]; then
  echo "Missing $entitlements" >&2
  exit 1
fi

/usr/libexec/PlistBuddy -c "Delete :aps-environment" "$entitlements" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :aps-environment string development" "$entitlements"
echo "aps-environment=development set in $entitlements"

for lang in en he; do
  rm -rf "$target/$lang.lproj"
  cp -R "$root/src-tauri/lproj/$lang.lproj" "$target/$lang.lproj"
done
echo "Localizable.strings (en, he) copied into $target"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen not found on PATH. Install it with 'brew install xcodegen' and run this script again." >&2
  exit 1
fi
xcodegen generate --spec "$apple/project.yml"
echo "Xcode project regenerated. Next: bun run ios:dev  (or bun run ios:open to run from Xcode)"
