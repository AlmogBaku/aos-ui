# Troubleshoot AOS

Start with the symptom you see. AOS fails closed when runtime configuration or provider data cannot be trusted, so an unavailable control is often an intentional capability boundary rather than a hidden fallback.

## The runtime is unavailable

1. Open `/runtime-config.json` in the same browser origin.
2. Confirm it is valid JSON and uses exactly one shape from the [configuration reference](configuration.md).
3. Remove unknown fields and credentials.
4. Provider-specific server adapters are not browser runtime modes; confirm the
   normalized AOS proxy is configured and reachable.
5. Confirm the private proxy configuration selects one supported runtime kind:
   `hermes`, `opencode`, or `openclaw`.

If Vite is using environment-derived configuration, restart it after changing variables. AOS never substitutes fixture data for an invalid real-runtime configuration.

## OpenCode is unavailable

- Use `AOS_UI_RUNTIME_MODE=aos`; the browser never connects directly to
  OpenCode.
- Verify the private `runtime.baseUrl`, absolute `runtime.directory`,
  `runtime.username`, and owner-only `runtime.passwordFile` match the running
  OpenCode server.
- From a proxy container, use the Compose service address (`opencode:4096`),
  not a browser-facing URL. For an independently operated server, ensure its
  address is reachable from the proxy process.
- A missing Todo, Activity, context meter, title/delete, artifact, voice,
  edit/regenerate, or steering control is an explicit OpenCode capability
  limit, not a connection failure.

## Hermes authentication fails

Hermes V1 uses a configured server token loaded from the proxy's private secret
file. Verify the configured file exists, is owner-only, is readable by the
proxy process, and contains the current Hermes token. The browser never handles
Hermes cookies or credentials.

## Hermes HTTP works but live updates fail

- Confirm Nginx forwards WebSocket upgrades on `/api/aos/v1/events` and keeps
  buffering disabled for `/api/aos/v1`.
- Verify the proxy config's Hermes base URL is reachable from the proxy
  container; it is never a browser-facing URL.
- Check that the server version exposes the native interfaces described in the [Hermes guide](runtimes/hermes.md).

AOS reconnects to the native Session without submitting a prompt. Recovery and auto-continue policy remain Hermes settings.

## The proxy container cannot reach Hermes

A host service bound only to `127.0.0.1` is not reachable through Docker's host gateway. Bind Hermes to an appropriate trusted interface or provide another container-reachable host, then update the private proxy config's `hermes.baseUrl`.

From the proxy container, verify the configured host and port resolve and
accept connections. Keep the browser-facing configuration on the normalized
same-origin `/api/aos/v1` path.

## Generic AG-UI Agents or Sessions do not load

- Verify the workspace service implements every required endpoint in the [AG-UI guide](runtimes/ag-ui.md).

## OpenClaw is unavailable

- Use `AOS_UI_RUNTIME_MODE=aos`; AOS does not expose a browser Gateway route.
- Verify the private `runtime.baseUrl` is a reachable WebSocket URL and its
  device identity/token files are present, owner-only, and readable by the
  proxy. Do not place either credential in browser configuration.
- With `compose.openclaw.yaml`, `host.docker.internal` reaches Docker's host
  gateway. A native Gateway bound only to host loopback may not be reachable;
  use a trusted container-reachable address instead.
- Pairing or policy-negotiation errors are Gateway/proxy configuration errors.
  A missing Session/Agent mutation, Todo, Activity, edit/regenerate, steering,
  artifact, voice, creator, or handoff control is an explicit capability limit.
- Confirm Session records include matching `threadId` and `agentId` values.
- Confirm a newly created Session reports the Agent that was requested.
- Check browser CORS errors for both the run and workspace origins.
- Ensure history responses contain valid message data and resumable state when advertised.

## A capability is missing

Check the [runtime capability matrix](runtime-capabilities.md). AOS shows only capabilities supported by the active adapter and provider. Fixture mode intentionally omits Agent creation; OpenCode and OpenClaw catalogs are read-only; generic AG-UI lacks shared Todos and Agent creation.

## Browser notifications do not appear

1. Enable notifications in Activity settings.
2. Grant browser permission and check operating-system notification settings or Do Not Disturb.
3. Keep at least one AOS tab loaded.
4. Test from another Session, a hidden tab, or an unfocused browser window. The exact visible and focused Session suppresses its own alert.

Denied or unsupported permission does not disable Activity. Multiple tabs elect one delivery tab, so only one operating-system notification is expected.

## Microphone or read-aloud is unavailable

Voice requires Hermes plus the relevant native STT/TTS configuration. Microphone capture also requires HTTPS or `localhost`, browser support, and permission. Follow [Chat voice](chat-voice.md) for mode-specific checks and safety limits.

## A published Artifact cannot load

- Confirm the active conversation branch contains an explicit `present_artifact` result or a successful trusted provider-native delivery receipt, such as Hermes text-to-speech.
- For Hermes media, confirm the tool result's `file_path` or `file_paths` entry exactly matches its `MEDIA:` delivery tag. AOS rejects unmatched assistant-authored paths.
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
