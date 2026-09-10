# Runtime capabilities

AOS selects exactly one runtime mode per deployment. Unsupported behavior remains visibly unavailable instead of being emulated by the browser.

OpenCode and Hermes are installed and run independently of AOS. The matrix describes the complete supported composition; rows backed by an AOS native integration require that optional integration to be installed in the runtime.

| Capability                      | Fixture      | OpenCode                 | Hermes                                   | Generic AG-UI               |
| ------------------------------- | ------------ | ------------------------ | ---------------------------------------- | --------------------------- |
| Provider-backed durable history | No           | Yes                      | Yes                                      | Workspace service           |
| Multiple Agents and Sessions    | Demo data    | Yes                      | Yes                                      | Workspace service           |
| Create Sessions                 | Temporary    | Yes                      | Yes                                      | Required workspace endpoint |
| Agent catalog                   | Demo catalog | Native                   | Native profiles                          | Required workspace endpoint |
| Change Agent visibility         | Temporary    | Read-only                | Native                                   | Optional workspace mutation |
| Agent creation                  | No           | Optional AOS integration | Optional integration; safe write blocked | No shared support           |
| Session Todos                   | Demo data    | Native                   | Projected from native tool results       | No shared support           |
| Workspace-wide Activity         | Demo events  | Yes                      | Active Session only                      | Active Session only         |
| Questions                       | Demo flows   | Native batches           | Native clarification                     | Provider-dependent messages |
| Execution approvals             | Demo flows   | Native                   | Native                                   | Provider-dependent messages |
| Attachments                     | Demo flows   | Native                   | Native                                   | Agent-dependent             |
| Published Artifacts             | Demo data    | Optional AOS integration | Optional AOS integration                 | Shared presentation tools   |
| Voice                           | No           | No                       | Native STT/TTS                           | No                          |

## Fixture

Use fixture mode to evaluate layout, localization, keyboard flow, rich output, and deterministic Activity behavior without a backend. Fixture state is not durable and deliberately excludes Agent creation.

## OpenCode

OpenCode owns Agent definitions, Sessions, execution, model credentials, and persistence. AOS can optionally load a native integration plugin and creator definition. Catalog visibility is currently read-only because the native integration does not expose the required safe mutation. Agent definitions written through the optional integration may require an operator-controlled OpenCode restart before they become ready.

## Hermes

Hermes owns profiles, Sessions, authentication, speech providers, tools, and persistence. AOS connects directly to the native HTTP/WebSocket API. Profile visibility is native. The optional integration can provide a creator interview, but automated profile creation fails closed until Hermes provides an atomic no-overwrite create operation.

## Generic AG-UI

Generic AG-UI requires a run endpoint and a separate workspace service for Agent and Session discovery. The shared workspace contract covers listing Agents, listing/loading/creating Sessions, and optionally changing visibility. Native capabilities that are not represented by those services remain unavailable.

## Optional Monty integration

Monty is not an AOS runtime mode. It is an optional harness-side MCP integration configured in OpenCode or Hermes. AOS does not start it or manage its credentials. See the [Monty integration README](../integrations/monty/README.md).
