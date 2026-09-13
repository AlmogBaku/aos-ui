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

| Variable | Default | Use |
| --- | --- | --- |
| `AOS_UI_RUNTIME_CONFIG_FILE` | unset | Public runtime JSON file. |
| `AOS_UI_RUNTIME_MODE` | `aos` | `aos` or explicit `fixture`. |
| `AOS_UI_PROXY_TARGET` | `http://127.0.0.1:4100` | Local normalized proxy target. |
| `AOS_UI_COMPOSER_MODEL_SELECTOR_ENABLED` | `true` | Set `false` to hide model selection. |
| `AOS_UI_COMPOSER_CONTEXT_ENABLED` | `true` | Set `false` to hide context usage. |

The AOS proxy privately selects and authenticates Hermes. Future OpenCode and
OpenClaw integrations remain server-side until they have normalized proxy
adapters; no browser runtime mode or provider route is available for them.

Slash-command suggestions are shown in the main app whenever the runtime
provides commands. They are hidden for guests by default. Set
`AOS_UI_COMPOSER_SLASH_COMMANDS_ENABLED=true` in the proxy environment to show
them in guest chat. Only `true` enables the guest UI (case-insensitive, with
outer whitespace ignored). This setting only controls visibility; it does not
disable runtime commands or prevent a guest from typing one manually.

## Deployment

The Bun proxy serves the built browser assets, `/runtime-config.json`, and the
operator API. Guest invitations use a separate listener and configuration.
See [Deployment](deployment.md) for private proxy configuration and secret
mounts. Keep all credentials in that private configuration, never in a
`VITE_*` variable or the public JSON.
