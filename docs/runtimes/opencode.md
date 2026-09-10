# Run AOS with OpenCode

Use this guide to run AOS against an OpenCode server while keeping Agent definitions, model credentials, and durable Sessions in OpenCode.

## Prerequisites

- Bun
- OpenCode installed and authenticated with the model provider you intend to use
- An absolute external worktree for OpenCode to operate in

The external worktree is native runtime state. Do not point OpenCode at the AOS frontend checkout unless that is intentionally the Agent's working directory.

## Start a local composition

Install dependencies and build the native integration:

```bash
bun install
bun run integrations:build
```

Start OpenCode from the AOS launcher:

```bash
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  bun run opencode:serve
```

The launcher defaults to `127.0.0.1:4096`, installs the AOS integration and dedicated creator definition, and scopes native requests and writes to the configured worktree. It refuses to overwrite an existing Agent definition.

In another terminal, start the frontend:

```bash
AOS_UI_RUNTIME_MODE=opencode \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  bun run dev
```

Open <http://localhost:3000>.

## Choose a model

AOS does not select an OpenCode model by default. Leave selection to OpenCode, or set both identifiers:

```bash
AOS_UI_OPENCODE_PROVIDER_ID=amazon-bedrock \
AOS_UI_OPENCODE_MODEL_ID=your-model-id \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  bun run opencode:serve
```

Setting only one identifier makes the frontend configuration unavailable.

The launcher passes existing AWS and Google provider variables through to OpenCode. For an OpenAI-compatible service, set all three native-process variables together:

```text
AOS_UI_OPENAI_COMPATIBLE_BASE_URL
AOS_UI_OPENAI_COMPATIBLE_API_KEY
AOS_UI_OPENAI_COMPATIBLE_MODEL_ID
```

Keep provider credentials out of `/runtime-config.json` and `VITE_*` variables.

## Run with Compose

Copy the Compose environment example and set the host worktree:

```bash
cp .env.compose.example .env
```

Edit `.env`, then run:

```bash
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.opencode.json \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  docker compose -f compose.yaml -f compose.opencode.yaml up --build
```

The native container sees the worktree as `/workspace`, matching the supplied public configuration. On Linux, set `AOS_UI_HOST_UID` and `AOS_UI_HOST_GID` to the owning numeric IDs when the defaults do not match the host files.

## Operational limits

- OpenCode is the authority for Agent visibility, Sessions, execution, credentials, and persistence.
- AOS currently treats the OpenCode Agent catalog as read-only.
- Newly saved Agent definitions may report `setup-needed` until an operator restarts OpenCode after active runs finish. AOS does not dispose the shared native instance automatically because that can abort unrelated runs.
- Secure Agent writes use Linux directory-descriptor guarantees. Use the supplied OpenCode container on hosts that cannot provide them.
- Stop targets the current native run. Switching Sessions parks frontend queue state without transferring it to another Session.

## Verify

```bash
bun run integrations:build
bunx vitest run test/opencode src/runtime-adapters/opencode integrations/opencode
```

Live acceptance requires approved disposable Agents and real model credentials. Mocked tests are not evidence of a live OpenCode journey.

If startup or connection fails, see [Troubleshooting](../troubleshooting.md).
