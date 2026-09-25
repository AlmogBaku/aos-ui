# Run OpenCode behind the AOS proxy

The browser connects only to the normalized AOS proxy (`AOS_UI_RUNTIME_MODE=aos`). The proxy attaches to one separately operated OpenCode server, keeps its Basic-auth credentials private, and scopes every Session operation to the configured absolute OpenCode directory. It is not a browser-direct OpenCode integration.

## Prerequisites

- Bun and an OpenCode installation authenticated with the model providers you intend to use
- An absolute external worktree for OpenCode to operate in
- Private, owner-only files for the OpenCode server password and the proxy signing keys

The worktree is native runtime state. Do not point OpenCode at the AOS checkout unless that is deliberately the Agent's working directory. AOS neither installs OpenCode nor owns its provider credentials.

## Attach a locally operated server

Start OpenCode independently, with server authentication enabled, then create a private proxy configuration from [`deploy/proxy.opencode.example.yaml`](../../deploy/proxy.opencode.example.yaml). Set its `runtime.baseUrl` to the server address reachable by the proxy, `runtime.directory` to the exact absolute worktree, `runtime.username` to the OpenCode server username, and `runtime.passwordFile` to the matching private password file.

```bash
# Terminal 1: OpenCode owns this process and its provider credentials.
cd /absolute/path/to/external-worktree
OPENCODE_SERVER_USERNAME=aos-ui \
OPENCODE_SERVER_PASSWORD='replace-with-a-private-secret' \
  opencode serve --hostname 127.0.0.1 --port 4096

# Terminal 2: the browser talks only to this proxy.
bun run proxy:serve -- --config /absolute/private/path/proxy.opencode.yaml
```

For Vite development, point the browser at that normalized proxy:

```bash
AOS_UI_RUNTIME_MODE=aos \
AOS_UI_PROXY_TARGET=http://127.0.0.1:4100 \
  bun run dev
```

Never put the server password, provider credentials, directory, or native URL in `/runtime-config.json`, `VITE_*`, or browser configuration.

## Compose composition

The optional overlay starts OpenCode alongside the proxy. The native port is internal to Compose; it is not published to the browser.

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.opencode.json \
AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy.opencode.yaml \
AOS_UI_OPENCODE_PASSWORD_FILE=/absolute/private/path/opencode-password \
AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  docker compose -f compose.yaml -f compose.opencode.yaml up --build
```

The overlay also points the launcher at the base stack's `tools-mcp` service (`AOS_UI_TOOLS_MCP_URL=http://tools-mcp:4110/mcp`) and starts OpenCode only after that service is healthy.

The example proxy configuration uses `http://opencode:4096` and `/workspace`, which are correct only inside this Compose composition. On Linux, set `AOS_UI_HOST_UID` and `AOS_UI_HOST_GID` when the defaults do not match the worktree owner.

## Native model configuration and AOS UI tools

The installation prompt, [`shared/install/PROMPT.md`](../../shared/install/PROMPT.md),
lets an agent perform the steps below; its [OpenCode reference](../../shared/install/reference/harness-opencode.md)
holds the exact commands. The manual steps follow.

OpenCode owns provider/model configuration and credentials. AOS reads the
native model catalog and can select a model for an attached Session, but does
not choose a default model. Reasoning-effort selection is unavailable because
OpenCode reports no reasoning ladder.

`bun run opencode:serve` is an optional launcher. It adds the UI's tools MCP
server to the OpenCode config as `mcp["aos-ui"]`, a remote server at
`AOS_UI_TOOLS_MCP_URL` (default `http://127.0.0.1:4110/mcp`) enabled in every
Session. Start that server first:

```bash
bun run tools-mcp:serve
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  bun run opencode:serve
```

An independently launched OpenCode server registers the same entry in its own
`opencode.json`:

```json
{
  "mcp": {
    "aos-ui": {
      "type": "remote",
      "url": "http://127.0.0.1:4110/mcp",
      "enabled": true
    }
  }
}
```

