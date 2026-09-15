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

The AOS proxy privately selects and authenticates Hermes. Future OpenCode and
OpenClaw integrations remain server-side until they have normalized proxy
adapters; no browser runtime mode or provider route is available for them.

## Private proxy configuration

The Bun proxy reads a strict private JSON file passed to
`bun run proxy:serve -- --config PATH`. The maintained example is
[`deploy/proxy-config.hermes.example.json`](../deploy/proxy-config.hermes.example.json).

| Field             | Meaning                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `version`         | Configuration format; V1 accepts only `1`.                                                                         |
| `deploymentId`    | Stable identifier bound into reconnect cursors and guest invitations.                                              |
| `listen`          | Trusted operator host and port. Wildcard binds require `exposure: "private-container"`.                            |
| `publicOrigin`    | Exact browser origin accepted for state-changing operator requests.                                                |
| `runtime`         | The one selected runtime: stable ID, `kind: "hermes"`, native base URL, server-token file, and warm-idle duration. |
| `events`          | Active reconnect-cursor key ID and one to three file-backed keys.                                                  |
| `limits`          | Global execution, guest execution, event-peer, and subscriber queue bounds.                                        |
| `guest`           | Optional distinct guest listener/origin and invitation signing keys.                                               |
| `shutdownGraceMs` | Time allowed for HTTP and event connections to drain.                                                              |

V1 selects one Hermes adapter per deployment. The selection seam can accept
more runtime kinds later, but unknown kinds are rejected now. Operator and
guest listeners use the exact same runtime instance, Hermes token, transport,
and Session coordinator. There is no second guest runtime or credential.

The operator listener intentionally has no application authentication. Network
access grants full operator access. Keep it on loopback or a trusted private
network, or put it behind an authenticated ingress. If `guest` is configured,
its listener and public origin must differ from the operator lane; guest access
requires a scoped, expiring JWT.

`runtime.tokenFile`, every `events.keys[].secretFile`, and every
`guest.invitations.keys[].secretFile` must be absolute paths to regular,
non-symlinked, owner-only files. Secret values never belong directly in the
JSON, Compose environment, `VITE_*`, public runtime configuration, or browser
bundle. Unknown and legacy OIDC, operator-cookie, Hermes browser-broker, and
guest-Hermes fields are rejected.

The Bun proxy serves the built browser assets, `/runtime-config.json`, the
operator API, and—when configured—the separate guest surface. See
[Deployment](deployment.md) for Compose mounts and listener exposure.

Runtime slash-command suggestions are enabled on the operator surface. The
guest surface hides them by default; set
`AOS_UI_COMPOSER_SLASH_COMMANDS_ENABLED=true` on the proxy to show them there.
This flag changes presentation only. A guest submission is still routed by the
runtime according to the invitation's existing message permissions.
