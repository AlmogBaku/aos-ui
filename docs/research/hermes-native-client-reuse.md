# Hermes native client reuse

Research snapshot: NousResearch/hermes-agent `main` at
[`643b3f4`](https://github.com/NousResearch/hermes-agent/tree/643b3f450df1c6c884b2de8d0832d0af9b6ed272)
(2026-09-13), compared with the Hermes revision AOS currently documents as
verified, [`b29b352`](https://github.com/NousResearch/hermes-agent/tree/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b).

## Decision

Do **not** copy Hermes's `web/src/lib/api.ts` or browser `GatewayClient` into
the proxy. They are useful protocol references, but not safer server clients.
Keep AOS's existing normalized adapter modules and hardened transport. The
smallest useful adoption is a pinned upstream contract note, focused drift
tests, and the history-pagination correction identified by this audit.

## Evidence

- The dashboard API is a 2,727-line hand-written browser module. It reads
  `window.__HERMES_*`, uses same-origin cookies, redirects with
  `window.location.assign`, and trusts `response.json()` through TypeScript
  casts rather than runtime validation. Its error path can include the native
  response body. Those are valid dashboard assumptions, but conflict with the
  proxy's fixed upstream origin, per-principal server-side credentials,
  bounded inputs, validation, and redaction. See
  [`api.ts`](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/web/src/lib/api.ts#L8-L290).
- Session REST shapes overlap enough to use as a reference: list/detail,
  messages, delete, and rename. The current web client nevertheless hardcodes
  history to `limit=500&order=latest`; the backend's history pagination returns
  only `{limit, offset, order, returned}`—there is no history `total`. AOS must
  retain its explicit `oldest`, offset, and `include_compacted` behavior.
  Compare the
  [web wrappers](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/web/src/lib/api.ts#L380-L444),
  [web types](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/web/src/lib/api.ts#L1965-L2000),
  and the
  [authoritative route](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/hermes_cli/web_routers/sessions.py#L528-L564).
- This is not merely a theoretical difference. AOS currently substitutes the
  first page's row count when Hermes omits `pagination.total`; its remote client
  stops when `nextOffset >= total`. A current Hermes transcript longer than the
  requested 200-row page can therefore be truncated after that first page. The
  normalized response needs an "at least one more row" sentinel when a native
  page is full, and an exact terminal total once Hermes returns a short page.
- The 63-line browser `GatewayClient` is only a binding around the private
  `@hermes/shared` client and dashboard auth. The actual reusable-looking code
  is 568 lines of gateway lifecycle/replay, 393 lines of request-channel code,
  and 767 lines of event types. `@hermes/shared` is `private`, version `0.0.0`,
  and exports repository source; it is not an installable supported client
  package. See
  [`gatewayClient.ts`](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/web/src/lib/gatewayClient.ts),
  [`json-rpc-gateway.ts`](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/shared/src/json-rpc-gateway.ts),
  [`json-rpc-channel.ts`](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/shared/src/json-rpc-channel.ts),
  and its
  [`package.json`](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/shared/package.json).
- Upstream's best contract artifact is
  [`gateway-events.json`](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/shared/src/gateway-events.json),
  checked against both the TypeScript event map and Python emitters by
  [upstream tests](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/tests/tui_gateway/test_gateway_event_contract.py).
  This is substantially safer to pin than duplicating the whole dashboard
  client.
- The shared gateway owns heartbeat, request multiplexing, sequence/epoch
  replay, and live-event holdback. AOS already owns authoritative reconnect,
  uncertain-send handling, and reconciliation in `run.ts`; adopting upstream
  replay would create two owners unless it is disabled. Upstream also retains
  JSON-RPC error `message` and `data` and provides no AOS frame-depth/body-size
  policy. The local `gateway.ts` (which replaced `transport.ts`) adds those
  proxy trust-boundary controls.
- The web client still places a single-use WebSocket ticket in the URL. Current
  Hermes also supports the `hermes-gateway-ticket.*` WebSocket subprotocol; AOS
  uses neither, dialling `/api/ws?token=` with a server-held credential, so
  copying the browser connection code would remove that ownership. See the
  [browser URL construction](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/web/src/lib/gatewayClient.ts#L43-L61)
  and
  [server subprotocol handling](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/hermes_cli/web_server_chat.py#L202-L217).
- Hermes's pure native OAuth helpers are better candidates than its web auth,
  but AOS still has to own principal/lane binding, callback routing, origin
  allowlists, server-side cookie/token storage, bounds, and redaction. Reusing
  those helpers would remove little proxy-specific code. See
  [`native-oauth.ts`](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/electron/native-oauth.ts).

## Desktop app follow-up

Desktop is a better source for current Hermes **behavior**, but it is still not
a reusable proxy client package. The root project, Desktop, and
`@hermes/shared` are all `private`; Desktop links shared source with
`file:../shared`. It also pins assistant-ui 0.14, while AOS uses assistant-ui
0.15 plus the public AG-UI runtime adapter. See the
[root package](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/package.json),
[Desktop package](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/package.json),
and
[shared package](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/shared/package.json).

- The 2,702 lines of production `src/api/*` are route wrappers, not a native
  client. [`src/hermes.ts`](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/src/hermes.ts)
  is only their compatibility barrel. Their one transport seam calls
  `window.hermesDesktop.api()` and carries mutable renderer-global profile and
  connection scope; generic results are TypeScript casts, not runtime
  validation. See
  [`api/client.ts`](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/src/api/client.ts#L30-L178).
- [`api/sessions.ts`](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/src/api/sessions.ts#L392-L638)
  is useful as a behavior-test donor. Its `getAllSessionMessages` advances by
  returned rows and stops on a short page—correctly requiring no `total`—and
  the behavior is covered by
  [`hermes.test.ts`](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/src/hermes.test.ts#L587-L638).
  Its ownership stamping, connection registry, transcript cache, and legacy
  fallbacks are renderer concerns; use its route shapes and tests, not its
  implementation. `getAllSessionMessages` is an export helper, not a reason
  to eagerly load AOS history.
- Desktop's REST `ProfileInfo` omits `ui_meta` and revision fields. Its Bot
  surfaces obtain those through `profiles.list` / `profiles.configure` RPC,
  confirming that AOS still needs its existing RPC workspace path for
  revision-checked visibility. Compare the
  [REST type](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/src/types/hermes.ts#L954-L963)
  with the
  [Bot roster RPC](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/src/plugins/hermes-bots/data.ts#L642-L680).
- The 1,977-line
  [`store/gateway.ts`](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/src/store/gateway.ts)
  manages renderer-side profile socket pools, nanostores, HMR preservation,
  foreground leases, and calls to `window.hermesDesktop.getConnection*`.
  It is not portable to the server adapter boundary.
- Desktop does not map native events to AG-UI. Its event hooks first mutate a
  Hermes-specific `ChatMessage`/nanostore model and UI effects, then convert
  that model to assistant-ui `ThreadMessage`; its optimized runtime imports
  `@assistant-ui/core/internal`. Copying it would introduce the extra domain
  model and provider-specific browser path AOS is removing. See the
  [event dispatcher](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/src/app/session/hooks/use-message-stream/gateway-event/index.ts),
  [message conversion](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/src/lib/chat-runtime.ts#L379-L446),
  and
  [custom assistant-ui runtime](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/src/lib/incremental-external-store-runtime.ts).
- The server-looking implementation is embedded in Electron main and depends
  on IPC, Electron `net`/cookie partitions/`safeStorage`, browser windows,
  local process pools, and SSH routing. Its Node `fetchJson` buffers an
  unbounded response, preserves native response bodies in HTTP errors, and
  performs no schema validation. It is not safer than AOS `gateway.ts`.
  See the
  [preload bridge](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/electron/preload.ts#L15-L262)
  and
  [HTTP implementation](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/electron/main.ts#L5420-L5505).

The exact mechanically portable subset is limited to the retry predicates in
[`api-transport.ts`](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/electron/api-transport.ts),
the pure
[`native-oauth.ts`](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/electron/native-oauth.ts)
helpers, and the dependency-injected refresh/auth decision modules. Use those
and the session paging tests as behavioral references. AOS already implements
safe mutation uncertainty, PKCE, bounded validation, refresh single-flight,
and credential generations, so copying them would mostly replace working code.
One additional parity case is worth testing separately: after a native bearer
receives a structured 401, Desktop forces one refresh and retries with the
rotated bearer; it never does that for 403. AOS currently invalidates either
status, so this should be audited before claiming auth parity. See
[`oauth-rest-request.ts`](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/electron/oauth-rest-request.ts#L34-L103)
and
[`native-auth-decisions.ts`](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/apps/desktop/electron/native-auth-decisions.ts#L229-L256).

This does not change the recommended implementation estimate: the known
history correction remains 45–90 minutes. A focused 401-refresh parity audit
is another 30–60 minutes if included now. Vendoring Desktop code does not
reduce the 3–5 hour request-channel estimate; extracting it from Electron and
removing renderer/registry assumptions adds work rather than removing it.

## Exact fit with the AOS modules

| Local module                                                | Safe upstream reuse                                          | Keep local                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `transport.ts` (now `gateway.ts` plus the vendored channel) | Pinned JSON-RPC/event contract; the vendored request channel | URL/credential ownership, the `?token=` dial, bounds, validation, redaction, observation socket |
| `auth-broker.ts`                                            | At most pure PKCE/token normalization helpers                | Entire proxy flow, principal/lane binding, cookie jar, callbacks and origin policy              |
| `adapter.ts`                                                | None                                                         | AOS capabilities, ownership and normalized projection                                           |
| `history.ts`                                                | REST field names as contract fixtures                        | Ordering, compacted history, validation and AG-UI projection                                    |
| `run.ts`                                                    | Event names/payload typings                                  | Send semantics, Stop settlement, uncertainty and authoritative reconciliation                   |
| `content.ts`, `workspace.ts`, `interactions.ts`             | Native endpoint/RPC shapes as fixtures                       | Validation, authorization and normalized AOS behavior                                           |

## Minimal plan and estimate

Recommended, **45–90 minutes** (agent time):

1. Add a small `UPSTREAM.md` that pins the audited Hermes sources and keeps the
   separately tested Hermes compatibility revision explicit. No vendored
   runtime code is needed.
2. Add a failing adapter test for a full history page whose native pagination
   has `{limit, offset, order, returned}` but no `total`.
3. Correct only the normalized history total/continuation calculation, then
   cover a short final page and an exact page-size boundary.
4. Run the focused Hermes adapter and remote-client tests, then the applicable
   repository verification. Do not claim current-main live acceptance without
   a disposable target.

If actual upstream implementation code must be adopted, vendor only
`JsonRpcRequestChannel` behind the existing transport, disable its replay, and
preserve AOS bounds, ticket subprotocol, credential provider, and redaction.
That is **3–5 agent-hours**, because the private module and tests must be
trimmed, adapted to Bun's WebSocket surface, and reconciled with AOS reconnect
ownership. Copying the full API/gateway is **1–2 agent-days**, likely increases
code initially, and is not recommended.

## License and drift

Hermes is MIT licensed. Any copied substantial source must retain the upstream
copyright and permission notice required by its
[`LICENSE`](https://github.com/NousResearch/hermes-agent/blob/643b3f450df1c6c884b2de8d0832d0af9b6ed272/LICENSE).
Keep a colocated `LICENSE` and an `UPSTREAM.md` that records the exact
commit, files, and divergences.

Do not track unpinned `main`: between the currently documented AOS revision
and this snapshot, the web API grew and the shared gateway was substantially
reorganized, including a new transport-independent request channel and a much
larger typed event contract. Treat updates as explicit contract reviews, not
automatic dependency upgrades.
