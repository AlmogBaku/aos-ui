# Run AOS with Hermes

AOS connects to an independently operated `hermes serve` HTTP/WebSocket API
through the TypeScript proxy. Hermes owns profiles, Sessions, runs, tools,
credentials, and durable history. The browser sees only normalized AOS and
AG-UI data.

## Prerequisites

- An authenticated Hermes server reachable from the proxy
- A Hermes server token in a private, owner-readable file
- A 32-byte base64url reconnect-cursor key in another private file
- Bun, or Docker with Compose
- `uv` only when building or testing the optional native plugin

The adapter is tested against Hermes checkout
`b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b`; its required RPC surface was also
verified in unmodified Hermes `v2026.9.7`.

## Start Hermes independently

Install and configure Hermes outside the AOS checkout, then start its native
server:

```bash
hermes serve
```

The example proxy configuration expects Hermes at
`http://host.docker.internal:9119`. Keep native profile state and credentials
outside AOS.

## Create private configuration

Copy the example outside the checkout:

```bash
cp deploy/proxy-config.hermes.example.json /absolute/private/path/proxy-config.json
chmod 600 /absolute/private/path/proxy-config.json
```

Set these fields in the private copy:

- `listen` and `publicOrigin` for the trusted operator listener;
- `runtime.baseUrl` and `runtime.tokenFile` for the one selected Hermes runtime;
- `events.keys` for sealed reconnect cursors;
- optionally, a distinct `guest.listen`, `guest.publicOrigin`, and invitation
  signing key.

The operator listener has no application login. Anyone who can reach it can
operate every visible Agent and Session, so bind it to loopback or a trusted
private network. State-changing browser requests must still use the exact
configured origin.

Secret files must be regular, non-symlinked, owner-only files. Generate each
32-byte base64url key with:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Write the Hermes token exactly as supplied by Hermes, with at most one trailing
newline. Never put it in `/runtime-config.json`, an environment variable, or a
browser-facing URL.

## Run locally

For a Vite development server on port `3000`, configure the private proxy to
listen on `127.0.0.1:4100` with `publicOrigin` set to
`http://localhost:3000`. Then run:

```bash
# Terminal 1
bun run proxy:serve -- --config /absolute/private/path/proxy-config.json

# Terminal 2
AOS_UI_RUNTIME_MODE=aos \
AOS_UI_PROXY_TARGET=http://127.0.0.1:4100 \
  bun run dev
```

Open <http://localhost:3000>. Vite forwards only normalized AOS traffic to the
proxy; the browser never receives the Hermes URL or token.

## Run with Compose

The Hermes overlay runs the Bun proxy as both the static server and normalized
API. Hermes itself remains outside the stack:

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.hermes.json \
AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy-config.json \
AOS_UI_HERMES_TOKEN_FILE=/absolute/private/path/hermes-token \
AOS_UI_RECONNECT_CURSOR_KEY_FILE=/absolute/private/path/reconnect-cursor-key \
AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.hermes.yaml up --build
```

The example config enables the optional guest listener on port `3001`; remove
its `guest` block and the corresponding secret mount if the deployment does not
offer guest access. Both listeners use the same Hermes token and runtime
instance. Nginx is optional external TLS or access-control infrastructure.

The browser talks only to same-origin `/api/aos/v1`; guests use the separate
`/api/guest/v1` listener. The proxy never exposes Hermes' native `/auth`,
`/api`, or WebSocket routes.

Create a guest invitation locally from the configured signing key:

```bash
AOS_RUNTIME_PROXY_CONFIG=/absolute/private/path/proxy-config.json \
  bun run gateway -- invite --agent default
```

The installed `aos-invite-link` skill uses `curl` against the operator proxy's
`/api/aos/v1/guest-invitations` endpoint. Set `AOS_RUNTIME_PROXY_URL` to a
reachable configured operator origin in the Hermes environment. This works
for native and containerized Hermes without exposing the invitation signing
key.

The command prints a link, defaults to 72 hours, and generates a stable
conversation reference. Add `--ref`, `--instruction`, `--prefill`, `--title`,
`--message`, `--lang`, or `--expires-in` only when needed. Creating or opening
the link does not contact Hermes or create a Session; the first guest Send
atomically reuses or creates `aos-invite:<reference>`.

Before issuing a link, follow the [invited-chat guide](../invite-chat.md) to
prepare a dedicated, narrowly skilled Hermes profile and restrict its native
tools, filesystem, network, credentials, and approval behavior for the guest
workflow.

Hermes owns native recovery policy, including auto-continue. AOS reattaches
without submitting a new prompt. Disconnecting a browser does not stop work.
After a terminal Session has no subscribers or pending interaction, the proxy
keeps it warm for five minutes and then closes only that Session attachment.
The shared Hermes socket stays open.

## Optionally install the AOS native plugin

Basic attachment uses Hermes's native APIs. The AOS plugin adds presentation tools, Session handoff, creator guidance, and the invited-chat skill. Install it from an immutable AOS commit into each profile that needs those additions:

```bash
hermes -p PROFILE plugins install OWNER/REPOSITORY/integrations/hermes \
  --ref FULL_40_CHARACTER_COMMIT_SHA --no-enable
hermes -p PROFILE plugins doctor aos-integration --ci
hermes -p PROFILE plugins enable aos-integration
hermes -p PROFILE tools enable --platform api_server aos-presentation aos-session-handoff
hermes -p PROFILE tools enable --platform cli aos-presentation aos-session-handoff
```

Use `file:///absolute/path/to/aos-ui#integrations/hermes` instead of the repository source for a committed local checkout. The package-level [Hermes integration README](../../integrations/hermes/README.md) documents the exact native tools and creator provisioning. Installing the plugin extends Hermes; it does not move runtime ownership into AOS.

For upgrades, install from a new full committed SHA, run `plugins doctor`,
enable the required tools, then restart Hermes. Do not patch
an installed plugin cache to carry local or uncommitted AOS changes; commit and
reinstall from an immutable ref instead.

## Creator profile

Agent creation begins in a dedicated native creator profile. Mark that profile in `profile.yaml`:

```yaml
ui_meta:
  aos:
    role: creator
  hermes-bots:
    hidden: true
```

The integration reads this metadata; it does not grant creator authority itself. Automated creation currently fails closed because the verified Hermes versions do not provide an atomic no-overwrite profile-create operation. The interview remains available, but no native profile is written.

## Operational behavior

- Native profiles form the AOS Agent catalog and can expose visibility changes.
- Native CLI or cron Sessions may appear in AOS even when the browser did not create them.
- Activity coverage is limited to the active Session.
- AG-UI starts or resumes a run and carries its server-to-browser event stream.
  Stop and steering are separate normalized AOS REST controls on that existing
  run; neither submits a second AG-UI run.
- Stop uses native `session.interrupt`.
- Text-only active-turn steering uses native `session.redirect`. Hermes may
  report the correction as immediately redirected or accepted into its native
  build-window queue; both outcomes mean AOS must not submit another copy.
- A steering redirect seals the current assistant generation, preserves
  completed tool results, presents the visible correction at that boundary,
  and continues under the same logical AOS run until Hermes is authoritatively
  idle.
- Questions, approvals, attachments, edit/regenerate, Artifacts, and Todos are projected from native Hermes interfaces when present.
- Voice controls appear only for native STT/TTS interfaces; see [Chat voice](../chat-voice.md).

## Verify

```bash
bun run integrations:build
bun run hermes:test
```

Live acceptance requires an approved profile, disposable Session, and real credentials. If authentication, WebSocket attachment, or profile discovery fails, see [Troubleshooting](../troubleshooting.md).
