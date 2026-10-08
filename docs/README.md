# AOS operator documentation

Use this documentation to configure and operate AOS UI: a workspace for personal agent harnesses serving business use cases, and a companion to the [AOS capability kit](https://github.com/AlmogBaku/aos). The browser reaches the separately maintained [harness-gw](https://github.com/AlmogBaku/harness-gw) gateway; fixture mode is available only for evaluating the interface without one.

## Learn

- [Getting started](getting-started.md) — connect the gateway, or preview the interface in fixture mode, then tour the workspace.
- [Using AOS](using-aos.md) — work with Agents, Sessions, Plans, Todos, Artifacts, Activity, and preferences.

## Run

- [Hermes](runtimes/hermes.md) — operate Hermes behind the gateway.
- [OpenClaw](runtimes/openclaw.md) — attach an independently operated OpenClaw Gateway behind harness-gw.
- [OpenCode](runtimes/opencode.md) — operate an OpenCode server behind the gateway.
- [Deployment](deployment.md) — run Caddy, the aos-ui web server, the gateway, and the tools MCP server, with optional external TLS termination.

## Operate

- [Use voice](chat-voice.md) — configure transcription, voice turns, and read-aloud.
- [Invited chat](invite-chat.md) — issue scoped JWT links through the gateway's separate guest lane.
- [Troubleshooting](troubleshooting.md) — diagnose configuration, connectivity, authentication, browser, and container problems.

## Reference

- [Configuration](configuration.md) — public runtime JSON, local environment variables, and deployment settings.
- [Runtime capabilities](runtime-capabilities.md) — compare fixture and normalized provider capabilities.
- [MCP Apps](mcp-apps.md) — register an MCP App server, and what an App view may do inside AOS.

## Understand

- [Architecture and trust boundaries](architecture.md) — understand what AOS owns, what the runtime owns, and where data persists.

Internal product and visual authorities are intentionally separate from this operator set. Contributors and automation Agents should follow [`AGENTS.md`](../AGENTS.md).
Contributors should start with the [development documentation](development/README.md);
gateway and runtime adapter work happens in harness-gw.

## Internal authorities

- [Visual design lock](design/agent-workspace-design-lock.md) — binding visual direction for workspace UI.
- [harness-gw protocol](https://github.com/AlmogBaku/harness-gw/blob/main/docs/protocol.md) — the ACP v2 wire, `_hgw/*` extensions, origins, and the `/api/v1` HTTP API, maintained in harness-gw.
- [Runtime gateway architecture](https://github.com/AlmogBaku/harness-gw/blob/main/docs/design/aos-runtime-gateway-architecture.md) — normative server-side gateway design, maintained in harness-gw.

`docs/development/` contains retrospectives and transport audits. `docs/research/` and `docs/superpowers/plans/` are dated historical records; treat them as background only.
