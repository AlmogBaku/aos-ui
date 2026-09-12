# Task 1 report: serial walking skeleton

## Status

Implemented the Hermes-first AOS runtime proxy walking skeleton across the public browser boundary, normalized `/api/aos/v1` REST control plane, server-side Hermes projection, and minimal Assistant UI composition. No live Hermes service was accessed.

The implementation deliberately does not add an aggregate bootstrap route, a second runtime SPI, server-issued replacement identifiers, a browser Hermes decoder/client, event replay, a browser conversation store, a workspace database, or a materialized provider cache.

## Design

### Public protocol

`packages/protocol/index.ts` defines strict Zod schemas for:

- operator authentication state;
- Hermes runtime authentication state, with `static-token` and `browser` represented distinctly;
- runtime identity/readiness and operation-specific capability objects;
- normalized Agent catalog entries;
- catalog and per-Agent revisions;
- revision-required visibility requests and confirmed responses;
- bounded public error codes.

Strict objects reject unknown native fields. Profile paths, raw `ui_meta`, native URLs, provider credentials, cookies, tokens, and upstream error text cannot validate as browser responses.

### Proxy kernel and authentication boundary

`packages/proxy/app.ts` provides a Hono application with the strict `/api/aos/v1` routes:

- `GET /healthz`
- `GET /readyz`
- `GET /auth/operator`
- `GET /auth/hermes`
- `GET /runtime`
- `GET /agents`
- `PATCH /agents/:agentId/visibility`

There is intentionally no `/bootstrap` route. Runtime/control-plane routes require an allowlisted verified operator. The visibility mutation additionally requires the configured same-origin `Origin`, JSON content type, a bounded body, a normalized visibility value, and the last observed native revision.

`operator-auth.ts` is the boundary around the OIDC session verifier: verifier failures, absent sessions, and subjects outside the configured allowlist all become `unauthenticated`. OIDC Authorization Code + PKCE mechanics remain owned by the injected verifier rather than being reimplemented in this proxy slice.

All responses carry no-store and security headers. Request logs omit paths and domain identifiers. Errors are reduced to public codes and recursively redacted before logging.

### Configuration and secrets

`config.ts` uses a strict configuration schema. It accepts only loopback listeners, absolute secret-file paths, credential-free HTTP(S) URLs, a non-empty OIDC subject allowlist, and either static-token or browser-broker Hermes auth mode. Rejected parser details are not exposed.

`secrets.ts` accepts only absolute, regular, non-symlink, owner-only files of at most 8 KiB. It strips one terminal newline and rejects empty, multiline, NUL-containing, or overly permissive secrets.

`composition.ts` loads the OIDC client secret and Hermes static token before constructing the application. Static tokens are supplied only as `X-Hermes-Session-Token` to Hermes' ws-ticket exchange. This is not presented as support for gated Hermes: browser-broker mode reports `unavailable/not-configured` until a real per-operator broker is supplied.

### Hermes server adapter

`hermes-transport.ts` performs the native sequence:

1. `POST /api/auth/ws-ticket` with server-owned credentials;
2. open `/api/ws` with `hermes-gateway-v1` and the single-use ticket subprotocol;
3. perform one bounded JSON-RPC request;
4. close the native socket and discard the ticket.

Native bodies and RPC errors collapse to generic failures.

`hermes-adapter.ts` calls `profiles.list({ include_sessions: false })`, uses the profile name as the Agent ID, and projects only the existing provider-neutral Agent contract. Visibility is editable only when Hermes supplies the `hermes-bots` revision. Updates perform:

1. authoritative profile-list read and observed-revision comparison;
2. `profiles.describe` and a second revision comparison;
3. `profiles.configure` with `ui_meta_expected_revisions` while preserving server-side `hermes-bots` metadata;
4. authoritative `profiles.list` reread and visibility confirmation.

No native metadata is cached or exposed.

### Browser composition

The new public runtime mode is `aos`. Its public configuration is only `{ "mode": "aos" }`; it accepts no provider URL. `AosRemoteClient` calls fixed same-origin `/api/aos/v1` paths and validates every response with the public schemas before adapting it to the existing `WorkspaceAdapter`. Per-Agent revisions are retained privately only long enough to issue the next CAS visibility mutation.

