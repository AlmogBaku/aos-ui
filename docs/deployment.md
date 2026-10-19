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
`bun run web:serve` (`server/cli.ts`) alongside `deploy/Caddyfile`. The
aos-ui web server applies the MCP App sandbox rule — routing by resolved file
rather than by path, so every spelling of the sandbox path is handled — which
a static file server cannot do. A static host is no longer a supported way to
serve the UI. See [Configuration](configuration.md#web-server) and
[MCP App sandbox origins](#mcp-app-sandbox-origins).

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
`${HARNESS_GW_IMAGE:-ghcr.io/almogbaku/harness-gw:0.13.0@sha256:3e8dfd369cd3695b83b41a1340fdf66bcb4aca4b05c874ed927ad763738e64cf}`) and the guest lane.
Caddy is then the only published lane listener:

| Lane     | Host port (default) | Caddy   | Gateway listener | Web server listener |
| -------- | ------------------- | ------- | ---------------- | ------------------- |
| Operator | `3000`              | `18080` | `gateway:4100`   | `web:4200`          |
| Guest    | `3001`              | `18081` | `gateway:4101`   | `web:4201`          |

On each lane, `/api/v1/*` goes to the gateway and everything else to the web
server. Which port a request reaches, never its path, decides whether it is a
guest's. Caddy answers only `127.0.0.1`, `localhost`, and the lane's
`AOS_UI_PUBLIC_HOST` or `AOS_UI_GUEST_PUBLIC_HOST`; any other `Host` gets 421.
Set those variables to the name the browser uses, such as a tailnet name.

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

## MCP App sandbox origins

The MCP Apps spec requires a view's sandbox to have an origin different from
every page that hosts it. AOS UI gives the whole deployment one sandbox origin:
a static page the aos-ui web server serves from an address of its own, under
each view's own Content Security Policy, which only the lanes' own pages may
frame. Any separate name, or a lane's name on another port, differs from the
lanes' origins. Both lanes' views load from it.

Three settings hold the addresses. The web server refuses to start without
them, naming each one it rejects:

| Setting | Form | Description |
| --- | --- | --- |
| `AOS_UI_PUBLIC_ORIGIN` | Comma-separated exact origins | The origins the browser opens the operator lane at |
| `AOS_UI_GUEST_PUBLIC_ORIGIN` | Comma-separated exact origins | The origins the browser opens the guest lane at; required with the guest lane on |
| `AOS_UI_MCP_APP_SANDBOX_ORIGIN` | Single exact origin | The one address every lane's views load from; its host and port differ from every lane origin's, it is `https:` when any of them is, and loopback exactly when they are |

Each value is an [exact origin](configuration.md#exact-origins):
`https://agents.example` is exact; `https://agents.example/` is not. No origin
may be in both lanes' lists.

Compose defaults all three to loopback, so local development and containerized
fixture mode need no extra configuration. The sandbox takes the operator lane's
published port, and the guest lane frames that same address:

| Variable | Compose default (ports 3000 and 3001) | Under [host networking](#host-networking) |
| --- | --- | --- |
| `AOS_UI_PUBLIC_ORIGIN` | `http://localhost:3000,http://127.0.0.1:3000` | `http://127.0.0.1:18080,http://localhost:18080` |
| `AOS_UI_GUEST_PUBLIC_ORIGIN` | `http://localhost:3001,http://127.0.0.1:3001` | `http://127.0.0.1:18081,http://localhost:18081` |
| `AOS_UI_MCP_APP_SANDBOX_ORIGIN` | `http://sandbox.localhost:3000` | `http://sandbox.localhost:18080` |

### Choosing a sandbox address

Any address whose origin differs from every lane's meets the spec: another
name, such as `https://agents-sandbox.example` or
`https://sandbox.agents.example`, or a lane's name on another port, such as
`https://agents.example:8443`. How much of the lane's site it shares follows
from the choice:

- **A registrable domain of its own** (`https://agents-sandbox.example`) is a
  different site from `https://agents.example`: its cookies and `SameSite`
  context are its own. This isolation is optional.
- **A sibling name** (`https://sandbox.agents.example`) is the same site as the
  lane. Views there can set `Domain=agents.example` cookies, and their requests
  to the lane carry its `SameSite` cookies, `SameSite=Strict` included.
  Chromium may also run same-site pages in one renderer process.
- **A port on the lane's name** (`https://agents.example:8443`) is the same
  site too, and since cookies ignore ports, it shares the lane's whole cookie
  jar: views there can read the lane's cookies that are not `HttpOnly` and set
  host-only cookies the lane then receives.

AOS itself sets only a locale preference cookie; App servers may set their
own.

For loopback development, the sandbox must be a `*.localhost` name such as
`http://sandbox.localhost:3000`, never `localhost` or a loopback address on
another port, which the gateway still answers. Vite accepts `*.localhost` names
without extra configuration. The sandbox must be loopback exactly when the
lanes' origins are: a sandbox at `http://sandbox.localhost:3000` with a lane at
`https://agents.example` stops the web server with an error naming the
mismatched setting.

### One sandbox for both lanes

Whichever lane receives a request for the sandbox address serves it. Each Caddy
site matches the same `AOS_UI_MCP_APP_SANDBOX_ORIGIN` and sends the request to
its own web listener, and every listener answers with the sandbox page whose
`frame-ancestors` names every lane's origins: the operator's, and the guest's
when the guest listener is on. Both surfaces' `/runtime-config.json` carry the
same `mcpAppSandboxOrigin`, and both pages' `frame-src` name it.

Sharing one origin across lanes shares two things. One is what the origin
stores, its web storage and cookies, which a browser keeps per profile: an
operator and a guest on their own devices never meet there, and views on
different pages cannot script each other. The other is the sandbox page's
header, whose `frame-ancestors` lists every lane's origins to whoever requests
the page: keep the operator lane's origins to names you are fine publishing.

With a public guest lane, the sandbox address must be publicly reachable too,
since guests' browsers load it. Route that public address to the guest Caddy
site alone, so the operator site stays as private as its lane. The operator's
own views then load the sandbox over that public route as well, and stop
showing while it is down. The sandbox address serves only the sandbox page and
its relay script; every other path on it, `/api/v1` included, is 404.

### Stable origins (optional) {#stable-origins-optional}

`AOS_UI_MCP_APP_STABLE_ORIGINS` is off by default. Installing AOS UI needs
nothing new; skip this section unless you specifically want Apps to run on
their own origins.

Set it to a wildcard origin:

```
AOS_UI_MCP_APP_STABLE_ORIGINS=https://*.mcp-apps.agents.example
```

The web server refuses to start when the value is not a valid
`<scheme>://*.<domain>[:port]` wildcard origin; when any lane's host or the
sandbox's is at or below `<domain>`; when the wildcard is `http:` under an
`https:` lane; or when loopback status does not match the lanes.

A view that asks for a stable domain gets its sandbox page from
`https://<32hexkey>.agents-apps.example`, with the wildcard's scheme and port,
when the domain the gateway forwarded is exactly one 32-hex-digit key label
below the wildcard's domain. Any other host at or below that domain — a label
that is 31 or 33 hex digits, a label that is not hex, an extra label, or the
wrong port — is foreign and gets **421** from Caddy; the web server itself
returns 404 for such names when reached directly, past Caddy. Nothing at or
below the domain bypasses the web server through Caddy; the gateway never sees a
stable host.

Stable hosts follow the same same-site and cookie rules as the sandbox address;
see [Choosing a sandbox address](#choosing-a-sandbox-address) for the trade-offs
of a registrable domain of its own versus a name under the lane's site.

With a public guest lane, the stable host addresses must be publicly reachable
too, for the same reason the sandbox address must: guests' browsers load them
directly. Route them through the same public path as the sandbox address, sent
to the guest Caddy site.

**DNS and certificate.** Every `<32hexkey>.agents-apps.example` host needs DNS
and a TLS certificate. A wildcard DNS record (`*` CNAME or A) covers all keys.
The certificate must cover `*.agents-apps.example`; whatever terminates TLS
issues it, for example an external Caddy using an ACME DNS challenge. A
Cloudflare-proxied wildcard is covered by the free certificate only when the
wildcard sits one level below the zone apex — for example `*.agents-apps.example`
in a zone whose apex is `agents-apps.example`. A `<domain>` that is itself a
subdomain of another zone, such as `mcp-apps.agents.example` in
`agents.example`, puts the wildcard two levels below the apex and requires
Cloudflare's paid certificate or a separate DNS zone for `mcp-apps.agents.example`.

**Caddy routing.** Both Caddy sites already match each stable host, using the
same `@stable` expression, and send it to the web server's own listener.
No manual Caddyfile change is needed; setting the variable is enough. Verify:

```bash
# A stable host reaches the web server, not the gateway:
curl -I https://<32hexkey>.agents-apps.example/api/v1/healthz   # expect 404 from the web server
curl -I https://<32hexkey>.agents-apps.example/mcp-app-sandbox.html  # expect 200

# A near-miss (wrong label length) goes through Caddy's @foreign rule:
curl -I https://<31digits>.agents-apps.example/mcp-app-sandbox.html  # expect 421 through Caddy
```

**Proxy rules.** Send only exact stable hosts — a 32-hex-digit label directly
below the wildcard's domain, on the wildcard's port — to the web server, the
same way the sandbox address is routed. The gateway must never receive a stable
host request. Any other name at or below the domain is foreign and gets 421 from
Caddy; do not let a wildcard DNS catch-all route non-stable names to the gateway.

**Tools server.** The tools server declares a stable domain for the artifact
view when both `AOS_UI_MCP_APP_STABLE_ORIGINS` and `AOS_UI_TOOLS_MCP_URL` are
set. `AOS_UI_TOOLS_MCP_URL` must equal exactly the URL the gateway dials the
tools server at, so the key the tools server computes matches the one the
gateway checks. Under the Hermes overlay, both default to
`http://tools-mcp:4110/mcp`; the gateway's `mcpApps.fallback` override names
that same URL. Under the OpenCode overlay, OpenCode registers the tools server
at `http://tools-mcp:4110/mcp` directly, so no gateway override is needed and
both default to that URL. Under host networking, both default to
`http://127.0.0.1:4110/mcp`. Set `AOS_UI_TOOLS_MCP_URL` explicitly when the
gateway's configuration dials another URL. See
[Tools MCP server configuration](configuration.md#tools-mcp-server) for the
full rules.

**Lockstep deploy.** The gateway (0.13.0) and this aos-ui build use a strict
view schema. An older aos-ui that has not consumed the 0.13.0 SDK refuses a
view carrying `domain`. Deploy and roll back the gateway and aos-ui together.

### DNS and certificate

The sandbox address is a real hostname, not a path alias, and needs its own DNS
record and TLS certificate. Add the sandbox name to the SANs of the lane's
certificate, or obtain a separate certificate for it. An external TLS reverse
proxy must serve the sandbox name alongside the lanes' names. A name proxied by
Cloudflare must sit one level below its zone, such as `sandbox.agents.example`
in the `agents.example` zone, for Cloudflare's free certificate to cover it.

### Three places that must agree

The operator lane's address must be consistent in three places:

1. **Caddy's `AOS_UI_PUBLIC_HOST`** — the hostname Caddy's foreign-host guard accepts.
2. **Web server's `AOS_UI_PUBLIC_ORIGIN`** — the full origin list the web server validates and writes into `/runtime-config.json`.
3. **Gateway's `allowedOrigins`** — the origins the gateway accepts WebSocket upgrades from.

The guest lane's address agrees the same way, in `AOS_UI_GUEST_PUBLIC_HOST`,
`AOS_UI_GUEST_PUBLIC_ORIGIN`, and the gateway's guest listener. The sandbox
address is one value, `AOS_UI_MCP_APP_SANDBOX_ORIGIN`, which Caddy's sites
match and the web server serves the sandbox page for.

Caddy routes every request for the sandbox address — any path, any method — to
the web server. The web server answers the sandbox address with the sandbox page
and its relay script only; every other path is 404. `/api/v1` never reaches the
gateway from the sandbox address.

### Your own reverse proxy

If you terminate TLS in front of Caddy or run a different reverse proxy:

- **Keep the `Host` header.** Caddy's sandbox matcher compares the request's host and port against `AOS_UI_MCP_APP_SANDBOX_ORIGIN`. A proxy that rewrites `Host` defeats both that matcher and the gateway's host check.
- **Route everything for the sandbox address to the web server** through one Caddy site: the guest site when the address is public, the operator site only when the address is as private as the operator lane. No path on the sandbox address goes to the gateway; the web server handles it all.
- **Keep the operator site as private as its lane.** A public route for the sandbox reaches the guest site alone, never the operator site.
- **Pass only the sandbox's own `Host`.** A listener in front for the sandbox address forwards only requests whose `Host` equals the sandbox's host and port, so no other name reaches the Caddy site behind it.
- **Never add the sandbox origin to the gateway's `allowedOrigins`.** The sandbox address has nothing to do with the gateway's origin policy.

For a **port-form sandbox** (`https://agents.example:8443` beside
`https://agents.example`), add a TLS listener on port 8443 that passes only
requests whose `Host` is `agents.example:8443`, keeping that header, and
forwards them to one Caddy site. A public sandbox goes to the guest site's
port: `127.0.0.1:18081` under [host networking](#host-networking), or the
published `AOS_UI_GUEST_PUBLISHED_PORT` (default `3001`) under bridged
Compose. A sandbox as private as the operator lane may go to the operator
site's port instead: `127.0.0.1:18080`, or `AOS_UI_WEB_PUBLISHED_PORT`
(default `3000`). Caddy's `@sandbox` matcher routes requests for that host and
port to the web server, as with a separate name; the gateway never sees
port-8443 requests.

The gateway answers 421 to any request whose `Host` header names a host and
port it does not serve and that is not exactly `localhost`, `127.0.0.1`, or
`[::1]`. A proxy that accidentally sends sandbox requests to the gateway will
see 421. Non-browser callers that reach the gateway by shell tool, such as
`aos-invite-link` via `AOS_GATEWAY_URL`, must name a host in the gateway's
allowed origins list, or exactly `localhost`, `127.0.0.1`, or `[::1]`; never
set `AOS_GATEWAY_URL` to a sandbox origin.

### Verify after deployment

```bash
# Sandbox address returns 404 for /api/v1 — it never reaches the gateway:
curl -I https://agents-sandbox.example/api/v1/healthz

# Lane address returns 404 for the sandbox page under every spelling:
curl -I https://agents.example/mcp-app-sandbox.html
curl -I "https://agents.example//mcp-app-sandbox.html"

# Sandbox address serves the page (200) with every lane's origins in frame-ancestors:
curl -I https://agents-sandbox.example/mcp-app-sandbox.html
# Content-Security-Policy: … frame-ancestors https://agents.example https://guests.agents.example; …

# Gateway answers 421 for a host it does not serve (host networking only):
curl -I -H "Host: agents-sandbox.example" http://127.0.0.1:4100/api/v1/healthz
```

The last check needs the gateway on the host's `127.0.0.1:4100`, as under
[host networking](#host-networking). Bridged Compose publishes no gateway port,
and Caddy never sends the sandbox address to the gateway, so there the first
check stands for it.

### Guest lane

A harness overlay turns the guest lane on, so `AOS_UI_GUEST_PUBLIC_ORIGIN` is
required there: set it to the origins guests open the lane at. The overlays
default it to loopback on `AOS_UI_GUEST_PUBLISHED_PORT`. The guest lane's views
load from the same sandbox, so its origins fall under the sandbox's rules too,
and they must sit on the same side of loopback as the operator lane's. A
loopback operator lane beside a public guest lane is therefore unsupported with
one shared sandbox, and so is a named operator lane beside the overlays'
loopback guest default; without a guest lane, add
[`deploy/compose.operator-only.yaml`](#run-without-the-guest-lane).

Apply the same DNS, certificate, and reverse-proxy rules to the guest lane's
name, and give guests' browsers a route to the sandbox address: a guest lane
behind a tunnel needs the sandbox name in that tunnel too, sent to the guest
lane like the tunnel's other name.

### Development with compose.dev.yaml

`compose.dev.yaml` defaults both lanes' origins and the sandbox origin to
loopback on the published ports, so no extra configuration is needed for local
development.
See [Use hot reload in containers](#use-hot-reload-in-containers) for the full
recipe.

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
gateway's guest listener; see [Run without the guest lane](#run-without-the-guest-lane)
for an operator-only deployment.

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

## Run without the guest lane

Each harness overlay mounts Caddy's guest site, `deploy/caddy/guest.caddy`, at
`/etc/caddy/lanes/guest.caddy`, which the Caddyfile imports. With no gateway
guest listener, that site would serve the guest page while its `/api/v1`
answers 502. For an operator-only deployment:

1. Remove the `guest` block from the gateway configuration.
2. Add `-f deploy/compose.operator-only.yaml` after the harness overlay. It
   mounts the Caddyfile without the guest site, so Caddy does not listen on
   the guest lane at all, and turns off the web server's guest listener, so
   the overlay's loopback guest origins never meet a named operator lane.
3. Keep `AOS_UI_GUEST_BIND_ADDRESS` at its loopback default and route no
   ingress to the guest port.

The one runtime instance and its credentials are unchanged, and the guest
invitation signing-key file is still required by the overlay.

## Host networking

`deploy/compose.host.yaml` runs every service on the host network, each bound
to loopback: Caddy on `18080` and `18081`, the gateway on `4100` and `4101`,
the web server on `4200` and `4201`, and `tools-mcp` on `4110`. Use it with
exactly one harness overlay, after it (and after `compose.push.yaml` when push
is enabled):

```bash
docker compose -f compose.yaml -f compose.hermes.yaml \
  -f deploy/compose.host.yaml up --build
```

With `compose.opencode.yaml`, also add `deploy/compose.host.opencode.yaml`
after it: OpenCode then listens on `127.0.0.1:4096`, so the gateway
configuration's OpenCode base URL becomes `http://127.0.0.1:4096`, and it
registers the tools server as `http://127.0.0.1:4110/mcp`.

Use host networking in either of these cases:

- **An exit node captures the Docker bridges.** A Tailscale exit node (and
  similar VPN clients) installs a policy routing table, 52 for Tailscale, whose
  routes cover the private ranges Docker assigns to its bridges, such as
  `172.16.0.0/12`, and send them to the VPN interface. The host then cannot
  reach its own containers: a bridged, published port hangs, and a container
  cannot reach a host service. Use this overlay, or add an `ip rule` with a
  higher priority than the VPN's rules that looks up the `main` table for the
  Docker bridge subnets.
- **Hermes listens on the host.** A bridged gateway must reach Hermes at an
  address Hermes accepts in its `Host` check, and Hermes rejects
  `host.docker.internal`. Use this overlay so the gateway reaches a host-local
  Hermes on `127.0.0.1`, or bind Hermes where the bridge can reach it under a
  `Host` name it accepts.

Compose ignores published ports here, so `AOS_UI_WEB_PUBLISHED_PORT` and the
bind variables have no effect: the lanes are `http://127.0.0.1:18080` and
`http://127.0.0.1:18081`, usually behind an external ingress, and the lanes'
origin settings default to them, with the one sandbox at
`http://sandbox.localhost:18080`. The gateway configuration must list
`127.0.0.1` as both listener hosts, its origins must match the address the
browser uses, and the `aos-ui` MCP App override can use
`http://127.0.0.1:4110/mcp`, the same URL the host harness registers.

## Web Push state and VAPID secret

Web Push is optional. `compose.push.yaml` passes push settings to the gateway as
container environment variables; the private configuration file needs no
`push` block. Add `-f compose.push.yaml` after the harness overlay and set
these three variables:

```bash
HARNESS_GW_PUSH_STATE_DIR=/var/lib/harness-gw/push     # operator-owned directory
HARNESS_GW_PUSH_VAPID_PRIVATE_KEY_FILE=/absolute/private/path/vapid-private-key
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
HARNESS_GW_PUSH_VAPID_PRIVATE_KEY_FILE=/absolute/private/path/vapid-private-key \
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
request; payloads are end-to-end encrypted and carry the Agent name, Session
title, and a masked preview of the request text; the push service sees a stable
per-Session pseudonym as the topic (a keyed hash), plus TTL and urgency; content
goes only to devices refreshed within 30 days, and registrations idle for 90 days
are removed; request text is credential-masked for every runtime; input
notifications stay in the OS Notification Center until dismissed. Accepted
residual: anyone who can reach the listener may register, delete, or fill the 32
device slots; anyone who can reach the operator listener can mute or hide an
editable Agent, silencing its pushes on every device (the guest lane cannot:
its Agent update is not a method it offers); masking is pattern-based, so a
credential with no telling name, header, URL position, or known provider shape
reaches the preview as written; an invited guest whose prompts cause the Agent to ask questions can
raise one input notification per invited Session per coalescing window, and its
text can be shaped by the guest (plain text only; it opens only AOS); a small
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

With a harness overlay before it, Vite reaches that overlay's gateway. Vite
serves the operator surface only, so the overlay's `web-guest` service, the
production web server built from the checkout, serves the guest page without
hot reload; rerun with `--build` to pick up a change there. The overlay
bind-mounts the source and keeps `node_modules` in a named volume.

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
reachable through `host.docker.internal`, and Hermes rejects that name in its
`Host` check anyway; use [host networking](#host-networking) or a reachable
address.

## Systemd and a private operator UI

For a host-managed deployment, one template `aos-ui.service.template` in
[`deploy/systemd`](../deploy/systemd) runs the Compose service as
`Type=oneshot, RemainAfterExit=yes`. Each `Exec` line builds the Compose file
list as `-f compose.yaml -f compose.<runtime>.yaml`, then the
`@AOS_HOST_NETWORK@` slot, so a runtime deployment needs both files. Replace
the slot with nothing for the bridged shape, or with
`-f @AOS_CHECKOUT@/deploy/compose.host.yaml` for
[host networking](#host-networking) (OpenCode adds
`-f @AOS_CHECKOUT@/deploy/compose.host.opencode.yaml` after it); substitute it
before `@AOS_CHECKOUT@`:

```bash
sed -e 's|@AOS_HOST_NETWORK@|-f @AOS_CHECKOUT@/deploy/compose.host.yaml|' \
  -e 's|@AOS_CHECKOUT@|/absolute/path/to/aos-ui|g' -e 's|@AOS_RUNTIME@|hermes|g' \
  deploy/systemd/aos-ui.service.template > /etc/systemd/system/aos-ui.service
```

Further overlays, such as `compose.push.yaml` or
`deploy/compose.operator-only.yaml`, go between the harness overlay and the
slot, and a host-owned overlay after it, in all three `Exec` lines.
`ExecReload` recreates the containers without tearing down the stack. `TimeoutStartSec=10min` covers the initial
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
target the loopback guest lane exclusively, for the guest name and the sandbox
name alike; it must not expose the private operator lane, a native runtime's
own endpoints, `/auth`, or a host Docker socket. Then verify the guest root, that an unauthenticated
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
  HARNESS_GW_PUSH_VAPID_PRIVATE_KEY_FILE=/absolute/private/path/vapid-private-key \
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
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.opencode.yaml \
  HARNESS_GW_OPENCODE_PASSWORD_FILE=/absolute/private/path/opencode-password \
  HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.opencode.yaml \
    -f deploy/compose.host.yaml -f deploy/compose.host.opencode.yaml config --quiet
```

When container behavior changes, also build the affected image and smoke the
Caddy, web, and gateway health endpoints and one ACP stream through Caddy.
Native live acceptance has not been run for the OpenClaw or OpenCode attachment
paths.
