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
- forwards only `/api/aos/v1` to the private TypeScript runtime proxy,
  preserving HTTP streaming and WebSocket upgrades without turning proxy
  failures into SPA responses.

The Bun listener implements these behaviors alongside the normalized runtime API.

## Run fixture mode with Compose

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.fixture.json \
  docker compose up --build
```

Open <http://localhost:3000>. The web health endpoint is <http://localhost:3000/api/health>.

## OpenCode server-adapter development

OpenCode is not a browser runtime. Its retained overlay is for native
server-adapter development only; the browser uses the normalized AOS proxy.

There is no public OpenCode runtime configuration or direct browser route.

## Optionally run the native OpenCode composition

The supplied overlay is a local all-in-one convenience for operators who explicitly want Compose to start an OpenCode container:

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.fixture.json \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  docker compose -f compose.yaml -f compose.opencode.yaml up --build
```

The overlay builds and starts OpenCode, mounts the external worktree at `/workspace`, and publishes native port `4096` on loopback by default. Its health endpoint is `/global/health`. This optional composition does not change the general attachment model.

Read [OpenCode server adapter status](runtimes/opencode.md) before using it.

## Deploy the Hermes operator surface

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.hermes.json \
AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy-config.json \
AOS_UI_OIDC_CLIENT_SECRET_FILE=/absolute/private/path/oidc-client-secret \
AOS_UI_OPERATOR_PRINCIPAL_KEY_FILE=/absolute/private/path/operator-principal-hmac \
AOS_UI_OPERATOR_SESSION_KEY_FILE=/absolute/private/path/operator-session-key \
AOS_UI_RECONNECT_CURSOR_KEY_FILE=/absolute/private/path/reconnect-cursor-key \
AOS_UI_GUEST_HERMES_TOKEN_FILE=/absolute/private/path/guest-hermes-token \
AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.hermes.yaml up --build
```

Hermes remains independently operated. The overlay runs one Bun process that
serves static assets and the private TypeScript proxy on separate operator and
guest listeners. External ingress owns TLS; the browser uses the normalized
`/api/aos/v1` API for operator OIDC, Hermes authentication brokerage, catalogs,
history, AG-UI/SSE runs, Stop, and reconnect. The operator listener has no
guest API route, and the guest listener has no operator API route.

Start from [`deploy/proxy-config.hermes.example.json`](../deploy/proxy-config.hermes.example.json)
and customize its public origin, OIDC issuer/allowlist, and Hermes address.
The browser-broker mode is the supported auth-gated Hermes path. Secret files
must be owner-only and contain no public runtime configuration. The mounted
[`runtime-config.hermes.json`](../deploy/runtime-config.hermes.json) contains
only `{ "mode": "aos" }`.

Read [Run with Hermes](runtimes/hermes.md) for native plugin, profile, and authentication setup.

## OpenClaw status

OpenClaw is planned but unavailable on the Hermes-first normalized deployment
path. The retained `compose.openclaw.yaml` overlay and
`deploy/runtime-config.openclaw.json` are deliberately fail-closed and do not
provide a browser Gateway route or accept OpenClaw host, port, or credentials.

## Use hot reload in containers

Add `compose.dev.yaml` to the selected composition. For example:

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.fixture.json \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  docker compose \
    -f compose.yaml \
    -f compose.opencode.yaml \
    -f compose.dev.yaml \
    up --build
```

The development overlay bind-mounts frontend source and keeps `node_modules` in a named volume. Native worktree and state mounts remain separate.

## Change public configuration

Compose mounts the file selected by `AOS_UI_RUNTIME_CONFIG_FILE` at `/runtime-config.json`. Modify or replace that host file, then recreate the web container. The frontend image does not need to be rebuilt.

See the [configuration reference](configuration.md) for accepted fields and secret boundaries.

## Network exposure

All published ports bind to `127.0.0.1` by default. Set `AOS_UI_BIND_ADDRESS` only when another host must connect, and use browser-reachable runtime URLs and CORS origins.

