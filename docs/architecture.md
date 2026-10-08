# Architecture and trust boundaries

AOS UI is the business-agent workspace and UI companion to the [AOS capability kit](https://github.com/AlmogBaku/aos). It is a static browser application that attaches, through the separately maintained [harness-gw](https://github.com/AlmogBaku/harness-gw) gateway, to an independently installed and operated AI runtime. It does not install or replace that runtime, and it deliberately avoids becoming another agent server or conversation database. Starting or stopping AOS UI does not start, stop, or delete provider state.

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

The browser owns presentation state: language, appearance, keyboard preferences, open tabs, per-visit selection restoration, notification preferences, and a content-free Activity snapshot. Session read state is provider-owned: the browser reports the focused Session via `_hgw/session/focus` and the runtime decides when it becomes read. The browser does not become the durable source for provider conversations.

Assistant UI manages the frontend projection of threads, messages, runs, branches, the composer, and message queues. Runtime adapters translate native records and lifecycle operations without leaking provider-specific types across the shared boundary.

## Runtime boundaries

The gateway, [harness-gw](https://github.com/AlmogBaku/harness-gw), selects one configured runtime adapter for a
deployment. Hermes is the primary and first-supported V1 implementation.
OpenClaw and OpenCode implement the same normalized server boundary without
adding provider branches to the browser. Each native adapter keeps its own
transport, credentials, recovery positions, and provider payloads private
inside the gateway; aos-ui contains no adapter code.

The browser uses the gateway's client, `@harness-gw/sdk`. Each browser tab
opens one ACP v2 WebSocket at `/api/v1/acp`. That single socket carries run
streams, session lifecycle, agent catalog, active-run controls, `_hgw/*`
notifications (focus, activity, invalidation), Artifact `resource_link`
content blocks, `usage_update`, and `session/set_config_option`. The
`initialize` response always answers ACP version 2 and carries the gateway's
extension version and optional extensions, including `activity`, `readState`,
and `focus`, in `_meta.hgw`; a gateway on another extension version ends the
connection without reconnecting. The gateway's `/api/v1` HTTP API handles
bytes and discovery. The wire is specified in harness-gw's
[protocol](https://github.com/AlmogBaku/harness-gw/blob/main/docs/protocol.md). Fixture mode remains explicit
synthetic data for evaluation and tests; invalid real-runtime configuration
renders an unavailable screen rather than falling back to fixtures.

Assistant UI owns queued messages. While a run is busy, an ordinary Send adds
a follow-up to the queue, and the whole queue goes out as one message when the
turn ends; a supported text-only steering action delivers an
`_hgw/session/steer` request over the same ACP socket. It does not create
another run. The gateway correlates the acknowledgement into the existing event
stream, and provider history remains authoritative after settlement or reconnect.

Browser code never imports native filesystem writers or provider implementations. Agent profiles, worktrees, secrets, and runtime state remain outside the frontend checkout.

## Tools MCP server

`packages/tools-mcp` is a stateless MCP server that AOS UI owns, separate from
the gateway. It offers `render_chart`, `render_map`, `render_stats`, and
`present_artifact`; each tool's description carries its guidance, and there is
no AOS system prompt. The operator registers the server in each harness as
`aos-ui` (`http://127.0.0.1:4110/mcp`). It serves Streamable HTTP at `/mcp` and
`/health` with no authentication, so it stays on loopback or a private Compose
network.

The server never reads the filesystem or talks to the gateway. `render_chart`,
`render_map`, and `render_stats` are [MCP Apps](#mcp-apps): each validates its
data and declares a single-file HTML view (`ui://aos-ui/chart`, `map`, or
`stats`) built from `packages/tools-mcp/views`. The map view draws MapLibre
over OpenFreeMap tiles. `present_artifact` is also an MCP App: it declares an
`artifact` view (`ui://aos-ui/artifact`) that renders PDFs, images, plain text,
and sandboxed HTML. The view reads the file from the address the gateway grants it
in `aos/files`; the server itself never opens the file. The gateway serves the
file through the runtime's own file interface, governed by the `mcpApps.files`
folder rules; the harness therefore remains the authority on what a Session may
read.

## Rich output and Artifacts

Charts, maps, stats, and files are MCP App views; every tool call keeps an inspectable textual fallback in its compact row. AOS does not execute arbitrary generated code in the main page.

An Agent shows a file with `present_artifact`. The `artifact` view renders PDFs (with pdf.js, fitted to the view, with selectable text, keyboard paging, zoom, and an outline and page sidebar), zoomable images, plain text, and Agent-written HTML (its own scripts in an opaque-origin frame, no network or external resources). A file over its kind's preview limit (64 MiB for a PDF or an image, 25 MiB for HTML, 2 MiB for text) offers download and open instead of a preview. pip moves the view to the side panel. The gateway serves the file through the runtime's own file interface; the `aos-ui` MCP server never opens it. A signed address, valid about ten minutes and renewed while the view is open, lets the view fetch from the opaque-origin sandbox frame. Folder rules in `mcpApps.files` govern which paths are served.

An Agent may also publish an Artifact through a harness's own media delivery such as a Hermes `MEDIA:` line or a trusted native delivery tool such as Hermes text-to-speech. The gateway validates the path, refuses relative, traversing, and credential-file paths, and caps reads at 25 MiB. Published image, audio, and video Artifacts render inline in the conversation. AOS does not provide file editing, storage, or version history.

## MCP Apps

An MCP server the operator registers in the runtime's own MCP configuration
may declare an App view for a tool: server-authored HTML at a `ui://` resource.
AOS renders it as an App card; nothing about the server is configured in AOS.
The runtime runs the tool and stores its result. The gateway flags a call whose
tool declares a view when the call starts, from the tool's name and the
server's `tools/list`, or else once its result names the view. It serves the
view keyed by the tool call, sends the view the call's input once the arguments
are complete and its result once the call settles, and relays the view's own
`tools/call` and `resources/read` only to that call's server, only for a call
of that Session's own run or history. The browser never names a
server, tool, or resource URI, and never talks to an MCP server.

OpenClaw serves views natively. Hermes and OpenCode keep none, so a temporary
gateway fallback reads them with the gateway's own MCP client from the server
URL the runtime reports, and reaches only Streamable HTTP servers without
credentials or with headers the operator gave the gateway.

The view runs in a double iframe: an opaque-origin sandbox proxy that relays
messages, holding the App frame. That sandbox proxy is a static page,
`/mcp-app-sandbox.html`, which the aos-ui web server serves on both surfaces
with its own CSP, so it never
inherits the embedding page's policy; the App frame carries a CSP built from
the view's declared domains, which narrows that one. Neither frame may navigate
the top window, open popups, or submit forms. See [MCP Apps](mcp-apps.md) for the rules a view runs under.

MCP tool names are normalized in the gateway: the four `aos-ui` tools read bare,
every other MCP tool reads `mcp__<server>__<tool>` resolved against the
runtime's own server list, and an unknown name stays raw.

## Network and authentication boundary

Each lane is one origin. Caddy (`deploy/Caddyfile`) answers it, sends
`/api/v1` to the gateway's listener for that lane, and sends everything else
to the aos-ui web server, which serves the compiled application,
`/runtime-config.json`, and the guest page policy, and answers nothing under
`/api`. The gateway is API-only: every path outside `/api/v1` is 404. Caddy
answers only its configured Host names (421 otherwise), and the gateway
refuses a socket upgrade or state-changing request whose `Origin` is not in
that lane's `allowedOrigins`. The operator lane intentionally has no
application authentication: network access grants operator access. It must
therefore remain on loopback or a trusted private network, or sit behind an
operator-managed authenticated ingress. An external TLS reverse proxy is
optional infrastructure, not part of the runtime boundary.

The optional guest lane uses a distinct port and scoped, expiring JWTs; the
gateway's operator-only routes, such as invitation creation and push, answer
404 there. Operator and guest listeners share the same configured runtime
adapter, transport, and Session coordinator. Authorization and outbound
projection are the gateway's guest middleware, so a guest token grants only
its declared runtime, Agent, and conversation. Within it a guest sends,
edits and retries messages it was shown, steers, takes the composer prefill,
stops the conversation's turn, and answers questions. It never sees a
permission request, and it gets no usage, model, activity, read-state, or
catalog feed. There is no second guest Hermes credential.

Hermes authentication uses one server token read from a private file. Optional
guest invitation signing keys are also file-backed secrets. None appear in the
browser-readable `/runtime-config.json`, browser bundle, URLs, logs, or
normalized provider responses.

One multiplexed native WebSocket is retained for the configured runtime. The
Session coordinator retains an attachment while work is running, stopping,
waiting for a question or approval, reconciling, or actively observed. A
terminal unobserved Session stays warm for `runtime.sessionIdleMs` (default
300 000 ms), after which the gateway closes only that native Session attachment;
the shared socket remains open. Disconnecting or reloading a browser never
stops native work.
