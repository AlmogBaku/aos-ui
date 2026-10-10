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
| `HARNESS_GW_IMAGE`            | `ghcr.io/almogbaku/harness-gw:0.1.3@sha256:a01d8da1a34fd6e6769ad89829d23c30f43cc22fb9fa3f46911e5bfa934480f5` | Gateway image a harness overlay runs.                                      |
| `HARNESS_GW_CONFIG_FILE`      | required by a harness overlay        | Host path of the private gateway configuration.                            |

Each harness overlay also requires its secret-file variables, such as
`HARNESS_GW_HERMES_TOKEN_FILE` and `HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE`;
see [Deployment](deployment.md).

## Caddy routing

`deploy/Caddyfile` (and `deploy/caddy/guest.caddy`, mounted by the harness
overlays) gives each lane one origin: `/api/v1/*`, HTTP and WebSocket, goes to
that lane's gateway listener, and everything else to that lane's aos-ui web
server listener. The lane is the port, never the path.

- Each site answers only `127.0.0.1`, `localhost`, and the optional
  `AOS_UI_PUBLIC_HOST` or `AOS_UI_GUEST_PUBLIC_HOST`; any other name gets 421.
  Setting either variable to a loopback name is harmless. Compose maps an
  empty value to `localhost`; run outside Compose, Caddy refuses to start with
  either variable set but empty.
- `AOS_UI_CADDY_BIND` sets the bind address (default `127.0.0.1`; Compose sets
  `0.0.0.0` inside the container and publishes the port on loopback).
- The upstreams default to the Compose service names and are overridden by
  `deploy/compose.host.yaml` with `AOS_UI_GATEWAY_UPSTREAM`,
  `AOS_UI_GATEWAY_GUEST_UPSTREAM`, `AOS_UI_WEB_UPSTREAM`, and
  `AOS_UI_WEB_GUEST_UPSTREAM`.
- There is no admin API, no automatic HTTPS, and no access log, because a file
  address carries its pass in the query. External ingress owns TLS.

## Gateway configuration

The harness-gw gateway reads one private YAML file. Every key, its default,
its `HARNESS_GW_*` override, and its validation rules are documented in
harness-gw's
[configuration reference](https://github.com/AlmogBaku/harness-gw/blob/main/docs/configuration.md);
the wire and HTTP API, including origin rules, are in its
[`docs/protocol.md`](https://github.com/AlmogBaku/harness-gw/blob/main/docs/protocol.md).
Start from the example for the selected runtime in harness-gw's `examples/`:
[`config.hermes.example.yaml`](https://github.com/AlmogBaku/harness-gw/blob/main/examples/config.hermes.example.yaml),
[`config.openclaw.example.yaml`](https://github.com/AlmogBaku/harness-gw/blob/main/examples/config.openclaw.example.yaml),
or
[`config.opencode.example.yaml`](https://github.com/AlmogBaku/harness-gw/blob/main/examples/config.opencode.example.yaml).

What an aos-ui operator needs beyond that reference:

- **Validate first.** `harness-gw config check --config <path>` validates the
  file and its `HARNESS_GW_*` overrides and starts nothing. An invalid
  configuration logs `gateway.start_failed` naming each failing field, never
  its value.
- **Ownership under Compose.** The harness overlays bind-mount the file, which
  keeps its host ownership, so it must be owned by `AOS_UI_HOST_UID` at mode
  `0600` or `0640`, or by root at `0644`, and never be group- or
  world-writable.
- **Listeners.** In Compose the operator listener (`listen`) is port `4100` and
  the guest listener (`guest.listen`) port `4101`, both behind Caddy; a
  wildcard host needs `exposure: private-container`. Under
  `deploy/compose.host.yaml` both listen on `127.0.0.1`. The operator listener
  has no application authentication.
- **Origins.** Each listener's `publicOrigin` must be the exact origin the
  browser uses: `http://127.0.0.1:3000` for the operator lane and
  `http://127.0.0.1:3001` for the guest lane under the default Compose ports,
  or the HTTPS name in front of them. A non-loopback origin must be `https:`.
  The `aos-invite-link` skill's `curl` creates invitations without an
  `Origin`, which the operator listener allows for that one route.
- **Operator-only.** A configuration with no `guest` block has no guest
  listener; see [Deployment](deployment.md#run-without-the-guest-lane) for the
  matching Compose change.

### Voice providers {#voice-providers}

A `voice` block routes transcription and read-aloud through an
OpenAI-compatible speech provider; without it only the runtime's native speech
is used. Its fields and `fallback`/`override` modes are in harness-gw's
configuration reference. Its `apiKeyFile` entries are files mounted into the
gateway container, never values in `.env` or the Compose environment, and are
unrelated to OpenCode's `AOS_UI_OPENAI_COMPATIBLE_API_KEY`; see
[Deployment](deployment.md#voice-provider-key-files) for the mount.

### MCP Apps fallback {#mcp-apps-fallback}

On Hermes and OpenCode the gateway reads an App's view through its own MCP
client from the server URL the runtime reports. A Hermes on the host registers
the `aos-ui` tools server as `http://127.0.0.1:4110/mcp`, which a gateway in a
Compose container cannot reach, so the gateway configuration overrides it:

```yaml
mcpApps:
  fallback:
    servers:
      aos-ui:
        url: http://tools-mcp:4110/mcp
```

harness-gw's Hermes example already sets this. Under
`deploy/compose.host.yaml` the loopback URL works and `tools-mcp` does not
resolve, so drop the override there. An override never adds a server the
runtime does not report. OpenClaw serves Apps natively and ignores the block.
See [MCP Apps](mcp-apps.md) for what a view may do once it is served.

### MCP App files {#mcp-app-files}

`present_artifact` names the file it presents, and the gateway reads it for
the view through the runtime; the view never sees its path. An `mcpApps.files`
block decides which calls and folders qualify:

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

- `servers` defaults to `[aos-ui]` (which also matches `aos_ui`); a call from
  any other server gets no files.
- Operators get the Agent's own folder by default. Guests get nothing until
  `guest` allows a folder, and a guest read must pass the `operator` folders
  too. A denial beats an allowance.
- Credential folders and names (`.ssh`, `.env`, `*.pem`, SSH keys, and the
  rest of harness-gw's list) are refused whatever the folders say, and a
  symbolic link cannot lead out of an allowed folder.
- `viewer` names the view a published attachment opens in; the default is
  `aos-ui`'s `ui://aos-ui/artifact`.

The full rules are in harness-gw's configuration reference; see
[MCP Apps](mcp-apps.md#files) for the routes.

### Web Push (optional)

For Compose deployments, `compose.push.yaml` passes push settings to the
gateway as container environment variables, so the private configuration file
needs no `push` block. Add `-f compose.push.yaml` after the runtime overlay and
set `HARNESS_GW_PUSH_STATE_DIR`, `HARNESS_GW_PUSH_VAPID_PRIVATE_KEY_FILE`, and
`HARNESS_GW_PUSH_VAPID_SUBJECT` (see
[Deployment](deployment.md#web-push-state-and-vapid-secret)). Omitting the
overlay leaves tab-only delivery active with no additional variables required.
