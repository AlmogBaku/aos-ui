# Run OpenClaw behind the AOS proxy

The browser connects only to the normalized AOS proxy (`AOS_UI_RUNTIME_MODE=aos`). The proxy connects to one independently operated OpenClaw Gateway over WebSocket, using its device identity and device token from private files. There is no browser Gateway route and AOS does not manage OpenClaw or model credentials.

## Prerequisites

- A reachable, already configured OpenClaw Gateway
- Private, owner-only files containing the Gateway device identity and device token
- A private guest-invitation signing-key file when the guest lane is enabled

Start from [`deploy/proxy.openclaw.example.yaml`](../../deploy/proxy.openclaw.example.yaml). Set `runtime.baseUrl` to the Gateway WebSocket URL reachable by the proxy and set `runtime.deviceIdentityFile` and `runtime.deviceTokenFile` to the corresponding private files. The example's `ws://host.docker.internal:18789` is for a Gateway running on the Compose host; replace it when your topology differs.

## Compose attachment

The OpenClaw overlay runs the AOS proxy and static UI only. It does not start, publish, or proxy a native OpenClaw Gateway.

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.openclaw.json \
AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy.openclaw.yaml \
AOS_UI_OPENCLAW_DEVICE_IDENTITY_FILE=/absolute/private/path/openclaw-device-identity \
AOS_UI_OPENCLAW_DEVICE_TOKEN_FILE=/absolute/private/path/openclaw-device-token \
AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.openclaw.yaml up --build
```

For a host Gateway, the overlay maps `host.docker.internal` to Docker's host gateway. A service bound only to host loopback may still be unreachable from the container; use a trusted container-reachable address and update the private proxy configuration. Keep the native Gateway off the browser-facing network.

## Register the AOS UI tools

The installation prompt, [`shared/install/PROMPT.md`](../../shared/install/PROMPT.md),
lets an agent perform the steps below; its [OpenClaw reference](../../shared/install/reference/harness-openclaw.md)
holds the exact commands. The manual steps follow.

AOS UI ships its own stateless MCP server, `packages/tools-mcp`, with
`render_chart`, `render_map`, `render_stats`, and
`present_artifact({path, title?, mimeType?})`. The first three are
[MCP Apps](#mcp-apps), so charts, maps, and stats render only while the Gateway
has `mcp.apps.enabled: true`. Run it on the Gateway host with
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

The proxy enables the server per Session: it creates Sessions with
`toolOverrides.mcpServers["aos-ui"] = true` and, before each new turn, patches
the same override onto a Session created elsewhere. OpenClaw admits
`toolOverrides` only from a device holding `operator.admin`, which the proxy
requests; a turn whose patch fails does not start. OpenClaw names the tools
`aos-ui__render_chart` and so on, and the proxy canonicalizes those names.

### MCP Apps

OpenClaw serves MCP Apps natively, and AOS renders them as App cards
([MCP Apps](../mcp-apps.md)). Register the App server under `mcp.servers` like
any other MCP server, and turn MCP Apps on in the Gateway:

```bash
openclaw mcp add NAME --url https://apps.example.test/mcp \
  --transport streamable-http
openclaw config set mcp.apps.enabled true
openclaw config validate
openclaw mcp reload
```

The proxy finds a view in the tool result's `details.mcpAppPreview`, opens it
with `mcp.app.view`, and relays the view's requests through `mcp.app.callTool`
and `mcp.app.readResource`. OpenClaw caps a view's HTML at 2 MiB. A view the
Gateway no longer holds, or any view while `mcp.apps.enabled` is off, shows
the tool call's textual details. The tool shows as `mcp__NAME__TOOL`, resolved
against the Session's `tools.effective` list. The proxy's `mcpApps` headers
block does not apply to OpenClaw.

### Creator Agent

OpenClaw's Agent summary has no field for a role, so AOS treats the Agent with
the reserved id `aos-agent-creator` as the creator behind **New Agent** and
keeps it out of the roster. Create it with `openclaw agents add` and give its
workspace a copy of the `aos-agent-creator` skill. After the user confirms a
definition, the creator runs `openclaw agents add` as the skill's
`reference/harness-openclaw.md` describes, so it needs OpenClaw's command
execution tool.

### Artifacts

- A `present_artifact` receipt is read through `sessions.files.get`: only
  files in the Session's workspace, at most 256 KiB, and only text or common
  image types (PNG, JPEG, GIF, WebP, AVIF). Anything else reads as
  unavailable.
- OpenClaw's own `MEDIA:` media is read through `artifacts.download`. These
  Artifacts appear after the Session is reloaded, not while the turn streams.

## Run locally

For a Vite development server on port `3000`, configure the private proxy to
listen on `127.0.0.1:4100` with `publicOrigin` set to
`http://localhost:3000`. Then run:

