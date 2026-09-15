# AOS runtime gateway architecture

This document defines the target architecture for the AOS runtime gateway. It
is normative: implementations may change internally, but they must preserve the
interfaces, ownership rules, isolation, and observable behavior described here.

## Purpose

AOS presents one workspace across multiple independently operated agent
harnesses. The gateway authenticates users, authorizes every operation, keeps
native credentials and protocols server-side, and translates each harness into
one normalized browser protocol.

The architecture supports:

- multiple isolated tenants;
- multiple runtime definitions per tenant, including multiple definitions of
  the same harness kind;
- multiple authenticated users and scoped guests;
- concurrent Sessions and runs across runtime definitions;
- gateway-owned OIDC, SAML, trusted-assertion, and service authentication;
- shared or principal-specific native identities;
- browser and gateway reconnect without prompt duplication;
- provider-specific connection lifecycles behind one runtime adapter seam.

The gateway is not an agent harness or conversation database. Native runtimes
remain authoritative for Agents, Sessions, messages, executions, tools,
interactions, and durable history.

## System shape

```text
React + assistant-ui
        |
        | AOS REST + events WebSocket + AG-UI runs
        v
+---------------------------------------------------------------+
| AOS gateway                                                   |
|                                                               |
| Identity -> authorization -> authorized request context       |
|                              |                                |
|                        workspace module                       |
|                              |                                |
|                       runtime directory                       |
|                  +-----------+-----------+                    |
|                  |           |           |                    |
|               Hermes      OpenCode    OpenClaw                |
|               adapter      adapter      adapter                |
|                  |           |           |                    |
|             native clients and provider-specific transports   |
+---------------------------------------------------------------+
```

The browser uses one provider-neutral remote runtime. It never imports a native
SDK, understands a native payload, receives a native credential, or connects to
a harness endpoint.

The gateway is a modular TypeScript application. Its modules may run in one
process or be distributed without changing the browser protocol or runtime
adapter interface.

## Domain model

The following terms are canonical.

### Tenant

A Tenant is the top-level security and configuration isolation scope. Runtime
definitions, memberships, signing keys, policies, and upstream credentials
belong to exactly one Tenant.

Resources and live connections are never shared across Tenants, even when two
Tenants configure the same upstream URL or secret.

### Workspace

A Workspace is the user-facing projection of one Tenant. It combines the
authorized runtime definitions and their normalized Agent catalogs without
merging their native identities or persistence.

### Principal

A Principal is an authenticated human, service, or guest. Authentication proves
the Principal's identity; it does not itself grant access to a Tenant or
resource.

### Membership and grant

A Membership associates a Principal with a Tenant and its roles. A Grant is the
effective, request-time authorization scope derived from Membership, policy, or
an invitation. A Grant identifies allowed runtime definitions, Agents,
Sessions, operations, fields, and expiry.

### Runtime definition

A Runtime definition is one configured harness deployment within a Tenant. It
has a stable `runtimeId`, harness kind, display metadata, endpoint, credential
policy, and runtime-specific configuration.

Two definitions remain distinct even when they use the same harness kind,
endpoint, or credential. The gateway never silently merges configured runtime
definitions.

### Upstream identity

An Upstream identity is the exact native authentication identity selected for a
Runtime definition. It may be a gateway-owned service token, a cookie jar, a
device identity, or another native credential set.

A shared service credential creates one Upstream identity for authorized users
of that Tenant and Runtime definition. Principal-specific native authentication
creates a different Upstream identity for each authenticated Principal.

### Runtime instance

A Runtime instance is the live server adapter and native client associated with
one Runtime definition and Upstream identity. Its full identity is:

```text
tenantId / runtimeId / upstreamIdentityId
```

The Runtime instance owns native connections, subscriptions, replay state, and
disposal. Browser connections do not own it.

### Resource references

AOS scopes native identities structurally:

```ts
type AgentRef = {
  runtimeId: string
  agentId: string
}

type SessionRef = AgentRef & {
  sessionId: string
}

type RunRef = SessionRef & {
  runId: string
}
```

