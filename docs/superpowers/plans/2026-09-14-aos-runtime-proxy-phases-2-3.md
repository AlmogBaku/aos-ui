# AOS Runtime Proxy Phases 2 and 3 Implementation Plan

> Status: planned; implementation has not started.

## Objective

Add complete server-side OpenCode and OpenClaw paths to the Hermes-first AOS
runtime proxy while preserving the existing normalized browser and protocol.

```text
React + assistant-ui
-> AOS REST/WebSocket + AG-UI
-> TypeScript proxy
-> ServerRuntime
-> official OpenCode or OpenClaw client
-> native runtime
```

Phase 2 delivers OpenCode. Phase 3 delivers OpenClaw. Each phase includes the
operator and invitation-scoped guest journeys supported by that runtime.

Research and upstream references are recorded in
[`docs/research/opencode-openclaw-server-clients.md`](../../research/opencode-openclaw-server-clients.md).

## Constraints and reasons

- One runtime is selected per deployment. A discriminated configuration switch
  is sufficient; a dynamic registry or plugin framework would add unused
  machinery.
- The existing `ServerRuntime` is the only normalized provider boundary. The
  transport must not acquire a second runtime SPI or canonical domain model.
- Browser code remains provider-neutral. Provider packages, schemas, URLs,
  credentials, device keys, tokens, and native payloads stay server-side.
- Use the official clients rather than implementing HTTP, SSE, WebSocket,
  reconnect, RPC multiplexing, device signing, or frame validation again.
- Keep AG-UI for active runs and AOS REST/WebSocket for workspace operations.
  The current public AG-UI packages already satisfy this boundary.
- Generalize only the Hermes names and types that prevent a second concrete
  runtime from plugging into the current proxy. Do not rewrite working auth,
  routes, browser composition, cursors, or guest projection.
- Preserve native stable identities where their scope is safe. Public Session
  ownership is enforced by the adapter and proxy, not by decorative ID changes.
- Runtime-specific capabilities remain full operation values with limits,
  choices, scopes, and reasons.
- No Agent Browser verification; it is explicitly excluded because the tool is
  currently broken.
- No live native acceptance without an approved disposable target and
  credentials.
- Do not touch `.agents/ADRs/`. No ADR accompanies this plan because that path
  is explicitly out of scope.

## Decisions

### Shared composition

Replace Hermes-specific composition names with a small known-runtime switch:

```text
runtime.kind = hermes | opencode | openclaw
```

Each runtime folder owns its config fragment, official-client construction,
auth/credential lifecycle, concrete `ServerRuntime`, and cleanup. Top-level
composition owns the selected runtime, operator/guest listener construction,
OIDC, invitation verification, reconnect cursors, and graceful shutdown.

There is no runtime registry. A deployment has one selected runtime and, when
enabled, one separately constructed guest-lane instance of that same runtime.

### OpenCode

Make `@opencode-ai/sdk@1.18.29` a direct exact dependency, matching the current
`@opencode-ai/plugin` pin. `runtimes/opencode/client.ts` is a narrow facade over
the official SDK:

- use v2 Session messages/history/events for bounded reads, durable source
  positions, replay, run streaming, and reconciliation;
- use v2 prompt identity, wait, and interrupt for admission and Stop;
- use v2 Agent/model/question/permission APIs;
- use the established API only where the pinned v2 surface lacks a required
  lifecycle operation, behind the same facade;
- inject fixed server URL, fixed worktree/directory, and HTTP Basic
  credentials loaded from a secret file.

Authentication is mandatory for every deployable OpenCode composition. The
only exception is a synthetic-test-only loopback fixture that cannot be enabled
by production configuration. The normalized Compose overlay removes OpenCode's
published host port and browser CORS configuration; only the proxy can reach the
native service on its internal network.

