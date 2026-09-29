# ACP v2 browser wire

ACP v2 over WebSocket is the browser transport for the normalized AOS proxy. It
is not a server-side runtime adapter; every native runtime (Hermes, OpenClaw,
OpenCode) continues to use its own server-side transport, and the ACP layer in
`packages/proxy/acp/` translates the proxy-owned run vocabulary to ACP before
delivery to the browser.

All AOS extension shapes are defined in `packages/protocol/acp.ts` and imported
by both ends; nothing else defines these shapes.

## Connection

The proxy upgrades a GET request to a WebSocket at:

- `/api/aos/v1/acp` — operator listener (`AOS_ACP_OPERATOR_PATH`, `acp.ts:25`)
- `/api/aos/v1/acp/agents/<agentId>` — per-Agent operator address (`aosAcpAgentPath`, `acp.ts`); scopes the connection to one Agent, does not restrict access beyond it, and must never be exposed publicly
- `/api/guest/v1/acp` — guest listener (`AOS_ACP_GUEST_PATH`, `acp.ts:26`), authenticated with the invitation token via `auth/login`

A request to a socket path that is not a WebSocket handshake (RFC 6455 §4.2.1) gets HTTP 400 before the service reads it. An unknown Agent path gets 404; a catalog that cannot answer gets 503.

`Origin` header rule: an absent `Origin` is admitted (non-browser clients send none); a present `Origin` must equal the configured `publicOrigin` exactly, `null` included, or the upgrade is refused with 401 and logged as `acp.upgrade.origin_refused`.

The response carries an `Acp-Connection-Id` header. One socket per browser tab
is the current topology; there is no SharedWorker multiplexing. The browser
sends an `initialize` request and receives capabilities in `_meta.aos`. On
reconnect, send `initialize` again and then `session/resume` with
`_meta.aos.after` set to the last sequence cursor the browser observed. A
`resync: true` response means the cursor is beyond bounded replay; send
`session/resume` again with `replayFrom: { type: "start" }`.

Reconnect uses jittered backoff starting at 250 ms, capped at 5 000 ms, and
resetting once every resumed Session has rejoined or the link has been stable
for a while. A guest connection re-sends `auth/login` after every transport
recovery before resuming sessions.

Close codes the proxy sends and the browser handles:

