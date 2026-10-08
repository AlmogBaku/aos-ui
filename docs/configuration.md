# Configuration reference

AOS has three layers of configuration:

- the public `/runtime-config.json`, read by the browser;
- the aos-ui web server and Compose stack (`AOS_UI_*` variables, Caddy);
- the private harness-gw gateway configuration (a YAML file plus
  `HARNESS_GW_*` variables), which selects and authenticates the one native
  runtime.

## Public runtime configuration

The browser loads `/runtime-config.json` without caching. It has exactly two
runtime modes: `aos` for the harness-gw gateway on the same origin and
`fixture` for a deterministic local preview. Native provider URLs,
credentials, directories, and model identifiers never belong in this public
file.

```json
{
  "mode": "aos",
  "composerModelSelectorEnabled": true,
  "composerContextEnabled": true
}
```

Unknown fields are rejected. Published HTML Artifacts load no external assets
in preview.

The aos-ui web server serves the operator's file with one field added,
`buildId`, read from `dist/build-id`. The guest surface needs no file: it
answers a generated `{ "surface": "guest" }` with the same `buildId`. The
browser refetches the configuration on reconnect and when the tab regains
focus, and reloads once when the served `buildId` differs from the build it is
running.

## Local development

Vite derives the same public shape when no configuration file is supplied.

| Variable                                 | Default                     | Use                                                                                         |
| ---------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| `AOS_UI_RUNTIME_CONFIG_FILE`             | unset                       | Public runtime JSON file. Also read by the web server; required in every non-fixture setup. |
| `AOS_UI_RUNTIME_MODE`                    | `aos`                       | `aos` or explicit `fixture`.                                                                |
| `AOS_UI_GATEWAY_TARGET`                  | `http://127.0.0.1:4100`     | Gateway that Vite forwards `/api/v1` (HTTP and WebSocket) to.                               |
| `AOS_UI_COMPOSER_MODEL_SELECTOR_ENABLED` | `true`                      | Set `false` to hide model selection.                                                        |
| `AOS_UI_COMPOSER_CONTEXT_ENABLED`        | `true`                      | Set `false` to hide context usage.                                                          |
| `AOS_UI_TOOLS_MCP_URL`                   | `http://127.0.0.1:4110/mcp` | Tools MCP server URL that `bun run opencode:serve` registers as `aos-ui`.                   |

