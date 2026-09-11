<div align="center">

<img src="public/logo-adaptive.svg" alt="AOS logo" width="76" />

# AOS UI

**A UI for personal agent harnesses serving real business use cases—and the companion to the [AOS kit](https://github.com/AlmogBaku/aos).**

[Get started](docs/getting-started.md) · [Choose a runtime](docs/runtime-capabilities.md) · [Deploy AOS](docs/deployment.md) · [Operator docs](docs/README.md)

![AOS workspace showing a Q1 planning request, an executive-assistant recommendation, and an investment chart alongside personal business agents and Sessions](docs/assets/aos-workspace.png)

</div>

Most agent harnesses present a coding-agent interface. AOS UI gives your personal harness a workspace for business use cases: an accountant, executive assistant, marketing agent, ghostwriter, product partner, hiring agent, or any other role you configure. It keeps their Agents and Sessions in one place without losing ownership, execution state, or pending work.

AOS UI complements the [AOS kit](https://github.com/AlmogBaku/aos), which packages installable capabilities for a separately operated agent harness. OpenCode, Hermes, and OpenClaw keep control of execution, credentials, Agent definitions, and durable history; AOS UI provides the operator workspace around them.

## What AOS provides

- Agent and Session navigation with provider-verified ownership
- Streaming chat, queued messages, Stop, questions, approvals, and attachments where the selected runtime supports them
- Session-scoped Todos and message-scoped Plans
- Safe, inspectable rich output including charts, maps, Mermaid, and published Artifacts
- Activity history and opt-in browser notifications
- English LTR and Hebrew RTL layouts with keyboard-first navigation
- Optional Hermes voice controls and restricted guest invitations

One runtime is selected for each deployment. See the [runtime capability matrix](docs/runtime-capabilities.md) before choosing OpenCode, Hermes, OpenClaw, or generic AG-UI.

## Quick start

AOS UI is not an agent harness. It attaches to a harness that you install, authenticate, and run separately.

### Prerequisites

- One supported harness:
  - [OpenCode](docs/runtimes/opencode.md), installed and running as a server; or
  - [Hermes](docs/runtimes/hermes.md), installed, authenticated, and running as a server; or
  - [OpenClaw](docs/runtimes/openclaw.md), installed with its Gateway running; or
  - compatible [AG-UI run and workspace services](docs/runtimes/ag-ui.md)
- [Bun](https://bun.sh/)
- A current desktop browser

Install AOS UI:

```bash
git clone https://github.com/AlmogBaku/aos-ui.git
cd aos-ui
bun install
```

Then choose **one** of the following runtime connections. Do not run both configurations.

### OpenCode

Start OpenCode in the worktree it should own and allow the AOS browser origin:

```bash
cd /absolute/path/to/opencode-worktree
opencode serve --hostname 127.0.0.1 --port 4096 \
  --cors http://localhost:3000
```

In the AOS checkout:

```bash
AOS_UI_RUNTIME_MODE=opencode \
AOS_UI_OPENCODE_BASE_URL=http://127.0.0.1:4096 \
AOS_UI_OPENCODE_WORKTREE=/absolute/path/to/opencode-worktree \
  bun run dev
```

See [Run AOS with OpenCode](docs/runtimes/opencode.md) for native ownership, optional AOS integration tools, models, and containers.

### Hermes

Start your authenticated `hermes serve` installation independently. In the AOS checkout, attach through the development proxy:

```bash
AOS_UI_RUNTIME_MODE=hermes \
AOS_UI_HERMES_BASE_URL=/hermes \
AOS_UI_HERMES_TARGET=http://127.0.0.1:9119 \
  bun run dev
```

See [Run AOS with Hermes](docs/runtimes/hermes.md) for authentication, profiles, the optional native plugin, and containers.

### OpenClaw

Start the OpenClaw Gateway independently, then attach its official WebSocket:

```bash
AOS_UI_RUNTIME_MODE=openclaw \
AOS_UI_OPENCLAW_BASE_URL=ws://127.0.0.1:18789 \
  bun run dev
```

See [Run AOS with OpenClaw](docs/runtimes/openclaw.md) for pairing, scopes, the optional native plugin, containers, and explicit capability limits.

Generic providers use separate [AG-UI run and workspace services](docs/runtimes/ag-ui.md).

Open <http://localhost:3000> after starting AOS. Stopping AOS does not stop or remove the harness or its data.

### Preview without a harness

Fixture mode is an optional, backend-free preview of the interface. It is not a substitute for OpenCode, Hermes, or another compatible harness:

```bash
AOS_UI_RUNTIME_MODE=fixture bun run dev
```

The fixture is deterministic and cannot create or modify native Agents. Continue with the [guided workspace tour](docs/getting-started.md).

## Deployment

AOS builds to static assets and ships with an Nginx container. Runtime selection comes from `/runtime-config.json`, so operators can change the selected runtime without rebuilding the frontend.

For a containerized fixture preview:

```bash
cp .env.compose.example .env
AOS_UI_RUNTIME_CONFIG_FILE=./deploy/runtime-config.fixture.json \
  docker compose up --build
```

> [!IMPORTANT]
> Compose binds to loopback by default. AOS does not provide TLS or public multi-user authentication. Expose it more widely only behind controls appropriate for a trusted private network.

See [Deployment](docs/deployment.md) for native-runtime overlays, networking, health checks, and persistence.

## Documentation

| Goal                                      | Guide                                            |
| ----------------------------------------- | ------------------------------------------------ |
| Learn the workspace                       | [Getting started](docs/getting-started.md)       |
| Operate Agents and Sessions               | [Using AOS](docs/using-aos.md)                   |
| Configure a deployment                    | [Configuration reference](docs/configuration.md) |
| Resolve a problem                         | [Troubleshooting](docs/troubleshooting.md)       |
| Understand ownership and trust boundaries | [Architecture](docs/architecture.md)             |

The [operator documentation index](docs/README.md) lists every maintained guide.

## Verify a checkout

```bash
bun run test
bun run typecheck
bun run lint
bun run build
```

Additional checks are documented beside the runtime or deployment they cover.
