#!/usr/bin/env bash
set -euo pipefail

# Provision a hidden Hermes "creator" profile for AOS UI "New Agent".
# Hermes has no CLI flag for hidden/ui_meta, so profile.yaml is edited
# using the Hermes venv's Python (which has PyYAML installed).

usage() {
  cat <<EOF
Usage: $(basename "$0") --ref <40-hex-sha> [OPTIONS]

Options:
  --ref <sha>       40-hex lowercase git SHA of the plugin (required)
  --source <src>    Plugin source URL
                    (default: derived from this script's git checkout,
                     e.g. file:///path/to/repo#integrations/hermes)
  --name <profile>  Profile name to create/update (default: agent-creator)
  --python <path>   Path to a Python interpreter with PyYAML
  --dry-run         Print planned commands without executing
  -h, --help        Show this help and exit
EOF
}

REF=
SOURCE_OVERRIDE=
NAME="agent-creator"
PY_OVERRIDE=
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)     REF="$2";         shift 2 ;;
    --source)  SOURCE_OVERRIDE="$2"; shift 2 ;;
    --name)    NAME="$2";        shift 2 ;;
    --python)  PY_OVERRIDE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1;        shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Resolve plugin source: explicit override, or derived from this checkout
if [[ -n "$SOURCE_OVERRIDE" ]]; then
  SOURCE="$SOURCE_OVERRIDE"
else
  ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null)
  if [[ -z "$ROOT" ]]; then
    echo "Error: could not determine repository root from script location; pass --source explicitly" >&2; exit 1
  fi
  SOURCE="file://$ROOT#integrations/hermes"
fi

# Validate --ref (required, 40 lowercase hex characters)
if [[ -z "$REF" ]]; then
  echo "Error: --ref is required" >&2; usage >&2; exit 1
fi
if [[ ! "$REF" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Error: --ref must be a 40-character lowercase hex SHA; got: $REF" >&2; exit 1
fi

# Validate --name
if [[ ! "$NAME" =~ ^[a-z][a-z0-9-]{1,31}$ ]]; then
  echo "Error: --name must match ^[a-z][a-z0-9-]{1,31}\$; got: $NAME" >&2; exit 1
fi

# --- Resolve Python interpreter ---
if [[ -n "$PY_OVERRIDE" ]]; then
  PY="$PY_OVERRIDE"
else
  HERMES_BIN=$(command -v hermes) || { echo "Error: hermes not found in PATH" >&2; exit 1; }
  HEAD2=$(head -c2 "$HERMES_BIN" 2>/dev/null || true)
  if [[ "$HEAD2" == "#!" ]] && grep -q 'exec .*hermes' "$HERMES_BIN" 2>/dev/null; then
    # Extract the exec target, stripping surrounding double-quotes if present
    EXEC_TARGET=$(grep 'exec .*hermes' "$HERMES_BIN" | head -1 \
      | awk '{for(i=1;i<=NF;i++) if($i ~ /hermes/) {gsub(/"/, "", $i); print $i; exit}}')
    PY="$(dirname "$EXEC_TARGET")/python"
  else
    PY="$(dirname "$HERMES_BIN")/python"
  fi
fi
echo "Python interpreter: $PY"

# Verify PyYAML is importable
if "$PY" -c 'import yaml' 2>/dev/null; then
  : # ok
elif [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Warning: $PY cannot import yaml; proceeding in dry-run mode" >&2
else
  echo "Could not find a Python with PyYAML; pass --python <path>" >&2; exit 1
fi

PROFILE_DIR="${HERMES_HOME:-$HOME/.hermes}/profiles/$NAME"

# --- Step 1: Create profile if not already present ---
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] hermes profile list  # check for '$NAME' as a whole word"
  echo "[dry-run] hermes profile create \"$NAME\" --no-alias --description \"Creates AOS Agents through a guided interview\""
else
  echo "hermes profile list"
  existing=$(hermes profile list)
  if ! grep -qw -- "$NAME" <<<"$existing"; then
    echo "hermes profile create \"$NAME\" --no-alias --description \"Creates AOS Agents through a guided interview\""
    hermes profile create "$NAME" --no-alias --description "Creates AOS Agents through a guided interview"
  fi
fi

# --- Step 2: Patch profile.yaml (display_name, ui_meta, _ui_meta_revisions) ---
PROFILE_YAML="$PROFILE_DIR/profile.yaml"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] edit $PROFILE_YAML: set keys:"
  echo "  display_name: Agent Creator"
  echo "  ui_meta.aos.role: creator"
  echo "  ui_meta.hermes-bots.hidden: true"
  echo "  _ui_meta_revisions.aos: >=1"
  echo "  _ui_meta_revisions.hermes-bots: >=1"
else
  echo "\"$PY\" - \"$PROFILE_YAML\" <<'PY'  # patch profile.yaml"
  "$PY" - "$PROFILE_YAML" <<'PY'
import sys, os, tempfile, yaml

path = sys.argv[1]
try:
    with open(path) as fh:
        data = yaml.safe_load(fh) or {}
except FileNotFoundError:
    data = {}

data['display_name'] = 'Agent Creator'

ui_meta = data.get('ui_meta') or {}
ui_meta_aos = ui_meta.get('aos') or {}
ui_meta_aos['role'] = 'creator'
ui_meta['aos'] = ui_meta_aos
ui_meta_hb = ui_meta.get('hermes-bots') or {}
ui_meta_hb['hidden'] = True
ui_meta['hermes-bots'] = ui_meta_hb
data['ui_meta'] = ui_meta

revisions = data.get('_ui_meta_revisions') or {}
revisions['aos'] = max(revisions.get('aos') or 0, 1)
revisions['hermes-bots'] = max(revisions.get('hermes-bots') or 0, 1)
data['_ui_meta_revisions'] = revisions

dirpath = os.path.dirname(os.path.abspath(path))
fd, tmp = tempfile.mkstemp(dir=dirpath)
try:
    with os.fdopen(fd, 'w') as fh:
        yaml.dump(data, fh, sort_keys=False, allow_unicode=True)
    os.replace(tmp, path)
except Exception:
    os.unlink(tmp)
    raise
PY
fi

# --- Step 3: Install plugin (no-enable) ---
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] hermes -p \"$NAME\" plugins install \"$SOURCE\" --ref \"$REF\" --no-enable"
else
  echo "hermes -p \"$NAME\" plugins install \"$SOURCE\" --ref \"$REF\" --no-enable"
  hermes -p "$NAME" plugins install "$SOURCE" --ref "$REF" --no-enable