The gateway privately selects and authenticates exactly one Hermes, OpenClaw,
or OpenCode runtime. Hermes is the primary and first-supported harness. There
is no browser runtime mode or provider route for any of them. Run the gateway
from its own checkout; see
[harness-gw `README.md`](https://github.com/AlmogBaku/harness-gw/blob/main/README.md).

## Web server

`bun run web:serve` (`server/cli.ts`) serves the built app, the page policy
(the guest page's CSP and framing headers), `/runtime-config.json`, and a
`/healthz` liveness check. It answers `GET` and `HEAD` only; any other method
gets 405, and every `/api` path is 404, because the gateway answers `/api/v1`
beside it.

| Variable                     | Default                           | Use                                                                                                    |
| ---------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `AOS_UI_WEB_HOST`            | `127.0.0.1`                       | Operator surface bind address: `127.0.0.1`, `::1`, or a wildcard with `AOS_UI_WEB_EXPOSURE`.           |
| `AOS_UI_WEB_PORT`            | `3000`                            | Operator surface port. Compose uses `4200`.                                                            |
| `AOS_UI_GUEST_WEB_PORT`      | unset                             | Guest surface port; the guest surface runs only when it is set. Compose's harness overlays use `4201`. |
| `AOS_UI_GUEST_WEB_HOST`      | `127.0.0.1`                       | Guest surface bind address, under the same rule as `AOS_UI_WEB_HOST`.                                  |
| `AOS_UI_WEB_EXPOSURE`        | unset                             | `private-container` allows a wildcard bind (`0.0.0.0` or `::`) inside a private container network.     |
| `AOS_UI_STATIC_ROOT`         | `/app/dist`                       | The built app, holding `build-id` beside the assets.                                                   |
| `AOS_UI_RUNTIME_CONFIG_FILE` | `/run/aos-ui/runtime-config.json` | The operator's public runtime configuration.                                                           |

The guest surface never serves `/auth`, `/sw.js`, or `/manifest.webmanifest`.

## Compose host variables

These variables control how the Compose stack publishes its listeners on the
host. They are not read by the Vite dev server. Caddy is the only published
lane listener; the `tools-mcp` service has no authentication and is always
published on `127.0.0.1`, whatever the operator bind address.

| Variable                      | Default                              | Use                                                                        |
| ----------------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| `AOS_UI_BIND_ADDRESS`         | `127.0.0.1`                          | Host bind address for the operator lane.                                   |
| `AOS_UI_WEB_PUBLISHED_PORT`   | `3000`                               | Host port for the operator lane (Caddy `:18080`).                          |
| `AOS_UI_GUEST_BIND_ADDRESS`   | `127.0.0.1`                          | Host bind address for the guest lane.                                      |
| `AOS_UI_GUEST_PUBLISHED_PORT` | `3001`                               | Host port for the guest lane (Caddy `:18081`), added by a harness overlay. |
| `AOS_UI_PUBLIC_HOST`          | unset                                | Extra `Host` name the operator lane answers, such as a tailnet name.       |
| `AOS_UI_GUEST_PUBLIC_HOST`    | unset                                | Extra `Host` name the guest lane answers.                                  |
| `AOS_UI_TOOLS_MCP_PORT`       | `4110`                               | Loopback host port for the `tools-mcp` service.                            |
| `AOS_UI_HOST_UID`/`_GID`      | `1000`                               | Numeric owner of the mounted secret files; the gateway runs as this user.  |
| `HARNESS_GW_IMAGE`            | `ghcr.io/almogbaku/harness-gw:0.1.0` | Gateway image a harness overlay runs.                                      |
| `HARNESS_GW_CONFIG_FILE`      | required by a harness overlay        | Host path of the private gateway configuration.                            |

Each harness overlay also requires its secret-file variables, such as
`HARNESS_GW_HERMES_TOKEN_FILE` and `HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE`;
see [Deployment](deployment.md).

## Caddy routing

`deploy/Caddyfile` (and `deploy/caddy/guest.caddy`, mounted by the harness
overlays) gives each lane one origin: `/api/v1/*`, HTTP and WebSocket, goes to
that lane's gateway listener, and everything else to that lane's aos-ui web
server listener. The lane is the port, never the path.

- Each site answers only its own `Host` names, `127.0.0.1`, `localhost`, and
  the optional `AOS_UI_PUBLIC_HOST` or `AOS_UI_GUEST_PUBLIC_HOST`; any other
  name gets 421. Never set those variables to `localhost` or `127.0.0.1`:
  Caddy rejects the duplicate host and does not start.
- `AOS_UI_CADDY_BIND` sets the bind address (default `127.0.0.1`; Compose sets
  `0.0.0.0` inside the container and publishes the port on loopback).
- The upstreams default to the Compose service names and are overridden by
  `deploy/compose.host.yaml` with `AOS_UI_GATEWAY_UPSTREAM`,
  `AOS_UI_GATEWAY_GUEST_UPSTREAM`, `AOS_UI_WEB_UPSTREAM`, and
  `AOS_UI_WEB_GUEST_UPSTREAM`.
- There is no admin API, no automatic HTTPS, and no access log, because a file
  address carries its pass in the query. External ingress owns TLS.

## Gateway configuration

The harness-gw gateway reads one private YAML file. Start from the example for
the selected runtime in harness-gw's `examples/`:
[`config.hermes.example.yaml`](https://github.com/AlmogBaku/harness-gw/blob/main/examples/config.hermes.example.yaml),
[`config.openclaw.example.yaml`](https://github.com/AlmogBaku/harness-gw/blob/main/examples/config.openclaw.example.yaml),
or
[`config.opencode.example.yaml`](https://github.com/AlmogBaku/harness-gw/blob/main/examples/config.opencode.example.yaml).
The schema, with every key documented, is harness-gw's `src/config.ts`; the
wire and HTTP API, including origin rules, are in
[`docs/protocol.md`](https://github.com/AlmogBaku/harness-gw/blob/main/docs/protocol.md).
TODO(ALM-36): harness-gw has no configuration reference doc yet; once it does,
replace the gateway sections below with a link to it.

What an aos-ui operator needs to know:

- **Path.** `--config`, then `HARNESS_GW_CONFIG_FILE`, then
  `${XDG_CONFIG_HOME:-$HOME/.config}/harness-gw/config.yaml`. The `invite`
  command never discovers a path. `harness-gw config check --config <path>`
  validates the file, its `HARNESS_GW_*` overrides, and the schema, and starts
  nothing.
- **File checks.** The file must be a regular file owned by the gateway user or
  root and never group- or world-writable. Compose bind-mounts keep host
  ownership, so it must be owned by `AOS_UI_HOST_UID` at mode `0600` or
  `0640`, or by root at `0644`.
- **Listeners.** `listen` is the trusted operator listener and the optional
  `guest.listen` the guest one; in Compose they are ports `4100` and `4101`
  behind Caddy. A wildcard host needs `exposure: private-container`. The
  operator listener has no application authentication: network access grants
  full operator access. Operator and guest share one runtime instance and
  credential.
- **Origins.** Each listener's `publicOrigin` (and optional `allowedOrigins`,
  which defaults to it) must list the exact origin the browser uses, such as
  `http://127.0.0.1:3000` for the operator lane in Compose and
  `http://127.0.0.1:3001` for the guest lane. A WebSocket upgrade or
  state-changing request with a foreign, `null`, or missing `Origin` is refused
  with 403, so a client that is not a browser must still send a listed
  `Origin`. The one exception is invitation creation on the operator listener,
  which the `aos-invite-link` skill's `curl` calls without one. A
  non-loopback origin must be `https:`.
- **Runtime.** `runtime.kind` is `hermes`, `openclaw`, or `opencode`, with that
  runtime's private connection fields and secret files; see the harness-gw
  runtime guides under `docs/runtimes/`. `runtime.mediaArtifacts` (default
  `true`) turns native assistant media into Artifacts; with `false`, a Hermes
  `MEDIA:` line, native path included, stays visible to every reader of the
  Session, guests too.
- **Secrets.** Every secret file is an absolute path to a regular,
  non-symlinked, owner-only file. Guest invitation signing keys are 43
  base64url characters encoding 32 bytes. Secret values never belong in the
  YAML file, the Compose environment, `VITE_*`, the public runtime
  configuration, or the browser bundle.
- **Environment overrides.** Every scalar field can be set by `HARNESS_GW_`
  followed by its path in upper snake case, for example
  `HARNESS_GW_LISTEN_PORT`, `HARNESS_GW_RUNTIME_BASE_URL`, or
  `HARNESS_GW_PUSH_VAPID_SUBJECT`. Arrays, `allowedOrigins`, and the whole
  `mcpApps` block are file-only, and a guest override needs a `guest` block in
  the file.
- **Errors.** An invalid configuration logs `proxy.start_failed` with a
  message beginning `Invalid proxy configuration in <path>:` and one line per
  failing field path, naming the variable that set it; values are never
  included. A key this release no longer accepts is an unrecognized key and
  stops the gateway. Logs mask credential fields and URL userinfo, query, and
  fragment.

Runtime slash-command suggestions are enabled on the operator surface only.
The guest listener advertises none and refuses any guest message or steer whose
text starts with `/`.

### Voice providers {#voice-providers}

Add a `voice` block to route transcription (`POST {baseUrl}/audio/transcriptions`)
and/or read-aloud synthesis (`POST {baseUrl}/audio/speech`) through an
OpenAI-compatible speech provider. Omitting the block leaves only the runtime's
native speech interfaces active. The block must contain at least one of
`transcription` or `speech`; the example gateway configs intentionally omit it.

```yaml
voice:
  transcription:
    provider: openai-compatible
    baseUrl: https://stt.example.test/v1
    apiKeyFile: /run/secrets/voice-stt-key
    model: whisper-1
    mode: fallback
    language: he
    timeoutMs: 60000
  speech:
    provider: openai-compatible
    baseUrl: https://tts.example.test/v1
    apiKeyFile: /run/secrets/voice-tts-key
    model: tts-1
    voice: alloy
    format: mp3
    mode: override
    timeoutMs: 60000
```

Each direction (`transcription`, `speech`) accepts:

| Field        | Default    | Meaning                                                                                                                                                                                                                             |
| ------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`   | required   | Must be `"openai-compatible"`.                                                                                                                                                                                                      |
| `baseUrl`    | required   | Base URL including the API version segment (e.g. `/v1`). Must be `https:` or a loopback host when `apiKeyFile` is set. Upstream redirects are refused.                                                                              |
| `apiKeyFile` | —          | Optional absolute path to an owner-only secret file carrying the API key. Same ownership rules as `runtime.tokenFile`. The key is never inline, never an environment value, and is unrelated to `AOS_UI_OPENAI_COMPATIBLE_API_KEY`. |
| `model`      | required   | Model identifier forwarded to the provider.                                                                                                                                                                                         |
| `mode`       | `fallback` | `"fallback"` or `"override"` (see below).                                                                                                                                                                                           |
| `timeoutMs`  | `60000`    | Per-request timeout in milliseconds (1 000–300 000).                                                                                                                                                                                |

`transcription` additionally accepts:

| Field      | Default | Meaning                                                  |
| ---------- | ------- | -------------------------------------------------------- |
| `language` | —       | Optional BCP-47-like language hint (e.g. `he`, `en-US`). |

`speech` additionally accepts:

| Field    | Default | Meaning                                        |
| -------- | ------- | ---------------------------------------------- |
| `voice`  | —       | Voice identifier forwarded to the provider.    |
| `format` | `mp3`   | Audio format: `mp3`, `opus`, `wav`, or `flac`. |

#### Mode semantics

`"fallback"` uses the gateway provider only where the runtime cannot serve speech:
at the capability level when the runtime reports speech unavailable (OpenClaw,
OpenCode), and at request time when the runtime's native call fails. On Hermes,
which advertises speech availability per transport, fallback is request-time
only: the native call is attempted first, and the gateway provider is used only
if that call fails.

`"override"` always uses the gateway provider, regardless of runtime capability.

Provider failures surface as `503 temporarily_unavailable`. An unsupported audio
type or oversized request surfaces as `400 invalid_request`. The gateway never logs
audio content or transcript text; it logs one redacted `voice.fallback` event
per direction naming the direction and the runtime's public error code.

### MCP Apps fallback {#mcp-apps-fallback}

MCP App servers are registered in the runtime's own MCP configuration, never
in AOS. On Hermes and OpenCode the gateway reads an App's view itself, through
its own MCP client, from the server URL the runtime reports. By default it
connects only to Streamable HTTP servers that ask for no credentials. Add an
`mcpApps` block to let it reach a server at another address, or one that needs
headers:

```yaml
mcpApps:
  fallback:
    servers:
      aos-ui:
        url: http://tools-mcp:4110/mcp
      desktop:
        headers:
          Authorization: { file: /etc/aos-ui/secrets/desktop-ui-authorization }
```

- The key under `servers` is the MCP server name exactly as the runtime reports
  it. Each entry needs `url`, `headers`, or both.
- `url` replaces the URL the runtime reports; the gateway connects there
  instead. Use it when the gateway reaches the server at a different address
  than the harness does. A Hermes on the host registers
  `http://127.0.0.1:4110/mcp`, but a gateway in a Compose container has its own
  loopback, so harness-gw's Hermes example overrides `aos-ui` with the Compose
  service address `http://tools-mcp:4110/mcp`. It must be an `http:` or
  `https:` URL without credentials, query, or fragment. Only the runtime's
  report decides whether a server is reachable at all: an override never adds
  a server the runtime does not report with a URL.
- Each header's `file` holds the whole header value (for example
  `Bearer …`). It follows the same rules as `runtime.tokenFile`: absolute,
  regular, non-symlinked, owner-only, 1–8192 bytes, one line. Every file is read
  once at startup, so a changed value needs a gateway restart.
- A server with headers is reached only over `https:` or on a loopback host,
  whether the URL is the override or the runtime's; anything else is refused.
  A `url` over plain HTTP to a host other than loopback is accepted only
  without headers.
- Header values never appear in logs, errors, capabilities, or browser
  responses.
- OpenClaw serves Apps natively and ignores this block.

See [MCP Apps](mcp-apps.md) for what a view may do once it is served.

### MCP App files {#mcp-app-files}

A tool call can name files for its App's view to show, as `present_artifact`
names the file it presents. The gateway reads such a file for the view through
the runtime, and the view never sees its path; see [MCP Apps](mcp-apps.md#files)
for the routes. An `mcpApps.files` block decides which calls and folders
qualify:

```yaml
mcpApps:
  files:
    servers: [aos-ui]
    operator:
      agentFolder: true
      allow: [/srv/reports]
      deny: [/srv/reports/drafts]
    guest:
      allow: [/srv/reports/shared]
    viewer:
      server: aos-ui
      resource: ui://aos-ui/artifact
```

- `servers` names the MCP servers whose calls may name files, as the harness
  configures them. The default is `[aos-ui]`, which also matches a harness
  that names the server `aos_ui`. A call from any other server gets no files,
  and neither does a native tool that shares a name with one of `aos-ui`'s.
- `operator` and `guest` each hold one role's folders: `agentFolder` serves
  the Agent's own folder, `allow` adds folders, and `deny` takes folders away.
  Every entry is an absolute path, and a denial beats an allowance.
- Operators get the Agent's folder by default. Guests get nothing until
  `guest` allows a folder, and a guest read must pass the `operator` folders
  too, so a guest never reads what an operator may not.
- Where the runtime reports no Agent folder, only `allow` counts; with nothing
  allowed, a view gets no files.
- A `deny` entry holds in any letter case; an `allow` entry matches the path
  exactly.
- These are refused whatever the folders say, matched per path component in
  any letter case:
  - the folders `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`,
    `.git`, `.config/gcloud`, and `.config/gh`;
  - the credential names an Artifact path refuses, such as `.env`, `.env.*`,
    `.envrc`, `auth.json`, `credentials`, and `config.yaml`, plus `.netrc`,
    `.npmrc`, `.pypirc`, and `.pgpass`;
  - the SSH keys `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ecdsa_sk`, `id_ed25519`,
    and `id_ed25519_sk`;
  - every name ending in `.pem`, `.key`, `.p12`, or `.pfx`. `*.key` also
    blocks Keynote decks.
- The folders judge the path as the call wrote it and, where the runtime
  reports it, the real path the runtime will read, so a symbolic link cannot
  lead out of an allowed folder. Both are judged again on every request. A
  guest reads files only on a runtime that reports real paths.
- `viewer` names the view a published attachment opens in: `server` is an
  MCP server as the harness configures it, and `resource` one of its `ui://`
  resources. The default is `aos-ui`'s `ui://aos-ui/artifact`, and `aos-ui`
  again matches `aos_ui`. The view reads only that server's resources and
  calls no tool. Folders do not apply to an attachment: its bytes are the
  ones the Agent published. A runtime that cannot read the viewer, or a
  viewer out of reach, leaves the attachment on its card with no view.
- The folders themselves are compared as written, and a link among them is
  never followed. Where the runtime reports real paths, a folder that sits
  behind a symbolic link, the Agent's own included, serves nothing until its
  real location is in `allow` too, in both sets for a guest. The log records
  each such refusal as `real_path_denied`.

### Web Push (optional)

Add a `push` block to enable closed-app OS notifications via Web Push. Omitting
the block leaves tab-only delivery active; no other behavior changes.

```yaml
push:
  stateDir: /var/lib/harness-gw/push
  vapid:
    subject: mailto:ops@example.com
    privateKeyFile: /run/secrets/vapid-private-key
```

`stateDir` must exist and be writable by the gateway user before the gateway starts.
It holds one JSON file of device registrations (push endpoints and their keys;
no conversation content), up to 32 per operator. The gateway refuses to start if
the directory is missing or unwritable — there is no silent fallback.

Generate a VAPID key pair once:

```bash
bunx web-push generate-vapid-keys
```

Keep only the private key (a 43-character base64url scalar). Write it to a
file, set its permissions to `0600`, and pass the path as `privateKeyFile`. The
public key is derived at gateway startup; do not configure it separately.

For Compose deployments, `compose.push.yaml` passes push settings to the gateway
as container environment variables; the private configuration file needs no
`push` block. Add `-f compose.push.yaml` after the runtime overlay and set
`HARNESS_GW_PUSH_STATE_DIR`, `HARNESS_GW_VAPID_PRIVATE_KEY_FILE`, and
`HARNESS_GW_PUSH_VAPID_SUBJECT` (see
[Deployment](deployment.md#web-push-state-and-vapid-secret)). Omitting the
overlay leaves tab-only delivery active with no additional variables required.
