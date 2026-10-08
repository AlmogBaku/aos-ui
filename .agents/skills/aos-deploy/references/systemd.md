# Systemd deployment reference

Use this reference after the operator chose systemd. The checked-in templates
are starting points, not host-independent commands.

## Private operator UI

Copy `deploy/systemd/aos-ui.service.template` to `/etc/systemd/system/aos-ui.service`,
replacing `@AOS_CHECKOUT@` with the absolute checkout path and `@AOS_RUNTIME@` with
the selected runtime name (e.g. `hermes`, `openclaw`, `opencode`). The template
lists only `compose.yaml` and the harness overlay; add any further `-f` after the
harness overlay, in the same order in `ExecStart`, `ExecReload`, and `ExecStop`:
`compose.push.yaml` when push is enabled, then
`@AOS_CHECKOUT@/deploy/compose.host.yaml` when the host needs host networking
(its exit-node routes capture the Docker bridge subnets), then an optional
host-owned overlay such as `/etc/aos-ui/compose.service.yaml`. With
`deploy/compose.host.yaml`, nothing is published: Caddy listens on
`127.0.0.1:18080` and `127.0.0.1:18081` itself, and the gateway configuration
must list `127.0.0.1` as both listener hosts. Set `AOS_UI_HOST_UID` and `AOS_UI_HOST_GID` in
`/etc/aos-ui/aos-ui.env` to match the host user the containers should run as; the
runtime overlays use these to set `user:` and volume ownership.
Bind the published lane ports to loopback or an explicitly trusted private interface.
Do not put a public DNS host or guest proxy route in this service.

Check for an existing host runbook (an untracked operator-specific guide) before
planning any changes to services or configuration.

Validate before enabling:

```bash
systemd-analyze verify /etc/systemd/system/aos-ui.service
docker compose --project-directory /absolute/path/to/aos-ui \
  -f /absolute/path/to/aos-ui/compose.yaml \
  -f /absolute/path/to/aos-ui/compose.<runtime>.yaml \
  config --quiet
```

When push and further overlays are active, validate with every file the unit uses, in its order:

```bash
docker compose --project-directory /absolute/path/to/aos-ui \
  -f /absolute/path/to/aos-ui/compose.yaml \
  -f /absolute/path/to/aos-ui/compose.<runtime>.yaml \
  -f /absolute/path/to/aos-ui/compose.push.yaml \
  -f /absolute/path/to/aos-ui/deploy/compose.host.yaml \
  -f /etc/aos-ui/compose.service.yaml \
  config --quiet
```

Inspect both system and user units — review and dev gateways often run in user
scope:

```bash
systemctl list-units 'aos*'
systemctl --user list-units 'aos*'
```

Use the gateway's `readyz` (`/api/v1/readyz` on the operator lane) to confirm
it is ready, not only `healthz`. Caddy's own `/healthz` on the operator lane
checks Caddy and the web server.

## Gateway configuration and secrets

The service template runs the repository's Compose definition, whose harness
overlay runs the harness-gw gateway image (`HARNESS_GW_IMAGE` overrides it).
Start from harness-gw's `examples/config.<runtime>.example.yaml` (summarized in
`docs/configuration.md`), store the host copy outside the checkout as a YAML
file, and point `HARNESS_GW_CONFIG_FILE` at that absolute path from
`/etc/aos-ui/aos-ui.env`. The file must be owned by the gateway user
(`AOS_UI_HOST_UID`) or by root and must not be group- or world-writable; a file
left at mode `0664` by `umask 002` fails startup. The `invite` command requires
`--config` or `HARNESS_GW_CONFIG_FILE`; it never discovers a path. The same
configuration defines the distinct operator and optional guest listeners, their
browser origins, and the one runtime.

Set the Compose secret-file variables for the Hermes token and guest invitation
signing key (`HARNESS_GW_HERMES_TOKEN_FILE` and
`HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE`, the `compose.hermes.yaml` secrets
block), and `AOS_UI_PUBLIC_HOST`/`AOS_UI_GUEST_PUBLIC_HOST` for the names the
browser uses (never `localhost` or `127.0.0.1`). For Web Push, also add
`HARNESS_GW_PUSH_VAPID_SUBJECT` (a `mailto:` or `https:` contact URL) to
`/etc/aos-ui/aos-ui.env`; `deploy/setup-push.sh` appends the three push
variables plus `AOS_UI_HOST_UID` and `AOS_UI_HOST_GID`, each only when missing,
when run with `--subject`. After the script succeeds, insert
`-f @AOS_CHECKOUT@/compose.push.yaml` after the runtime overlay in `ExecStart`,
`ExecReload`, and `ExecStop`, then run
`systemctl daemon-reload && systemctl reload aos-ui`. Create and protect those files with the
host's documented secret-management workflow. If encrypted credentials are
unavailable, use root-owned mode-0600 files mounted as Compose secrets; do not
put secret values in a world-readable unit, `.env`, shell profile, gateway
configuration file, or browser runtime JSON.

Published ports are commonly overridden in a host overlay; the operator lane
remains loopback-only regardless. The public reverse proxy points only at the
guest lane, published with `AOS_UI_GUEST_BIND_ADDRESS` and
`AOS_UI_GUEST_PUBLISHED_PORT` (or Caddy's `127.0.0.1:18081` under
`deploy/compose.host.yaml`); it never points at the operator lane, a gateway or
web server listener directly, or the native runtime port.

## Reverse proxy and optional Cloudflare Tunnel

Route the guest hostname to the guest lane only. On that lane Caddy sends only
`/api/v1` to the gateway's guest listener and everything else to the web
server's guest surface, which answers 404 for `/auth` and every other path it
does not serve, and the gateway answers 404 for operator-only routes. Caddy
answers only the lane's own `Host` names (421 otherwise). Configure a separate
guest virtual host so an unmatched route cannot fall through to a private AOS
or native runtime host.

If the operator explicitly selected Cloudflare Tunnel, its single ingress
hostname may point to the loopback guest lane. Do not add `/hermes`,
`/auth`, the operator lane, or the native runtime as tunnel ingress
services. DNS/tunnel credentials are operator-managed external state and require
confirmation before changing.

Verify unauthenticated `GET /api/v1/runtime` returns `401` through the guest
host and `POST /api/v1/guest-invitations` returns `404` there. Confirm the
guest host never reaches the operator lane and neither host proxies native
runtime routes.

## Tools MCP server and Hermes skills

The unit's Compose stack includes the `tools-mcp` service, so `ExecReload`
rebuilds and restarts it with the rest of the stack. Check it after a reload
with `curl --fail http://127.0.0.1:4110/health` (or the configured
`AOS_UI_TOOLS_MCP_PORT`); it stays on loopback whatever the operator bind.

Each Hermes profile that uses the tools registers
`http://127.0.0.1:4110/mcp` as `aos-ui` under `mcp_servers` in its own
`config.yaml`; `hermes -p PROFILE mcp test aos-ui` confirms it. The gateway
reads the chart, map, and stats views itself; from its container it uses
`mcpApps.fallback.servers.aos-ui.url: http://tools-mcp:4110/mcp` in the gateway
config instead of that loopback URL (under `deploy/compose.host.yaml` the
loopback URL works, and `tools-mcp` does not resolve). Restarting the
AOS unit does not require restarting Hermes. Skills are plain directories:
copy `shared/invite-link` or `shared/agent-creator` into the profile's
`skills/`, or list the checkout's `shared/` under `skills.external_dirs`, and
restart the managed `hermes serve` so its skills index reloads.
