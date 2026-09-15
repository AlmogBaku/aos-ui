# OpenCode/OpenClaw runtime transport seams

Research date: 2026-09-14. This report uses only official repository sources at
the versions currently pinned by AOS: [OpenCode 1.18.29
(`1674747`)](https://github.com/anomalyco/opencode/tree/16747470f976aca3d362ad730bcd3fe82ecc2c9a)
and [OpenClaw 2026.9.4
(`3a9d69d`)](https://github.com/openclaw/openclaw/tree/3a9d69db306cd7f081e06254cb89c4bcc14a7107).
Facts verified from those sources are separated from the AOS design inference.

## Answer

Keep the Session/run management already built, but do **not** move a concrete
Hermes-style connection manager into a common cross-runtime layer. The common
layer should define normalized AOS Session/run semantics and acquire/release an
opaque Session observation. Each runtime adapter should own its official client,
native identities, connection topology, replay/reconciliation, and cancellation
mapping.

| Runtime | Native connection and event model | Native Session/run identity | Resume/reconnect and stop |
| --- | --- | --- | --- |
| Hermes | One persistent JSON-RPC WebSocket per exact backend scope, multiplexing Sessions | Durable stored ID plus process-local live ID | `session.resume` remaps stored to live identity; socket replay uses Session sequence; interruption uses the live Session |
| OpenCode | Ordinary HTTP RPCs; SSE is available as a server-wide live stream or a replayable per-Session stream | Stable `sessionID`; admitted prompt has a caller-supplied or generated message ID, but no public run ID | Reopen Session SSE from a durable aggregate sequence; `prompt.resume` is a wake flag, not identity resume; interrupt is Session-wide |
| OpenClaw | One persistent, multiplexed WebSocket per authenticated client/lane | Stable `sessionKey`, rotating transcript-generation `sessionId`, and native `runId` | Reconnect the client, resubscribe, and reconcile from history/current active runs; abort can target an exact `runId` |

The three runtimes therefore share a lifecycle *shape*, not a connection or
Session-resume algorithm.

## Verified facts

### OpenCode

- OpenCode's headless server is HTTP, and the official protocol exposes Session
  creation, lookup, prompt admission, event observation, and interruption as
  separate endpoints. A prompt is durably admitted and normally schedules the
  agent loop; callers may supply its message ID. The public `resume` field is a
  Boolean controlling whether the loop is woken after admission.
  ([protocol definitions](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/protocol/src/groups/session.ts#L109-L223),
  [implementation](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/core/src/session.ts#L360-L385))
- `GET /api/session/:sessionID/event` is a per-Session SSE endpoint. It replays
  durable events after an exclusive aggregate sequence and then remains open for
  new durable events. The finite history endpoint uses the same Session aggregate.
  ([protocol](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/protocol/src/groups/session.ts#L307-L343),
  [Session event/history implementation](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/core/src/session.ts#L346-L358))
- OpenCode also exposes a server-wide `/api/event` SSE route. That stream is a
  bounded live subscription and does not offer the per-Session `after` replay
  contract, so its connection topology and recovery behavior are different.
  ([event protocol](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/protocol/src/groups/event.ts#L29-L45),
  [event handler](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/server/src/handlers/event.ts#L20-L48))
- Each official SDK SSE invocation creates its own async stream and HTTP fetch.
  It supports abort and reconnects failed streams with bounded exponential
  backoff; it is not a singleton connection shared across Sessions.
  ([SSE client](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/sdk/js/src/v2/gen/core/serverSentEvents.gen.ts#L78-L238))
- Durable ordering is keyed by `sessionID`. Text/reasoning delta fragments are
  explicitly live-only, while their completed full-value events are replayable.
  A reconnect can reconstruct settled output, but must not assume that every
  token delta will replay.
  ([durable aggregate definition](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/schema/src/session-event.ts#L27-L49),
  [text event boundary](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/schema/src/session-event.ts#L197-L231))
- The public stop operation is `POST /api/session/:sessionID/interrupt`; it
  interrupts execution owned by that OpenCode process and is a no-op when the
  Session is idle. There is an internal core `resume(sessionID)`, but no public
  identity-changing resume endpoint in this protocol.
  ([interrupt protocol](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/protocol/src/groups/session.ts#L345-L357),
  [core lifecycle methods](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/core/src/session.ts#L421-L431))

### OpenClaw

- The Gateway exposes typed requests, responses, and server-push events over
  WebSocket. The documented topology is one WebSocket per client, with concurrent
  RPCs and events multiplexed after a mandatory handshake.
  ([architecture](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/docs/concepts/architecture.md#L24-L37),
  [wire lifecycle](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/docs/concepts/architecture.md#L55-L82))
- The official `GatewayProtocolClient` owns the single socket, handshake,
  request correlation, event listener fan-out, close handling, and reconnect
  backoff. Its pending-request table multiplexes RPCs by generated request ID.
  ([reference client](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/packages/gateway-client/src/protocol-client.ts#L38-L145),
  [pending requests](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/packages/gateway-client/src/pending-request.ts#L47-L156),
  [reconnect handling](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/packages/gateway-client/src/protocol-client.ts#L447-L533))
- Session list and message subscriptions belong to the current WebSocket and end
  on disconnect. The official subscription coordinator keeps one targeted wire
  observer per canonical Session for each client and leases it to multiple local
  consumers.
  ([subscription RPCs](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/docs/gateway/protocol/rpc-session-control.md#L17-L18),
  [coordinator ownership](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/packages/gateway-client/src/session-subscriptions.ts#L61-L90),
  [one coordinator per client](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/packages/gateway-client/src/session-subscriptions.ts#L404-L425))
- Gateway events are not replayed. After reconnect, clients must resubscribe,
  reload `chat.history`, adopt any `inFlightRun`, reconcile `activeRunIds`, and
  continue per-run processing by `runId` and payload `seq`. The outer WebSocket
  event sequence resets with the connection.
  ([non-replay invariant](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/docs/concepts/architecture.md#L144-L148),
  [official recovery procedure](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/docs/gateway/clients.md#L153-L181),
  [sequence scopes](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/docs/gateway/clients.md#L199-L204))
- The canonical routing identity is the stable Session key; the row's `sessionId`
  is a rotating transcript generation and is deliberately excluded from stable
  URLs. Chat stream events carry `sessionKey`, `runId`, and per-run `seq`.
  ([stable URL identity](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/docs/web/urls.md#L50-L65),
  [chat event schema](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/packages/gateway-protocol/src/schema/logs-chat.ts#L298-L305))
- `sessions.abort` accepts a Session key and optional `runId`; providing the run
  ID scopes cancellation to that run. Closing the client socket is not the stop
  operation: Gateway RPC work survives ordinary disconnects.
  ([Session control](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/docs/gateway/protocol/rpc-session-control.md#L28-L35),
  [transport-independent run state](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/gateway/server-connection-state.ts#L18-L33))

## Architectural inference for AOS

Preserve the common `ServerRunEngine`/`ServerRunHandle` concepts and the existing
downstream AOS event service. Change only the provider leak at the observation
boundary: a common `resume(scope) -> { liveSessionId }` followed by
`observe(liveSessionId, ...)` encodes Hermes's identity model and makes OpenCode
and OpenClaw manufacture a meaningless live ID.

A provider-neutral seam should instead be one operation, conceptually:

```ts
observeSession(
  scope: ServerRunScope,
  observer: { invalidate(): void; reset(): void },
): Promise<{ stop(): void }>
```

Each adapter implements that seam differently:

- **Hermes:** resolve durable stored ID to the current live ID with
  `session.resume`, attach it to the persistent scoped lane, and replay by native
  Session sequence.
- **OpenCode:** retain the stable `sessionID`, acquire/ref-count that Session's
  SSE stream, resume after the last durable aggregate sequence, deduplicate any
  replay overlap, and reconcile live-only deltas from completed events/history.
- **OpenClaw:** acquire/ref-count the official client's Session message
  subscription, retain `sessionKey` plus observed generation `sessionId`, and on
  reconnect resubscribe and reconcile history/active runs.

For connection ownership, OpenCode needs a long-lived SSE request only while AOS
wants live observation; the adapter may choose one live server stream or
reference-counted per-Session streams. OpenClaw needs one persistent official
client per AOS authorization lane, not per Session. Its operator and guest lanes
should use distinct clients because handshake identity, scopes, device
credentials, and subscriptions are connection-scoped.

The common layer may own AOS public identity/ownership checks, normalized run
conflict and stop semantics, downstream cursoring/invalidation, authorization
lane isolation, leases, and disposal of a runtime instance. It should **not** own
a universal socket/SSE client, native reconnect cursor, native Session identity
map, or native subscription registry. OpenClaw already provides the latter
connection machinery; OpenCode has a different per-stream HTTP lifecycle; and
Hermes genuinely needs its stored-to-live resume map.

This keeps the built Hermes Session management intact inside the Hermes adapter
while avoiding a second, parallel Session manager for OpenCode/OpenClaw. The
cross-runtime architecture stays shared at the semantic boundary and deliberately
shallow at the transport boundary.
