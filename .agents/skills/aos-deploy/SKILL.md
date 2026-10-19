---
name: aos-deploy
description: Deploy an AOS operator UI or invited guest chat after an operator explicitly asks to install, expose, change, or verify production services.
---

# Deploy AOS

Use this only when explicitly invoked. It is an operator-assistance skill, not
an automatic installer. Keep the regular AOS UI private; expose a guest
surface only when the operator has chosen its domain, proxy, and TLS boundary.

## Inspect before planning

Read `README.md`, `docs/deployment.md`, `docs/invite-chat.md`, and the
selected runtime guide. Check whether an untracked host runbook exists before
planning any service or configuration changes. Inspect the existing services,
listeners, gateway configuration, runtime health, and Git state without changing
them. Do not stop or replace an existing service until its owner and replacement
are clear.

Collect only unresolved choices: runtime, private operator address, optional
guest hostname, reverse proxy/TLS provider, paths for build and configuration,
service account, and whether the native runtime may intentionally mint guest
invitations through the operator lane. The configured
`guest.publicOrigin` is the canonical guest URL; changing it invalidates
existing invite links.

## Plan and confirm mutations

Present the exact files, services, ports, external DNS/Tunnel changes, and
secrets that would change. State that Caddy publishes two loopback lane ports
in front of the gateway and the web server: the operator lane (`3000`) is
private and the guest lane (`3001`) may receive only the guest host. Require
a direct confirmation immediately before writes, service reloads/restarts, DNS
changes, tunnel creation, or stopping duplicate processes. Treat each later material change as a new confirmation point.

