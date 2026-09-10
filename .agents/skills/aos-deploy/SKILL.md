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
selected runtime guide. Inspect the existing services, listeners, proxy
configuration, runtime health, and Git state without changing them. Do not
stop or replace an existing service until its owner and replacement are clear.

Collect only unresolved choices: runtime, private operator address, optional
guest hostname, reverse proxy/TLS provider, paths for build and configuration,
service account, and whether the Hermes invite-minting key is intentionally
available to Hermes. A configured `AOS_GATEWAY_GUEST_ORIGIN` is the canonical
guest URL; changing it invalidates existing invite links.

## Plan and confirm mutations

Present the exact files, services, ports, external DNS/Tunnel changes, and
secrets that would change. State that the gateway has two loopback listeners:
the operator listener is private and the guest listener may receive only the
guest host. Require a direct confirmation immediately before writes, service
reloads/restarts, DNS changes, tunnel creation, or stopping duplicate
processes. Treat each later material change as a new confirmation point.

Use the provider-neutral templates under `deploy/systemd/` and adapt them to
the selected host. Do not install Cloudflare, create a tunnel, alter DNS, or
assume Tailscale unless the operator explicitly selected it. For Cloudflare,
route the selected guest hostname to the guest listener and retain the same
guest-only path boundary.

## Secrets and runtime integration

Put browser-safe runtime configuration in `/runtime-config.json` only. Keep
gateway signing keys and native tokens in an operator-managed secret facility,
not Git, shell startup files, or browser variables. The service manager must
receive its environment; editing a runtime `.env` alone does not update an
already-managed systemd service.

Giving `AOS_GATEWAY_INVITE_SIGNING_KEY` to Hermes lets shell-capable agents
mint bearer invitations. Do so only after an explicit opt-in. If the key is
not provisioned to Hermes, its invite skill may still use the configured guest
origin but must report that minting is unavailable.

Install Hermes plugins from an immutable, committed AOS ref. Upgrade by
installing the new immutable ref, running the plugin doctor, enabling required
tools, and restarting the managed Hermes gateway. Never patch an installed
plugin to carry uncommitted checkout changes.

## Verify before handoff

Run the relevant repository checks and service-manager validation. Check the
private operator endpoint from its intended private network, guest root over
its public origin, unauthenticated `/api/guest/bootstrap` returns `401`, and
guest attempts to reach `/hermes/`, `/auth/`, and non-guest `/api/` routes do
not reach the native runtime. Confirm the deployed guest origin matches invite
minting before issuing a link. Report all changed service names, addresses,
and any intentionally unperformed external step.
