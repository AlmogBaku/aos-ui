# Runtime capabilities

AOS selects exactly one runtime per deployment. The browser always uses the normalized AOS proxy; provider URLs and credentials remain in its private configuration. Unsupported behavior stays visibly unavailable rather than being emulated by the browser.

Hermes, OpenClaw, and OpenCode are independently installed and operated
runtimes. Hermes is the primary and first-supported harness. The matrix keeps
that product order and places the newer OpenCode path last. Optional native
integrations add presentation tools where stated; they do not change the trust
boundary.

| Capability                      | Fixture      | Hermes                                   | OpenClaw                              | OpenCode                                      |
| ------------------------------- | ------------ | ---------------------------------------- | ------------------------------------- | --------------------------------------------- |
| Provider-backed durable history | No           | Yes                                      | Yes                                   | Yes                                           |
| Multiple Agents and Sessions    | Demo data    | Yes                                      | Yes                                   | Yes                                           |
| Create Sessions                 | Temporary    | Yes                                      | Yes                                   | Yes                                           |
| Rename/archive/delete Sessions  | Temporary    | Yes                                      | Unavailable                           | Unavailable                                   |
| Agent catalog                   | Demo catalog | Native profiles                          | Native, read-only                     | Native, read-only                             |
| Change Agent visibility         | Temporary    | Native                                   | Unavailable                           | Unavailable                                   |
| Agent creation                  | No           | Optional integration; safe write blocked | Unavailable                           | Denied by the launcher (`scripts/opencode-config.ts`) |
| Session Todos                   | Demo data    | Projected native tool results            | Unavailable                           | Unavailable                                   |
| Workspace-wide Activity         | Demo events  | Workspace-wide from proxy feed           | Unavailable                           | Unavailable                                   |
| Session read state              | Demo data    | Native (`unread` catalog row; PATCH `{unread:false}`) | Unavailable              | Unavailable                                   |
| Models                          | Demo choices | Native                                   | Native catalog; selection unavailable | Native catalog and selection                  |
| Reasoning-effort selection      | No           | Native                                   | Unavailable                           | Unavailable                                   |
| Context usage                   | Demo data    | Native                                   | Native usage/estimate                 | Unavailable                                   |
| Slash-command suggestions       | No           | Native catalog when the profile has one  | Unavailable                           | Unavailable                                   |
| Questions and approvals         | Demo flows   | Native                                   | Native                                | Native                                        |
| Attachments                     | Demo flows   | Native                                   | Supported image/file inputs           | Native                                        |
| Stop and reconnect              | Demo flows   | Native                                   | Native                                | Native                                        |
| Edit/regenerate                 | Demo flows   | Native truncate/resubmit                 | Unavailable                           | Unavailable                                   |
| Active-turn steering            | No           | Native visible redirect                  | Unavailable                           | Unavailable                                   |
| Published Artifacts             | Demo data    | Optional AOS integration                 | Unavailable                           | Unavailable                                   |
| Rich presentation tools         | Demo data    | Optional AOS integration                 | Optional AOS integration              | Optional AOS integration                      |
| Voice                           | No           | Native STT/TTS                           | Unavailable                           | Unavailable                                   |

## Fixture

Use fixture mode to evaluate layout, localization, keyboard flow, rich output, and deterministic Activity behavior without a backend. Fixture state is not durable and deliberately excludes Agent creation.

## Hermes

Hermes owns profiles, Sessions, authentication, speech providers, tools, and persistence. AOS connects directly to the native HTTP/WebSocket API over the server adapter; the browser sees ACP v2. Native active-turn steering records a visible user correction and can fall back to Hermes's provider queue. Profile visibility is native. The optional integration can provide a creator interview and creates the profile itself, hidden until its package and toolsets verify; an incomplete setup is reported for an operator to finish.

## OpenClaw

The OpenClaw adapter uses the authenticated, negotiated Gateway connection for provider-owned catalog, Session/history, run, interaction, attachment, model, and context operations. It does not expose the Gateway to browsers or infer native mutations that the pinned protocol does not prove. Session creation is available; rename, archive, delete, Todos, Activity, edit/regenerate, steering, artifacts, read state, and voice remain unavailable. See [Run OpenClaw](runtimes/openclaw.md).

## OpenCode

OpenCode owns Agent definitions, Sessions, execution, provider credentials, worktree, and persistence. The proxy attaches to its authenticated server using a fixed directory and server-side Basic authentication. AOS reads the catalog and session model choices, creates Sessions, and projects durable runs, questions, permissions, attachments, Stop, and reconnect. It intentionally does not invent catalog mutation, title/delete, Todos, Activity, context accounting, artifacts, voice, edit/regenerate, or steering semantics. See [Run OpenCode](runtimes/opencode.md).

## Optional Monty integration

Monty is not an AOS runtime mode. It is an optional harness-side MCP integration configured in Hermes or OpenCode. AOS does not start it or manage its credentials. See the [Monty integration README](../integrations/monty/README.md).
