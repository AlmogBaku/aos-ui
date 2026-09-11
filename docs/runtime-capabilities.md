# Runtime capabilities

AOS selects exactly one runtime mode per deployment. Unsupported behavior remains visibly unavailable instead of being emulated by the browser.

OpenCode, Hermes, and OpenClaw are installed and run independently of AOS. The matrix describes the complete supported composition; rows backed by an AOS native integration require that optional integration to be installed in the runtime.

| Capability                      | Fixture      | OpenCode                 | Hermes                                   | OpenClaw                                      | Generic AG-UI               |
| ------------------------------- | ------------ | ------------------------ | ---------------------------------------- | --------------------------------------------- | --------------------------- |
| Provider-backed durable history | No           | Yes                      | Yes                                      | Native                                        | Workspace service           |
| Multiple Agents and Sessions    | Demo data    | Yes                      | Yes                                      | Native                                        | Workspace service           |
| Create Sessions                 | Temporary    | Yes                      | Yes                                      | Native                                        | Required workspace endpoint |
| Agent catalog                   | Demo catalog | Native                   | Native profiles                          | Native, read-only in AOS                       | Required workspace endpoint |
| Change Agent visibility         | Temporary    | Read-only                | Native                                   | No exact operation                            | Optional workspace mutation |
| Agent creation                  | No           | Optional AOS integration | Optional integration; safe write blocked | Unavailable across external-plugin authority   | No shared support           |
| Session Todos                   | Demo data    | Native                   | Projected from native tool results       | No; tasks/goals are not relabeled              | No shared support           |
| Workspace-wide Activity         | Demo events  | Yes                      | Active Session only                      | Active Session only                            | Active Session only         |
| Questions                       | Demo flows   | Native batches           | Native clarification                     | Native, non-secret questions                   | Provider-dependent messages |
| Execution approvals             | Demo flows   | Native                   | Native                                   | Native operator approvals                      | Provider-dependent messages |
| Attachments                     | Demo flows   | Native                   | Native                                   | Native policy-bounded base64                    | Agent-dependent             |
| Edit/regenerate                 | Demo flows   | Native                   | Native truncate/resubmit                 | Disabled; rewind is not equivalent             | Provider-dependent          |
| Published Artifacts             | Demo data    | Optional AOS integration | Optional AOS integration                 | Native authoritative receipts/downloads only   | Shared presentation tools   |
| Rich presentation tools         | Demo data    | Optional AOS integration | Optional AOS integration                 | Optional plugin; textual/JSON fallback          | Shared presentation tools   |
| Voice                           | No           | No                       | Native STT/TTS                           | Native TTS only; no exact STT                  | No                          |

## Fixture

Use fixture mode to evaluate layout, localization, keyboard flow, rich output, and deterministic Activity behavior without a backend. Fixture state is not durable and deliberately excludes Agent creation.

## OpenCode

OpenCode owns Agent definitions, Sessions, execution, model credentials, and persistence. AOS can optionally load a native integration plugin and creator definition. Catalog visibility is currently read-only because the native integration does not expose the required safe mutation. Agent definitions written through the optional integration may require an operator-controlled OpenCode restart before they become ready.

## Hermes

Hermes owns profiles, Sessions, authentication, speech providers, tools, and persistence. AOS connects directly to the native HTTP/WebSocket API. Profile visibility is native. The optional integration can provide a creator interview, but automated profile creation fails closed until Hermes provides an atomic no-overwrite create operation.

## OpenClaw

OpenClaw owns Agents, Sessions, Gateway authentication, execution, artifacts, and persistence. AOS uses the official Gateway protocol. The optional external plugin adds structured presentation tools and safe artifact-path validation with textual fallback. External plugins cannot register native downloadable artifacts, create Agents, or initiate cross-Agent Sessions through the required authority boundary, so AOS does not advertise those operations. Guest chat supports scoped history, send, Stop, questions, attachments, authoritative native artifact downloads, and TTS; edit/regenerate, branches, Todos, and transcription remain unavailable.

## Generic AG-UI

Generic AG-UI requires a run endpoint and a separate workspace service for Agent and Session discovery. The shared workspace contract covers listing Agents, listing/loading/creating Sessions, and optionally changing visibility. Native capabilities that are not represented by those services remain unavailable.

## Optional Monty integration

Monty is not an AOS runtime mode. It is an optional harness-side MCP integration configured in OpenCode or Hermes. AOS does not start it or manage its credentials. See the [Monty integration README](../integrations/monty/README.md).
