# Complete Hermes V1 — resume-safe implementation plan

**Status (2026-09-15): complete.** The implementation, cleanup, adapter
boundary, local verification, and user-driven browser acceptance have passed.
Playwright and Agent Browser were intentionally not run per the operator's
instruction; the operator manually revalidated the live browser journey.

This is the maintained execution record for Hermes V1. The target behavior is
defined by [AOS runtime gateway V1](../../design/aos-runtime-gateway-v1.md).
This file records what is already implemented, what must not regress, and the
completion evidence. It supersedes earlier task text as an execution checklist.

## Resume point

- Branch: `codex/aos-runtime-proxy-hermes`
- Protected implementation baseline: commit `08ea31f`
  (`feat(proxy): complete shared Hermes V1 runtime path`)
- Worktree at the checkpoint: clean
- Do not reset to an earlier commit, replay the original migration plan, or
  restore deleted donor architecture.
- Do not touch `.agents/ADRs/`.
- Preserve new fixes by extending the existing modules and their behavior
  tests. Do not rewrite the proxy, coordinator, Hermes adapter, or browser
  runtime unless a reproduced failure proves that the current seam is wrong.

## Frozen V1 decisions

- One configured Hermes runtime selected through a future-compatible adapter
  factory seam.
- The trusted operator listener has no application authentication.
- The separate guest listener uses scoped invitation JWTs verified by `jose`.
- Both lanes share one `RuntimeInstance`, `SessionCoordinator`, Hermes adapter,
  attachment registry, and multiplexed native WebSocket.
- Hermes uses one server token loaded from a secret file.
- Bun serves the application and normalized API. Nginx is optional external
  TLS/reverse-proxy infrastructure.
- The browser remains provider-neutral and talks only AOS REST/events and
  standard AG-UI runs.
- A new Session stays local until first Send. Initialization creates exactly
  one Hermes Session, then the queued turn is sent exactly once.
- Native durable Session IDs appear directly in URLs; runtime/profile prefixes
  are not added.
- Browser disconnect never stops Hermes work. Terminal idle attachments close
  after five minutes while the shared native socket remains open.
- An interrupt ends one AG-UI run segment. Answer or cancel starts one fresh
  AG-UI `runId` with a complete `resume[]` while retaining the same logical
  Hermes execution.
- V1 includes a clean structural cutover. File/package cleanup, removal of
  replaced code, and a proven adapter-selection seam are acceptance work, not
  optional follow-up.
- V1 does not create empty OpenCode/OpenClaw adapters or a generic transport
  framework. It leaves one clear place to add each real adapter without
  changing core coordination, normalized routes, or browser code.

## Implemented baseline — do not schedule again

### Proxy and Hermes

- Proxy packages are organized under `core`, `adapters/hermes`, `auth`,
  `events`, and `routes`.
- Operator and guest listeners receive the same runtime instance.
- The coordinator owns admission, conflicts, Stop settlement, reconnect,
  bounded replay, subscriber fanout, and authoritative reconciliation.
- One Hermes JSON-RPC WebSocket correlates concurrent requests and routes native
  events by live Session ID.
- The attachment registry performs single-flight resume, reconnect reattach,
  retention, and per-Session idle release without closing the shared socket.
- Lost mutation acknowledgements remain uncertain and are never replayed.
- Catalogs, visibility, history, and content continue to use the existing
  validated Hermes dashboard client and converters.
- Public failures use normalized `{ code, description }` errors and do not
  expose native errors, URLs, credentials, or payloads.

### Browser runtime

- The browser uses the public assistant-ui remote thread-list and AG-UI runtime
  APIs with the message queue enabled.
- Local drafts make no Session-scoped requests before first Send.
- Session ownership is resolved before scoped calls and delayed results cannot
  overwrite the selected Session.
- Run SSE delivers reasoning, tools, progress, and final text without requiring
  a history refresh.
- Edit and retry use the normalized run endpoint and preserve Hermes history
  preconditions.
- One page-level AOS `/events` WebSocket multiplexes invalidation scopes. It is
  separate from the single server-side Hermes WebSocket.

### AG-UI workspace behavior

- Session Todos use `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` with
  `activityType: "PLAN"` and the existing `TodoItem` content.
- Todo state restores through normalized history and Activity Messages are not
  forwarded to Hermes as prompt history.
- Session status derives from scoped AG-UI lifecycle plus authoritative Hermes
  activity; it is not polled from `/workspace/activity`.