| Code   | Meaning                                                                                                                                            | Browser action                |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `1008` | Policy violation (expired credential, rate or size exceeded)                                                                                       | No reconnect; ends connection |
| `1013` | Proxy at capacity                                                                                                                                  | Backs off 30–60 s with jitter |
| `4408` | Handshake unfinished: `initialize` (and a guest's sign-in) not done within 15 s, or the oldest such socket closed past the listener's budget of 32 | Normal reconnect              |

Any other code triggers a normal reconnect.

## Handshake: `initialize` and `auth/login`

`initialize` always answers `protocolVersion: 2`, whatever the client requested; this is ACP's version-negotiation rule, not v1 support.

`initialize` response `_meta.aos` (`AosInitializeMetaSchema`, `acp.ts:115-119`).
Its `version` is AOS's own extension version (`AOS_EXTENSION_VERSION`, now 1),
not ACP's `protocolVersion`:

```json
{
  "version": 1,
  "role": "operator | guest",
  "extensions": {
    "steer": true,
    "rewind": true,
    "composerPrefill": true,
    "agents": true,
    "invalidation": true,
    "activity": true,
    "readState": true,
    "focus": true,
    "guestProjection": true,
    "historyPages": true
  }
}
```

`auth/login` for the guest listener uses `methodId: "aos-invite"` (`AOS_AUTH_METHOD_INVITE`,
`acp.ts:29`) and carries the invitation token in `_meta.aos.token`
(`AosLoginMetaSchema`, `acp.ts`).

The browser sends its compiled build id in `initialize`'s `info.version`; the
proxy answers with the id of the assets it serves. When both sides carry an id
and they differ, the browser reloads once. A `sessionStorage` entry named
`aos-reloaded-for-build` prevents a reload loop: the browser stores the proxy's
id before reloading, and skips the reload if that id matches next time. On the
dev server or in the service worker the browser carries no id and no reload
fires; the proxy uses the AOS extension version in `info.version` instead.

## Guest listener

A guest connection reaches nothing but `initialize` and `auth/login` until it
redeems an invitation (`packages/proxy/guest/acp.ts`). Its `initialize` omits
the runtime's title and advertises only the `aos-invite` auth method. A
connection acts as one invitation for its whole life: a second `auth/login` is
refused with `-32000`.

From the invitation's expiry no frame passes in either direction
(`packages/proxy/acp/socket.ts`): a request received after it is answered
`-32000` and the socket closes with code `1008`, and an outbound frame after it
closes the socket instead of being written. A timer also closes the connection
at expiry; it re-arms in steps of at most 2^31−1 ms, the longest delay one
timer holds (`guest/acp.ts:65`, `:102-107`).

The guest listener advertises (`GUEST_EXTENSIONS`, `guest/acp.ts:51-62`):

| Extension         | Guest   |
| ----------------- | ------- |
| `steer`           | `true`  |
| `rewind`          | `true`  |
| `composerPrefill` | `true`  |
| `agents`          | `false` |
| `invalidation`    | `false` |
| `activity`        | `false` |
| `readState`       | `false` |
| `focus`           | `false` |
| `guestProjection` | `true`  |
| `historyPages`    | `true`  |

The invited Session's capabilities report slash commands, models, and context
usage unavailable, and steering as the runtime reports it.

Every method runs as a member command through the guest middleware stack in
`packages/proxy/guest/middleware/` (commands, scope, history, turns,
permissions; events pass back through it in reverse). The guest addresses the
invited conversation by its reference alone; any other Session id is
`-32002`.

| Method                                                                                                               | Guest behavior                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `session/resume`                                                                                                     | The invited conversation only. A fresh invitation with no Session yet answers idle with nothing to replay.                                   |
| `session/prompt`                                                                                                     | Sends; the first Send creates the invited Session. Edit and Retry (`rewindSourceId`) may name only a user message this connection was shown. |
| `_aos/session/steer`                                                                                                 | Steers the invited conversation's active turn.                                                                                               |
| `session/cancel`                                                                                                     | Stops a turn in the invited conversation only.                                                                                               |
| `session/close`                                                                                                      | Stops the Session's active work for every member, then detaches.                                                                             |
| `_aos/session/focus`                                                                                                 | Accepted, answered `{}`, and ignored: read state is the operator's.                                                                          |
| `session/new`, `session/list`, `session/delete`, `session/set_config_option`, `_aos/session/update`, `_aos/agents/*` | `-32601` method not found, refused before its params are decoded.                                                                            |

`session/prompt` and `_aos/session/steer` refuse, with `-32602`, text that
starts with `/` (after any leading whitespace or zero-width characters) and
text shaped like an invitation envelope. The text itself travels as written.

What a guest is shown:

- The conversation's text passes whole, under the runtime's ids. There are no
  inline size or count caps beyond the frame and queue limits every
  connection has; the REST byte caps still apply.
- Reasoning, tool input and output, terminals, compaction, the model, and
  subagent prose are dropped. A tool call that declares an MCP App reaches
  the guest as its card alone.
- Questions (`elicitation/create`) reach the guest unchanged, and the guest may
  answer them.
- Permission requests are never shown to a guest. One raised in a turn the
  guest started is declined for it: with `deny`, or `cancelled` when `deny` is
  not offered. One raised in another member's turn is hidden and left for the
  operator to answer.
- No feeds: no `usage_update`, no model readings, no `_aos/activity`, no
  `session_info_update`, and no `_aos/catalog_invalidated`.

Guest errors carry only a public code (`PUBLIC_ERRORS`,
`packages/proxy/acp/validation.ts`): an error reply keeps its JSON-RPC code
with the code's public name as its message, and an `_aos/error` notification
keeps only a public code. Any other failure reads `-31013`
`temporarily_unavailable`. In a batched reply each entry is redacted
independently; a successful entry in the same batch is unaffected.

## Session lifecycle methods

`session/new`, `session/list`, `session/resume`, `session/prompt`,
`session/cancel`, `session/close`, `session/delete`, `session/set_config_option`
(model → `category: "model"`, effort → `category: "thought_level"`).

`session/close` stops the Session's active work for every member and then
detaches this connection. `_aos/session/part` (`AosSessionPartRequestSchema`,
`acp.ts`) only detaches this connection; the Session's work and all other
members continue. `session/delete` of a Session not known to this connection
succeeds rather than returning not-found.

### Request `_meta.aos` shapes

**`session/new`** request (`AosSessionNewMetaSchema`, `acp.ts`): `{ agentId, title?, clientId? }`

`clientId` is an optional opaque id the browser picks for this create. The
coordinator dedupes it: a retry with the same `clientId` returns the Session the
first create opened rather than creating a second one.

`session/new` and `session/resume` on the operator listener enforce a folder
rule: `cwd` must equal the Agent's folder exactly (folded on the string; `..`
and trailing separators are allowed, but a relative path is refused). Any other
`cwd` returns invalid params naming the folder; an Agent with no folder returns
unsupported. A non-empty `mcpServers` or `additionalDirectories` also returns
invalid params. The runtime never receives the client's `cwd`. Every list row
carries its Agent's folder; `_aos/agents/list` rows carry `folder` too. A list
with a `cwd` filter that matches no Agent's folder returns no rows. A list across
Agents skips, and logs, any Agent with no folder (`session.list.no_folder`) or an
unreadable one (`session.list.folder_read_failed`), and still lists every other
Agent's rows; a list on one Agent's address answers either as an error.
`session/delete` on the shared address for a Session this connection never
listed or resumed returns invalid params naming the per-Agent address; on an
Agent's address a Session that is already gone deletes successfully.