`composition.tsx` mounts the existing workspace with `useRemoteThreadListRuntime` and a disabled, empty `useExternalStoreRuntime` thread body. Task 1 has no Session endpoints, so no browser conversation store or speculative Session identity is introduced. When Session/run operations land, this seam is intended to use the pinned public `@ag-ui/client` `HttpAgent` and `@assistant-ui/react-ag-ui` `useAgUiRuntime`, following the existing AG-UI bundle; it must not grow a custom AG-UI decoder.

### Routing and shutdown

Vite and Nginx forward only `/api/aos/v1` to the proxy and preserve WebSocket upgrade and browser Origin headers for later scoped invalidations. Existing native development routes remain unchanged. Compose/Docker defaults expose the proxy host/port to Nginx without placing a provider URL in browser runtime configuration.

`server.ts` starts a Bun listener and provides idempotent bounded shutdown: stop accepting new work, wait for active work through `stop(false)`, then force close only after the configured grace period.

## Changed paths

- `packages/protocol/index.ts`
- `packages/protocol/protocol.test.ts`
- `packages/proxy/app.ts`
- `packages/proxy/app.test.ts`
- `packages/proxy/composition.ts`
- `packages/proxy/composition.test.ts`
- `packages/proxy/config.ts`
- `packages/proxy/config.test.ts`
- `packages/proxy/hermes-adapter.ts`
- `packages/proxy/hermes-adapter.test.ts`
- `packages/proxy/hermes-transport.ts`
- `packages/proxy/hermes-transport.test.ts`
- `packages/proxy/index.ts`
- `packages/proxy/operator-auth.ts`
- `packages/proxy/redaction.ts`
- `packages/proxy/secrets.ts`
- `packages/proxy/server.ts`
- `packages/proxy/server.test.ts`
- `src/runtime-adapters/aos/aos-client.ts`
- `src/runtime-adapters/aos/aos-client.test.ts`
- `src/runtime-adapters/aos/composition.tsx`
- `src/runtime-adapters/aos/composition.test.tsx`
- `src/runtime-adapters/aos/index.ts`
- `src/runtime-adapters/registry.tsx`
- `src/runtime-adapters/registry.test.ts`
- `shared/runtime-config.ts`
- `shared/runtime-modes.ts`
- `shared/aos-runtime-config.test.ts`
- `vite.config.ts`
- `test/vite-aos-proxy.test.ts`
- `deploy/nginx/default.conf.template`
- `Dockerfile`
- `compose.yaml`
- `compose.hermes.yaml`
- `package.json`
- `bun.lock`
- `tsconfig.proxy.json`

## TDD evidence

Every behavior group was first run against the absent or incomplete production seam and observed failing for the expected reason.

1. Protocol validation
   - RED: `bunx vitest run packages/protocol/protocol.test.ts`
   - Result: failed to resolve missing `./index`.
   - GREEN: same command.
   - Result: 1 file passed, 5 tests passed.

2. Strict config, secrets, and redaction
   - RED: `bunx vitest run packages/proxy/config.test.ts`
   - Result: failed to resolve missing `./config`.
   - GREEN: same command.
   - Result: 1 file passed, 5 tests passed.

3. Hermes Agent projection and visibility CAS
   - RED: `bunx vitest run packages/proxy/hermes-adapter.test.ts`
   - Result: failed to resolve missing `./hermes-adapter`.
   - Intermediate run: 3 passed, 1 failed because the test fixture's default parameter accidentally restored revision 7 when `undefined` was supplied. The fixture was corrected to use an explicit `null` no-revision case; production behavior was unchanged.
   - GREEN: same command.
   - Result: 1 file passed, 4 tests passed.

4. Native Hermes transport
   - RED: `bunx vitest run packages/proxy/hermes-transport.test.ts`
   - Result: failed to resolve missing `./hermes-transport`.
   - GREEN: same command.
   - Result: 1 file passed, 2 tests passed.

5. Hono public walking skeleton
   - RED: `bunx vitest run packages/proxy/app.test.ts`
   - Result: failed to resolve missing `./app`.
   - GREEN: same command.
   - Result: 1 file passed, 4 tests passed.

