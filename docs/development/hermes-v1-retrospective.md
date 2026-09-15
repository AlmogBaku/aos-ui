# Hermes V1 retrospective

Hermes V1 moved provider execution out of the browser and established the
server-side runtime seam used by the normalized AOS and AG-UI clients. The most
important result was not the Hermes HTTP client or WebSocket itself. It was the
separation between provider mechanics, logical execution, AG-UI segments, and
browser presentation.

This retrospective records causal lessons. The normative decisions remain in
the [gateway architecture](../design/aos-runtime-gateway-architecture.md) and
[V1 design](../design/aos-runtime-gateway-v1.md).

## What worked

### A real-runtime vertical slice

Starting with Hermes exposed behavior a fixture would not have predicted:
durable and live Session identities differ, one connection multiplexes many
Sessions, command outcomes are heterogeneous, and native completion may not be
the same as logical terminal settlement.

Implementing one visible journey at a time kept those discoveries tied to user
behavior: catalog, history, first Send, live output, Stop, interruption,
reload, and guest access.

### Reading the maintained native client

Hermes Desktop and gateway source resolved questions about JSON-RPC
correlation, Session resume, disconnect behavior, heartbeat, replay, and HTTP
authority. Adapting those established patterns was safer and faster than
inferring a protocol from endpoint names.

The evidence is retained in:

- [Hermes Desktop gateway connection](../research/hermes-desktop-gateway-connection.md)
- [Hermes native client reuse](../research/hermes-native-client-reuse.md)
- [Hermes upstream attribution](../../packages/proxy/adapters/hermes/UPSTREAM.md)

### Evidence from real boundaries

Normalized EventStream output, HTTP requests, browser errors, and scripted
native frames made ownership failures observable. They revealed when final
text was mislabeled as reasoning, a tool remained open at `RUN_FINISHED`, an
edit targeted stale history, or a foreign Session event reached the selected
thread.

Focused behavior tests became effective once they asserted those boundaries
rather than private implementation layers.

### Converging on one execution path

Operator and guest traffic now share one Runtime instance, coordinator,
Hermes transport, and logical execution. The guest boundary authorizes input
and projects output; it does not duplicate provider work. Likewise, browser
reload reattaches to server-owned execution instead of recreating it.

## What cost time

### Designing before inspecting

Early connection and Session-lifetime assumptions were based on a generic
gateway model. Hermes already had concrete multiplexing, resume, and reaping
semantics. Inspecting Desktop first would have avoided request-owned sockets
and several rounds of stale conflicts and refresh-only output.

**Correction:** research the official client and build a native lifecycle
matrix before introducing a connection abstraction.

### Expanding the security plane before the run path

Operator authentication, browser-brokered native login, and duplicated guest
composition grew before basic live Send and reconnect were reliable. The V1
deployment later converged on a trusted operator listener, scoped guest JWTs,
and one server credential.

**Correction:** establish the smallest authorized real-runtime journey, then
harden the exact boundary it proves.

### Treating related controls as one operation

Browser FIFO queueing, active-turn steering, Hermes provider queueing, slash
commands, Retry, and interrupt resume all involve user input, but they have
different admission and retry semantics. Conflating them caused duplicate or
missing turns.

**Correction:** name the owner and acknowledgement boundary for each operation
before mapping it.

### Patching presentation symptoms

Missing final messages, empty responses, stale run conflicts, and broken
questions appeared as frontend defects. Several were consequences of invalid
AG-UI event ordering or incomplete coordinator settlement.

**Correction:** trace one event from native input through conversion,
coordination, serialization, and browser materialization before changing UI
state.

### Duplicating observable state

Polling Todos, activity, pending interactions, audio availability, and
capabilities created request noise and competing authorities.

**Correction:** use AG-UI lifecycle and PLAN activity for run-derived state,
normalized history for restoration, cached capability descriptors, and
explicit user actions for audio transforms.

### Broad coordination and verification

Parallel edits to shared files and repeated full-suite runs increased merge and
feedback cost while semantics were moving.

**Correction:** keep one owner for shared protocol/core files, let independent
workers report interface needs, and use a focused red-capable test until the
vertical behavior stabilizes.

## Golden nuggets

### Five lifetimes, not one Session

A durable Session, live Hermes attachment, logical AOS execution, AG-UI run
segment, and browser subscriber end for different reasons. Browser disconnect
ends only the last of these. A pending question ends a segment but retains the
logical execution and attachment.

### Shared semantics do not imply shared transports

Admission, subscriber fanout, control authorization, interruption, and
reconnect belong in the coordinator. Native sockets, subscriptions, live IDs,
and retention belong in the adapter. The
[OpenCode/OpenClaw research](../research/opencode-openclaw-runtime-transport-seams.md)
confirms that a generic transport manager would couple unlike systems.

### Accepted is not necessarily applied

Hermes may acknowledge steering as queued. That is a successful mutation
receipt, not permission to submit the text again. Conversely, losing the
acknowledgement creates uncertainty even when the native mutation may have
applied.

### AG-UI has lifecycle invariants

Final prose is ordinary assistant content. Reasoning and tools have explicit
lifecycles, and tool calls settle before the run segment finishes. Questions
finish one segment and resume through another; steering does not.

### Commands are a native dispatcher

Only the native catalog makes slash text a command. A command may alias another
command, prefill the composer, return immediate output, or start asynchronous
work. Treating every slash as a prompt or every command as an immediate result
loses native semantics.

### History decides rewind

Edit and Retry target an authoritative native message identity. User-visible
text is insufficient: identical text can appear more than once, and a stopped
local turn may never have entered native history.

### Projection is part of queue safety

Guest filtering happens before queue insertion. Sanitizing only at HTTP
serialization leaves sensitive reasoning, paths, or native metadata inside a
guest-addressable buffer.

### Real traces complement deterministic tests

Scripted transports prove ordering, loss, replay, and races. A real native
event trace proves that the fixture resembles the provider. Both are needed;
neither substitutes for the other.

## Consequences for the next adapters

OpenCode and OpenClaw should implement the same normalized runtime and
coordinator obligations, but begin from their official clients and native
lifecycle models. Their first deliverable should be a capability/lifecycle
matrix followed by one read and one complete run through the proxy.

No future adapter should require browser provider branches, a second normalized
domain model, or a Hermes-shaped connection abstraction. A shared-core change
should be supported by a real semantic need demonstrated by another adapter,
not by anticipated symmetry.
