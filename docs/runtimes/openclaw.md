# Run OpenClaw behind the AOS proxy

The browser connects only to the normalized AOS proxy (`AOS_UI_RUNTIME_MODE=aos`). The proxy connects to one independently operated OpenClaw Gateway over WebSocket, using its device identity and device token from private files. There is no browser Gateway route and AOS does not manage OpenClaw or model credentials.

## Prerequisites

- A reachable, already configured OpenClaw Gateway
- Private, owner-only files containing the Gateway device identity and device token
- A private guest-invitation signing-key file when the guest lane is enabled

Start from [`deploy/proxy-config.openclaw.example.json`](../../deploy/proxy-config.openclaw.example.json). Set `runtime.baseUrl` to the Gateway WebSocket URL reachable by the proxy and set `runtime.deviceIdentityFile` and `runtime.deviceTokenFile` to the corresponding private files. The example's `ws://host.docker.internal:18789` is for a Gateway running on the Compose host; replace it when your topology differs.

## Compose attachment

The OpenClaw overlay runs the AOS proxy and static UI only. It does not start, publish, or proxy a native OpenClaw Gateway.

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.openclaw.json \
AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy-config.openclaw.json \
AOS_UI_OPENCLAW_DEVICE_IDENTITY_FILE=/absolute/private/path/openclaw-device-identity \
AOS_UI_OPENCLAW_DEVICE_TOKEN_FILE=/absolute/private/path/openclaw-device-token \
AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.openclaw.yaml up --build
```

For a host Gateway, the overlay maps `host.docker.internal` to Docker's host gateway. A service bound only to host loopback may still be unreachable from the container; use a trusted container-reachable address and update the private proxy configuration. Keep the native Gateway off the browser-facing network.

## Optional native tools

Install [`integrations/openclaw`](../../integrations/openclaw/README.md) in OpenClaw to add AOS chart, map, stats, Plan, and safe artifact-path validation with textual fallback. Without the plugin, ordinary text and JSON remain inspectable. The verified external-plugin API does not prove native downloadable artifact publication, Agent creation, or cross-Agent Session handoff, so those tools are not advertised.

## Run locally

For a Vite development server on port `3000`, configure the private proxy to
listen on `127.0.0.1:4100` with `publicOrigin` set to
`http://localhost:3000`. Then run:

```bash
# Terminal 1
bun run proxy:serve -- --config /absolute/private/path/proxy-config.openclaw.json

# Terminal 2
AOS_UI_RUNTIME_MODE=aos \
AOS_UI_PROXY_TARGET=http://127.0.0.1:4100 \
  bun run dev
```

## Capability limits

- AOS reads provider Agents, Sessions, history, model catalog, context usage, runs, questions, permissions, and supported image/file attachments through the negotiated Gateway policy.
- Session creation is available. Rename, archive, delete, visibility changes, Todos, Activity, edit/regenerate, steering, artifacts, and read state are unavailable because the pinned Gateway leaves do not prove matching native operations. Voice becomes available when the proxy `voice` block is configured; see [Use voice](../chat-voice.md).
- An invitation can resolve only a pre-existing reserved OpenClaw Session. The adapter does not create a Session for a new guest invitation because the pinned Gateway leaves do not prove equivalent native creation semantics.
- Device identity and tokens are server-only. Treat pairing/authentication failures as private proxy configuration problems, never as browser credentials.
- The proxy requests device token scopes `operator.read`, `operator.write`, `operator.approvals`, and `operator.questions`.
- A `pairing-required` error is terminal unless the Gateway responds with `pauseReconnect: false` or `recommendedNextStep: "wait_then_retry"`, in which case the adapter retries.

## Verify

Run the proxy checks for the selected deployment and verify the Gateway is reachable from the proxy host or container:

```bash
bunx vitest run packages/proxy/adapters/openclaw
```

Confirm the Gateway is reachable and the device identity and token files are correct:

```bash
bun run proxy:serve -- --config /absolute/private/path/proxy-config.openclaw.json
curl --fail --silent --show-error http://127.0.0.1:4100/api/aos/v1/readyz
```

Native live acceptance has not been run; mocked protocol tests do not prove a paired live OpenClaw journey.

For connection problems, see [Troubleshooting](../troubleshooting.md).