`agentId` and `sessionId` retain stable native identities whenever the provider
supplies them. AOS does not encode provider names or runtime IDs into native
IDs. Tenant identity comes from the authorized request context rather than
untrusted resource parameters.

## Trust model

The browser, public request headers, native payloads, reconnect cursors, and
resource identifiers are untrusted input.

The gateway owns:

- user authentication and AOS session issuance;
- Tenant and Principal resolution;
- authorization and invitation verification;
- runtime selection and configuration;
- upstream URLs, secrets, cookie jars, and device identities;
- native authentication and connection lifecycle;
- Agent and Session ownership validation;
- protocol validation, limits, redaction, and safe error translation;
- run admission, idempotency, and reconnect authorization.

Native runtimes own:

- Agent definitions and native visibility metadata;
- Session identity, persistence, messages, and history;
- native execution, tools, questions, approvals, and artifacts;
- native models, context accounting, Todos, and activity where supported.

The browser owns presentation, drafts, navigation, locale, accessibility,
microphone capture, and audio playback. Browser state is never authoritative
provider input.

## Identity and authentication

The gateway exposes one identity module with adapters for established
authentication protocols:

```text
OIDC -------------------+
SAML -------------------+--> Principal --> AOS session
trusted signed assertion+
mTLS/service identity --+
```

Public browser authentication uses redirects or form posts appropriate to the
configured protocol. After validation, the gateway issues a short-lived,
signed, HttpOnly, Secure, SameSite cookie. Identity-provider tokens and
assertions are discarded unless a protocol requires bounded server-side
continuation state.

A trusted identity proxy may authenticate users before the gateway. It sends a
signed identity assertion over a private authenticated ingress after removing
client-supplied identity headers. A shared signing key or private key is
server-to-server material and is never shipped to browser code.

User authentication and native runtime authentication are separate:

- user authentication establishes a Principal;
- authorization grants that Principal access to Tenant resources;
- native authentication selects an Upstream identity for a Runtime definition.

Gateway-owned service credentials are loaded from a secret manager or secret
file reference. Principal-specific native cookies, tokens, or device material
are encrypted at rest and keyed by Tenant, Runtime definition, and Principal.

## Authorization and guest access

Every request is evaluated from an authorized context:

```ts
type AuthorizedContext = {
  tenantId: string
  principalId: string
  grant: Grant
}
```

The runtime adapter is selected only after authorization. Native resource
existence is then verified through the selected adapter. A resource ID from the
browser never proves ownership or access.

The effective capability for an operation is the intersection of:

```text
native capability x Tenant policy x Principal grant
```

Guests and operators use the same normalized protocol. A guest invitation is a
signed, expiring grant bound to its Tenant, Runtime definition, Agent and/or
Session scope, permitted operations, audience, and deployment. Guest output is
projected through the grant before serialization.

When an operator and guest use the same gateway-owned native service identity,
they share the same Runtime instance and native connection. Isolation is
enforced by authorization, event routing, reconnect binding, and outbound
projection rather than by duplicating the native connection.

Guest projections exclude all data outside the explicit grant, including
privileged roles, hidden Agents, native metadata, provider paths, credentials,
private tool payloads, approval internals, and native reconnect positions.

## Runtime directory

The runtime directory is the shared instance-routing module. It has two
responsibilities:

1. list the Runtime definitions visible to an authorized context;
2. resolve one authorized Runtime instance from `tenantId`, `runtimeId`, and
   the selected Upstream identity.

It does not implement WebSockets, SSE, provider retries, Session attachment, or
payload conversion. Those behaviors belong to the selected adapter.

The directory maintains one Runtime instance for each exact instance identity:

```text
tenantId / runtimeId / upstreamIdentityId
```

Concurrent resolution of the same identity is single-flight. Instance creation
either yields one ready adapter or one normalized failure. An instance may be
unloaded only when it has no active runs, pending interactions, subscriptions,
or adapter-specific retention requirement. Gateway shutdown disposes all
instances gracefully.

## Runtime adapter seam