OpenCode's v2 session engine, which AOS drives, does not expose MCP tools at the
pinned `1.18.29`. The `aos-ui` tools are therefore registered but not callable
through AOS on OpenCode until upstream exposes MCP tools to that engine. When
they are, the proxy canonicalizes their names like any other harness. Charts,
maps, and stats are [MCP App](#mcp-apps) views the proxy reads from the
registered URL itself, so that URL must reach the server from the proxy as
well as from OpenCode, and each view receives a text-only result.

`bun run opencode:serve` also writes the hidden `agent-builder` creator
definition, `.opencode/skills/aos-agent-creator/SKILL.md` with its
`reference/harness-opencode.md`, and `.opencode/skills/aos-invite-link/SKILL.md`
into the worktree, and refuses to start if they would conflict with existing
content or if the target port is already occupied. The creator may write only
a new `.opencode/agents/<id>.md` file. The OpenCode adapter does not yet report
it as the creator, so AOS does not offer **New Agent** on OpenCode.

The launcher accepts these environment variables:

| Variable                            | Default                     | Meaning                                         |
| ----------------------------------- | --------------------------- | ----------------------------------------------- |
| `AOS_UI_OPENCODE_HOST`              | `127.0.0.1`                 | Bind address for the OpenCode server.           |
| `AOS_UI_OPENCODE_PORT`              | `4096`                      | Port for the OpenCode server.                   |
| `AOS_UI_OPENCODE_CORS_ORIGINS`      | unset                       | Comma-separated allowed CORS origins.           |
| `AOS_UI_OPENCODE_PASSWORD_FILE`     | unset                       | Owner-only file containing the server password. |
| `AOS_UI_OPENCODE_WORKTREE`          | required                    | Absolute path to the OpenCode working tree.     |
| `AOS_UI_TOOLS_MCP_URL`              | `http://127.0.0.1:4110/mcp` | The `aos-ui` tools MCP server.                  |
| `AOS_UI_OPENAI_COMPATIBLE_BASE_URL` | unset                       | OpenAI-compatible provider base URL.            |
| `AOS_UI_OPENAI_COMPATIBLE_API_KEY`  | unset                       | OpenAI-compatible API key.                      |
| `AOS_UI_OPENAI_COMPATIBLE_MODEL_ID` | unset                       | OpenAI-compatible model identifier.             |

The three `AOS_UI_OPENAI_COMPATIBLE_*` variables are all-or-none.

Set `AOS_RUNTIME_PROXY_URL` for an Agent using `aos-invite-link` to the
configured operator proxy origin. The skill prefers the operator invitation
endpoint over the local CLI, so it needs network access but no signing key.

## MCP Apps

AOS renders an MCP server's App views as App cards ([MCP Apps](../mcp-apps.md)).
Register the App server as a remote entry in the OpenCode `mcp` config; AOS
itself needs no entry:

```json
{
  "mcp": {
    "NAME": {
      "type": "remote",
      "url": "https://apps.example.test/mcp",
      "enabled": true
    }
  }
}
```

OpenCode keeps no App views, so the proxy reads the server list from
`GET /config` and connects to each view's server with its own MCP client:

- It reaches only enabled remote servers without `headers` or OAuth. A local
  server, or one that needs credentials the proxy does not hold, shows the
  tool call's textual details.
- For a server that needs headers, give the proxy its own copy under
  `mcpApps.fallback.servers.NAME.headers` in the proxy configuration
  ([MCP Apps fallback](../configuration.md#mcp-apps-fallback)). Its URL must
  then be `https:` or loopback.
- When the proxy reaches a server at another address than OpenCode does, set
  `mcpApps.fallback.servers.NAME.url`; the proxy connects there instead.
- OpenCode stores only a tool's text output, so the view receives a text-only
  result; the tool is never called again to recover more.
- The tool shows as `mcp__NAME__TOOL`, matched against the configured server
  names even when a name contains `_`.

MCP tools are not callable from the v2 session engine at the pinned `1.18.29`
(see above), so Apps appear once upstream exposes them. This fallback is
temporary and goes away once OpenCode serves MCP Apps itself.

## Artifacts

A completed `present_artifact` receipt publishes an Artifact. The proxy reads
its bytes through OpenCode's `GET /file/content`, confined to the configured
project directory: a receipt path outside that directory reads as unavailable.
Only a receipt the Session still holds grants read access.

## Agent icons

OpenCode has no native Agent write, so every `_aos/agents/update` call returns
the `-32009 unsupported` error and `avatarEditable` is `false` for every Agent.

An operator may hand-write an `avatar: ring/blue` key in the Agent file's
frontmatter. The proxy reads it from `request.body.avatar` and treats it as
the Agent's icon. Be aware of two effects:

- OpenCode forwards `request.body` to the model provider on every request, so
  the `avatar` key travels to the LLM API.
- An unknown frontmatter key causes OpenCode to load that Agent file with its
  legacy parser, which may change other frontmatter handling.

Agents without a stored icon receive a generated icon derived from their
position in the id-sorted roster. If the roster changes, the icon assignments
can shift. A stable icon requires writing the frontmatter key.

Session `createdAt` comes from `time.created`.

A follow-up ticket (ALM-16) will adopt `experimental.fs.write` once a released
OpenCode ships it, enabling the proxy to store icons without frontmatter.

## Capability limits

- AOS reads the native Agent catalog and creates Sessions, but Agent visibility, Agent icon writes, Session titles, deletion, Todos, Activity, and context accounting are unavailable when OpenCode has no exact matching operation. Voice becomes available when the proxy `voice` block is configured; see [Use voice](../chat-voice.md).
- Runs support streaming, reconnect, Stop, attachments, questions, and permissions. Edit/regenerate and active-turn steering are unavailable.
- An invitation can resolve only an existing OpenCode Session titled `aos-invite:<ref>`. OpenCode cannot create that reserved Session safely because its pinned API exposes neither title-bearing creation nor title mutation; a new invitation therefore cannot create a Session on first Send.
- AOS never restarts OpenCode automatically. Restart it under operator control after changing its configuration, once active work has finished.

## Verify

```bash
bunx vitest run test/opencode scripts/opencode packages/proxy/adapters/opencode packages/tools-mcp
```

Native live acceptance has not been run. It requires approved disposable Agents and real model credentials; mocked tests do not prove a live OpenCode journey.

For connection problems, see [Troubleshooting](../troubleshooting.md).
