# Run AOS with OpenCode

The browser connects only to the [harness-gw](https://github.com/AlmogBaku/harness-gw)
gateway (`AOS_UI_RUNTIME_MODE=aos`). The gateway attaches to one separately
operated OpenCode server, keeps its Basic-auth credentials private, and scopes
every Session operation to the configured absolute OpenCode directory. It is
not a browser-direct OpenCode integration.

This page covers running AOS against OpenCode, the optional launcher, and the
AOS UI tools. The gateway's OpenCode adapter (native routes, MCP App fallback,
icon reads) is documented in harness-gw's
[`docs/runtimes/opencode.md`](https://github.com/AlmogBaku/harness-gw/blob/main/docs/runtimes/opencode.md).

## Prerequisites

- Bun and an OpenCode installation authenticated with the model providers you intend to use
- An absolute external worktree for OpenCode to operate in
- Private, owner-only files for the OpenCode server password and the gateway signing keys

The worktree is native runtime state. Do not point OpenCode at the AOS checkout unless that is deliberately the Agent's working directory. AOS neither installs OpenCode nor owns its provider credentials.

## Attach a locally operated server

Start OpenCode independently, with server authentication enabled, then create a
private gateway configuration from harness-gw's
[`examples/config.opencode.example.yaml`](https://github.com/AlmogBaku/harness-gw/blob/main/examples/config.opencode.example.yaml).
Set its `runtime.baseUrl` to the server address reachable by the gateway,
`runtime.directory` to the exact absolute worktree, `runtime.username` to the
OpenCode server username, and `runtime.passwordFile` to the matching private
password file. For Vite on port `3000`, set the operator listener to
`127.0.0.1:4100` and `publicOrigin` to `http://localhost:3000`.

```bash
# Terminal 1: OpenCode owns this process and its provider credentials.
cd /absolute/path/to/external-worktree
OPENCODE_SERVER_USERNAME=aos-ui \
OPENCODE_SERVER_PASSWORD='replace-with-a-private-secret' \
  opencode serve --hostname 127.0.0.1 --port 4096

# Terminal 2, in the harness-gw checkout: the browser talks only to this gateway.
bun run serve --config /absolute/private/path/harness-gw.opencode.yaml

# Terminal 3, in the aos-ui checkout
AOS_UI_RUNTIME_MODE=aos \
AOS_UI_GATEWAY_TARGET=http://127.0.0.1:4100 \
  bun run dev
```

Never put the server password, provider credentials, directory, or native URL in `/runtime-config.json`, `VITE_*`, or browser configuration.

## Compose composition

The optional overlay starts OpenCode beside the gateway and opens the guest
lane. The native port is internal to Compose; it is not published to the
browser.

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.opencode.json \
HARNESS_GW_CONFIG_FILE=/absolute/private/path/harness-gw.opencode.yaml \
HARNESS_GW_OPENCODE_PASSWORD_FILE=/absolute/private/path/opencode-password \
HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  docker compose -f compose.yaml -f compose.opencode.yaml up --build
```

The overlay mounts the same password file into both the gateway and OpenCode,
points the launcher at the base stack's `tools-mcp` service
(`AOS_UI_TOOLS_MCP_URL=http://tools-mcp:4110/mcp`), and starts OpenCode only
after that service is healthy.

The example gateway configuration uses `http://opencode:4096` and `/workspace`,
which are correct only inside this Compose composition. On Linux, set
`AOS_UI_HOST_UID` and `AOS_UI_HOST_GID` when the defaults do not match the
worktree owner.

## Native model configuration and AOS UI tools

The installation prompt, [`shared/install/PROMPT.md`](../../shared/install/PROMPT.md),
lets an agent perform the steps below; its [OpenCode reference](../../shared/install/reference/harness-opencode.md)
holds the exact commands. The manual steps follow.

OpenCode owns provider/model configuration and credentials. AOS reads the
native model catalog and can select a model for a resumed Session, but does
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
they are, the gateway canonicalizes their names like any other harness. Charts,
maps, and stats are [MCP App](#mcp-apps) views the gateway reads from the
registered URL itself, so that URL must reach the server from the gateway as
well as from OpenCode.

`bun run opencode:serve` also writes the hidden `agent-builder` creator
definition, `.opencode/skills/aos-agent-creator/SKILL.md` with its
`reference/harness-opencode.md`, and `.opencode/skills/aos-invite-link/SKILL.md`
into the worktree, and refuses to start if they would conflict with existing
content or if the target port is already occupied. The creator may write only
a new `.opencode/agents/<id>.md` file. The gateway does not yet report it as
the creator, so AOS does not offer **New Agent** on OpenCode.

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
configured operator gateway origin. The skill calls the operator invitation
endpoint, so it needs network access but no signing key.

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

OpenCode keeps no App views, so the gateway connects to each view's server with
its own MCP client. It reaches only enabled remote servers without `headers` or
OAuth; any other shows the tool call's textual details. A view receives a
text-only result, because OpenCode stores only a tool's text output. Header
and address overrides are in harness-gw's OpenCode guide.

MCP tools are not callable from the v2 session engine at the pinned `1.18.29`
(see above), so Apps appear once upstream exposes them.

## Folder

Each Agent's folder is the gateway's configured `runtime.directory`.

## Artifacts

OpenCode 1.18.29 cannot call MCP tools, so `present_artifact` is not callable
and the App shows "Can't reach this file".

## Agent icons

OpenCode has no native Agent write, so AOS cannot change an Agent's icon on
OpenCode. An operator may hand-write an `avatar: ring/blue` key in the Agent
file's frontmatter, which AOS shows as the Agent's icon; harness-gw's OpenCode
guide lists that key's side effects (it reaches the model provider, and it
switches OpenCode to its legacy frontmatter parser). Agents without a stored
icon receive a generated icon derived from their position in the id-sorted
roster, so the assignments can shift when the roster changes.

## Capability limits

- AOS reads the native Agent catalog, creates, renames, pins, archives, and deletes Sessions, and projects Session Todos, but Agent visibility, Agent icon writes, Activity, and context accounting are unavailable. Voice becomes available when the gateway `voice` block is configured; see [Use voice](../chat-voice.md).
- Runs support streaming, reconnect, Stop, attachments, questions, and permissions. Edit/regenerate and active-turn steering are unavailable.
- An invitation can resolve only an existing OpenCode Session titled `aos-invite:<ref>`; a new invitation cannot create a Session on first Send.
- AOS never restarts OpenCode automatically. Restart it under operator control after changing its configuration, once active work has finished.

## Verify

```bash
bunx vitest run scripts/opencode packages/tools-mcp
```

Native live acceptance has not been run. It requires approved disposable Agents and real model credentials; mocked tests do not prove a live OpenCode journey.

For connection problems, see [Troubleshooting](../troubleshooting.md).
