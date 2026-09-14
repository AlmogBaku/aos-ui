# AOS runtime gateway V1

This document defines the complete V1 target for the AOS runtime gateway. It is
a deliberately small deployment slice of the
[ideal gateway architecture](aos-runtime-gateway-architecture.md), not a second
architecture.

## Outcome

V1 provides one working Hermes-backed AOS workspace:

```text
React + assistant-ui
        |
        | AOS REST + events WebSocket + AG-UI runs
        v
TypeScript gateway
        |
        | one selected ServerRuntime
        v
Hermes adapter
        |
        | authenticated HTTP + one multiplexed WebSocket
        v
Hermes dashboard API
```

The browser communicates only with normalized AOS and AG-UI endpoints. Hermes
URLs, credentials, live Session IDs, payloads, and native event positions stay
server-side.

## Deployment and runtime selection

One gateway deployment has:

- one implicit Tenant and operator;
- one configured Runtime definition;
- one server-side adapter selected from a discriminated Runtime configuration;
- one Hermes adapter implementation;
- one Hermes server token loaded from a secret file;
- one Hermes Runtime instance and native connection.

The composition root selects the adapter. Routes, authorization, run
coordination, and browser code depend only on `ServerRuntime`. Adding a future
adapter must not require provider branches in those modules. V1 does not expose
multiple Runtime definitions concurrently and does not add empty OpenCode or
OpenClaw implementations.

The Bun gateway may serve the built Vite application and normalized endpoints
directly. A reverse proxy or TLS terminator is optional deployment
infrastructure, not an application requirement.

## Access model

### Operator listener

The operator listener has no application login. Network access to its trusted
port grants the single operator context and full access to the selected
Runtime. Every browser that can reach this listener sees all visible Hermes
Agents and their Sessions.

The listener remains loopback- or private-network-bound by default. Exact
origin checks, input limits, redaction, and safe error handling still apply;
they are request protections rather than user authentication.

### Guest listener

Guests use a physically separate listener and origin. Every guest operation
requires an expiring, scoped invitation JWT verified with `jose`. The grant is
bound to the deployment, selected Runtime, Agent and optional Session, allowed
operations, output capabilities, and expiry.

Operator and guest requests use the same Hermes Runtime instance, native
connection, Session attachment registry, and run coordinator. Isolation is
provided by request authorization, event routing, reconnect binding, and
outbound projection—not by creating a second Hermes connection.

Guest output excludes information outside the grant, including hidden Agents,
reasoning when prohibited, private tool and approval data, provider metadata,
native paths, live Session IDs, credentials, and native reconnect positions.

## Hermes authentication and connection

V1 supports configured Hermes server-token authentication only. The token is
read from an owner-only secret file and is never serialized, logged, or placed
in public runtime configuration.

The Hermes adapter owns one long-lived, reconnecting JSON-RPC WebSocket for the
configured Runtime instance. All RPC responses correlate by request ID and all
Session events route by native live Session ID and sequence. HTTP remains the
authority for catalogs, durable Session data, history, and content operations.

A reconnect reopens the native socket with the configured server token,
restores required Session bindings, recovers available native events, and then
reconciles authoritative state. An uncertain mutation is never retried
automatically.

## Session and run lifetime

V1 separates four pieces of state:

1. Hermes owns the durable Session and transcript.
2. The shared gateway run coordinator owns logical run admission and terminal
   settlement.
3. The Hermes adapter owns the durable-to-live Session binding.
4. The Hermes Runtime instance owns the multiplexed WebSocket.

The run coordinator has one entry for each Agent and durable Session. It is
shared by operator and guest listeners. It retains a run while Hermes reports
it as running, stopping, or waiting for a question or approval. Browser
disconnect removes only that downstream stream and never stops or settles the
run.

The Hermes adapter maintains one single-flight attachment for each durable
Session. It retains the live binding while any of these conditions applies:

- the run is active or stopping;
- a question or approval is unresolved;
- native acknowledgement or authoritative reconciliation is in progress;
- the Session is within its warm-idle grace period.

The warm-idle timer begins after terminal idle state and defaults to five
minutes through one Hermes adapter setting. Relevant authorized Session
activity refreshes it. When it expires and no retaining condition exists, the
adapter calls native `session.close`, discards only the live ID, and keeps the
durable Session and history. The next operation uses `session.resume` and
reconciles before proceeding. Releasing one Session never closes the shared
Hermes WebSocket or affects another Session.

This policy is Hermes-specific. V1 does not create a generic transport or
cross-provider Session-retention framework.

## Workspace behavior

