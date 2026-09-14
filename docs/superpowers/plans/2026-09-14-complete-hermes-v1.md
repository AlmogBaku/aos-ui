# Complete Hermes V1 — resume-safe implementation plan

This is the maintained execution record for Hermes V1. The target behavior is
defined by [AOS runtime gateway V1](../../design/aos-runtime-gateway-v1.md).
This file records what is already implemented, what must not regress, and the
remaining work. It supersedes earlier task text as an execution checklist.

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

## Remaining work

### 1. Revalidate the current live build

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

### 2. Fix only reproduced acceptance failures

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

### 3. Complete operator and guest acceptance

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

### 4. Run the final gate once after the last implementation edit

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

### 5. Final review and cutover

- Review conformance against the V1 design and this frozen baseline.
- Review capability fidelity, ownership, guest isolation, credential/native
  payload non-disclosure, reconnect, and uncertain-send behavior.
- Confirm no browser provider SDK/direct provider path or obsolete Go gateway
  route remains in the production bundle or deployment.
- Update the evidence below with final command results and live acceptance.
- Only then mark V1 complete and plan OpenCode/OpenClaw adapter work.

## Completion checklist

- [x] Shared runtime, coordinator, fanout, and package structure
- [x] Multiplexed Hermes transport and retained Session attachments
- [x] Provider-neutral browser runtime and lazy Session creation
- [x] Standard AG-UI streaming, PLAN Activities, and interrupts
- [x] Shared guest authorization/projection path
- [x] Server-token configuration and deployment implementation
- [ ] Current user-visible regressions revalidated against `08ea31f`
- [ ] Operator journey passes without refresh-based recovery
- [ ] Scoped guest journey passes over the shared runtime
- [ ] Full verification gate passes after the final edit
- [ ] Final conformance, quality, and security review passes

Update this document after every checkpoint. Never move an implemented item
back into the work queue unless a failing test or live reproduction proves a
regression.
