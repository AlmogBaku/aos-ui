# Troubleshoot AOS

Start with the symptom you see. AOS fails closed when runtime configuration or provider data cannot be trusted, so an unavailable control is often an intentional capability boundary rather than a hidden fallback.

## The runtime is unavailable

1. Open `/runtime-config.json` in the same browser origin.
2. Confirm it is valid JSON and uses exactly one shape from the [configuration reference](configuration.md).
   The default `deploy/runtime-config.fixture.json` is `{"mode":"fixture"}`; the file `{}`
   and the default Compose value both fail the strict schema and produce an unavailable state.
   Every production recipe must set `AOS_UI_RUNTIME_CONFIG_FILE`.
3. Remove unknown fields and credentials.
4. Provider-specific server adapters are not browser runtime modes; confirm the
   normalized AOS proxy is configured and reachable.
5. Confirm the private proxy configuration selects one supported runtime kind:
   `hermes`, `openclaw`, or `opencode`.

If Vite is using environment-derived configuration, restart it after changing variables. AOS never substitutes fixture data for an invalid real-runtime configuration.

## The proxy returns "Invalid proxy configuration"

The startup log entry (`proxy.start_failed`) carries a readable
`ProxyConfigurationError` message. The message begins with the file path,
followed by one indented line per field; values are never included and
unrecognized keys are reported as a count:

```
Invalid proxy configuration in /etc/aos-ui/proxy.yaml:
  runtime.tokenFile: Invalid input: expected string, received undefined
  limits: 1 unrecognized key
```

When a `AOS_UI_PROXY_*` variable set the failing field, its name appears in
parentheses after the message. File-check failures produce their own messages
before parsing begins:

- `the configuration file must be a regular file`
- `the configuration file must not be group- or world-writable`
- `the configuration file must be owned by this user or by root`
- `the configuration file is larger than the 1048576 byte limit`

If no `--config` flag or `AOS_UI_PROXY_CONFIG_FILE` variable is set, the proxy
discovers `${XDG_CONFIG_HOME:-$HOME/.config}/aos-ui/proxy.yaml`. A discovered
path that does not exist is not an error; an explicitly supplied path that does
not exist is. Use `--config` or `AOS_UI_PROXY_CONFIG_FILE` to make the path
explicit.

To validate the schema interactively, check all required fields are present
(`deploymentId`, `publicOrigin`, `runtime`), `version: 1`, `listen.host` is one
of `127.0.0.1|::1|0.0.0.0|::`, and `publicOrigin` is `https:` unless the host
is `127.0.0.1`, `[::1]`, or `localhost`. See the
[configuration reference](configuration.md) for the full field list.

## A request returns 403 Forbidden

The `Origin` header on attachments, transcription, speech, and guest-invitation requests must match the operator `publicOrigin` configured in the private proxy configuration. Mismatches — including `http://` vs `https://` or a wrong port — return 403.

## A secret file is rejected

Secret files must be regular non-symlinked files, owner-only (`chmod 600`), non-empty, and at most 8192 bytes. Guest invitation signing keys must be exactly 43 characters of base64url encoding a 32-byte value. The proxy error message does not reveal which constraint failed; check all of them.

## `/api/aos/v1/readyz` returns 503

`readyz` returns 503 when the proxy cannot reach the configured runtime.
`healthz` is liveness only and always returns 200, with body
`{status: "ok"|"degraded", links: [{name, state}], gauges: {sockets,
memberships, executions, uncertain, deadlinesFired, journalBytes}}`.
`status: "degraded"` means the native link is `lost`; the proxy is still
running and serving. Resolve the runtime connectivity problem first; `readyz`
becomes 200 once the runtime reports ready.

## Hermes authentication fails

Hermes V1 uses a configured server token loaded from the proxy's private secret
file. Verify the configured file exists, is owner-only, is readable by the
proxy process, and contains the current Hermes token. The browser never handles
Hermes cookies or credentials.

## Hermes HTTP works but live updates fail

