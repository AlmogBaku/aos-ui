# Run AOS with OpenCode

Use this guide to attach AOS to an independently installed OpenCode server. OpenCode keeps ownership of its process, Agent definitions, model credentials, worktree, and durable Sessions.

## Prerequisites

- Bun
- OpenCode installed and authenticated with the model provider you intend to use
- An absolute external worktree for OpenCode to operate in

The external worktree is native runtime state. Do not point OpenCode at the AOS frontend checkout unless that is intentionally the Agent's working directory. AOS does not install or manage the OpenCode binary.

## Start OpenCode independently

From the worktree OpenCode should own, start its native server and allow the browser origin that will serve AOS:

```bash
cd /absolute/path/to/external-worktree
opencode serve --hostname 127.0.0.1 --port 4096 \
  --cors http://localhost:3000 \
  --cors http://127.0.0.1:3000
```

Configure models and credentials through OpenCode itself. Keep this process running independently of AOS.

## Attach AOS

In the AOS checkout, install frontend dependencies and point the adapter at the existing server and its native directory:

```bash
bun install
AOS_UI_RUNTIME_MODE=opencode \
AOS_UI_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  bun run dev
```

Open <http://localhost:3000>. `AOS_UI_OPENCODE_WORKTREE` is sent to OpenCode as the request directory, so it must be the absolute directory understood by the native server. AOS refuses ownership data from another directory.

Stopping AOS leaves OpenCode and its Sessions running. Stop or restart OpenCode through your normal runtime operations.

## Optionally load the AOS native integration

Basic attachment uses OpenCode's native APIs. The AOS integration adds presentation tools, Session handoff, the guarded creator workflow, and the `aos-invite-link` skill.

For development from this checkout, the supplied launcher builds and loads that integration into an already installed `opencode` binary:

```bash
bun run integrations:build
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  bun run opencode:serve
```

Then attach the frontend in a second terminal using the command from the previous section. The launcher is optional convenience tooling: it does not install OpenCode, own its credentials, or turn AOS into the runtime. It refuses to overwrite conflicting Agent or skill definitions.

## Choose a model

The independently operated OpenCode instance owns model providers and credentials. AOS does not choose a model by default. Leave selection native, or set both identifiers on the frontend to select one model already available from that server:

```bash
AOS_UI_RUNTIME_MODE=opencode \
AOS_UI_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
AOS_UI_OPENCODE_PROVIDER_ID=amazon-bedrock \
AOS_UI_OPENCODE_MODEL_ID=your-model-id \
  bun run dev
```

Setting only one identifier makes the frontend configuration unavailable.

Configure an independently started server using OpenCode's native provider settings. When using the optional AOS launcher, it passes existing AWS and Google provider variables through. Its OpenAI-compatible convenience requires all three native-process variables together:

```text
AOS_UI_OPENAI_COMPATIBLE_BASE_URL
AOS_UI_OPENAI_COMPATIBLE_API_KEY
AOS_UI_OPENAI_COMPATIBLE_MODEL_ID
```

Keep provider credentials out of the AOS process, `/runtime-config.json`, and `VITE_*` variables unless the optional launcher explicitly needs to forward them to OpenCode.

## Attach containerized AOS to existing OpenCode

Create public runtime JSON whose `baseUrl` is reachable by the operator's browser and whose `directory` is the absolute path understood by OpenCode:

```json
{
  "mode": "opencode",
  "baseUrl": "https://opencode.example.test",
  "directory": "/srv/agents"
}
```

Mount that file into the web-only composition:

```bash
AOS_UI_RUNTIME_CONFIG_FILE=/absolute/path/to/runtime-config.opencode.json \
  docker compose -f compose.yaml up --build
```

The browser connects to the existing OpenCode server; the AOS container does not start or mount it. Configure OpenCode CORS for the public AOS origin.

## Optionally run the bundled OpenCode composition

For local evaluation, the repository also supplies an overlay that starts OpenCode beside AOS:

```bash
cp .env.compose.example .env
```

Edit `.env`, then run:

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.opencode.json \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  docker compose -f compose.yaml -f compose.opencode.yaml up --build
```

This optional composition is an all-in-one convenience, not the attachment architecture. The native container sees the worktree as `/workspace`, matching the supplied public configuration. On Linux, set `AOS_UI_HOST_UID` and `AOS_UI_HOST_GID` to the owning numeric IDs when the defaults do not match the host files.

The image includes `aos-gateway`. To let an Agent create guest invitations, set
`AOS_GATEWAY_INVITE_SIGNING_KEY` in `.env`; the skill asks for the deployed
guest origin for each invitation. See [Invited chat](../invite-chat.md) for the
workflow and trust model.

## Operational limits

- OpenCode is the authority for its process, Agent visibility, Sessions, execution, credentials, worktree, and persistence.
- AOS currently treats the OpenCode Agent catalog as read-only.
- With the optional AOS integration, newly saved Agent definitions may report `setup-needed` until an operator restarts OpenCode after active runs finish. AOS does not dispose the native instance automatically because that can abort unrelated runs.
- Secure Agent writes in the optional integration use Linux directory-descriptor guarantees. Use the supplied OpenCode container on hosts that cannot provide them.
- Stop targets the current native run. Switching Sessions parks frontend queue state without transferring it to another Session.

## Verify

```bash
bun run integrations:build
bunx vitest run test/opencode src/runtime-adapters/opencode integrations/opencode
```

Live acceptance requires approved disposable Agents and real model credentials. Mocked tests are not evidence of a live OpenCode journey.

If startup or connection fails, see [Troubleshooting](../troubleshooting.md).