OpenCode Basic auth is server-wide and cannot express invitation scope. An
enabled guest lane therefore constructs a separate SDK client, event stream,
abort lifecycle, and listener lane, but it may target the same authenticated
OpenCode workspace so a guest can enter the invited Session. The AOS invitation
authorization check is the authority boundary: every guest operation resolves
the exact granted Agent/Session before the guest client dispatches it. Reusing
the operator client object or its event listeners is forbidden; sharing the
upstream endpoint/credential is allowed because the credential never reaches
the guest and grants the proxy no authority it does not already hold. Tests must
cover foreign Agent, Session, run, interaction, attachment, artifact, and
reconnect identities before native dispatch.

Map native durable Session events directly to AG-UI. The durable aggregate
sequence is the provider recovery position. On an event gap, epoch mismatch,
or failed replay, reread authoritative native history and continue from its
validated position. Do not build an in-memory projection database.

OpenCode Agent visibility is read-only. Unsupported reactions, audio, or other
operations remain unavailable with precise capability reasons. The optional
native AOS integration remains responsible only for the creator workflow,
presentation tools, handoff, and safe artifact publication.

### OpenClaw

Add exact direct dependencies
`@openclaw/gateway-client@2026.9.4` and
`@openclaw/gateway-protocol@2026.9.4`, matching the current OpenClaw integration.

The official `GatewayClient` owns the native socket, request multiplexing,
handshake timeouts, reconnect policy, and event-gap notification. The protocol
package validates every native frame and operation payload used by AOS.
Host callbacks own a persistent Ed25519 device identity and scoped device token
in private server files. Operator and guest lanes use separate client instances,
device identities, tokens, and requested scopes.

Each lane's optional first-connect bootstrap token/password comes from its own
private secret file, never JSON, environment values, logs, URLs, or browser
state. Once that lane persists a scoped device token, subsequent connections use
only that token. Rejection or expiry fails closed and requires explicit operator
repair; it never falls back to an operator token or stale bootstrap authority.

Use normal paired client identity; do not use OpenClaw's special local backend
exception. Pairing-required and missing-scope states fail readiness with a safe
operator-facing reason and never expose native tokens or full error payloads.

Map authoritative Agent/Session/history RPCs and scoped Session events directly
to `ServerRuntime` and AG-UI. Use the official Session subscription coordinator
for subscribe/unsubscribe/reconnect. Use official projection helpers only if a
specific history/live race requires them and a focused test demonstrates the
need.

The optional OpenClaw plugin remains presentation-only. It is not the runtime
connection and does not provide Agent creation, Session handoff, or publication
authority.

## Non-goals

- Changing the AOS browser protocol or adding provider selection to the UI.
- Adding a generic AG-UI provider adapter.
- Reviving direct browser OpenCode/OpenClaw runtimes, ACP, or the Go gateway.
- Copying generated SDKs or gateway clients into this repository.
- A workspace database, materialized cache, generalized event sourcing, or a
  proxy replay store beyond the current bounded reconnect behavior.
- Emulating unsupported native operations with different semantics.
- Upgrading OpenCode or OpenClaw independently of their repository integrations.

## Failure journey

1. Invalid runtime configuration or unreadable secret/device files prevents the
   affected listener from starting; validation output and logs remain redacted.
2. A missing or invalid AOS operator cookie returns the existing operator-auth
   state before any native request.
3. Native authentication, pairing, missing scope, timeout, or outage becomes the
   existing normalized auth/unavailable state. The browser receives no native
   body, URL, header, token, path, or payload.
4. Every Agent/Session operation resolves and rechecks native ownership before
   mutation. Cross-Agent, cross-Session, or out-of-invitation requests fail
   before dispatch.
5. A side-effecting request acknowledged by the native runtime returns its
   normalized result. If dispatch may have occurred but the acknowledgement is
   lost, AOS returns `uncertain` and never resends automatically.
6. A run stream gap or disconnect stops incremental delivery. Reconnect first
   attempts native replay from the provider position, then falls back to an
   authoritative Session read. It never resubmits the user turn.
