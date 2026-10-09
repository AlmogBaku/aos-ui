# Share an invited conversation

The [harness-gw](https://github.com/AlmogBaku/harness-gw) gateway can expose
one runtime-neutral guest conversation on its dedicated guest listener, which
AOS serves as its own guest lane. Guests and operators share the same runtime, transport, and
Session coordinator. The invitation restricts the guest to one Agent and one
conversation reference.

## Configure the guest listener

Add `guest` to the private gateway configuration for the selected runtime, as
shown in harness-gw's `examples/config.hermes.example.yaml`,
`examples/config.openclaw.example.yaml`, or
`examples/config.opencode.example.yaml`.
The signing key must be a private 32-byte secret file. The default invitation
lifetime is 72 hours.

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' \
  > /absolute/private/path/guest-invite-signing-key
chmod 600 /absolute/private/path/guest-invite-signing-key
```

The guest listener must have its own origin and port. It uses the same selected
runtime instance as the trusted operator listener; do not configure a second
provider token or runtime. Up to three signing keys may be configured for
rotation (`guest.invitations.keys`); the gateway accepts tokens signed by any
of them.

Under Compose, every harness overlay opens the guest lane: Caddy publishes it
on `${AOS_UI_GUEST_BIND_ADDRESS:-127.0.0.1}:${AOS_UI_GUEST_PUBLISHED_PORT:-3001}`,
sends `/api/v1` to the gateway's guest listener (4101), and everything else to
the AOS web server's guest surface (4201), which serves the guest page under
its own content security policy and never the operator sign-in, service
worker, or manifest. Mount the key with
`HARNESS_GW_GUEST_INVITE_SIGNING_KEY_FILE`, set the gateway's
`guest.publicOrigin` to the address guests use, and set
`AOS_UI_GUEST_PUBLIC_HOST` to its host name so Caddy answers it. Under the
development overlay the guest page has no hot reload; rebuild to see a change.

## Prepare the invited Agent

Use a dedicated Agent for each guest-facing business use case instead of
inviting guests to a general-purpose or personal Agent. Give it only the
focused skills required by that workflow. For example, an interview Agent can
use a skill for one specific interview type that defines its questions,
workflow, outputs, and guardrails.

Restrict the Agent in the native runtime to the tools, filesystem locations,
network destinations, credentials, and approval behavior the workflow needs.
Test it with non-sensitive data before sharing an invitation. Agent visibility
controls catalog presentation; it does not restrict what the Agent can access.
Likewise, invitation scope restricts the guest to one Agent and conversation,
but it does not sandbox the Agent itself.

Guests get no slash commands. The guest listener advertises none, and it refuses
any guest message or steer whose text starts with `/`, even after leading
whitespace.

The `limits.guestActiveExecutions` gateway config field caps concurrent guest
runs. It must not exceed `limits.activeExecutions`.

## Create an invitation

The `aos-invite-link` skill (`shared/invite-link/SKILL.md`) performs the same
dedicated-Agent preflight before it creates a link. It is a plain skill:
install it in a Hermes profile's `skills/` directory or through
`skills.external_dirs` (see [Run Hermes](runtimes/hermes.md#skills)); the
OpenCode launcher writes it into the worktree's `.opencode/skills/`.

The gateway CLI, run from the harness-gw checkout, signs locally and makes no
HTTP request. `--ref` is optional; if
omitted, the CLI generates a URL-safe conversation reference. Whether a new
Session can be created on first Send depends on the selected runtime's exact
native semantics.

```bash
bun run gateway invite --config /absolute/private/path/harness-gw.yaml --agent interviewer
```

The `aos-invite-link` skill instead sends one POST to the trusted
operator gateway's `/api/v1/guest-invitations` endpoint. That endpoint admits a
request with no `Origin`, as the skill's `curl` sends; one that carries an
`Origin` outside the operator listener's `allowedOrigins` returns 403. An
unknown Agent ID returns 404, and the guest lane answers 404 for the route. Set
`AOS_GATEWAY_URL` to a reachable operator origin in the Hermes
environment; native and containerized installs need only network access to
that listener, not the signing key. The endpoint accepts the same invitation
fields and applies the same defaults as the CLI.

Useful presentation options are `--name`, `--logo`, `--accent`, `--title`,
`--message`, `--prefill`, and `--lang en|he`. Use `--expires-in` to override the
72-hour default. Use `--instruction` only for non-secret setup text that the
runtime should receive once when the invited Session is created.

The command prints a URL whose fragment contains the invitation. The fragment
stays in the guest URL so refresh can authenticate again; URL fragments are not
sent in HTTP requests. The browser authenticates by sending the token as the
`_meta.hgw.token` of an `auth/login` ACP request with method `hgw-invite` on
the guest connection.

> [!WARNING]
> The JWT is signed, not encrypted. Its holder can read the Agent ID,
> conversation reference, presentation fields, and first-turn instruction.
> Never place secrets in any invitation option.

## Runtime behavior

- Opening a new invitation creates nothing; an existing reference loads its
  conversation.
- Hermes can atomically reuse or create the reserved invited Session on first
  Send. OpenClaw and OpenCode can only resolve a pre-existing reserved Session:
  their pinned native APIs do not prove safe equivalent creation. Do not issue
  a new first-send invitation for those runtimes until the reserved Session
  exists.
- Attachments are selected before the first Send and staged only after the
  invited Session resolves.
- Streaming, Stop, questions, cancellation, reload, and reconnect use the same
  normalized ACP v2 path as operator conversations.
- A guest can edit or retry a message it was shown, steer the active turn, and
  start from the runtime's composer prefill. Stop reaches only the invited
  conversation.
- Permission requests never reach a guest. One raised in a turn the guest
  started is declined for it; one raised in another turn waits for the
  operator.
- Voice transcription and speech are Agent-scoped and do not create a Session. Guest audio and read-aloud text may reach the operator-configured gateway speech provider under the same permissions as operator requests. Guest audio is budgeted per conversation at 2 concurrent in-flight operations and 60 audio operations per 10 minutes, shared across all tabs and devices on the same invitation link.
- An Artifact the invited Session publishes reaches the guest as a link. The
  guest browser fetches it from
  `/api/v1/agents/:agentId/sessions/:sessionId/artifacts/:artifactId` on the
  guest lane with its invitation token as a Bearer token; the gateway resolves
  it only from that Session's own history.
- A tool call in the invited Session that declares an MCP App view reaches the
  guest as the App card alone, without the call's arguments or result; no
  other tool call reaches the guest. The `aos-ui` charts, maps, and stats are
  such cards. The guest
  browser opens the view and reads its resources under the invitation's
  Artifact permission and relays its tool calls under the message permission,
  through `/api/v1/agents/:agentId/sessions/:sessionId/tool-calls/:toolCallId/app`
  on the guest lane,
  and only for a call of that Session. The view itself receives
  the call's input and result, so give a guest-facing Agent only App servers
  whose views are fit for a guest.
- Expiry detaches the guest only; it does not stop provider work.
- Invalid or expired links ask the guest to request a new invitation.

Guest output is allowlisted; harness-gw's
[`docs/protocol.md`](https://github.com/AlmogBaku/harness-gw/blob/main/docs/protocol.md#guest-listener)
specifies it. It excludes reasoning, raw tools, permission
requests, usage and model readings, privileged roles, provider metadata and positions, filesystem paths, credentials, live
provider IDs, and Agent-wide approval grants.

Native live acceptance has not been run for the OpenClaw and OpenCode guest
paths. It requires an approved disposable target and credentials.
