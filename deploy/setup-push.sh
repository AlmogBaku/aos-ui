#!/usr/bin/env bash
# One-time setup for Web Push on a production AOS deployment.
#
# Run as root (or with sudo) from the AOS checkout directory:
#
#   sudo bash deploy/setup-push.sh \
#     --key-file    /etc/aos-ui/secrets/vapid-private-key \
#     --state-dir   /var/lib/aos-ui/push \
#     --config-file /etc/aos-ui/proxy-config.json \
#     --env-file    /etc/aos-ui/aos-ui.env \
#     --subject     "mailto:you@example.com" \
#     --uid         1002 \
#     --gid         1002
#
# After the script succeeds, add -f compose.push.yaml to every docker compose
# invocation in the systemd service (after the runtime overlay, e.g.
# compose.hermes.yaml) and reload:
#
#   systemctl daemon-reload && systemctl reload aos-ui
#
# The script is idempotent: it skips steps that are already done.
set -euo pipefail

KEY_FILE=""
STATE_DIR=""
CONFIG_FILE=""
ENV_FILE=""
SUBJECT=""
HOST_UID=""
HOST_GID=""

usage() {
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --key-file)    KEY_FILE="$2";    shift 2 ;;
    --state-dir)   STATE_DIR="$2";   shift 2 ;;
    --config-file) CONFIG_FILE="$2"; shift 2 ;;
    --env-file)    ENV_FILE="$2";    shift 2 ;;
    --subject)     SUBJECT="$2";     shift 2 ;;
    --uid)         HOST_UID="$2";    shift 2 ;;
    --gid)         HOST_GID="$2";    shift 2 ;;
    *) echo "unknown option: $1"; usage ;;
  esac
done

for var in KEY_FILE STATE_DIR CONFIG_FILE ENV_FILE SUBJECT HOST_UID HOST_GID; do
  [[ -n "${!var}" ]] || { echo "missing --$(echo "$var" | tr '[:upper:]' '[:lower:]' | tr '_' '-')"; usage; }
done

# --- state directory ---------------------------------------------------------
if [[ -d "$STATE_DIR" ]]; then
  echo "state dir already exists: $STATE_DIR"
else
  echo "==> creating state dir: $STATE_DIR"
  mkdir -p "$STATE_DIR"
fi
chown "${HOST_UID}:${HOST_GID}" "$STATE_DIR"
chmod 0700 "$STATE_DIR"

# --- VAPID private key -------------------------------------------------------
KEY_DIR="$(dirname "$KEY_FILE")"
mkdir -p "$KEY_DIR"
chmod 0700 "$KEY_DIR"

if [[ -f "$KEY_FILE" ]]; then
  echo "VAPID key already exists: $KEY_FILE"
else
  echo "==> generating VAPID private key: $KEY_FILE"
  node -e "
const { createECDH } = require('crypto')
const { writeFileSync, chmodSync } = require('fs')
const ecdh = createECDH('prime256v1')
ecdh.generateKeys()
const key = ecdh.getPrivateKey().toString('base64url')
if (key.length !== 43) throw new Error('unexpected key length: ' + key.length)
writeFileSync(process.argv[1], key, { mode: 0o600 })
chmodSync(process.argv[1], 0o600)
" "$KEY_FILE"
fi
chown "${HOST_UID}:${HOST_GID}" "$KEY_FILE"
chmod 0400 "$KEY_FILE"
echo "   key: $KEY_FILE ($(stat -c '%A %U' "$KEY_FILE"))"

# --- proxy-config.json push block -------------------------------------------
if node -e "process.exit(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).push ? 0 : 1)" "$CONFIG_FILE" 2>/dev/null; then
  echo "push block already present in $CONFIG_FILE"
else
  echo "==> adding push block to $CONFIG_FILE"
  node -e "
const { readFileSync, writeFileSync } = require('fs')
const cfg = JSON.parse(readFileSync(process.argv[1], 'utf8'))
cfg.push = {
  stateDir: process.argv[2],
  vapid: { subject: process.argv[3], privateKeyFile: '/run/secrets/vapid-private-key' }
}
writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2) + '\n')
" "$CONFIG_FILE" "$STATE_DIR" "$SUBJECT"
fi

# --- aos-ui.env env vars -----------------------------------------------------
if grep -q AOS_UI_PUSH_STATE_DIR "$ENV_FILE" 2>/dev/null; then
  echo "push env vars already present in $ENV_FILE"
else
  echo "==> adding push env vars to $ENV_FILE"
  printf '\nAOS_UI_PUSH_STATE_DIR=%s\nAOS_UI_VAPID_PRIVATE_KEY_FILE=%s\nAOS_UI_HOST_UID=%s\nAOS_UI_HOST_GID=%s\n' \
    "$STATE_DIR" "$KEY_FILE" "$HOST_UID" "$HOST_GID" >> "$ENV_FILE"
fi

echo ""
echo "Done. Next steps:"
echo "  1. Add -f compose.push.yaml to ExecStart/ExecReload/ExecStop in the systemd service"
echo "     (after the runtime overlay, e.g. compose.hermes.yaml)"
echo "  2. systemctl daemon-reload && systemctl reload aos-ui"
