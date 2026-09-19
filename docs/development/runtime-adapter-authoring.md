# Author an AOS runtime adapter

Use this guide when adding, auditing, or debugging a server-side runtime
adapter. The [gateway architecture](../design/aos-runtime-gateway-architecture.md)
and [V1 design](../design/aos-runtime-gateway-v1.md) remain normative. This
guide explains the obligations that are difficult to infer from TypeScript
interfaces alone.

## Start from the native runtime

Inspect the runtime's maintained SDK, client application, protocol source, and
behavior tests before designing the adapter. Record a capability and lifecycle
matrix that answers:

- Which identities are durable, and which are process- or connection-local?
- Which reads are authoritative, and which streams are incremental?
- How are runs started, observed, stopped, resumed, and reconciled?
- Can a running turn be redirected or queued, and what does acknowledgement
  mean?
- How are commands, questions, approvals, tools, Todos, and content represented?
- What can be recovered after a connection or process generation changes?

Expose native behavior faithfully. An unsupported operation stays unavailable
with a reason. Do not emulate it with a different operation that merely looks
similar.

## Preserve the ownership boundary

```text
browser presentation and drafts
        -> ACP v2 WebSocket (ACP layer) / AOS REST (bytes/discovery)
        -> SessionCoordinator
        -> ServerRuntime / ServerRunEngine
        -> native adapter clients and transports
```

| Owner                | Responsibilities                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser              | Presentation, local drafts, navigation, locale, accessibility, microphone capture, playback, and the Assistant UI follow-up queue.                                                        |
| Normalized routes    | Input validation, authorized resource scope, protocol encoding, and friendly errors.                                                                                                      |
| `SessionCoordinator` | One logical execution per Session, admission, idempotency, Stop and steering serialization, run segment identities, subscriber fanout, bounded replay, and authoritative settlement.      |
| Runtime adapter      | Native authentication, stable/native identity mapping, connection topology, Session attachment, native payload validation, capability mapping, event conversion, recovery, and retention. |
| Native runtime       | Durable Agents, Sessions, history, executions, interactions, tools, and content.                                                                                                          |

The coordinator must not learn native WebSocket methods, live Session IDs, or
provider event shapes. The adapter must not create a second run coordinator or
browser runtime. Add a shared abstraction only after two adapters demonstrate
the same semantic requirement.

## Keep lifetimes distinct

Treat these as separate objects:

1. The durable native Session and transcript.
2. The adapter's live attachment, subscription, or process-local Session ID.
3. The coordinator's logical execution.
4. A proxy run segment (a sequence of events with a stable `runId`).
5. A downstream browser subscriber.

A browser disconnect releases only its subscriber. It does not stop native
work, settle the logical execution, discard a pending interaction, or close a
provider attachment still needed for recovery.

A question ends one run segment. Answering resumes the run, while the logical execution and native Session continue.
Active-turn steering stays inside the current segment and creates no new run.

Connection and retention topology remains provider-private. Hermes uses a
multiplexed JSON-RPC connection and durable-to-live Session attachments;
OpenClaw and OpenCode have different native observation and recovery models.
They share coordinator semantics, not a generic socket manager.

## Map native output to the proxy-owned run vocabulary

Adapters emit the proxy-owned run vocabulary (`RunEvent`, `RunEventKind`,
`PendingRequest`, `RequestReply`, `TurnInput`, `ExecutionEvent` from
`packages/proxy/core/events.ts`), which currently aliases AG-UI shapes; the ACP
layer in `packages/proxy/acp/` translates them for the browser. Treat the
vocabulary as an event grammar, not a bag of JSON:

- final assistant prose is text message content, never reasoning content;
- reasoning starts and ends independently of final text;
- every tool call and result reaches a terminal state before the run ends;
- run completion carries success, interruption, or cancellation only after the
  segment is complete;
- provider progress uses structured activity when it is meaningful to the UI;
- Session Todos use a PLAN activity event; the ACP layer projects them as
  `plan_update` with `_meta.aos.todos`;
- restored PLAN activity is presentation state and is never forwarded as
  native prompt history.

Validate native events before conversion. Reject malformed, oversized,
unknown, and wrong-Session events without disturbing other Sessions. Route by
the exact Agent and Session attachment before publishing normalized output.

History is authoritative. Incremental events make the UI timely; they do not
replace provider history during recovery.

## Separate Send, queue, steering, and commands

These operations have different authority and retry semantics:

| Operation                | Owner                    | Meaning                                                                            |
| ------------------------ | ------------------------ | ---------------------------------------------------------------------------------- |
| Send while idle          | Coordinator and adapter  | Admit one new native user turn.                                                    |
| Browser follow-up queue  | Assistant UI             | Retain FIFO user intent until the Session can accept it.                           |
| Active-turn steering     | Coordinator control lane | Correct the current native execution without starting another run.                 |
| Provider-queued steering | Native runtime           | The steering request was accepted for later application; do not send another copy. |
| Native command           | Adapter                  | Execute a catalog-recognized provider operation with its native result semantics.  |

Steering requires an exact active `runId`, a unique request ID, text-only
input, and the controller's authorization. Stop and steering serialize through
the same control lane. Steering is unavailable while idle, stopping,
uncertain, or waiting for input.

Discover commands from the native catalog. A leading slash alone does not make
text a command: an unknown `/name` remains an ordinary prompt. Resolve native
aliases with a strict depth bound. Preserve distinct command outcomes:

- immediate normalized output;
- composer prefill;
- alias dispatch;
- asynchronous prompt or skill execution.

Apply native attachment and rewind restrictions to commands rather than
silently changing their semantics.

## Make Edit and Retry authoritative

The browser supplies one replacement user turn and an opaque source message
identity. The adapter must locate that identity in fresh authoritative history
and translate it to the native rewind or truncation operation.

Never use browser-supplied history as provider authority. A stopped turn that
was never persisted is not a rewind source. Repeated edits must use current
native identities; matching an older row by text can truncate the wrong
conversation. If history changed incompatibly, reconcile and return a
normalized conflict rather than guessing.

## Preserve interrupts

Questions and approvals use normalized interruption. The ACP layer delivers
them as `session/request_permission` or `elicitation/create` to the browser:

1. Validate the complete native interaction batch.
2. Finish the current segment with an interrupt outcome.
3. Preserve normalized interrupt metadata in authoritative history.
4. Retain the native Session while it waits for input.
5. Accept one complete response with `resolved` or `cancelled` entries.
6. Resume the same logical execution (no new run created).

An answer is not a new user prompt. Repeated identical responses may be
idempotent; conflicting, expired, wrong-Session, or incomplete responses make
no native call. Reload reconstructs the interrupt from normalized history or
adapter-private native discovery, not from a browser polling contract.

## Design for uncertainty and reconnect

Every native mutation needs an admission identity and an acknowledgement
boundary. If a connection fails after dispatch but before acknowledgement,
return `uncertain`. Never automatically replay Send, Stop, steering, command,
rewind, or interaction responses.

Reconnect performs attachment and reconciliation:

```text
authorize scope
  -> read authoritative history and execution state
  -> recover or recreate provider observation
  -> replay safe missed events when supported
  -> reconcile identities and terminal state
  -> resume normalized delivery
```

Provider replay positions are adapter-private: the coordinator carries only the
opaque `{ epoch, lastSeen }` an adapter reports, never a provider cursor. Replay
overflow or an epoch change falls back to authoritative reads without
resubmitting user intent.

## Normalize capabilities, state, and content

Capabilities are structured values. Preserve native choices, limits, scopes,
and unavailability reasons rather than reducing operations to booleans. Cache
capabilities for the relevant scope; ordinary renders and generic Session
invalidations are not capability changes. A local draft has no Session-scoped
capabilities.

Derive `running`, `stopping`, `waiting-for-input`, and terminal state from the
coordinator and ACP lifecycle state. Use PLAN activity for Todos (the ACP layer translates them to `plan_update`) and structured
activity for progress. Do not create polling endpoints for state already
carried by the normalized run or history.

Parse provider-injected attachment and context envelopes server-side. Return
safe filenames, MIME types, sizes, and opaque content identities. Native paths,
filesystem warnings, credentials, URLs, payloads, and error bodies never cross
the adapter boundary. Transcription and speech synthesis run only after their
explicit user actions and remain distinct from native multimodal audio input or
output.

## Share execution, project authorization

Operator and guest requests using the same configured upstream identity share
the same Runtime instance, coordinator, provider connection, and native
execution. Authorization controls observation and mutation; it does not create
a duplicate runtime.

Project guest output before it enters the guest subscriber queue. This keeps
reasoning, raw tools, privileged roles, native metadata, paths, live IDs, and
provider positions out of memory that an authorized guest connection can
drain. A slow or expired guest may lose its own subscriber without delaying or
stopping operator delivery.

## Implement one vertical operation

For each adapter operation:

1. Find the existing observable behavior and its provider-neutral contract.
2. Inspect the native client and payloads that implement the same behavior.
3. Add one focused conformance test that fails for the missing mapping.
4. Implement the smallest native client, validation, and conversion change.
5. Verify capability fidelity, ownership, isolation, and failure mapping.
6. Exercise reconnect or uncertainty when the operation mutates native state.
7. Run the adapter suite and the affected provider-neutral browser test.

Changing shared protocol or coordinator code requires evidence that the
existing seam cannot express a real native capability. Prefer an adapter-private
mapping when the difference is connection topology, live identity, retention,
or provider recovery.

## Completion checklist

An adapter is ready when:

- its capability matrix matches inspected native behavior;
- stable identity and Session ownership are enforced on every operation;
- its event stream obeys the proxy-owned run vocabulary ordering and rejects foreign Session events;
- Stop, steering, commands, Edit/Retry, and interrupts preserve native
  semantics where supported;
- lost mutation acknowledgements are uncertain and never replayed;
- reconnect restores observation and state without resending prompts;
- provider payloads and paths cannot enter normalized or guest output;
- focused adapter tests and provider-neutral conformance tests pass.

Use the Hermes adapter and its tests as a worked example, not as a transport
template. Its package map is in
[`packages/proxy/adapters/hermes/README.md`](../../packages/proxy/adapters/hermes/README.md).

### Catalog-change subscription

Implement the optional `subscribeCatalogChanges(listener)` method on
`ServerRuntime` when the native provider broadcasts catalog-change signals.
Hermes uses its native `sessions.changed` WebSocket event. The ACP layer calls
this method to wake the activity feed on connect; adapters that omit it simply
receive no wake.

### Session read state and `unread`

Project `unread` in `AosSessionInfoMeta` only when the native payload proves the
read state (for example, Hermes `last_read_at` NULL means read). Omit `unread`
when the payload is absent or ambiguous; absent never overwrites a known value in
the browser. Declare the read-state capability unavailable rather than emulating
it with a synthetic value.
