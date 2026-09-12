# Configuration reference

AOS loads runtime selection from browser-readable JSON or, during local Vite development, from an allowlisted set of environment variables. These values tell the browser how to attach to an already-running runtime; they do not install or start it.

## Configuration precedence

When `AOS_UI_RUNTIME_CONFIG_FILE` is set, Vite serves that file as `/runtime-config.json`. Otherwise it derives the same public shape from local environment variables. The production Bun listener reads the mounted `/runtime-config.json` file.

The browser fetches the file without caching. Invalid or missing configuration renders an unavailable state; AOS never falls back to fixture data.

> [!WARNING]
> Everything in `/runtime-config.json` is public to the browser. Keep credentials in the native runtime or server environment. Never put secrets in this file or in `VITE_*` variables.

Guest-invitation signing keys are native-process secrets, not browser runtime
configuration. See [Invited chat](invite-chat.md) for gateway and skill setup.

## Public runtime JSON

Shared optional fields:

| Field                          | Type     | Default | Meaning                                           |
| ------------------------------ | -------- | ------- | ------------------------------------------------- |
| `composerModelSelectorEnabled` | boolean  | `true`  | Show the runtime model selector when supported.   |
| `composerContextEnabled`       | boolean  | `true`  | Show authoritative context usage when supported.  |
| `artifactHtmlAssetOrigins`     | string[] | omitted | HTTPS origins allowed by published HTML previews. |

Unknown fields are rejected. Ready configurations use one of these shapes.

### Fixture

```json
{
  "mode": "fixture",
  "composerModelSelectorEnabled": true,
  "composerContextEnabled": true
}
```

### OpenCode

```json
{
  "mode": "opencode",
  "baseUrl": "http://127.0.0.1:4096",
  "directory": "/workspace",
  "composerModelSelectorEnabled": true,
  "composerContextEnabled": true
}
```

`directory` is the absolute path understood by the OpenCode server. In the supplied container it is `/workspace`. Add `defaultModel` only when both native identifiers are known:

```json
"defaultModel": {
  "providerID": "amazon-bedrock",
  "modelID": "your-model-id"
}
```

### Hermes

```json
{
  "mode": "aos",
  "composerModelSelectorEnabled": true,
  "composerContextEnabled": true
}
```

The Hermes Compose deployment uses this credential-free public shape. The
private TypeScript proxy translates `/api/aos/v1` to Hermes and brokers
operator/runtime authentication; the browser never receives a Hermes URL or
token. The old `/hermes` shape is retained only for the local development
shortcut documented in [Run AOS with Hermes](runtimes/hermes.md).

### Generic AG-UI

```json
{
  "mode": "ag-ui",
  "runUrl": "http://127.0.0.1:8000/agent",
  "workspaceUrl": "http://127.0.0.1:8001",
  "composerModelSelectorEnabled": true,
  "composerContextEnabled": true
}
```

Both URLs are required absolute HTTP(S) URLs without credentials, queries, or fragments.

### OpenClaw

```json
{
  "status": "unavailable",
  "reason": "invalid-runtime-mode"
}
```

OpenClaw is planned but unavailable on the normalized Hermes-first deployment
path. Do not configure a browser Gateway URL or `/openclaw` route. Gateway
tokens and passwords are never public fields.

The optional private invited-chat gateway has separate server-only settings:
`AOS_GATEWAY_OPENCLAW_TOKEN` supplies the initial operator bootstrap secret and
`AOS_GATEWAY_OPENCLAW_DEVICE_FILE` names an absolute, persistent, writable path
for its paired device key and token. Neither value belongs in this public JSON
or in a `VITE_*` value.

## Artifact HTML assets

`artifactHtmlAssetOrigins` accepts at most 16 credential-free HTTPS origins. Each entry must contain only the origin, with no path, query, or fragment:

```json
"artifactHtmlAssetOrigins": ["https://cdn.example.com"]
```

Omit the field to block external assets in published HTML previews.

## Local Vite environment