**`session/list`** request (`AosSessionListMetaSchema`, `acp.ts:138-140`): `{ agentId? }`

**`session/resume`** request (`AosSessionResumeMetaSchema`, `acp.ts:168-174`):

```json
{ "agentId?": "…", "after?": 0, "turnId?": "…" }
```

`agentId` is optional and used for deep links when the client knows the owning
Agent before listing. `after` is the last `sequence` the client observed for
`turnId`. `resync: true` on the response means `after` was beyond bounded
replay; resume again with `replayFrom: { type: "start" }`.

`replayFrom` is absent (resume without replay), `{ type: "start" }`, or the
`_aos/before` older-page variant described under
[Older history pages](#older-history-pages). As ACP asks of a receiver that
does not understand a cursor, the proxy rejects every other `replayFrom` type,
and an `_aos/before` without a string `cursor`, with `-32602` invalid params
rather than guessing where to replay from.

**`session/prompt`** request (`AosPromptMetaSchema`, `acp.ts`):
`{ rewindSourceId?, attachmentStageId?, clientId? }`. `clientId` becomes the
turn's `turnId`; a retry with the same `clientId` returns the first answer
unchanged. The response carries the minted user-message id as the top-level
`messageId` field (SDK 1.5.0 `PromptResponse`); the answer is sent only after
the runtime confirms it stored the prompt. Attachment content referenced by
`resource_link` blocks uses the `aos-attachment:` URI scheme
(`AOS_ATTACHMENT_URI_SCHEME`, `acp.ts`).

### Response `_meta.aos` shapes

**`session/new`** response: `{ sessionId }` as a top-level result field, with no
`_meta.aos`. The Session row (`session_info_update`), capabilities
(`available_commands_update._meta.aos.capabilities`), models, and usage arrive
as events after the answer.

**`session/resume`** response (`AosSessionResumeResponseMetaSchema`, `acp.ts`):
`{ position?, resync?, history? }` in `_meta.aos` — nothing else. `position` is
the turn and sequence the joined Session stands at; a later resume continues
from it. Session info (`session_info_update`), execution state (`state_update`),
capabilities (`available_commands_update._meta.aos.capabilities`), models, and
usage arrive as events after the answer. `resync: true` means `after` was beyond
bounded replay; resume again with `replayFrom: { type: "start" }`. A resume that
replayed carries `history` (`AosHistoryCursorSchema`): `{ nextCursor?, truncated? }`.

**`session_info_update`** `_meta.aos` (`AosSessionInfoMetaSchema`, `acp.ts:148-153`):
`{ agentId, status, archived, createdAt?, unread?, pinned? }`. `createdAt` is
the UTC ISO timestamp of when the Session was created, absent when the runtime
does not report it. `unread` and `pinned` are absent when the runtime does not
track that state or this read cannot know it; **absent never overwrites a known
value** in the browser.

### Older history pages

A client that pages history advertises it in `initialize`'s
`clientCapabilities._meta.aos.historyPages: true` (`AosClientCapabilitiesMetaSchema`,
default `false`). To that client, a server that sets `extensions.historyPages`
(default `false`) replays only the newest page on a `start` resume and serves
older ones through
`session/resume` with the reserved variant (`AOS_REPLAY_BEFORE`,
`AosReplayBeforeSchema`):

```json
{ "type": "_aos/before", "cursor": "…", "_meta?": {} }
```

Any other client gets what ACP's `start` promises: every retained message,
read page by page on the server, with no `nextCursor` in the reply. The reply
still carries `truncated: true` when the reading stopped at a reach bound.

- `cursor` is the opaque `history.nextCursor` of an earlier resume, 1 to 256
  characters. The server picks the page size; offsets count back from the
  newest message, and pages break at turn starts.
- The page's messages arrive as `session/update`s before the response, each
  tagged `_meta.aos.historyPage: { cursor }` (`AosHistoryPageTagSchema`). The
  browser keeps them out of the turn position and every live listener. A page
  never carries `plan_update`; the Todo plan and a restored failed turn come
  only with the newest page.
- The response carries only `_meta.aos.history`
  (`AosHistoryPageResponseMetaSchema`). A missing `nextCursor` means the
  beginning. `truncated: true` with no cursor means the proxy's bound stopped
  the reading, or the runtime's own reach did, and the thread says earlier
  messages can't be loaded.
- A page is read only for a Session this connection has resumed, whether by
  a resume, `session/new`, or a prompt, one at a time per Session. It never
  resumes, restates configuration or usage, or reports execution. A cursor that does not decode, or points past the
  history, is invalid params.
- An accepted rewind deletes the newest rows, so it marks the browser's cursor
  stale and drops a page still loading; the next load resumes from `start`
  first. A resync likewise returns the thread to the newest page.

## Run stream

Message ids are set where the message is born and are the same live and after a
reload. One prompt produces one turn: the state sequence is `running` →
`requires_action`? → `running`? → one `idle`. Stop (`session/cancel`) sends the
stop signal to the runtime; the turn continues until the runtime confirms it
ended.

On reconnect (session/resume with replay) a client with a pending prompt
receives history first, then buffered live events, then the current state, then
the stored prompt answer (if it arrived before the storage deadline).
Catch-up uses only standard ACP session updates; no `_aos/session_invalidated`
or `_aos/steer_accepted` is sent.

| ACP event                   | Meaning                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `agent_message_chunk`       | Streaming assistant prose                                                                                |
| `agent_thought_chunk`       | Streaming reasoning                                                                                      |
| `tool_call_update`          | Tool lifecycle and argument deltas                                                                       |
| `state_update`              | Run state transitions                                                                                    |
| `plan_update`               | Session Todos in `_meta.aos.todos`                                                                       |
| `usage_update`              | Context window usage                                                                                     |
| `session_info_update`       | Session metadata changes                                                                                 |
| `available_commands_update` | Slash commands and capabilities in `_meta.aos.capabilities` (`AosAvailableCommandsMetaSchema`, `acp.ts`) |
| `config_option_update`      | Current model and effort-level selection                                                                 |

`usage_update` carries the used and total token counts in its own fields, and
the provider's attribution and provenance in `_meta.aos` (`source`,
`estimated`, `breakdown`). It is session-scoped rather than run-scoped: the
proxy sends one on `session/new`, on `session/resume`, after every settled turn,
and after a `session/set_config_option` that changes the model, because the
window grows with the conversation and its size belongs to the model. A provider
that cannot report usage sends none, and the last reading stands.

