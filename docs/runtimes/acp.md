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

- `/api/aos/v1/acp` — operator lane (`AOS_ACP_OPERATOR_PATH`, `acp.ts:25`)
- `/api/guest/v1/acp` — guest lane (`AOS_ACP_GUEST_PATH`, `acp.ts:26`), authenticated with the invitation token via `auth/login`

The response carries an `Acp-Connection-Id` header. One socket per browser tab
is the current topology; there is no SharedWorker multiplexing. The browser
sends an `initialize` request and receives capabilities in `_meta.aos`. On
reconnect, send `initialize` again and then `session/resume` with
`_meta.aos.after` set to the last sequence cursor the browser observed. A
`resync: true` response means the cursor is beyond bounded replay; send
`session/resume` again with `replayFrom: { type: "start" }`.

Reconnect uses exponential back-off starting at 250 ms and capped at 5 000 ms
(`connection.ts:59-60`). A guest connection re-sends `auth/login` after every
transport recovery before resuming sessions.

## Handshake: `initialize` and `auth/login`

`initialize` response `_meta.aos` (`AosInitializeMetaSchema`, `acp.ts:115-119`):

```json
{
  "version": 1,
  "lane": "operator | guest",
  "extensions": {
    "steer": true,
    "rewind": true,
    "artifacts": true,
    "composerPrefill": true,
    "agents": true,
    "invalidation": true,
    "activity": true,
    "readState": true,
    "focus": true,
    "guestProjection": true
  }
}
```

`auth/login` for the guest lane uses `methodId: "aos-invite"` (`AOS_AUTH_METHOD_INVITE`,
`acp.ts:29`) and carries the invitation token in `_meta.aos.token`
(`AosLoginMetaSchema`, `acp.ts:123-125`).

## Session lifecycle methods

`session/new`, `session/list`, `session/resume`, `session/prompt`,
`session/cancel`, `session/close`, `session/delete`, `session/set_config_option`
(model → `category: "model"`, effort → `category: "thought_level"`).

### Request `_meta.aos` shapes

**`session/new`** request (`AosSessionNewMetaSchema`, `acp.ts:132-135`): `{ agentId, title? }`

**`session/list`** request (`AosSessionListMetaSchema`, `acp.ts:138-140`): `{ agentId? }`

**`session/resume`** request (`AosSessionResumeMetaSchema`, `acp.ts:168-174`):

```json
{ "agentId?": "…", "after?": 0, "runId?": "…" }
```

`agentId` is optional and used for deep links when the client knows the owning
Agent before listing. `after` is the last `sequence` the client observed for
`runId`. `resync: true` on the response means `after` was beyond bounded
replay; resume again with `replayFrom: { type: "start" }`.

**`session/prompt`** request (`AosPromptMetaSchema`, `acp.ts:198-203`):
`{ rewindSourceId?, attachmentStageId? }`. The response carries the minted
user-message id in `_meta.aos.messageId` (`AosPromptResponseMetaSchema`,
`acp.ts:181-183`). Attachment content referenced by `resource_link` blocks uses
the `aos-attachment:` URI scheme (`AOS_ATTACHMENT_URI_SCHEME`, `acp.ts:30`).

### Response `_meta.aos` shapes

**`session/new`** response (`AosSessionNewResponseMetaSchema`, `acp.ts:162-165`):
`{ session: AosSessionInfoMeta, capabilities }`.

**`session/resume`** response (`AosSessionResumeResponseMetaSchema`, `acp.ts:190-195`):
`{ session: AosSessionInfoMeta, execution: { status, runId? }, capabilities, resync? }`.

**`session_info_update`** `_meta.aos` (`AosSessionInfoMetaSchema`, `acp.ts:148-153`):
`{ agentId, status, archived, unread? }`. `unread` is absent when the runtime
does not track read state or this read cannot know it; **absent never overwrites
a known value** in the browser.

## Run stream

