#!/usr/bin/env bash
# One-time setup for Web Push on a production AOS deployment.
#
# Run as root (or with sudo) from the AOS checkout directory:
#
#   sudo bash deploy/setup-push.sh \
#     --key-file  /etc/aos-ui/secrets/vapid-private-key \
#     --state-dir /var/lib/aos-ui/push \
#     --env-file  /etc/aos-ui/aos-ui.env \
#     --subject   "mailto:you@example.com" \
#     --uid       1002 \
#     --gid       1002
#
# After the script succeeds, add -f compose.push.yaml to every docker compose
# invocation in the systemd service (after the runtime overlay, e.g.
# compose.hermes.yaml) and reload:
#
#   systemctl daemon-reload && systemctl reload aos-ui
#
# The overlay passes the push settings to the proxy as container environment
# variables; the private proxy configuration file needs no push section.
#
# The script is idempotent: it skips steps that are already done.
set -euo pipefail

KEY_FILE=""
STATE_DIR=""
ENV_FILE=""
SUBJECT=""
HOST_UID=""
HOST_GID=""

usage() {
  sed -n '3,23p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --key-file)  KEY_FILE="$2";  shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --env-file)  ENV_FILE="$2";  shift 2 ;;
    --subject)   SUBJECT="$2";   shift 2 ;;
    --uid)       HOST_UID="$2";  shift 2 ;;
    --gid)       HOST_GID="$2";  shift 2 ;;
    *) echo "unknown option: $1"; usage ;;
  esac
done

for var in KEY_FILE STATE_DIR ENV_FILE SUBJECT HOST_UID HOST_GID; do
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

# --- aos-ui.env env vars -----------------------------------------------------
append_env() {
  local name="$1" value="$2"
  if grep -q "^${name}=" "$ENV_FILE" 2>/dev/null; then
    echo "$name already present in $ENV_FILE"
  else
    echo "==> adding $name to $ENV_FILE"
    # A file whose last line lacks a newline would glue the new variable onto it.
    if [[ -s "$ENV_FILE" && -n "$(tail -c1 "$ENV_FILE")" ]]; then
      echo >>"$ENV_FILE"
    fi
    printf '%s=%s\n' "$name" "$value" >>"$ENV_FILE"
  fi
}

append_env AOS_UI_PUSH_STATE_DIR "$STATE_DIR"
append_env AOS_UI_VAPID_PRIVATE_KEY_FILE "$KEY_FILE"
append_env AOS_UI_PUSH_VAPID_SUBJECT "$SUBJECT"
append_env AOS_UI_HOST_UID "$HOST_UID"
append_env AOS_UI_HOST_GID "$HOST_GID"

echo ""
echo "Done. Next steps:"
echo "  1. Add -f compose.push.yaml to ExecStart/ExecReload/ExecStop in the systemd service"
echo "     (after the runtime overlay, e.g. compose.hermes.yaml)"
echo "  2. systemctl daemon-reload && systemctl reload aos-ui"
