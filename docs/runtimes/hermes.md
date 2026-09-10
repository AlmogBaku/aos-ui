# Run AOS with Hermes

AOS connects directly to the native `hermes serve` HTTP/WebSocket API. Hermes remains responsible for profiles, authentication, Sessions, runs, credentials, tools, and persistence; there is no AOS bridge database or profile registry.

## Prerequisites

- An operator-managed Hermes installation with native server authentication configured
- Bun for the AOS frontend
- `uv` when building or testing the AOS Hermes plugin locally

The integration is tested against Hermes checkout `b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b`; its required RPC surface was also verified in unmodified Hermes `v2026.9.7`.

## Install the native plugin

Install from an immutable AOS commit into every participating profile:

```bash
hermes -p PROFILE plugins install OWNER/REPOSITORY/integrations/hermes \
  --ref FULL_40_CHARACTER_COMMIT_SHA --no-enable
hermes -p PROFILE plugins doctor aos-integration --ci
hermes -p PROFILE plugins enable aos-integration
hermes -p PROFILE tools enable --platform api_server aos-presentation aos-session-handoff
hermes -p PROFILE tools enable --platform cli aos-presentation aos-session-handoff
```

Use `file:///absolute/path/to/aos-ui#integrations/hermes` instead of the repository source for a committed local checkout. The package-level [Hermes integration README](../../integrations/hermes/README.md) documents the exact native tools and creator provisioning.

## Start the frontend

Build the integration assets, then start AOS:

```bash
bun run integrations:build
uv sync --project integrations/hermes --frozen
AOS_UI_RUNTIME_MODE=hermes \
AOS_UI_HERMES_BASE_URL=/hermes \
AOS_UI_HERMES_TARGET=http://127.0.0.1:9119 \
  bun run dev
```

Vite forwards `/hermes`, native authentication routes, and WebSockets to the target. Open <http://localhost:3000>, follow **Sign in to Hermes** when prompted, then reload the workspace.

Hermes owns recovery policy, including auto-continue. AOS reattaches without submitting a new prompt, so it does not require a particular auto-continue setting.

## Run with Compose

Hermes remains outside the Compose stack. The overlay lets the web container reach the operator-managed server:

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.hermes-native.json \
  docker compose -f compose.yaml -f compose.hermes.yaml up --build
```

By default the container reaches `host.docker.internal:9119`. Set `AOS_UI_HERMES_HOST` and `AOS_UI_HERMES_PORT` when Hermes is elsewhere. A server bound only to host loopback is not reachable through Docker's host gateway.

## Creator profile

Agent creation begins in a dedicated native creator profile. Mark that profile in `profile.yaml`:

```yaml
ui_meta:
  aos:
    role: creator
  hermes-bots:
    hidden: true
```

The integration reads this metadata; it does not grant creator authority itself. Automated creation currently fails closed because the verified Hermes versions do not provide an atomic no-overwrite profile-create operation. The interview remains available, but no native profile is written.

## Operational behavior

- Native profiles form the AOS Agent catalog and can expose visibility changes.
- Native CLI or cron Sessions may appear in AOS even when the browser did not create them.
- Activity coverage is limited to the active Session.
- Stop uses native Session interruption.
- Questions, approvals, attachments, edit/regenerate, Artifacts, and Todos are projected from native Hermes interfaces when present.
- Voice controls appear only for native STT/TTS interfaces; see [Chat voice](../chat-voice.md).

## Verify

```bash
bun run integrations:build
bun run hermes:test
```

Live acceptance requires an approved profile, disposable Session, and real credentials. If authentication, WebSocket attachment, or profile discovery fails, see [Troubleshooting](../troubleshooting.md).
