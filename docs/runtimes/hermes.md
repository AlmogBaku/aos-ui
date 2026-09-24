# Run AOS with Hermes

AOS connects to an independently operated `hermes serve` HTTP/WebSocket API
through the TypeScript proxy. Hermes owns profiles, Sessions, runs, tools,
credentials, and durable history. The browser connects over ACP v2 WebSocket at `/api/aos/v1/acp`.

## Prerequisites

- An authenticated Hermes server reachable from the proxy
- A Hermes server token in a private, owner-readable file
- Bun, or Docker with Compose

The minimum supported Hermes revision is
`47685348eaca9d673719003b9e03a71becfa6423`; the vendored gateway client and the
interactions protocol both require the server-to-client request behavior present
at that pin. The separately tested compatibility revision is
`b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b` (`v2026.9.7`).

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
cp deploy/proxy.hermes.example.yaml /absolute/private/path/proxy.yaml
chmod 600 /absolute/private/path/proxy.yaml
```

The proxy accepts the file when it is owned by the user running it at mode 0600
or 0640, or owned by root at mode 0644; it refuses any group- or world-writable
mode.

Set these fields in the private copy:

- `listen` and `publicOrigin` for the trusted operator listener;
- `runtime.baseUrl` and `runtime.tokenFile` for the one selected Hermes runtime;
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
bun run proxy:serve -- --config /absolute/private/path/proxy.yaml

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
AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy.yaml \
AOS_UI_HERMES_TOKEN_FILE=/absolute/private/path/hermes-token \
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
bun run gateway -- invite --config /absolute/private/path/proxy.yaml --agent default
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

## Register the AOS UI tools

The installation prompt, [`shared/install/PROMPT.md`](../../shared/install/PROMPT.md),
lets an agent perform the steps below; its [Hermes reference](../../shared/install/reference/harness-hermes.md)
holds the exact commands. The manual steps follow.

AOS UI ships its own stateless MCP server, `packages/tools-mcp`, separate from
the proxy. It offers four tools: `render_chart`, `render_map`, `render_stats`,
and `present_artifact({path, title?, mimeType?})`, where `path` is an absolute
path. The first three are [MCP Apps](../mcp-apps.md) whose views draw the
chart, map, or stats in the message; `present_artifact` has no view. Each
tool's description carries its usage guidance; there is no AOS system prompt
to install.

Run it on the Hermes host, bound to loopback:

```bash
bun run tools-mcp:serve                     # http://127.0.0.1:4110/mcp
bun run tools-mcp:serve -- --port 4111      # another port
```

The Compose stack runs the same server as the `tools-mcp` service, published
on `127.0.0.1:${AOS_UI_TOOLS_MCP_PORT:-4110}`. It serves `/mcp` (Streamable
HTTP) and `/health`, has no authentication, and never reads files itself:
`present_artifact` only returns a receipt, and the proxy later reads the file
through Hermes.

Register it in each profile that should use the tools. Hermes reads
`mcp_servers` from the profile's own `config.yaml`
(`~/.hermes/profiles/PROFILE/config.yaml`, or `~/.hermes/config.yaml` for the
default profile):

```yaml
mcp_servers:
  aos-ui:
    url: http://127.0.0.1:4110/mcp
```

`hermes -p PROFILE mcp add aos-ui --url http://127.0.0.1:4110/mcp` writes the
same entry interactively after probing the server; answer that it needs no
authentication. Check the connection with `hermes -p PROFILE mcp test aos-ui`.

