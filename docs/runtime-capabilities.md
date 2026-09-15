# Runtime capabilities

AOS selects exactly one runtime per deployment. The browser always uses the normalized AOS proxy; provider URLs and credentials remain in its private configuration. Unsupported behavior stays visibly unavailable rather than being emulated by the browser.

Hermes, OpenClaw, and OpenCode are independently installed and operated
runtimes. Hermes is the primary and first-supported harness. The matrix keeps
that product order and places the newer OpenCode path last. Optional native
integrations add presentation tools where stated; they do not change the trust
boundary.

| Capability                      | Fixture      | Hermes                                   | OpenClaw                              | Generic AG-UI               | OpenCode                     |
| ------------------------------- | ------------ | ---------------------------------------- | ------------------------------------- | --------------------------- | ---------------------------- |
| Provider-backed durable history | No           | Yes                                      | Yes                                   | Workspace service           | Yes                          |
| Multiple Agents and Sessions    | Demo data    | Yes                                      | Yes                                   | Workspace service           | Yes                          |
| Create Sessions                 | Temporary    | Yes                                      | Unavailable                           | Required workspace endpoint | Yes                          |
| Agent catalog                   | Demo catalog | Native profiles                          | Native, read-only                     | Required workspace endpoint | Native, read-only            |
| Change Agent visibility         | Temporary    | Native                                   | Unavailable                           | Optional workspace mutation | Unavailable                  |
| Agent creation                  | No           | Optional integration; safe write blocked | Unavailable                           | No shared support           | Optional native integration  |
| Session Todos                   | Demo data    | Projected native tool results            | Unavailable                           | No shared support           | Unavailable                  |
| Workspace-wide Activity         | Demo events  | Active Session only                      | Unavailable                           | Active Session only         | Unavailable                  |
| Models                          | Demo choices | Native                                   | Native catalog; selection unavailable | Provider-dependent          | Native catalog and selection |
| Context usage                   | Demo data    | Native                                   | Native usage/estimate                 | Provider-dependent          | Unavailable                  |
| Questions and approvals         | Demo flows   | Native                                   | Native                                | Provider-dependent messages | Native                       |
| Attachments                     | Demo flows   | Native                                   | Supported image/file inputs           | Agent-dependent             | Native                       |
| Stop and reconnect              | Demo flows   | Native                                   | Native                                | Provider-dependent          | Native                       |
| Edit/regenerate                 | Demo flows   | Native truncate/resubmit                 | Unavailable                           | Provider-dependent          | Unavailable                  |
| Active-turn steering            | No           | Native visible redirect                  | Unavailable                           | Not standardized by AG-UI   | Unavailable                  |
| Published Artifacts             | Demo data    | Optional AOS integration                 | Unavailable                           | Shared presentation tools   | Unavailable                  |
| Rich presentation tools         | Demo data    | Optional AOS integration                 | Optional AOS integration              | Shared presentation tools   | Optional AOS integration     |
| Voice                           | No           | Native STT/TTS                           | Unavailable                           | No                          | Unavailable                  |

## Fixture

Use fixture mode to evaluate layout, localization, keyboard flow, rich output, and deterministic Activity behavior without a backend. Fixture state is not durable and deliberately excludes Agent creation.

## Hermes

Hermes owns profiles, Sessions, authentication, speech providers, tools, and persistence. AOS connects directly to the native HTTP/WebSocket API. Native active-turn steering records a visible user correction and can fall back to Hermes's provider queue. Profile visibility is native. The optional integration can provide a creator interview, but automated profile creation fails closed until Hermes provides an atomic no-overwrite create operation.

## OpenClaw

The OpenClaw adapter uses the authenticated, negotiated Gateway connection for provider-owned catalog, Session/history, run, interaction, attachment, model, and context operations. It does not expose the Gateway to browsers or infer native mutations that the pinned protocol does not prove. Session/Agent creation and mutation, Todos, Activity, edit/regenerate, steering, artifacts, and voice therefore remain unavailable. See [Run OpenClaw](runtimes/openclaw.md).

## Generic AG-UI

Generic AG-UI requires a run endpoint and a separate workspace service for Agent and Session discovery. The shared workspace contract covers listing Agents, listing/loading/creating Sessions, and optionally changing visibility. Core AG-UI does not define a same-run steering command; a future adapter must implement the optional normalized AOS steering operation before the UI exposes it. Native capabilities that are not represented by those services remain unavailable.

## OpenCode

OpenCode owns Agent definitions, Sessions, execution, provider credentials, worktree, and persistence. The proxy attaches to its authenticated server using a fixed directory and server-side Basic authentication. AOS reads the catalog and session model choices, creates Sessions, and projects durable runs, questions, permissions, attachments, Stop, and reconnect. It intentionally does not invent catalog mutation, title/delete, Todos, Activity, context accounting, artifacts, voice, edit/regenerate, or steering semantics. See [Run OpenCode](runtimes/opencode.md).

## Optional Monty integration

Monty is not an AOS runtime mode. It is an optional harness-side MCP integration configured in Hermes or OpenCode. AOS does not start it or manage its credentials. See the [Monty integration README](../integrations/monty/README.md).