| Variable                                 | Default                 | Use                                                                                          |
| ---------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `AOS_UI_RUNTIME_CONFIG_FILE`             | unset                   | Absolute path to public runtime JSON.                                                        |
| `AOS_UI_RUNTIME_MODE`                    | `opencode`              | `fixture`, `opencode`, `hermes`, or `ag-ui`; OpenClaw is unavailable in the current cutover. |
| `AOS_UI_OPENCODE_BASE_URL`               | `http://127.0.0.1:4096` | Browser-reachable OpenCode URL or same-origin path.                                          |
| `AOS_UI_OPENCODE_WORKTREE`               | required for OpenCode   | Absolute native working directory.                                                           |
| `AOS_UI_OPENCODE_PROVIDER_ID`            | unset                   | Optional model provider; set with model ID.                                                  |
| `AOS_UI_OPENCODE_MODEL_ID`               | unset                   | Optional model ID; set with provider ID.                                                     |
| `AOS_UI_HERMES_BASE_URL`                 | required for Hermes     | Absolute URL or same-origin path such as `/hermes`.                                          |
| `AOS_UI_HERMES_TARGET`                   | `http://127.0.0.1:9119` | Vite forwarding target.                                                                      |
| `AOS_UI_AG_UI_URL`                       | required for AG-UI      | AG-UI run endpoint.                                                                          |
| `AOS_UI_AG_UI_WORKSPACE_URL`             | required for AG-UI      | Workspace-service base URL.                                                                  |
| `AOS_UI_COMPOSER_MODEL_SELECTOR_ENABLED` | `true`                  | Set to `false` to hide the selector.                                                         |
| `AOS_UI_COMPOSER_CONTEXT_ENABLED`        | `true`                  | Set to `false` to hide context usage.                                                        |

The optional OpenCode launcher and its credential-forwarding variables are described in [Run with OpenCode](runtimes/opencode.md). They are not required when attaching to an independently configured server.

## Compose environment

| Variable                               | Default                        | Use                                                |
| -------------------------------------- | ------------------------------ | -------------------------------------------------- |
| `AOS_UI_RUNTIME_CONFIG_FILE`           | `./deploy/runtime-config.json` | Public JSON mounted read-only.                     |
| `AOS_UI_BIND_ADDRESS`                  | `127.0.0.1`                    | Published-service bind address.                    |
| `AOS_UI_WEB_PUBLISHED_PORT`            | `3000`                         | Web port on the host.                              |
| `AOS_UI_OPENCODE_PUBLISHED_PORT`       | `4096`                         | OpenCode port on the host.                         |
| `AOS_UI_OPENCODE_WORKTREE`             | required by OpenCode overlay   | External worktree mounted at `/workspace`.         |
| `AOS_UI_HOST_UID` / `AOS_UI_HOST_GID`  | `1000`                         | Non-root OpenCode container identity.              |
| `AOS_UI_PROXY_CONFIG_FILE`             | required by Hermes overlay     | Private proxy JSON mounted read-only.              |
| `AOS_UI_OIDC_CLIENT_SECRET_FILE`       | required by Hermes overlay     | Owner-only OIDC client secret file.                |
| `AOS_UI_OPERATOR_PRINCIPAL_KEY_FILE`   | required by Hermes overlay     | Owner-only 32-byte principal key file.             |
| `AOS_UI_OPERATOR_SESSION_KEY_FILE`     | required by Hermes overlay     | Owner-only 32-byte session key file.               |
| `AOS_UI_RECONNECT_CURSOR_KEY_FILE`     | required by Hermes overlay     | Owner-only 32-byte reconnect key file.             |
| `AOS_UI_GUEST_HERMES_TOKEN_FILE`       | required by Hermes guest lane  | Owner-only Hermes Desktop Session token.           |
| `AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE` | required by Hermes guest lane  | Owner-only 32-byte invitation signing key.         |
| `AOS_UI_GUEST_BIND_ADDRESS`            | `127.0.0.1`                    | Host bind address for the separate guest listener. |
| `AOS_UI_GUEST_PUBLISHED_PORT`          | `3001`                         | Host port forwarded to the guest listener.         |

Copy [`.env.compose.example`](../.env.compose.example) to `.env` for local overrides. See [Deployment](deployment.md) for complete commands.
