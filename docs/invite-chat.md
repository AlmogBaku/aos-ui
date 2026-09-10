# Same-origin helper and invited chat

`aos-gateway` is an optional Go helper for two deployment shapes that the
static frontend cannot provide alone:

- an operator UI whose native Hermes or OpenCode traffic is forwarded through
  the UI origin, avoiding browser CORS differences; and
- a restricted guest chat reached through an expiring invitation link.

The helper is not a runtime. Hermes or OpenCode still owns Agents, Sessions,
messages, credentials, tools, and persistence. The helper has no database and
selects exactly one native runtime at startup.

## Build and configure

Build the existing frontend and the helper:

```bash
bun run build
go build -C gateway -o ../aos-gateway ./cmd/aos-gateway
```

The executable uses Cobra and documents its complete operator surface. This is
also the preferred discovery path for an automation Agent; help is read-only
and does not inspect configuration or start listeners:

```bash
./aos-gateway --help
./aos-gateway help serve
./aos-gateway help invite
```

Create a random 32-byte base64url encryption key and store it outside the
repository. The same key is used to create and redeem invitations. Rotating it
invalidates every outstanding invitation.

Set these variables before either `serve` or `invite`:

```bash
export AOS_GATEWAY_INVITE_KEY='<base64url-encoded 32-byte key>'
export AOS_GATEWAY_GUEST_ORIGIN='https://guest.example.com'
```

Common server configuration:

| Variable | Meaning | Default |
|---|---|---|
| `AOS_GATEWAY_RUNTIME` | `hermes` or `opencode` | required |
| `AOS_GATEWAY_UPSTREAM` | fixed native HTTP origin | required |
| `AOS_GATEWAY_DIST` | frontend build directory | `dist` |
| `AOS_GATEWAY_OPERATOR_ADDR` | operator listener | `127.0.0.1:8080` |
| `AOS_GATEWAY_GUEST_ADDR` | guest listener | `127.0.0.1:8081` |

Hermes additionally requires `AOS_GATEWAY_HERMES_TOKEN`. OpenCode requires
`AOS_GATEWAY_OPENCODE_DIRECTORY`; set
`AOS_GATEWAY_OPENCODE_USERNAME` and `AOS_GATEWAY_OPENCODE_PASSWORD` when the
native server uses Basic authentication.

```bash
AOS_GATEWAY_RUNTIME=hermes \
AOS_GATEWAY_UPSTREAM=http://127.0.0.1:9119 \
AOS_GATEWAY_HERMES_TOKEN="$HERMES_SESSION_TOKEN" \
./aos-gateway serve
```

The operator listener serves the regular UI and only forwards the selected
native prefix (`/hermes` or `/opencode`). Native operator authentication remains
in force. The guest listener never exposes that forwarding route or operator
APIs.

Terminate public HTTPS at an existing reverse proxy and forward only the guest
origin to the guest listener. TLS provisioning and SSH tunnel management are
outside this helper. An SSH tunnel may be used for the fixed native upstream.

## Create an invitation

Use the local CLI; there is no HTTP minting endpoint:

```bash
./aos-gateway invite \
  --agent interviewer \
  --ref dan-2026 \
  --expires-in 24h \
  --prefill 'Hey, Almog sent me here!' \
  --instruction-file /secure/path/dan-instructions.txt \
  --name 'Almog' \
  --title 'Interview' \
  --message 'Thanks for taking the time to speak with us.' \
  --lang en
```

Run `./aos-gateway invite --help` for every optional branding and first-turn
field. Missing or invalid arguments produce a concise error and point back to
that command-specific help.

The command prints `https://guest.example.com/#invite=<JWE>`. The browser
removes the fragment immediately, redeems the token, and keeps it in a Secure,
HttpOnly, host-only, SameSite=Strict cookie. The encrypted token remains a
bearer credential; anyone with the link has its access until expiration.

To audit an invitation locally, save its URL (or raw token) to a protected file
and inspect it with the same encryption key and guest origin used to create it:

```bash
aos-gateway invite inspect --link-file ./invite-link.txt
```

Use `--link-file -` to read from stdin. The command contacts no runtime and
prints formatted JSON containing every claim, including the private first-turn
instruction. Treat that output as sensitive. It validates the configured
audience and rejects expired or tampered invitations. Run
`aos-gateway invite inspect --help` for complete usage.

`--prefill` is an editable draft placed in the guest composer. It is never sent
until the guest submits it. The private instruction is read only from
`--instruction-file` (use `-` for stdin), is never returned to browser code,
and is applied only while initializing the native Session for the first
submitted message:

- OpenCode sends it through native `prompt_async.system`.
- Hermes seeds it as a private, preloaded user-history instruction during
  `session.create`. Hermes sends that seed with the first participant turn but
  does not persist the preloaded row in the native transcript. A system-history
  row is not used because Hermes' Responses transport drops additional system
  rows after its assembled Session system prompt.

OpenCode persists a namespaced initialization marker and stable native message
identity before prompting, so delayed message visibility or a helper restart
cannot reapply the instruction. Once initialization is complete—or durable
messages already exist—renewed invitations ignore both first-turn fields.
Opening, refreshing, or dismissing the welcome note never creates a Session or
submits a prompt.

Hermes recovers a reference through an exact reserved Session title scoped to
the configured profile. OpenCode recovers it from namespaced native Session
metadata while preserving unrelated metadata. Native Hermes WebSocket and
OpenCode SSE observation drive guest refreshes; the helper does not continuously
poll complete histories. Manual deletion, renaming, archival, or metadata edits
can make recovery fail. Run only one helper instance for a given runtime state;
distributed creation locks are intentionally absent.

## Security and capability limits

Every guest mutation checks the configured Origin, invitation expiry, and a
conversation binding derived from the invitation's Agent and reference. Guest
history and events project participant messages, attachments, and explicitly
supported rich displays. System rows, reasoning, raw tool calls/results,
Subagent activity, permissions, management, unrelated Sessions, model changes,
and executable slash commands are not available.

This filtering is not a sandbox. Configure the invited Agent's native tools,
filesystem access, network access, and permissions for the guest's trust level.
The Agent can repeat private instructions or runtime-owned background in its
ordinary answers, and a Hermes operator can inspect the native system row.

Capabilities remain provider-driven. Hermes and OpenCode both support chat,
streaming, Stop, attachments where native support exists, and reconnect.
OpenCode additionally exposes safe native edit/regenerate operations and its
pending-question flow: ordered batches, multiple selection, custom answers and
rejection. The guest sees only bounded question text and an opaque handle;
every response is reauthorized against the current native Session. Hermes voice
is offered only when native STT/TTS configuration is available. Branch
navigation remains disabled because neither regular runtime UI currently
exposes it; OpenCode's lower-level fork API is not made into a guest escape
hatch. Hermes execution approvals remain intentionally excluded.

NanoClaw and OpenClaw are not implemented. A future adapter can implement the
same provider-neutral Go conversation contract if it can provide durable
Agent+reference lookup, ownership checks, scoped operations, and safe output
projection without importing native details into the browser.

## Focused verification

```bash
go -C gateway test ./...
go -C gateway vet ./...
CGO_ENABLED=1 go -C gateway test -race ./...
bun run typecheck
bun run lint
bun run build
```

Live acceptance requires configured credentials and approved disposable native
Agents. Fixture tests are not evidence of a live Hermes or OpenCode journey.
