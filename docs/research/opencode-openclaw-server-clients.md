# OpenCode and OpenClaw server-client research

Research date: 2026-09-14.

## Decision

Use each runtime's supported public TypeScript client inside the AOS proxy:

- OpenCode: `@opencode-ai/sdk`, pinned to the same exact OpenCode release as
  the repository's native integration.
- OpenClaw: `@openclaw/gateway-client` and
  `@openclaw/gateway-protocol`, pinned to the same exact release as the
  repository's OpenClaw integration.
- AG-UI: keep the existing `@ag-ui/core`, `@ag-ui/encoder`,
  `@ag-ui/client`, and `@assistant-ui/react-ag-ui` packages.

The provider clients stop at the server adapter boundary. The browser keeps
using only the normalized AOS REST/WebSocket protocol and AG-UI run endpoint.

There is no official OpenCode-to-AG-UI or OpenClaw-to-AG-UI adapter to adopt.
AOS therefore maps validated native events directly to the existing
`ServerRuntime` results and AG-UI events. It does not add another runtime SPI,
canonical view model, ACP bridge, or provider-specific browser path.

## OpenCode

The public MIT-licensed
[`@opencode-ai/sdk@1.18.29`](https://www.npmjs.com/package/@opencode-ai/sdk/v/1.18.29)
is generated from OpenCode's OpenAPI document. The repository already resolves
version `1.18.29` transitively through `@opencode-ai/plugin`; Phase 2 should make
that exact version a direct dependency rather than upgrading the native
integration and SDK independently.

The SDK exposes both its established client and the `v2` client. The current
`v2` Session API provides the operations that most simplify AOS:

- cursor-paginated Session catalog and message history;
- durable Session history with aggregate sequence numbers;
- replaying per-Session SSE from an `after` position;
- durable prompt admission with a caller-supplied identity;
- active-session reads, wait, and interrupt;
- scoped questions and permissions;
- Agent, model, and provider catalogs.

See the official [SDK guide](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/sdk.mdx),
[server guide](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/server.mdx),
[v2 client construction](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/v2/client.ts),
and [generated v2 Session surface](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/v2/gen/sdk.gen.ts#L3362-L4328).

OpenCode's normal server authentication is HTTP Basic using
`OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`. The SDK accepts
caller-provided headers or `fetch`, so the proxy can inject a secret-file
password without exposing it to browser configuration. See OpenCode's
[server authentication documentation](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/server.mdx#L37-L43).
That credential protects the whole server; OpenCode does not expose a native
per-Agent or per-Session guest credential. Consequently, a guest joining an
existing operator Session must be isolated by the proxy's invitation scope and
a separate adapter/listener lifecycle, while the native credential remains
server-side. A separate OpenCode instance would be a different workspace, not a
stronger credential for the same invited Session.

The established and v2 clients are two API namespaces in the same supported
package. Use v2 for durable run/history/event behavior. Use an established
endpoint only for an operation that the pinned v2 surface does not expose, and
hide that choice inside `runtimes/opencode/client.ts`.

The official [`@assistant-ui/react-opencode`](https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-opencode)
package is a useful behavior reference, especially for event conversion. It is
not an AG-UI server adapter and must not return to the browser bundle.

## OpenClaw

OpenClaw now publishes two MIT-licensed third-party-client packages:

- [`@openclaw/gateway-client@2026.9.4`](https://www.npmjs.com/package/@openclaw/gateway-client/v/2026.9.4)
  owns WebSocket request multiplexing, handshake timeouts, reconnect, event-gap
  detection, request cancellation, device authentication helpers, and scoped
  Session subscription helpers.
- [`@openclaw/gateway-protocol@2026.9.4`](https://www.npmjs.com/package/@openclaw/gateway-protocol/v/2026.9.4)
  owns protocol v4 types, TypeBox validators, frame guards, method schemas,
  capability identifiers, and structured error readers.

Pin both to `2026.9.4`, matching `integrations/openclaw`. Their declared runtime
is Node 22.19 or newer. A clean Bun probe installed both exact packages and
successfully imported `GatewayClient` and protocol version `4`; Phase 3 still
starts with an automated construction/close test before wiring native I/O.

The official [external-client guide](https://github.com/openclaw/openclaw/blob/main/docs/gateway/clients.md)
and [gateway protocol](https://github.com/openclaw/openclaw/blob/main/docs/gateway/protocol.md)
define the intended integration. The client deliberately leaves Ed25519 key
generation/signing and device-token persistence to host callbacks, which fits
the proxy's secret-file and server-owned credential boundary. Pairing and
scoped device tokens remain OpenClaw-native; no browser token is introduced.

Use the official client for its connection lifecycle and the protocol package
for runtime validation. Use its Session subscription coordinator when a scoped
subscription is required. Adopt its projection helpers only if a concrete
history/live race cannot be handled by the existing AOS authoritative-read
reconciliation; they are not a replacement AOS domain model.

OpenClaw's OpenResponses HTTP endpoint is not a substitute. It is disabled by
default, omits parts of the native workspace lifecycle, and is not AG-UI. See
the official [OpenResponses endpoint documentation](https://github.com/openclaw/openclaw/blob/main/docs/gateway/openresponses-http-api.md).

## AG-UI

The repository already pins the current public TypeScript protocol stack at
`0.0.59` (`@assistant-ui/react-ag-ui` is `0.0.58`). Keep it:

- `@ag-ui/core` supplies `RunAgentInputSchema`, message/event schemas,
  reasoning, tools, interrupts, and `CUSTOM` events.
- `@ag-ui/encoder` supplies the server SSE/protobuf encoder.
- `@ag-ui/client` supplies `HttpAgent`.
- `@assistant-ui/react-ag-ui` maps AG-UI into the existing assistant-ui UI.

The official [AG-UI TypeScript event definitions](https://github.com/ag-ui-protocol/ag-ui/blob/main/sdks/typescript/packages/core/src/events.ts),
[encoder](https://github.com/ag-ui-protocol/ag-ui/blob/main/sdks/typescript/packages/encoder/src/encoder.ts),
and [integration catalog](https://docs.ag-ui.com/integrations) confirm that no
official OpenCode or OpenClaw adapter exists. `HttpAgent` also does not own
automatic reconnect, so AOS must keep its existing normalized reconnect and
authoritative reconciliation rather than assuming SSE replay in the browser.

## Donor-code policy

The experimental `codex/aos-proxy-opencode`, `codex/aos-proxy-openclaw`, and
`codex/aos-proxy` branches are read-only behavior donors.

Worth porting selectively:

- native payload fixtures and validation cases;
- Agent/Session ownership and catalog filters;
- message, reasoning, tool, Todo, model, context, interaction, attachment, and
  artifact conversion tests;
- uncertain-send, Stop, event-gap, reconnect, device-pairing, and guest-scope
  behavior tests;
- safe rich-output fallbacks and creator receipt validation.

Do not transplant their second `runtime-contract` SPI, canonical projection
model, provider registry, generalized replay/event store, browser provider
adapters, or retired Go gateway. The current `ServerRuntime`, normalized routes,
event service, guest lane, and browser client are already the target boundary.
