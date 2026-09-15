# Runtime capabilities

AOS selects exactly one runtime per deployment. The browser always uses the normalized AOS proxy; provider URLs and credentials remain in its private configuration. Unsupported behavior stays visibly unavailable rather than being emulated by the browser.

OpenCode, Hermes, and OpenClaw are independently installed and operated runtimes. The matrix describes the current normalized proxy adapters. Optional native integrations add presentation tools where stated; they do not change the trust boundary.

| Capability                      | Fixture      | OpenCode                     | Hermes                                   | OpenClaw                              | Generic AG-UI               |
| ------------------------------- | ------------ | ---------------------------- | ---------------------------------------- | ------------------------------------- | --------------------------- |
| Provider-backed durable history | No           | Yes                          | Yes                                      | Yes                                   | Workspace service           |
| Multiple Agents and Sessions    | Demo data    | Yes                          | Yes                                      | Yes                                   | Workspace service           |
| Create Sessions                 | Temporary    | Yes                          | Yes                                      | Unavailable                           | Required workspace endpoint |
| Agent catalog                   | Demo catalog | Native, read-only            | Native profiles                          | Native, read-only                     | Required workspace endpoint |
| Change Agent visibility         | Temporary    | Unavailable                  | Native                                   | Unavailable                           | Optional workspace mutation |
| Agent creation                  | No           | Optional native integration  | Optional integration; safe write blocked | Unavailable                           | No shared support           |
| Session Todos                   | Demo data    | Unavailable                  | Projected native tool results            | Unavailable                           | No shared support           |
| Workspace-wide Activity         | Demo events  | Unavailable                  | Active Session only                      | Unavailable                           | Active Session only         |
| Models                          | Demo choices | Native catalog and selection | Native                                   | Native catalog; selection unavailable | Provider-dependent          |
| Context usage                   | Demo data    | Unavailable                  | Native                                   | Native usage/estimate                 | Provider-dependent          |
| Questions and approvals         | Demo flows   | Native                       | Native                                   | Native                                | Provider-dependent messages |
| Attachments                     | Demo flows   | Native                       | Native                                   | Supported image/file inputs           | Agent-dependent             |
| Stop and reconnect              | Demo flows   | Native                       | Native                                   | Native                                | Provider-dependent          |
| Edit/regenerate                 | Demo flows   | Unavailable                  | Native truncate/resubmit                 | Unavailable                           | Provider-dependent          |
| Active-turn steering            | No           | Unavailable                  | Native visible redirect                  | Unavailable                           | Not standardized by AG-UI   |
| Published Artifacts             | Demo data    | Unavailable                  | Optional AOS integration                 | Unavailable                           | Shared presentation tools   |
| Rich presentation tools         | Demo data    | Optional AOS integration     | Optional AOS integration                 | Optional AOS integration              | Shared presentation tools   |
| Voice                           | No           | Unavailable                  | Native STT/TTS                           | Unavailable                           | No                          |

## Fixture

Use fixture mode to evaluate layout, localization, keyboard flow, rich output, and deterministic Activity behavior without a backend. Fixture state is not durable and deliberately excludes Agent creation.

## OpenCode

OpenCode owns Agent definitions, Sessions, execution, provider credentials, worktree, and persistence. The proxy attaches to its authenticated server using a fixed directory and server-side Basic authentication. AOS reads the catalog and session model choices, creates Sessions, and projects durable runs, questions, permissions, attachments, Stop, and reconnect. It intentionally does not invent catalog mutation, title/delete, Todos, Activity, context accounting, artifacts, voice, edit/regenerate, or steering semantics. See [Run OpenCode](runtimes/opencode.md).

## Hermes

Hermes owns profiles, Sessions, authentication, speech providers, tools, and persistence. AOS connects directly to the native HTTP/WebSocket API. Native active-turn steering records a visible user correction and can fall back to Hermes's provider queue. Profile visibility is native. The optional integration can provide a creator interview, but automated profile creation fails closed until Hermes provides an atomic no-overwrite create operation.

## OpenClaw

The OpenClaw adapter uses the authenticated, negotiated Gateway connection for provider-owned catalog, Session/history, run, interaction, attachment, model, and context operations. It does not expose the Gateway to browsers or infer native mutations that the pinned protocol does not prove. Session/Agent creation and mutation, Todos, Activity, edit/regenerate, steering, artifacts, and voice therefore remain unavailable. See [Run OpenClaw](runtimes/openclaw.md).

## Generic AG-UI

Generic AG-UI requires a run endpoint and a separate workspace service for Agent and Session discovery. The shared workspace contract covers listing Agents, listing/loading/creating Sessions, and optionally changing visibility. Core AG-UI does not define a same-run steering command; a future adapter must implement the optional normalized AOS steering operation before the UI exposes it. Native capabilities that are not represented by those services remain unavailable.

## Optional Monty integration

Monty is not an AOS runtime mode. It is an optional harness-side MCP integration configured in OpenCode or Hermes. AOS does not start it or manage its credentials. See the [Monty integration README](../integrations/monty/README.md).
