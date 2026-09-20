# AOS Runtime Proxy Phases 2 and 3

> Status (2026-09-20): complete; OpenClaw and OpenCode adapters shipped.

## Goal

Add complete server-side OpenCode and OpenClaw adapters to the working
Hermes-first TypeScript proxy. The browser continues to use only the normalized
AOS REST/WebSocket protocol and AG-UI run endpoint.

```text
React + assistant-ui
-> AOS REST/WebSocket + AG-UI
-> TypeScript proxy
-> ServerRuntime
-> official provider client
-> native runtime
```

Phase 2 delivers OpenCode operator and invitation-scoped guest journeys. Phase
3 delivers the same normalized journey for OpenClaw. Provider implementation
runs concurrently; the main agent integrates shared files serially, OpenCode
first and then the already-developed OpenClaw adapter.

## Frozen surfaces and constraints

- **Mandatory AOS skill preflight:** before changing adapter or shared
  integration code, the main integration agent, every provider lead, every
  provider leaf, and every provider reviewer must load the complete
  worktree-local `.agents/skills/aos-runtime-adapter/SKILL.md`. Loading an
  assistant-ui `runtime`, `streaming`, or other frontend skill does not satisfy
  this gate. Inherited conversation context and another agent's summary also
  do not count: each working agent loads the file itself.
- Each of those agents must then read `AGENTS.md`,
  `docs/development/runtime-adapter-authoring.md`, both normative gateway
  design documents, the selected runtime guide, and the selected runtime
  research. Before implementation fan-out, the provider lead records the
  skill-required native capability/lifecycle matrix and freezes the tested
  client facade. Each handoff reports native evidence, changed mappings,
  verification, and capabilities intentionally left unavailable.
- **Deployment skill boundary:** `.agents/skills/aos-deploy/SKILL.md` is the
  authority only when the operator separately asks to install, expose, change,
  or verify production services. Compose templates and deployment tests in
  this plan remain ordinary repository implementation and do not authorize a
  live mutation. Before any separately authorized live deployment, the acting
  agent must load that skill completely and follow its inspect/confirm/verify
  gates.
- Continue from this clean worktree's current `HEAD`; leave dirty `main`
  untouched.
- Preserve the completed Hermes adapter, `ServerRuntime`,
  `SessionCoordinator`, normalized routes, guest authorization/projection, and
  provider-neutral browser AOS client.
- Extend `ServerRuntime` only when a failing native conformance test proves the
  current contract cannot express required behavior.
- Use full capability values with limits, choices, scopes, and unavailability
  reasons.
- Operator and guest listeners share one selected `RuntimeInstance`. Guest
  authorization happens before native dispatch and projection before guest
  queue insertion.
- Do not add a second SPI, base adapter class, provider registry, canonical
  projection model, ACP bridge, database, generic replay system, browser
  provider path, or generic AG-UI provider adapter.
- Direct browser provider adapters and the Go gateway are already removed; do
  not schedule that work again.
- Do not touch `.agents/ADRs/` or use Agent Browser.
- Never claim live acceptance without an approved disposable target and
  credentials.

Research and implementation references:

- `docs/development/runtime-adapter-authoring.md`
- `docs/research/opencode-openclaw-server-clients.md`
- `docs/research/opencode-openclaw-runtime-transport-seams.md`
- donor branches `codex/aos-proxy-opencode` and
  `codex/aos-proxy-openclaw`, for reviewed fixtures and behavior only

## Dependencies and private configuration

Pin and use the official clients directly:

- `@opencode-ai/sdk@1.18.29`
- `@openclaw/gateway-client@2026.9.4`
- `@openclaw/gateway-protocol@2026.9.4`
- the repository's existing AG-UI packages for normalized run events

The private runtime configuration becomes a strict union:

```ts
type RuntimeConfig =
  | HermesRuntimeConfig
  | {
      kind: "opencode"
      id: string
      baseUrl: string
      directory: string
      username: string
      passwordFile: string
    }
  | {
      kind: "openclaw"
      id: string
      baseUrl: string
      deviceIdentityFile: string
      deviceTokenFile: string
    }
```

OpenCode credentials and directory are fixed server-side. The optional native
launcher passes matching Basic credentials only in its child environment.
OpenClaw device identity and token files are pre-provisioned absolute, bounded,
owner-only, non-symlink regular files. The proxy does not pair, bootstrap,
write, rotate, or fall back to another credential. Missing or rejected
credentials fail closed as normalized authentication-required or unavailable.