7. Stop remains `stopping` until a native terminal event or authoritative idle
   result settles it.
8. Guest output passes through the existing invitation scope and guest
   projection on REST, AG-UI, WebSocket, artifacts, errors, and reconnect.

### Journey and red-capable checks

```text
Browser
  -> AOS operator cookie / guest invitation
      -> normalized REST or AG-UI request
          -> proxy scope + ownership check
              -> selected ServerRuntime
                  -> official native client
                      -> OpenCode HTTP/SSE or OpenClaw Gateway WS

Invalid AOS identity --------> 401; zero native calls
Foreign Agent/Session -------> 404/forbidden; zero native calls
Native auth/pairing failure -> normalized unavailable; redacted detail
Lost mutation response ------> uncertain; no automatic retry
Event gap/disconnect --------> native replay or authoritative reread
Expired guest invitation ----> stream closed; reconnect and Stop denied
```

| Failure                            | Synthetic fixture                                            | Red-capable check                                           | Expected observation                                        |
| ---------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------- |
| Invalid proxy/runtime config       | malformed config and unreadable temp secret                  | config/composition unit test                                | listener is not created; generic startup error              |
| Missing operator or guest identity | unsigned/expired cookie or invitation JWT                    | route and WebSocket authorization tests                     | `401`; official client spy has zero calls                   |
| Cross-scope identity               | two Agents, two Sessions, two operators, and one guest grant | REST, run, Stop, interaction, artifact, and reconnect tests | normalized denial before native dispatch                    |
| OpenCode native exposure           | Compose render with synthetic secrets                        | container routing test                                      | no published `4096`, browser CORS origin, or native route   |
| OpenCode invalid Basic auth        | controlled SDK HTTP server returning `401`                   | client/composition readiness test                           | normalized unavailable; no native body/header disclosed     |
| OpenClaw pairing/missing scope     | controlled protocol-v4 gateway frames                        | device/composition test                                     | readiness unavailable with safe reason; no token disclosed  |
| OpenClaw stale device token        | stored rejected token plus valid bootstrap fixture           | credential-precedence test                                  | fail closed; bootstrap is not retried                       |
| Lost side-effect acknowledgement   | server admits identity then drops response                   | run/session mutation test                                   | `uncertain`; one native request; later history reconciles   |
| Native event gap                   | skipped durable sequence or gateway gap callback             | run/reconnect test                                          | incremental stream stops; authoritative read replaces state |
| Stop race                          | terminal/idle event held after accepted Stop                 | run test                                                    | `stopping` until terminal/idle, then settled once           |
| Guest expiry while streaming       | fake clock crossing JWT expiry                               | guest AG-UI/WebSocket test                                  | connection closes; later read/reconnect/Stop denied         |
| Oversized/malformed provider data  | bounded HTTP/SSE/WS fixtures                                 | client and adapter validation tests                         | normalized failure; raw payload absent from response/log    |

## Implementation dependency map

```text
P2.1 shared runtime-neutral composition cleanup
  -> P2.2 OpenCode official-client facade
      -> P2.3 Agent/Session/history reads
      -> P2.4 runs/events/Stop/reconnect
      -> P2.5 interactions/content/capabilities
          -> P2.6 operator + guest integration and Phase 2 gate

P2.2 contract freeze
  -> P3.1 OpenClaw package/Bun/client lifecycle
      -> P3.2 device auth and lane composition
          -> P3.3 Agent/Session/history reads
          -> P3.4 runs/events/Stop/reconnect
          -> P3.5 interactions/content/capabilities
              -> P3.6 operator + guest integration and Phase 3 gate
```

Phase 3 client/auth work may begin after P2.2 freezes the shared composition
contract, but Phase 3 integration does not edit shared composition until the
Phase 2 gate is green.

## File and package structure

