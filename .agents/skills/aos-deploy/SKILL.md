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
listeners, proxy configuration, runtime health, and Git state without changing
them. Do not stop or replace an existing service until its owner and replacement
are clear.

Collect only unresolved choices: runtime, private operator address, optional
guest hostname, reverse proxy/TLS provider, paths for build and configuration,
service account, and whether the native runtime may intentionally read the
private proxy configuration and its referenced invitation key. The configured
`guest.publicOrigin` is the canonical guest URL; changing it invalidates
existing invite links.

## Plan and confirm mutations

Present the exact files, services, ports, external DNS/Tunnel changes, and
secrets that would change. State that the gateway has two loopback listeners:
the operator listener is private and the guest listener may receive only the
guest host. Require a direct confirmation immediately before writes, service
reloads/restarts, DNS changes, tunnel creation, or stopping duplicate
processes. Treat each later material change as a new confirmation point.

Use the provider-neutral template under `deploy/systemd/` and the versioned
proxy configuration described in `docs/configuration.md`; adapt them to the
selected host. The private proxy configuration is a YAML file. It must be owned
by the proxy user or root and must not be group- or world-writable; a file left
at mode `0664` by `umask 002` fails startup. Point `AOS_UI_PROXY_CONFIG_FILE` at
the absolute host path in `/etc/aos-ui/aos-ui.env`. The `invite` subcommand
requires `--config` or `AOS_UI_PROXY_CONFIG_FILE`; it never discovers a default
path. For Web Push deployments, also set `AOS_UI_PUSH_VAPID_SUBJECT` (a
`mailto:` or `https:` contact URL) in the env file; `deploy/setup-push.sh`
appends the three push variables plus `AOS_UI_HOST_UID` and `AOS_UI_HOST_GID`,
each only when missing, when run with `--subject`. After the script succeeds,
add `-f compose.push.yaml` after the runtime overlay in `ExecStart`,
`ExecReload`, and `ExecStop`, then run
`systemctl daemon-reload && systemctl reload aos-ui`. Do not install Cloudflare,
create a tunnel, alter DNS, or assume Tailscale unless the operator explicitly
selected it. For Cloudflare, route the selected guest hostname to the guest
listener and retain the same guest-only path boundary.

## Secrets and runtime integration

Put browser-safe runtime configuration in `/runtime-config.json` only. Keep
gateway signing keys and native tokens in an operator-managed secret facility,
not Git, shell startup files, or browser variables. The service manager must
receive its environment; editing a runtime `.env` alone does not update an
already-managed systemd service. Set `AOS_UI_HOST_UID` and `AOS_UI_HOST_GID`
on Linux so container volumes are owned by the correct host user.

Giving Hermes read access to the private proxy configuration and its referenced
invitation signing-key file lets shell-capable agents mint bearer invitations.
Do so only after an explicit opt-in. Prefer operator-side minting when Hermes
does not need this authority; its invite skill must report that minting is
unavailable when it cannot read the required files.

The AOS UI tools reach a harness through the stateless `tools-mcp` service,
which Compose always publishes on `127.0.0.1:${AOS_UI_TOOLS_MCP_PORT:-4110}`
(or `bun run tools-mcp:serve` outside Compose). It has no authentication; never
widen its bind. Register `http://127.0.0.1:4110/mcp` as the `aos-ui` MCP server
in each Hermes profile's `mcp_servers` and confirm it with
`hermes -p PROFILE mcp test aos-ui`; a running `hermes serve` picks it up
without a restart. The proxy reads the chart, map, and stats views from that
URL too, but a proxy container does not share the host's loopback: its proxy
config sets `mcpApps.fallback.servers.aos-ui.url: http://tools-mcp:4110/mcp`. Install the `aos-invite-link` and `aos-agent-creator` skills
by copying them into the profile's `skills/` directory or listing the checkout's
`shared/` directory under `skills.external_dirs`, then restart `hermes serve`.
Register the server with OpenClaw disabled and let the proxy enable it per
Session, as the OpenClaw runtime guide describes; charts, maps, and stats also
need `mcp.apps.enabled: true` on the Gateway.

## Upgrade live proxy configuration

Use this procedure when an operator needs to change a key in the live proxy YAML without rebuilding or redeploying the image. Require a direct confirmation before writing any file or reloading the service.

### 1. Back up the live configuration

The YAML holds paths to secrets, not secret values. A backup is safe:

```bash
cp /etc/aos-ui/proxy.yaml /tmp/proxy-backup-$(date +%Y%m%d).yaml
```

### 2. Prepare and validate the new configuration

Copy the live YAML to a temporary path, apply the changes there, then start the proxy with the test file to confirm the configuration parses cleanly and the proxy reaches its ready state:

```bash
cp /etc/aos-ui/proxy.yaml /tmp/proxy-test.yaml
# Apply changes to /tmp/proxy-test.yaml
bun run proxy:serve -- --config /tmp/proxy-test.yaml
```

Watch the startup log. A `proxy.start_failed` event means the configuration is invalid; fix `/tmp/proxy-test.yaml` and retry. When the proxy logs its ready state without errors, the configuration is valid. Interrupt it with SIGTERM.

The proxy reads secret files from their original paths, so `/run/secrets` and `/etc/aos-ui/secrets` must be reachable from wherever the test command runs.

### 3. Install and reload

Overwrite the live file and reload the service:

```bash
cp /tmp/proxy-test.yaml /etc/aos-ui/proxy.yaml
systemctl reload aos-ui
```

`ExecReload` rebuilds and restarts the container stack; the proxy picks up the new configuration on the next start.

### 4. Probe health and readiness

```bash
curl --fail --silent http://127.0.0.1:4100/api/aos/v1/healthz
curl --fail --silent http://127.0.0.1:4100/api/aos/v1/readyz
```

`healthz` always returns 200. `readyz` returns 200 only when the runtime is reachable; 503 means the proxy started but cannot reach the configured runtime — check the runtime address and token.

### 5. Watch one old tab reload in the aos-test Agent only

Open a browser window at the aos-test Agent only (never at an Agent that holds real work). An existing tab should either continue its Session normally or reload once if the image build id changed. Do not proceed until the tab is stable.

## Verify before handoff


Run the relevant repository checks and service-manager validation. Check the
private operator endpoint from its intended private network and the guest root
over its public origin. Confirm unauthenticated `/api/guest/v1/runtime` returns
`401`, and guest attempts to reach `/hermes/`, `/auth/`, and non-guest `/api/`
routes do not reach the native runtime.

Verify that both listeners resolve the same configured Runtime instance while
retaining distinct route and projection policies. Exercise one normalized
ACP run stream and reconnect without prompt replay, and confirm guest output is
projected before delivery. Inspect the browser bundle and network boundary for
native provider routes, URLs, and credentials. Confirm the deployed guest
origin matches invite minting before issuing a link. After a
configuration-only reload the verification is health, readiness, runtime status,
and the public runtime config; the full list above applies to code changes.
Report all changed service names, addresses, and any intentionally unperformed
external step.