- Questions and approvals use AG-UI interrupt outcomes and restore from
  `metadata.custom.agui.interrupts`; `/interactions/pending` is not a browser
  dependency.
- Answer and cancel send one complete `resume[]`; they are not converted into a
  new Hermes user prompt.
- Settled batched questions retain their normalized questions and recorded
  answers. A cancelled question renders `Discarded` rather than an empty
  assistant message.
- Hermes continuation events that omit a second native `message.start` still
  open a normalized assistant message and stream the final response live.
- Capabilities are cached by Agent/Session scope and do not refresh on generic
  invalidations or rerenders.
- Transcription and speech synthesis are called only after their explicit user
  actions; there is no automatic audio-availability polling.
- Browser requests to the obsolete Todos, activity, pending-interaction, and
  audio-availability read endpoints have been removed.

### Access and deployment

- Guest authorization, projection, expiry, reconnect binding, and limits run
  over the shared runtime without granting broader operator access.
- OIDC, operator cookies, Hermes browser authentication, cookie jars, and the
  duplicate guest Hermes runtime have been removed from V1.
- Compose, public configuration examples, and operator documentation describe
  server-token Hermes and the trusted operator/separate guest listeners.

## Current evidence at `08ea31f`

- Exact question regressions were developed red-to-green:
  - settled batched questions preserve answers and cancelled responses;
  - a resumed Hermes interaction streams when no second `message.start` is
    emitted;
  - the question UI renders each recorded answer or `Discarded`.
- Focused affected suite: 6 files, 186 tests passed.
- `bun run typecheck`: passed.
- `bun run lint`: passed.
- `bun run build`: passed with the existing Vite/CSS/chunk-size warnings.
- Live proxy service: active; `/healthz` reported `live`, `/readyz` reported
  `ready`, and the Tailnet application returned HTTP 200.

This evidence protects the checkpoint; it is not the final V1 acceptance gate.

## Structural gaps in the protected baseline

Commit `08ea31f` protects working behavior, but it is not yet the desired
final structure:

- `composition.ts` imports and constructs Hermes directly, and its dependency
  interface exposes Hermes transport types.
- `guest/service.ts` contains a second large Hono route stack instead of
  mounting the same normalized route modules with a guest policy.
- `HermesRunEngine.reconnect()` remains as a deprecated rollout shim even
  though `recover()` is the runtime interface.
- The package root exports Hermes implementation types alongside the public
  proxy surface.
- The old Go `gateway/`, its build stage, systemd/Nginx templates, environment
  variables, tests, generated invite instructions, and maintained docs still
  coexist with the TypeScript proxy.
- Some affected comments and tests still describe removed “legacy” interaction
  and gateway paths.

These are cleanup gaps, not permission to redesign working run, interaction,
retention, authorization, or projection behavior.

## Completion work

### 1. Finish the file and package structure

Perform a behavior-preserving move to this ownership shape:

```text
packages/proxy/
├── adapters/
│   ├── create-runtime.ts
│   └── hermes/
├── auth/
├── core/
├── events/
├── listeners/
│   └── guest.ts
├── routes/
├── app.ts
├── composition.ts
├── config.ts
├── server.ts
└── cli.ts
```

- `core/` owns only provider-neutral runtime, coordinator, fanout, attachment
  staging, and lifecycle concepts.
- `adapters/hermes/` owns every Hermes DTO, validator, converter, dashboard
  operation, native transport, attachment, and retention detail.
- `adapters/create-runtime.ts` is the only production module that selects an
  adapter kind. For V1 it has one exhaustive `hermes` case.
- `composition.ts` loads shared configuration/secrets, asks the adapter
  factory for one `RuntimeInstance`, and injects that exact instance into both
  listeners. Its dependency interface must not expose Hermes transport types.
- `routes/` owns the normalized operation implementations. The trusted
  operator app mounts them directly; the guest listener adds scoped
  authorization/projection wrappers while reusing history, artifacts, run
  normalization, SSE delivery, coordination, and Stop behavior.
- `app.ts` composes the trusted operator app. `listeners/guest.ts` composes the
  guest HTTP policy, while `events/guest.ts` owns guest WebSocket policy. An
  empty `listeners/operator.ts` pass-through is intentionally avoided.
- The package root exports the provider-neutral composition/server surface.
  Adapter internals are imported through their own modules only.
