# Building an MCP App for AOS

AOS renders [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (spec
2026-01-26): a tool whose `_meta.ui.resourceUri` names a `ui://` resource with
MIME type `text/html;profile=mcp-app` shows that HTML as an interactive view
in the message, followed by the call's compact "Used" row with its textual
details. AOS's own charts, maps, and stats are such Apps: the `aos-ui` server's
`render_chart`, `render_map`, and `render_stats` declare
`ui://aos-ui/chart`, `ui://aos-ui/map`, and `ui://aos-ui/stats`. This page
lists what AOS offers an App view and what it refuses.

## Register the server

AOS has no server registry. Register the MCP server in the runtime's own
configuration, and AOS renders the views of every Agent that can call it:

- [Hermes](runtimes/hermes.md#mcp-apps): a Streamable HTTP server in the
  profile's `mcp_servers`.
- [OpenClaw](runtimes/openclaw.md#mcp-apps): `openclaw mcp add`, with
  `mcp.apps.enabled: true` on the Gateway.
- [OpenCode](runtimes/opencode.md#mcp-apps): a `remote` entry in the `mcp`
  configuration.

On Hermes and OpenCode the proxy reads the view itself, so it must reach the
server over HTTP at the URL the runtime reports, or at the URL configured for
it under [`mcpApps.fallback`](configuration.md#mcp-apps-fallback); that
includes `aos-ui`. A server that needs credentials renders only once its headers are configured
under [`mcpApps.fallback`](configuration.md#mcp-apps-fallback).

## Sandbox

The view runs inside a double iframe. The outer frame is a static page,
`/mcp-app-sandbox.html`, loaded sandboxed with an opaque origin and holding only
a message relay; the inner frame holds the view. Both proxy listeners, and Vite
in development, serve that page with its own CSP header: the widest set of
sources any view may be granted, framable only by the same origin. The view's
own CSP, below, is injected into its document and narrows that ceiling. A
reverse proxy in front of AOS must pass the page's headers through unchanged
and must not add a CSP or `X-Frame-Options` of its own to it. Requests the
view makes carry `Origin: null`, so an App server must not rely on an origin
check. This departs from the spec, which gives the outer frame
`allow-same-origin` on a dedicated sandbox origin: AOS serves no separate
origin, so it keeps the outer frame opaque instead, and a view cannot use cookies
or web storage. The frame may not navigate the workspace, open pop-ups, or submit forms.

AOS builds the view's CSP from its declared `_meta.ui.csp`:

| Field             | Accepted                                                                              |
| ----------------- | ------------------------------------------------------------------------------------- |
| `resourceDomains` | `https://host` or `https://*.host`; allowed for scripts, styles, images, fonts, media |
| `connectDomains`  | `https://` or `wss://` hosts; `http://` or `ws://` only for loopback                  |
| `frameDomains`    | `https://host` or `https://*.host`                                                    |
| `baseUriDomains`  | `https://host` or `https://*.host`                                                    |

Anything else is dropped, and an empty list means none. Inline scripts and
styles are allowed; `object-src` and `form-action` are `'none'`. Web workers
may start from the view's own `blob:` URLs, as a WebGL map library's do. Any
origin may carry a port; loopback means `127.0.0.1`, `localhost`, or `*.localhost` on the
viewer's own machine. CSP cannot name an IPv6 literal, so `[::1]` is refused. Declared `_meta.ui.permissions`
(camera, microphone, geolocation, clipboard write) become the frame's `allow`
attribute.

## Host requests

| Request                   | Behavior                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `tools/call`              | Calls an app-visible tool on the view's own server; a tool with no `visibility` is visible |
| `resources/read`          | Reads a `ui://` resource on the view's own server                                          |
| `ui/open-link`            | Opens an `https` URL in a new tab                                                          |
| `ui/message`              | Sends a user text message into the same conversation; other content is refused             |
| `ui/request-display-mode` | Grants `inline` or `fullscreen` if the view declared it; otherwise keeps the current mode  |
| `ui/update-model-context` | Refused                                                                                    |

Every request goes through the proxy, scoped to the tool call's own Session.
The browser never talks to the MCP server.

## Limits

- The view's HTML is at most 2 MiB.
- A request body is at most 256 KiB.
- A view may make about 10 requests per second; excess requests fail.

## Presentation

Where the proxy reads the view itself (Hermes, OpenCode), it knows from the
server's `tools/list` which tools declare one, so the card draws as soon as
the call starts. The view receives the call's input once the arguments are
complete and its result once the call settles; it never receives partial
input. A call that fails without a result, or is still open when its turn
ends, reaches the view as cancelled instead. On OpenClaw the card draws once the Gateway reports the view with the
result. Inline, it
grows with its content up to 80% of the viewport height; fullscreen covers the
viewport, and the host shows an **Exit full screen** control. Esc exits
fullscreen only while focus is outside the view, because the view receives its
own key presses; the control is always available.

The host context carries the theme (`light` or `dark`), the locale (`en-US`
or `he-IL`), and the workspace's colors and font as the spec's style
variables, plus the time zone, the tool call, pointer and hover support, and
safe-area insets in fullscreen. A view's log messages go only to the browser
console. AOS sets `lang` and `dir` on the view's root element unless the
view sets its own, so a view can follow Hebrew right-to-left layout.

## Guests

An invited guest sees an App card in the invited Session, with no other tool
calls. The view still receives the call's input and result, so expose to a
guest-facing Agent only App servers whose views are fit for a guest. See
[Share an invited conversation](invite-chat.md#runtime-behavior).