```text
packages/proxy/
  attachments/
    stage-registry.ts
    stage-registry.test.ts
  runtimes/
    composition.ts
    hermes/
      composition.ts
      ...existing Hermes modules
    opencode/
      UPSTREAM.md
      client.ts
      client.test.ts
      composition.ts
      adapter.ts
      adapter.test.ts
      workspace.ts
      workspace.test.ts
      history.ts
      history.test.ts
      run.ts
      run.test.ts
      interactions.ts
      interactions.test.ts
      content.ts
      content.test.ts
    openclaw/
      UPSTREAM.md
      client.ts
      client.test.ts
      device-store.ts
      device-store.test.ts
      composition.ts
      adapter.ts
      adapter.test.ts
      workspace.ts
      workspace.test.ts
      history.ts
      history.test.ts
      run.ts
      run.test.ts
      interactions.ts
      interactions.test.ts
      content.ts
      content.test.ts
```

Keep `packages/proxy/runtime.ts` as the single provider contract. Split concrete
provider behavior by operation, mirroring the successful Hermes structure.
Do not introduce base adapter classes. Shared helpers move upward only after the
second concrete implementation contains proved duplicate code.

## Phase 2 tasks: OpenCode

### P2.1 — Make the existing proxy runtime-neutral

**Files:** `packages/proxy/config.ts`, `config.test.ts`, `composition.ts`,
`composition.test.ts`, `app.ts`, `app.test.ts`, `events/service.ts`,
`events/service.test.ts`, `guest/service.ts`, `guest/service.test.ts`, relevant
`routes/*.ts`, new `packages/proxy/runtimes/composition.ts`, new
`packages/proxy/runtimes/hermes/composition.ts`, and the attachment registry
move shown above.

1. Add failing tests for `runtime.kind`, same-kind guest composition, generic
   runtime naming, generic guest Session resolution, and unchanged Hermes auth.
2. Move the attachment-stage registry out of Hermes without changing behavior.
3. Replace `hermes`, `hermesForOperator`, and Hermes type imports in shared
   app/event/guest code with `ServerRuntime`/`ServerRunEngine` terms.
4. Move Hermes construction into its runtime folder and add the exhaustive
   known-runtime switch.
5. Run the shared proxy/auth/guest/event tests, typecheck, and the existing
   Hermes E2E journey before proceeding.

### P2.2 — Add the official OpenCode client facade

**Files:** `package.json`, `bun.lock`, new `runtimes/opencode/client.ts`,
`client.test.ts`, `composition.ts`, `UPSTREAM.md`, plus config tests/examples.

1. Make the already-resolved `@opencode-ai/sdk@1.18.29` a direct dependency.
2. Test exact base URL/directory binding, Basic-auth injection, cancellation,
   SDK error sanitization, cursor pagination, durable event iteration, and
   close/abort behavior with a controlled HTTP/SSE server.
3. Expose only the SDK operations AOS immediately consumes. Validate returned
   data before it reaches normalized converters.
4. Add operator and separately constructed guest clients; neither exposes its
   credentials or native configuration.

### P2.3 — Implement workspace, Sessions, and history

**Files:** new `workspace.ts`, `history.ts` and focused tests;
port only relevant fixtures/assertions from the former browser adapter and
experimental OpenCode adapter.

1. Test Agent filtering, hidden creator treatment, stable identity, deterministic
   order, read-only visibility, and capability values.
2. Test bounded recent Session catalog, cursor translation, on-demand pages,
   ownership, lifecycle mutations, partial history, chronological projection,
   reasoning/tools/images, Todos, models, context, and activity.
3. Implement direct SDK reads and normalized projections.
4. Prove cross-Agent/cross-Session rejection occurs before native mutation.

### P2.4 — Implement runs, streaming, Stop, and reconnect

**Files:** new `run.ts`, `run.test.ts`, and proxy run/event integration fixtures.