- Confirm your reverse proxy forwards WebSocket upgrades on `/api/aos/v1/acp`
  and keeps buffering disabled for `/api/aos/v1`.
- Verify the proxy config's Hermes base URL is reachable from the proxy
  container; it is never a browser-facing URL.
- Check that the server version exposes the native interfaces described in the [Hermes guide](runtimes/hermes.md).

AOS reconnects to the native Session without submitting a prompt, keeping the conversation on screen under a "Reconnecting to AOS…" notice until the Session rejoins. Recovery and auto-continue policy remain Hermes settings.

## The proxy container cannot reach Hermes

A host service bound only to `127.0.0.1` is not reachable through Docker's host gateway. Bind Hermes to an appropriate trusted interface or provide another container-reachable host, then update the private proxy config's `runtime.baseUrl`.

From the proxy container, verify the configured host and port resolve and
accept connections. Keep the browser-facing configuration on the normalized
same-origin `/api/aos/v1` path.

## OpenClaw is unavailable

- Use `AOS_UI_RUNTIME_MODE=aos`; AOS does not expose a browser Gateway route.
- Verify the private `runtime.baseUrl` is a reachable WebSocket URL and its
  device identity/token files are present, owner-only, and readable by the
  proxy. Do not place either credential in browser configuration.
- With `compose.openclaw.yaml`, `host.docker.internal` reaches Docker's host
  gateway. A native Gateway bound only to host loopback may not be reachable;
  use a trusted container-reachable address instead.
- Pairing or policy-negotiation errors are Gateway/proxy configuration errors.
  A missing Todo, Activity, edit/regenerate, steering, voice, or read-state
  control is an explicit capability limit.
- Confirm Session records include matching `sessionId` and `agentId` values.
- Confirm a newly created Session reports the Agent that was requested.
- Ensure history responses contain valid message data and resumable state when advertised.

## OpenCode is unavailable

- Use `AOS_UI_RUNTIME_MODE=aos`; the browser never connects directly to
  OpenCode.
- Verify the private `runtime.baseUrl`, absolute `runtime.directory`,
  `runtime.username`, and owner-only `runtime.passwordFile` match the running
  OpenCode server.
- From a proxy container, use the Compose service address (`opencode:4096`),
  not a browser-facing URL. For an independently operated server, ensure its
  address is reachable from the proxy process.
- A missing Activity, context meter, voice, edit/regenerate, or steering
  control is an explicit OpenCode capability limit, not a connection failure.

## A capability is missing

Check the [runtime capability matrix](runtime-capabilities.md). AOS shows only capabilities supported by the active adapter and provider. Fixture mode intentionally omits Agent creation; OpenClaw and OpenCode catalogs are read-only; read state and Activity are Hermes-only, and Todos are available on Hermes and OpenCode. Session rename, pin, archive, and delete work on every runtime; a Session menu item the runtime does not declare stays visible, disabled, as "Unavailable for this runtime".

## Browser notifications do not appear

1. Enable notifications in Activity settings.
2. Grant browser permission and check operating-system notification settings or Do Not Disturb.
3. Keep at least one AOS tab loaded.
4. Test from another Session, a hidden tab, or an unfocused browser window. The exact visible and focused Session suppresses its own alert.

Denied or unsupported permission does not disable Activity. Multiple tabs elect one delivery tab, so only one operating-system notification is expected.

## Microphone or read-aloud is unavailable

Voice requires either the relevant native runtime STT/TTS configuration or a proxy `voice` block in the private proxy configuration. Microphone capture also requires HTTPS or `localhost`, browser support, and permission. Follow [Use voice](chat-voice.md) for mode-specific checks, proxy provider setup, and safety limits.

## The tools MCP server is not connected

- Check the server itself: `curl --fail http://127.0.0.1:4110/health` should
  print `ok`. Under Compose, `docker compose ps tools-mcp` should report it
  healthy; `AOS_UI_TOOLS_MCP_PORT` changes its host port.
