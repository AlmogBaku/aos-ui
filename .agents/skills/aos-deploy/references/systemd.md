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

## Guest gateway and secrets

Build `aos-gateway`, install it outside the checkout, and copy frontend `dist/`
to a stable read-only directory. Create a dedicated unprivileged account. Copy
`aos-gateway.service.template`, set the binary and data paths for the host, and
place non-secret configuration in `/etc/aos-gateway/aos-gateway.env`:

```ini
AOS_GATEWAY_RUNTIME=hermes
AOS_GATEWAY_UPSTREAM=http://127.0.0.1:9119
AOS_GATEWAY_GUEST_ORIGIN=https://guest.example.com
AOS_GATEWAY_DIST=/opt/aos-ui/dist
AOS_GATEWAY_OPERATOR_ADDR=127.0.0.1:18080
AOS_GATEWAY_GUEST_ADDR=127.0.0.1:18081
```

The template uses systemd encrypted credentials for the invite key and Hermes
token. Create and protect those encrypted credential files with the host's
documented `systemd-creds` workflow. If encrypted credentials are unavailable,
use a root-owned mode-0600 secret file read by a dedicated launcher; do not put
the secret in a world-readable unit, `.env`, shell profile, or runtime JSON.

The operator listener remains loopback-only. The public reverse proxy points
only at `AOS_GATEWAY_GUEST_ADDR`; it never points at the operator listener or
the Hermes native port.

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

## Hermes plugin upgrades

Use a full committed SHA when installing the plugin. Run the native plugin
doctor after installation, enable the required tools, and restart the managed
Hermes gateway so the changed plugin and service environment are loaded. Do
not modify files in the installed plugin cache; make a commit and reinstall
from that immutable ref instead.
