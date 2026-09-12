# Architecture and trust boundaries

AOS UI is the business-agent workspace and UI companion to the [AOS capability kit](https://github.com/AlmogBaku/aos). It is a static browser application that attaches to an independently installed and operated AI runtime. It does not install or replace that runtime, and it deliberately avoids becoming another agent server or conversation database. Starting or stopping AOS UI does not start, stop, or delete provider state.

## Ownership model

A deployment selects one runtime engine. That runtime owns Agents, Sessions, messages, runs, credentials, tools, configuration, and durable history. AOS projects those records into Assistant UI and adds a small workspace boundary for Agent catalogs, verified Session ownership, Todos, activity, and optional capabilities.

The core relationships are strict:

- Every Session belongs to one primary Agent.
- A Subagent is a nested run, not a primary Agent.
- A Plan belongs to the message that produced it.
- Todos belong to the Session.
- Delayed events retain their originating Agent and Session.

These rules prevent a late event, reconnect, or navigation change from placing work under the wrong identity.

## Browser state

The browser owns presentation state: language, appearance, keyboard preferences, open tabs, per-visit selection restoration, and content-free Activity read/delivery records. It does not become the durable source for provider conversations.

Assistant UI manages the frontend projection of threads, messages, runs, branches, the composer, and message queues. Runtime adapters translate native records and lifecycle operations without leaking provider-specific types across the shared boundary.

## Runtime boundaries

OpenCode, Hermes, and the planned OpenClaw integration have independent native
adapters behind the shared harness-runtime contract. OpenClaw uses its official
Gateway WebSocket, not AG-UI, but is unavailable on the current normalized
deployment path. Generic AG-UI uses one HTTP Agent per Session and a separate
workspace service. Fixture mode is explicit synthetic data for evaluation and
tests; invalid real-runtime configuration renders an unavailable screen rather
than falling back to fixtures.

Browser code never imports native filesystem writers or provider implementations. Native packages install presentation tools and, only where the harness exposes the required safe authority, creator support. Agent profiles, worktrees, secrets, and runtime state remain outside the frontend checkout.

## Rich output and Artifacts

Rich tools are rendered from validated data and always retain an inspectable textual fallback. AOS does not execute arbitrary generated code in the main page.

An Agent may explicitly publish an Artifact. AOS provides read-only resolution, preview, and download; it does not provide file editing, storage, or version history. Published HTML runs in an opaque-origin sandbox with a fixed content-security policy. An operator allowlist may permit public HTTPS assets, so the preview is isolation rather than a complete network-egress boundary.

## Network and authentication boundary

The standard production image serves static assets through Nginx and forwards only restricted integration routes. Native runtimes keep their own authentication and credentials. Public runtime configuration is browser-readable and therefore accepts no secrets.

Compose binds to loopback by default. It supplies neither TLS nor public multi-user authentication. Wider exposure belongs behind an operator-managed trusted-network, authentication, and TLS boundary.

The optional gateway adds same-origin native forwarding and a separate restricted guest listener using signed, expiring bearer invitations. It does not replace the runtime or sandbox the invited Agent's native tools. See [Invited chat](invite-chat.md) for that narrower trust model.
