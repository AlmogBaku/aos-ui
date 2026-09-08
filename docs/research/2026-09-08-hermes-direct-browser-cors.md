# Hermes direct-browser CORS at `b29b352c`

Status: focused feasibility research. All Hermes claims below are pinned to the
checkout targeted by AOS in `integrations/hermes/README.md`, commit
`b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b`. This is a source baseline, not a
released version tag.

## Conclusion

The AOS SPA cannot use the targeted Hermes `hermes serve` deployment as an
arbitrary, credentialed cross-origin browser API through supported configuration.
Hermes does have CORS middleware, but its allowed origins are hard-coded to
`localhost` and `127.0.0.1` over HTTP(S), and it does not enable credentialed CORS.
There is no `hermes serve` CORS flag or documented dashboard CORS allowlist.

The supported browser-auth shape is same-origin: serve Hermes behind the same
browser-facing origin (optionally under a path prefix such as `/hermes`) and let an
operator-owned reverse proxy/ingress route that prefix. The reverse proxy does not
need AOS business logic, but some same-origin routing layer is required unless
Hermes gains a configurable credentialed-CORS and WebSocket-Origin contract.

## Upstream issue status

[Hermes issue #10567](https://github.com/NousResearch/hermes-agent/issues/10567)
independently reports the same limitation: `--host 0.0.0.0` changes the bind
address, but the fixed localhost CORS rule still rejects API calls from a remote
dashboard origin. As of this note, the issue remains open.

The linked implementation attempts do not change the pinned contract:

- [PR #43235](https://github.com/NousResearch/hermes-agent/pull/43235) proposed
  the complete configuration surface—bind host/port, CORS origins, and allowed
  HTTP/WebSocket hosts—but was closed without merging.
- [PR #27113](https://github.com/NousResearch/hermes-agent/pull/27113) proposed
  only an allowed-Host environment variable for trusted reverse proxies. It was
  also closed without merging and deliberately did not add the proxy hostname to
  CORS, because browsing the dashboard through that hostname is a same-origin
  deployment.
- [PR #15736](https://github.com/NousResearch/hermes-agent/pull/15736) addressed
  only non-loopback WebSocket chat clients through an `--insecure-chat` flag; it
  too was closed without merging.

Consequently, `--host` alone does not make a separately hosted AOS SPA a supported
cross-origin Hermes client. An SSH tunnel is a valid workaround when the browser
navigates to the tunneled Hermes dashboard itself, while an operator reverse proxy
can provide a remote same-origin deployment. Neither workaround supplies
credentialed cross-origin access to a distinct AOS origin.

## Evidence

- `hermes serve` and `hermes dashboard` boot the same server. Their shared runtime
  arguments include host, port, and related lifecycle options, but no CORS option.
  See the [command parser at the targeted
  commit](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/hermes_cli/subcommands/dashboard.py#L1-L45).
- The server installs `CORSMiddleware` with only a hard-coded localhost/loopback
  origin regex. It omits `allow_credentials=True`, so credentialed cross-origin
  `fetch(..., { credentials: "include" })` responses do not receive the required
  credential permission. See [`web_server.py` lines
  364–371](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/hermes_cli/web_server.py#L364-L371).
  The official guide describes the same fixed localhost scope and only notes that
  a custom Hermes server port is added automatically; it documents no arbitrary
  origin configuration. See [Web Dashboard: CORS](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/website/docs/user-guide/features/web-dashboard.md#L1146-L1155).
- Browser sessions use HttpOnly, host-only cookies with `SameSite=Lax`; HTTPS adds
  `Secure`, and a proxy prefix controls `Path`. No `Domain` attribute is set. See
  [`dashboard_auth/cookies.py` lines
  47–79](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/hermes_cli/dashboard_auth/cookies.py#L47-L79).
- After cookie login, the SPA obtains a 30-second WebSocket ticket from the
  authenticated `POST /api/auth/ws-ticket` endpoint. See [the ticket
  route](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/hermes_cli/dashboard_auth/routes.py#L427-L453)
  and [the single-use ticket
  store](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/hermes_cli/dashboard_auth/ws_tickets.py#L20-L59).
- A valid ticket is not sufficient for an arbitrary cross-origin WebSocket. Hermes
  independently checks a browser's HTTP(S) `Origin` hostname against the bound host
  or the exact hostname derived from `dashboard.public_url`; it accepts the ticket
  as a query parameter or ticket-bearing subprotocol only after that boundary.
  See [the WebSocket host/origin and authentication
  checks](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/hermes_cli/web_server_chat.py#L165-L290).
- Hermes documents `dashboard.public_url` as the canonical URL for reverse-proxy
  deployments and as the exact HTTP Host/WebSocket Origin trust declaration. It is
  not an additional SPA-origin allowlist. See [Public URL and proxy
  deployment](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/website/docs/user-guide/features/web-dashboard.md#L929-L999).

## Why Hermes Desktop over SSH works

Desktop SSH mode is not an example of an ordinary hosted SPA connecting
cross-origin. It is a native Electron client that owns both the SSH tunnel and
the privileged HTTP transport:

1. Electron main uses the system SSH client to start a Desktop-owned remote
   `hermes serve --isolated --host 127.0.0.1 --port 0`, supplies a per-spawn
   session-token file, reads the announced remote port, and creates a loopback-only
   local forward. The resulting backend URL is
   `http://127.0.0.1:<chosen-local-port>`. See [remote lifecycle spawn and
   connection](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/apps/desktop/electron/remote-lifecycle.ts#L1038-L1048),
   [local-forward setup](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/apps/desktop/electron/remote-lifecycle.ts#L1586-L1622),
   and the [loopback-only `-L` specification](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/apps/desktop/electron/ssh-connection.ts#L324-L327).
2. The React renderer does not issue REST `fetch` calls to that URL. It calls a
   narrow preload IPC API; Electron main performs HTTP using Node's `http`/`https`
   client and attaches `X-Hermes-Session-Token`. CORS is a browser enforcement
   mechanism, so it does not apply to these main-process requests. See the
   [preload bridge](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/apps/desktop/electron/preload.ts#L15-L32),
   [main-process HTTP client](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/apps/desktop/electron/main.ts#L5342-L5385),
   and [`hermes:api` IPC handler](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/apps/desktop/electron/main.ts#L16717-L16728).
3. SSH mode is explicitly kept in loopback token-auth mode, even if the user's
   public-dashboard configuration would otherwise engage the OAuth gate. Its
   WebSocket therefore uses the static session token, not cookies or a
   `ws-ticket`. Hermes accepts non-web Electron origins (`file://`, `null`,
   `app://`) after the Host check; HTTP(S) browser origins must instead match the
   bound/trusted host. See the [Desktop loopback auth exemption](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/hermes_cli/web_server.py#L1064-L1092)
   and [WebSocket Origin and credential branches](https://github.com/NousResearch/hermes-agent/blob/b29b352c9eeec261fc17b09bd5402b5a8a0c4a8b/hermes_cli/web_server_chat.py#L165-L189).

An ordinary SPA could use an SSH tunnel only if something outside the SPA creates
and keeps that tunnel alive and securely gives the SPA the session token. If the
SPA itself is served from `http://localhost:<another-port>`, Hermes' fixed CORS
regex permits that HTTP origin and token-header requests do not need credentialed
CORS; the WebSocket HTTP Origin also has a loopback hostname and the static token
branch applies. But this reproduces Desktop's privileged tunnel/token bootstrap
outside AOS, and it is local-machine-only. A hosted AOS origin such as
`https://aos.example.com` cannot reuse the user's `127.0.0.1` tunnel: the URL is
resolved on the browser user's machine, its HTTP origin is outside Hermes' CORS
allowlist, and its WebSocket Origin fails the loopback host check. Cookies and
WebSocket tickets are the separate gated/public deployment flow; Desktop SSH does
not demonstrate that flow.

## Practical boundary for AOS

- Direct browser access from an unrelated production origin is unsupported.
- A different localhost port matches Hermes' HTTP origin regex, but cookie-backed
  calls still lack `Access-Control-Allow-Credentials`; this is not a complete
  direct-connect path.
- WebSocket tickets solve browser WebSocket authentication, not cross-origin
  authorization. The HTTP ticket-mint request and the WebSocket Origin check must
  both succeed.
- AOS can stop owning the proxy only if deployment documentation makes same-origin
  ingress an operator responsibility, or if the targeted Hermes contract changes.