- The server listens on loopback. A harness on the same host registers
  `http://127.0.0.1:4110/mcp`; the Compose OpenCode service uses
  `http://tools-mcp:4110/mcp`. A harness in another container or on another
  host cannot reach host loopback.
- Tools run but charts, maps, and stats show as text on Hermes or OpenCode: the
  proxy cannot reach the URL the harness registered. A proxy in a container
  needs `mcpApps.fallback.servers.aos-ui.url: http://tools-mcp:4110/mcp`
  ([MCP Apps fallback](configuration.md#mcp-apps-fallback)).
- Hermes: `hermes -p PROFILE mcp test aos-ui` reports whether the profile's
  `mcp_servers.aos-ui` entry connects. Confirm the entry is in that profile's
  own `config.yaml`, not another profile's.
- OpenClaw: `openclaw mcp status` and `openclaw mcp probe aos-ui` report the
  registered server. The entry must use `"transport": "streamable-http"`.

## The AOS tools are missing from a Session

- Hermes: a running server connects a new MCP server within about a minute.
  When `aos-ui` is the profile's first MCP server, run `/reload-mcp` or start
  a new Session.
- OpenClaw: the server stays disabled until the proxy enables it for the
  Session. A turn that fails because that enable patch failed usually means
  the proxy device lacks `operator.admin`; re-pair it with that scope. Run
  `openclaw mcp reload` after changing `openclaw.json`.
- OpenCode: at the pinned 1.18.29 the v2 session engine AOS drives does not
  expose MCP tools, so the tools are not callable through AOS. This is an
  upstream limit, not a configuration error.

## A published Artifact cannot load

### present_artifact file not loading

The proxy logs `app_file.refused` (404) or `app_file.unavailable` (503) for
every failure; it never logs the path. Reason codes, from
`packages/proxy/routes/app-files.ts`:

**Refused (404):**

| Code                    | Meaning                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `no_reader`             | The runtime cannot read files, or (for a guest) cannot report a file's real path |
| `call_unknown`          | No such tool call in that Session                                                |
| `server_not_allowed`    | The call's MCP server is not in `mcpApps.files.servers`                          |
| `argument_not_servable` | The argument is missing, nested, or not an absolute normalized path              |
| `denied`                | The folder rules refuse the written path                                         |
| `real_path_unknown`     | The runtime could not report the real path                                       |
| `real_path_denied`      | The real path, after links, falls outside the folder rules                       |
| `runtime_refused`       | The runtime answered 403                                                         |
| `missing`               | The runtime answered 404 (file not found)                                        |
| `gone`                  | The Agent or Session no longer exists                                            |

**Unavailable (503):**

| Code             | Meaning                                                   |
| ---------------- | --------------------------------------------------------- |
| `runtime_status` | The runtime answered a status other than 200, 206, or 416 |
| `failed`         | The read failed for another reason                        |

A 401 response means a bad or expired pass, or a guest without a valid login.
A 429 response means the file route's own rate limit was hit.

If the card shows "Can't reach this file" and the proxy logged nothing, `open`
returned no address. Every path that leads there:

- The call's MCP server is not in `mcpApps.files.servers`.
- The runtime cannot read files (OpenCode).
- No folder is configured for this Agent.
- The guest is on OpenClaw (guests get no file addresses on OpenClaw).

**OpenCode** cannot yet serve files; the card always shows "Can't reach this file".

**OpenClaw** cannot reach sandboxed Sessions or Sessions on other machines.

**Hermes** reports the reason when it cannot resolve the real path of a file
(logged as `hermes.file.real_path_unknown`):

| Code              | Meaning                                                                            |
| ----------------- | ---------------------------------------------------------------------------------- |
| `listing_invalid` | The folder path is not a real directory (for example, a broken link loop)          |
| `listing_refused` | The folder is outside a locked root or Hermes cannot read it                       |
| `listing_missing` | The folder does not exist                                                          |
| `listing_failed`  | A broken link whose target Hermes cannot stat                                      |
| `not_listed`      | The file is not in the folder listing; Hermes omits credential files from listings |

Any of these causes the proxy to log `app_file.refused` with code `real_path_unknown`.

For HTML files shown in the `present_artifact` card:

- The view loads no external or relative resources; an HTML file that needs them must inline everything.
- Scripts are off; any effect that requires a script will not appear in the preview.

For PDFs:

- JPEG 2000 images inside a PDF stay blank in Safari and WebKit while the rest of the page renders. This is a WebKit limitation.

### MEDIA: and trusted-delivery Artifacts

- `MEDIA:` takes an absolute path. AOS refuses a relative path, a path that traverses with `..`, and any path naming a credential file such as `.env`, `auth.json`, or `config.yaml`.
- Artifacts larger than 25 MiB are not read back.
- Confirm the Artifact still exists in provider-owned storage and belongs to the selected Agent and Session.

## A route points to missing work

AOS validates Agent and Session ownership before selecting a route. Refresh the provider catalog. If the native record was deleted, hidden, renamed, or archived, choose a current Session instead; AOS does not create a browser-owned replacement.

## Debug an ACP connection

To trace a live ACP connection in any build, add `?debug=acp` to the page URL once for the tab. The tab then logs one line per owner state change and one per wire frame to the browser console. The flag is stored in `sessionStorage` for the rest of the tab session; opening a new tab clears it.

Match browser log lines to proxy log lines by the `sessionId`, `turnId`, and `requestId` fields that appear in both. Raise the proxy log level to `debug` with `AOS_UI_PROXY_LOG_LEVEL=debug` or `log.level: debug` in the private proxy configuration to see owner state changes on the server side. `debug` is never the production default.

### ACP upgrade log entries

| Log line                          | Meaning and fix                                                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acp.upgrade.origin_refused`      | The `Origin` header was present but did not match `publicOrigin`. Update the reverse-proxy configuration or the `publicOrigin` field.                                                     |
| `acp.upgrade.agent_unknown`       | The Agent id in the path is not in the catalog; the Agent may be deleted or hidden. Check the Agent id and confirm it is visible.                                                         |
| `acp.upgrade.catalog_failed`      | The catalog query during upgrade threw; the socket was refused with 503. The line carries the public `errorCode`. Check runtime connectivity.                                             |
| `turn.receipt.deadline_passed`    | The storage receipt for the prompt did not arrive within 30 s; the answer was sent as `uncertainMutation`. Check runtime latency and storage health.                                      |
| `session.list.no_folder`          | (info) A list across Agents met an Agent whose runtime names no folder; that Agent's Sessions are omitted. Configure the Agent's folder (for Hermes, an absolute `terminal.cwd`).         |
| `session.list.folder_read_failed` | A list across Agents could not read one Agent's folder; that Agent's Sessions are omitted and the others still list. The line carries the public `errorCode`. Check runtime connectivity. |

**Folder refusal on `session/new` or `session/resume`:** the proxy returns
invalid params when `cwd` does not match the Agent's folder exactly, or
unsupported when the Agent has no folder. Send an empty `cwd` or the folder the
Session list row reports, or confirm the Agent's folder is configured in the
runtime.

## Renamed proxy log fields

If you have log queries that filter on these field values, update them:

| Old value             | New value             | Where                                         |
| --------------------- | --------------------- | --------------------------------------------- |
| `lane`                | `role`                | membership role field                         |
| `subscriberId`        | `membershipId`        | membership id on turn and subscription events |
| `acp.room.failed`     | `channel.failed`      | channel setup failure                         |
| `acp.fanout.detached` | `membership.detached` | subscriber fell behind its queue bounds       |

## Collect useful diagnostics

Record the runtime mode, browser, native runtime version, failing Agent/Session identifiers, and the first relevant browser-console or native-server error. Exclude credentials, invitation tokens, conversation content, tool payloads, and speech data.

For code-level verification, run:

```bash
bun run test
bun run test:gate
bun run typecheck
bun run lint
bun run build
```
