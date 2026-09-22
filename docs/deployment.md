# Deploy AOS

AOS is a Vite application that builds to static assets. The supplied production image serves those assets with the Bun proxy and loads runtime selection from a read-only configuration file.

## Build static assets

```bash
bun install
bun run build
```

The output is written to `dist/`. Serve it through a static host that:

- returns `index.html` for valid application routes;
- serves `/runtime-config.json` without long-lived caching;
- gives hashed assets immutable caching;
- exposes `/api/health` for the web service; and
- forwards `/api/aos/v1` and `/api/guest/v1` to the private TypeScript runtime proxy,
  passing WebSocket upgrades on `/api/*/acp` without turning proxy
  failures into SPA responses.

The Bun listener implements these behaviors alongside the normalized runtime API.

## Run fixture mode with Compose

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.fixture.json \
  docker compose up --build
```

Open <http://localhost:3000>. The liveness endpoint is `/api/aos/v1/healthz`; the readiness endpoint is `/api/aos/v1/readyz` (returns 503 when the runtime is unavailable).

## Deploy the Hermes operator surface

Hermes is AOS's primary and first-supported harness. Start with this deployment
unless you specifically operate another runtime.

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.hermes.json \
AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy.yaml \
AOS_UI_HERMES_TOKEN_FILE=/absolute/private/path/hermes-token \
AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.hermes.yaml up --build
```

Hermes remains independently operated. The overlay runs one Bun process that
serves static assets and the private TypeScript proxy on separate operator and
guest listeners. External ingress owns TLS; the browser uses the normalized
`/api/aos/v1` API for catalogs, history, and ACP v2 WebSocket run streams at
`/api/aos/v1/acp`. External reverse proxies must pass WebSocket upgrades on
`/api/*/acp`.
The operator listener has no application authentication: anyone who can reach
it has full operator access. The operator listener has no guest API route, and
the guest listener has no operator API route.

Start from [`deploy/proxy.hermes.example.yaml`](../deploy/proxy.hermes.example.yaml)
and customize its listener origins and Hermes address. Hermes uses one server
token file for both operator and guest requests. Guest invitations have a
separate signing-key file. Secret files must be owner-only and contain no
public runtime configuration. The mounted
[`runtime-config.hermes.json`](../deploy/runtime-config.hermes.json) contains
only `{ "mode": "aos" }`.

On Linux, set `AOS_UI_HOST_UID` and `AOS_UI_HOST_GID` to the numeric owner of
the secret files before starting any runtime overlay. Local Docker Compose
bind-mounts secret files and does not apply the long-form secret ownership
fields, so the non-root proxy runs with these IDs. The defaults are `1000:1000`.

The example enables the guest listener. For an operator-only deployment,
remove the `guest` block and its invitation-key secret mount from a private
overlay. The one Hermes token and runtime instance remain unchanged.

Read [Run with Hermes](runtimes/hermes.md) for native plugin, profile, and authentication setup.

## Deploy the OpenClaw operator surface

The OpenClaw overlay starts only the AOS proxy and static UI. It attaches to an
independently operated Gateway; it does not publish a native Gateway route.

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.openclaw.json \
AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy.openclaw.yaml \
AOS_UI_OPENCLAW_DEVICE_IDENTITY_FILE=/absolute/private/path/openclaw-device-identity \
AOS_UI_OPENCLAW_DEVICE_TOKEN_FILE=/absolute/private/path/openclaw-device-token \
AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.openclaw.yaml up --build
```

The private example uses `ws://host.docker.internal:18789` for a host Gateway.
Change that URL for your topology and ensure the Gateway is reachable from the
container. Device identity and token files remain private to the proxy.

## Deploy the OpenCode operator surface

