# Hermes V1 implementation record

**Status (2026-09-15): complete.**

This is the maintained resume point for Hermes V1 and runtime-neutral guest
conversations. The normative architecture authority is
[AOS runtime gateway architecture](../../design/aos-runtime-gateway-architecture.md);
[AOS runtime gateway V1](../../design/aos-runtime-gateway-v1.md) is a dated
completion record. Do not restore deleted donor, authentication, WebSocket, or
Go gateway paths.

## Frozen V1 shape

- One configured runtime selected through `adapters/create-runtime.ts`; V1
  configures Hermes only.
- One `RuntimeInstance`, `SessionCoordinator`, adapter, Hermes transport, and
  attachment registry shared by trusted operator and scoped guest traffic.
- Trusted operator port has no application authentication. The separate guest
  port verifies scoped JWT invitations with `jose`.
- The browser is provider-neutral and uses standard AG-UI SSE for run input,
  interrupts, replay, and reconnect. Normalized AOS REST carries workspace
  operations plus Stop and optional active-turn steering.
  _(Superseded 2026-09-19 by the ACP v2 wire (`92a24f2`, `f042380`, `046d3bf`);
  see `docs/runtimes/acp.md`.)_
- One operator invalidation WebSocket is page-scoped. Guest pages have no
  invalidation WebSocket and reconcile on reload/focus.
- Browser disconnect never stops Hermes. Terminal Sessions stay warm for five
  minutes, then only that Session attachment closes; the multiplexed Hermes
  socket stays open.
- Bun serves the application and APIs. Nginx is optional external TLS/proxy
  infrastructure.

## Implemented operator path

- Agent and paginated Session catalogs, ownership, lazy local Session drafts,
  history, send/stream, reasoning, tools, Stop, active-turn steering,
  edit/retry, artifacts, voice, PLAN activities, questions/approvals, reload,
  and reconnect.
- Stop and steering share the coordinator's provider-neutral run-control lane.
  Hermes alone maps them to `session.interrupt` and `session.redirect`;
  steering continues the same logical run and emits no second `RUN_STARTED`.
- AG-UI interrupt answers and cancellation start one fresh run segment with a
  complete `resume[]` while retaining the logical Hermes execution.
- Capabilities are cached; obsolete Todo, activity, pending-interaction, and
  audio-availability polling is absent.
- Hermes uses one server token and one multiplexed JSON-RPC WebSocket. Native
  identity, payload, credentials, paths, live IDs, and positions stay server-side.

## Implemented runtime-neutral guest path

- Commander CLI signs locally with `jose`, defaults to 72 hours, and generates
  a URL-safe reference when `--ref` is omitted. There is no HTTP signing route.
- JWT claims contain only version, issuer, audience, deployment, runtime,
  timestamps, Agent, reference, and optional first-turn/presentation data.
  Fixed V1 permissions live in gateway code.
- `GET /api/guest/v1/runtime` is the sole browser authority for guest context;
  browser code does not decode JWT claims.
- `ServerRuntime.resolveInvitedSession()` performs lookup or atomic lazy
  reuse/create. Hermes uses exact profile plus exact `aos-invite:<ref>` title,
  materializes that title, and authoritatively re-reads it.
- Opening a link and selecting attachments create no Session. First Send
  resolves the Session, materializes attachment staging, and starts one run.
- A private versioned first-turn history envelope seeds the native Session once
  without starting a run or appearing in guest history.
- Guest history uses the shared authoritative history loader, including
  coordinator execution and restored interrupt metadata. A missing invited
  Session returns empty history without creation.
- Guest runs reuse the shared coordinator/SSE path. Reconnect never resends a
  prompt; expiry or disconnect removes only the guest subscriber.
- One allowlist projects safe text, interrupts, PLAN activities, attachments,
  artifacts, custom UI, and friendly errors. Reasoning, raw tools, privileged
  roles, provider metadata/positions, paths, credentials, live IDs, and
  Agent-wide approval grants are removed. Direct Agent-wide approval responses
  are rejected before coordinator/runtime execution.
- Voice transcription and speech are Agent-scoped and never resolve or create
  a Session.
- Guest SSE observation is bounded per invitation and across the guest lane;
  slow or expired guest subscribers cannot block operator delivery.
- Deferred attachment stages expire after five minutes and have explicit
  aggregate-byte and per-invitation bounds.
- Invalid and expired invitations render localized warm recovery copy.

## Structure and next-runtime seam

```text
packages/proxy/
├── adapters/create-runtime.ts
├── adapters/hermes/
├── auth/
├── core/
├── events/
├── guest/{app,context,routes/}
├── routes/
├── app.ts
├── composition.ts
├── config.ts
└── server.ts
```

OpenCode or OpenClaw should require one config variant, one adapter package,
and one factory case. They must not require browser provider branches,
duplicate guest runtimes, or changes to coordinator and normalized route
semantics.

## Verification status

- Focused guest/CLI/projection/Hermes/browser suites: 115 tests passing after
  final review fixes.
- Full deterministic unit suite: 143 files and 1,313 tests passing.
- Typecheck and lint: passing after final review fixes.
- Production build: passing. Existing Vite/CSS/chunk-size warnings remain.
- Browser E2E: 77 tests passing. Guest composition additionally mounts a valid
  invitation with restored history, welcome, prefill, and locale in its focused
  browser integration test.
- Hermes integration: 43 tests passing.
- Compose tests: 10 tests passing; base and Hermes Compose configurations
  validate with explicit secret-file environment values.
- Integration assets: regenerated from `shared/invite-link/SKILL.md`.
- Final independent conformance/quality and security reviews: approved with no
  remaining blocking or important findings.

No live Hermes guest acceptance was performed or claimed; it still requires an
approved disposable target and credentials.

Do not touch `.agents/ADRs/`. Do not use Agent Browser. Do not claim live native
acceptance without an approved disposable target and credentials.
