# Multi-harness AOS gateway architecture

Research date: 2026-09-14. This report uses the versions already pinned by AOS:
[Hermes `5eb99eb`](https://github.com/NousResearch/hermes-agent/tree/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04),
[OpenCode 1.18.29 (`1674747`)](https://github.com/anomalyco/opencode/tree/16747470f976aca3d362ad730bcd3fe82ecc2c9a),
and [OpenClaw 2026.9.4 (`3a9d69d`)](https://github.com/openclaw/openclaw/tree/3a9d69db306cd7f081e06254cb89c4bcc14a7107).
Only first-party documentation, source, and published clients are used. Sections
labelled **AOS inference** are design conclusions rather than native-runtime facts.

## Decision

**AOS inference:** replace the single selected runtime with a small, startup-built
directory of configured runtime instances. Every public Agent, Session, run,
invitation, event subscription, and reconnect cursor is scoped by an explicit
`runtimeId`. The native Agent and Session IDs remain unchanged inside that scope;
do not encode the runtime name into either native ID.

```text
Browser (one provider-neutral client)
  -> AOS runtimeId + native Agent/Session scope
      -> runtime directory
          -> Hermes instance A  -> Hermes HTTP + one scoped WS client
          -> OpenClaw instance B -> one official GatewayClient
          -> OpenClaw instance C -> another official GatewayClient
          -> OpenCode instance D -> one SDK facade + scoped SSE streams
```

The common architecture is an **instance-routing module**, not a transport or
socket module. A configured instance owns one server runtime adapter. That adapter
owns its official/native client, native authentication, connection topology,
Session attachment/subscription, replay, reconciliation, and disposal.

This supports one Hermes plus one OpenClaw, two OpenClaws, two OpenCodes, or any
other configured combination concurrently. Two instances of the same harness are
separate directory entries and separate adapter lifecycles, even if an operator
accidentally configures equivalent endpoints. The gateway does not silently merge
declared instances.

## Verified native models

| Runtime  | Client and authentication scope                                                                                                                                                 | Session/concurrency model                                                                                                                                                                                               | Reconnect and release model                                                                                                                                                                                                                         | Multiple native instances                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hermes   | HTTP plus one JSON-RPC WebSocket for an exact backend/native-auth scope. Static server-token callers can share that scope; browser-auth cookies are distinct native identities. | One socket multiplexes requests and asynchronous events for many Sessions; event notifications carry `session_id` and per-Session sequence. Durable stored Session identity is distinct from the process-local live ID. | Reconnect obtains a fresh socket/ticket, resumes durable stored IDs, and replays by Session epoch/sequence. `session.close` tears down one live Session without closing the shared socket.                                                          | Different Hermes servers or native identities require different scoped clients.                                                                               |
| OpenCode | The official SDK is an HTTP client configured by `baseUrl`, Basic-auth headers, and directory/workspace scope.                                                                  | The server supports multiple clients. Sessions have stable IDs and durable per-Session event aggregates; each SDK SSE call owns its own HTTP stream.                                                                    | Reopen the Session SSE after its durable aggregate sequence and reconcile completed output/history. Abort the SSE to release observation; interrupt is a separate Session operation.                                                                | Separate server endpoints and/or directory/workspace scopes can coexist as separate AOS instances.                                                            |
| OpenClaw | The official `GatewayClient` owns one authenticated WebSocket. URL, TLS/edge identity, device key/token, role, scopes, and advertised capabilities affect that connection.      | The socket multiplexes concurrent RPCs and events for many Sessions. Stable routing uses `sessionKey`; `sessionId` is a transcript generation and `runId` identifies an execution.                                      | The official client reconnects, but Gateway events are not replayed. The adapter must resubscribe and reconcile `chat.history`, `inFlightRun`, and `activeRunIds`. The official Session subscription coordinator releases individual subscriptions. | OpenClaw explicitly supports isolated Gateways with unique profiles/config, state directories, workspaces, and ports. Each is a separate AOS instance/client. |

### Hermes

Hermes Desktop owns one primary connection plus scoped secondary connections for
other backends/profiles with live work; it does not create a socket per Session.
Each connection correlates JSON-RPC replies by request ID and routes asynchronous
events by `session_id`. The server attaches Sessions additively to the requesting
transport, so many Sessions and viewers can coexist on one socket.
([Desktop connection topology](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/store/gateway.ts#L17-L25),
[request correlation](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/shared/src/json-rpc-channel.ts#L117-L169),
[event routing](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/server.py#L595-L653),
[transport fan-out](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/session_transports.py#L50-L114))

The client records an epoch and sequence watermark per Session. Reconnect replays
`session.events.since`; a backend restart invalidates live IDs, so the client
resumes from the durable stored ID. OAuth-gated connections obtain a fresh,
short-lived WS ticket for every connection, while static-token URLs can reuse the
configured server credential.
([replay algorithm](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/shared/src/json-rpc-gateway.ts#L366-L489),
[Desktop reconnect](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/app/gateway/hooks/use-gateway-boot.ts#L325-L473),
[WS ticket acquisition](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/electron/main.ts#L8294-L8341))

Hermes exposes a real per-Session live-runtime release operation:
`session.close` removes the specified live Session and tears it down, rather than
closing the multiplexed socket. A later operation can resume the durable stored
Session. This lifecycle belongs in the Hermes adapter; it is not a generic AOS
hangup operation.
([`session.close`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/methods_session.py#L1880-L1884),
[`session.resume`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/methods_session.py#L658-L850))

**AOS inference:** for a static server-token Hermes instance, operators and
invited guests should use the same adapter and socket. Their upstream native
identity is identical; guest isolation is enforced before dispatch and again in
the normalized outbound projection. Browser-based Hermes auth needs a separate
adapter/socket for each distinct cookie jar/native identity, not for every tab or
every AOS Session.

### OpenCode

`opencode serve` is an HTTP/OpenAPI server. Its official documentation states
that this client/server architecture supports multiple clients, and server auth
is one HTTP Basic credential configured by `OPENCODE_SERVER_USERNAME` and
`OPENCODE_SERVER_PASSWORD`.
([server architecture and flags](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/web/src/content/docs/server.mdx#L9-L57),
[authentication](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/web/src/content/docs/server.mdx#L31-L43))

The official SDK constructor accepts a `baseUrl`, headers/fetch implementation,
directory, and workspace identity. It applies directory/workspace scope to every
request. Session records themselves carry `id`, `projectID`, optional
`workspaceID`, and `directory`; therefore a client configured for a different
directory/workspace is a different native workspace scope even when the server
URL is the same.
([SDK client construction](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/sdk/js/src/v2/client.ts#L414-L540),
[Session shape](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/sdk/js/src/v2/gen/types.gen.ts#L170-L203))

Per-Session SSE replays durable events after an aggregate sequence, while each
official SDK SSE invocation owns its own fetch and reconnect loop. Text and
reasoning deltas are live-only, but completed values are durable, so reconnect
must reconcile settled output rather than promise token-perfect replay.
([Session event protocol](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/protocol/src/groups/session.ts#L307-L343),
[SDK SSE implementation](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/sdk/js/src/v2/gen/core/serverSentEvents.gen.ts#L78-L238),
[durable/live event split](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/schema/src/session-event.ts#L27-L49))

**AOS inference:** construct one SDK facade per configured OpenCode instance and
share it across operator and guest requests that use the same server credential.
Observation remains per Session (or may use the server-wide stream if later
measurements justify it); this is an adapter-private choice. Two configured
OpenCode instances get two facades so their ownership, health, streams, and
shutdown remain independent.

### OpenClaw

OpenClaw documents one WebSocket per client, multiplexing typed requests,
responses, and server-push events after a mandatory handshake. The official
`GatewayClient` owns socket creation, request correlation, heartbeat/stall
detection, reconnect backoff, and connection callbacks. Its options show that
URL, edge/TLS details, shared or device tokens, device identity, role, scopes,
and capabilities are connection inputs.
([Gateway architecture](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/docs/concepts/architecture.md#L24-L82),
[`GatewayClient` options](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/packages/gateway-client/src/client.ts#L223-L281),
[protocol client lifecycle](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/packages/gateway-client/src/protocol-client.ts#L38-L145))

The official Session subscription coordinator keeps one targeted native
subscription per canonical Session on a client and leases it to local consumers.
Events are not replayed after reconnect: the documented client procedure is to
resubscribe, replace state from `chat.history`, adopt `inFlightRun` and exact
`activeRunIds`, and then process run-scoped sequence numbers.
([subscription coordinator](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/packages/gateway-client/src/session-subscriptions.ts#L61-L180),
[reconnect recovery](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/docs/gateway/clients.md#L153-L204))

OpenClaw's canonical routing identity is `sessionKey`; the row's `sessionId` is
a rotating transcript generation and must not become the stable URL identity.
OpenClaw officially supports multiple isolated Gateway processes by assigning
each a distinct profile/config, state directory, workspace, and port.
([stable Session URLs](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/docs/web/urls.md#L50-L65),
[multiple Gateways](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/docs/gateway/multiple-gateways.md#L1-L92))

**AOS inference:** construct one official client per configured OpenClaw instance
and native authentication contract. Operator and guest traffic may share it when
they deliberately use the same device identity, token, role, scopes, and
capabilities; AOS authorization still filters each request and emitted event. If
the guest lane is intentionally paired with reduced native scopes, it is a
different native auth scope and needs a different client. Never share one client
between two configured OpenClaw runtime IDs.

## Shared concerns versus adapter-private concerns

| Shared AOS module concerns                                          | Runtime-adapter implementation concerns                           |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Strict startup config and unique stable `runtimeId`                 | HTTP, SSE, or WebSocket topology                                  |
| Deterministic instance catalog and exact instance lookup            | Official client construction and native credentials               |
| Explicit `{ runtimeId, agentId, sessionId }` ownership scope        | Native Agent/Session/run identity conversion                      |
| Operator/invitation authorization before native dispatch            | Socket multiplexing, SSE selection, and subscription fan-out      |
| Normalized REST, AG-UI, invalidations, and redacted errors          | Heartbeats, backoff, replay positions, and authoritative recovery |
| Run conflicts, idempotency, uncertain-send policy, and Stop outcome | Native prompt admission and cancellation semantics                |
| Reconnect cursor and invitation binding to `runtimeId`              | Hermes resume/close, OpenCode SSE abort, OpenClaw unsubscribe     |
| Independent instance health and graceful shutdown                   | Connection sharing/caching within one native auth scope           |

The runtimes share a lifecycle **shape**, not a connection algorithm. A universal
`SocketPool`, `ConnectionLease`, `resume(nativeId)`, or provider-position type
would expose almost as much complexity as its implementations and force at least
one runtime to invent meaningless concepts.

## Small deep TypeScript modules

Use the existing `ServerRuntime` as the normalized runtime seam. Add only one
instance-level seam above it:

```ts
type RuntimeInstanceId = string

type RuntimeDescriptor = {
  id: RuntimeInstanceId
  kind: "hermes" | "opencode" | "openclaw"
  label: string
}

type RuntimeAccess =
  | { kind: "operator"; principalId: string }
  | { kind: "guest"; invitationId: string }

interface ServerRuntimeInstance {
  readonly descriptor: RuntimeDescriptor
  runtimeFor(access: RuntimeAccess): Promise<ServerRuntime>
  close(): Promise<void>
}

interface RuntimeDirectory {
  list(): readonly RuntimeDescriptor[]
  require(id: RuntimeInstanceId, access: RuntimeAccess): Promise<ServerRuntime>
  close(): Promise<void>
}
```

`ServerRuntimeInstance` is the adapter seam implemented by Hermes, OpenCode, and
OpenClaw composition. A static-token instance returns the same `ServerRuntime`
for operator and guest access. Hermes browser auth may return a principal-bound
runtime. An OpenClaw instance may select a shared or separately scoped official
client according to its configured native credentials. Those caches stay private
to the adapter implementation.

`RuntimeDirectory` is a deep module: it validates unique IDs, preserves config
order, resolves the exact instance, owns each instance lifecycle, and closes each
instance once. Its implementation can be a `Map`; callers and tests do not need
to know that. A known-kind `switch` constructs the three adapters from the strict
discriminated config. No dynamic plugin loader or runtime registration protocol
is needed.

Every normalized entity reference is an explicit tuple:

```ts
type AgentScope = { runtimeId: RuntimeInstanceId; agentId: string }
type SessionScope = AgentScope & { sessionId: string }
```

The protocol and browser URL should carry `runtimeId` as its own field/path
segment. This permits `default` Agent and identical-looking native Session IDs in
two instances without collision, while preserving the native IDs verbatim. Add
`runtimeId` to active-run keys, invalidations, invitation claims, artifact scope,
and sealed reconnect cursors so no cross-instance value can be replayed.

The runtime catalog is workspace control-plane state. Each instance reports
authentication, availability, and capabilities independently; one unavailable
harness must not make healthy instances unusable. Invalid configuration still
fails startup, while a configured but offline native server produces that
instance's normalized unavailable state.

## Client sharing rules

Client sharing is decided inside one adapter by **native connection identity**,
not by browser tab and not automatically by AOS operator/guest role:

1. Share only within one configured `runtimeId`.
2. Share when every connection-affecting native input is the same.
3. Never broaden native credentials merely to make clients shareable.
4. Route/fan out only normalized events after exact AOS scope authorization.

Applied to the three adapters:

- Hermes static server token: one HTTP client/socket for that instance, shared by
  operators and guests. Hermes browser auth: one scoped client per distinct
  cookie jar/native identity. All Sessions on that client multiplex; idle live
  Sessions can be released with `session.close`.
- OpenCode Basic auth: one SDK facade per instance, shareable by operators and
  guests because the credential is server-wide. Individual observed Sessions
  still own independent SSE lifecycles.
- OpenClaw: one `GatewayClient` per exact URL/TLS/device/token/role/scopes/caps
  contract. Share it across AOS roles only when that complete native contract is
  intentionally identical. Sessions multiplex and the official subscription
  coordinator handles per-Session release.

## Verification implications

Tests should exercise the directory and each adapter through their interfaces:

- Configure Hermes + OpenClaw + two distinct OpenClaw instances; prove all four
  catalogs and runs can progress concurrently and one outage does not block the
  others.
- Give two instances the same native Agent and Session strings; prove REST,
  AG-UI, Stop, interactions, artifacts, invalidations, and reconnect stay scoped
  by `runtimeId` without rewriting those strings.
- Prove invitations and reconnect cursors issued for instance A are rejected for
  instance B before any native client call.
- Prove static-token Hermes and Basic-auth OpenCode reuse one native client for
  authorized operator and guest calls, while two browser-auth Hermes principals
  do not share a cookie jar/socket.
- Prove OpenClaw shares one socket across concurrent Sessions in one instance,
  creates separate clients for two configured Gateways or native auth contracts,
  and restores subscriptions/history after reconnect.
- Prove Hermes `session.close`, OpenCode SSE abort, and OpenClaw subscription
  release affect only the intended native Session observation.
- Prove directory shutdown closes each configured instance exactly once and does
  not expose native URLs, tokens, cookies, device keys, payloads, or positions.

## Bottom line

Multi-harness support requires a stable runtime-instance dimension and a small
directory of runtime adapters. It does **not** require a shared connection
library. The adapters can all satisfy the same normalized `ServerRuntime` while
using the native model that already fits them: multiplexed Hermes JSON-RPC,
OpenCode HTTP/replayable SSE, and the official multiplexed OpenClaw client.
