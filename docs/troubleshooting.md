# Troubleshoot AOS

Start with the symptom you see. AOS fails closed when runtime configuration or provider data cannot be trusted, so an unavailable control is often an intentional capability boundary rather than a hidden fallback.

## The runtime is unavailable

1. Open `/runtime-config.json` in the same browser origin.
2. Confirm it is valid JSON and uses exactly one shape from the [configuration reference](configuration.md).
3. Remove unknown fields and credentials.
4. For OpenCode, confirm `directory` is an absolute path understood by the server.
5. For generic AG-UI, confirm both `runUrl` and `workspaceUrl` are present absolute HTTP(S) URLs.
6. For OpenClaw, confirm `baseUrl` is a credential-free `ws://`/`wss://` URL or `/openclaw` proxy path; enter pairing credentials only in the connection UI.

If Vite is using environment-derived configuration, restart it after changing variables. AOS never substitutes fixture data for an invalid real-runtime configuration.

## AOS cannot reach OpenCode

- Confirm the independently operated OpenCode server is running and that `/global/health` responds at its configured origin.
- Confirm `AOS_UI_OPENCODE_BASE_URL` is reachable by the browser and matches the server's host and port.
- Configure OpenCode CORS for the exact AOS browser origin.
- Confirm `AOS_UI_OPENCODE_WORKTREE` exists and is the absolute directory understood by that server.
- Set both `AOS_UI_OPENCODE_PROVIDER_ID` and `AOS_UI_OPENCODE_MODEL_ID`, or leave both unset.

If you deliberately use the optional AOS launcher, run `bun run integrations:build` before `bun run opencode:serve`, check whether `127.0.0.1:4096` is already occupied, and set all three `AOS_UI_OPENAI_COMPATIBLE_*` values together when using that convenience provider. For the optional bundled Compose overlay, also verify host UID/GID access to the worktree and credential files.

## A new OpenCode Agent is not ready

OpenCode `1.18.29` caches Agent definitions. Wait for active runs to finish, restart the native harness, then refresh the catalog. AOS does not automatically dispose a shared OpenCode instance because doing so can abort unrelated runs.

## Hermes asks you to sign in

Use the **Sign in to Hermes** action, complete native authentication in the new tab, then reload AOS. The browser relies on Hermes cookies and single-use WebSocket tickets; credentials never belong in public runtime configuration.

The production Hermes deployment does not mount Hermes at a browser path.
Authentication must use the normalized proxy routes under
`/api/aos/v1/auth`; `/hermes` and native `/auth` routes should return `404`.

## Hermes HTTP works but live updates fail

- Confirm Nginx forwards WebSocket upgrades on `/api/aos/v1/events` and keeps
  buffering disabled for `/api/aos/v1`.
- Confirm operator session cookies apply to the public origin.
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

## OpenClaw does not connect

- Verify protocol v4 is enabled and the Gateway is reachable at the configured WebSocket URL.
- Grant the browser device `operator.read` and `operator.write`, plus `operator.questions` and `operator.approvals` for those controls.
- With Compose, use `compose.openclaw.yaml` and check `AOS_UI_OPENCLAW_HOST`/`AOS_UI_OPENCLAW_PORT`; never put a token in `runtime-config.json`.
- For invited chat, set `AOS_GATEWAY_OPENCLAW_DEVICE_FILE` to an absolute writable persistent path. The file must be a regular `0600` file, not a symlink. If first start reports `PAIRING_REQUIRED`, run `openclaw devices list`, approve the exact current request with `openclaw devices approve <requestId>`, and restart the guest gateway.
- If invited chat reports a missing scope, re-pair that device for exactly `operator.read`, `operator.write`, and `operator.questions`; do not delete or replace a working device file merely to bypass approval.
- A missing Todo, visibility, edit/regenerate, creator, handoff, or STT control is an explicit capability limit, not a connection failure.
- Confirm Session records include matching `threadId` and `agentId` values.
- Confirm a newly created Session reports the Agent that was requested.
- Check browser CORS errors for both the run and workspace origins.
- Ensure history responses contain valid message data and resumable state when advertised.

## A capability is missing

Check the [runtime capability matrix](runtime-capabilities.md). AOS shows only capabilities supported by the active adapter and provider. Fixture mode intentionally omits Agent creation; OpenCode visibility is read-only; generic AG-UI lacks shared Todos and Agent creation.

## Browser notifications do not appear

1. Enable notifications in Activity settings.
2. Grant browser permission and check operating-system notification settings or Do Not Disturb.
3. Keep at least one AOS tab loaded.
4. Test from another Session, a hidden tab, or an unfocused browser window. The exact visible and focused Session suppresses its own alert.

Denied or unsupported permission does not disable Activity. Multiple tabs elect one delivery tab, so only one operating-system notification is expected.

## Microphone or read-aloud is unavailable

Voice requires Hermes plus the relevant native STT/TTS configuration. Microphone capture also requires HTTPS or `localhost`, browser support, and permission. Follow [Chat voice](chat-voice.md) for mode-specific checks and safety limits.

## A published Artifact cannot load

- Confirm the active conversation branch contains an explicit `present_artifact` result.
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
