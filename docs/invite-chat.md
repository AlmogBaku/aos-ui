# Share an invited conversation

The proxy can expose one runtime-neutral guest conversation on its dedicated
guest listener. Guests and operators share the same runtime, transport, and
Session coordinator. The invitation restricts the guest to one Agent and one
conversation reference.

## Configure the guest listener

Add `guest` to the private proxy configuration for the selected runtime, as
shown in the maintained [Hermes](../deploy/proxy-config.hermes.example.json),
[OpenClaw](../deploy/proxy-config.openclaw.example.json), or
[OpenCode](../deploy/proxy-config.opencode.example.json) example.
The signing key must be a private 32-byte secret file. The default invitation
lifetime is 72 hours.

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' \
  > /absolute/private/path/guest-invite-signing-key
chmod 600 /absolute/private/path/guest-invite-signing-key
```

The guest listener must have its own origin and port. It uses the same selected
runtime instance as the trusted operator listener; do not configure a second
provider token or runtime.

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

Slash-command suggestions are hidden in the guest composer by default. Set
`AOS_UI_COMPOSER_SLASH_COMMANDS_ENABLED=true` on the proxy to show them. This is
only a presentation flag: it does not add an authorization boundary or change
how submitted text is handled.

## Create an invitation

The packaged `aos-invite-link` skill performs the same dedicated-Agent
preflight before it creates a link.

The proxy CLI signs locally and makes no HTTP request. `--ref` is optional; if
omitted, the CLI generates a URL-safe conversation reference. Whether a new
Session can be created on first Send depends on the selected runtime's exact
native semantics.

```bash
AOS_RUNTIME_PROXY_CONFIG=/absolute/path/proxy-config.json \
  bun run gateway -- invite --agent interviewer
```

The packaged native integration skill instead sends one POST to the trusted
operator proxy's `/api/aos/v1/guest-invitations` endpoint. Set
`AOS_RUNTIME_PROXY_URL` to the configured operator origin in the Hermes
environment; native and containerized installs need only network access to
that listener, not the signing key. The endpoint accepts the same invitation
fields and applies the same defaults as the CLI.

Useful presentation options are `--name`, `--logo`, `--accent`, `--title`,
`--message`, `--prefill`, and `--lang en|he`. Use `--expires-in` to override the
72-hour default. Use `--instruction` only for non-secret setup text that the
runtime should receive once when the invited Session is created.

The command prints a URL whose fragment contains the invitation. The fragment
stays in the guest URL so refresh can authenticate again; URL fragments are not
sent in HTTP requests. The browser sends the token as guest API authorization.

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
  normalized AG-UI path as operator conversations.
- Voice transcription and speech are Agent-scoped and do not create a Session.
- Expiry detaches the guest only; it does not stop provider work.
- Invalid or expired links ask the guest to request a new invitation.

Guest output is allowlisted. It excludes reasoning, raw tools, privileged
roles, provider metadata and positions, filesystem paths, credentials, live
provider IDs, and Agent-wide approval grants.

Native live acceptance has not been run for the OpenClaw and OpenCode guest
paths. It requires an approved disposable target and credentials.
