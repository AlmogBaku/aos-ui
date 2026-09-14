# Complete Hermes V1 implementation status

Plan authority: the approved "Complete Hermes V1 — Updated Implementation
Plan" in the Codex task dated 2026-09-14.

Worktree: `/home/anakin/projects/aos-ui/.worktrees/aos-runtime-proxy-hermes`

Branch: `codex/aos-runtime-proxy-hermes`

Base: `HEAD` at worktree creation. Preserve the existing dirty changes and do
not touch `.agents/ADRs/`.

## Decisions

- One configured Hermes runtime in V1, selected through a runtime factory seam.
- Operator listener trusts network access and has no application login.
- Guest listener uses scoped invitation JWTs verified with `jose`.
- Both listeners share one `RuntimeInstance`, `SessionCoordinator`, Hermes
  adapter, attachment registry, and multiplexed native WebSocket.
- Bun serves the application and normalized API. Nginx is optional external
  infrastructure.
- New Session is browser-local until first Send. Assistant UI's public message
  queue waits for remote initialization before sending exactly once.
- A question ends an AG-UI segment with `RUN_FINISHED`; its answer starts a new
  AG-UI `runId` with `resume[]` while the same logical Hermes execution remains
  retained.
- Hermes attachments remain while running, stopping, waiting for input,
  reconciling, within reconnect grace, or actively subscribed. Terminal idle
  attachments close after five minutes; the shared socket stays open.

## Dependency map and ownership

| Order | Surface | Owner | State |
| --- | --- | --- | --- |
| 1 | Package move, config contract, `RuntimeInstance`, coordinator and fanout interfaces | integration owner | complete |
| 2 | Persistent Hermes transport and attachment retention | Hermes owner | complete |
| 2 | Browser lazy draft, queue, standard interrupts and reconnect | browser owner | complete |
| 2 | Guest authorization/projection over shared runtime | guest/security owner | complete |
| 3 | Shared run routes, Stop, recovery and interaction integration | integration owner | complete |
| 4 | Bun/Compose/docs cleanup and Go gateway removal | deployment owner | in progress |
| 5 | Stable-tree full verification and review | integration owner | pending 4 |

No two writer agents may edit the same files. Shared interface changes are
reported to and applied by the integration owner.

## Current evidence

### 2026-09-15 scoped AG-UI cleanup

- Session Todos now travel as standard `PLAN` Activity snapshots/deltas and
  restore from normalized history; the browser no longer requests Todo,
  activity, pending-interaction, or audio-availability endpoints.
- Session status now follows scoped AG-UI lifecycle events and Hermes'
  authoritative `is_active` value. Opening an active Session after a proxy
  restart discovers and reattaches its execution instead of submitting again.
- Questions and approvals restore from
  `metadata.custom.agui.interrupts`; answer and cancel use one standard
  `resume[]` run.
- Capabilities are cached per Session. Transcription and speech routes are
  invoked only by their explicit UI actions.
- Browser invalidation scopes share one `/events` WebSocket per loaded page;
  the Hermes adapter separately keeps one multiplexed native WebSocket.
- Verification: 15 focused files / 246 tests passed; the final affected rerun
  passed 13 files / 221 tests. `bun run typecheck`, `bun run lint`, and
  `bun run build` pass. The build retains pre-existing CSS pseudo-element and
  chunk-size warnings.

- Existing isolated worktree verified on the expected branch.
- The current Hermes transport, adapter, run, and interaction focused suites
  pass before the V1 replacement.
- A combined focused suite exposed an existing intermittent browser integration
  failure (`Entry not available in the store`) even though the same test passes
  alone. The browser integration rewrite must make this deterministic.
- Current gaps confirmed: request-owned Hermes sockets, no attachment idle
  lifecycle, split operator/guest runtimes, OIDC/browser-broker configuration,
  eager Session creation, one-consumer run streams, custom interaction response
  route, and one-shot browser SSE reconnect.

## Checkpoints

- [x] Shared contracts and package structure frozen; synthetic operator and
      guest observe one coordinator run.
- [x] One Hermes socket multiplexes concurrent RPC and retained Sessions.
- [x] Browser first Send initializes a local draft and streams the final answer.
- [x] Stop, reload, reconnect, questions, approvals, and uncertainty pass in focused tests.
- [x] Guest isolation, limits, and content parity pass in focused tests.
- [ ] Deployment cleanup and stable-tree gates pass.
- [ ] Full verification and final conformance/quality/security review pass.

Update this file after each checkpoint with the last stable verification
commands and any remaining blockers.
