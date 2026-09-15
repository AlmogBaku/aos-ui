# OpenCode server adapter status

AOS does not currently expose an OpenCode browser runtime. OpenCode remains a
future server-side adapter. The browser connects only to the normalized AOS
proxy (`AOS_UI_RUNTIME_MODE=aos`) or explicit fixture mode.

## Prerequisites

- Bun
- OpenCode installed and authenticated with the model provider you intend to use
- An absolute external worktree for OpenCode to operate in

The external worktree is native runtime state. Do not point OpenCode at the AOS frontend checkout unless that is intentionally the Agent's working directory. AOS does not install or manage the OpenCode binary.

## Native integration development

OpenCode integration packaging and tests remain available for server-adapter
development. Operate the native server independently of the browser:

```bash
cd /absolute/path/to/external-worktree
opencode serve --hostname 127.0.0.1 --port 4096
```

Configure models and credentials through OpenCode itself. Keep this process running independently of AOS.

## Optional native integration tooling

Basic attachment uses OpenCode's native APIs. The AOS integration adds presentation tools, Session handoff, the guarded creator workflow, and the `aos-invite-link` skill.

For development from this checkout, the supplied launcher builds and loads that integration into an already installed `opencode` binary:

```bash
bun run integrations:build
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  bun run opencode:serve
```

The launcher is optional convenience tooling: it does not provide a browser
attachment path, install OpenCode, own its credentials, or turn AOS into the
runtime. It refuses to overwrite conflicting Agent or skill definitions.

## Native model configuration

The independently operated OpenCode instance owns model providers and
credentials. Configure them through OpenCode itself; there are no OpenCode
browser environment variables or runtime mode.

When using the optional AOS launcher, it passes existing AWS and Google
provider variables through. Its OpenAI-compatible convenience requires all
three native-process variables together:

```text
AOS_UI_OPENAI_COMPATIBLE_BASE_URL
AOS_UI_OPENAI_COMPATIBLE_API_KEY
AOS_UI_OPENAI_COMPATIBLE_MODEL_ID
```

Keep provider credentials out of the AOS process, `/runtime-config.json`, and `VITE_*` variables unless the optional launcher explicitly needs to forward them to OpenCode.

## Optional bundled server composition

For native server-adapter evaluation, the repository supplies an overlay that
starts OpenCode beside AOS. It does not add an OpenCode browser runtime.

```bash
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/external-worktree \
  docker compose -f compose.yaml -f compose.opencode.yaml up --build
```

The native container sees the worktree as `/workspace`. On Linux, set
`AOS_UI_HOST_UID` and `AOS_UI_HOST_GID` when the defaults do not match host
files.

The image contains only OpenCode and the optional native AOS integration. Guest
invitations belong to the TypeScript proxy and become available for OpenCode
after its server adapter is implemented.

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
