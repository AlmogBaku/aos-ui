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

`readyz` returns 503 when the proxy cannot reach the configured runtime. `healthz` is liveness only and always returns 200. Resolve the runtime connectivity problem first; `readyz` becomes 200 once the runtime reports ready.

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

AOS reconnects to the native Session without submitting a prompt. Recovery and auto-continue policy remain Hermes settings.

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
  A missing rename/archive/delete, Todo, Activity, edit/regenerate, steering,
  voice, or read-state control is an explicit capability limit.
- Confirm Session records include matching `threadId` and `agentId` values.
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
- A missing Todo, Activity, context meter, title/delete, voice,
  edit/regenerate, or steering control is an explicit OpenCode capability
  limit, not a connection failure.

## A capability is missing

Check the [runtime capability matrix](runtime-capabilities.md). AOS shows only capabilities supported by the active adapter and provider. Fixture mode intentionally omits Agent creation; OpenClaw and OpenCode catalogs are read-only; rename, archive, delete, read state, Todos, and Activity are Hermes-only.

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

- Confirm the active conversation branch contains an explicit `present_artifact` result, an assistant `MEDIA:/absolute/path` line (Hermes), or a successful trusted provider-native delivery receipt, such as Hermes text-to-speech.
- `present_artifact` and `MEDIA:` take an absolute path. AOS refuses a relative path, a path that traverses with `..`, and any path naming a credential file such as `.env`, `auth.json`, or `config.yaml`.
- OpenCode reads only files inside the configured project directory; a path outside it reads as unavailable. OpenClaw reads only the Session's workspace files, at most 256 KiB and only text or common images; OpenClaw's native media appears after a reload.
- Artifacts larger than 25 MiB are not read back.
- Confirm the Artifact still exists in provider-owned storage and belongs to the selected Agent and Session.
- For HTML dependencies, add only the required credential-free HTTPS origins to `artifactHtmlAssetOrigins`.
- Inspect the Source or textual fallback when preview rendering is unavailable.

## A route points to missing work

AOS validates Agent and Session ownership before selecting a route. Refresh the provider catalog. If the native record was deleted, hidden, renamed, or archived, choose a current Session instead; AOS does not create a browser-owned replacement.

## Collect useful diagnostics

Record the runtime mode, browser, native runtime version, failing Agent/Session identifiers, and the first relevant browser-console or native-server error. Exclude credentials, invitation tokens, conversation content, tool payloads, and speech data.

For code-level verification, run:

```bash
bun run test
bun run typecheck
bun run lint
bun run build
```
