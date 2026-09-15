# Runtime capabilities

AOS selects exactly one runtime mode per deployment. Unsupported behavior remains visibly unavailable instead of being emulated by the browser.

OpenCode and Hermes are installed and run independently of AOS. OpenClaw is a
planned integration but unavailable on the current normalized deployment path.
The matrix describes the deployable composition; rows backed by an AOS native
integration require that optional integration to be installed in the runtime.

| Capability                      | Fixture      | OpenCode                 | Hermes                                   | OpenClaw              | Generic AG-UI               |
| ------------------------------- | ------------ | ------------------------ | ---------------------------------------- | --------------------- | --------------------------- |
| Provider-backed durable history | No           | Yes                      | Yes                                      | Unavailable (cutover) | Workspace service           |
| Multiple Agents and Sessions    | Demo data    | Yes                      | Yes                                      | Unavailable (cutover) | Workspace service           |
| Create Sessions                 | Temporary    | Yes                      | Yes                                      | Unavailable (cutover) | Required workspace endpoint |
| Agent catalog                   | Demo catalog | Native                   | Native profiles                          | Unavailable (cutover) | Required workspace endpoint |
| Change Agent visibility         | Temporary    | Read-only                | Native                                   | Unavailable (cutover) | Optional workspace mutation |
| Agent creation                  | No           | Optional AOS integration | Optional integration; safe write blocked | Unavailable (cutover) | No shared support           |
| Session Todos                   | Demo data    | Native                   | Projected from native tool results       | Unavailable (cutover) | No shared support           |
| Workspace-wide Activity         | Demo events  | Yes                      | Active Session only                      | Unavailable (cutover) | Active Session only         |
| Questions                       | Demo flows   | Native batches           | Native clarification                     | Unavailable (cutover) | Provider-dependent messages |
| Execution approvals             | Demo flows   | Native                   | Native                                   | Unavailable (cutover) | Provider-dependent messages |
| Attachments                     | Demo flows   | Native                   | Native                                   | Unavailable (cutover) | Agent-dependent             |
| Edit/regenerate                 | Demo flows   | Native                   | Native truncate/resubmit                 | Unavailable (cutover) | Provider-dependent          |
| Active-turn steering            | No           | Unavailable              | Native visible redirect                  | Unavailable (cutover) | Not standardized by AG-UI   |
| Published Artifacts             | Demo data    | Optional AOS integration | Optional AOS integration                 | Unavailable (cutover) | Shared presentation tools   |
| Rich presentation tools         | Demo data    | Optional AOS integration | Optional AOS integration                 | Unavailable (cutover) | Shared presentation tools   |
| Voice                           | No           | No                       | Native STT/TTS                           | Unavailable (cutover) | No                          |

## Fixture

Use fixture mode to evaluate layout, localization, keyboard flow, rich output, and deterministic Activity behavior without a backend. Fixture state is not durable and deliberately excludes Agent creation.

## OpenCode

OpenCode owns Agent definitions, Sessions, execution, model credentials, and persistence. AOS can optionally load a native integration plugin and creator definition. Catalog visibility is currently read-only because the native integration does not expose the required safe mutation. Agent definitions written through the optional integration may require an operator-controlled OpenCode restart before they become ready.

## Hermes

Hermes owns profiles, Sessions, authentication, speech providers, tools, and
persistence. AOS connects directly to the native HTTP/WebSocket API. Native
active-turn steering records a visible user correction and can fall back to
Hermes's provider queue. Profile visibility is native. The optional integration
can provide a creator interview, but automated profile creation fails closed
until Hermes provides an atomic no-overwrite create operation.

## OpenClaw

OpenClaw remains a code-level integration, but its normalized deployment lane is
unavailable in this cutover. The retained adapter and guest documentation do
not make `/openclaw` or a browser Gateway route deployable.

## Generic AG-UI

Generic AG-UI requires a run endpoint and a separate workspace service for
Agent and Session discovery. The shared workspace contract covers listing
Agents, listing/loading/creating Sessions, and optionally changing visibility.
Core AG-UI does not define a same-run steering command; a future adapter must
implement the optional normalized AOS steering operation before the UI exposes
it. Native capabilities that are not represented by those services remain
unavailable.

## Optional Monty integration

Monty is not an AOS runtime mode. It is an optional harness-side MCP integration configured in OpenCode or Hermes. AOS does not start it or manage its credentials. See the [Monty integration README](../integrations/monty/README.md).
