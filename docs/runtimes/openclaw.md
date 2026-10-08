# Run AOS with OpenClaw

The browser connects only to the [harness-gw](https://github.com/AlmogBaku/harness-gw)
gateway (`AOS_UI_RUNTIME_MODE=aos`). The gateway connects to one independently
operated OpenClaw Gateway over WebSocket, using its device identity and device
token from private files. There is no browser Gateway route, and AOS does not
manage OpenClaw or model credentials.

This page covers running AOS against OpenClaw and registering the AOS UI tools
and creator. The gateway's OpenClaw adapter (device scopes, pairing, MCP App
relaying, file reads, icon writes) is documented in harness-gw's
[`docs/runtimes/openclaw.md`](https://github.com/AlmogBaku/harness-gw/blob/main/docs/runtimes/openclaw.md).

## Prerequisites

- A reachable, already configured OpenClaw Gateway
- Private, owner-only files containing the Gateway device identity and device token
- A private guest-invitation signing-key file when the guest listener is enabled

Start from harness-gw's
[`examples/config.openclaw.example.yaml`](https://github.com/AlmogBaku/harness-gw/blob/main/examples/config.openclaw.example.yaml),
copied outside both checkouts. Set `runtime.baseUrl` to the OpenClaw Gateway
WebSocket URL reachable by the gateway, and `runtime.deviceIdentityFile` and
`runtime.deviceTokenFile` to the private files. The example's
`ws://host.docker.internal:18789` is for an OpenClaw Gateway on the Compose
host; replace it when your topology differs. Set each listener's `publicOrigin`
to the address the browser uses.

## Compose attachment

The OpenClaw overlay adds the gateway and the guest lane. It does not start,
publish, or proxy a native OpenClaw Gateway.

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.openclaw.json \
HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.openclaw.yaml \
HARNESS_GW_OPENCLAW_DEVICE_IDENTITY_FILE=/absolute/private/path/openclaw-device-identity \
HARNESS_GW_OPENCLAW_DEVICE_TOKEN_FILE=/absolute/private/path/openclaw-device-token \
HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.openclaw.yaml up --build
```

Caddy publishes the operator lane on `127.0.0.1:3000` and the guest lane on
`127.0.0.1:3001`. For a host OpenClaw Gateway, the overlay maps
`host.docker.internal` to Docker's host gateway. A service bound only to host
loopback may still be unreachable from the container; use a trusted
container-reachable address, or add `-f deploy/compose.host.yaml` after the
OpenClaw overlay and list `127.0.0.1` listeners in the gateway config. Keep the
native Gateway off the browser-facing network.

## Run locally

For a Vite development server on port `3000`, configure the gateway's operator
listener on `127.0.0.1:4100` with `publicOrigin` set to
`http://localhost:3000`. Then run:

```bash
# Terminal 1, in the harness-gw checkout
bun run serve --config /absolute/private/path/harness-gw.openclaw.yaml

# Terminal 2, in the aos-ui checkout
AOS_UI_RUNTIME_MODE=aos \
AOS_UI_GATEWAY_TARGET=http://127.0.0.1:4100 \
  bun run dev
```

## Register the AOS UI tools

The installation prompt, [`shared/install/PROMPT.md`](../../shared/install/PROMPT.md),
lets an agent perform the steps below; its [OpenClaw reference](../../shared/install/reference/harness-openclaw.md)
holds the exact commands. The manual steps follow.

AOS UI ships its own stateless MCP server, `packages/tools-mcp`, with
`render_chart`, `render_map`, `render_stats`, and
`present_artifact({path, title?, mimeType?})`. All four are
[MCP Apps](#mcp-apps) and render only while the OpenClaw Gateway has
`mcp.apps.enabled: true`. Run it on the OpenClaw host with
`bun run tools-mcp:serve` (loopback, port `4110`), or use the Compose stack's
`tools-mcp` service, published on `127.0.0.1:${AOS_UI_TOOLS_MCP_PORT:-4110}`.

Register it in OpenClaw as `aos-ui`, disabled by default, so it loads only in
Sessions AOS enables it for:

```bash
openclaw mcp add aos-ui --url http://127.0.0.1:4110/mcp \
  --transport streamable-http --disabled
```

That writes this entry under `mcp.servers` in `openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "aos-ui": {
        "url": "http://127.0.0.1:4110/mcp",
        "transport": "streamable-http",
        "enabled": false
      }
    }
  }
}
```

Run `openclaw mcp reload` so the next turn uses the new configuration.

The gateway enables the server per Session, which needs its device paired with
`operator.admin`; a turn whose enabling patch fails does not start. OpenClaw
names the tools `aos-ui__render_chart` and so on, and the gateway
canonicalizes those names, so the browser renders them as AOS tools.

### MCP Apps

OpenClaw serves MCP Apps natively, and AOS renders them as App cards
([MCP Apps](../mcp-apps.md)). Register the App server under `mcp.servers` like
any other MCP server, and turn MCP Apps on in the OpenClaw Gateway:

```bash
openclaw mcp add NAME --url https://apps.example.test/mcp \
  --transport streamable-http
openclaw config set mcp.apps.enabled true
openclaw config validate
openclaw mcp reload
```

OpenClaw caps a view's HTML at 2 MiB. A view OpenClaw no longer holds, or any
view while `mcp.apps.enabled` is off, shows the tool call's textual details.
Guests get no file addresses on OpenClaw, and a sandboxed or remote Session
cannot serve `present_artifact` files. OpenClaw's own native media appears
after the Session is reloaded, not while the turn streams.

### Creator Agent

OpenClaw's Agent summary has no field for a role, so AOS treats the Agent with
the reserved id `aos-agent-creator` as the creator behind **New Agent** and
keeps it out of the roster. Create it with `openclaw agents add` and give its
workspace a copy of the `aos-agent-creator` skill. After the user confirms a
definition, the creator runs `openclaw agents add` as the skill's
`reference/harness-openclaw.md` describes, so it needs OpenClaw's command
execution tool.

## Agent icons

Each Agent's icon is stored in the `identity.avatar` field of the Agent's own
authored entry in `agents.list`. Only a non-creator Agent with its own entry
can change its icon; the implicit default Agent cannot. Visibility changes are
unsupported on OpenClaw. OpenClaw's own Control UI reads `identity.avatar` as
a file path, so after AOS writes a token such as `ring/blue` it may show a
broken or default avatar there. The first workspace open against a gateway
that serves icons saves one for every Agent with an authored entry.

## Folder

Each Agent's folder is the `workspace` field on its `agents.list` row.

## Capability limits

- AOS reads provider Agents, Sessions, history, model catalog, context usage, runs, questions, permissions, and supported image/file attachments.
- Session creation, rename, pin, archive, delete, and Artifacts are available. Todos, Activity, edit/regenerate, steering, visibility changes, and read state are unavailable. Voice becomes available when the gateway `voice` block is configured; see [Use voice](../chat-voice.md).
- An invitation can resolve only a pre-existing reserved OpenClaw Session; a new guest invitation gets no Session.
- Device identity and tokens are server-only. Treat pairing or authentication failures as private gateway configuration problems, never as browser credentials.

## Verify

Confirm the gateway reaches OpenClaw with the device files it was given:

```bash
bunx vitest run packages/tools-mcp
curl --fail --silent --show-error http://127.0.0.1:3000/api/v1/readyz
```

Under Compose that request goes through Caddy to the gateway's operator
listener; against a local gateway use `http://127.0.0.1:4100/api/v1/readyz`.

Native live acceptance has not been run; mocked protocol tests do not prove a paired live OpenClaw journey.

For connection problems, see [Troubleshooting](../troubleshooting.md).