fi

# --- Step 4: Doctor check ---
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] hermes -p \"$NAME\" plugins doctor aos-integration --ci"
else
  echo "hermes -p \"$NAME\" plugins doctor aos-integration --ci"
  hermes -p "$NAME" plugins doctor aos-integration --ci
fi

# --- Step 5: Enable plugin ---
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] hermes -p \"$NAME\" plugins enable aos-integration --no-allow-tool-override"
else
  echo "hermes -p \"$NAME\" plugins enable aos-integration --no-allow-tool-override"
  hermes -p "$NAME" plugins enable aos-integration --no-allow-tool-override
fi

# --- Step 6: Enable tools for api_server platform ---
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] hermes -p \"$NAME\" tools enable --platform api_server aos-presentation aos-session-handoff aos"
else
  echo "hermes -p \"$NAME\" tools enable --platform api_server aos-presentation aos-session-handoff aos"
  hermes -p "$NAME" tools enable --platform api_server aos-presentation aos-session-handoff aos
fi

# --- Step 7: Enable tools for cli platform ---
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] hermes -p \"$NAME\" tools enable --platform cli aos-presentation aos-session-handoff aos"
else
  echo "hermes -p \"$NAME\" tools enable --platform cli aos-presentation aos-session-handoff aos"
  hermes -p "$NAME" tools enable --platform cli aos-presentation aos-session-handoff aos
fi

# --- Step 8: Append env vars to .env (never read existing values) ---
ENV_FILE="$PROFILE_DIR/.env"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] append to $ENV_FILE (if key not already present):"
  echo "  AOS_HERMES_PLUGIN_SOURCE=$SOURCE"
  echo "  AOS_HERMES_PLUGIN_REF=$REF"
else
  echo "# Updating $ENV_FILE"
  [[ -e "$ENV_FILE" ]] || install -m 600 /dev/null "$ENV_FILE"
  if ! grep -q '^AOS_HERMES_PLUGIN_SOURCE=' "$ENV_FILE" 2>/dev/null; then
    echo "AOS_HERMES_PLUGIN_SOURCE=$SOURCE" >> "$ENV_FILE"
  fi
  if ! grep -q '^AOS_HERMES_PLUGIN_REF=' "$ENV_FILE" 2>/dev/null; then
    echo "AOS_HERMES_PLUGIN_REF=$REF" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
fi

# --- Step 9: Next steps ---
echo ""
echo "Done. Next steps:"
echo "  hermes profile list"
echo "  Restart Hermes (or reload its config) to pick up the '$NAME' profile."
echo "  The AOS proxy will show 'New Agent' once it lists the '$NAME' profile."
