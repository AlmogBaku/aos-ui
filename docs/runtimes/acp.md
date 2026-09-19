# ACP v2 browser wire

ACP v2 over WebSocket is the browser transport for the normalized AOS proxy. It
is not a server-side runtime adapter; every native runtime (Hermes, OpenClaw,
OpenCode) continues to use its own server-side transport, and the ACP layer in
`packages/proxy/acp/` translates the proxy-owned run vocabulary to ACP before
delivery to the browser.

## Connection

The proxy upgrades a GET request to a WebSocket at:

- `/api/aos/v1/acp` — operator lane
- `/api/guest/v1/acp` — guest lane (authenticated with the invitation token via `auth/login`)

The response carries an `Acp-Connection-Id` header. The browser sends an
`initialize` request and receives capabilities in `_meta.aos`. On reconnect,
send `initialize` again and then `session/resume` with `_meta.aos.after` set to
the last sequence cursor the browser observed. A `resync: true` response means
the cursor is beyond bounded replay; send `session/resume` again with
`replayFrom: { type: "start" }`.

## Run stream

| ACP event             | Meaning                            |
| --------------------- | ---------------------------------- |
| `agent_message_chunk` | Streaming assistant prose          |
| `agent_thought_chunk` | Streaming reasoning                |
| `tool_call_update`    | Tool lifecycle and argument deltas |
| `state_update`        | Run state transitions              |
| `plan_update`         | Session Todos in `_meta.aos.todos` |
| `usage_update`        | Token and resource usage           |
| `session_info_update` | Session metadata changes           |

## Session lifecycle methods

`session/new`, `session/list`, `session/resume`, `session/prompt`,
`session/cancel`, `session/close`, `session/delete`, `session/set_config_option`
(model → `category: "model"`, effort → `category: "thought_level"`).

## AOS extension methods (`_aos/*`)

All extension shapes are defined in `packages/protocol/acp.ts`:

| Method                       | Direction     | Purpose                                            |
| ---------------------------- | ------------- | -------------------------------------------------- |
| `_aos/session/update`        | client→server | Set title, archived, or unread (one intent)        |
| `_aos/session/steer`         | client→server | Deliver a text correction to the active run        |
| `_aos/session/focus`         | client→server | Report the exposed Session (arms read-state)       |
| `_aos/agents/list`           | client→server | Fetch the agent catalog                            |
| `_aos/agents/set_visibility` | client→server | Mutate agent visibility                            |
| `_aos/activity`              | server→client | Workspace-wide activity feed item                  |
| `_aos/artifact`              | server→client | Published Artifact descriptor                      |
| `_aos/steer_accepted`        | server→client | Replayable steering acknowledgement                |
| `_aos/composer_prefill`      | server→client | Composer prefill text from a slash command         |
| `_aos/catalog_invalidated`   | server→client | Agent catalog may have changed                     |
| `_aos/session_invalidated`   | server→client | Session record may have changed                    |
| `_aos/error`                 | server→client | Connection-level failure with no request to answer |

Stop reasons `_aos_error` and `_aos_uncertain` appear in `state_update { state: "idle" }`.

## REST remains for bytes and discovery

| Method | Path                        | Purpose              |
| ------ | --------------------------- | -------------------- |
| `GET`  | `/api/aos/v1/runtime`       | Runtime discovery    |
| `POST` | `/api/aos/v1/attachments`   | Stage an attachment  |
| `GET`  | `/api/aos/v1/artifacts/:id` | Download an Artifact |
| `POST` | `/api/aos/v1/transcribe`    | Audio → text         |
| `POST` | `/api/aos/v1/speak`         | Text → audio         |

## Browser modules

`src/runtime-adapters/aos/acp/` owns the browser side:

- `connection.ts` — `createAcpConnection`
- `acp-workspace-client.ts` — `WorkspaceAdapter` over ACP
- `session-projector.ts` + `projector-messages.ts` — pure reducer to Assistant UI messages
- `use-acp-runtime.ts` — `useExternalStoreRuntime`
- `acp-thread-list.ts` — thread list integration
- `acp-interactions.ts` — permission/elicitation → `RuntimeQuestion`

## Verify

```bash
bunx vitest run src/runtime-adapters/aos/acp
```

See [Troubleshooting](../troubleshooting.md) for connection and ownership failures.