> [!WARNING]
> The Compose stack does not provide TLS or public multi-user authentication. Treat a wider bind as a trusted-private-network deployment and place appropriate access controls in front of it.

Hermes must listen on an address reachable from the web container. A host-loopback-only listener is not reachable through `host.docker.internal`.

## Systemd and a private operator UI

For a host-managed deployment, use the provider-neutral templates in
[`deploy/systemd`](../deploy/systemd). They model two distinct surfaces:

- `aos-ui.service.template` runs the regular operator UI as a private Compose
  service. Bind it to loopback or a trusted private network; do not publish it
  through the guest host.
- `aos-gateway.service.template` runs the optional invited-chat gateway. Both
  of its listeners are loopback-bound: the operator listener remains private,
  while an external reverse proxy may reach only the guest listener. The Compose
  Hermes overlay publishes that listener separately on loopback port `3001` by
  default.
- `aos-guest-nginx.conf.template` is an example external guest-only virtual
  host. It sends the guest UI and `/api/guest/*` to the guest listener and has
  no route to native Hermes/OpenCode endpoints.

Copy and substitute the templates outside the checkout; they are not an
installer and intentionally contain no domain, proxy provider, tunnel, or
credential defaults. Follow [`aos-deploy`'s systemd reference](../.agents/skills/aos-deploy/references/systemd.md)
when using those templates.

Keep public runtime JSON separate from service configuration. A process managed
by systemd receives only its unit, `EnvironmentFile=`, credentials, and other
service-manager settings: editing a runtime `.env` does not update that
process. Store native tokens and invite signing keys in an operator-managed
secret facility such as systemd encrypted credentials, never in
`/runtime-config.json`, `VITE_*`, or a shell startup file.

After changing a unit or proxy configuration, validate it before reload:

```bash
systemd-analyze verify /etc/systemd/system/aos-ui.service
systemd-analyze verify /etc/systemd/system/aos-gateway.service
systemctl daemon-reload
```

Use Cloudflare Tunnel only when the operator selects it. Tunnel ingress must
target the loopback guest listener exclusively; it must not expose the private
operator UI, `/hermes`, `/auth`, a native runtime, or a host Docker socket.
Then verify the guest root and an unauthenticated `/api/guest/v1` request
(`401`/`404` as appropriate), and that `/hermes/`, `/auth/`, and non-guest
`/api/` routes cannot reach the native runtime. The guest origin remains a
separate host and listener; it is never routed through the operator
`/api/aos/v1` boundary.

## Persistence and shutdown

Provider persistence remains native:

- Independently operated OpenCode keeps all state in its own worktree and native data directories.
- The optional OpenCode overlay uses the external worktree plus the `opencode-data` named volume.
- Hermes keeps all state in the operator-managed Hermes installation.
- The separately operated OpenClaw guest gateway keeps all state and device
  credentials in its own installation; the browser runtime lane is unavailable.
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

## Validate Compose changes

```bash
bunx vitest run test/containers/compose.test.ts
docker compose -f compose.yaml config --quiet
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  docker compose -f compose.yaml -f compose.opencode.yaml config --quiet
docker compose -f compose.yaml -f compose.hermes.yaml config --quiet
```

When runtime container behavior changes, also build the affected image and
smoke its health and streaming endpoints.

## P1 cutover blockers retained for later deletion

The old native forwarding artifacts remain in the checkout until parity is
proven and are not part of the Hermes operator deployment:

- the local Vite Hermes forwarding shortcut and its direct runtime configuration
  example; OpenClaw's runtime example is already fail-closed;
- the optional legacy Go `aos-gateway` guest listener and its acceptance
  coverage, retained until the TypeScript dual-listener path has proven parity;
- the planned OpenClaw deployment overlay and live acceptance coverage.

Delete those artifacts only after an approved Hermes operator and guest
acceptance run proves authentication, Agent/Session ownership, history,
streaming, Stop, reconnect, invitation expiry/isolation, and deployment
rollback on the normalized proxy path.
