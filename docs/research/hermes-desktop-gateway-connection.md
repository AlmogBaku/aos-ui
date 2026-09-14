# Hermes Desktop gateway connection architecture

Research date: 2026-09-14. “Current upstream” below means
[`NousResearch/hermes-agent@5eb99eb`](https://github.com/NousResearch/hermes-agent/tree/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04).
The local comparison is `/home/anakin/work/fix-cron-standalone-delivery-ack` at
`793741fceaf84b0a0557f669148ee3ba42f8a65b`. Only repository source and its
current documentation/comments were used; statements labelled **Inference**
are architectural conclusions rather than explicit upstream promises.

## Short answer

Hermes Desktop does **not** open a WebSocket per Session. It maintains one
primary WebSocket per renderer window and lazily keeps one secondary WebSocket
per other live backend scope. A backend scope is effectively the exact
`(connectionId, profile)` owner; a shared remote backend can instead reuse the
primary socket and place `profile` in each request. Multiple Sessions therefore
multiplex over the same scoped socket, with JSON-RPC request IDs correlating
responses and `session_id` plus a per-Session `seq` routing asynchronous events.

This is not a stateless transport. A live Hermes runtime Session retains the
WebSocket transport(s) attached to it. Desktop consequently preserves the exact
owner route, holds a socket across `session.create -> attachment(s) ->
prompt.submit`, and keeps a turn lease after the immediate submit ACK until a
terminal event. Closing that socket detaches its Session membership and invokes
the server's orphan policy.

## Connection and multiplexing model

- Upstream describes the topology directly: one primary/window socket plus one
  persistent secondary for each *other profile with live work*; all feed the
  same Session-keyed event handler. Single-profile use has only the primary.
  ([`apps/desktop/src/store/gateway.ts:17-25`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/store/gateway.ts#L17-L25))
- Each secondary owns one `HermesGateway` and is keyed by a scoped backend
  identity. Independent registry sources use composite scopes so identically
  named profiles do not alias. Shared-remote profiles deliberately reuse the
  primary socket; dedicated local/remote profiles get a pooled secondary.
  ([`gateway.ts:789-846`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/store/gateway.ts#L789-L846),
  [`gateway.ts:849-902`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/store/gateway.ts#L849-L902))
- **Inference:** one scoped socket multiplexes all of that scope's Sessions. The
  evidence is that there is one `HermesGateway` per scope rather than per
  Session, while events on it are keyed by `session_id`; Session creation stores
  the request's current transport in the server-side Session record.
  ([`tui_gateway/methods_session.py:318-389`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/methods_session.py#L318-L389))
- The gateway server accepts each `/api/ws` upgrade as a separate
  `WSTransport`, sends `gateway.ready`, registers it for global events, and
  dispatches every received JSON-RPC object with that transport bound as request
  context. There is no server-wide “only one Desktop socket” restriction.
  ([`tui_gateway/ws.py:265-368`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/ws.py#L265-L368))

## RPC correlation and event routing

- Each connection has a monotonically generated request ID and one pending-call
  map. The client sends `{jsonrpc, id, method, params}` and resolves/rejects the
  matching pending promise when a response with that `id` arrives. Detaching a
  transport rejects every in-flight request; requests are not transparently
  replayed. ([`apps/shared/src/json-rpc-channel.ts:117-169`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/shared/src/json-rpc-channel.ts#L117-L169),
  [`json-rpc-channel.ts:177-255`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/shared/src/json-rpc-channel.ts#L177-L255),
  [`json-rpc-channel.ts:263-305`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/shared/src/json-rpc-channel.ts#L263-L305))
- Asynchronous messages are JSON-RPC notifications with `method: "event"`.
  Session events carry `session_id`; the server routes them through the Session's
  attached transport, stamps a per-Session monotonic `seq`, and sends sessionless
  global events to all live transports.
  ([`tui_gateway/server.py:595-653`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/server.py#L595-L653))
- The client records a sequence watermark per `session_id`. After reconnect it
  calls `session.events.since` once per known Session, holds racing live frames,
  and deduplicates by sequence. A changed replay epoch means the backend process
  restarted, so old watermarks are discarded.
  ([`apps/shared/src/json-rpc-gateway.ts:102-126`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/shared/src/json-rpc-gateway.ts#L102-L126),
  [`json-rpc-gateway.ts:366-390`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/shared/src/json-rpc-gateway.ts#L366-L390),
  [`json-rpc-gateway.ts:418-489`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/shared/src/json-rpc-gateway.ts#L418-L489))

## Session lifecycle and socket ownership

| Operation | Current upstream behavior |
| --- | --- |
| `session.create` | Mints a process-local runtime ID and durable stored ID, associates the current request transport, schedules lazy agent construction, and normally defers the database row until first prompt. |
| `session.resume` | Accepts the durable stored ID. If the same profile already has the Session live, it attaches the caller to that live runtime; otherwise it hydrates/mints a new runtime according to resume mode. ([`methods_session.py:658-680`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/methods_session.py#L658-L680), [`methods_session.py:819-850`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/methods_session.py#L819-L850)) |
| `session.activate` | Accepts a live runtime ID and attaches the current transport without closing the previously focused Session. ([`methods_session.py:922-934`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/methods_session.py#L922-L934)) |
| `prompt.submit` | Looks up the runtime ID, attaches the request's current transport, cancels any orphan-reap timer, starts a daemon turn thread, and immediately returns `status: streaming`; completion arrives as events. ([`tui_gateway/methods_prompt.py:544-604`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/methods_prompt.py#L544-L604), [`methods_prompt.py:650-662`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/methods_prompt.py#L650-L662)) |

Current upstream attachment is additive: a Session can have multiple live
transport members through `FanoutTransport`; attaching a new client does not
displace an existing subscriber. The server only treats a disconnect as
clientless after the last member is removed.
([`tui_gateway/session_transports.py:1-35`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/session_transports.py#L1-L35),
[`session_transports.py:50-114`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/session_transports.py#L50-L114))

Transport membership and turn-writer ownership are separate. `prompt.submit`
first claims the durable Session's active-writer lease and can fail closed with
`SESSION_NOT_OWNED`/`SESSION_COORDINATION_UNAVAILABLE`; `session.create` and
`session.resume` do not themselves claim it. It then additively attaches the
request socket before starting the turn. A second authenticated login attaching
to a known live Session is only warned about—not rejected by the transport
membership layer—and the Session retains its creator identity.
([`tui_gateway/methods_prompt.py:544-604`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/methods_prompt.py#L544-L604),
[`hermes_cli/active_sessions.py:433-524`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/hermes_cli/active_sessions.py#L433-L524),
[`tui_gateway/session_transports.py:38-47`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/session_transports.py#L38-L47))

Desktop records the exact `(connectionId, profile)` route that created or
resumed a runtime and uses it for every Session-scoped RPC; the currently active
gateway is explicitly not treated as routing authority.
([`apps/desktop/src/store/session-request-router.ts:5-17`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/store/session-request-router.ts#L5-L17),
[`session-request-router.ts:48-64`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/store/session-request-router.ts#L48-L64))
It also holds a routed socket across the create/attach/submit sequence because
closing it between calls detaches the newly minted runtime, and it holds a
separate turn lease after `prompt.submit` ACKs until the terminal event; otherwise
the 20-second orphan guard can interrupt a still-running turn as `client_gone`.
([`gateway.ts:1190-1199`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/store/gateway.ts#L1190-L1199),
[`gateway.ts:1308-1315`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/store/gateway.ts#L1308-L1315))

## Disconnect, reaping, and recovery

On WebSocket close the server unregisters and closes that transport, removes its
Session memberships, and then applies one teardown path. If another live member
remains, the Session keeps streaming. If this was the last member,
`close_on_disconnect` Sessions are reaped immediately; other Sessions are parked
on a drop transport and scheduled for orphan reaping.
([`tui_gateway/ws.py:371-405`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/ws.py#L371-L405),
[`tui_gateway/session_lifecycle.py:621-678`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/session_lifecycle.py#L621-L678))

The default orphan grace is 20 seconds. An idle orphan is then reaped. A running
orphan whose activity is still fresh continues detached and is checked again;
the freshness threshold defaults to 600 seconds. Once stale, the turn is
interrupted once, polled every second, and force-reaped after at most 60 polls.
An attach/resume during the grace cancels the timer.
([`tui_gateway/server.py:121-147`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/server.py#L121-L147),
[`tui_gateway/session_lifecycle.py:494-505`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/session_lifecycle.py#L494-L505),
[`session_lifecycle.py:534-606`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/session_lifecycle.py#L534-L606))

A separate last-resort detached-idle reaper defaults to six hours and excludes
Sessions that are running, pending/building, or still have a live transport.
([`tui_gateway/server.py:357-365`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/server.py#L357-L365),
[`tui_gateway/session_reaper.py:150-185`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/session_reaper.py#L150-L185))

Desktop detects silent half-open sockets with a 15-second heartbeat and a
45-second liveness deadline. Its primary reconnect loop also reacts to power
resume, network online, and visibility, revalidates remote state, obtains a fresh
WS URL, and uses full-jitter exponential backoff (300 ms base, 15 s cap). A
backend respawn invalidates process-local runtime IDs, so the renderer clears
bindings and resumes from durable stored IDs; stale-Session calls use a
single-flight `session.resume` and one bounded retry.
([`json-rpc-channel.ts:310-352`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/shared/src/json-rpc-channel.ts#L310-L352),
[`apps/desktop/src/app/gateway/hooks/use-gateway-boot.ts:219-226`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/app/gateway/hooks/use-gateway-boot.ts#L219-L226),
[`use-gateway-boot.ts:325-417`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/app/gateway/hooks/use-gateway-boot.ts#L325-L417),
[`use-gateway-boot.ts:459-473`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/app/gateway/hooks/use-gateway-boot.ts#L459-L473),
[`apps/desktop/src/app/session/hooks/use-prompt-actions/utils.ts:110-149`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/app/session/hooks/use-prompt-actions/utils.ts#L110-L149))

Secondary sockets use the same jittered reconnect shape. Current upstream parks
a secondary after three *stalled* automatic dials (slot wait/timeout), while fast
transport failures keep retrying; an explicit open/wake rearms the budget.
Desktop prunes secondaries that are neither active, retained, foreground-pinned,
nor serving running/needs-input work. Open sockets are touched so the backend
idle reaper does not kill a backend still in use.
([`gateway.ts:674-713`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/store/gateway.ts#L674-L713),
[`gateway.ts:1681-1701`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/store/gateway.ts#L1681-L1701),
[`gateway.ts:1722-1735`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/store/gateway.ts#L1722-L1735),
[`gateway.ts:1760-1822`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/store/gateway.ts#L1760-L1822))

## HTTP, WebSocket, and authentication split

Desktop uses authenticated HTTP/IPC for durable/read-mostly control-plane data
such as configuration, profile/session lists, history and artifacts; for example,
session lists are GETs to `/api/sessions` or `/api/profiles/sessions`.
Live runtime lifecycle/mutations and streaming use JSON-RPC over `/api/ws`.
([`apps/desktop/src/api/client.ts:5-38`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/api/client.ts#L5-L38),
[`apps/desktop/src/api/sessions.ts:84-145`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/api/sessions.ts#L84-L145),
[`tui_gateway/ws.py:1-4`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/ws.py#L1-L4))
Desktop's own README calls REST the authority for complete transcripts; a
resume can fetch REST history concurrently with the live `session.resume` RPC.
([`apps/desktop/README.md:95-103`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/README.md#L95-L103),
[`apps/desktop/src/app/session/hooks/use-session-actions/index.ts:1591-1616`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/app/session/hooks/use-session-actions/index.ts#L1591-L1616))

For OAuth-gated remotes, REST uses a native bearer token or Electron's HttpOnly
cookie partition. A WS upgrade uses a single-use ticket from
`POST /api/auth/ws-ticket`; it has roughly a 30-second TTL, so Electron mints a
fresh ticket immediately before every connect/reconnect. Local/static-token
connections reuse their long-lived token URL. Hard auth rejection becomes a
sign-in-required state rather than an endless reconnect loop.
([`apps/desktop/electron/main.ts:7445-7471`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/electron/main.ts#L7445-L7471),
[`main.ts:8294-8341`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/electron/main.ts#L8294-L8341),
[`main.ts:15992-16030`](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/electron/main.ts#L15992-L16030))

## Local checkout differences

The local checkout already has the same high-level Desktop topology: primary
per window, persistent secondary per other live profile
(`/home/anakin/work/fix-cron-standalone-delivery-ack/apps/desktop/src/store/gateway.ts:11-19`),
exact Session owner routing, turn leases, event replay, 20-second orphan grace,
and activity-aware reaping.

Two relevant differences from current upstream are material:

1. Local Session attachment is single-owner-with-viewer-fallback, not true
   additive fanout. `prompt.submit` replaces `session["transport"]` with the
   current request transport
   (`/home/anakin/work/fix-cron-standalone-delivery-ack/tui_gateway/methods_prompt.py:471-475`),
   and disconnect hands ownership to the newest surviving viewer or parks it
   (`.../tui_gateway/server.py:1601-1677`). Upstream's
   `session_transports.py` instead attaches multiple simultaneous members and
   only orphans the Session after the last one leaves.
2. Local secondaries retry transient/stalled dials indefinitely with capped
   jitter and touch every `wantOpen` entry
   (`.../apps/desktop/src/store/gateway.ts:620-670`,
   `:1605-1614`). Current upstream adds the three-stalled-dial parking budget,
   foreground spawn priority, recovery rearming, and limits backend touches to
   sockets that are actually open.

The shared JSON-RPC implementation was also refactored upstream from the local
single `apps/shared/src/json-rpc-gateway.ts` into a transport-neutral request
channel plus WS client. The core semantics—one pending map per connection,
ID-correlated replies, `session_id`/`seq` event routing, heartbeat, and reconnect
replay—remain the same.

## Architectural implication for AOS

**Inference:** the closest compatible design is a connection manager keyed by
exact backend scope, with one multiplexed WS per scope and many AOS Sessions on
it—not one WS per Session and not one global WS for unrelated backends. Preserve
the durable stored ID separately from the ephemeral runtime ID, pin the owner
scope for every Session RPC, retain the socket from creation through active-turn
completion, and use `session.resume` after a lost runtime generation. If AOS
adds its own browser-facing gateway, it should fan events by `session_id` and
sequence while preserving JSON-RPC request IDs; it must not release its upstream
Hermes socket merely because one downstream tab disconnects while other tabs or
turns still depend on that scope.

## Primary sources

- [Hermes Agent repository at the researched upstream revision](https://github.com/NousResearch/hermes-agent/tree/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04)
- [Desktop scoped gateway manager](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/desktop/src/store/gateway.ts)
- [Shared JSON-RPC request channel](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/shared/src/json-rpc-channel.ts)
- [Shared reconnect/replay client](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/apps/shared/src/json-rpc-gateway.ts)
- [Gateway WebSocket transport](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/ws.py)
- [Session transport membership](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/session_transports.py)
- [Session disconnect lifecycle](https://github.com/NousResearch/hermes-agent/blob/5eb99eb2844b22ebb723711b8e6a0bbb80bb5f04/tui_gateway/session_lifecycle.py)
