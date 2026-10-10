# Run AOS with Hermes

AOS reaches an independently operated `hermes serve` HTTP/WebSocket API
through the [harness-gw](https://github.com/AlmogBaku/harness-gw) gateway.
Hermes owns profiles, Sessions, runs, tools, credentials, and durable history.
The browser connects to the gateway over ACP v2 WebSocket at `/api/v1/acp` on
its own origin; it never sees the Hermes URL or token.

This page covers what an AOS operator does: run the stack, register the AOS UI
tools and skills, and set up the creator. The gateway's Hermes adapter, its
configuration fields, native routes, recovery rules, and live operator checks
are documented in harness-gw's
[`docs/runtimes/hermes.md`](https://github.com/AlmogBaku/harness-gw/blob/main/docs/runtimes/hermes.md).

## Prerequisites

- An authenticated Hermes server reachable from the gateway
- A Hermes server token in a private, owner-readable file
- Bun, or Docker with Compose

The minimum supported Hermes revision is `v2026.9.24`.

## Start Hermes independently

Install and configure Hermes outside the AOS checkout, then start its native
server:

```bash
hermes serve
```

The example gateway configuration expects Hermes at
`http://host.docker.internal:9119`. Keep native profile state and credentials
outside AOS.

## Create private configuration

Copy harness-gw's
[`examples/config.hermes.example.yaml`](https://github.com/AlmogBaku/harness-gw/blob/main/examples/config.hermes.example.yaml)
outside both checkouts and keep it owner-only:

```bash
cp /absolute/path/to/harness-gw/examples/config.hermes.example.yaml \
  /absolute/private/path/harness-gw.yaml
chmod 600 /absolute/private/path/harness-gw.yaml
```

Set the operator `listen` and `publicOrigin`, `runtime.baseUrl` and
`runtime.tokenFile`, and, for guest access, a distinct `guest.listen`,
`guest.publicOrigin`, and invitation signing key. Each listener accepts
state-changing requests and socket upgrades only from its `allowedOrigins`,
which default to its `publicOrigin`, so set `publicOrigin` to the address the
browser uses. File ownership, modes, secret-file rules, and every field are in
harness-gw's Hermes guide and `README.md`.

The operator listener has no application login. Anyone who can reach it can
operate every visible Agent and Session, so keep it on loopback or a trusted
private network.

Write the Hermes token exactly as supplied by Hermes, with at most one trailing
newline. Never put it in `/runtime-config.json`, an environment variable, or a
browser-facing URL.

## Run locally

For a Vite development server on port `3000`, configure the gateway's operator
listener on `127.0.0.1:4100` with `publicOrigin` set to
`http://localhost:3000`. Then run:

```bash
# Terminal 1, in the harness-gw checkout
bun run serve --config /absolute/private/path/harness-gw.yaml

# Terminal 2, in the aos-ui checkout
AOS_UI_RUNTIME_MODE=aos \
AOS_UI_GATEWAY_TARGET=http://127.0.0.1:4100 \
  bun run dev
```

Open <http://localhost:3000>. Vite forwards only `/api/v1` (HTTP and
WebSocket) to the gateway, which checks the browser's `Origin` against
`publicOrigin`; the browser never receives the Hermes URL or token.

## Run with Compose

The Hermes overlay adds the gateway (`${HARNESS_GW_IMAGE:-ghcr.io/almogbaku/harness-gw:0.1.3@sha256:a01d8da1a34fd6e6769ad89829d23c30f43cc22fb9fa3f46911e5bfa934480f5}`)
and the guest lane to the base stack. Hermes itself stays outside the stack:

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.hermes.json \
HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.yaml \
HARNESS_GW_HERMES_TOKEN_FILE=/absolute/private/path/hermes-token \
HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
  docker compose -f compose.yaml -f compose.hermes.yaml up --build
```

Caddy is the only published lane port: `127.0.0.1:3000` for the operator and
`127.0.0.1:3001` for guests. On each lane it sends `/api/v1` to the gateway's
listener (4100 operator, 4101 guest) and everything else to the AOS web
server. The example gateway config's `publicOrigin` values,
`http://127.0.0.1:3000` and `http://127.0.0.1:3001`, match those ports; change
them with the address the browser uses. A host whose exit-node routes capture
the Docker bridge subnets adds `-f deploy/compose.host.yaml` after the Hermes
overlay; see [Deployment](../deployment.md).

Both listeners use the same Hermes token and runtime instance. The gateway
never exposes Hermes' native `/auth`, `/api`, or WebSocket routes.

## Create a guest invitation

The installed `aos-invite-link` skill uses `curl` against the operator
gateway's `/api/v1/guest-invitations` endpoint. Set `AOS_GATEWAY_URL` to a
reachable operator origin in the Hermes environment. This works for native and
containerized Hermes without exposing the invitation signing key. From the
harness-gw checkout, an operator can also sign one locally:

```bash
bun run gateway invite --config /absolute/private/path/harness-gw.yaml --agent default
```

Before issuing a link, follow the [invited-chat guide](../invite-chat.md) to
prepare a dedicated, narrowly skilled Hermes profile and restrict its native
tools, filesystem, network, credentials, and approval behavior for the guest
workflow.

## Register the AOS UI tools

The installation prompt, [`shared/install/PROMPT.md`](../../shared/install/PROMPT.md),
lets an agent perform the steps below; its [Hermes reference](../../shared/install/reference/harness-hermes.md)
holds the exact commands. The manual steps follow.

AOS UI ships its own stateless MCP server, `packages/tools-mcp`, separate from
the gateway. It offers four tools: `render_chart`, `render_map`, `render_stats`,
and `present_artifact({path, title?, mimeType?})`, where `path` is an absolute
path. The first three are [MCP Apps](../mcp-apps.md) whose views draw the
chart, map, or stats in the message; `present_artifact` has an App view that
shows the file, which the gateway reads through Hermes. Each tool's description
carries its usage guidance; there is no AOS system prompt to install.

Run it on the Hermes host, bound to loopback:

```bash
bun run tools-mcp:serve                     # http://127.0.0.1:4110/mcp
bun run tools-mcp:serve -- --port 4111      # another port
```

The Compose stack runs the same server as the `tools-mcp` service, published
on `127.0.0.1:${AOS_UI_TOOLS_MCP_PORT:-4110}`. It serves `/mcp` (Streamable
HTTP) and `/health`, has no authentication, and never reads files itself.

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

The tools reach the model as `mcp__aos_ui__render_chart` and so on; the gateway
canonicalizes those names, so the browser renders them as AOS tools. Hermes
keeps no App views, so the gateway reads the views from the URL the profile
registers. A gateway in a container does not share the host's loopback, so the
example config overrides that URL under `mcpApps.fallback.servers.aos-ui.url`
with `http://tools-mcp:4110/mcp`; under `deploy/compose.host.yaml` the loopback
URL works as registered. The server loads on every platform the profile
serves, messaging channels such as Telegram included.

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

Hermes drops a tool's `_meta.ui`, so the gateway reads the view itself, and
reaches only enabled Streamable HTTP servers. A stdio server, or one that needs
credentials the gateway does not hold, shows the tool call's textual details
instead. Header and address overrides (`mcpApps.fallback`), caching, and how
`present_artifact` files are resolved through Hermes are in harness-gw's
Hermes guide.

## Sessions and Artifacts

Sessions AOS creates carry `source: "aos-ui"`. An assistant
`MEDIA:/absolute/path` line, Hermes's own delivery convention, becomes an
Artifact card: the line leaves the prose, and a path that is relative,
traverses, or names a credential file such as `.env` or `auth.json` is refused.
The gateway's `runtime.mediaArtifacts: false` turns this off, leaving the line
and its native path in the message text for every reader, guests included.
Images attached to a user message stay Artifacts either way.

## Creator profile

The creator behind **New Agent** is an ordinary profile, conventionally
`aos-agent-creator`, that loads the `aos-agent-creator` skill. Its marker lives
in its `profile.yaml`, and no `hermes` command sets it; the gateway keeps the
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
`ui_meta.aos.avatar` of the profile; a value that does not match
`/^[a-z0-9-]{1,32}\/[a-z0-9-]{1,32}$/` reads as no icon. Every editable profile
can change its icon; the creator profile never can. The first time the
workspace opens against a gateway that serves icons, it saves one for every
visible, editable Agent. The compare-and-set write is described in harness-gw's
Hermes guide.

## What AOS shows

- Native profiles form the Agent catalog; Agent visibility and icon can be
  changed from AOS.
- Native CLI or cron Sessions may appear in AOS even when the browser did not
  create them.
- Stop and steering travel over the same ACP socket as the run; neither
  creates another run. Stop interrupts natively; a steering correction appears
  at the point Hermes accepted it, and the run continues.
- Questions, approvals, attachments, edit/regenerate, Artifacts, and Todos are
  projected from native Hermes interfaces when present. The `aos-ui` tools
  appear only in profiles that register the MCP server.
- AOS needs `display.tool_progress` left at its default (`all`). With `off`,
  live tool calls are withheld and appear only after a reload.
  `display.show_reasoning` gates nothing AOS reads.
- Each served profile needs an existing `terminal.cwd` that is neither `.`,
  `auto`, `cwd`, nor a missing directory; AOS lists it as the Agent's folder. A
  named SSH profile needs an absolute remote `terminal.cwd` (`~/…` yields no
  folder), or AOS cannot list, start, or resume its Sessions. A resumed
  Session runs in the folder Hermes stored on its own row, which can differ.
- After Hermes compacts a conversation, carried-forward messages get new ids;
  an open tab keeps the old ones until the page reloads.
- Session rename, pin, archive, delete, and provider-owned read state are
  available.
- Voice controls appear for native STT/TTS interfaces and when the gateway
  `voice` block is configured; see [Use voice](../chat-voice.md).
- A Hermes restart resets every active run once: the in-progress indicator
  clears and history reloads from the Hermes transcript. No prompt is re-sent.
  Hermes refusals keep Hermes' own words as the failure's second line.

Disconnecting a browser does not stop work. Hermes owns native recovery,
including auto-continue, and the gateway reattaches without submitting a new
prompt.

## Verify

```bash
bunx vitest run packages/tools-mcp
curl --fail --silent http://127.0.0.1:4110/health
hermes -p PROFILE mcp test aos-ui
```

Live acceptance requires an approved profile, disposable Session, and real
credentials; harness-gw's Hermes guide lists the live operator checks. If
authentication, WebSocket attachment, or profile discovery fails, see
[Troubleshooting](../troubleshooting.md).
