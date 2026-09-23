# Architecture and trust boundaries

AOS UI is the business-agent workspace and UI companion to the [AOS capability kit](https://github.com/AlmogBaku/aos). It is a static browser application that attaches to an independently installed and operated AI runtime. It does not install or replace that runtime, and it deliberately avoids becoming another agent server or conversation database. Starting or stopping AOS UI does not start, stop, or delete provider state.

## Ownership model

A deployment selects one runtime engine. That runtime owns Agents, Sessions, messages, runs, credentials, tools, configuration, and durable history. AOS projects those records into Assistant UI and adds a small workspace boundary for Agent catalogs, verified Session ownership, and optional capabilities. Session Todos arrive as ACP `plan_update` notifications, and execution status derives from the normalized run lifecycle.

The core relationships are strict:

- Every Session belongs to one primary Agent.
- A Subagent is a nested run, not a primary Agent.
- A Plan belongs to the message that produced it.
- Todos belong to the Session.
- Delayed events retain their originating Agent and Session.

These rules prevent a late event, reconnect, or navigation change from placing work under the wrong identity.

## Browser state

The browser owns presentation state: language, appearance, keyboard preferences, open tabs, per-visit selection restoration, notification preferences, and a content-free Activity snapshot. Session read state is provider-owned: the browser reports the focused Session via `_aos/session/focus` and the runtime decides when it becomes read. The browser does not become the durable source for provider conversations.

Assistant UI manages the frontend projection of threads, messages, runs, branches, the composer, and message queues. Runtime adapters translate native records and lifecycle operations without leaking provider-specific types across the shared boundary.

## Runtime boundaries

The proxy selects one configured runtime adapter for a deployment. Hermes is
the primary and first-supported V1 implementation. OpenClaw and OpenCode also
implement the same normalized server boundary without adding provider branches
to the browser. Each native adapter keeps its own transport, credentials,
recovery positions, and provider payloads private.

Each browser tab opens one ACP v2 WebSocket at `/api/aos/v1/acp`. That single
socket carries run streams, session lifecycle, agent catalog, active-run
controls, `_aos/*` notifications (focus, activity, invalidation),
Artifact `resource_link` content blocks,
`usage_update`, and `session/set_config_option`. The `initialize` response
negotiates optional extensions including `activity`, `readState`, and `focus`.
`packages/proxy/acp` is the server-side translation point. Normalized AOS REST
handles bytes and discovery. Fixture mode remains explicit synthetic data for
evaluation and tests; invalid real-runtime configuration renders an unavailable
screen rather than falling back to fixtures.

Assistant UI owns queued messages. While a run is busy, an ordinary Send adds
one FIFO follow-up; a supported text-only steering action delivers an
`_aos/session/steer` request over the same ACP socket. It does not create
another run. The proxy correlates the acknowledgement into the existing event
stream, and provider history remains authoritative after settlement or reconnect.

Browser code never imports native filesystem writers or provider implementations. Agent profiles, worktrees, secrets, and runtime state remain outside the frontend checkout.

## Tools MCP server

`packages/tools-mcp` is a stateless MCP server that AOS UI owns, separate from
the proxy. It offers `render_chart`, `render_map`, `render_stats`, and
`present_artifact`; each tool's description carries its guidance, and there is
no AOS system prompt. The operator registers the server in each harness as
`aos-ui` (`http://127.0.0.1:4110/mcp`). It serves Streamable HTTP at `/mcp` and
`/health` with no authentication, so it stays on loopback or a private Compose
network.

The server never reads the filesystem or talks to the proxy. `render_chart`,
`render_map`, and `render_stats` are [MCP Apps](#mcp-apps): each validates its
data and declares a single-file HTML view (`ui://aos-ui/chart`, `map`, or
`stats`) built from `packages/tools-mcp/views`. The map view draws MapLibre
over OpenFreeMap tiles. `present_artifact` has no view and returns a receipt
naming an absolute path. The proxy recognizes that receipt in provider history,
whatever prefix the harness gave the tool name, and reads a published file's
bytes back through the harness's own file interface. The harness therefore
remains the authority on what a Session may read.

## Rich output and Artifacts

Charts, maps, and stats are MCP App views; every tool call keeps an inspectable textual fallback in its compact row. AOS does not execute arbitrary generated code in the main page.

An Agent may explicitly publish an Artifact, with a `present_artifact` receipt or a harness's own media delivery such as a Hermes `MEDIA:` line. The proxy validates the path, refuses relative, traversing, and credential-file paths, and caps reads at 25 MiB. AOS provides read-only resolution, preview, and download; it does not provide file editing, storage, or version history. Published image, audio, and video Artifacts render inline in the conversation. Published HTML runs in an opaque-origin sandbox with a fixed content-security policy. An operator allowlist may permit public HTTPS assets, so the preview is isolation rather than a complete network-egress boundary.

## MCP Apps

An MCP server the operator registers in the runtime's own MCP configuration
may declare an App view for a tool: server-authored HTML at a `ui://` resource.
AOS renders it as an App card; nothing about the server is configured in AOS.
The runtime runs the tool and stores its result. The proxy flags a call whose
tool declares a view when the call starts, from the tool's name and the
server's `tools/list`, or else once its result names the view. It serves the
view keyed by the tool call, sends the view the call's input once the arguments
are complete and its result once the call settles, and relays the view's own
`tools/call` and `resources/read` only to that call's server, only for a call
of that Session's own run or history. The browser never names a
server, tool, or resource URI, and never talks to an MCP server.

OpenClaw serves views natively. Hermes and OpenCode keep none, so a temporary
proxy fallback (`packages/proxy/mcp-apps`) reads them with the proxy's own MCP
client from the server URL the runtime reports, and reaches only Streamable
HTTP servers without credentials or with headers the operator gave the proxy.

The view runs in a double iframe: an opaque-origin sandbox proxy that relays
messages, holding the App frame. The proxy is a static page,
`/mcp-app-sandbox.html`, served on both listeners with its own CSP, so it never
inherits the embedding page's policy; the App frame carries a CSP built from
the view's declared domains, which narrows that one. Neither frame may navigate
the top window, open popups, or submit forms. See [MCP Apps](mcp-apps.md) for the rules a view runs under.

MCP tool names are normalized server-side: the four `aos-ui` tools read bare,
every other MCP tool reads `mcp__<server>__<tool>` resolved against the
runtime's own server list, and an unknown name stays raw.

## Network and authentication boundary

The Bun proxy serves the compiled Vite application and normalized API on one
trusted operator listener. The operator listener intentionally has no
application authentication: network access grants operator access. It must
therefore remain on loopback or a trusted private network, or sit behind an
operator-managed authenticated ingress. Nginx is optional TLS/reverse-proxy
infrastructure, not part of the runtime boundary.

The optional guest listener uses a distinct port and scoped, expiring JWTs.
Operator and guest lanes share the same configured runtime adapter, transport,
and Session coordinator. Authorization and outbound projection remain
lane-specific, so a guest token grants only its declared runtime, Agent,
Session, and operations. Guests may stop runs they started (`session/cancel` is
in `GUEST_METHODS`). There is no second guest Hermes credential.

Hermes authentication uses one server token read from a private file. Optional
guest invitation signing keys are also file-backed secrets. None appear in the
browser-readable `/runtime-config.json`, browser bundle, URLs, logs, or
normalized provider responses.

One multiplexed native WebSocket is retained for the configured runtime. The
Session coordinator retains an attachment while work is running, stopping,
waiting for a question or approval, reconciling, or actively observed. A
terminal unobserved Session stays warm for `runtime.sessionIdleMs` (default
300 000 ms), after which the proxy closes only that native Session attachment;
the shared socket remains open. Disconnecting or reloading a browser never
stops native work.
