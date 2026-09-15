# Systemd deployment reference

Use this reference after the operator chose systemd. The checked-in templates
are starting points, not host-independent commands.

## Private operator UI

Copy `deploy/systemd/aos-ui.service.template` to `/etc/systemd/system/aos-ui.service`, replacing `@AOS_CHECKOUT@`. Copy the selected Compose definition to `/etc/aos-ui/compose.yaml` and create `/etc/aos-ui/aos-ui.env` with values needed by that Compose file. Bind the published web port to loopback or an explicitly trusted private interface. Do not put a public DNS host or guest proxy route in this service.

Validate before enabling:

```bash
systemd-analyze verify /etc/systemd/system/aos-ui.service
docker compose --project-directory /absolute/path/to/aos-ui -f /etc/aos-ui/compose.yaml config --quiet
```

## Gateway configuration and secrets

The service template runs the repository's Compose definition. Start with the
versioned proxy configuration documented in `docs/configuration.md`, store the
host copy outside the checkout, and point `AOS_UI_PROXY_CONFIG_FILE` at that
absolute path from `/etc/aos-ui/aos-ui.env`. The same configuration defines the
distinct operator and optional guest listeners and selects one runtime.

Set the Compose secret-file variables for the Hermes token, reconnect cursor
key, and optional guest invitation key. Create and protect those files with the
host's documented secret-management workflow. If encrypted credentials are
unavailable, use root-owned mode-0600 files mounted as Compose secrets; do not
put secret values in a world-readable unit, `.env`, shell profile, proxy JSON,
or browser runtime JSON.

The operator listener remains loopback-only. The public reverse proxy points
only at the address published with `AOS_UI_GUEST_BIND_ADDRESS` and
`AOS_UI_GUEST_PUBLISHED_PORT`; it never points at the operator listener or the
Hermes native port.

## Proxy and optional Cloudflare Tunnel

Copy `aos-guest-nginx.conf.template` into the selected proxy, substitute the
guest hostname and guest port, configure its normal TLS certificate, then
validate the generated configuration with that proxy's native test command.
It must be a separate guest virtual host, so an unmatched route cannot fall
through to a private AOS or Hermes host.

If the operator explicitly selected Cloudflare Tunnel, its single ingress
hostname may point to the loopback guest listener. Route `/api/guest/*` and the
guest UI to that listener; do not add `/hermes`, `/auth`, the operator listener,
or the native runtime as tunnel ingress services. DNS/tunnel credentials are
operator-managed external state and require confirmation before changing.

Verify unauthenticated `GET /api/guest/v1/runtime` returns `401` through the
guest host. Confirm the operator host cannot resolve guest routes, the guest
host cannot resolve `/api/aos/v1`, and neither host proxies native Hermes
routes.

## Hermes plugin upgrades

Use a full committed SHA when installing the plugin. Run the native plugin
doctor after installation, enable the required tools, and restart the managed
Hermes gateway so the changed plugin and service environment are loaded. Do
not modify files in the installed plugin cache; make a commit and reinstall
from that immutable ref instead.