| ACP event             | Meaning                            |
| --------------------- | ---------------------------------- |
| `agent_message_chunk` | Streaming assistant prose          |
| `agent_thought_chunk` | Streaming reasoning                |
| `tool_call_update`    | Tool lifecycle and argument deltas |
| `state_update`        | Run state transitions              |
| `plan_update`         | Session Todos in `_meta.aos.todos` |
| `usage_update`        | Context window usage               |
| `session_info_update` | Session metadata changes           |

`usage_update` carries the used and total token counts in its own fields, and
the provider's attribution and provenance in `_meta.aos` (`source`,
`estimated`, `breakdown`). It is session-scoped rather than run-scoped: the
proxy sends one on `session/new`, on `session/resume`, after every settled turn,
and after a `session/set_config_option` that changes the model, because the
window grows with the conversation and its size belongs to the model. A provider
that cannot report usage sends none, and the last reading stands.

### Run stream `_meta.aos`

Every event emitted from a run segment carries a base of
`{ sequence, runId }` (`acp.ts:251-254`).

| Event                                 | Extra `_meta.aos` fields                                                   |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `state_update`                        | `execution?: "stopping"`, `code?`, `message?` (`acp.ts:257-264`)           |
| `agent_message_chunk`/`thought_chunk` | (base only) — identical live and on replay (`AosChunkMetaSchema`)          |
| `tool_call_update`                    | `messageId`, `argsTextDelta?`, `argsText?` (`acp.ts:281-287`)              |
| `plan_update`                         | `sequence`, `runId?`, `todos` (`acp.ts:290-294`)                           |
| `usage_update`                        | `source`, `estimated?`, `breakdown?` (`acp.ts:303-307`); no sequence/runId |

Stop reasons `_aos_error` and `_aos_uncertain` appear in
`state_update { state: "idle" }` (`AOS_STOP_REASONS`, `acp.ts:54-57`).

## AOS extension methods (`_aos/*`)

### Requests (client → server, expect a response)

| Method                       | Purpose                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `_aos/session/update`        | Set title, archived, or unread (exactly one intent per call; `acp.ts:206-222`) |
| `_aos/session/steer`         | Deliver a text correction to the active run                                    |
| `_aos/agents/list`           | Fetch the agent catalog                                                        |
| `_aos/agents/set_visibility` | Mutate agent visibility                                                        |

### Notifications (no response expected)