`ServerRuntime` is the provider-neutral adapter interface. It exposes runtime
operations directly in normalized protocol terms and reports operation-specific
capabilities. It does not introduce a second canonical workspace model.

The interface covers:

- runtime status and capability values;
- Agent catalog and visibility;
- Session catalog, lifecycle, and history;
- AG-UI run start, stream, reconnect, and Stop;
- questions, approvals, reactions, and feedback;
- attachments, artifacts, and native audio operations;
- models, context, Todos, and activity;
- scoped invalidation subscriptions;
- graceful disposal.

Each adapter owns its native implementation:

- official or upstream-derived native client;
- native authentication mechanics;
- payload schemas and validation;
- request and event correlation;
- native connection topology;
- Session attachment and release;
- replay and authoritative reconciliation;
- native-to-normalized conversion;
- safe public error classification.

Capabilities are structured values containing choices, limits, scopes,
concurrency rules, and unavailability reasons. They are not reduced to booleans.

AG-UI is the run transport foundation and is not implemented as another runtime
adapter.

## Native connection topology

Connection lifecycle varies by harness and remains private to its adapter.

| Runtime  | Native client and connection model                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hermes   | Authenticated HTTP plus one multiplexed JSON-RPC WebSocket for each Runtime instance. The socket carries requests and events for many Sessions.                               |
| OpenCode | One official SDK client for each configured server and workspace scope. Active Session observation uses scoped, abortable SSE streams.                                        |
| OpenClaw | One official `GatewayClient` WebSocket for each Runtime instance. The socket multiplexes RPCs and events while Session subscriptions are acquired and released independently. |
| Fixture  | Deterministic in-process behavior with the same runtime interface and no native transport.                                                                                    |

No common socket pool or transport abstraction is imposed across adapters. The
shared concern is Runtime-instance ownership and routing, not the shape of the
native connection.

### Hermes lifecycle

A Hermes Runtime instance maintains one long-lived multiplexed WebSocket and
uses HTTP for authoritative catalogs, history, and content operations. JSON-RPC
responses correlate by request ID; events route by live `session_id` and
per-Session sequence.

Hermes durable stored Session IDs remain distinct from process-local live
Session IDs. Live IDs never cross the normalized protocol.

A live Hermes Session is retained while it is running, stopping, waiting for a
question or approval, reconciling, or within a bounded warm-idle grace period.
Relevant authorized Session activity refreshes that grace without creating a
permanent browser-owned lease. When no condition retains it, the adapter may
call `session.close` to release the live Session without deleting durable
history. A later `session.resume` reattaches it.

The adapter obtains a fresh WebSocket ticket for every native reconnect,
restores durable Session bindings, replays from native epoch and sequence where
available, and then confirms state through authoritative reads.

### OpenCode lifecycle

The OpenCode adapter uses the official SDK for normalized operations. Durable
Session IDs are stable. Each observed Session owns an abortable SSE stream; the
stream is released when no run, pending interaction, subscriber, or reconnect
grace retains it.

Reconnect reopens observation from the available provider position and
reconciles Session history and status before accepting another turn.

### OpenClaw lifecycle

The OpenClaw adapter maintains one official Gateway client for each Runtime
instance. Stable routing uses native Session keys; transcript generation IDs
and run IDs retain their separate native meanings.

Session subscriptions are reference-counted inside the adapter. Because native
events are not replayed across a lost Gateway connection, reconnect resubscribes
and reconciles authoritative history, in-flight run state, and active run IDs
before incremental delivery resumes.

## Session retention

Session retention has three independent lifetimes. Implementations must not
couple them to a browser tab or force different providers through one generic
connection lease.

### Durable Session lifetime

The native runtime owns durable Session persistence. Closing a browser,
releasing native observation, disconnecting a gateway worker, or expiring an
idle timer never deletes a durable Session or its history. A durable Session is
deleted or archived only by an explicit authorized lifecycle operation and the
provider's native retention policy.

The gateway stores no duplicate conversation record. After process restart it
discovers durable Sessions and reconstructs their normalized state from the
authoritative runtime.

### Logical run lifetime

