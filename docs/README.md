# AOS operator documentation

Use this documentation to evaluate, configure, and operate AOS. Start with fixture mode if you have not used the workspace before.

## Learn

- [Getting started](getting-started.md) — run the credential-free fixture and learn the workspace through a short guided tour.
- [Using AOS](using-aos.md) — work with Agents, Sessions, Plans, Todos, Artifacts, Activity, and preferences.

## Run

- [OpenCode](runtimes/opencode.md) — connect AOS to a local or containerized OpenCode server.
- [Hermes](runtimes/hermes.md) — connect AOS to an operator-managed Hermes server.
- [Generic AG-UI](runtimes/ag-ui.md) — connect separate AG-UI run and workspace services.
- [Deployment](deployment.md) — build static assets or run the supplied Compose stack.

## Operate

- [Chat voice](chat-voice.md) — configure transcription, voice turns, and read-aloud with Hermes.
- [Invited chat](invite-chat.md) — run the optional gateway and issue restricted guest links.
- [Troubleshooting](troubleshooting.md) — diagnose configuration, connectivity, authentication, browser, and container problems.

## Reference

- [Configuration](configuration.md) — public runtime JSON, local environment variables, and deployment settings.
- [Runtime capabilities](runtime-capabilities.md) — compare fixture, OpenCode, Hermes, and generic AG-UI.

## Understand

- [Architecture and trust boundaries](architecture.md) — understand what AOS owns, what the runtime owns, and where data persists.

Internal product and visual authorities are intentionally separate from this operator set. Contributors and automation Agents should follow [`AGENTS.md`](../AGENTS.md).