- Split a large file only when it mixes these ownership responsibilities.
  File length alone is not a reason to create pass-through modules.

Run the current focused proxy, Hermes, guest, and browser suites after each
move. A move is complete only when `git diff --find-renames` shows moves rather
than delete-and-recreate churn where the implementation was preserved.

### 2. Remove every replaced V1 path

Delete code only after its TypeScript replacement is covered:

- remove the deprecated Hermes `reconnect()` shim and make its tests use the
  public `recover()` interface;
- remove the Go `gateway/` tree and Go build/copy steps;
- remove obsolete gateway systemd/Nginx templates, Compose wiring, environment
  variables, container tests, and troubleshooting instructions;
- replace maintained invite instructions that invoke `aos-gateway` with the
  TypeScript proxy's supported invitation operation, then regenerate tracked
  integration copies through the repository's existing build;
- remove stale browser/provider routes, adapters, schemas, imports, tests, and
  comments whose replacement is already active;
- remove obsolete workspace Todo/activity/pending/audio read routes and
  contracts once no production caller or recovery path uses them;
- update maintained OpenCode/OpenClaw docs to describe their current status
  accurately rather than directing operators to the deleted Go gateway.

Audit the affected proxy/AOS/deployment paths for `deprecated`, `legacy`,
`compat`, old gateway commands, and deleted endpoint names. Every match must
either be removed or identify an active external compatibility requirement.
Do not retain dead code as a donor; the research documents preserve the useful
native findings.

### 3. Prove readiness for OpenCode and OpenClaw

V1 remains a single-Hermes deployment, but the next adapter must require only:

1. one strict runtime-config variant;
2. one new `adapters/<kind>/` implementation of `ServerRuntime`;
3. one exhaustive case in `adapters/create-runtime.ts`;
4. adapter-specific tests and deployment documentation.

Adding an adapter must not require edits to:

- `core/session-coordinator.ts` or subscriber fanout;
- normalized route handlers;
- operator/guest authorization and projection semantics;
- AG-UI protocol schemas;
- the provider-neutral browser runtime or workspace UI.

Add conformance tests proving:

- a provider-neutral test runtime can pass through the common listener/routes
  stack without importing Hermes;
- both lanes receive the exact same selected `RuntimeInstance`;
- runtime shutdown closes the selected adapter exactly once;
- adapter capabilities and unavailability reasons reach the browser without
  boolean reduction;
- common run admission, Stop, reconnect, interrupts, and guest projection use
  only the `ServerRuntime` interface;
- production imports from `core`, `routes`, `auth`, `events`, and browser
  AOS modules contain no Hermes types or native protocol constants.

Transport connection, native identity, recovery, and Session-retention policy
remain inside each adapter. Do not force OpenCode or OpenClaw into Hermes'
WebSocket/attachment model.

### 4. Revalidate the current live build

Use the running Tailnet application and current Hermes data. Do not restart the
Hermes service or mutate Agents/profiles. Confirm these user-visible behaviors:

- status is not shown as unavailable for a reachable idle/running Session;
- opening or rerendering a Session creates no recurring requests for Todos,
  activity, pending interactions, audio availability, or capabilities;
- one browser page opens no more than one AOS invalidation WebSocket;
- New Session is local until first Send and adopts only the native Session ID;
- send, reasoning, tools, final response, edit, and retry work without refresh;
- a question/approval renders, answer and discard each produce a visible
  receipt, and the final response streams immediately;
- question/approval state survives reload and remains answerable;
- `present_artifact` renders during the live run, not only after history reload;
- reload during running or waiting-for-input reattaches without resending and
  does not leave a stale `Hermes is already running this Session` conflict;
- Stop settles only after Hermes reaches a terminal/idle state.

Record each failure with its Session, visible symptom, relevant normalized
request/event sequence, and whether refresh changes the result. Do not patch a
second symptom until the first has a deterministic regression test.

### 5. Fix only reproduced acceptance failures

For each live failure:

1. Add one focused test at the existing owner seam.
2. Observe the expected failure.
3. Make the smallest correction.
4. Rerun the focused test and its affected package suite.
5. Recheck the exact live behavior.

Keep ownership narrow:

