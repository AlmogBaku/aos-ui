# Minimal Hermes Dashboard Client Extraction

> Historical, completed 2026-09.

## Goal

Extract the Hermes dashboard HTTP calls already used by the server adapter into
one small typed client, then align history pagination with current Hermes
Desktop behavior. Keep the existing runtime, authentication, RPC/WebSocket,
AG-UI, guest, and reconnect architecture unchanged.

Research and permanent upstream links are in
[`docs/research/hermes-native-client-reuse.md`](../../research/hermes-native-client-reuse.md)
and [`packages/proxy/runtimes/hermes/UPSTREAM.md`](../../../packages/proxy/runtimes/hermes/UPSTREAM.md).

## Scope

The client wraps only the dashboard HTTP operations AOS already performs:

- list, read, update, and delete Sessions;
- read paginated Session messages;
- read artifact data URLs;
- read STT/TTS configuration;
- transcribe audio and synthesize speech.

`HermesServerAdapter` constructs the client from the existing optional
`transport.http` function. The public adapter constructor and
`HermesRpcTransport` remain unchanged. Existing adapter/content validation is
authoritative; the client only constructs native requests and returns native
TypeScript response shapes.

## History pagination contract

For a native page with pagination, validate `limit`, `offset`, and `returned`
as safe integers, bind them to the request and returned message count, and
reject invalid totals. Preserve a valid native total. When Hermes omits total,
use `nextOffset + 1` after a full page so the normalized remote client requests
the next page; a short or empty page terminates at `nextOffset`. Legacy pages
without pagination terminate at `requestedOffset + messages.length`. Reject
unsafe derived offsets.

## Implementation map

| File                       | Responsibility                                                         |
| -------------------------- | ---------------------------------------------------------------------- |
| `dashboard-client.ts`      | Native dashboard route/query/body construction only                    |
| `dashboard-client.test.ts` | Exact request contract tests                                           |
| `adapter.ts`               | Ownership, validation, normalized projection, pagination normalization |
| `adapter.test.ts`          | Behavior and malformed-pagination coverage                             |
| `UPSTREAM.md`              | Pinned provenance and drift references                                 |

The browser remote runtime, normalized AOS protocol, Hermes RPC transport,
authentication broker, guest projection, run engine, and deployment wiring are
dependencies but are not modified by this extraction.

## Status

- [x] Add the focused dashboard client contract tests.
- [x] Implement and wire the dashboard client without changing adapter APIs.
- [x] Add pagination continuation, terminal, legacy, malformed, and safe-integer tests.
- [x] Implement pagination normalization at the adapter boundary.
- [x] Add pinned upstream provenance.
- [x] Focused Hermes adapter/client and remote-client tests pass.
- [x] Typecheck passes.
- [x] Full unit, lint, build, E2E, Hermes integration, and diff verification.

## Separate follow-up findings

The upstream parity audit also identified existing adapter behaviors outside
this extraction: compressed-session history can return a resolved descendant
ID, raw workspace history currently reads one 500-row page, and pinned Session
back-fill can exceed a requested catalog page. They should be handled as
focused behavior fixes rather than expanding this client extraction.

## Verification

```bash
bunx vitest run packages/proxy/runtimes/hermes/dashboard-client.test.ts \
  packages/proxy/runtimes/hermes/adapter.test.ts \
  src/runtime-adapters/aos/aos-client.test.ts
bun run test
bun run typecheck
bun run lint
bun run build
bun run test:e2e
bun run hermes:test
git diff --check
```

This is local/mock verification only. Live Hermes acceptance requires an
explicitly approved disposable target and credentials.