| Method                     | Direction     | Purpose                                                                                                                                                                                                        |
| -------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_aos/session/focus`       | client→server | Report the exposed Session (arms read-state); `AosFocusNotificationSchema`, `acp.ts:232-235`                                                                                                                   |
| `_aos/activity`            | server→client | Workspace-wide activity feed item (union type, `acp.ts:419-446`)                                                                                                                                               |
| `_aos/artifact`            | server→client | Published Artifact descriptor (`acp.ts:373-378`)                                                                                                                                                               |
| `_aos/steer_accepted`      | server→client | Replayable steering acknowledgement                                                                                                                                                                            |
| `_aos/composer_prefill`    | server→client | Composer prefill text from a slash command                                                                                                                                                                     |
| `_aos/catalog_invalidated` | server→client | Agent catalog may have changed (no params)                                                                                                                                                                     |
| `_aos/session_invalidated` | server→client | Reserved in the contract (`acp.ts:396-399`); **not emitted by the proxy today**. Session row changes reach the browser as `session_info_update`. Wiring or removing this notification is a follow-up decision. |
| `_aos/error`               | server→client | Connection-level failure with no request to answer                                                                                                                                                             |

#### `_aos/activity` union (`acp.ts:419-446`)

Every item carries `{ agentId, sessionId, occurredAt }` plus a discriminant `type`:

| `type`                | Extra fields                            |
| --------------------- | --------------------------------------- |
| `run-started`         | `lifecycleId`                           |
| `run-finished`        | `lifecycleId`                           |
| `run-failed`          | `lifecycleId`                           |
| `attention-requested` | `requestId`, `attentionKind: "question" | "permission"` |
| `attention-resolved`  | `requestId`                             |
| `unread-changed`      | `unread: boolean`                       |

#### `_aos/artifact` descriptor (`acp.ts:352-378`)

`source` is a discriminated union on `type`:

| `type`     | Extra fields      |
| ---------- | ----------------- |
| `inline`   | `encoding: "utf8" | "base64"`, `data` |
| `url`      | `url`             |
| `provider` | `reference`       |

## Interactions: permission and elicitation

ACP delivers pending interactions as `session/request_permission` or
`elicitation/create`. The AOS `_meta.aos` extensions carried on these are
(`acp.ts:315-341`):

**Permission** (`AosPermissionMetaSchema`, `acp.ts:315-319`):
`{ interruptId, expiresAt?, message? }`.
The vendor permission kind `_allow_session` (`AOS_PERMISSION_KIND_SESSION`,
`acp.ts:60`) represents Hermes' "allow for this session" scope.

**Elicitation** (`AosElicitationMetaSchema`, `acp.ts:337-341`):
`{ interruptId, expiresAt?, questions[] }`. Each question carries
`{ id?, header, prompt, options[], multiple?, custom? }`. A multi-select
question must declare `items.enum` in the ACP property schema
(`packages/proxy/acp/translate/interrupts.ts:164-179`); a free-text answer
remains valid because the response schema does not constrain values to the enum.

## JSON-RPC error codes

The proxy returns these vendor error codes beyond the standard JSON-RPC set
(`AOS_JSONRPC_ERRORS`, `acp.ts:69-79`):

| Code     | Name                     | Meaning                                      |
| -------- | ------------------------ | -------------------------------------------- |
| `-32001` | `authenticationRequired` | No valid session token (guest lane)          |
| `-32002` | `runInProgress`          | Cannot send while a run is active            |
| `-32003` | `staleInterrupt`         | Interrupt ID no longer valid                 |
| `-32004` | `notFound`               | Agent or Session does not exist              |
| `-32005` | `revisionConflict`       | Edit/rewind source message no longer current |
| `-32006` | `temporarilyUnavailable` | Runtime not reachable; retry later           |
| `-32007` | `connectionInterrupted`  | Transport dropped mid-mutation               |
| `-32008` | `uncertainMutation`      | Mutation dispatched but outcome unknown      |
| `-32602` | `invalidRequest`         | Request parameters failed validation         |

## REST remains for bytes and discovery

| Method | Path                                                                    | Purpose                  |
| ------ | ----------------------------------------------------------------------- | ------------------------ |
| `GET`  | `/api/aos/v1/healthz`                                                   | Liveness probe           |
| `GET`  | `/api/aos/v1/readyz`                                                    | Readiness probe          |
| `GET`  | `/api/aos/v1/runtime`                                                   | Runtime discovery        |
| `POST` | `/api/aos/v1/agents/:agentId/sessions/:sessionId/attachments/stage`     | Stage an attachment      |
| `GET`  | `/api/aos/v1/agents/:agentId/sessions/:sessionId/artifacts/:artifactId` | Download an Artifact     |
| `POST` | `/api/aos/v1/agents/:agentId/audio/transcribe`                          | Audio → text             |
| `POST` | `/api/aos/v1/agents/:agentId/audio/speak`                               | Text → audio             |
| `POST` | `/api/aos/v1/guest-invitations`                                         | Issue a guest invitation |

Guest-lane mirrors under `/api/guest/v1/` (authenticated with the invitation
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
- `acp-interactions.ts` — permission/elicitation → `RuntimeQuestion`
- `types.ts` — shared connection and subscription types

## Verify

```bash
bunx vitest run src/runtime-adapters/aos/acp
```

See [Troubleshooting](../troubleshooting.md) for connection and ownership failures.