6. Provider-neutral browser client
   - RED: `bunx vitest run src/runtime-adapters/aos/aos-client.test.ts`
   - Result: failed to resolve missing `./aos-client`.
   - Intermediate run: 2 passed, 1 failed because the test expected the wire-only revision field in the existing `WorkspaceAdapter` result. The expectation was corrected to the existing contract while preserving revision internally.
   - GREEN: same command.
   - Result: 1 file passed, 3 tests passed.

7. Browser mode, registry, and Assistant Runtime composition
   - RED: `bunx vitest run shared/aos-runtime-config.test.ts src/runtime-adapters/aos/composition.test.tsx`
   - Result: config returned `invalid-runtime-mode`; composition import was missing.
   - Additional RED: `bunx vitest run src/runtime-adapters/registry.test.ts -t 'resolves every configured|exposes only'`
   - Result: missing `./aos` entrypoint.
   - GREEN: `bunx vitest run shared/aos-runtime-config.test.ts src/runtime-adapters/aos/composition.test.tsx src/runtime-adapters/registry.test.ts -t 'provider-neutral|resolves every configured|exposes only'`
   - Result: 3 files passed, 9 tests passed, 4 unrelated tests skipped by filter.

8. Configured composition and graceful shutdown
   - RED: `bunx vitest run packages/proxy/composition.test.ts packages/proxy/server.test.ts`
   - Result: both production modules were missing.
   - GREEN: same command.
   - Result: 2 files passed, 3 tests passed.

9. Development routing
   - RED: `bunx vitest run test/vite-aos-proxy.test.ts`
   - Result: `/api/aos/v1` proxy configuration was absent.
   - GREEN: `bunx vitest run test/vite-aos-proxy.test.ts && docker compose -f compose.yaml config --quiet && docker compose -f compose.yaml -f compose.hermes.yaml config --quiet`
   - Result: 1 test passed; both Compose configurations parsed successfully.

## Final verification

- `bunx vitest run packages/protocol packages/proxy src/runtime-adapters/aos shared/aos-runtime-config.test.ts test/vite-aos-proxy.test.ts src/runtime-adapters/registry.test.ts`
  - PASS: 12 files, 40 tests.
- `bun run typecheck`
  - PASS, including the new `tsconfig.proxy.json` project.
- `bun run lint`
  - PASS after formatting; zero errors/warnings.
- `bun run build`
  - PASS. Existing Vite native-loader, CSS highlight, dynamic-import, and chunk-size warnings remain.
- `docker compose -f compose.yaml config --quiet`
  - PASS.
- `docker compose -f compose.yaml -f compose.hermes.yaml config --quiet`
  - PASS.
- `bunx vitest run src/components/assistant-ui/elements/conversation-search.test.tsx`
  - PASS: 1 file, 2 tests.
- `bun run test` (first full run)
  - All assertions passed: 151 files passed, 1 skipped; 1,363 tests passed, 2 skipped.
  - Process exit 1 because Vitest caught two post-suite `ReferenceError: window is not defined` scheduler exceptions attributed to the unchanged `conversation-search.test.tsx`.
- `bun run test` (fresh retry)
  - All assertions passed again: 151 files passed, 1 skipped; 1,363 tests passed, 2 skipped.
  - Process exit 1 because one identical post-suite scheduler exception recurred. The attributed file passes in isolation and none of the changed modules imports it.

## Self-review

- Browser code contains no Hermes URL, schema, credential, cookie, ticket, native ID, or provider branch. The opt-in `aos` mode is provider-neutral; the legacy Hermes mode was preserved rather than broadened.
- Server code is the only place containing Hermes native paths/methods and `ui_meta` translation.
- Profile names remain Agent IDs. No replacement identifiers are generated.
- Visibility cannot be attempted without a fresh native revision and always confirms an authoritative reread.
- Missing native revisions reduce capability/editability instead of approximating a mutation.
- Static-token auth is not mislabeled as gated Hermes support. Gated/browser auth fails closed as unavailable until the dedicated broker is supplied.
- No Session/run behavior is invented in Task 1. The minimal Assistant Runtime is deliberately disabled and empty.
- No aggregate bootstrap endpoint, generic runtime SPI, cache, replay mechanism, database, or live-provider access was added.
- Remaining concern: the repository-wide Vitest command has a repeatable full-suite teardown race in the unchanged conversation-search test, although all 1,363 assertions and the isolated attributed test pass. This should be repaired separately rather than coupling unrelated UI scheduler cleanup to the proxy foundation.
