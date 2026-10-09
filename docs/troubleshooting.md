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
   harness-gw gateway is configured and reachable on the same origin at
   `/api/v1`.
5. Confirm the private gateway configuration selects one supported runtime kind:
   `hermes`, `openclaw`, or `opencode`.

If Vite is using environment-derived configuration, restart it after changing variables. AOS never substitutes fixture data for an invalid real-runtime configuration.

## Check each service

Under Compose, check the three layers from the outside in:

```bash
docker compose ps                                   # every service healthy
curl --fail --silent http://127.0.0.1:3000/healthz  # Caddy, then the web server
curl --fail --silent http://127.0.0.1:3000/runtime-config.json
curl --fail --silent http://127.0.0.1:3000/api/v1/healthz  # the gateway
```

`/healthz` on the operator lane is answered by the AOS web server through
Caddy; `/api/v1/healthz` and `/api/v1/readyz` are the gateway's, operator lane
only. Read each service's log with `docker compose logs caddy`, `web`, or
`gateway`. Caddy keeps no access log, because a file address carries its pass
in the query.

| Response | Where it comes from |
| --- | --- |
| `421 Misdirected Request` | Caddy: the request's `Host` is not `127.0.0.1`, `localhost`, or the lane's `AOS_UI_PUBLIC_HOST` / `AOS_UI_GUEST_PUBLIC_HOST`. Set the name the browser uses. |
| `502 Bad Gateway` | Caddy cannot reach the web server or gateway lane. Under `compose.dev.yaml`, the guest lane always answers 502, because Vite serves the operator surface only. On the guest lane's `/api/v1` with no gateway guest listener, add `deploy/compose.operator-only.yaml`; see [Run without the guest lane](deployment.md#run-without-the-guest-lane). |
| `404` on an `/api` path | The web server answers no `/api` path, and the gateway answers nothing outside `/api/v1`; operator-only gateway routes such as invitations and push answer 404 on the guest lane. |
| `405` | The web server accepts only GET and HEAD. |
| `503` on `/runtime-config.json` | The web server cannot read its `AOS_UI_RUNTIME_CONFIG_FILE`, or the file is not a JSON object. |

## The gateway does not start