1. Test one authorized new user turn or one interrupt response per run.
2. Admit with a stable caller-supplied native identity; map durable text,
   reasoning, tool, progress, lifecycle, and terminal events to standard AG-UI.
3. Test exact duplicate admission, changed-payload conflict, lost acknowledgement
   as `uncertain`, and authoritative identity reconciliation without resend.
4. Map Stop to native interrupt and wait for terminal/idle settlement.
5. Test replay from aggregate sequence, gap detection, subscribe-before-read,
   authoritative history fallback, reload, and native outage.

### P2.5 — Implement interactions and content

**Files:** new `interactions.ts`, `content.ts`, and focused tests.

1. Map scoped question batches and permission requests to AG-UI interrupts and
   existing normalized snapshots/responses.
2. Allow only decisions supported by the native request; preserve typed answer
   validation and exact Session/run ownership.
3. Stage bounded inline attachments for the next admitted turn. Project safe
   images and optional integration-backed rich output/artifact receipts.
4. Mark reactions, audio, visibility mutation, and any unproved operation
   unavailable with exact reasons and limits.

### P2.6 — Integrate and accept OpenCode

**Files:** the concrete OpenCode `adapter.ts`; invitation schemas in
`packages/protocol`; `src/runtime-adapters/aos/aos-client.ts`;
`src/components/workspace/session-actions.tsx`; a new provider-neutral
invitation dialog/tests; both locale dictionaries; `gateway/`;
`Dockerfile.opencode`; `deploy/` including the old gateway service template;
Compose files; `.env*.example`; maintained operator/runtime docs;
shared/generated native invitation instructions; container/deletion manifests;
and E2E/security tests.

1. Assemble the concrete OpenCode `adapter.ts` from the tested operation
   modules; the provider-adapter owner exclusively edits this seam.
2. Add a strict authenticated OpenCode runtime config and internal-only
   deployment overlay. Remove native host-port publication and browser CORS;
   add negative ingress/Compose tests for the port and provider routes.
3. Add one provider-neutral operator Session action that calls the existing
   authenticated `POST /api/aos/v1/guest-invitations`, constructs the guest
   fragment URL from the normalized response and configured guest origin, and
   lets the operator copy it. Keep signing keys and JWT construction in the
   proxy. Cover English/Hebrew, keyboard access, expiry/error states, and an E2E
   link that opens the exact authorized guest Session.
4. Run the full operator journey and the invitation-scoped guest journey against
   controlled native fixtures.
5. Prove browser-bundle exclusion of OpenCode packages, provider payloads,
   credentials, native URLs, and paths.
6. Once Hermes and OpenCode invitation issuance/guest parity pass, delete the Go
   gateway source/module/build stage/tests/service template and every command
   that invokes `aos-gateway`. Update `README.md`, `docs/architecture.md`,
   `docs/deployment.md`, `docs/invite-chat.md`, `docs/troubleshooting.md`, all
   three runtime docs, the capability matrix, and generated native invitation
   instructions to the normalized operator action/API. Keep OpenClaw documented
   as unavailable until Phase 3.
7. Run deletion tests proving no Go gateway binary, old device environment
   variable, provider-native browser route, or stale invitation instruction
   remains.
8. Run the Phase 2 gate below. Perform live acceptance only with an approved
   disposable OpenCode target.

## Phase 3 tasks: OpenClaw

### P3.1 — Adopt the official gateway packages

**Files:** `package.json`, `bun.lock`, new `runtimes/openclaw/client.ts`,
`client.test.ts`, and `UPSTREAM.md`.

1. Add both exact `2026.9.4` dependencies.
2. Automate the successful Bun import/construction/close probe.
3. Test protocol v4 handshake, request cancellation/timeouts, out-of-order
   responses, event gaps, reconnect pause, scoped subscription acquisition and
   release, and sanitized errors with a controlled gateway.
4. Wrap only fixed-URL construction and the AOS-used typed requests; keep the
   official client lifecycle intact.

