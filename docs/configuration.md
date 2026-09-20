# Configuration reference

The browser loads `/runtime-config.json` without caching. It has exactly two
runtime modes: `aos` for the normalized same-origin proxy and `fixture` for a
deterministic local preview. Native provider URLs, credentials, directories,
and model identifiers never belong in this public file.

```json
{
  "mode": "aos",
  "composerModelSelectorEnabled": true,
  "composerContextEnabled": true
}
```

Unknown fields are rejected. Optional `artifactHtmlAssetOrigins` is an array of
at most 16 credential-free HTTPS origins; omit it to block external HTML
preview assets.

## Local development

Vite derives the same public shape when no configuration file is supplied.

| Variable                                 | Default                 | Use                                  |
| ---------------------------------------- | ----------------------- | ------------------------------------ |
| `AOS_UI_RUNTIME_CONFIG_FILE`             | unset                   | Public runtime JSON file.            |
| `AOS_UI_RUNTIME_MODE`                    | `aos`                   | `aos` or explicit `fixture`.         |
| `AOS_UI_PROXY_TARGET`                    | `http://127.0.0.1:4100` | Local normalized proxy target.       |
| `AOS_UI_COMPOSER_MODEL_SELECTOR_ENABLED` | `true`                  | Set `false` to hide model selection. |
| `AOS_UI_COMPOSER_CONTEXT_ENABLED`        | `true`                  | Set `false` to hide context usage.   |

The AOS proxy privately selects and authenticates exactly one Hermes, OpenClaw,
or OpenCode runtime. Hermes is the primary and first-supported harness. There
is no browser runtime mode or provider route for any of them.

## Private proxy configuration

The Bun proxy reads a strict private JSON file passed to
`bun run proxy:serve -- --config PATH`. Start from the maintained example for
the selected provider: [`Hermes`](../deploy/proxy-config.hermes.example.json),
[`OpenClaw`](../deploy/proxy-config.openclaw.example.json), or
[`OpenCode`](../deploy/proxy-config.opencode.example.json).

| Field             | Meaning                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `version`         | Configuration format; V1 accepts only `1`.                                                    |
| `deploymentId`    | Stable identifier bound into guest invitations.                                               |
| `listen`          | Trusted operator host and port. Wildcard binds require `exposure: "private-container"`.       |
| `publicOrigin`    | Exact browser origin accepted for state-changing operator requests.                           |
| `runtime`         | One selected runtime: a stable ID plus the provider-specific private connection fields below. |
| `limits`          | Global execution, guest execution, event-peer, and subscriber queue bounds.                   |
| `guest`           | Optional distinct guest listener/origin and invitation signing keys.                          |
| `shutdownGraceMs` | Whole shutdown budget after SIGTERM: drain, close the runtime, exit non-zero if forced.       |

V1 selects one of the supported adapter kinds per deployment; unknown kinds are
rejected. Operator and guest listeners use the exact same runtime instance,
credentials, transport, and Session coordinator. There is no second guest
runtime or credential.

| `runtime.kind` | Required private fields                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `hermes`       | `baseUrl`, absolute owner-only `tokenFile`, and `sessionIdleMs`                                          |
| `openclaw`     | WebSocket `baseUrl`, absolute owner-only `deviceIdentityFile`, and absolute owner-only `deviceTokenFile` |
| `opencode`     | `baseUrl`, absolute `directory`, `username`, and absolute owner-only `passwordFile`                      |

The operator listener intentionally has no application authentication. Network
access grants full operator access. Keep it on loopback or a trusted private
network, or put it behind an authenticated ingress. If `guest` is configured,
its listener and public origin must differ from the operator lane; guest access
requires a scoped, expiring JWT.

Every provider secret file (`runtime.tokenFile`, `runtime.passwordFile`, or
`runtime.deviceIdentityFile`/`runtime.deviceTokenFile` as applicable), every
and every `guest.invitations.keys[].secretFile` must be absolute paths to regular, non-symlinked, owner-only files. Secret
values never belong directly in the JSON, Compose environment, `VITE_*`, public
runtime configuration, or browser bundle. Unknown and legacy OIDC,
operator-cookie, Hermes browser-broker, and guest-Hermes fields are rejected.

For Compose runtime overlays, `AOS_UI_HOST_UID` and `AOS_UI_HOST_GID` select
the non-root proxy identity and the declared secret ownership. On Linux, use
the numeric owner of the source secret files because local Compose mounts them
without changing their host ownership.

The Bun proxy serves the built browser assets, `/runtime-config.json`, the
operator API, and—when configured—the separate guest surface. See
[Deployment](deployment.md) for Compose mounts and listener exposure.

Runtime slash-command suggestions are enabled on the operator surface. The
guest surface hides them by default; set
`AOS_UI_COMPOSER_SLASH_COMMANDS_ENABLED=true` on the proxy to show them there.
This flag changes presentation only. A guest submission is still routed by the
runtime according to the invitation's existing message permissions.

### Web Push (optional)

Add a `push` block to enable closed-app OS notifications via Web Push. Omitting
the block leaves tab-only delivery active; no other behavior changes.

```json
"push": {
  "stateDir": "/var/lib/aos-ui/push",
  "vapid": {
    "subject": "mailto:ops@example.com",
    "privateKeyFile": "/run/secrets/vapid-private-key"
  }
}
```

`stateDir` must exist and be writable by the proxy user before the proxy starts.
It holds one JSON file of device registrations (push endpoints and their keys;
no conversation content), up to 32 per operator. The proxy refuses to start if
the directory is missing or unwritable — there is no silent fallback.

Generate a VAPID key pair once:

```bash
bunx web-push generate-vapid-keys
```

Keep only the private key (a 43-character base64url scalar). Write it to a
file, set its permissions to `0600`, and pass the path as `privateKeyFile`. The
public key is derived at proxy startup; do not configure it separately.

For Compose deployments, add `-f compose.push.yaml` after the runtime overlay
and set `AOS_UI_PUSH_STATE_DIR` and `AOS_UI_VAPID_PRIVATE_KEY_FILE` (see
[Deployment](deployment.md#web-push-state-and-vapid-secret)). Omitting the
overlay leaves tab-only delivery active with no additional variables required.