The browser uses one thin provider-neutral AOS runtime client and preserves the
existing assistant-ui workspace and components.

V1 supports:

- normalized runtime status and operation-valued capabilities;
- Hermes profile catalog and revision-checked Agent visibility;
- a recent Session page of 50 rows, additional pages on demand, and a maximum
  requested page size of 100;
- history loaded only for the opened Session, 200 rows by default and 500
  maximum per page;
- chronological compacted history with stable native message and durable
  Session IDs;
- rename and delete where the native operation supports them;
- models, context, Todos, activity, and suggestions where Hermes exposes them;
- attachments, artifacts, images, and native audio operations where supported;
- capability-driven unavailable states for unsupported native operations.

`New Session` creates a browser draft only. On first Send, Assistant UI queues
the turn while initialization creates one Hermes Session and returns its
durable ID. The queued turn is then submitted exactly once to that ID, and the
browser replaces the draft URL with the native durable Session ID. A definite
first-run rejection cleans up the empty Session; an uncertain submission is
neither retried nor deleted automatically. Abandoning a draft creates no
Hermes Session.

Native IDs remain unchanged. Provider names, profile names, and runtime IDs are
not encoded into Session IDs for URL formatting.

## Runs and interactions

Standard AG-UI represents messages, streaming, reasoning, tool calls, custom
UI, usage, lifecycle, and run interruption. The gateway accepts exactly one
authorized new user turn or one response bound to an existing interrupt.
Browser history, state, tools, and context are not authoritative provider
input.

Questions and approvals remain part of the same logical Hermes execution. An
interrupted AG-UI segment ends with `RUN_FINISHED` and an interrupt outcome. An
authorized response starts a fresh AG-UI `runId` carrying `resume[]`, while the
coordinator retains the logical execution and streams the eventual final
assistant response. Operator and guest lanes share admission state but retain
distinct control permissions.

Stop remains `stopping` until a terminal native event or authoritative idle
read proves settlement. Lost acknowledgement produces `uncertain`, not a false
success or automatic retry.

## Reconnect

Browser reload and network interruption do not own native execution lifetime.
Reconnect performs:

```text
authorize scope
  -> read authoritative history and pending interaction
  -> locate or reconstruct the active run
  -> restore Hermes attachment and event position
  -> replay available events
  -> reconcile authoritative state
  -> resume normalized delivery
```

The coordinator preserves one logical execution across start, interrupt,
response, Stop, and reconnect while each AG-UI segment keeps its own stable
`runId`. Pending questions and approvals reappear after reload and remain
answerable. Completed output that arrived while disconnected is recovered
without resending the prompt.

Workspace invalidations use the normalized events WebSocket. REST remains
authoritative: subscribe before reading, mark overlapping reads dirty, reject
stale generations, and repeat until the read completes cleanly.

## Public failures

Every public failure has a stable normalized code and a safe, friendly
description. V1 distinguishes authorization failure, invalid or oversized
input, not found, unsupported capability, revision conflict, run conflict,
Hermes temporarily unavailable, connection interrupted, uncertain mutation,
and actual gateway failure.

Guest responses use the same allowlisted descriptions after projection. Native
error bodies, URLs, credentials, payloads, filesystem paths, and stack traces
never cross either listener.

## V1 exclusions

V1 does not include:

- multiple Tenants, operator users, or concurrent Runtime definitions;
- OpenCode or OpenClaw server adapters;
- OIDC, SAML, operator cookies, or trusted identity assertions;
- Hermes browser authentication or server-side cookie jars;
- distributed Runtime ownership or cross-process run coordination;
- an AOS workspace database, conversation mirror, or generalized event store;
- a provider-neutral socket, SSE, or Session-retention framework;
- browser provider SDKs, native provider routes, or a compatibility switch;
- Agent Browser verification.

## Acceptance

V1 is complete only when one local Hermes journey works without refresh-based
recovery:

```text
open operator workspace
  -> load Agents and recent Sessions
  -> open paginated history
  -> create a draft Session
  -> send the first turn
  -> stream reasoning, tools, and final response
  -> answer a question or approval
  -> Stop an active run
  -> reload during active and needs-input states
  -> reconnect and continue without duplicate submission
  -> issue and use a scoped guest invitation
```

Tests must cover protocol validation, capability fidelity, ownership,
operator/guest cross-lane admission, guest projection, native payload and
credential non-disclosure, lazy creation, pagination, history ordering,
streaming, terminal delivery, Stop settlement, questions and approvals,
attachments and artifacts, malformed and oversized inputs, uncertain sends,
connection loss, idle Session release, native reconnect, and deployment port
isolation.
