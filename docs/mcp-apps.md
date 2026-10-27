# Building an MCP App for AOS

AOS renders [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (spec
2026-01-26): a tool whose `_meta.ui.resourceUri` names a `ui://` resource with
MIME type `text/html;profile=mcp-app` shows that HTML as an interactive view
in the message, followed by the call's compact "Used" row with its textual
details. AOS's own charts, maps, stats, and Artifacts are such Apps: the
`aos-ui` server's `render_chart`, `render_map`, `render_stats`, and
`present_artifact` declare `ui://aos-ui/chart`, `ui://aos-ui/map`,
`ui://aos-ui/stats`, and `ui://aos-ui/artifact`. This page lists what AOS
offers an App view and what it refuses.

## Register the server

AOS has no server registry. Register the MCP server in the runtime's own
configuration, and AOS renders the views of every Agent that can call it:

- [Hermes](runtimes/hermes.md#mcp-apps): a Streamable HTTP server in the
  profile's `mcp_servers`.
- [OpenClaw](runtimes/openclaw.md#mcp-apps): `openclaw mcp add`, with
  `mcp.apps.enabled: true` on the Gateway.
- [OpenCode](runtimes/opencode.md#mcp-apps): a `remote` entry in the `mcp`
  configuration.

On Hermes and OpenCode the [harness-gw](https://github.com/AlmogBaku/harness-gw)
gateway reads the view itself, so it must reach the server over HTTP at the URL
the runtime reports, or at the URL configured for it under the gateway's
`mcpApps.fallback`; that includes `aos-ui`. A server that needs credentials
renders only once its headers are configured there. harness-gw's runtime
guides document the fallback.

## Sandbox

The view runs inside a double iframe. The outer frame (`sandbox="allow-scripts
allow-same-origin"`) loads a static relay page, `/mcp-app-sandbox.html`, from
the deployment's one sandbox origin, `AOS_UI_MCP_APP_SANDBOX_ORIGIN`, such as
`https://mcp-apps.example.com`, which both lanes' views load from and which
differs from every lane's origin, as the spec requires; see
[MCP App sandbox origins](deployment.md#mcp-app-sandbox-origins). The inner
frame holds the view itself. Because the outer frame has `allow-same-origin`,
the view runs on the sandbox origin and can use cookies and web storage.

**Per-view policy.** The aos-ui web server serves `/mcp-app-sandbox.html` with
a Content Security Policy built for the particular view the query names:

- `frame-ancestors` lists every origin in `AOS_UI_PUBLIC_ORIGIN`, the origins
  people open AOS UI at, operator and guest alike, so only the lanes' own
  pages may frame the sandbox page. Any other page that tries to embed it is
  refused by the browser.
- The view's declared domains (`_meta.ui.csp`) travel in the sandbox page's
  query; the server rebuilds the policy from them and sends it with `no-store`.
  Every value is validated before it is written.

Caddy, and any reverse proxy in front of it, must pass the page's headers
through unchanged and must not add a CSP or `X-Frame-Options` of its own.

**Requests** the view makes carry the sandbox origin; that identifies the
deployment, not the lane, the App, or its server. An App server that checks the
request origin sees the sandbox address, not the calling Agent or tool.

**Shared storage.** All views share the one sandbox origin — the spec's
default. In one browser profile their stored data persists across Agents,
Sessions, App servers, and lanes: one view can read another's storage, and,
on the same workspace page, read its page and act as it — call its server's
tools and use its delegated permissions such as clipboard write. With a second
view on the page, a hostile App can reload a neighbouring sandbox page with a
query it chose and run code there under the policy it picked; the per-view
policy binds a view acting alone. Per-App origins (a non-goal) would close
these paths. Across lanes, sharing is the storage within one browser profile —
an operator and a guest each use their own browser, and views on different
pages cannot script each other — plus the lanes' origins the sandbox page
publishes.

**Published origins.** The sandbox page's header lists every lane's origins in
its `frame-ancestors` to whoever requests the page, so keep the operator
lane's origins to names you are fine publishing. Each surface's
`/runtime-config.json` carries the same list as `publicOrigins`, from which
the workspace reports the domains a view's policy applies. With the
sandbox reachable only through a public route, the operator's own views load
it over that route too, and stop showing while it is down.

**Lane restriction.** The workspace loads views only when its own origin is in
the `publicOrigins` list and differs from the sandbox origin. A workspace
opened at an address not in that list, or opened at the sandbox origin itself,
shows views as unavailable and names `AOS_UI_PUBLIC_ORIGIN`.

The view frame may not navigate the workspace, open pop-ups, or submit forms.

### Stable origins (optional) {#stable-origins}

An App can declare `_meta.ui.domain` to request an origin of its own, separate
from the shared sandbox. AOS honors it only when `AOS_UI_MCP_APP_STABLE_ORIGINS`
is set, such as `https://*.mcp-apps.example.com` right below a sandbox at
`https://mcp-apps.example.com`; with it unset every view loads from the shared
sandbox and no configuration is required for a new installation. Two protocol
fixes apply regardless of that setting: `_meta.ui` is taken from the
`resources/list` entry when the `resources/read` content item declares none,
and a file the gateway delivers by a native path carries a `fileId` that
matches `present_artifact`'s for the same path.

**Format.** A domain AOS accepts is `<32 hex digits>.<the wildcard's domain>`,
where the 32-digit prefix is the first 32 hex digits of a SHA-256 of the MCP
server URL the gateway dials, computed by `mcpAppStableOriginKey` from
`@harness-gw/sdk/node`. The gateway hashes the URL in its canonical form — the
WHATWG URL serialization with no trailing slash — so
`https://Example.com:443/mcp/` and `https://example.com/mcp` give the same key.
A server declares its own `domain` by computing the key from the same URL the
gateway dials it at; if that URL differs from what the server computed the key
from, the gateway drops the domain and opens the view on the shared sandbox.
Claude's ext-apps documentation published this format.

**Gateway check.** On every view path — tool-call views and published-Artifact
views alike — the gateway verifies that the domain's first label equals the key
for the URL it dialed. A domain that passes the check is forwarded to the
browser; one that fails is dropped and logged as `mcp_app.domain.dropped` with
the server name and a `reason`: `"mismatch"` when the first label is a valid
host-name part but does not equal the expected key, or `"malformed"` when the
declared value is not a valid lowercase host name at all. The log carries no URL.
Coverage is Hermes and OpenCode; OpenClaw's native App views and stdio servers
carry no domain.

**Browser.** A view whose `domain` is exactly one 32-hex-digit label directly
below the configured wildcard's domain loads from that host, with the
wildcard's scheme and port. Every other view loads from the shared sandbox.
Lane pages' `frame-src` adds the wildcard when it is set.

**Artifact view storage.** The `present_artifact` view keeps each Agent HTML
file's `localStorage` per file across preview sessions when it runs on its
stable origin: values are keyed by `fileId`, injected before the file's scripts
run, and updated through a message the file's own frame sends on each write.
Each file's share is capped at 64 Ki characters of the file's saved JSON; a
quota error fails only that file's write and changes nothing else. Off the
stable host — on the shared sandbox, or when no `fileId` is in the result — the
in-memory storage has no limit. `sessionStorage` always lives in memory for the
life of the preview. Values from one file are separate from another's; a message
from any other frame is ignored.

**Risks.** Browsers partition storage by top-level site, and Safari may clear
it. Whatever HTML later sits at a given file path — by any Agent — can read
what was saved there. `MEDIA:` results now carry a truncated path hash to the
browser and to guests, as `present_artifact` results already do; a holder can
check a guessed path. A bug in the artifact view's renderers costs more on the
artifact origin, which holds every saved file. Turning stable origins on moves
the artifact view to the new origin; nothing stored before carries over.

See [Stable origins](deployment.md#stable-origins-optional) for DNS,
certificate, Compose settings, and proxy rules.

### Security policy and Agent HTML {#security-policy}

AOS builds the view's CSP from its declared `_meta.ui.csp`:

| Field             | Accepted                                                                              |
| ----------------- | ------------------------------------------------------------------------------------- |
| `resourceDomains` | `https://host` or `https://*.host`; allowed for scripts, styles, images, fonts, media |
| `connectDomains`  | `https://` or `wss://` hosts; `http://` or `ws://` only for loopback                  |
| `frameDomains`    | `https://host` or `https://*.host`                                                    |
| `baseUriDomains`  | `https://host` or `https://*.host`                                                    |

Anything else is dropped, and an empty list means none. Declared domains whose
host and port match any lane's origin or the sandbox origin are also dropped
from the built policy (a wildcard that covers them is kept). Inline scripts and
styles are allowed, and scripts may compile WebAssembly (`'wasm-unsafe-eval'`),
as a document renderer's decoders do; `object-src` and `form-action` are
`'none'`. Web workers may start from the view's own `blob:` URLs, as a WebGL
map library's do. Any
origin may carry a port; loopback means `127.0.0.1`, `localhost`, or `*.localhost` on the
viewer's own machine. CSP cannot name an IPv6 literal, so `[::1]` is refused. Declared `_meta.ui.permissions`
(camera, microphone, geolocation, clipboard write) become the frame's `allow`
attribute.

A frame a view opens from `srcdoc` inherits the view's CSP. The `artifact`
view shows Agent-written HTML that way, in a frame sandboxed with
`allow-scripts` and never `allow-same-origin`, so the file's inline scripts run
in an opaque origin of their own that cannot reach the view or the page
directly. The view also injects a policy into that document allowing only inline
scripts and styles, `data:` fonts, and `data:` and `blob:` images and media,
with `connect-src` and `frame-src` set to `'none'`. Its one exception is the
public CDNs `AGENT_HTML_DOMAINS` names: Google Fonts (`fonts.googleapis.com`,
`fonts.gstatic.com`) and Tailwind's Play CDN (`cdn.tailwindcss.com`), from
which the document may load scripts, styles, and fonts. The view declares the
same hosts as its `resourceDomains`, since the inherited view CSP would
otherwise refuse them. Only their owners publish to these hosts and no one else
reads who asked, so a page that loads from them signals nothing; a host anyone
may publish to, such as an npm mirror, stays out. Because the inherited view CSP
grants images and media `data:` only, `blob:` images stay blank.

The `artifact` view draws a Word `.docx` the same way, in a Word frame
sandboxed with `allow-scripts` alone, under a stricter policy that names no
host: its scripts must carry a nonce the view draws fresh for each frame, so
only the frame's own three run (the zoom script, the link stand-ins, and the
docx-preview renderer, read from the server's `ui://aos-ui/office/` folder),
and neither an inline handler, a `javascript:` link, nor any script a document
carries does. Styles stay inline, and pictures and fonts arrive as `data:`
addresses; `connect-src` and `frame-src` are `'none'`. The renderer never
draws a document's embedded HTML part. The view posts the file's bytes into
the frame once, as it first loads, and `https:` link clicks are relayed as
Agent HTML's are. Any other link but one to a place in the document does
nothing, so the frame never leaves the document for a page its policy refuses.

Even though the Agent HTML frame is opaque, it has two capabilities:

- **Storage.** `localStorage` is kept per file on the artifact view's stable
  origin, in memory elsewhere (see [Stable origins (optional)](#stable-origins)
  for the cap and persistence rules). `sessionStorage` is always in memory for
  the life of the preview. Property-style access (`localStorage.foo`) is not
  supported; use `getItem` and `setItem`.
- **Link relay.** A click on an `https:` link that the page did not prevent, or
  a `window.open` call with an `https:` address, is relayed to the workspace as
  a `ui/open-link` request. The workspace opens the URL in a new tab under the
  same rules it applies to any other link (`https` only, `noopener noreferrer`,
  rate-limited). `javascript:`, `data:`, and `http:` addresses are refused. An
  Agent HTML page can therefore open an https address it chose on a click,
  carrying whatever it stored, so treat Agent-written HTML with the same trust
  you would give any tool-produced content.

## Host requests

| Request                   | Behavior                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `tools/call`              | Calls an app-visible tool on the view's own server; a tool with no `visibility` is visible        |
| `resources/read`          | Reads a `ui://` resource on the view's own server, or reads one of the view's own file addresses through that server |
| `ui/open-link`            | Opens an `https` URL, or one of the view's own files, in a new tab                                |
| `ui/download-file`        | Saves one of the view's own files; offered only to a view given files                             |
| `ui/message`              | Sends a user text message into the same conversation; other content is refused                    |
| `ui/request-display-mode` | Grants `inline`, `fullscreen`, or `pip` if the view declared it; otherwise keeps the current mode |
| `ui/update-model-context` | Refused                                                                                           |

Every request goes through the gateway, scoped to the tool call's own Session.
The browser never talks to the MCP server. The page may answer a repeated
`resources/read` for the same Agent, server, and URI from an earlier read, so
a server that changes a resource gives it a new URI.

A view given [files](#files) finds their addresses in its host context under
`aos/files`, by argument, each made absolute:

```json
{
  "aos/files": {
    "path": "https://aos.example.test/api/v1/agents/…/tool-calls/call-1/app/files/path?pass=…"
  }
}
```

The host renews the passes while the view is mounted: at half their life,
when the page wakes or comes back online past that point, and when the
workspace's connection recovers. A failed renewal retries with backoff until
the gateway refuses it. The fresh addresses arrive as a host-context change, so
a view reads a file with `readServerResource` on the address it received last.

A result that carries a `fileId` beside its `filename`, as `present_artifact`'s
does with a digest of the file's path, identifies the file across calls. The
host context then also carries `aos/filesRevision`, an opaque token that changes
once a later call shows the same file again, and the `present_artifact` view
re-reads the file on the change, in its message, in the side panel, and in
full screen alike. The inspector's Outputs list names such a file once, at its
latest call. `ui/open-link` and
`ui/download-file` recognize the view's own file by its address, whatever
pass it carries, and use a fresh one. An own file opens over `http` too when
the workspace itself is served over `http`. A download names the file by a
`resource_link` and saves it under the link's `name`, without any directory or
reserved character; another address, or content the view embeds, is refused.

## Limits

- The view's HTML is at most 2 MiB.
- A request body is at most 256 KiB.
- A view may make about 10 requests per second, links and downloads
  included; excess requests fail.

## Files

A view can show the files its tool call names, as `present_artifact`'s view
shows the file it presents, without ever seeing a path. Each top-level
argument that holds an absolute, normalized path names a file. Opening any
view withholds from its `toolInput` every top-level argument whose value
starts with `/`, a file or not; a view that needs such a value reads it from
its own result. For a call from one of
the gateway's [`mcpApps.files.servers`](configuration.md#mcp-app-files), the view gets
`files` in their place, with one address per argument that names a file:

```json
{
  "addresses": {
    "path": "/api/v1/agents/…/tool-calls/call-1/app/files/path?pass=…"
  },
  "expiresAt": "2026-01-01T12:10:00.000Z"
}
```

- An address reads `GET …/tool-calls/:toolCallId/app/files/:argument`, under
  `/api/v1` on both the operator and guest listeners; which listener answers,
  never the path, decides whose request it is. The gateway takes the path from the runtime's own record of the
  call, never from the request, and judges it by the configured folders on
  every request.
- An address carries a pass for that one call and listener, valid for at most
  ten minutes and never past a guest's invitation. A request with a pass is
  judged by the pass alone; one without a pass needs the listener's own
  login, which for a guest is the invitation.
- `POST …/tool-calls/:toolCallId/app/files` answers fresh addresses in the
  same shape. It checks `Origin` against the listener's `allowedOrigins`, and
  the listener's login, as a view's other requests do.
- A call that names no file gets no `files`; one the listener may not read
  gets `files` with no addresses.
- The address's origin must be listed in `AOS_UI_PUBLIC_ORIGIN`; the
  tools server checks this before reading.

A file answer:

- A bad pass or login answers 401. A path the folders refuse as written
  answers an empty 403, which the artifact view shows as not allowed. Every
  other refusal, a missing file, and a Session that is gone answer the same
  empty 404, so nothing the file system decides tells them apart. The log
  records only a reason code, never a path or a pass. A runtime that does not
  answer, or fails, answers 503.
- One byte range answers 206 with `Content-Range`, and a range past the end
  answers 416. Of the runtime's headers, only `Content-Length`,
  `Content-Range`, and `Accept-Ranges` pass through.
- PDFs and AVIF, BMP, GIF, JPEG, PNG, and WebP images keep their type. Other
  text, HTML included, goes out as `text/plain` with its charset, and
  anything else, SVG and XML included, as `application/octet-stream`. A file
  opens `inline` under its own sanitized name.
- Every answer carries `nosniff`, `Referrer-Policy: no-referrer`, and
  `Cache-Control: no-store`. Every answer but a PDF's also carries this
  policy, so no file runs as a page:
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox`.
- An admitted pass's answer carries `Access-Control-Allow-Origin: *`; no
  answer allows credentials.
- File reads and renewals have their own limit of about 50 requests per second
  per call, apart from the view's 10; excess requests answer 429.

### Published attachments

A file an Agent publishes as an attachment opens in the
[configured viewer](configuration.md#mcp-app-files), with no tool call. Its
routes sit beside a call's, under the same roots, at
`…/sessions/:sessionId/artifacts/:artifactId/app`:

- `GET …/app` opens the view: the viewer's resource, an empty `toolInput`,
  and a `toolResult` carrying the attachment's name and type as the gateway
  reads them from the runtime, never its path. `files` holds one address,
  `path`, for its bytes.
- That `toolResult` is the whole contract a configured viewer reads:
  `structuredContent.value` is `{ "filename": string, "mimeType"?: string }`,
  and the text content ends with the same JSON after `Structured fallback:`
  for a view that reads text alone. No other field is promised.
- `POST …/app/resources/read` reads a `ui://` resource of the viewer's server,
  or one of the view's own file addresses through that server; any other URI
  answers 403. There is no `tools/call`; it answers 404.
- `POST …/app/files` renews the address, and `GET …/app/files/path` reads the
  bytes under a pass that names the attachment, so a call's pass never opens
  an attachment, nor the other way round. Reads follow the rules above, but
  no folder applies and a range is ignored.
- An attachment the Session lacks, or that the provider has pruned, answers
  404, as its content route does. One that is there with no viewer to open
  it in answers 503: a runtime that cannot read a server's resource without
  a call (OpenClaw), or a viewer server out of reach.
- A guest opens only the invited Session's attachments, by its invitation,
  and sees the name and type the guest content route would.

## Presentation

Where the gateway reads the view itself (Hermes, OpenCode), it knows from the
server's `tools/list` which tools declare one, so the card draws as soon as
the call starts. The view receives the call's input once the arguments are
complete and its result once the call settles; it never receives partial
input. A call that fails without a result, or is still open when its turn
ends, reaches the view as cancelled instead. On OpenClaw the card draws once the Gateway reports the view with the
result. Inline, it
grows with its content up to 80% of the viewport height. Fullscreen covers the
viewport in place, under the side panel's header: the view's name (the file it
shows, when its result names one), the file's type, and an **Exit full screen**
control, which takes focus. The host keeps the header and the view clear of the
device's edges itself. Esc exits fullscreen only while focus is outside the
view, because the view receives its own key presses; the control is always
available. Fullscreen returns the view to where it was, its message or the side
panel.

`pip` shows the view in the side panel: in the inspector's place on a wide
screen and in a drawer on a narrow one. The panel holds one view at a time. The
view's frame reloads whenever it moves, so a view that keeps state restores it
from its input, its result, or its own server. Its message shows **Shown in the
side panel** with a **Return to the message** control; the panel's own control,
Esc while focus is in the panel but outside the view, a request for `inline`,
and leaving the Session return it too.

The host context carries the theme (`light` or `dark`), the locale (`en-US`
or `he-IL`), and the workspace's colors and font as the spec's style
variables, plus the time zone, the tool call, pointer and hover support,
zero safe-area insets, since the host keeps every view clear of the device's
edges, a view's file addresses as `aos/files`, and the shown file's revision as
`aos/filesRevision` when its tool identifies the file.
A view's log messages go only to the browser console. AOS sets `lang` and
`dir` on the view's root element unless the view sets its own, so a view can
follow Hebrew right-to-left layout.

## Guests

An invited guest sees an App card in the invited Session, with no other tool
calls. The view still receives the call's input and result, so expose to a
guest-facing Agent only App servers whose views are fit for a guest. See
[Share an invited conversation](invite-chat.md#runtime-behavior).
