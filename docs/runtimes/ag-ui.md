# Generic AG-UI server adapter status

Generic AG-UI is a server-side adapter seam, not a browser runtime mode. The
browser connects only to the normalized AOS proxy (`aos`) or explicit fixture
mode. A future proxy deployment may use AG-UI when its workspace contract is
implemented.

## Required services

The run service must accept AG-UI requests at one absolute HTTP(S) URL. AOS creates one public `HttpAgent` instance per Session.

The workspace service must implement:

| Method | Path                  | Purpose                                                                     |
| ------ | --------------------- | --------------------------------------------------------------------------- |
| `GET`  | `/agents`             | List provider-filtered Agents and optional visibility/editability metadata. |
| `GET`  | `/sessions`           | List Sessions with `threadId`, `agentId`, status, and update time.          |
| `POST` | `/sessions`           | Create a Session for the requested Agent.                                   |
| `GET`  | `/sessions/:threadId` | Load messages and resumable state for one Session.                          |

Session creation must return the same `agentId` requested by AOS. Ownership mismatches are rejected.

There is no supported `AOS_UI_RUNTIME_MODE=ag-ui` command or public
`mode: "ag-ui"` configuration. The following describes the contract a future
server adapter must implement internally.

Both services must allow the browser origin or be placed behind an operator-managed same-origin proxy.

## Optional workspace behavior

The workspace transport may subscribe to catalog/Session changes and may expose Agent visibility updates. Each catalog entry controls whether it is selectable and editable. AOS re-reads the catalog after a visibility mutation and requires the service to confirm the result.

Capabilities outside the generic contract remain unavailable. There is no shared Agent-creation flow or Session Todo subscription. Activity covers the active Session, not the complete workspace.

## Run lifecycle

Navigating away from a running Session detaches its cloned HTTP stream and parks its frontend queue. It does not call an arbitrary provider-native cancellation callback. Do not use this composition with a custom Agent whose `abortRun` performs wider native cancellation as a side effect.

Core AG-UI accepts input that starts or resumes a run and streams events back to
the client. It does not currently define a command that changes an already
active model turn. Assistant UI's queue Steer action only prioritizes a queued
item unless the selected AOS runtime exposes the separate provider-neutral
active-run steering capability. Generic AG-UI therefore reports active-turn
steering unavailable by default.

## Verify

```bash
bunx vitest run src/runtime-adapters/ag-ui
```

For live acceptance, create a disposable Session, send one request, navigate away and back while it streams, and confirm that ownership and resumable state still come from the workspace service.

See [Troubleshooting](../troubleshooting.md) for configuration, CORS, and ownership failures.