OpenCode is not a browser runtime. The browser uses the normalized AOS proxy;
the optional overlay is a local all-in-one composition that starts OpenCode
beside that proxy.

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.opencode.json \
AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy.opencode.yaml \
AOS_UI_OPENCODE_PASSWORD_FILE=/absolute/private/path/opencode-password \
AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  docker compose -f compose.yaml -f compose.opencode.yaml up --build
```

The overlay builds and starts OpenCode, mounts the external worktree at
`/workspace`, and keeps native port `4096` internal to Compose. The proxy uses
the private OpenCode password file and the `opencode:4096` service address in
the supplied private example. Its operator health endpoint is
`/api/aos/v1/healthz`.

Read [OpenCode server adapter status](runtimes/opencode.md) before using it.

## Web Push state and VAPID secret

Web Push is optional. `compose.push.yaml` passes push settings to the proxy as
container environment variables; the private configuration file needs no `push`
block. Add `-f compose.push.yaml` after the runtime overlay and set these three
variables:

```bash
AOS_UI_PUSH_STATE_DIR=/var/lib/aos-ui/push            # operator-owned directory
AOS_UI_VAPID_PRIVATE_KEY_FILE=/absolute/private/path/vapid-private-key
AOS_UI_PUSH_VAPID_SUBJECT=mailto:ops@example.com      # or https: URL
```

`AOS_UI_PUSH_VAPID_SUBJECT` is the VAPID contact that push services use to
reach the operator. It is required when the push overlay is active.

For example, with Hermes:

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.hermes.json \
AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy.yaml \
AOS_UI_HERMES_TOKEN_FILE=/absolute/private/path/hermes-token \
AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
AOS_UI_PUSH_STATE_DIR=/var/lib/aos-ui/push \
AOS_UI_VAPID_PRIVATE_KEY_FILE=/absolute/private/path/vapid-private-key \
AOS_UI_PUSH_VAPID_SUBJECT=mailto:ops@example.com \
  docker compose -f compose.yaml -f compose.hermes.yaml -f compose.push.yaml up --build
```

Omitting `-f compose.push.yaml` leaves tab-only delivery active and requires
none of these variables.

**One-time setup.** Run `deploy/setup-push.sh` as root from the checkout
directory to generate the VAPID key, create the state directory, and append all
three variables to the env file in one step:

```bash
sudo bash deploy/setup-push.sh \
  --key-file  /etc/aos-ui/secrets/vapid-private-key \
  --state-dir /var/lib/aos-ui/push \
  --env-file  /etc/aos-ui/aos-ui.env \
  --subject   "mailto:ops@example.com" \
  --uid       1002 \
  --gid       1002
```

The script is idempotent: it skips steps that are already complete. After it
succeeds, add `-f compose.push.yaml` to `ExecStart`, `ExecReload`, and
`ExecStop` in the systemd service and run `systemctl daemon-reload && systemctl
reload aos-ui`.

**State directory.** The proxy writes device registrations to
`${AOS_UI_PUSH_STATE_DIR}`. Create it before the first start and ensure the
proxy user owns it:

```bash
mkdir -p /var/lib/aos-ui/push
chown <UID>:<GID> /var/lib/aos-ui/push
```

`compose.push.yaml` mounts this as a bind mount rather than a named volume
because a named volume is initially root-owned while the proxy runs as the host
UID. The proxy refuses to start if the directory is missing or unwritable.

**VAPID secret.** Generate a key pair once and keep only the private key:

```bash
bunx web-push generate-vapid-keys
# copy only the private key (43-character base64url) into the key file
chmod 0600 /absolute/private/path/vapid-private-key
```

**HTTPS and outbound access.** Web Push requires an HTTPS origin (or
`localhost`). Plain-HTTP deployments keep tab-only delivery; the notification
settings UI reflects this. The proxy must also be able to reach the browser
vendors' push services outbound (Firebase FCM, Apple APNs, Mozilla Autopush,
and equivalents); block that egress only if you intend to disable push.

**Security posture.** The operator lane is unauthenticated by design on a
trusted private network. Push adds device registration routes and the proxy's
first outbound requests to caller-supplied endpoints. Mitigations: mutating
routes require the AOS origin; endpoints are validated (HTTPS, default port,
no credentials or query string) and every resolved address must be publicly
routable — private, loopback, link-local, and carrier-grade-NAT ranges such as
a tailnet's 100.64/10 block are refused before any outbound request; payloads
are end-to-end encrypted and content-free; push topics are opaque. Accepted
residual: anyone who can reach the listener may register, delete, or fill the
32 device slots; an invited guest whose prompts cause the Agent to ask
questions can raise input notifications for the operator at the coalescing rate
(nothing is dropped; revoke the invitation to stop); a small DNS
check-to-connect window remains.

