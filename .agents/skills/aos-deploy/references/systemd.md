# Systemd deployment reference

Use this reference after the operator chose systemd. The checked-in templates
are starting points, not host-independent commands.

## Private operator UI

Copy `deploy/systemd/aos-ui.service.template` to `/etc/systemd/system/aos-ui.service`,
replacing `@AOS_CHECKOUT@` with the absolute checkout path and `@AOS_RUNTIME@` with
the selected runtime name (e.g. `hermes`, `openclaw`, `opencode`). Optionally add a
third `-f` for a host overlay. Set `AOS_UI_HOST_UID` and `AOS_UI_HOST_GID` in
`/etc/aos-ui/aos-ui.env` to match the host user the containers should run as; the
runtime overlays use these to set `user:` and volume ownership.
Bind the published web port to loopback or an explicitly trusted private interface.
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

Inspect both system and user units — review and dev proxies often run in user
scope:

```bash
systemctl list-units 'aos*'
systemctl --user list-units 'aos*'
```

Use `readyz` (`/api/aos/v1/readyz`) to confirm the proxy is ready, not only
`healthz`.

## Gateway configuration and secrets

The service template runs the repository's Compose definition. Start with the
versioned proxy configuration documented in `docs/configuration.md`, store the
host copy outside the checkout, and point `AOS_UI_PROXY_CONFIG_FILE` at that
absolute path from `/etc/aos-ui/aos-ui.env`. The same configuration defines the
distinct operator and optional guest listeners and selects one runtime.

Set the Compose secret-file variables for the Hermes token and optional guest
invitation signing key (`compose.hermes.yaml` secrets block). Create and protect
those files with the host's documented secret-management workflow. If encrypted
credentials are unavailable, use root-owned mode-0600 files mounted as Compose
secrets; do not put secret values in a world-readable unit, `.env`, shell
profile, proxy JSON, or browser runtime JSON.

Published ports are commonly overridden in a host overlay; the operator listener
remains loopback-only regardless. The public reverse proxy points only at the
address published with `AOS_UI_GUEST_BIND_ADDRESS` and
`AOS_UI_GUEST_PUBLISHED_PORT`; it never points at the operator listener or the
native runtime port.

## Reverse proxy and optional Cloudflare Tunnel

Route the guest hostname to the guest listener only. The Bun proxy already
blocks reserved paths — requests to `/auth` and `/hermes` on the guest surface
return 404 (`packages/proxy/cli/serve.ts:23`). Configure a separate guest
virtual host so an unmatched route cannot fall through to a private AOS or
native runtime host.

If the operator explicitly selected Cloudflare Tunnel, its single ingress
hostname may point to the loopback guest listener. Do not add `/hermes`,
`/auth`, the operator listener, or the native runtime as tunnel ingress
services. DNS/tunnel credentials are operator-managed external state and require
confirmation before changing.

Verify unauthenticated `GET /api/guest/v1/runtime` returns `401` through the
guest host. Confirm the operator host cannot resolve guest routes, the guest
host cannot resolve `/api/aos/v1`, and neither host proxies native runtime
routes.

## Hermes plugin upgrades

Use a full committed SHA when installing the plugin. Run the native plugin
doctor after installation, enable the required tools, and restart the managed
Hermes gateway so the changed plugin and service environment are loaded. Do
not modify files in the installed plugin cache; make a commit and reinstall
from that immutable ref instead.