### P3.2 — Implement device auth and lane composition

**Files:** new `device-store.ts`, `device-store.test.ts`, `composition.ts`, and
config/secret tests and examples.

1. Test private regular-file identity/token loading, Ed25519 validation,
   atomic token rotation, and fail-closed malformed or insecure state.
2. Supply official client host callbacks for challenge signing and device-token
   persistence.
3. Construct separate operator and guest devices/clients with only their
   required scopes. Never share a privileged paired token across lanes.
4. Test pairing-required, missing-scope, expired token, rotation, shutdown, and
   reconnect behavior without leaking native details.

### P3.3 — Implement workspace, Sessions, and history

**Files:** new `workspace.ts`, `history.ts` and focused tests;
port only relevant fixtures/assertions from the retired browser/Go paths and
experimental TypeScript adapter.

1. Test Agent filtering, hidden/system Agents, stable native identities,
   deterministic order, catalog continuation, lifecycle, and exact ownership.
2. Test bounded Session catalog/history, message/reasoning/tool projection,
   models, context, activity, and the exact native capability limits.
3. Subscribe before authoritative reads; repeat a read if its scope was
   invalidated during the read.
4. Keep tasks/goals distinct from AOS Todos and keep visibility mutation
   unavailable unless the pinned native method proves identical semantics.

### P3.4 — Implement runs, streaming, Stop, and reconnect

**Files:** new `run.ts`, `run.test.ts`, and proxy run/event integration fixtures.

1. Test one admitted turn, native idempotency key, exact Session/Agent binding,
   and mapping of text, reasoning, tool, progress, lifecycle, and terminal
   events to AG-UI.
2. Test uncertain send without replay, native terminal correlation, queued or
   in-flight run adoption, and exact Stop settlement.
3. Test socket-generation sequence reset, forward gap detection, Session
   resubscription, authoritative history reconciliation, reload, and outage.
4. Request the native `tool-events` capability; if not negotiated, expose the
   reduced tool detail honestly rather than reconstructing it.

### P3.5 — Implement interactions and content

**Files:** new `interactions.ts`, `content.ts`, and focused tests.

1. Map questions and approvals using their scoped native IDs, allowed decisions,
   and expiry. Keep raw commands, paths, and approval internals server-side.
2. Apply native attachment limits from the negotiated gateway policy and test
   the full encoded request size.
3. Authorize artifact reads only from native receipts tied to the exact
   Agent/Session/message. Keep plugin path validation separate from publication
   authority.
4. Expose native audio only where the pinned gateway proves the complete
   operation; do not infer it from generic media transport.

### P3.6 — Integrate and accept OpenClaw

**Files:** the concrete OpenClaw `adapter.ts`; `deploy/`; Compose files;
`.env*.example`; `README.md`; `docs/architecture.md`, `docs/deployment.md`,
`docs/invite-chat.md`, `docs/troubleshooting.md`,
`docs/runtimes/openclaw.md`, `docs/runtime-capabilities.md`;
container/deletion manifests; and E2E/security tests.

1. Assemble the concrete OpenClaw `adapter.ts` from the tested operation
   modules; the provider-adapter owner exclusively edits this seam.
2. Add strict OpenClaw runtime/device config and deployment overlay without a
   browser Gateway route or plugin-mediated transport.
3. Run controlled operator and exact-Session guest journeys, including pairing
   state, Stop, reload, and reconnect.
4. Prove browser-bundle and guest-projection non-disclosure.
5. Re-run deletion tests proving the Phase 2 Go/browser path cannot return and
   update maintained runtime/deployment documentation for the available
   normalized OpenClaw path.
6. Run the Phase 3 gate below. Perform live pairing/model acceptance only with
   an approved disposable OpenClaw target.

## Work distribution

