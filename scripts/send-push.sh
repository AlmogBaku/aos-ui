#!/usr/bin/env bash
# Sends the ALM-109 probe alert through APNs (token-based auth). Runs on the Mac.
#
#   scripts/send-push.sh --key-file /absolute/path/AuthKey_ABC123DEFG.p8 \
#     --key-id ABC123DEFG --team-id TEAM123456 --bundle-id com.you.aosprobe \
#     --env sandbox --token "$(pbpaste)"
#
#   --env sandbox     iPhone build run from Xcode / `tauri ios dev` (development)
#   --env production  Developer ID macOS build (and TestFlight/App Store builds)
#   --token -         read the device token from stdin instead (pbpaste | ...)
#   --agent ID / --session ID   custom payload fields (default agent-1 / session-1)
#   --dry-run         build and sign everything, print the payload, send nothing
#
# Nothing is hard-coded and nothing secret is printed: the provider JWT and the
# device token never reach stdout, stderr or the command line of curl (curl
# reads them from a private temporary config file that is deleted on exit).
set -euo pipefail

die() { echo "send-push: $*" >&2; exit 2; }

key_file="" key_id="" team_id="" bundle_id="" env="" token="" dry_run=0
agent="agent-1" session="session-1"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key-file) key_file="${2-}"; shift 2 ;;
    --key-id) key_id="${2-}"; shift 2 ;;
    --team-id) team_id="${2-}"; shift 2 ;;
    --bundle-id) bundle_id="${2-}"; shift 2 ;;
    --env) env="${2-}"; shift 2 ;;
    --token) token="${2-}"; shift 2 ;;
    --agent) agent="${2-}"; shift 2 ;;
    --session) session="${2-}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ -n "$key_file" && -n "$key_id" && -n "$team_id" && -n "$bundle_id" && -n "$env" && -n "$token" ]] \
  || die "missing arguments; need --key-file --key-id --team-id --bundle-id --env --token (see --help)"
if [[ "$token" == "-" ]]; then
  IFS= read -r token || true
fi
token="$(printf '%s' "$token" | tr -d ' <>\r\n')"

[[ -f "$key_file" && -r "$key_file" ]] || die "key file not readable: $key_file"
here="$(cd "$(dirname "$0")/.." && pwd -P)"
key_dir="$(cd "$(dirname "$key_file")" && pwd -P)"
case "$key_dir/" in "$here"/*) die "keep the .p8 key OUTSIDE the probe directory" ;; esac
[[ "$key_id" =~ ^[A-Z0-9]{10}$ ]] || die "--key-id must be the 10-character key ID"
[[ "$team_id" =~ ^[A-Z0-9]{10}$ ]] || die "--team-id must be the 10-character team ID"
[[ "$bundle_id" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || die "--bundle-id looks wrong"
[[ "$token" =~ ^[0-9a-fA-F]{64,200}$ ]] || die "--token must be the hex device token (use 'Copy full token' in the app)"
[[ "$agent" =~ ^[A-Za-z0-9._-]{1,64}$ && "$session" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "--agent/--session: letters, digits, . _ - only"
case "$env" in
  sandbox) host="api.sandbox.push.apple.com" ;;
  production) host="api.push.apple.com" ;;
  *) die "--env must be sandbox or production" ;;
esac
command -v openssl >/dev/null || die "openssl not found"
command -v xxd >/dev/null || die "xxd not found"
command -v curl >/dev/null || die "curl not found"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# ES256 signatures come out of openssl as DER (SEQUENCE of two INTEGERs);
# a JWT needs the raw 64-byte r||s.
der_to_jose() {
  local hex pos len r s
  hex="$(xxd -p | tr -d '\n')"
  [[ "${hex:0:2}" == "30" ]] || die "unexpected signature encoding"
  pos=2
  if [[ "${hex:pos:2}" == "81" ]]; then pos=$((pos + 4)); else pos=$((pos + 2)); fi
  [[ "${hex:pos:2}" == "02" ]] || die "unexpected signature encoding (r)"
  len=$((16#${hex:pos+2:2})); r="${hex:pos+4:len*2}"; pos=$((pos + 4 + len * 2))
  [[ "${hex:pos:2}" == "02" ]] || die "unexpected signature encoding (s)"
  len=$((16#${hex:pos+2:2})); s="${hex:pos+4:len*2}"
  while [[ ${#r} -gt 64 && "${r:0:2}" == "00" ]]; do r="${r:2}"; done
  while [[ ${#s} -gt 64 && "${s:0:2}" == "00" ]]; do s="${s:2}"; done
  [[ ${#r} -le 64 && ${#s} -le 64 ]] || die "unexpected signature length"
  r="$(printf '%64s' "$r" | tr ' ' 0)"
  s="$(printf '%64s' "$s" | tr ' ' 0)"
  printf '%s%s' "$r" "$s" | xxd -r -p | b64url
}

header="$(printf '{"alg":"ES256","kid":"%s"}' "$key_id" | b64url)"
claims="$(printf '{"iss":"%s","iat":%s}' "$team_id" "$(date +%s)" | b64url)"
signature="$(printf '%s.%s' "$header" "$claims" | openssl dgst -sha256 -sign "$key_file" | der_to_jose)"
jwt="$header.$claims.$signature"

payload="$(printf '{"aps":{"alert":{"title-loc-key":"push.input.title","loc-key":"push.input.body","loc-args":["Travel desk","Lisbon offsite","Which hotel?"]},"sound":"default"},"agentId":"%s","sessionId":"%s"}' "$agent" "$session")"

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
{
  printf 'url = "https://%s/3/device/%s"\n' "$host" "$token"
  printf 'header = "authorization: bearer %s"\n' "$jwt"
  printf 'header = "apns-topic: %s"\n' "$bundle_id"
  printf 'header = "apns-push-type: alert"\n'
  printf 'header = "apns-priority: 10"\n'
  printf 'header = "content-type: application/json"\n'
} > "$work/curl.conf"
printf '%s' "$payload" > "$work/payload.json"

echo "APNs host:  $host"
echo "topic:      $bundle_id"
echo "token:      ${#token} hex chars (not shown)"
echo "payload:    $payload"
if [[ $dry_run -eq 1 ]]; then
  echo "dry run: JWT signed with key $key_id; nothing sent."
  exit 0
fi

status="$(curl --http2 --silent --show-error --config "$work/curl.conf" \
  --data-binary "@$work/payload.json" --dump-header "$work/headers" \
  --output "$work/body" --write-out '%{http_code}')" || die "curl failed (network?)"
apns_id="$(grep -i '^apns-id:' "$work/headers" | tr -d '\r' | cut -d' ' -f2- || true)"
echo "HTTP status: $status   apns-id: ${apns_id:-none}"
if [[ "$status" != "200" ]]; then
  echo "APNs answer: $(cat "$work/body")"
  echo "(BadDeviceToken usually means --env does not match the build: sandbox for Xcode/dev builds, production for Developer ID.)"
  exit 1
fi
echo "Sent. Check the device now (the app must be fully closed for measurements 21 and 22)."
