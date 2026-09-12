# Task 2 report

## Scope delivered

Commit `6095fab` adds the shared normalized Session protocol and the Hermes
server adapter's bounded catalog/history projection. Catalog requests use the
required native query shape, reject duplicate or cross-profile stored IDs, and
project the stable stored identity only. History uses chronological,
compacted native query options and returns no live Session identity.

## TDD evidence

- RED: `bunx vitest run packages/protocol/protocol.test.ts` failed because
  `SessionCatalogResponseSchema` was undefined.
- GREEN: the same command passed after the protocol implementation.
- Reset: at reviewer direction, I reverted the uncommitted adapter/app/browser
  implementation that had been written before its tests. This left only the
  protocol vertical slice.
- RED: `bunx vitest run packages/proxy/hermes-adapter.test.ts` failed with
  `adapter.listSessions is not a function`.
- GREEN: the same command passed after the minimal adapter implementation.

## Verification

`bunx vitest run packages/protocol/protocol.test.ts packages/proxy/hermes-adapter.test.ts`
passed (14 tests). `bun run typecheck` was started successfully but the
combined shell invocation timed out before its completion could be captured;
the committed slice had previously typechecked before the reset.

## Design and self-review

The browser does not receive a Hermes URL or native payload from this slice.
The public identity is `hermes:${encodeURIComponent(profile)}:${encodeURIComponent(storedId)}`;
the native live `session_id` is ignored. The adapter owns all native query
formation and shape validation. Follow-on work remains required for strict
proxy routes, lifecycle/create, browser thread-list/history integration, and
moving/reusing the existing complete pure history converter server-side.
