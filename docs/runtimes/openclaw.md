# Run AOS with OpenClaw

AOS attaches to an independently installed OpenClaw Gateway through its official protocol-v4 WebSocket. AOS does not install OpenClaw, manage its model credentials, or store its device identity in public runtime configuration.

## Browser connection

Start OpenClaw with a Gateway endpoint reachable by AOS, then run:

```bash
AOS_UI_RUNTIME_MODE=openclaw \
AOS_UI_OPENCLAW_BASE_URL=ws://127.0.0.1:18789 \
  bun run dev
```

For a same-origin container deployment, use the supplied proxy:

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.openclaw.json \
  docker compose -f compose.yaml -f compose.openclaw.yaml up --build
```

The browser performs OpenClaw's official challenge, device pairing, and scoped token flow. Bootstrap credentials are entered in the connection form, retained only in memory, and never belong in `runtime-config.json` or a `VITE_*` value. Grant `operator.read`, `operator.write`, `operator.questions`, and `operator.approvals`; Talk access is needed only for speech.

## Optional native tools

Install [`integrations/openclaw`](../../integrations/openclaw/README.md) in OpenClaw to add AOS chart, map, stats, Plan, and safe artifact-path validation with textual fallback. Without the plugin, ordinary text and JSON remain inspectable. The verified external-plugin API cannot register a native downloadable artifact, create an Agent, or initiate a cross-Agent Session with the required authority, so the plugin does not advertise publication, creator, or handoff tools.

## Exact limitations

OpenClaw tasks/goals are not AOS Session Todos, so the adapter does not relabel them. Agent visibility mutation and edit/regenerate are unavailable because the verified protocol has no equivalent matching AOS semantics. Context usage is aggregate rather than Hermes's detailed system/tool/message breakdown. Guest chat additionally omits transcription and branches. Unsupported controls stay absent instead of invoking a nearby destructive operation.

## Invited chat

The private Go gateway uses `AOS_GATEWAY_OPENCLAW_TOKEN` and an `AOS_GATEWAY_UPSTREAM` WebSocket URL. It creates the deterministic invitation-bound Session atomically and checks both its Agent and key on every operation. Keep this operator token in the service environment, never in public browser configuration.
