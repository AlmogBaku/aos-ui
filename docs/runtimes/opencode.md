# Run OpenCode behind the AOS proxy

The browser connects only to the normalized AOS proxy (`AOS_UI_RUNTIME_MODE=aos`). The proxy attaches to one separately operated OpenCode server, keeps its Basic-auth credentials private, and scopes every Session operation to the configured absolute OpenCode directory. It is not a browser-direct OpenCode integration.

## Prerequisites

- Bun and an OpenCode installation authenticated with the model providers you intend to use
- An absolute external worktree for OpenCode to operate in
- Private, owner-only files for the OpenCode server password and the proxy signing keys

The worktree is native runtime state. Do not point OpenCode at the AOS checkout unless that is deliberately the Agent's working directory. AOS neither installs OpenCode nor owns its provider credentials.

## Attach a locally operated server

Start OpenCode independently, with server authentication enabled, then create a private proxy configuration from [`deploy/proxy-config.opencode.example.json`](../../deploy/proxy-config.opencode.example.json). Set its `runtime.baseUrl` to the server address reachable by the proxy, `runtime.directory` to the exact absolute worktree, `runtime.username` to the OpenCode server username, and `runtime.passwordFile` to the matching private password file.

```bash
# Terminal 1: OpenCode owns this process and its provider credentials.
cd /absolute/path/to/external-worktree
OPENCODE_SERVER_USERNAME=aos-ui \
OPENCODE_SERVER_PASSWORD='replace-with-a-private-secret' \
  opencode serve --hostname 127.0.0.1 --port 4096

# Terminal 2: the browser talks only to this proxy.
bun run proxy:serve -- --config /absolute/private/path/proxy-config.opencode.json
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
AOS_UI_PROXY_CONFIG_FILE=/absolute/private/path/proxy-config.opencode.json \
AOS_UI_OPENCODE_PASSWORD_FILE=/absolute/private/path/opencode-password \
AOS_UI_RECONNECT_CURSOR_KEY_FILE=/absolute/private/path/reconnect-cursor-key \
AOS_UI_GUEST_INVITE_SIGNING_KEY_FILE=/absolute/private/path/guest-invite-signing-key \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  docker compose -f compose.yaml -f compose.opencode.yaml up --build
```

The example proxy configuration uses `http://opencode:4096` and `/workspace`, which are correct only inside this Compose composition. On Linux, set `AOS_UI_HOST_UID` and `AOS_UI_HOST_GID` when the defaults do not match the worktree owner.

## Native model configuration and optional tools

OpenCode owns provider/model configuration and credentials. AOS reads the native model catalog and can select a model for an attached Session, but does not choose a default model. The optional AOS native integration supplies presentation tools, guarded creator support, Session handoff, and the `aos-invite-link` skill; it remains optional to the proxy attachment. Build and load it for local native-tool development with:

Set `AOS_RUNTIME_PROXY_URL` for an Agent using `aos-invite-link` to the
configured operator proxy origin. The skill prefers the operator invitation
endpoint over the local CLI, so it needs network access but no signing key.

```bash
bun run integrations:build
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  bun run opencode:serve
```

## Capability limits

- AOS reads the native Agent catalog and creates Sessions, but Agent visibility, Session titles, deletion, Todos, Activity, context accounting, artifacts, transcription, and speech are unavailable when OpenCode has no exact matching operation.
- Runs support streaming, reconnect, Stop, attachments, questions, and permissions. Edit/regenerate and active-turn steering are unavailable.
- An invitation can resolve only an existing OpenCode Session titled `aos-invite:<ref>`. OpenCode cannot create that reserved Session safely because its pinned API exposes neither title-bearing creation nor title mutation; a new invitation therefore cannot create a Session on first Send.
- AOS never restarts OpenCode automatically. If the optional integration reports an Agent as `setup-needed`, let active work finish and restart OpenCode under operator control.

## Verify

```bash
bun run integrations:build
bunx vitest run test/opencode src/runtime-adapters/opencode integrations/opencode
```

Native live acceptance has not been run. It requires approved disposable Agents and real model credentials; mocked tests do not prove a live OpenCode journey.

For connection problems, see [Troubleshooting](../troubleshooting.md).
