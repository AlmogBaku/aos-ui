# Assistant UI engine runtime interfaces

Status: implementation-planning research, not an implementation specification.
The claims below are pinned to the versions in this repository, not to each
project's moving `main` branch:

| Package | Version | Upstream tag commit |
|---|---:|---|
| `@assistant-ui/react-ag-ui` | `0.0.58` | [`d511ff496c59005f5df4df155dcccb3c1ddff475`](https://github.com/assistant-ui/assistant-ui/tree/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-ag-ui) |
| `@assistant-ui/core` | `0.3.17` | [`d511ff496c59005f5df4df155dcccb3c1ddff475`](https://github.com/assistant-ui/assistant-ui/tree/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/core) |
| `@ag-ui/client` | `0.0.59` | [`9f393021ecbd6bcc62dc4b1ad5a6ac4b797565f4`](https://github.com/ag-ui-protocol/ag-ui/tree/9f393021ecbd6bcc62dc4b1ad5a6ac4b797565f4/sdks/typescript/packages/client) |
| `@assistant-ui/react-opencode` | `0.2.22` | [`d511ff496c59005f5df4df155dcccb3c1ddff475`](https://github.com/assistant-ui/assistant-ui/tree/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-opencode) |

The repository pins these versions in [`package.json`](../../package.json). The
Hermes-side HTTP and plugin contracts are covered separately in
[`2026-09-07-hermes-integration-interfaces.md`](./2026-09-07-hermes-integration-interfaces.md).

## Conclusions for the integration plan

1. Keep the existing `useAgUiRuntime` composition for an endpoint that already
   speaks AG-UI. Stock `HttpAgent` is sufficient for a normal, single POST whose
   response is an AG-UI SSE stream.
2. Attach to an already-running inbound run through
   `ThreadHistoryAdapter.resume()`. This is the pinned runtime's implemented,
   explicitly unstable replay seam for consuming an existing stream without
   invoking `agent.runAgent()` and therefore without submitting a new prompt.
   Resolving the remote run and opening that stream remain adapter
   responsibilities.
3. Do not describe `HttpAgent.connect()` as the attach path. The AG-UI client
   exposes `connectAgent()`, but `useAgUiRuntime@0.0.58` never calls it.
4. Treat subscription abort and engine stop as separate operations. In the
   pinned React runtime, explicit Assistant UI cancel and React teardown share
   the same `core.cancel()` path. An `abortRun()` override cannot identify which
   one occurred.
5. Add authoritative Session-catalog invalidation/refetch. The pinned OpenCode
   runtime recognizes a `session.created` event enough to extract its Session
   ID, but it does not add that Session to the remote thread list.

Confidence: high. The behavior was checked against the exact release tags and
the installed package tarballs.

## Normal AG-UI run path

`useAgUiRuntime` routes a new user message to `core.append()`, and reload/resume
interactions to the corresponding core methods. A normal `startRun()` builds an
AG-UI input, creates a local `RUN_STARTED` event, and calls the supplied agent's
`runAgent()` method. The runtime passes a third `{ signal }` argument for custom
agents, although the published `AbstractAgent.runAgent()` signature has only two
parameters; `HttpAgent` ignores that third argument and is cancelled through
`abortRun()`.

Evidence:

- [`useAgUiRuntime` callback wiring](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-ag-ui/src/useAgUiRuntime.ts#L223-L274)
- [`AgUiThreadRuntimeCore.startRun()` normal branch](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-ag-ui/src/runtime/AgUiThreadRuntimeCore.ts#L985-L1173)
- [`RunAgentWithRunOptions` compatibility comment and type](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-ag-ui/src/runtime/AgUiThreadRuntimeCore.ts#L61-L68)

### What stock `HttpAgent` actually supports

At `@ag-ui/client@0.0.59`, `HttpAgent`:

- sends one POST request to its configured URL;
- sends `Content-Type: application/json` and `Accept: text/event-stream`;
- allows static headers, a custom `fetch`, and subclass customization of
  `requestInit()`;
- converts that same HTTP response into AG-UI events; and
- implements `abortRun()` by aborting its request controller.

It does not implement `connect()`. The base implementation throws
`AGUIConnectNotImplementedError`; `connectAgent()` catches that specific error
and completes empty. `AbstractAgent.detachActiveRun()` is a separate local Rx
detachment primitive, but the pinned React hook never invokes it.

Evidence:

- [`HttpAgent` request, run, and abort implementation](https://github.com/ag-ui-protocol/ag-ui/blob/9f393021ecbd6bcc62dc4b1ad5a6ac4b797565f4/sdks/typescript/packages/client/src/agent/http.ts#L40-L109)
- [`AbstractAgent.runAgent()`](https://github.com/ag-ui-protocol/ag-ui/blob/9f393021ecbd6bcc62dc4b1ad5a6ac4b797565f4/sdks/typescript/packages/client/src/agent/agent.ts#L164-L261)
- [`AbstractAgent.connect()` and `connectAgent()`](https://github.com/ag-ui-protocol/ag-ui/blob/9f393021ecbd6bcc62dc4b1ad5a6ac4b797565f4/sdks/typescript/packages/client/src/agent/agent.ts#L263-L336)
- [`abortRun()` and `detachActiveRun()`](https://github.com/ag-ui-protocol/ag-ui/blob/9f393021ecbd6bcc62dc4b1ad5a6ac4b797565f4/sdks/typescript/packages/client/src/agent/agent.ts#L338-L348)

Consequently, stock `HttpAgent` is appropriate when an external engine plugin or
bridge already presents a standard AG-UI POST-to-SSE endpoint. A browser that
talks directly to an engine with a create-run response followed by a separate
event-stream request needs a custom `AbstractAgent` or a translating service. A
subclass that overrides only `connect()` and `abortRun()` is insufficient: normal
turns would also require a `run()` override, and inbound attach still needs
explicit history-adapter wiring because the React hook does not call
`connectAgent()`.

## Existing-run attachment through history

The shared `ThreadHistoryAdapter` contract allows `load()` to return
`unstable_resume: true` and provides an optional `resume(options)` async
generator. `resume()` yields `ChatModelRunResult`, not AG-UI `BaseEvent` values.

In the AG-UI runtime's resume branch:

- `agent.runAgent()` is bypassed;
- the history generator receives the current messages, model context,
  `abortSignal`, `unstable_threadId`, `unstable_parentId`,
  `unstable_assistantMessageId`, and `unstable_getMessage`;
- yielded `content` replaces the current assistant content rather than being
  appended as a token delta; and
- if the generator ends while the message is still running, the runtime marks
  it complete.

Therefore a transport-backed resume generator should yield cumulative assistant
message snapshots with stable message and tool-call IDs. It must honor
`abortSignal` by closing its subscription. Any engine-native event translation
belongs behind that adapter boundary.

Evidence:

- [`ThreadHistoryAdapter` contract](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/core/src/adapters/thread-history.ts#L59-L82)
- [`consumeResumeStream()` options and completion behavior](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-ag-ui/src/runtime/AgUiThreadRuntimeCore.ts#L1233-L1291)
- [`updateAssistantMessage()` replacement semantics](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-ag-ui/src/runtime/AgUiThreadRuntimeCore.ts#L1431-L1473)

### Initial-load hazard in `0.0.58`

There is an important asymmetry in the pinned release:

- On initial history load, `unstable_resume: true` causes `startRun()` to be
  called even when `history.resume` is absent. The resulting `undefined`
  `resumeStream` selects the normal branch and invokes `agent.runAgent()`. This
  can accidentally submit or repeat a turn.
- After a thread switch, `resumeInFlightRun()` explicitly checks for
  `history.resume`. If it is missing, the runtime reports an error and skips the
  resume.

The adapter invariant must therefore be stronger than the type:
`unstable_resume` may be true only when a concrete resume generator and a
resolvable remote run identity are both available.

Evidence:

- [`__internal_load()` unguarded initial resume](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-ag-ui/src/runtime/AgUiThreadRuntimeCore.ts#L243-L278)
- [`resumeInFlightRun()` guarded switch resume](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-ag-ui/src/runtime/AgUiThreadRuntimeCore.ts#L370-L392)
- [`useAgUiRuntime` switch hydration](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-ag-ui/src/useAgUiRuntime.ts#L175-L208)

### Current AOS bridge gap

The current provider-neutral AG-UI workspace types already contain
`AgUiSessionSnapshot.unstableResume`, and `AgUiThreadListBridge` maps it to
Assistant UI's `unstable_resume` field on both initial load and thread switch.
However, `AgUiWorkspaceTransport` has no resume operation and
`AgUiThreadListBridge.history` implements only `load()` and `append()`.

This is not merely a missing enhancement. If a workspace host currently returns
`unstableResume: true`, the initial-load hazard above is reachable.

The smallest safe extension is an optional transport method that accepts a
Session/run reference and `AbortSignal` and yields `ChatModelRunResult`
snapshots. The bridge should expose it as `history.resume`; hosts that cannot
resolve a live run must omit or return `false` for `unstableResume`.

Repository evidence:

- [`AgUiSessionSnapshot` and `AgUiWorkspaceTransport`](../../lib/runtime-adapters/ag-ui/ag-ui-workspace.ts)
- [`toRepository()` and current history adapter](../../lib/runtime-adapters/ag-ui/ag-ui-thread-list-bridge.ts)
- [`useAgUiRuntimeBundle` adapter composition](../../lib/runtime-adapters/ag-ui/use-ag-ui-runtime-bundle.ts)

## Cancel, teardown, detach, and stop

The pinned runtime does not expose separate callbacks for user cancellation and
component teardown:

| Trigger | Pinned path | Observable result |
|---|---|---|
| Assistant UI cancel action | external-store `onCancel` -> `core.cancel()` | agent request abort plus local cancelled status |
| React runtime cleanup/unmount | effect cleanup -> `core.detachRuntime()` -> `core.cancel()` | the same agent request abort plus local cancelled status |
| Local abort listener | dispatches `RUN_CANCELLED` or marks a replayed message incomplete/cancelled | clears running state and invokes `UseAgUiRuntimeOptions.onCancel` |

`core.cancel()` first calls the active agent's `abortRun()` and then always
aborts its own controller. No reason or teardown flag reaches `abortRun()` or
`onCancel`. When no run controller exists, cancellation is a no-op.

Evidence:

- [`useAgUiRuntime` cancel callback and effect cleanup](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-ag-ui/src/useAgUiRuntime.ts#L245-L310)
- [`detachRuntime()`](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-ag-ui/src/runtime/AgUiThreadRuntimeCore.ts#L212-L220)
- [`cancel()`](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-ag-ui/src/runtime/AgUiThreadRuntimeCore.ts#L346-L358)
- [local abort listener in `startRun()`](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-ag-ui/src/runtime/AgUiThreadRuntimeCore.ts#L1110-L1125)

If a run must survive navigation or unmount, the agent's abort and the history
resume generator's abort must mean **disconnect locally**, not stop engine work.
An engine-native stop endpoint must be invoked only from an explicit user-stop
handler outside this ambiguous abort path. The handler can then reconcile the
local Assistant UI lifecycle after the native stop request is accepted. Do not
put native stop in an `HttpAgent.abortRun()` override for this pinned runtime.

## OpenCode `session.created` discovery gap

The pinned OpenCode event source normalizes both direct and nested event
payloads. For `session.created`, `session.updated`, and `session.deleted`, it can
extract the Session ID from `properties.info.id`.

That normalization does not produce remote thread-list discovery:

1. Each `OpenCodeThreadController` subscribes to the shared event source and
   discards every event whose Session ID differs from its own.
2. Its server-event switch handles `session.updated`, status, idle, compacted,
   errors, messages, parts, permissions, and questions, but has no
   `session.created` case.
3. `createOpenCodeThreadListAdapter().list()` fetches root Sessions, but the
   adapter has no event subscription that invalidates or refreshes that list.

An externally created root Session can therefore appear on a later authoritative
thread-list reload, but `session.created` alone does not add it to the rendered
list in `@assistant-ui/react-opencode@0.2.22`.

Evidence:

- [`OpenCodeEventSource` Session-ID extraction and normalization](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-opencode/src/OpenCodeEventSource.ts#L12-L70)
- [per-Session event filter](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-opencode/src/OpenCodeThreadController.ts#L418-L428)
- [`handleServerEvent()`](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-opencode/src/OpenCodeThreadController.ts#L770-L908)
- [root Session list fetch](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-opencode/src/openCodeThreadListAdapter.ts#L24-L45)
- [`useOpenCodeRuntime` remote-thread-list composition](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/react-opencode/src/useOpenCodeRuntime.ts#L349-L377)

Confidence: high. An exhaustive search of the exact package source found
`session.created` only in Session-ID extraction; it found no thread-list event
consumer.

### Supported authoritative thread-list refresh

The pinned public refresh is `await runtime.threads.reload()` on the
`AssistantRuntime` returned by `useOpenCodeRuntime`. The equivalent scoped client
call is `await aui.threads.reload()`.

For `useRemoteThreadListRuntime`, `reload()` increments the load generation,
clears the cached load and pagination promises, resets the cursor, and calls the
adapter's `list()` again. Responses from superseded loads are ignored. With the
same adapter instance, this refresh does not reset the current selection; adapter
replacement has separate reset behavior. `reloadMainThread()` is a different
operation: it refetches or remounts the selected thread body and does not reread
the Session catalog.

The smallest supported OpenCode discovery composition is therefore:

1. receive a provider-owned catalog invalidation, such as `session.created`;
2. coalesce bursts and call `runtime.threads.reload()` once; and
3. let the existing OpenCode remote-thread-list adapter reread
   `experimental.session.list({ roots: true, archived: true })`.

The event is only an invalidation signal. The authoritative `list()` response
must determine membership, metadata, and ownership. No replacement
`RemoteThreadListAdapter` is required merely to gain refresh capability.

Evidence:

- [`ThreadListRuntime.reload()` public API](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/core/src/runtime/api/thread-list-runtime.ts#L45-L89)
- [public API delegation to the runtime core](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/core/src/runtime/api/thread-list-runtime.ts#L221-L235)
- [`RemoteThreadListThreadListRuntimeCore.reload()`](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/core/src/react/runtimes/RemoteThreadListThreadListRuntimeCore.tsx#L489-L498)
- [remote list loading and stale-generation guard](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/core/src/react/runtimes/RemoteThreadListThreadListRuntimeCore.tsx#L126-L200)
- [`aui.threads.reload()` client method](https://github.com/assistant-ui/assistant-ui/blob/d511ff496c59005f5df4df155dcccb3c1ddff475/packages/core/src/store/scopes/threads.ts#L20-L36)

## Required regression coverage

The implementation plan should require focused tests for:

- initial load with `unstable_resume: true` attaches to the existing run and
  performs no new-run POST;
- thread switch with `unstable_resume: true` behaves the same way;
- a snapshot cannot advertise resume without a resolvable run reference and a
  configured resume generator;
- resume yields cumulative content with stable assistant-message and tool-call
  IDs and preserves history without a duplicate assistant turn;
- aborting the resume stream detaches locally and does not call native stop;
- the explicit Stop button/keyboard action invokes native stop exactly once and
  then reconciles local cancelled state;
- unmount while a run is active never invokes native stop;
- malformed, expired, or unavailable resume streams degrade to refreshed
  history/status plus a visible error;
- an externally created OpenCode Session invalidates and refetches the
  authoritative root Session list; and
- Session arrival never steals focus from the active thread.

## Remaining gaps and stability warning

- `unstable_resume` is explicitly unstable API surface. Re-verify these paths
  before any upgrade of `@assistant-ui/core` or `@assistant-ui/react-ag-ui`.
- A Session listing must expose, or an AOS-owned coordinator must retain, enough
  identity to attach to the correct live run. A boolean `unstableResume` alone is
  insufficient.
- The upstream AG-UI client has a distinct `connectAgent()` concept, while the
  pinned Assistant UI AG-UI runtime uses `ThreadHistoryAdapter.resume()` for
  restoration. These are not interchangeable in the current integration.
- OpenCode's event normalization and remote thread-list storage are separate
  layers. Treat `session.created` as an invalidation signal and refetch
  authoritative provider data rather than projecting the event payload directly
  into ownership state.