### Turn stream `_meta.aos`

Every event emitted from a turn carries a base of
`{ sequence, turnId }` (`acp.ts:251-254`).

| Event                                 | Extra `_meta.aos` fields                                                    |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `state_update`                        | `execution?: "stopping"`, `code?`, `message?` (`acp.ts:257-264`)            |
| `agent_message_chunk`/`thought_chunk` | (base only) — identical live and on replay (`AosChunkMetaSchema`)           |
| `tool_call_update`                    | `messageId`, `argsTextDelta?`, `argsText?` (`acp.ts:281-287`)               |
| `plan_update`                         | `sequence`, `turnId?`, `todos` (`acp.ts:290-294`)                           |
| `usage_update`                        | `source`, `estimated?`, `breakdown?` (`acp.ts:303-307`); no sequence/turnId |

Stop reasons `_aos_error` and `_aos_uncertain` appear in
`state_update { state: "idle" }` (`AOS_STOP_REASONS`, `acp.ts:54-57`). A
`state_update { state: "running" }` carrying `code` and `message` reports a
final failure on a run that stays active until it is stopped: the browser shows
the failure and keeps Stop available, and the run's own idle update ends it.
A prompt the proxy accepted whose turn then fails to start reaches its sender
as a `running` update followed by an `_aos_error` idle update for the same
`turnId`, carrying only a public `code`, never an `_aos/error` notification.

