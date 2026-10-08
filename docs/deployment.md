# Deploy AOS

AOS is a Vite application that builds to static assets. The production stack
has three parts: the aos-ui web server (`server/cli.ts`), which serves those
assets, the page policy, and `/runtime-config.json`; the harness-gw gateway,
which owns the `/api/v1` API and the ACP WebSocket; and Caddy, which joins
them on one origin per lane.

## Build static assets

```bash
bun install
bun run build
```

The output is written to `dist/`, including `dist/build-id`. Serve it with
`bun run web:serve` (see [Configuration](configuration.md#web-server)) or a
static host that:

- returns `index.html` for valid application routes;
- serves `/runtime-config.json` without long-lived caching, with the build's
  `buildId` added;
- gives hashed assets immutable caching; and
- forwards `/api/v1`, including WebSocket upgrades on `/api/v1/acp`, to the
  gateway without turning gateway failures into SPA responses.

The supplied web server and `deploy/Caddyfile` implement these behaviors.

## Run fixture mode with Compose

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.fixture.json \
  docker compose up --build
```

Open <http://localhost:3000>. `compose.yaml` runs `caddy`, `web`, and
`tools-mcp`; there is no gateway in fixture mode. Caddy's liveness check is
`/healthz` on the operator lane, which reaches the web server:

```bash
curl --fail --silent http://127.0.0.1:3000/healthz
```

## Tools MCP server

Every Compose file set, fixture mode included, starts a `tools-mcp` service:
the stateless MCP server in `packages/tools-mcp` that offers `render_chart`,
`render_map`, `render_stats`, and `present_artifact`. It is built from the
`tools-mcp` stage of the `Dockerfile`, serves Streamable HTTP at `/mcp` and a
liveness check at `/health`, and holds no state. Its tools are MCP Apps whose
views are built into the image.

The server has no authentication, so Compose always publishes it on
`127.0.0.1:${AOS_UI_TOOLS_MCP_PORT:-4110}`; `AOS_UI_BIND_ADDRESS` does not
widen it. A harness on the same host registers `http://127.0.0.1:4110/mcp`; a
Compose service, such as the optional OpenCode container, uses
`http://tools-mcp:4110/mcp`. On Hermes and OpenCode the gateway reads those
views itself from the URL the harness registered. A containerized gateway does
not share the host's loopback, so its configuration can override that URL per
server under
[`mcpApps.fallback.servers.NAME.url`](configuration.md#mcp-apps-fallback).
Without Compose, run it with `bun run tools-mcp:serve`.

```bash
curl --fail --silent http://127.0.0.1:4110/health
```

Each runtime guide explains how to register the server with that harness.

## Lanes and Caddy

A harness overlay adds the `gateway` service (image
`${HARNESS_GW_IMAGE:-ghcr.io/almogbaku/harness-gw:0.1.0}`) and the guest lane.
Caddy is then the only published lane listener:

| Lane     | Host port (default) | Caddy   | Gateway listener | Web server listener |
| -------- | ------------------- | ------- | ---------------- | ------------------- |
| Operator | `3000`              | `18080` | `gateway:4100`   | `web:4200`          |
| Guest    | `3001`              | `18081` | `gateway:4101`   | `web:4201`          |

On each lane, `/api/v1/*` goes to the gateway and everything else to the web
server. Which port a request reaches, never its path, decides whether it is a
guest's. Caddy answers only `127.0.0.1`, `localhost`, and the lane's
`AOS_UI_PUBLIC_HOST` or `AOS_UI_GUEST_PUBLIC_HOST`; any other `Host` gets 421.
Set those variables to the name the browser uses, such as a tailnet name, and
never to `localhost` or `127.0.0.1`, which Caddy rejects as a duplicate host.

The gateway is API-only: it answers nothing outside `/api/v1`. Its liveness
endpoint is `/api/v1/healthz` (always HTTP 200; `degraded` in the body means
the native link is lost but the gateway is running) and its readiness endpoint
`/api/v1/readyz` (503 when the runtime is unavailable), both on the operator
lane:

```bash
curl --fail --silent http://127.0.0.1:3000/api/v1/healthz
curl --fail --silent http://127.0.0.1:3000/api/v1/readyz
```

The operator listener has no application authentication: anyone who can reach
it has full operator access. The per-Agent address
`/api/v1/acp/agents/<agentId>` scopes a connection to one Agent; it is not an
access boundary and must never be exposed publicly. Operator-only routes, such
as invitation creation and push, answer 404 on the guest lane.

Each gateway listener accepts a WebSocket upgrade or state-changing request
only with an `Origin` on its `allowedOrigins` list, which defaults to its
`publicOrigin`; see
[harness-gw `docs/protocol.md`](https://github.com/AlmogBaku/harness-gw/blob/main/docs/protocol.md#origins).
An external reverse proxy in front of Caddy must pass WebSocket upgrades on
`/api/v1/acp` and the `Origin` and `Host` headers unchanged.

## Deploy the Hermes operator surface

Hermes is AOS's primary and first-supported harness. Start with this deployment
unless you specifically operate another runtime.

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.hermes.json \
HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.yaml \
HARNESS_GW_HERMES_TOKEN_FILE=/absolute/private/path/hermes-token \
HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.hermes.yaml up --build
```

Hermes remains independently operated. Start the gateway configuration from
harness-gw's
[`examples/config.hermes.example.yaml`](https://github.com/AlmogBaku/harness-gw/blob/main/examples/config.hermes.example.yaml)
and customize its listener origins and Hermes address. Its `mcpApps` block
points the gateway at `http://tools-mcp:4110/mcp` for the `aos-ui` server,
which a Hermes on the host registers as `http://127.0.0.1:4110/mcp`. Hermes
uses one server token file for both operator and guest requests. Guest
invitations have a separate signing-key file. Secret files must be owner-only
and contain no public runtime configuration. The mounted
[`runtime-config.hermes.json`](../deploy/runtime-config.hermes.json) contains
only `{ "mode": "aos" }`.

On Linux, set `AOS_UI_HOST_UID` and `AOS_UI_HOST_GID` to the numeric owner of
the secret files before starting any harness overlay. Local Docker Compose
bind-mounts secret files and does not apply the long-form secret ownership
fields, so the non-root gateway runs with these IDs. The defaults are
`1000:1000`.

The private configuration file is bind-mounted the same way and keeps its host
ownership, so it must be owned by `AOS_UI_HOST_UID` at mode `0600` or `0640`,
or owned by root at mode `0644` so the container user can still read it, and it
must never be group- or world-writable. A file owned by a third user, or left
at mode `0664` by `umask 002`, fails startup with an error naming the failed
check. Verify it before every start or reload:

```bash
stat -c '%U %a' /absolute/private/path/harness-gw.yaml
```

The overlays always open the guest lane, and the example configures the
gateway's guest listener. For an operator-only deployment, remove the `guest`
block from the gateway configuration and leave the guest port unexposed. The
one Hermes token and runtime instance remain unchanged.
TODO(ALM-36): confirm whether Caddy's guest site may stay mounted with no
gateway guest listener (it would answer 502 on `/api/v1`) or needs a private
overlay that drops it.

Read [Run with Hermes](runtimes/hermes.md) for tools registration, profile,
and authentication setup.

## Deploy the OpenClaw operator surface

The OpenClaw overlay starts the gateway beside the UI. It attaches to an
independently operated OpenClaw Gateway; it does not publish a native Gateway
route.

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.openclaw.json \
HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.openclaw.yaml \
HARNESS_GW_OPENCLAW_DEVICE_IDENTITY_FILE=/absolute/private/path/openclaw-device-identity \
HARNESS_GW_OPENCLAW_DEVICE_TOKEN_FILE=/absolute/private/path/openclaw-device-token \
HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.openclaw.yaml up --build
```

Start from harness-gw's
[`examples/config.openclaw.example.yaml`](https://github.com/AlmogBaku/harness-gw/blob/main/examples/config.openclaw.example.yaml),
which uses `ws://host.docker.internal:18789` for a host Gateway. Change that
URL for your topology and ensure the Gateway is reachable from the container.
Device identity and token files remain private to the gateway.

## Deploy the OpenCode operator surface

OpenCode is not a browser runtime. The browser uses the gateway; the optional
overlay is a local all-in-one composition that starts OpenCode beside it.

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.opencode.json \
HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.opencode.yaml \
HARNESS_GW_OPENCODE_PASSWORD_FILE=/absolute/private/path/opencode-password \
HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  docker compose -f compose.yaml -f compose.opencode.yaml up --build
```

The overlay builds and starts OpenCode, mounts the external worktree at
`/workspace`, and keeps native port `4096` internal to Compose. OpenCode waits
for a healthy `tools-mcp` service and registers it as `aos-ui` through
`AOS_UI_TOOLS_MCP_URL=http://tools-mcp:4110/mcp`. The gateway uses the private
OpenCode password file and the `opencode:4096` service address from harness-gw's
[`examples/config.opencode.example.yaml`](https://github.com/AlmogBaku/harness-gw/blob/main/examples/config.opencode.example.yaml).
`AOS_UI_AWS_CONFIG_DIR` overrides the host AWS credentials directory mounted
into the OpenCode container (default `$HOME/.aws`).

Read [OpenCode server adapter status](runtimes/opencode.md) before using it.

## Host networking

`deploy/compose.host.yaml` runs every service on the host network, each bound
to loopback: Caddy on `18080` and `18081`, the gateway on `4100` and `4101`,
the web server on `4200` and `4201`, and `tools-mcp` on `4110`. Use it on a
host whose exit-node routes capture the Docker bridge subnets, where a
bridged, published port is unreachable. Add it after the harness overlay (and
after `compose.push.yaml` when push is enabled):

```bash
docker compose -f compose.yaml -f compose.hermes.yaml \
  -f deploy/compose.host.yaml up --build
```

Compose ignores published ports here, so `AOS_UI_WEB_PUBLISHED_PORT` and the
bind variables have no effect: the lanes are `http://127.0.0.1:18080` and
`http://127.0.0.1:18081`, usually behind an external ingress. The gateway
configuration must list `127.0.0.1` as both listener hosts, its origins must
match the address the browser uses, and the `aos-ui` MCP App override can use
`http://127.0.0.1:4110/mcp`, the same URL the host harness registers.

## Web Push state and VAPID secret

Web Push is optional. `compose.push.yaml` passes push settings to the gateway as
container environment variables; the private configuration file needs no
`push` block. Add `-f compose.push.yaml` after the harness overlay and set
these three variables:

```bash
HARNESS_GW_PUSH_STATE_DIR=/var/lib/harness-gw/push     # operator-owned directory
HARNESS_GW_VAPID_PRIVATE_KEY_FILE=/absolute/private/path/vapid-private-key
HARNESS_GW_PUSH_VAPID_SUBJECT=mailto:ops@example.com   # or https: URL
```

`HARNESS_GW_PUSH_VAPID_SUBJECT` is the VAPID contact that push services use to
reach the operator. It is required when the push overlay is active, and a
systemd-managed deployment reads it from `EnvironmentFile=`, so
`/etc/aos-ui/aos-ui.env` must set it.

For example, with Hermes:

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.hermes.json \
HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.yaml \
HARNESS_GW_HERMES_TOKEN_FILE=/absolute/private/path/hermes-token \
HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
HARNESS_GW_PUSH_STATE_DIR=/var/lib/harness-gw/push \
HARNESS_GW_VAPID_PRIVATE_KEY_FILE=/absolute/private/path/vapid-private-key \
HARNESS_GW_PUSH_VAPID_SUBJECT=mailto:ops@example.com \
  docker compose -f compose.yaml -f compose.hermes.yaml -f compose.push.yaml up --build
```

Omitting `-f compose.push.yaml` leaves tab-only delivery active and requires
none of these variables.

**One-time setup.** Run `deploy/setup-push.sh` as root from the checkout
directory to generate the VAPID key, create the state directory, and append the
three push variables plus `AOS_UI_HOST_UID` and `AOS_UI_HOST_GID` to the env
file, each only when missing:

```bash
sudo bash deploy/setup-push.sh \
  --key-file  /etc/aos-ui/secrets/vapid-private-key \
  --state-dir /var/lib/harness-gw/push \
  --env-file  /etc/aos-ui/aos-ui.env \
  --subject   "mailto:ops@example.com" \
  --uid       1002 \
  --gid       1002
```

The script is idempotent: it skips steps that are already complete. After it
succeeds, add `-f compose.push.yaml` to `ExecStart`, `ExecReload`, and
`ExecStop` in the systemd service and run `systemctl daemon-reload && systemctl
reload aos-ui`.

**State directory.** The gateway writes device registrations to
`${HARNESS_GW_PUSH_STATE_DIR}`. Create it before the first start and ensure the
gateway user owns it:

```bash
mkdir -p /var/lib/harness-gw/push
chown <UID>:<GID> /var/lib/harness-gw/push
```

`compose.push.yaml` mounts this as a bind mount rather than a named volume
because a named volume is initially root-owned while the gateway runs as the
host UID. The gateway refuses to start if the directory is missing or
unwritable.

**VAPID secret.** Generate a key pair once and keep only the private key:

```bash
bunx web-push generate-vapid-keys
# copy only the private key (43-character base64url) into the key file
chmod 0600 /absolute/private/path/vapid-private-key
```

**HTTPS and outbound access.** Web Push requires an HTTPS origin (or
`localhost`). Plain-HTTP deployments keep tab-only delivery; the notification
settings UI reflects this. The gateway must also be able to reach the browser
vendors' push services outbound (Firebase FCM, Apple APNs, Mozilla Autopush,
and equivalents); block that egress only if you intend to disable push.

**Security posture.** The operator listener is unauthenticated by design on a
trusted private network. Push adds device registration routes and the
gateway's first outbound requests to caller-supplied endpoints. Mitigations:
mutating routes require a listed origin; endpoints are validated (HTTPS,
default port, no credentials or query string) and every resolved address must
be publicly routable — private, loopback, link-local, and carrier-grade-NAT
ranges such as a tailnet's 100.64/10 block are refused before any outbound
request; payloads are end-to-end encrypted and content-free; push topics are
opaque. Accepted residual: anyone who can reach the listener may register,
delete, or fill the 32 device slots; an invited guest whose prompts cause the
Agent to ask questions can raise input notifications for the operator at the
coalescing rate (nothing is dropped; revoke the invitation to stop); a small
DNS check-to-connect window remains.

## Voice provider key files

Voice provider key files are optional. When the gateway configuration includes
a `voice` block with `apiKeyFile` entries, mount those files into the gateway
container. There is no dedicated voice Compose overlay; use a user-owned
`compose.override.yaml` alongside the harness overlay:

```yaml
# compose.override.yaml — not tracked; adjust paths and IDs for your setup
secrets:
  voice-stt-api-key:
    file: ${AOS_UI_VOICE_STT_API_KEY_FILE}
  voice-tts-api-key:
    file: ${AOS_UI_VOICE_TTS_API_KEY_FILE}

services:
  gateway:
    secrets:
      - source: voice-stt-api-key
        target: /run/secrets/voice-stt-api-key
        uid: "${AOS_UI_HOST_UID:-1000}"
        gid: "${AOS_UI_HOST_GID:-1000}"
        mode: 0400
      - source: voice-tts-api-key
        target: /run/secrets/voice-tts-api-key
        uid: "${AOS_UI_HOST_UID:-1000}"
        gid: "${AOS_UI_HOST_GID:-1000}"
        mode: 0400
```

Set the two path variables before starting:

```bash
AOS_UI_VOICE_STT_API_KEY_FILE=/absolute/private/path/voice-stt-api-key
AOS_UI_VOICE_TTS_API_KEY_FILE=/absolute/private/path/voice-tts-api-key
```

Reference the mounted paths in the gateway configuration as the `apiKeyFile`
values for each voice direction (e.g. `/run/secrets/voice-stt-api-key`). The
mounted files must be owner-only and follow the same rules as
`runtime.tokenFile`. The key value itself never goes in `.env`, the Compose
environment, or the gateway configuration file — the variables above carry file
paths only, unlike OpenCode's env-borne `AOS_UI_OPENAI_COMPATIBLE_API_KEY`,
which is a different credential.

## Use hot reload in containers

`compose.dev.yaml` runs the Vite dev server in the `web` service, behind the
same Caddy site, with `AOS_UI_GATEWAY_TARGET=http://gateway:4100`. For fixture
mode with source hot-reload:

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.fixture.json \
  docker compose -f compose.yaml -f compose.dev.yaml up --build
```

With a harness overlay before it, Vite reaches that overlay's gateway. The
development overlay serves the operator surface only, so the guest lane answers
502; use the production `web` target to try the guest page. It bind-mounts the
source and keeps `node_modules` in a named volume.

## Change public configuration

Compose mounts the file selected by `AOS_UI_RUNTIME_CONFIG_FILE` into the web
container, which serves it at `/runtime-config.json`. Modify or replace that
host file, then recreate the web container. The frontend image does not need to
be rebuilt. Open tabs pick up a new build on their next reconnect or focus,
when the served `buildId` changes.

See the [configuration reference](configuration.md) for accepted fields and
secret boundaries.

## Network exposure

All published ports bind to `127.0.0.1` by default, and the `tools-mcp` port
never binds anywhere else. `AOS_UI_WEB_PUBLISHED_PORT` (default `3000`) and
`AOS_UI_GUEST_PUBLISHED_PORT` (default `3001`) set the host-side published
ports for the operator and guest lanes. Set `AOS_UI_BIND_ADDRESS` or
`AOS_UI_GUEST_BIND_ADDRESS` only when another host must connect, set the
matching `AOS_UI_PUBLIC_HOST` or `AOS_UI_GUEST_PUBLIC_HOST`, and configure the
corresponding exact browser origin in the gateway. A wider bind requires TLS in
front because the gateway rejects non-loopback `http:` origins.

> [!WARNING]
> The operator lane has no application login. Treat a wider operator bind as a
> trusted-private-network deployment and place appropriate authentication and
> TLS controls in front of it. A guest JWT does not authorize access to the
> operator lane.

The selected native runtime must listen on an address reachable from the
gateway container. A host-loopback-only Hermes or OpenClaw listener is not
reachable through `host.docker.internal`; use
[host networking](#host-networking) or a reachable address.

## Systemd and a private operator UI

For a host-managed deployment, one template `aos-ui.service.template` in
[`deploy/systemd`](../deploy/systemd) runs the Compose service as
`Type=oneshot, RemainAfterExit=yes`. The unit's `ExecStart` passes
`-f compose.yaml -f compose.<runtime>.yaml`; a runtime deployment therefore
needs both files. Further overlays, such as `compose.push.yaml`,
`deploy/compose.host.yaml`, or a host-owned overlay, go after the harness
overlay in all three `Exec` lines. `ExecReload` recreates the containers
without tearing down the stack. `TimeoutStartSec=10min` covers the initial
image build.

The service owns both lanes:

- the trusted operator lane is published on loopback port `3000` by default;
- the optional JWT-scoped guest lane is published separately on loopback port
  `3001` by default.

An external reverse proxy may expose only the guest lane for invited chat. It
must pass WebSocket upgrades on `/api/v1/acp` and must not route the operator
lane or any native Hermes endpoint.

Copy and substitute the template outside the checkout; it is not an
installer and intentionally contains no domain, proxy provider, tunnel, or
credential defaults. Follow [`aos-deploy`'s systemd reference](../.agents/skills/aos-deploy/references/systemd.md)
when using that template.

Keep public runtime JSON separate from service configuration. A process managed
by systemd receives only its unit, `EnvironmentFile=`, credentials, and other
service-manager settings: editing a runtime `.env` does not update that
process. Store native tokens and invite signing keys in an operator-managed
secret facility such as systemd encrypted credentials, never in
`/runtime-config.json`, `VITE_*`, or a shell startup file.

After changing the unit or gateway configuration, validate it before reload:

```bash
systemd-analyze verify /etc/systemd/system/aos-ui.service
systemctl daemon-reload
```

Use Cloudflare Tunnel only when the operator selects it. Tunnel ingress must
target the loopback guest lane exclusively; it must not expose the private
operator lane, a native runtime's own endpoints, `/auth`, or a host Docker
socket. Then verify the guest root, that an unauthenticated
`GET /api/v1/runtime` on the guest host returns `401`, that operator-only
routes such as `POST /api/v1/guest-invitations` return `404` there, and that
`/auth/` cannot reach the native runtime. The guest origin remains a separate
host and lane; it never reaches the operator listener.

## Persistence and shutdown

Provider persistence remains native:

- Hermes keeps all state in the operator-managed Hermes installation.
- OpenClaw keeps state in its independently operated Gateway and backing services.
- Independently operated OpenCode keeps all state in its own worktree and native data directories.
- The optional OpenCode overlay uses the external worktree plus the `opencode-data` named volume.
- The web and gateway containers hold no conversation database; with push
  enabled, the gateway keeps device registrations in its state directory.

Stop AOS with the same file set used to start it. For fixture mode:

```bash
docker compose -f compose.yaml down
```

For the optional bundled OpenCode composition:

```bash
docker compose -f compose.yaml -f compose.opencode.yaml down
```

Do not add `-v` unless you intend to delete named native-state volumes.

## Validate Compose changes

```bash
bunx vitest run test/containers/compose.test.ts
docker compose -f compose.yaml config --quiet
HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.yaml \
  HARNESS_GW_HERMES_TOKEN_FILE=/absolute/private/path/hermes-token \
  HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.hermes.yaml config --quiet
HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.yaml \
  HARNESS_GW_HERMES_TOKEN_FILE=/absolute/private/path/hermes-token \
  HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  HARNESS_GW_PUSH_STATE_DIR=/absolute/operator/dir \
  HARNESS_GW_VAPID_PRIVATE_KEY_FILE=/absolute/private/path/vapid-private-key \
  HARNESS_GW_PUSH_VAPID_SUBJECT=mailto:ops@example.com \
  docker compose -f compose.yaml -f compose.hermes.yaml -f compose.push.yaml config --quiet
HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.yaml \
  HARNESS_GW_HERMES_TOKEN_FILE=/absolute/private/path/hermes-token \
  HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.hermes.yaml -f deploy/compose.host.yaml config --quiet
HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.openclaw.yaml \
  HARNESS_GW_OPENCLAW_DEVICE_IDENTITY_FILE=/absolute/private/path/openclaw-device-identity \
  HARNESS_GW_OPENCLAW_DEVICE_TOKEN_FILE=/absolute/private/path/openclaw-device-token \
  HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.openclaw.yaml config --quiet
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.opencode.yaml \
  HARNESS_GW_OPENCODE_PASSWORD_FILE=/absolute/private/path/opencode-password \
  HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.opencode.yaml config --quiet
```

When container behavior changes, also build the affected image and smoke the
Caddy, web, and gateway health endpoints and one ACP stream through Caddy.
Native live acceptance has not been run for the OpenClaw or OpenCode attachment
paths.