One integration owner exclusively edits shared protocol, `ServerRuntime`, app,
configuration, composition, event, and guest-service files. A single provider-
adapter owner exclusively edits each provider's `adapter.ts` and composition
seam. Parallel operation agents return additive leaf modules, tests, fixtures,
and handoff notes; they never edit the adapter seam.

| Surface                            | Outcome                                                                                              | Dependencies / shared boundary                                                     | Owner role                                                             | Execution                                                 | Checkpoint                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| P2.1 shared proxy                  | Runtime-neutral names, config union, Hermes composition move, generic attachment and guest/run types | Existing `ServerRuntime`; exclusive shared-proxy writer                            | Integration owner (`gpt-5.6-luna`, high)                               | Serial first; benefits every later runtime                | Hermes unit/E2E gate; hand off frozen composition types       |
| P2.2 OpenCode client               | Tested official-SDK facade and lane factories                                                        | P2.1 composition draft; dependency edits reserved to integration owner             | OpenCode adapter owner (`gpt-5.6-terra`, high)                         | Serial within provider; parallel with no shared writes    | Controlled HTTP/SSE tests; freeze facade for operation agents |
| P2.3 OpenCode reads                | Catalog, ownership, Sessions, history, workspace values                                              | Frozen client facade and normalized protocol types                                 | OpenCode data agent (`gpt-5.6-terra`, high)                            | Parallel leaf work; faster fixture/converter port         | Focused leaf tests; hand modules to adapter owner             |
| P2.4 OpenCode runs                 | AG-UI stream, Stop, uncertainty, replay/reconcile                                                    | Frozen client facade and `ServerRunEngine`; no `adapter.ts` edits                  | OpenCode run agent (`gpt-5.6-sol`, high)                               | Parallel high-risk leaf work                              | Focused run tests; hand module to adapter owner               |
| P2.5 OpenCode interactions/content | Questions, approvals, attachments, artifacts, capability values                                      | Frozen client facade and protocol schemas; no `adapter.ts` edits                   | OpenCode content agent (`gpt-5.6-terra`, high)                         | Parallel independent leaves                               | Focused tests; hand modules to adapter owner                  |
| P2.6 OpenCode assembly/cutover     | Concrete adapter, operator invitation action/API, guest deployment, and Go removal                   | All OpenCode leaves green; exclusive `adapter.ts`, shared UI/deploy/deletion write | OpenCode adapter owner, then integration owner (`gpt-5.6-sol`, medium) | Serial assembly, invitation acceptance, then deletion     | Hermes/OpenCode guest E2E, deletion gate, Phase 2 full gate   |
| P3.1–P3.2 OpenClaw client/auth     | Official client, protocol validation, persistent paired device per lane                              | P2.1 composition types frozen; dependency edits reserved to integration owner      | OpenClaw adapter owner (`gpt-5.6-sol`, high)                           | May overlap P2 leaves because provider folder is disjoint | Controlled gateway/device tests; freeze facade                |
| P3.3 OpenClaw reads                | Catalog, ownership, Sessions, history, workspace values                                              | Frozen OpenClaw facade and normalized protocol                                     | OpenClaw data agent (`gpt-5.6-terra`, high)                            | Parallel leaf work; no `adapter.ts` edits                 | Focused leaf tests; hand modules to adapter owner             |
| P3.4 OpenClaw runs                 | AG-UI stream, Stop, uncertainty, resubscribe/reconcile                                               | Frozen client/subscription facade; no `adapter.ts` edits                           | OpenClaw run agent (`gpt-5.6-sol`, high)                               | Parallel high-risk leaf work                              | Focused run tests; hand module to adapter owner               |
| P3.5 OpenClaw interactions/content | Questions, approvals, attachment policy, artifacts, capability values                                | Frozen client facade and protocol validators; no `adapter.ts` edits                | OpenClaw content agent (`gpt-5.6-terra`, high)                         | Parallel independent leaves                               | Focused tests; hand modules to adapter owner                  |
| P3.6 OpenClaw assembly/cutover     | Concrete adapter, lanes, deployment, and maintained-doc cutover                                      | All OpenClaw leaves green and Phase 2 accepted; exclusive shared writer            | OpenClaw adapter owner, then integration owner (`gpt-5.6-sol`, medium) | Serial assembly and normalized cut-in                     | Phase 3 full/deletion-regression gates; fresh result reviews  |
| Conformance/quality review         | Independent plan/result challenge                                                                    | Writers stopped; complete plan or diff and fresh evidence                          | Fresh combined reviewer (`gpt-5.6-terra`, high)                        | Read-only delegation prevents self-review blind spots     | Report handed to integration owner before acceptance          |
| Security review                    | Independent auth/data-boundary review                                                                | Combined target plus secrets/lane/deployment evidence                              | Fresh Security reviewer (`gpt-5.6-sol`, high)                          | Read-only and parallel with combined review               | Approved report required before each phase acceptance         |

