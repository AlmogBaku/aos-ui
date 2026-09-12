# OpenClaw server adapter status

AOS does not currently attach a browser to OpenClaw. The Hermes-first
normalized deployment returns `404` for `/openclaw`; the retained Compose
overlay and runtime-config example are explicitly fail-closed. OpenClaw does
not install, manage, or expose model credentials through AOS.

There is no supported browser connection command. The browser uses only the
normalized AOS proxy (`AOS_UI_RUNTIME_MODE=aos`) or explicit fixture mode.
OpenClaw remains a future server-side adapter until the normalized proxy and
live acceptance coverage are implemented.

## Optional native tools

Install [`integrations/openclaw`](../../integrations/openclaw/README.md) in OpenClaw to add AOS chart, map, stats, Plan, and safe artifact-path validation with textual fallback. Without the plugin, ordinary text and JSON remain inspectable. The verified external-plugin API cannot register a native downloadable artifact, create an Agent, or initiate a cross-Agent Session with the required authority, so the plugin does not advertise publication, creator, or handoff tools.

## Exact limitations

OpenClaw tasks/goals are not AOS Session Todos, so the adapter does not relabel them. Agent visibility mutation and edit/regenerate are unavailable because the verified protocol has no equivalent matching AOS semantics. Context usage is aggregate rather than Hermes's detailed system/tool/message breakdown. Guest chat additionally omits transcription and branches. Unsupported controls stay absent instead of invoking a nearby destructive operation.

## Invited chat

The private Go gateway uses `AOS_GATEWAY_OPENCLAW_TOKEN`, an
`AOS_GATEWAY_UPSTREAM` WebSocket URL, and an absolute persistent
`AOS_GATEWAY_OPENCLAW_DEVICE_FILE`. It creates a stable Ed25519 identity in the
private file, requires `0600` permissions, verifies the live read/write/question
scopes, and persists the paired device token atomically. Keep both token and
device file in the service environment, never in public browser configuration.
The first connection may return `PAIRING_REQUIRED`; use `openclaw devices list`
and `openclaw devices approve <requestId>` on the OpenClaw host, then restart
the gateway. The invitation instruction and guest text are submitted together
as OpenClaw's one native initial turn. A non-admitted initial run remains an
uncertain send and is never blindly replayed without its instruction.
After the paired token has been persisted, the bootstrap token may be removed
from the guest-gateway environment; reconnect uses the scoped device token.

Guest history projects artifacts only from Session-scoped authoritative
`artifacts.list` receipts with a byte-download mode and exact message sequence;
the receipt's `messageSeq` must match the transcript message's authoritative
`__openclaw.seq`, including paginated or noncontiguous history. Unscoped
chat-content lookalikes are ignored. The browser-only OpenClaw Compose overlay
does not run the guest gateway. If you containerize it separately, bind-mount
the device-file directory as writable persistent private storage.