The shared run coordinator retains a normalized run while it is running,
stopping, or waiting for a question or approval. Browser disconnection removes
only that downstream consumer. It does not settle the run or discard its
pending interaction. Terminal native state releases the run; reconnect finds
the existing run or reconstructs it from the provider's authoritative state.

This is the shared cross-runtime rule. It does not imply that every provider
needs an AOS-owned live Session, idle timer, or native close operation.

### Native attachment lifetime

Each adapter implements only the native attachment behavior its provider
requires. Any adapter-owned attachment is keyed by the full scope:

```text
tenantId / runtimeId / upstreamIdentityId / agentId / sessionId
```

- Hermes keeps one single-flight durable-to-live Session binding. Active runs,
  Stop settlement, pending interactions, in-flight reconciliation, and a
  bounded warm-idle grace retain that binding. When it is safely idle, the
  adapter calls `session.close` without deleting durable history. A later
  operation uses `session.resume` and authoritative reconciliation.
- OpenClaw owns durable Session, run, idle/reset, and restart-recovery policy in
  its Gateway. AOS does not duplicate that policy or close an OpenClaw Session
  when a browser disconnects. The adapter reference-counts only the native
  roster and selected-Session subscriptions needed by its consumers, then
  resubscribes and reconciles after reconnect.
- OpenCode owns its native Session lifetime. Its adapter starts and aborts
  scoped event observation as required by active normalized consumers and
  reconciles through the official SDK. It does not inherit Hermes close/resume
  semantics.

Attachment, resume, and subscription acquisition are single-flight where the
native API requires them. Under resource pressure, an adapter may release only
native resources that are not needed by active work or a pending interaction;
otherwise it applies bounded admission or backpressure.

### Runtime connection lifetime

The Runtime instance owns its native connection independently of Session
attachments. Hermes and OpenClaw multiplex attached Sessions over one
long-lived connection for the exact Runtime instance identity; OpenCode owns
its SDK client and creates scoped observation streams only where needed.

Releasing one Session therefore does not close a shared runtime connection or
affect another Session. A Runtime instance may be disposed only after it has no
active runs, pending interactions, observers, reconnect grace, or other
adapter-specific retention requirement.

Retention state is process-local coordination, not durable workspace state. If
a worker or native connection fails, the new owner rebuilds run observation
and any provider-required attachments from authorized demand, pending native
state, and authoritative reads. It never resends a prompt merely to recreate
an attachment.

## Workspace protocol

The external protocol has two conceptual planes.

### Workspace control plane

Strict versioned REST operations expose:

- authentication state;
- visible Runtime definitions and status;
- runtime-scoped Agent catalogs and visibility;
- runtime- and Agent-scoped Session catalogs;
- Session lifecycle and paginated history;
- capabilities, models, context, Todos, and activity;
- reactions, attachments, artifacts, audio, and invitations.

Representative resource paths are:

```text
/api/aos/v1/runtimes
/api/aos/v1/runtimes/{runtimeId}/agents
/api/aos/v1/runtimes/{runtimeId}/agents/{agentId}/sessions
/api/aos/v1/runtimes/{runtimeId}/agents/{agentId}/sessions/{sessionId}/history
```

The Tenant is derived from the authorized context. Every supplied Runtime,
Agent, and Session ID is validated within that Tenant and grant.

Agent catalogs may be loaded concurrently across visible Runtime definitions so
the workspace can display all authorized Agents. Session catalogs remain
runtime- and Agent-scoped. History loads only for an opened Session. One
unavailable runtime degrades independently without making other runtime
definitions unavailable.

REST is authoritative. Catalog and history responses have deterministic
ordering, bounded pages, stable native identities, and explicit partial or
unavailable states.

### Session run plane

Standard AG-UI concepts represent:

- messages and multimodal input;
- run lifecycle and streaming;
- reasoning;
- tool calls and custom UI;
- usage;
- run interruption, questions, and approvals;
- Stop and terminal outcomes.

The gateway accepts exactly one authorized new user turn or one bound interrupt
response for a run. Browser history, tools, state, and context are never treated
as authoritative provider input.