```bash
# Terminal 1
bun run proxy:serve -- --config /absolute/private/path/proxy.openclaw.yaml

# Terminal 2
AOS_UI_RUNTIME_MODE=aos \
AOS_UI_PROXY_TARGET=http://127.0.0.1:4100 \
  bun run dev
```

## Agent icons

Each Agent's icon is stored in the `identity.avatar` field of the Agent's own
authored entry in `agents.list` inside the config.

The proxy writes an icon only for a non-creator Agent (never `aos-agent-creator`)
that has its own `agents.list` entry whose `id` exactly matches. An Agent with
no authored entry cannot take a write; its `avatarEditable` is `false`. The
implicit default Agent (no entry) stays unsaved for the same reason.

The write reads the current config hash with `config.get`, then sends one
`config.patch` with that `baseHash` and exactly
`{agents:{list:[{id, identity:{avatar}}]}}`, then re-lists to confirm.
It requires `operator.admin`.

The `config.get` payload may carry credentials. The proxy keeps only the config
hash and the set of authored Agent ids, and logs or returns nothing else from
it. Every catalog read also calls `config.get` to refresh the authorized set.

Visibility changes are unsupported for OpenClaw; a patch that includes
`visibility` is rejected as a whole.

OpenClaw's own Control UI reads `identity.avatar` as a file path, so after AOS
writes a token such as `ring/blue` that field may show as a broken or default
avatar in the Control UI.

Session `createdAt` comes from the native millisecond timestamp in `createdAt`.

Before deploying Agent icons, copy the Gateway config file owner-only under
`/etc/aos-ui/backups` with `cp -p`, so it keeps its mode. The first workspace
open after the deploy writes an icon into every Agent with an authored entry.
To restore, roll the proxy back first and then restore the file; otherwise the
next open saves the icons again.

## Capability limits

- AOS reads provider Agents, Sessions, history, model catalog, context usage, runs, questions, permissions, and supported image/file attachments through the negotiated Gateway policy.
- Session creation and Artifacts are available. Rename, archive, delete, Todos, Activity, edit/regenerate, steering, visibility changes, and read state are unavailable because the pinned Gateway leaves do not prove matching native operations. Avatar writes are available for Agents with an authored config entry. Voice becomes available when the proxy `voice` block is configured; see [Use voice](../chat-voice.md).
- An invitation can resolve only a pre-existing reserved OpenClaw Session. The adapter does not create a Session for a new guest invitation because the pinned Gateway leaves do not prove equivalent native creation semantics.
- Device identity and tokens are server-only. Treat pairing/authentication failures as private proxy configuration problems, never as browser credentials.
- The proxy requests device token scopes `operator.read`, `operator.write`, `operator.approvals`, `operator.questions`, and `operator.admin`. Admin scope is what lets it enable the `aos-ui` MCP server per Session; pair the proxy device with it.
- A `pairing-required` error is terminal unless the Gateway responds with `pauseReconnect: false` or `recommendedNextStep: "wait_then_retry"`, in which case the adapter retries.

## Verify

Run the proxy checks for the selected deployment and verify the Gateway is reachable from the proxy host or container:

```bash
bunx vitest run packages/proxy/adapters/openclaw packages/tools-mcp
```

Confirm the Gateway is reachable and the device identity and token files are correct:

```bash
bun run proxy:serve -- --config /absolute/private/path/proxy.openclaw.yaml
curl --fail --silent --show-error http://127.0.0.1:4100/api/aos/v1/readyz
```

Native live acceptance has not been run; mocked protocol tests do not prove a paired live OpenClaw journey.

For connection problems, see [Troubleshooting](../troubleshooting.md).
