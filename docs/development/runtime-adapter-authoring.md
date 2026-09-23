# Author an AOS runtime adapter

Use this guide when adding, auditing, or debugging a server-side runtime
adapter. The [gateway architecture](../design/aos-runtime-gateway-architecture.md)
is the normative authority. The [V1 design](../design/aos-runtime-gateway-v1.md)
is a dated completion record, not normative. This guide explains the obligations
that are difficult to infer from TypeScript interfaces alone.

## Start from the native runtime

Inspect the runtime's maintained SDK, client application, protocol source, and
behavior tests before designing the adapter. Record a capability and lifecycle
matrix that answers:

- Which identities are durable, and which are process- or connection-local?
- Which reads are authoritative, and which streams are incremental?
- How are turns started, observed, stopped, continued, and reconciled?
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
        -> ServerRuntime / ServerTurnEngine
        -> native adapter clients and transports
```

| Owner                | Responsibilities                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser              | Presentation, local drafts, navigation, locale, accessibility, microphone capture, playback, and the Assistant UI follow-up queue.                                                        |
| Normalized routes    | Input validation, authorized resource scope, protocol encoding, and friendly errors.                                                                                                      |
| `SessionCoordinator` | One logical execution per Session, admission, idempotency, Stop and steering serialization, turn segment identities, subscriber fanout, bounded replay, and authoritative settlement.     |
| Runtime adapter      | Native authentication, stable/native identity mapping, connection topology, Session attachment, native payload validation, capability mapping, event conversion, recovery, and retention. |
| Native runtime       | Durable Agents, Sessions, history, executions, interactions, tools, and content.                                                                                                          |

The coordinator must not learn native WebSocket methods, live Session IDs, or
provider event shapes. The adapter must not create a second turn coordinator or
browser runtime. Add a shared abstraction only after two adapters demonstrate
the same semantic requirement.

## Keep lifetimes distinct

Treat these as separate objects:

1. The durable native Session and transcript.
2. The adapter's live attachment, subscription, or process-local Session ID.
3. The coordinator's logical execution.
4. A proxy turn segment (a sequence of events with a stable `turnId`).
5. A downstream browser subscriber.

A browser disconnect releases only its subscriber. It does not stop native
work, settle the logical execution, discard a pending interaction, or close a
provider attachment still needed for recovery.

A question ends one turn segment. Answering continues the turn, while the logical execution and native Session continue.
Active-turn steering stays inside the current segment and creates no new turn.

Connection and retention topology remains provider-private. Hermes uses a
multiplexed JSON-RPC connection and durable-to-live Session attachments;
OpenClaw and OpenCode have different native observation and recovery models.
They share coordinator semantics, not a generic socket manager.

## Map native output to the proxy-owned turn vocabulary

Adapters emit the proxy-owned turn vocabulary (`TurnEvent`, `TurnEventKind`,
`PendingRequest`, `RequestReply`, `TurnInput`, `ExecutionEvent` from
`packages/proxy/core/events.ts`); the ACP layer in `packages/proxy/acp/`
translates them for the browser. The `TurnEventKind` names
(`turn-started`, `message-chunk`, `thought-chunk`, `tool-call-*`,
`plan-updated`, `turn-requires-action`, …) follow ACP's language and are
proxy-internal; the browser sees only the ACP messages they translate to.
Treat the vocabulary as an event grammar, not a bag of JSON:

- final assistant prose is a message chunk, never a thought chunk;
- reasoning starts and ends independently of final text;
- every tool call and result reaches a terminal state before the turn ends;
- turn completion carries success, a request for the operator, or cancellation
  only after the segment is complete;
- provider progress uses structured events when it is meaningful to the UI;
- Session Todos use a `plan-updated` event (`TurnEventKind.PlanUpdated`); the
  ACP layer projects them as `plan_update` with `_meta.aos.todos`;
- restored Todo activity is presentation state and is never forwarded as
  native prompt history.

Carry every native fact the operator can use, and leave out one the provider
does not report rather than guessing it. The translator maps each to a
standard ACP field or to `_meta.aos`:

- `ToolCallStarted.name` is always the canonical tool name, and live turns and
  history agree on it; `toolKind` comes from that name.
- Tool `locations` and `diffs` use absolute paths, with the patch as `git diff`
  text. Never emit a path the adapter's privacy rule hides.
- Timestamps are UTC ISO strings (`toISOString()`), and `durationMs` is whole
  milliseconds.
- `TurnEnded` carries `stopReason` when the provider reports one, its token
  `usage` with cache reads and writes, and the turn's `cost`. `TurnFailed`
  names the `provider` and `model` that failed.
- Partial tool output is `ToolCallOutputChunk`; command output is
  `TerminalOutput`, after its owning `ToolCallStarted`.
- Compaction is `CompactionUpdated` with a stable id: started, then completed
  with a summary, failed with an error, or cancelled when the turn ends
  without the runtime confirming it.
- `ModelChanged.modelId` is the same id `session/set_config_option` uses for
  the model option.
- Subagent work names its `subagentId`. The spawning call carries `subagent`,
  and `SubagentUpdated` reports its progress.
- Stored history carries the same tool kind, locations, diffs, timing, and
  stop reason where the provider's stored rows have them, so a reload reads
  like the live turn.

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
| Active-turn steering     | Coordinator control lane | Correct the current native execution without starting another turn.                |
| Provider-queued steering | Native runtime           | The steering request was accepted for later application; do not send another copy. |
| Native command           | Adapter                  | Execute a catalog-recognized provider operation with its native result semantics.  |

Steering requires an exact active `turnId`, a unique request ID, text-only
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

## Preserve requests

Questions and approvals are normalized pending requests. The ACP layer delivers
them as `session/request_permission` or `elicitation/create` to the browser.
The `_meta.aos` extensions on these requests are defined in
`packages/protocol/acp.ts:315-341`. The vendor permission kind `_allow_session`
(`AOS_PERMISSION_KIND_SESSION`, `acp.ts:60`) represents Hermes' "allow for this
session" scope; the translation lives in
`packages/proxy/acp/translate/requests.ts`. Elicitation questions arrive in
`_meta.aos.questions`; a multi-select question must declare `items.enum` in the
ACP property schema (`requests.ts`) so the SDK accepts the elicitation,
while the response schema does not constrain values to the enum.

Steps for the adapter:

1. Validate the complete native interaction batch.
2. Finish the current segment with a `turn-requires-action` outcome.
3. Preserve normalized request metadata in authoritative history.
4. Retain the native Session while it waits for input.
5. Accept one complete response with `resolved` or `cancelled` entries.
6. Continue the same logical execution (no new turn created).

An answer is not a new user prompt. Repeated identical responses may be
idempotent; conflicting, expired, wrong-Session, or incomplete responses make
no native call. Reload reconstructs the request from normalized history or
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
coordinator and ACP lifecycle state. Use `plan-updated` events for Todos (the ACP layer
translates them to `plan_update`) and structured events for progress. Do not create polling endpoints for state already
carried by the normalized turn or history.

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
- its event stream obeys the proxy-owned turn vocabulary ordering and rejects foreign Session events;
- Stop, steering, commands, Edit/Retry, and requests preserve native
  semantics where supported;
- lost mutation acknowledgements are uncertain and never replayed;
- reconnect restores observation and state without resending prompts;
- provider payloads and paths cannot enter normalized or guest output;
- focused adapter tests and provider-neutral conformance tests pass.

When a runtime's native client is open source and the AOS server-side
requirements (bounded decoding, credential isolation, uncertain-mutation
handling, reconciliation) can be satisfied with a thin wrapper, vendor the
upstream client files byte-identical rather than reimplementing the wire
protocol. Place the copy in a `vendor/` subdirectory, record the upstream pin,
per-file hashes, and a sync recipe in that directory's `UPSTREAM.md`, and
enforce the snapshot with a dedicated test. Keep replay ownership inside the
adapter — if the upstream client offers a replay mode, disable it and let the
adapter drive recovery from authoritative history.

Use the Hermes adapter and its tests as a worked example, not as a transport
template. Its package map is in
[`packages/proxy/adapters/hermes/README.md`](../../packages/proxy/adapters/hermes/README.md).

### Catalog-change subscription

Implement the optional `subscribeCatalogChanges(listener)` method on
`ServerRuntime` when the native provider broadcasts catalog-change signals.
The method returns a `Promise<() => void>` (the unsubscribe function;
`packages/proxy/core/runtime.ts:258`). Hermes uses its native
`sessions.changed` WebSocket event. The ACP layer calls this method to wake
the activity feed on connect; adapters that omit it simply receive no wake.

### Session read state and `unread`

Project `unread` in `AosSessionInfoMeta` only when the native payload proves the
read state (for example, Hermes `last_read_at` NULL means read). Omit `unread`
when the payload is absent or ambiguous; absent never overwrites a known value in
the browser. Declare the read-state capability unavailable rather than emulating
it with a synthetic value.

### Usage reporting

The proxy emits one `usage_update` on `session/new`, on `session/resume`, after
every settled turn, and after a `session/set_config_option` that changes the
model (`packages/proxy/acp/session-attachment.ts:228-242`). Implement
`workspaceCapabilities` to return a `SessionContextResponse`, or declare usage
unavailable; a provider that cannot answer at all leaves the last reading
standing without emitting an empty gauge.

### Published Artifacts

A published Artifact travels as the proxy-owned `artifact-published` turn event
carrying an `AosArtifactDescriptor`
(`packages/protocol/acp.ts:374-396`; translated in
`packages/proxy/acp/translate/turn-events.ts`), or, in history, as a `data`
message part named `aos.artifact`
(`packages/proxy/acp/translate/history.ts:33`). Only `id`, `filename`, and
`source` are required; `source` is `inline`, `url`, or `provider` with an
opaque `reference`. The ACP layer turns either form into a `resource_link`
content block with `uri: "artifact://<id>"` on the owning turn, so a live turn
and a replayed one reach the browser identically. The id must be opaque and
stable for that Agent and Session; never put a native path in it or in any
public tool argument or result.

Emit a descriptor only from an authoritative source: a `present_artifact`
receipt from the `aos-ui` tools MCP server
(`{ok: true, type: "aos.artifact", artifact: {path, filename, mimeType?}}`),
a harness's own `MEDIA:` delivery convention, or a trusted native delivery
tool such as Hermes text-to-speech. `packages/proxy/core/media-lines.ts`
(`MediaLineFilter`) strips `MEDIA:` lines from streamed prose across deltas
and replaces an unclaimed one with `[Media unavailable]`.

Validate every path with `packages/proxy/core/artifact-path.ts` before keeping
it: `safeArtifactPath` accepts only absolute POSIX paths with no `..`
segment, no control characters, at most 4096 bytes, and no credential-like
basename (`.env*`, `auth.json`, `config.yaml`, `credentials`, and similar);
`safeRelativeArtifactPath` applies the same rules to a project-relative path.
Keep the path in a private Agent-and-Session-scoped mapping.

Implement `ServerRuntime.artifact(agentId, publicSessionId, artifactId)`
(`packages/proxy/core/runtime.ts:264-268`) to resolve the id only within that
Session and return `{bytes, mimeType?, filename}`, read through the harness's
own file interface and bounded by `MAX_ARTIFACT_BYTES` (25 MiB). The route
`GET .../sessions/:sessionId/artifacts/:artifactId`
(`packages/proxy/routes/content.ts:87`) serves it on both lanes.

### MCP tool names

The `aos-ui` tools MCP server (`packages/tools-mcp`) and every other MCP server
are registered with the harness by the operator, never by the proxy. Each
harness prefixes MCP tool names its own way, so pass every native tool name
through `canonicalToolName(rawName, resolve)`
(`packages/proxy/core/aos-tool-names.ts`) before it enters the run vocabulary
or history:

- the four `aos-ui` tools read bare: `render_chart`, `render_map`,
  `render_stats`, `present_artifact` (`canonicalAosToolName`);
- any other MCP tool the adapter's resolver recognizes reads
  `mcp__<server>__<tool>`, built from the original server and tool names, so
  one server gives the same name on every runtime;
- an unknown name stays raw.

The resolver matches a raw name against the runtime's own MCP server list,
never by splitting the string. Hermes and OpenCode build it with
`createMcpToolNames(scheme, catalog)` (`packages/proxy/mcp-apps/tool-names.ts`),
where the scheme states how the harness spells a tool: Hermes
`mcp__<sanitized>__<sanitized>` with its 64-character hash clamp, OpenCode
`<server>_<tool>` matched longest server first. OpenClaw resolves
`<server>__<tool>` against its native `tools.effective` answer
(`packages/proxy/adapters/openclaw/mcp-tool-names.ts`). Each list sits in
`createMcpServerCache` (`packages/proxy/core/mcp-server-cache.ts`): one
single-flight fetch per key, reused for 5 minutes; an unknown name refetches
at most once per 30 s; a failed fetch keeps the last good list, and with no
list names stay raw. Use the same resolver live and on replay.

When the harness loads MCP servers per Session rather than globally, enable
`aos-ui` in the adapter before each turn, not in shared coordinator code. The
OpenClaw adapter creates Sessions with
`toolOverrides.mcpServers["aos-ui"] = true` and, before every non-resume turn,
patches the same override onto a Session created elsewhere with a
compare-and-swap on the previous overrides
(`packages/proxy/adapters/openclaw/native-schemas.ts:175-203`,
`packages/proxy/adapters/openclaw/run.ts:1253-1272`). A failed enable fails
the turn rather than running it without the tools.

### MCP Apps

An MCP tool whose server declares a `ui://` view (`_meta.ui.resourceUri`)
renders as an App card. Implement the optional `ServerRuntime.mcpApps`
(`packages/proxy/core/runtime.ts`) in the adapter's `mcp-apps.ts`:

| Method                                             | Answers                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `observe?(scope, call)`                            | A flagged call of this Session's run as it streams: name, then input, then result. |
| `describe(scope, {toolCallId, toolName, result?})` | Whether the call's tool declares a view.                                           |
| `open(scope, toolCallId, signal?)`                 | The `McpAppView`: HTML, CSP, permissions, `prefersBorder`, tool input and result.  |
| `callTool(scope, toolCallId, name, args)`          | A view's `tools/call`, limited to its own server's app-visible tools.              |
| `readResource(scope, toolCallId, uri)`             | A view's `resources/read` on its own server.                                       |

Every method first finds the `toolCallId` in this Session's own native
history, the same scoping as `artifact`, or among the running calls `observe`
heard for that Session; the browser never names a server, tool, or resource
URI. An unknown or foreign call reads as not found. A host that holds its views
natively leaves `observe` out.

Map the native MCP Apps API when the runtime has one (OpenClaw's
`mcp.app.view`, `mcp.app.callTool`, `mcp.app.readResource`). Otherwise build
the hook with `createMcpAppsFallback(source, client)`
(`packages/proxy/mcp-apps/fallback.ts`): the adapter supplies only the server
list and the stored call, and the proxy's own Streamable HTTP client reads the
view. A view named in the stored result wins over the server's `tools/list`.
The fallback reaches only HTTP servers the proxy may connect to: without auth,
or with headers the operator configured under `mcpApps.fallback.servers`
([configuration](../configuration.md#mcp-apps-fallback)), where the operator
may also override the URL the proxy connects to. It is a bridge;
delete it once no adapter reaches it.

Wrap the adapter in `withMcpApps(runtime)` (`packages/proxy/mcp-apps/annotate.ts`)
in its factory, before the coordinator. On the run, recover, and discover
streams the wrapper awaits `describe` (1.5 s budget) when an `mcp__` or bare
`aos-ui` tool call starts, so the browser draws the view while the call runs,
and asks again with the result only for a call the start could not flag. It
does the same for `history()`, sets the `app` flag, and advertises
`content.mcpApps` in the Session capabilities. The ACP layer carries the flag
as `_meta.aos.app` on `tool_call_update`, from the call's first update.

### Registration and adapter file layout

Register a new adapter as a `kind` literal in the `RuntimeSchema` discriminated
union (`packages/proxy/config.ts:109`) and add a corresponding branch in
`packages/proxy/adapters/create-runtime.ts`. The conventional per-adapter
module layout (as used by OpenCode and OpenClaw) is:

| Module              | Responsibility                                           |
| ------------------- | -------------------------------------------------------- |
| `adapter.ts`        | Composes all modules into `ServerRuntime`                |
| `factory.ts`        | Entry point; builds and returns a `RuntimeInstance`      |
| `capabilities.ts`   | Maps native capabilities to normalized form              |
| `client.ts`         | Validated HTTP or RPC client for native API calls        |
| `content.ts`        | Normalizes native content types and attachment envelopes |
| `history.ts`        | Converts authoritative native history rows               |
| `interactions.ts`   | Answers native clarify/approval interactions             |
| `mcp-apps.ts`       | `ServerRuntime.mcpApps`, native or through the fallback  |
| `run.ts`            | Converts native execution frames to proxy-owned events   |
| `workspace.ts`      | Agent/Session catalog and metadata                       |
| `native-schemas.ts` | Validated Zod schemas for native payloads                |

The Hermes adapter predates this layout and uses different module names for
some of these roles; see
[`packages/proxy/adapters/hermes/README.md`](../../packages/proxy/adapters/hermes/README.md).