Agents do not edit `package.json` or `bun.lock` concurrently. The integration
owner applies reviewed dependency changes once per checkpoint and owns final
verification/corrections. Provider-adapter owners verify each handoff before
wiring it; operation agents do not integrate their own work. No Astra model is
needed.

## Verification gates

Every task begins by porting or writing one observable behavior test, observing
it fail, implementing the smallest change, and observing it pass.

### Phase 2 gate

```bash
bunx vitest run packages/proxy/runtimes/opencode packages/proxy
bun run test
bun run typecheck
bun run lint
bun run build
bun run test:e2e
bun run integrations:build
bunx vitest run test/containers/compose.test.ts
docker compose -f compose.yaml config --quiet
AOS_UI_OPENCODE_WORKTREE=/absolute/disposable/worktree \
  docker compose -f compose.yaml -f compose.opencode.yaml config --quiet
git diff --check
```

### Phase 3 gate

```bash
bunx vitest run packages/proxy/runtimes/openclaw packages/proxy
bun run test
bun run typecheck
bun run lint
bun run build
bun run test:e2e
bun run integrations:build
bunx vitest run test/containers/compose.test.ts
docker compose -f compose.yaml config --quiet
docker compose -f compose.yaml -f compose.openclaw.yaml config --quiet
git diff --check
```

Also build affected images and smoke static delivery, proxy health/readiness,
normalized catalogs/history, AG-UI streaming, Stop, reload/reconnect, and guest
isolation. Mocked or controlled-gateway tests are not reported as live native
acceptance.

## Estimates

The estimates are agent-hours of implementation and local/mock verification,
not human calendar hours and not time waiting for credentials or pairing:

| Scope                            | Agent-hours | Parallel elapsed target |
| -------------------------------- | ----------: | ----------------------: |
| P2.1 shared cleanup              |         2–3 |               2–3 hours |
| P2.2–P2.5 OpenCode adapter       |         5–8 | 2–4 hours after cleanup |
| P2.6 integration/cutover         |         4–6 |               4–6 hours |
| **Phase 2 total**                |   **11–17** |          **8–13 hours** |
| P3.1–P3.2 OpenClaw client/device |         3–5 |               3–5 hours |
| P3.3–P3.5 OpenClaw adapter       |         6–9 |    3–5 hours after auth |
| P3.6 integration/gate            |         2–3 |               2–3 hours |
| **Phase 3 total**                |   **11–17** |          **8–12 hours** |

The official clients eliminate custom transport implementation; most remaining
work is observable runtime projection, ownership, guest isolation, and
verification. If a pinned native method differs from its published schema, stop
that operation, record the exact mismatch, and adjust its capability rather
than expanding the architecture.

## Scope check

This plan is limited to the two known remaining runtimes and the shared cleanup
they immediately require. It preserves the completed Hermes path, existing
browser runtime, protocol, UI, auth, guest projection, and deployment model.
It does not reopen Phase 1 or redesign the proxy.