## Implementation dependency map

```text
D0 main: exact dependencies + Bun probes [complete]
  |-- OC0 OpenCode SDK facade
  |     |-- OC1 workspace/history
  |     |-- OC2 runs/events/Stop/reconnect
  |     `-- OC3 interactions/content/capabilities
  |            `-- OC4 provider-lead assembly
  |
  `-- CL0 OpenClaw client/protocol/device facade
        |-- CL1 workspace/history
        |-- CL2 runs/subscriptions/Stop/reconnect
        `-- CL3 interactions/content/capabilities
               `-- CL4 provider-lead assembly

OC4 -> I1 main shared OpenCode integration -> Phase 2 gate
CL4 + idle shared writer -> I2 main OpenClaw integration -> Phase 3 gate
Phase 3 gate -> final stable-tree verification and result review
```

| Surface | Exclusive owner | Files/outcome |
| --- | --- | --- |
| Shared integration | main agent | package/lock, protocol/core, config, central factory, routes, auth, guest projection, browser, deployment, docs |
| OpenCode foundation/assembly | OpenCode lead | `client.ts`, then `adapter.ts`, `factory.ts`, integration tests |
| OpenCode data | data leaf | `native-schemas.ts`, `workspace.ts`, `history.ts` and tests |
| OpenCode runs | run leaf | `run.ts`, `events.ts` and tests |
| OpenCode content | content leaf | `interactions.ts`, `content.ts`, `capabilities.ts` and tests |
| OpenClaw foundation/assembly | OpenClaw lead | `client.ts`, credential helper, then `adapter.ts`, `factory.ts`, integration tests |
| OpenClaw data | data leaf | `native-schemas.ts`, `workspace.ts`, `history.ts` and tests |
| OpenClaw runs | run leaf | `run.ts`, `subscriptions.ts` and tests |
| OpenClaw content | content leaf | `interactions.ts`, `content.ts`, `capabilities.ts` and tests |

Each leaf starts from its provider's tested foundation checkpoint in an
isolated worktree and returns one tested commit. The provider lead integrates
the leaves and exclusively edits `adapter.ts` and `factory.ts`. A leaf reports
a missing shared operation to the main agent rather than editing shared files.
Every dispatch brief repeats the worktree-local `aos-runtime-adapter` skill
path, required reading, and evidence contract. Inheriting a parent agent's
context or loading an assistant-ui skill does not count as loading the AOS
skill.

Before accepting a provider commit, its handoff must explicitly confirm that
the author loaded the AOS adapter skill and must identify the native evidence,
normalized mappings, verification performed, and intentionally unavailable
capabilities required by that skill. A commit without this evidence returns to
its owner for review; it is not integrated on trust.

## Phase 2: OpenCode

### OC0: official SDK facade

- Bind every SDK call to the fixed base URL and absolute directory.
- Inject Basic authentication server-side.
- Validate consumed native responses and events.
- Expose only operations used by AOS workspace, history, run, interaction, and
  content behavior.
- Normalize cancellation, timeout, outage, authentication, and uncertain
  acknowledgement without exposing SDK request objects or native bodies.
- Own SSE abort and idempotent cleanup.

### OC1: workspace and history

- Map the Agent catalog, excluding the hidden creator from normal roster
  surfaces, with stable identities and deterministic order.
- Implement bounded Session pages and on-demand chronological history.
- Verify Agent and Session ownership before mutation or subscription.
- Map messages, tools, reasoning, images, Todos, models, context, and activity.
- Keep visibility read-only unless the pinned API proves equivalent mutation.
- Resolve invitations by exact Agent and reserved title `aos-invite:<ref>`:
  authoritative lookup; create only when absent; reread and verify; fail on
  ambiguity or wrong ownership.

### OC2: runs and recovery

- Admit exactly one authorized user turn or one bound interrupt response.
- Use stable native admission identity and map valid AG-UI text, reasoning,
  tools, progress, usage, lifecycle, and terminal events.
- Bind every observed event to the exact Agent and Session.
- Stop through native interrupt and remain `stopping` until terminal or
  authoritative idle.
- Return `uncertain` when dispatch may have occurred; never retry automatically.
- Replay from durable provider position when safe, otherwise reconcile from
  authoritative history without resending.

### OC3: interactions and content

- Map questions and permissions to standard AG-UI interrupts and validate
  complete answers and allowed decisions.
- Implement bounded attachment staging and supported artifact receipts.
- Preserve safe rich-tool payloads from the native integration.
- Add commands, Edit/Retry, steering, reactions, and audio only when the pinned
  API provides matching semantics; otherwise expose a structured reason.

### OC4/I1: assembly and acceptance

- Assemble one OpenCode `ServerRuntime` and runtime factory.
- Add its private configuration and central factory cases.
- Migrate the remaining OpenCode Compose and public runtime configuration to
  proxy-only access with no browser-native port or CORS path.
- Update maintained OpenCode, deployment, invitation, capability,
  troubleshooting, and environment documentation.
- Pass controlled operator and one-link/one-Session guest journeys.

## Phase 3: OpenClaw

### CL0: official Gateway foundation

- Wrap the official `GatewayClient` and protocol validators with fixed URL,
  device identity, token, role, scopes, and capabilities.
- Validate protocol-v4 frames and used operation results.
- Preserve official request multiplexing, timeouts, cancellation, reconnect,
  gap reporting, readiness, and idempotent shutdown.
- Perform no browser pairing or credential mutation.

### CL1: workspace and history

- Map Agent catalog, canonical Session keys, ownership, bounded catalog and
  history, messages, tools, reasoning, models, context, and activity.
- Keep OpenClaw tasks/goals distinct from AOS Todos.
- Resolve invitations with a deterministic canonical `sessionKey` derived
  from exact Agent plus invitation reference, then verify identity and
  ownership authoritatively.
- Subscribe before authoritative reads and repeat a read invalidated while in
  flight.

### CL2: runs and recovery

- Admit one authorized native-idempotent turn bound to exact Agent and Session.
- Lease official Session subscriptions independently of durable execution.
- Map valid AG-UI events and discard unsolicited foreign Session/run events.
- Stop the exact run and retain `stopping` until terminal or idle.
- Return `uncertain` without retry after lost acknowledgement.
- Recover socket generations and gaps by resubscribing and reconciling native
  history, in-flight run, and active-run state.
- Report reduced tool detail when the native capability was not negotiated.

### CL3: interactions and content

- Map questions and approvals with scoped IDs, decisions, and expiry.
- Enforce native attachment limits against the complete encoded request.
- Authorize artifacts only from receipts tied to exact Agent, Session, and
  message.
- Keep the optional OpenClaw plugin presentation-only.
- Enable audio only for a proven complete native operation and report other
  unsupported operations through structured capability reasons.

### CL4/I2: assembly and acceptance

- Assemble one OpenClaw `ServerRuntime` and runtime factory.
- Add its private configuration and central factory cases.
- Replace remaining OpenClaw browser/native deployment routing with normalized
  proxy-only routing.
- Update maintained OpenClaw, deployment, invitation, capability,
  troubleshooting, and environment documentation.
- Pass controlled operator and exact-Session guest journeys, including auth
  failure, Stop, reload, gap recovery, and reconnect.

## Verification

Every new behavior follows red-green TDD. Provider checkpoints run:

```bash
bunx vitest run packages/proxy/adapters/opencode
bunx vitest run packages/proxy/adapters/openclaw
```

Each checkpoint covers native validation and sanitized failures; authentication
and outages; identity, ownership, and deterministic order; pre-dispatch guest
isolation; AG-UI ordering; duplicate/uncertain sends; Stop settlement; gaps and
authoritative recovery; malformed/oversized input; browser/native-payload
exclusion; and idempotent shutdown.

After all writers stop, run once on a stable tree:

```bash
bun run test
bun run typecheck
bun run lint
bun run build
bun run test:e2e
bun run integrations:build
bun run hermes:test
bunx vitest run test/containers/compose.test.ts
docker compose -f compose.yaml config --quiet
AOS_UI_OPENCODE_WORKTREE=/absolute/external/worktree \
  docker compose -f compose.yaml -f compose.opencode.yaml config --quiet
docker compose -f compose.yaml -f compose.hermes.yaml config --quiet
docker compose -f compose.yaml -f compose.openclaw.yaml config --quiet
```

Build affected images and smoke static delivery, proxy health/readiness,
normalized reads, AG-UI streaming, Stop, reconnect, and guest isolation.