The gateway's startup log (`gateway.start_failed`) names the configuration file
and one indented line per failing field, without values. `harness-gw config
check --config <file>` runs the same validation without starting anything. File
ownership and mode rules, discovery, `HARNESS_GW_*` overrides, and every field
are documented in harness-gw's
[`README.md`](https://github.com/AlmogBaku/harness-gw/blob/main/README.md) and
the example configurations in its `examples/` directory. Gateway variables are
`HARNESS_GW_*` only; an `AOS_UI_*` name configures the UI, never the gateway.

## A request returns 403 Forbidden

Each gateway listener accepts a WebSocket upgrade or a state-changing request
(attachments, transcription, speech, invitations, push) only with an `Origin`
in its `allowedOrigins`, which default to its `publicOrigin`, when it carries
one. A `null` or foreign `Origin` gets 403 before any route runs, and the
gateway logs nothing for it. Mismatches include `http://` against `https://`, a
wrong port, and `localhost` against `127.0.0.1`. A request with no `Origin`,
such as the `aos-invite-link` skill's `curl` or a non-browser ACP client, is
admitted. The rules are in harness-gw's
[`docs/protocol.md`](https://github.com/AlmogBaku/harness-gw/blob/main/docs/protocol.md#origins).

## The page reloads once after a deploy

Each open tab refetches `/runtime-config.json` when it reconnects and when it
regains focus. When the `buildId` there, which the web server reads from the
served `dist/build-id`, differs from the build the tab runs, the tab reloads
once; a `sessionStorage` entry prevents a reload loop. A tab that keeps the
old build after a deploy means `/runtime-config.json` is cached by something in
front of Caddy or still reports the old build.

## A connection ends with a version error

The browser checks the gateway's extension version in `initialize`. A gateway
that speaks another version ends the connection without reconnecting, because
a retry cannot change it. Deploy a gateway release that matches the
`@harness-gw/sdk` version this build of AOS uses.

## A secret file is rejected

Secret files must be regular non-symlinked files, owner-only (`chmod 600`), non-empty, and at most 8192 bytes. Guest invitation signing keys must be exactly 43 characters of base64url encoding a 32-byte value. The gateway's error message does not reveal which constraint failed; check all of them.

## `/api/v1/readyz` returns 503

`readyz` returns 503 when the gateway cannot reach the configured runtime.
`healthz` is liveness only and always returns 200; its body reports
`status: "degraded"` while the native link is lost, and the gateway keeps
serving. Resolve the runtime connectivity problem first; `readyz` becomes 200
once the runtime reports ready. Both are on the operator lane only.

## Hermes authentication fails

The gateway authenticates to Hermes with a server token from a private secret
file (`HARNESS_GW_HERMES_TOKEN_FILE` under Compose). Verify the file exists, is
owner-only, is readable by the gateway's user (`AOS_UI_HOST_UID`), and contains
the current Hermes token. Hermes closes a rejected socket with 4401; see
harness-gw's [Hermes guide](https://github.com/AlmogBaku/harness-gw/blob/main/docs/runtimes/hermes.md). The browser never handles
Hermes cookies or credentials.

## Hermes HTTP works but live updates fail

- Confirm any reverse proxy in front of Caddy forwards WebSocket upgrades on
  `/api/v1/acp`, keeps buffering disabled for `/api/v1`, and passes the
  browser's `Origin` unchanged.
- Verify the gateway config's Hermes base URL is reachable from the gateway
  container; it is never a browser-facing URL.
- Check that the server version exposes the native interfaces described in the [Hermes guide](runtimes/hermes.md).

AOS reconnects to the native Session without submitting a prompt, keeping the conversation on screen under a "Reconnecting to AOS…" notice until the Session rejoins. Recovery and auto-continue policy remain Hermes settings.

## Caddy does not start

`module name 'host': module value cannot be null` in Caddy's log means `AOS_UI_PUBLIC_HOST` or
`AOS_UI_GUEST_PUBLIC_HOST` is set but empty in an environment that bypasses
Compose, which maps an empty value to `localhost`. Unset the variable or give
it a name.

## A published port hangs, or a container cannot reach the host

On a host using a Tailscale exit node or a similar VPN client, a policy routing
table (52 for Tailscale) sends Docker's bridge ranges, such as
`172.16.0.0/12`, to the VPN interface. `ip route show table all | grep
172.` lists such routes. Run the [host-networking shape](deployment.md#host-networking),
or add an `ip rule` with a higher priority than the VPN's that looks up the
`main` table for the Docker bridge subnets.

## The gateway container cannot reach Hermes

A host service bound only to `127.0.0.1` is not reachable through Docker's host gateway, and Hermes' `Host` check rejects `host.docker.internal`, so a bridged gateway cannot use that name for a Hermes on the host. Run the host-networking shape, adding `-f deploy/compose.host.yaml` after the harness overlay, with the gateway's listeners and `runtime.baseUrl` on `127.0.0.1`; see [Deployment](deployment.md#host-networking). Otherwise bind Hermes to a trusted interface the bridge can reach under a `Host` name Hermes accepts, and update the private gateway config's `runtime.baseUrl`.

From the gateway container, verify the configured host and port resolve and
accept connections. The browser reaches only the same-origin `/api/v1` path.

## OpenClaw is unavailable

- Use `AOS_UI_RUNTIME_MODE=aos`; AOS does not expose a browser Gateway route.
- Verify the private `runtime.baseUrl` is a reachable WebSocket URL and its
  device identity/token files are present, owner-only, and readable by the
  gateway. Do not place either credential in browser configuration.
- With `compose.openclaw.yaml`, `host.docker.internal` reaches Docker's host
  gateway. A native Gateway bound only to host loopback may not be reachable;
  use a trusted container-reachable address instead.
- Pairing or policy-negotiation errors are OpenClaw or gateway configuration errors.
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
- From the gateway container, use the Compose service address (`opencode:4096`),
  not a browser-facing URL. For an independently operated server, ensure its
  address is reachable from the gateway process.
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

Voice requires either the relevant native runtime STT/TTS configuration or a `voice` block in the private gateway configuration. Microphone capture also requires HTTPS or `localhost`, browser support, and permission. Follow [Use voice](chat-voice.md) for mode-specific checks, gateway provider setup, and safety limits.

## The tools MCP server is not connected

- Check the server itself: `curl --fail http://127.0.0.1:4110/health` should
  print `ok`. Under Compose, `docker compose ps tools-mcp` should report it
  healthy; `AOS_UI_TOOLS_MCP_PORT` changes its host port.
- The server listens on loopback. A harness on the same host registers
  `http://127.0.0.1:4110/mcp`; the Compose OpenCode service uses
  `http://tools-mcp:4110/mcp`. A harness in another container or on another
  host cannot reach host loopback.
- Tools run but charts, maps, and stats show as text on Hermes or OpenCode: the
  gateway cannot reach the URL the harness registered. A gateway in a container
  needs `mcpApps.fallback.servers.aos-ui.url: http://tools-mcp:4110/mcp` in its
  configuration, as harness-gw's Hermes example sets.
- Hermes: `hermes -p PROFILE mcp test aos-ui` reports whether the profile's
  `mcp_servers.aos-ui` entry connects. Confirm the entry is in that profile's
  own `config.yaml`, not another profile's.
- OpenClaw: `openclaw mcp status` and `openclaw mcp probe aos-ui` report the
  registered server. The entry must use `"transport": "streamable-http"`.

## The AOS tools are missing from a Session

- Hermes: a running server connects a new MCP server within about a minute.
  When `aos-ui` is the profile's first MCP server, run `/reload-mcp` or start
  a new Session.
- OpenClaw: the server stays disabled until the gateway enables it for the
  Session. A turn that fails because that enable patch failed usually means
  the gateway's device lacks `operator.admin`; re-pair it with that scope. Run
  `openclaw mcp reload` after changing `openclaw.json`.
- OpenCode: at the pinned 1.18.29 the v2 session engine AOS drives does not
  expose MCP tools, so the tools are not callable through AOS. This is an
  upstream limit, not a configuration error.

## A published Artifact cannot load

### present_artifact file not loading

The gateway logs `app_file.refused` (404) or `app_file.unavailable` (503) for
every failure, with a reason code and never the path. The codes, from
harness-gw's `src/routes/app-files.ts`:

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

If the card shows "Can't reach this file" and the gateway logged nothing, `open`
returned no address. Every path that leads there:

- The call's MCP server is not in `mcpApps.files.servers`.
- The runtime cannot read files (OpenCode).
- No folder is configured for this Agent.
- The guest is on OpenClaw (guests get no file addresses on OpenClaw).

**OpenCode** cannot yet serve files; the card always shows "Can't reach this file".

**OpenClaw** cannot reach sandboxed Sessions or Sessions on other machines.

**Hermes** fails a whole folder listing when it cannot resolve even one entry,
so one broken or looping link blocks every file in that folder; the gateway
logs `hermes.file.real_path_unknown`. harness-gw's
[Hermes guide](https://github.com/AlmogBaku/harness-gw/blob/main/docs/runtimes/hermes.md)
explains each listing code.

For HTML files shown in the `present_artifact` card:

- The view loads no external or relative resources; an HTML file that needs them must inline everything.
- Inline scripts run, but in an opaque origin with no network: a script that fetches, opens a frame, submits a form, or reads storage fails in the preview.
- Images and media from `blob:` addresses stay blank; inline them as `data:` addresses.

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

Match browser log lines to gateway log lines by the `sessionId`, `turnId`, and `requestId` fields that appear in both. Raise the gateway log level to `debug` with `HARNESS_GW_LOG_LEVEL=debug` or `log.level: debug` in the private gateway configuration to see owner state changes on the server side. `debug` is never the production default.

### Gateway log entries

| Log line                          | Meaning and fix                                                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acp.upgrade.agent_unknown`       | The Agent id in the path is not in the catalog; the Agent may be deleted or hidden. Check the Agent id and confirm it is visible.                                                         |
| `acp.upgrade.catalog_failed`      | The catalog query during upgrade threw; the socket was refused with 503. The line carries the public `errorCode`. Check runtime connectivity.                                             |
| `turn.receipt.deadline_passed`    | The storage receipt for the prompt did not arrive within 30 s; the answer was sent as `uncertainMutation`. Check runtime latency and storage health.                                      |
| `session.list.no_folder`          | (info) A list across Agents met an Agent whose runtime names no folder; that Agent's Sessions are omitted. Configure the Agent's folder (for Hermes, an absolute `terminal.cwd`).         |
| `session.list.folder_read_failed` | A list across Agents could not read one Agent's folder; that Agent's Sessions are omitted and the others still list. The line carries the public `errorCode`. Check runtime connectivity. |

A refused `Origin` is answered 403 without a log line; see
[A request returns 403 Forbidden](#a-request-returns-403-forbidden).

**Folder refusal on `session/new` or `session/resume`:** the gateway returns
invalid params when `cwd` does not match the Agent's folder exactly, or
unsupported when the Agent has no folder. Send an empty `cwd` or the folder the
Session list row reports, or confirm the Agent's folder is configured in the
runtime.

## Collect useful diagnostics

Record the runtime mode, browser, AOS build id, gateway version (`initialize`'s `info.version`), native runtime version, failing Agent/Session identifiers, and the first relevant browser-console or native-server error. Exclude credentials, invitation tokens, conversation content, tool payloads, and speech data.

For code-level verification, run:

```bash
bun run test
bun run test:gate
bun run typecheck
bun run lint
bun run build
```
