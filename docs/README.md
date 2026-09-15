# AOS operator documentation

Use this documentation to configure and operate AOS UI: a workspace for personal agent harnesses serving business use cases, and a companion to the [AOS capability kit](https://github.com/AlmogBaku/aos). The browser reaches a normalized AOS proxy; fixture mode is available only for evaluating the interface without one.

## Learn

- [Getting started](getting-started.md) — connect the AOS proxy, or preview the interface in fixture mode, then tour the workspace.
- [Using AOS](using-aos.md) — work with Agents, Sessions, Plans, Todos, Artifacts, Activity, and preferences.

## Run

- [Hermes](runtimes/hermes.md) — operate Hermes behind the AOS proxy.
- [OpenClaw](runtimes/openclaw.md) — attach an independently operated OpenClaw Gateway behind the AOS proxy.
- [OpenCode](runtimes/opencode.md) — operate an OpenCode server behind the AOS proxy.
- [Deployment](deployment.md) — run the Bun proxy and static assets, with optional external TLS termination.

## Operate

- [Chat voice](chat-voice.md) — configure transcription, voice turns, and read-aloud with Hermes.
- [Invited chat](invite-chat.md) — issue scoped JWT links through the proxy's separate guest listener.
- [Troubleshooting](troubleshooting.md) — diagnose configuration, connectivity, authentication, browser, and container problems.

## Reference

- [Configuration](configuration.md) — public runtime JSON, local environment variables, and deployment settings.
- [Runtime capabilities](runtime-capabilities.md) — compare fixture and normalized provider capabilities.

## Understand

- [Architecture and trust boundaries](architecture.md) — understand what AOS owns, what the runtime owns, and where data persists.

Internal product and visual authorities are intentionally separate from this operator set. Contributors and automation Agents should follow [`AGENTS.md`](../AGENTS.md).
Runtime adapter contributors should start with the
[development documentation](development/README.md).