## Voice provider key files

Voice provider key files are optional. When the proxy configuration includes a
`voice` block with `apiKeyFile` entries, mount those files into the container.
There is no dedicated voice Compose overlay; use a user-owned
`compose.override.yaml` alongside the runtime overlay:

```yaml
# compose.override.yaml — not tracked; adjust paths and IDs for your setup
secrets:
  voice-stt-api-key:
    file: ${AOS_UI_VOICE_STT_API_KEY_FILE}
  voice-tts-api-key:
    file: ${AOS_UI_VOICE_TTS_API_KEY_FILE}

services:
  web:
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

Reference the mounted paths in the proxy configuration as the `apiKeyFile`
values for each voice direction (e.g. `/run/secrets/voice-stt-api-key`). The
mounted files must be owner-only and follow the same rules as
`runtime.tokenFile`. The key value itself never goes in `.env`, the Compose
environment, or the proxy configuration file — the variables above carry file
paths only, unlike OpenCode's env-borne `AOS_UI_OPENAI_COMPATIBLE_API_KEY`,
which is a different credential.

## Use hot reload in containers

`compose.dev.yaml` swaps the production Bun server command for a Vite dev server. It only works correctly in fixture mode or when `AOS_UI_PROXY_TARGET` points at a separately running proxy (the container does not start the proxy). For fixture mode with source hot-reload:

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.fixture.json \
  docker compose -f compose.yaml -f compose.dev.yaml up --build
```

The development overlay bind-mounts frontend source and keeps `node_modules` in a named volume. It does not start or manage a runtime proxy.

## Change public configuration

Compose mounts the file selected by `AOS_UI_RUNTIME_CONFIG_FILE` at `/runtime-config.json`. Modify or replace that host file, then recreate the web container. The frontend image does not need to be rebuilt.

See the [configuration reference](configuration.md) for accepted fields and secret boundaries.

## Network exposure

All published ports bind to `127.0.0.1` by default. Set
`AOS_UI_BIND_ADDRESS` or `AOS_UI_GUEST_BIND_ADDRESS` only when another host
must connect, and configure the corresponding exact browser origin. A wider
bind requires TLS in front because non-loopback `http:` origins are rejected
by the proxy's `publicOrigin` validator.

> [!WARNING]
> The operator listener has no application login. Treat a wider operator bind
> as a trusted-private-network deployment and place appropriate authentication
> and TLS controls in front of it. A guest JWT does not authorize access to the
> operator listener.

The selected native runtime must listen on an address reachable from the proxy
container. A host-loopback-only Hermes or OpenClaw listener is not reachable
through `host.docker.internal`.

## Systemd and a private operator UI

For a host-managed deployment, one template `aos-ui.service.template` in
[`deploy/systemd`](../deploy/systemd) runs the Compose service as
`Type=oneshot, RemainAfterExit=yes`. The unit's `ExecStart` passes
`-f compose.yaml -f compose.<runtime>.yaml` plus an optional host overlay; a
runtime deployment therefore needs both files. `ExecReload` recreates the
containers without tearing down the stack. `TimeoutStartSec=10min` covers the
initial image build.

The service owns both distinct listeners:

- the trusted operator listener is published on loopback port `3000` by
  default;
- the optional JWT-scoped guest listener is published separately on loopback
  port `3001` by default.

An external reverse proxy may expose only the guest listener for invited chat.
It must pass WebSocket upgrades on `/api/*/acp` and must not route the
operator API or any native Hermes endpoint.

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

After changing the unit or proxy configuration, validate it before reload:

```bash
systemd-analyze verify /etc/systemd/system/aos-ui.service
systemctl daemon-reload
```