Use the provider-neutral template under `deploy/systemd/` and the harness-gw
gateway configuration summarized in `docs/configuration.md` (start from
harness-gw's `examples/config.<runtime>.example.yaml`); adapt them to the
selected host. The private gateway configuration is a YAML file. It must be
owned by the gateway user (`AOS_UI_HOST_UID`) or root and must not be group- or
world-writable; a file left at mode `0664` by `umask 002` fails startup. Its
`publicOrigin` (or `allowedOrigins`) for each lane must be the exact origin the
browser uses. Point `HARNESS_GW_CONFIG_FILE` at the absolute host path in
`/etc/aos-ui/aos-ui.env`, beside the harness overlay's secret-file variables
(`HARNESS_GW_HERMES_TOKEN_FILE`, `HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE`, or
the OpenClaw and OpenCode equivalents). Set `AOS_UI_PUBLIC_HOST` and
`AOS_UI_GUEST_PUBLIC_HOST` to the names the browser uses.

**Before configuring addresses, ask for:**

1. The exact origin(s) the browser will open the operator lane at (comma-separated if more than one), for `AOS_UI_PUBLIC_ORIGIN`.
2. The same for the guest lane, for `AOS_UI_GUEST_PUBLIC_ORIGIN`. A harness overlay turns the guest lane on, so this is required unless `deploy/compose.operator-only.yaml` is added, and it must sit on the same side of loopback as the operator's: a loopback operator lane beside a public guest lane is unsupported with one shared sandbox.
3. One MCP App sandbox address for the whole deployment, for `AOS_UI_MCP_APP_SANDBOX_ORIGIN`. The MCP Apps spec only requires its origin to differ from every lane's, so any separate name (`https://sandbox.agents.example`, `https://agents-sandbox.example`) or a lane's name on another port (`https://agents.example:8443`) works. State the trade-off without steering: a registrable domain of its own is a different site, optional extra isolation; a sibling name or a port is the same site as the lane and its views' requests to the lane carry the lane's `SameSite=Strict` cookies; the port form also shares the lane's whole cookie jar, since cookies ignore ports, so its views can read the lane's cookies that are not `HttpOnly` and set host-only cookies the lane receives. With a public guest lane, the sandbox address must be publicly reachable too; it serves only the sandbox page and its script, and the operator's own views then load it over that public route and stop showing while it is down. Its page's header lists every lane's origins to whoever requests it, so the operator's origins must be names the operator is fine publishing. A name proxied by Cloudflare must be one level below its zone for the free certificate.

Set all three in `/etc/aos-ui/aos-ui.env` (or `.env` for a Compose-only deployment). Both lanes share the one sandbox. The web server refuses to start if any is missing or not an exact origin, if the sandbox shares a host and port with a lane origin, is loopback while a lane is not or the reverse, is `http:` under an `https:` lane, or is loopback but not a `*.localhost` name, or if one origin is in both lanes' lists.

**Reverse proxy rules for the sandbox address:**

- Route every request for the sandbox address to the web server through one Caddy site, never to the gateway: the guest site (Caddy then sends it to `web:4201`) when the address is public, the operator site (`web:4200`) only when it is as private as the operator lane. A guest lane behind a tunnel needs the sandbox name in that tunnel too, sent to the guest lane; a public port-form sandbox forwards to the guest Caddy port.
- Keep the operator site as private as its lane: a public sandbox route never reaches it.
- Keep the original `Host` header, and let a listener in front for the sandbox pass only requests whose `Host` equals the sandbox's host and port.
- Never add the sandbox origin to the gateway's `allowedOrigins`.

`AOS_GATEWAY_URL` must name a host the gateway's listener allows, or exactly `localhost`, `127.0.0.1`, or `[::1]`; any other host gets 421. Never set it to a sandbox origin.

**After setting addresses, check:**

```bash
# Sandbox address must not reach the gateway:
curl -I https://<sandbox-address>/api/v1/healthz    # expect 404

# Lane address must refuse the sandbox page under every spelling:
curl -I https://<lane-address>/mcp-app-sandbox.html   # expect 404
curl -I "https://<lane-address>//mcp-app-sandbox.html" # expect 404

# Sandbox address must serve the page with correct frame-ancestors:
curl -I https://<sandbox-address>/mcp-app-sandbox.html
# Content-Security-Policy header must include: frame-ancestors with every lane address (operator, and guest when active)

# Host networking only (bridged Compose publishes no gateway port, and Caddy
# never sends the sandbox address to the gateway): the gateway answers 421 for
# a host it does not serve.
curl -I -H "Host: <sandbox-address-host>" http://127.0.0.1:4100/api/v1/healthz
```

The gateway's `invite` command requires `--config` or
`HARNESS_GW_CONFIG_FILE`; it never discovers a default path. On a host whose
exit-node routes capture the Docker bridges, or whose Hermes listens on host
loopback, fill the unit's `@AOS_HOST_NETWORK@` slot with
`-f deploy/compose.host.yaml` (plus `deploy/compose.host.opencode.yaml` for
OpenCode; see `docs/deployment.md#host-networking`). For Web
Push deployments, also set `HARNESS_GW_PUSH_VAPID_SUBJECT` (a `mailto:` or
`https:` contact URL) in the env file; `deploy/setup-push.sh`
appends the three push variables plus `AOS_UI_HOST_UID` and `AOS_UI_HOST_GID`,
each only when missing, when run with `--subject`. After the script succeeds,
add `-f compose.push.yaml` after the runtime overlay in `ExecStart`,
`ExecReload`, and `ExecStop`, then run
`systemctl daemon-reload && systemctl reload aos-ui`. Do not install Cloudflare,
create a tunnel, alter DNS, or assume Tailscale unless the operator explicitly
selected it. For Cloudflare, route the selected guest hostname to the guest
listener and retain the same guest-only path boundary.

## Stable origins (optional)

Skip this section unless the operator explicitly asks for App stable origins.

`AOS_UI_MCP_APP_STABLE_ORIGINS` is off by default and requires no change for a
standard deployment. Set it only when an App needs a fixed origin of its own
(OAuth callback, CORS or API-key allowlist, persistent `localStorage`). Before
setting it, confirm:

1. **A wildcard DNS record** (`*.agents-apps.example` CNAME or A) points to
   the Caddy host for every stable key the operator expects.
2. **A wildcard TLS certificate** (`*.agents-apps.example`) is in place.
   Whatever terminates TLS issues it, for example an external Caddy with an
   ACME DNS challenge. A Cloudflare-proxied wildcard is covered by the free
   certificate only when the wildcard sits one level below the zone apex — for
   example `*.agents-apps.example` in a `agents-apps.example` zone of its own.
   A `<domain>` that is a subdomain of another zone, such as
   `mcp-apps.agents.example` in `agents.example`, needs Cloudflare's paid
   certificate or a separate domain, as in the example above.
3. **The domain sits outside every lane and sandbox.** The web server refuses
   `AOS_UI_MCP_APP_STABLE_ORIGINS` when any lane's or the sandbox's host is at
   or below the wildcard's domain.

Set both variables in `/etc/aos-ui/aos-ui.env` (or `.env`):

```bash
AOS_UI_MCP_APP_STABLE_ORIGINS=https://*.agents-apps.example
AOS_UI_TOOLS_MCP_URL=http://tools-mcp:4110/mcp   # the URL the gateway dials
```

`AOS_UI_TOOLS_MCP_URL` must equal the URL the gateway dials the tools server
at, including any `mcpApps.fallback.servers.aos-ui.url` override in the gateway
configuration. Under the Hermes and OpenCode overlays it defaults to
`http://tools-mcp:4110/mcp`; under host networking it defaults to
`http://127.0.0.1:4110/mcp`.

After setting them, check the tools server's stderr on start: it logs one line
naming the stable domain it declared, or why it declared none. Then verify:

```bash
# A stable host serves the sandbox page, not a gateway route:
curl -I https://<32hexkey>.agents-apps.example/api/v1/healthz  # 404
curl -I https://<32hexkey>.agents-apps.example/mcp-app-sandbox.html  # 200
```

Deploy and roll back the gateway and aos-ui together: the strict view schema
means an older browser client refuses a view carrying `domain`.
See [Stable origins](../../docs/deployment.md#stable-origins-optional) and
[Troubleshooting](../../docs/troubleshooting.md#a-view-loads-from-the-shared-sandbox-instead-of-its-stable-origin).

## Secrets and runtime integration

Put browser-safe runtime configuration in `/runtime-config.json` only. Keep
gateway signing keys and native tokens in an operator-managed secret facility,
not Git, shell startup files, or browser variables. The service manager must
receive its environment; editing a runtime `.env` alone does not update an
already-managed systemd service. Set `AOS_UI_HOST_UID` and `AOS_UI_HOST_GID`
on Linux so container volumes are owned by the correct host user.

The `aos-invite-link` skill mints bearer invitations with one `curl` to the
operator lane's `POST /api/v1/guest-invitations`. The gateway admits any
request that carries no `Origin` (only a foreign or `null` one is refused), so
any shell-capable agent that can reach the operator lane can mint them. Set `AOS_GATEWAY_URL` to that operator URL
in the harness environment only after an explicit opt-in; without it the skill
reports setup-needed. Never give the native runtime the gateway configuration
or the invitation signing-key file.

The AOS UI tools reach a harness through the stateless `tools-mcp` service,
which Compose always publishes on `127.0.0.1:${AOS_UI_TOOLS_MCP_PORT:-4110}`
(or `bun run tools-mcp:serve` outside Compose). It has no authentication; never
widen its bind. Register `http://127.0.0.1:4110/mcp` as the `aos-ui` MCP server
in each Hermes profile's `mcp_servers` and confirm it with
`hermes -p PROFILE mcp test aos-ui`; a running `hermes serve` picks it up
without a restart. The gateway reads the chart, map, and stats views from that
URL too, but a gateway container does not share the host's loopback: its
config sets `mcpApps.fallback.servers.aos-ui.url: http://tools-mcp:4110/mcp`. Install the `aos-invite-link` and `aos-agent-creator` skills
by copying them into the profile's `skills/` directory or listing the checkout's
`shared/` directory under `skills.external_dirs`, then restart `hermes serve`.
Register the server with OpenClaw disabled and let the gateway enable it per
Session, as the OpenClaw runtime guide describes; charts, maps, and stats also
need `mcp.apps.enabled: true` on the Gateway.

## Upgrade live gateway configuration

Use this procedure when an operator needs to change a key in the live gateway YAML without rebuilding or redeploying an image. Require a direct confirmation before writing any file or reloading the service.

### 1. Back up the live configuration

The YAML holds paths to secrets, not secret values. A backup is safe:

```bash
cp /etc/harness-gw/config.yaml /tmp/harness-gw-backup-$(date +%Y%m%d).yaml
```

### 2. Prepare and validate the new configuration

Copy the live YAML to a temporary path, apply the changes there, then check it with `config check` inside the running gateway container. It validates the file, its `HARNESS_GW_*` overrides, and the schema, reads every secret file the configuration names, and starts nothing; the container already has those secrets mounted:

```bash
cp /etc/harness-gw/config.yaml /tmp/harness-gw-test.yaml
# Apply changes to /tmp/harness-gw-test.yaml
docker ps --format '{{.Names}}' | grep -- '-gateway-1$'
docker cp /tmp/harness-gw-test.yaml <that container>:/tmp/config.yaml
docker exec <that container> bun run src/cli.ts config check --config /tmp/config.yaml
```

It prints `configuration is valid` on success. A failure logs a `gateway.start_failed` event with one line per failing field, or names the secret file it could not read; fix `/tmp/harness-gw-test.yaml` and retry.

### 3. Install and restart the gateway

Install the file with the owner and mode startup requires, then restart the gateway container, which reads its configuration only when it starts:

```bash
install -o root -g root -m 0644 /tmp/harness-gw-test.yaml /etc/harness-gw/config.yaml
docker ps --format '{{.Names}}' | grep -- '-gateway-1$'
docker restart <that container>
docker exec <that container> cat /run/harness-gw/config.yaml
```

The last command must show the new file. `systemctl reload aos-ui` does not apply a configuration-only change: `ExecReload` recreates a container only when its image changed, and the gateway's single-file mount keeps showing the replaced file until the container restarts. Restart the container itself rather than running `docker compose restart` by hand, which fails without the unit's `EnvironmentFile`. When the same change also rebuilds an image, the reload recreates the container and it reads the new file.

### 4. Probe health and readiness

```bash
curl --fail --silent http://127.0.0.1:3000/api/v1/healthz
curl --fail --silent http://127.0.0.1:3000/api/v1/readyz
```

These go through Caddy's operator lane; with `deploy/compose.host.yaml` use `http://127.0.0.1:18080` (Caddy) or `http://127.0.0.1:4100` (the gateway itself). `curl --fail --silent http://127.0.0.1:3000/healthz` checks Caddy and the web server. `healthz` always returns 200. `readyz` returns 200 only when the runtime is reachable; 503 means the gateway started but cannot reach the configured runtime — check the runtime address and token.

### 5. Watch one old tab reload in the aos-test Agent only

Open a browser window at the aos-test Agent only (never at an Agent that holds real work). An existing tab should reconnect and continue its Session normally; it reloads once only when the web server's `buildId` in `/runtime-config.json` changed. Do not proceed until the tab is stable.

## Verify before handoff


Run the relevant repository checks and service-manager validation. Check the
private operator endpoint from its intended private network and the guest root
over its public origin. Confirm unauthenticated `GET /api/v1/runtime` on the
guest host returns `401`, operator-only routes such as
`POST /api/v1/guest-invitations` return `404` there, and guest attempts to
reach `/hermes/` and `/auth/` do not reach the native runtime.

Verify that both gateway listeners resolve the same configured Runtime instance while
retaining distinct route and projection policies. Exercise one normalized
ACP run stream and reconnect without prompt replay, and confirm guest output is
projected before delivery. Inspect the browser bundle and network boundary for
native provider routes, URLs, and credentials. Confirm the deployed guest
origin matches invite minting before issuing a link. After a
configuration-only reload the verification is health, readiness, runtime status,
and the public runtime config; the full list above applies to code changes.
Report all changed service names, addresses, and any intentionally unperformed
external step.
