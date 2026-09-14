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

OpenClaw guest access is unavailable until its TypeScript server adapter
implements native authentication, pairing, scoped history, runs, interactions,
and artifact projection behind the shared AOS guest listener.
