# Connect a generic AG-UI runtime

Generic AG-UI mode connects an AG-UI run endpoint to a separate workspace service. Use it when your backend can supply provider-neutral Agent ownership and durable Session history without an OpenCode or Hermes adapter.

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

## Start AOS

```bash
AOS_UI_RUNTIME_MODE=ag-ui \
AOS_UI_AG_UI_URL=http://127.0.0.1:8000/agent \
AOS_UI_AG_UI_WORKSPACE_URL=http://127.0.0.1:8001 \
  bun run dev
```

Open <http://localhost:3000>.

For static deployment, create a public configuration based on:

```json
{
  "mode": "ag-ui",
  "runUrl": "https://runtime.example.com/agent",
  "workspaceUrl": "https://workspace.example.com",
  "composerModelSelectorEnabled": true,
  "composerContextEnabled": true
}
```

Both services must allow the browser origin or be placed behind an operator-managed same-origin proxy.

## Optional workspace behavior

The workspace transport may subscribe to catalog/Session changes and may expose Agent visibility updates. Each catalog entry controls whether it is selectable and editable. AOS re-reads the catalog after a visibility mutation and requires the service to confirm the result.

Capabilities outside the generic contract remain unavailable. There is no shared Agent-creation flow or Session Todo subscription. Activity covers the active Session, not the complete workspace.

## Run lifecycle

Navigating away from a running Session detaches its cloned HTTP stream and parks its frontend queue. It does not call an arbitrary provider-native cancellation callback. Do not use this composition with a custom Agent whose `abortRun` performs wider native cancellation as a side effect.

## Verify

```bash
bunx vitest run src/runtime-adapters/ag-ui
```

For live acceptance, create a disposable Session, send one request, navigate away and back while it streams, and confirm that ownership and resumable state still come from the workspace service.

See [Troubleshooting](../troubleshooting.md) for configuration, CORS, and ownership failures.
