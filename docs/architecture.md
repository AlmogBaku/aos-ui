# Architecture and trust boundaries

AOS UI is the business-agent workspace and UI companion to the [AOS capability kit](https://github.com/AlmogBaku/aos). It is a static browser application that attaches to an independently installed and operated AI runtime. It does not install or replace that runtime, and it deliberately avoids becoming another agent server or conversation database. Starting or stopping AOS UI does not start, stop, or delete provider state.

## Ownership model

A deployment selects one runtime engine. That runtime owns Agents, Sessions, messages, runs, credentials, tools, configuration, and durable history. AOS projects those records into Assistant UI and adds a small workspace boundary for Agent catalogs, verified Session ownership, and optional capabilities. Session Todos arrive as AG-UI PLAN activity, and execution status derives from the normalized run lifecycle.

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

The proxy selects one configured runtime adapter for a deployment. Hermes is
the V1 implementation. The selection seam can accept OpenCode and OpenClaw
later without adding provider branches to the browser. Each native adapter
implements the same normalized server boundary while keeping its own transport,
credentials, recovery positions, and provider payloads private.

The browser uses AG-UI to start or resume Session runs and receive their event
streams. Namespaced AOS REST operations provide workspace resources and the
active-run controls that AG-UI does not standardize, including Stop and
capability-gated steering. The AOS WebSocket carries invalidations, not native
run events. Fixture mode remains explicit synthetic data for evaluation and
tests; invalid real-runtime configuration renders an unavailable screen rather
than falling back to fixtures.

Assistant UI owns queued messages. While a run is busy, an ordinary Send adds
one FIFO follow-up; a supported text-only steering action targets the existing
logical run through AOS REST. It does not create another AG-UI run. The proxy
correlates the acknowledgement into the existing event stream, and provider
history remains authoritative after settlement or reconnect.

Browser code never imports native filesystem writers or provider implementations. Native packages install presentation tools and, only where the harness exposes the required safe authority, creator support. Agent profiles, worktrees, secrets, and runtime state remain outside the frontend checkout.

## Rich output and Artifacts

Rich tools are rendered from validated data and always retain an inspectable textual fallback. AOS does not execute arbitrary generated code in the main page.

An Agent may explicitly publish an Artifact. AOS provides read-only resolution, preview, and download; it does not provide file editing, storage, or version history. Published HTML runs in an opaque-origin sandbox with a fixed content-security policy. An operator allowlist may permit public HTTPS assets, so the preview is isolation rather than a complete network-egress boundary.

## Network and authentication boundary

The Bun proxy serves the compiled Vite application and normalized API on one
trusted operator listener. The operator listener intentionally has no
application authentication: network access grants operator access. It must
therefore remain on loopback or a trusted private network, or sit behind an
operator-managed authenticated ingress. Nginx is optional TLS/reverse-proxy
infrastructure, not part of the runtime boundary.

The optional guest listener uses a distinct port and scoped, expiring JWTs.
Operator and guest lanes share the same configured Hermes adapter, transport,
and Session coordinator. Authorization and outbound projection remain
lane-specific, so a guest token grants only its declared runtime, Agent,
Session, and operations. There is no second guest Hermes credential.

Hermes authentication uses one server token read from a private file. Reconnect
cursor keys and optional guest invitation keys are also file-backed secrets.
None appear in the browser-readable `/runtime-config.json`, browser bundle,
URLs, logs, or normalized provider responses.

One multiplexed Hermes WebSocket is retained for the configured runtime. The
Session coordinator retains an attachment while work is running, stopping,
waiting for a question or approval, reconciling, or actively observed. A
terminal unobserved Session stays warm for five minutes, after which the proxy
closes only that native Session attachment; the shared socket remains open.
Disconnecting or reloading a browser never stops native work.