The tools reach the model as `mcp__aos_ui__render_chart` and so on; the proxy
canonicalizes those names, so the browser renders them as AOS tools. Hermes
keeps no App views, so the proxy reads the chart, map, and stats views from
the URL the profile registers ([MCP Apps](#mcp-apps)). A proxy in a container
does not share the host's loopback, so it overrides that URL with its own
address for the server under `mcpApps.fallback.servers.aos-ui.url`
([MCP Apps fallback](../configuration.md#mcp-apps-fallback)); the Compose
example, [`deploy/proxy.hermes.example.yaml`](../../deploy/proxy.hermes.example.yaml),
sets `http://tools-mcp:4110/mcp`. The
server loads on every platform the profile serves, messaging channels such as
Telegram included.

A running `hermes serve` connects a newly added server within about a minute
and refreshes a Session's tool list between turns, so no restart is needed.
When `aos-ui` is the profile's first MCP server, run `/reload-mcp` in the
Session, or start a new Session, to pick the tools up.

### Skills

AOS UI's skills are plain Hermes skills: `shared/invite-link` (the
`aos-invite-link` skill) and `shared/agent-creator` (the `aos-agent-creator`
skill). Either copy a skill's directory into the profile's `skills/` directory,
or list a directory that holds them; Hermes finds every `SKILL.md` below each
listed directory:

```yaml
skills:
  external_dirs:
    - /absolute/path/to/aos-ui/shared
```

External directories are read-only and lose a name collision to the profile's
own skills. Hermes caches the skills index of a running server, so restart
`hermes serve` after adding a skill.

## MCP Apps

Any MCP server whose tool declares an App view renders as an App card in AOS
([MCP Apps](../mcp-apps.md)). Register the server in the profile like any other
MCP server; AOS itself needs no entry:

```bash
hermes -p PROFILE config set mcp_servers.NAME.url https://apps.example.test/mcp
hermes -p PROFILE mcp test NAME
```

Hermes drops a tool's `_meta.ui` and has no API to read an MCP resource, so the
proxy reads the view itself. It lists the profile's servers through
`GET /api/mcp/servers?profile=PROFILE` and connects to their URLs with its own
MCP client:

- It reaches only enabled Streamable HTTP servers. A stdio server, or one that
  needs credentials the proxy does not hold, shows the tool call's textual
  details instead.
- For a server that needs headers, give the proxy its own copy under
  `mcpApps.fallback.servers.NAME.headers` in the proxy configuration
  ([MCP Apps fallback](../configuration.md#mcp-apps-fallback)). Its URL must
  then be `https:` or loopback.
- When the proxy reaches a server at another address than Hermes does, set
  `mcpApps.fallback.servers.NAME.url`; the proxy connects there instead of the
  URL the profile registers.
- The tool shows as `mcp__NAME__TOOL` with the server's original name, even
  where Hermes sanitizes or shortens it.
- The server list is cached for about 5 minutes; a tool from a server added
  since is picked up within 30 seconds.

This fallback is temporary and goes away once Hermes serves MCP Apps itself.

## Sessions and Artifacts

Sessions the proxy creates carry `source: "aos-ui"`. An Artifact is published
either by a `present_artifact` receipt or by an assistant `MEDIA:/absolute/path`
line, Hermes's own delivery convention. The proxy removes each `MEDIA:` line
from the prose, validates the path, and reads the bytes through
`GET /api/fs/read-data-url`. A path that is relative, traverses, or names a
credential file such as `.env` or `auth.json` is refused.

## Creator profile

The creator behind **New Agent** is an ordinary profile, conventionally
`aos-agent-creator`, that loads the `aos-agent-creator` skill. Its marker lives
in its `profile.yaml`, and no `hermes` command sets it; the proxy keeps the
marked profile out of the Agent roster and management surfaces:

```yaml
ui_meta:
  aos:
    role: creator
  hermes-bots:
    hidden: true
```

The marker grants no authority. After the user confirms a definition, the
creator writes the new profile with `hermes profile create` and the other
steps in the skill's `reference/harness-hermes.md`, so it needs Hermes's
terminal tool. AOS shows the new Agent once Hermes lists it, and the draft
**New Agent** row resolves into it. A freshly provisioned profile has no
credentials for its model: Hermes copies a new profile's model block but not
its credential pool, so sign it in with `hermes -p <name> auth add`. Never copy
another profile's tokens into it.

## Agent icons

Each Agent's icon is an opaque `silhouette/tone` token stored in
`ui_meta.aos.avatar` of the profile. A stored value that does not match
`/^[a-z0-9-]{1,32}\/[a-z0-9-]{1,32}$/` reads as no icon.

The Agent revision used for the compare-and-set is composite:
`hermes-bots:N,aos:M`, where `N` and `M` are the per-namespace CAS counters
that `profiles.list` returns in `ui_meta_revisions`.

`_aos/agents/update` writes the avatar (and optionally visibility) with one
`profiles.configure` call. That call sends only the `ui_meta` namespaces the
patch touches, each paired with its current `ui_meta_expected_revisions` entry,
so unrelated `aos` keys such as `role` survive intact. Passing `null` for the
avatar removes the key.

`avatarEditable` equals `editable` for every profile. The creator profile is
never writable.

Session `createdAt` comes from the Session row's `started_at` (epoch seconds).

### Before deploying Agent icons

The first time the workspace opens after the proxy is upgraded, AOS writes an
icon into every visible, editable Agent. Back up the affected files first.

1. Create a timestamped, owner-only backup directory:

   ```bash
   sudo install -d -m 700 /etc/aos-ui/backups/agent-icons-$(date +%Y%m%d)
   ```

2. Copy every profile's `profile.yaml`, preserving its mode. The default
   profile keeps its file in the Hermes home itself, not under `profiles/`:

   ```bash
   backup=/etc/aos-ui/backups/agent-icons-$(date +%Y%m%d)
   sudo cp -p ~/.hermes/profile.yaml "$backup/default.profile.yaml"
   for f in ~/.hermes/profiles/*/profile.yaml; do
     sudo cp -p "$f" "$backup/$(basename "$(dirname "$f")").profile.yaml"
   done
   ```

   Use the Hermes home in place of `~/.hermes` when it is not the default.

3. After the backup, deploy the updated proxy. The next workspace open writes
   icons.

To restore: roll the proxy back **first**, then restore the files — otherwise
the next workspace open saves icons again.

## Operational behavior

- Native profiles form the AOS Agent catalog and can expose Agent updates (visibility and avatar).
- Native CLI or cron Sessions may appear in AOS even when the browser did not create them.
- Activity is workspace-wide: the feed covers every Session the connection may observe.
- ACP v2 starts or resumes a run and carries its server-to-browser event stream.
  Stop (`session/cancel`) and steering (`_aos/session/steer`) travel over the
  same ACP socket; neither creates another run.
- Stop uses native `session.interrupt`.
- Text-only active-turn steering uses native `session.redirect`. Hermes may
  report the correction as immediately redirected or accepted into its native
  build-window queue; both outcomes mean AOS must not submit another copy.
- A steering redirect seals the current assistant generation, preserves
  completed tool results, presents the visible correction at that boundary,
  and continues under the same logical AOS run until Hermes is authoritatively
  idle.
- Questions, approvals, attachments, edit/regenerate, Artifacts, and Todos are projected from native Hermes interfaces when present. The `aos-ui` tools appear only in profiles that register the MCP server.
- Session rename, archive, delete, and provider-owned read state (`unread` catalog row; PATCH `{unread:false}`) are available. `runtime.sessionIdleMs` controls how long the proxy keeps a warm Session attachment after the last subscriber disconnects before closing only that Session.
- Voice controls appear for native STT/TTS interfaces and when the proxy `voice` block is configured; see [Use voice](../chat-voice.md).
- The proxy authenticates the `/api/ws` WebSocket with `?token=` in the URL.
  This is upstream Hermes behavior; Hermes accepts the token query parameter
  only on loopback or when started with `--insecure`; do not expose a
  `--insecure` Hermes instance beyond a trusted private network.
  The close code Hermes sends on token rejection (documented as 4401 or 4403)
  is unverified; treat an immediate WebSocket close after dial as a possible
  authentication failure and check the Hermes server log.
- Hermes refusals keep Hermes' own words as the failure's second line. A
  Session another Hermes window owns fails with `AOS_SESSION_IN_USE`; Hermes'
  active-Session limit fails with `AOS_SESSION_LIMIT`; a turn still running
  fails with `AOS_SESSION_BUSY`. A reattach Hermes fences while it settles a
  disconnect, and an unreadable ownership registry, are retried for a few
  seconds without a visible error, then fail with `AOS_PROVIDER_UNAVAILABLE`.
  A question Hermes no longer holds open fails with `AOS_INTERACTION_EXPIRED`.
- A Session AOS finds `waiting` whose open request Hermes does not re-deliver
  within about two seconds, while nothing else changes, reports
  `AOS_INTERACTION_LOST`. The turn stays running so Stop remains available;
  Stop interrupts it natively and the Session then accepts a new prompt.
- A Hermes restart resets every active run once: the next attach produces
  `AOS_RESET_REQUIRED`, which clears the in-progress indicator and reloads
  history from the Hermes transcript. No prompt is re-sent.

## Native routes the proxy calls

When placing an egress allowlist between the proxy and Hermes, allow these
Hermes-native routes from the proxy host:

- `GET /api/sessions` — session list
- `GET /api/sessions/:id`, `PATCH /api/sessions/:id`, `DELETE /api/sessions/:id` — session detail and mutations
- `GET /api/sessions/:id/messages` — message history
- `GET /api/fs/read-data-url` — artifact byte reads
- `GET /api/mcp/servers?profile=` — MCP server list for tool names and MCP Apps
- `GET /api/tools/toolsets/{stt,tts}/config` — audio configuration
- `POST /api/audio/transcribe`, `POST /api/audio/speak` — transcription and speech
- `GET /api/ws` (WebSocket upgrade) — gateway connection for profiles, runs, questions, and events

## Live operator checks

These checks require a disposable Session and real credentials. Run them
against a new pin or before confirming a deployment.

- **Network cut 5 s mid-turn**: sever the proxy-to-Hermes connection for 5
  seconds while a long run is in progress, then restore it. The browser should
  show no error; the run should resume and complete normally. The
  `AOS_CONNECTION_INTERRUPTED` event should not reach the browser.
- **Network cut 30 s mid-turn**: sever for 30 seconds (beyond the 20 s heal
  grace). The adapter should produce one `AOS_RESET_REQUIRED` and reload
  history. No prompt should be re-sent.
- **Hermes restart mid-turn**: stop and restart `hermes serve` while a run is
  active. The adapter should attach to the restarted instance and emit
  `AOS_RESET_REQUIRED` exactly once. The run indicator should clear; history
  should reload.
- **Clarify and approval with mid-question reload**: start a Session that asks
  a question or approval. Reload the browser tab mid-question. The interrupt
  should reconstruct from history. Answer the question; the run should
  continue.
- **Invalid token**: set a wrong token in the config and start the proxy.
  Connection should fail immediately with a recognizable authentication error
  in the server log. No token value should appear in any browser-facing
  response.
- **Confirm close code on auth rejection**: observe the actual WebSocket close
  code Hermes sends for a bad token (expected 4401 or 4403, but unverified at
  the pinned revision). Record the observed code here once confirmed.

## Verify

```bash
bunx vitest run packages/tools-mcp packages/proxy/adapters/hermes
curl --fail --silent http://127.0.0.1:4110/health
hermes -p PROFILE mcp test aos-ui
```

Live acceptance requires an approved profile, disposable Session, and real credentials. If authentication, WebSocket attachment, or profile discovery fails, see [Troubleshooting](../troubleshooting.md).