Minimal namespaced `aos.*` extensions are permitted only for run-adjacent
behavior absent from AG-UI. Raw provider events are rejected.

### Invalidation plane

One normalized AOS WebSocket multiplexes scoped invalidations and reconnect
positions for a browser connection. Subscriptions identify structured Runtime,
Agent, and Session scopes. The socket does not replace REST authority and does
not expose provider events.

An invalidation says that a scope may have changed. The browser repeats the
corresponding normalized read. Reads subscribe before fetching, mark overlapping
invalidations as dirty, reject stale generations, and repeat until a read
completes cleanly.

## Run coordination

The gateway run coordinator owns protocol-level concurrency and downstream
attachment. Its active-run identity is:

```text
tenantId / runtimeId / agentId / sessionId
```

One Session admits at most one new turn at a time unless the native capability
explicitly supports a stronger concurrency model. Duplicate submissions with
the same idempotency identity return the known run state. A different turn while
the Session is active returns a normalized conflict.

Each run records its initiating Principal. Observation and control are distinct
permissions. Authorized collaborators may observe a run; Stop or interaction
responses require the run-control grant. Tenant policy determines whether
operators other than the initiator receive that grant.

Disconnecting a browser stream detaches only that downstream consumer. It does
not stop the native run, release a pending question, or dispose the Runtime
instance. The run coordinator retains terminal settlement independently of the
browser connection.

Stop remains `stopping` until a native terminal event or authoritative idle
result proves settlement. Lost acknowledgement produces an uncertain state
rather than a false terminal state.

## Questions and approvals

Questions and approvals are AG-UI interrupts belonging to a run. Each interrupt
has a stable request ID, response schema, scope, and authorized control policy.

When an interrupt occurs:

1. the adapter validates and emits the normalized interrupt;
2. the native Session remains retained while waiting;
3. authoritative pending-interaction state is available during reconnect;
4. an authorized response resumes the same run;
5. duplicate identical responses are idempotent;
6. conflicting, expired, or uncertain responses produce distinct normalized
   outcomes.

An interrupted run is not represented as a completed conversation followed by
a synthetic new turn. Provider-native question and approval semantics are
preserved exactly.

## Reconnect and reconciliation

Browser reconnect is independent of the lifetime of any previous browser
socket:

```text
authenticate and authorize
  -> read authoritative Session history and pending interactions
  -> locate or reconstruct the run
  -> restore native attachment or subscription
  -> replay from the provider position when supported
  -> reconcile authoritative status and history
  -> resume normalized delivery
```

Reconnect cursors are bounded, authenticated values bound to:

- protocol version and key ID;
- deployment and expiry;
- Tenant and Runtime definition;
- Principal or invitation grant revision;
- Agent, Session, and run;
- native epoch, sequence, or equivalent provider position.

Cursors authorize resumption; they are not authoritative data. A cursor from a
different scope is rejected.

The gateway never automatically resends a prompt or interaction response after
losing its acknowledgement. It returns `uncertain` and reconciles native state.
Provider message IDs, run IDs, and event sequences are used to deduplicate
replay. When replay is unavailable or truncated, authoritative history replaces
incremental state.

Pending questions and approvals are reconstructed from native Session state or
authoritative native replay. A browser reload therefore presents the same
interrupt and can resume the same run.

## Errors and availability

Adapters classify native failures into a small normalized error vocabulary.
Every public error contains a stable code and safe human-readable description;
it may also contain retryability and request correlation metadata. Native URLs,
response bodies, credentials, filesystem paths, stack traces, and provider
payloads are never serialized.

The protocol distinguishes:

- AOS authentication required;
- native runtime authentication required;
- forbidden scope;
- unsupported or capability-unavailable operation;
- malformed or oversized input;
- resource not found within the authorized scope;
- revision or run conflict;
- provider temporarily unavailable;
- connection interrupted;
- uncertain mutation;
- gateway failure.

Runtime availability is independent. Failure of one Runtime instance does not
invalidate unrelated instances in the same Workspace.

## State and persistence

The gateway persists only its own control plane:

- Tenants and memberships;
- Runtime definitions and policies;
- references to secrets and encrypted principal-specific native credentials;
- identity-provider configuration;
- signing and encryption key metadata;
- invitation policy and optional revocation state;
- security audit records that contain no native secret or conversation body.

Native providers remain the durable source for Agents, Sessions, messages,
runs, tools, interactions, artifacts, and workspace history.

Process-local state includes:

- Runtime instances and native connections;
- active-run admission and settlement;
- Session observation and interaction retention;
- downstream subscribers;
- bounded replay buffers required by a native connection.

The gateway does not maintain a generalized event store, conversation mirror,
materialized workspace cache, or provider-independent Session database.

## Scaling and ownership

A single gateway process may host many Tenants and Runtime instances. When the
gateway is replicated, each exact Runtime-instance identity has one active
owner:

```text
tenantId / runtimeId / upstreamIdentityId -> gateway worker
```

Requests and downstream streams for that identity route to its owner. Ownership
may use consistent routing or a small distributed assignment module; it must
not allow two workers to issue conflicting turns on the same native Session.

If an owner fails, another worker reconstructs the Runtime instance from the
control plane and secret store, reconnects its native client, and reconciles
provider state. Recovery does not depend on replaying an AOS-owned conversation
log.

Static Vite assets may be served by the gateway, a CDN, or a conventional
reverse proxy. Static delivery is not part of runtime ownership. The public
deployment should present one origin for browser assets and normalized AOS
traffic. TLS termination and static caching may be delegated without granting
the proxy authority to forge identity headers.

## Module layout

The target source structure keeps protocol, shared gateway behavior, adapters,
and browser code separate:

```text
packages/
  protocol/
    ag-ui/
    workspace/

  gateway/
    identity/
    authorization/
    control-plane/
    runtime-directory/
    runs/
    events/
    routes/
    errors/
    adapters/
      hermes/
      opencode/
      openclaw/
      fixture/
    composition.ts
    cli.ts

src/
  runtime-adapters/
    aos/
```

The browser `aos` module is the sole remote runtime client. Gateway routes
depend on the runtime adapter interface and never import a concrete adapter.
Concrete adapters may have private modules for native clients, codecs,
authentication, mapping, and connection lifecycle.

Shared code is extracted only for behavior demonstrated by multiple adapters.
Transport mechanics remain adapter-private even when two providers both use a
WebSocket.

## Architectural invariants

An implementation conforms to this architecture only when all of the following
remain true:

1. The browser communicates exclusively through normalized AOS and AG-UI
   protocols.
2. Every resource and event is scoped by Tenant and Runtime definition before
   Agent and Session identity.
3. Native Agent and Session IDs are stable and are not rewritten for security
   or URL formatting.
4. Authentication occurs in the gateway; secrets and shared keys never enter
   the browser bundle.
5. Authorization precedes runtime resolution and native access.
6. Cross-Tenant Runtime instances and native connections are never shared.
7. Users and guests sharing one authorized native identity may share its
   Runtime instance without sharing authorization scope.
8. Each adapter owns its native client and connection lifecycle.
9. Browser disconnect never implies native Stop or Session deletion.
10. Pending questions and approvals remain reconnectable and resume the same
    run.
11. Uncertain sends and interaction responses are never retried automatically.
12. REST and provider state remain authoritative after reconnect.
13. Capabilities preserve native choices, limits, scopes, and reasons.
14. Provider payloads, credentials, URLs, and private metadata never cross the
    normalized protocol.
15. The gateway does not become a second provider workspace or conversation
    database.

## Research basis

The native connection and recovery models underlying this architecture are
documented in:

- [Multi-harness AOS gateway architecture](../research/multi-harness-gateway-architecture.md)
- [OpenCode and OpenClaw runtime transport seams](../research/opencode-openclaw-runtime-transport-seams.md)
- [OpenCode and OpenClaw server clients](../research/opencode-openclaw-server-clients.md)
- [Hermes Desktop gateway connection architecture](../research/hermes-desktop-gateway-connection.md)