## AOS extension methods (`_aos/*`)

### Requests (client → server, expect a response)

| Method                | Purpose                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_aos/session/update` | Set title, archived, or unread (exactly one intent per call; `acp.ts`)                                                                                                                         |
| `_aos/session/part`   | Detach this connection from the Session; the Session's work and all other members continue (`AosSessionPartRequestSchema`, `acp.ts`)                                                           |
| `_aos/session/steer`  | Deliver a text correction to the active run                                                                                                                                                    |
| `_aos/session/focus`  | Report the exposed Session and workspace presence; answered `{}`. An absent `sessionId` changes nothing — the browser may send `{}` as its liveness probe. (`AosFocusRequestSchema`, `acp.ts`) |
| `_aos/agents/list`    | Fetch the agent catalog                                                                                                                                                                        |
| `_aos/agents/update`  | Write visibility and/or avatar; compare-and-set on the observed revision (`AosAgentUpdateRequestSchema`, `acp.ts`)                                                                             |

### Notifications (no response expected)

| Method                     | Direction     | Purpose                                                  |
| -------------------------- | ------------- | -------------------------------------------------------- |
| `_aos/activity`            | server→client | Workspace-wide activity feed item (union type, `acp.ts`) |
| `_aos/composer_prefill`    | server→client | Composer prefill text from a slash command               |
| `_aos/catalog_invalidated` | server→client | Agent catalog may have changed (no params)               |
| `_aos/error`               | server→client | Connection-level failure with no request to answer       |

#### `_aos/activity` union (`acp.ts:466-493`)

Every item carries `{ agentId, sessionId, occurredAt }` plus a discriminant `type`:

| `type`                | Extra fields                            |
| --------------------- | --------------------------------------- |
| `turn-started`        | `turnId`                                |
| `turn-finished`       | `turnId`                                |
| `turn-failed`         | `turnId`                                |
| `attention-requested` | `requestId`, `attentionKind: "question" | "permission"` |
| `attention-resolved`  | `requestId`                             |
| `unread-changed`      | `unread: boolean`                       |

## Artifacts

A published Artifact reaches the browser as an ACP `resource_link` content
block inside the turn's `agent_message_chunk` (or `user_message_chunk`), both
live and on replay (`packages/proxy/acp/translate/updates.ts`):

```json
{
  "type": "resource_link",
  "uri": "artifact://ARTIFACT_ID",
  "name": "report.pdf",
  "mimeType": "application/pdf",
  "size": 48213
}
```

`uri` carries only the opaque, URI-encoded artifact id
(`AOS_ARTIFACT_URI_SCHEME`, `formatArtifactUri`, and `parseArtifactUri`,
`acp.ts:30`, `acp.ts:405-421`); it never carries a native path or a route.
`mimeType` and `size` appear only when the publishing tool reported them. The
proxy-side descriptor behind it is `AosArtifactDescriptorSchema`
(`acp.ts:378-396`), whose `source` never reaches the browser.

The browser fetches the bytes from the artifact route of the Session it is
viewing: a same-origin
`GET /api/aos/v1/agents/:agentId/sessions/:sessionId/artifacts/:artifactId` on
the operator listener, or the `/api/guest/v1/...` mirror with the guest's
invitation token as a Bearer `Authorization` header. The proxy resolves the id only against that Session's own
provider history.

## Interactions: permission and elicitation

ACP delivers pending interactions as `session/request_permission` or
`elicitation/create`. The AOS `_meta.aos` extensions carried on these are
(`acp.ts:409-440`):

**Permission** (`AosPermissionMetaSchema`, `acp.ts:409`):
`{ requestId, expiresAt?, message? }`.
The vendor permission kind `_allow_session` (`AOS_PERMISSION_KIND_SESSION`,
`acp.ts:67`) represents Hermes' "allow for this session" scope.

A permission names the call it guards in `subject.toolCall` when the adapter
knows it: OpenCode from the native `source.callID`, Hermes from the one tool
still running when the approval arrives. OpenClaw approvals name no call. The
browser (`acp-approvals.ts`) holds each request for the connection's lifetime
and projects it as Assistant UI's native `approval` on that tool part, or on a
standalone `request_permission` part in the current turn, and answers through
`onRespondToToolApproval`. The chosen option is kept only while the tab is
open: after a reload the tool's own result shows the outcome, and a request
still pending is re-sent by the proxy.

**Elicitation** (`AosElicitationMetaSchema`, `acp.ts:436`):
`{ requestId, expiresAt?, questions[] }`. Each question carries
`{ id?, header, prompt, options[], multiple?, custom? }`. A multi-select
question must declare `items.enum` in the ACP property schema
(`packages/proxy/acp/translate/requests.ts`); a free-text answer
remains valid because the response schema does not constrain values to the enum.

## JSON-RPC error codes

Every error ACP defines travels with ACP's own code, built by the SDK. The AOS
block covers only the failures ACP has no code for (`AOS_JSONRPC_ERRORS`,
`acp.ts`):

**ACP standard codes:**

| Code     | SDK constructor      | Meaning                                              |
| -------- | -------------------- | ---------------------------------------------------- |
| `-32000` | `authRequired()`     | Authentication required (guest: no valid invitation) |
| `-32002` | `resourceNotFound()` | Agent or Session does not exist                      |
| `-32601` | `methodNotFound()`   | Method not recognized                                |
| `-32602` | `invalidParams()`    | Request parameters failed validation                 |
| `-32800` | `requestCancelled()` | Request timed out or the transport closed            |

**AOS-only codes (`AOS_JSONRPC_ERRORS`, block from -31010):**

| Code     | Name                     | Meaning                                                     |
| -------- | ------------------------ | ----------------------------------------------------------- |
| `-31010` | `turnInProgress`         | Cannot send while a turn is active                          |
| `-31011` | `staleRequest`           | Request ID no longer valid                                  |
| `-31012` | `revisionConflict`       | Observed Agent revision or source message no longer current |
| `-31013` | `temporarilyUnavailable` | Runtime not reachable; retry later                          |
| `-31014` | `uncertainMutation`      | Mutation dispatched but outcome unknown                     |
| `-31015` | `unsupported`            | Runtime cannot store a requested Agent field                |

Codes `-32001` through `-32009` are no longer used.

The machine name an error travels as — the `message` of a public reply, and the
`code` field of an `_aos/error` notification (`AosErrorNotificationSchema`,
`acp.ts`) — is keyed by its numeric code:

| Code     | Machine name              |
| -------- | ------------------------- |
| `-32000` | `authentication_required` |
| `-32002` | `not_found`               |
| `-32601` | `method_not_found`        |
| `-32602` | `invalid_request`         |
| `-32800` | `request_cancelled`       |
| `-31010` | `turn_in_progress`        |
| `-31011` | `stale_request`           |
| `-31012` | `revision_conflict`       |
| `-31013` | `temporarily_unavailable` |
| `-31014` | `uncertain_mutation`      |
| `-31015` | `unsupported`             |
| (other)  | `internal_error`          |

## REST remains for bytes and discovery

| Method | Path                                                                    | Purpose                                                     |
| ------ | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| `GET`  | `/api/aos/v1/healthz`                                                   | Liveness probe (always 200; body `{status, links, gauges}`) |
| `GET`  | `/api/aos/v1/readyz`                                                    | Readiness probe                                             |
| `GET`  | `/api/aos/v1/runtime`                                                   | Runtime discovery                                           |
| `POST` | `/api/aos/v1/agents/:agentId/sessions/:sessionId/attachments/stage`     | Stage an attachment                                         |
| `GET`  | `/api/aos/v1/agents/:agentId/sessions/:sessionId/artifacts/:artifactId` | Download an Artifact                                        |
| `POST` | `/api/aos/v1/agents/:agentId/audio/transcribe`                          | Audio → text                                                |
| `POST` | `/api/aos/v1/agents/:agentId/audio/speak`                               | Text → audio                                                |
| `POST` | `/api/aos/v1/guest-invitations`                                         | Issue a guest invitation                                    |

Guest-listener mirrors under `/api/guest/v1/` (authenticated with the invitation
token, scoped to the invited Agent and Session):

| Method | Path                                                                      | Purpose              |
| ------ | ------------------------------------------------------------------------- | -------------------- |
| `GET`  | `/api/guest/v1/runtime`                                                   | Guest runtime info   |
| `POST` | `/api/guest/v1/agents/:agentId/sessions/:sessionId/attachments/stage`     | Stage an attachment  |
| `GET`  | `/api/guest/v1/agents/:agentId/sessions/:sessionId/artifacts/:artifactId` | Download an Artifact |
| `POST` | `/api/guest/v1/agents/:agentId/audio/transcribe`                          | Audio → text         |
| `POST` | `/api/guest/v1/agents/:agentId/audio/speak`                               | Text → audio         |

## Browser modules

`src/runtime-adapters/aos/acp/` owns the browser side:

- `connection.ts` — `createAcpConnection`
- `acp-workspace-client.ts` — `WorkspaceAdapter` over ACP
- `acp-workspace-client-sessions.ts` — session list and lifecycle operations
- `acp-workspace-client-composer.ts` — composer and attachment operations
- `session-projector.ts` + `projector-messages.ts` — pure reducer to Assistant UI messages
- `use-acp-runtime.ts` — `useExternalStoreRuntime`
- `acp-thread-list.ts` — thread list integration
- `acp-approvals.ts` — permission → Assistant UI tool approval
- `acp-interactions.ts` — elicitation → `RuntimeQuestion`
- `types.ts` — shared connection and subscription types

## Verify

```bash
bunx vitest run src/runtime-adapters/aos/acp
```

See [Troubleshooting](../troubleshooting.md) for connection and ownership failures.
