<div align="center">

<img src="public/logo-adaptive.svg" alt="AOS logo" width="76" />

# AOS

**A multilingual workspace for operating provider-owned AI agents and their conversations.**

[Get started](docs/getting-started.md) · [Choose a runtime](docs/runtime-capabilities.md) · [Deploy AOS](docs/deployment.md) · [Operator docs](docs/README.md)

![AOS workspace with an Agent roster, Session tabs, published outputs, Todos, and composer](docs/assets/aos-workspace.png)

</div>

AOS gives people one place to move between AI Agents and Sessions without losing ownership, execution state, or pending work. OpenCode and Hermes keep control of execution, credentials, Agent definitions, and durable history. AOS provides the browser workspace around them.

## What AOS provides

- Agent and Session navigation with provider-verified ownership
- Streaming chat, queued messages, Stop, questions, approvals, and attachments where the selected runtime supports them
- Session-scoped Todos and message-scoped Plans
- Safe, inspectable rich output including charts, maps, Mermaid, and published Artifacts
- Activity history and opt-in browser notifications
- English LTR and Hebrew RTL layouts with keyboard-first navigation
- Optional Hermes voice controls and restricted guest invitations

One runtime is selected for each deployment. See the [runtime capability matrix](docs/runtime-capabilities.md) before choosing OpenCode, Hermes, or generic AG-UI.

## Quick start

Use fixture mode to explore the workspace without a backend or model credentials.

### Prerequisites

- [Bun](https://bun.sh/)
- A current desktop browser

```bash
git clone https://github.com/AlmogBaku/aos-ui.git
cd aos-ui
bun install
AOS_UI_RUNTIME_MODE=fixture bun run dev
```

Open <http://localhost:3000>. The fixture is deterministic and intentionally does not create or modify native Agents.

Continue with the [guided fixture tour](docs/getting-started.md), then connect a runtime:

- [Run with OpenCode](docs/runtimes/opencode.md)
- [Run with Hermes](docs/runtimes/hermes.md)
- [Connect a generic AG-UI runtime](docs/runtimes/ag-ui.md)

## Deployment

AOS builds to static assets and ships with an Nginx container. Runtime selection comes from `/runtime-config.json`, so operators can change the selected runtime without rebuilding the frontend.

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