Use Cloudflare Tunnel only when the operator selects it. Tunnel ingress must
target the Bun proxy's loopback guest listener exclusively; it must not expose
the private operator UI, `/hermes`, `/auth`, a native runtime, or a host Docker socket.
Then verify the guest root and an unauthenticated `/api/guest/v1` request
(`401`/`404` as appropriate), and that `/hermes/`, `/auth/`, and non-guest
`/api/` routes cannot reach the native runtime. The guest origin remains a
separate host and listener; it is never routed through the operator
`/api/aos/v1` boundary.

## Persistence and shutdown

Provider persistence remains native:

- Hermes keeps all state in the operator-managed Hermes installation.
- OpenClaw keeps state in its independently operated Gateway and backing services.
- Independently operated OpenCode keeps all state in its own worktree and native data directories.
- The optional OpenCode overlay uses the external worktree plus the `opencode-data` named volume.
- The web container holds no conversation database.

Stop AOS with the same file set used to start it. For the web-only attachment:

```bash
docker compose -f compose.yaml down
```

For the optional bundled OpenCode composition:

```bash
docker compose -f compose.yaml -f compose.opencode.yaml down
```

Do not add `-v` unless you intend to delete named native-state volumes.

## Cutover from JSON

Existing JSON configuration files continue to work because JSON is valid YAML.
Rename at leisure and point `AOS_UI_PROXY_CONFIG_FILE` at the new name before
the next reload. Push deployments require three additional steps:

1. Add `AOS_UI_PUSH_VAPID_SUBJECT` to `/etc/aos-ui/aos-ui.env`. Re-running
   `deploy/setup-push.sh` with the same arguments appends only what is missing.
2. Optionally remove the `push` block from the private configuration file; the
   `compose.push.yaml` overlay now supplies all three push fields as container
   environment variables.
3. Confirm the file is owned by `AOS_UI_HOST_UID` (or by root) and is not
   group- or world-writable. Compose bind mounts keep host ownership, so a file
   owned by a third user, or left at mode `0664` by `umask 002`, fails startup
   with an error naming the failed check. Check with:
   ```bash
   stat -c '%U %a' /etc/aos-ui/proxy.yaml
   ```
   Before reloading, make it either owned by `AOS_UI_HOST_UID` at mode `0600`
   or `0640`, or owned by root at mode `0644` so the container user can still
   read it.

The pre-YAML configuration environment variable is rejected on startup with a
message pointing to `--config` or `AOS_UI_PROXY_CONFIG_FILE`.

## Validate Compose changes

```bash
bunx vitest run test/containers/compose.test.ts
docker compose -f compose.yaml config --quiet
AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy.yaml \
AOS_UI_HERMES_TOKEN_FILE=/absolute/private/path/hermes-token \
  AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.hermes.yaml config --quiet
AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy.yaml \
AOS_UI_HERMES_TOKEN_FILE=/absolute/private/path/hermes-token \
AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
AOS_UI_PUSH_STATE_DIR=/absolute/operator/dir \
AOS_UI_VAPID_PRIVATE_KEY_FILE=/absolute/private/path/vapid-private-key \
AOS_UI_PUSH_VAPID_SUBJECT=mailto:ops@example.com \
  docker compose -f compose.yaml -f compose.hermes.yaml -f compose.push.yaml config --quiet
AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy.openclaw.yaml \
  AOS_UI_OPENCLAW_DEVICE_IDENTITY_FILE=/absolute/private/path/openclaw-device-identity \
  AOS_UI_OPENCLAW_DEVICE_TOKEN_FILE=/absolute/private/path/openclaw-device-token \
  AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.openclaw.yaml config --quiet
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy.opencode.yaml \
  AOS_UI_OPENCODE_PASSWORD_FILE=/absolute/private/path/opencode-password \
  AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.opencode.yaml config --quiet
```

When runtime container behavior changes, also build the affected image and
smoke its health and streaming endpoints. Native live acceptance has not been
run for the OpenClaw or OpenCode attachment paths.

The TypeScript proxy is the only AOS gateway.