| Failure surface | Primary files |
| --- | --- |
| Hermes native stream/history/interaction | `packages/proxy/adapters/hermes/` |
| Admission, fanout, Stop, reconnect | `packages/proxy/core/` and `packages/proxy/routes/runs.ts` |
| AOS request/event mapping and drafts | `src/runtime-adapters/aos/` |
| Question, artifact, execution presentation | `src/components/tool-ui/` and existing assistant-ui elements |
| Guest scope/projection | `packages/proxy/auth/` and shared guest routes |
| Configuration/deployment | `packages/proxy/config.ts`, Compose, and maintained operator docs |

Do not let parallel writers edit the same surface. Shared contract changes are
applied by one integration owner after consumers demonstrate the requirement.

### 6. Complete operator and guest acceptance

After the operator journey is stable, verify one scoped guest invitation over
the same runtime:

- permitted Agent/Session operations work through normalized endpoints;
- disallowed scope and operations fail before Hermes access;
- guest projection hides reasoning/private tool data when excluded;
- guest expiry disconnects only that subscriber and does not stop the native
  execution or operator stream;
- operator and guest observe the same authorized logical execution without
  opening a second Hermes socket.

No live native acceptance may be claimed without an approved disposable target
and credentials.

### 7. Run the final gate once after the last implementation edit

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
docker compose -f compose.yaml -f compose.hermes.yaml config --quiet
```

Do not use Agent Browser. Use Codex Chrome only when it is available; otherwise
record the user-driven browser acceptance separately. Classify failures before
changing scope: fix regressions from V1, document unrelated pre-existing or
upstream failures, and do not broaden the architecture to make a test pass.

### 8. Final review and cutover

- Review conformance against the V1 design and this frozen baseline.
- Confirm the final file tree matches the ownership map and has no duplicate
  route/runtime implementations.
- Confirm the adapter-selection seam satisfies the four-location change budget
  above without adding placeholder adapters.
- Review capability fidelity, ownership, guest isolation, credential/native
  payload non-disclosure, reconnect, and uncertain-send behavior.
- Confirm no discarded/deprecated V1 shim, browser provider SDK/direct provider
  path, Go gateway source/build/deployment artifact, or obsolete endpoint
  remains.
- Update the evidence below with final command results and live acceptance.
- Only then mark V1 complete and plan OpenCode/OpenClaw adapter work.

## Completion checklist

- [x] Shared runtime, coordinator, fanout, and package structure
- [x] Multiplexed Hermes transport and retained Session attachments
- [x] Provider-neutral browser runtime and lazy Session creation
- [x] Standard AG-UI streaming, PLAN Activities, and interrupts
- [x] Shared guest authorization/projection path
- [x] Server-token configuration and deployment implementation
- [x] Files/packages match the final ownership structure
- [x] Operator and guest reuse the normalized operation implementations
- [x] Adapter selection is isolated and composition is provider-neutral
- [x] Go gateway and all replaced/deprecated V1 paths are removed
- [x] OpenCode/OpenClaw adapter-readiness conformance tests pass
- [x] Current user-visible regressions revalidated against `08ea31f`
- [x] Operator journey passes without refresh-based recovery
- [x] Scoped guest behavior passes over the shared runtime
- [x] Full permitted verification gate passes after the final edit
- [x] Final conformance, quality, and security review passes

## Final evidence — 2026-09-15

- User-driven acceptance: the operator reports the live manual tests pass,
  including the previously reported streaming, reasoning, question, edit,
  retry, draft Session, status, artifact, and request-noise regressions.
- `bun run test`: 142 files and 1,304 tests passed.
- `bun run typecheck`: passed.
- `bun run lint`: passed.
- `bun run build`: passed with the existing Vite/CSS/chunk warnings.
- `bun run integrations:build`: passed and regenerated tracked integration
  assets.
- `bun run hermes:test`: 43 tests passed.
- `bunx vitest run test/containers/compose.test.ts`: 10 tests passed.
- Base and Hermes Compose configurations passed `config --quiet` with explicit
  secret-file paths.
- Architecture conformance proves a provider-neutral runtime reaches common
  routes, both lanes share one selected `RuntimeInstance`, runtime close is
  idempotent, and common proxy/browser modules contain no Hermes native imports.
- Cleanup scans and `git diff --check` passed. The Go gateway, deprecated
  reconnect shim, obsolete polling endpoints, provider-specific browser path,
  and stale gateway deployment wiring are absent.
- Playwright and Agent Browser were not run. This is an explicit acceptance
  substitution, not an unreported pass.

Update this document after every checkpoint. Never move an implemented item
back into the work queue unless a failing test or live reproduction proves a
regression.
