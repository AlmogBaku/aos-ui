# Share an invited chat

`aos-gateway` is an optional Go helper that serves two isolated surfaces for one selected Hermes, OpenCode, or OpenClaw runtime:

- an operator listener with the regular AOS UI and same-origin native forwarding; and
- a guest listener with restricted chat reached through a signed, expiring invitation.

The gateway is not a runtime or conversation database. The selected native runtime still owns Agents, Sessions, messages, tools, credentials, and persistence.

## Build the gateway

```bash
bun run build
go build -C gateway -o ../aos-gateway ./cmd/aos-gateway
```

Inspect the current CLI surface without starting a listener:

```bash
./aos-gateway --help
./aos-gateway help serve
./aos-gateway help invite
```

## Configure the listeners

Generate a random 32-byte base64url signing key and keep it outside the repository. The same key signs and verifies invitations; rotating it invalidates outstanding links.

```bash
export AOS_GATEWAY_INVITE_SIGNING_KEY='<base64url-encoded 32-byte key>'
export AOS_GATEWAY_GUEST_ORIGIN='https://guest.example.com'
```

| Variable                           | Required value or default                                           |
| ---------------------------------- | ------------------------------------------------------------------- |
| `AOS_GATEWAY_RUNTIME`              | Required: `hermes`, `opencode`, or `openclaw`                       |
| `AOS_GATEWAY_UPSTREAM`             | Required fixed native HTTP origin                                   |
| `AOS_GATEWAY_DIST`                 | `dist`                                                              |
| `AOS_GATEWAY_OPERATOR_ADDR`        | `127.0.0.1:8080`                                                    |
| `AOS_GATEWAY_GUEST_ADDR`           | `127.0.0.1:8081`                                                    |
| `AOS_GATEWAY_INVITE_SIGNING_KEY`   | Required: 32 random base64url-encoded bytes                         |
| `AOS_GATEWAY_GUEST_ORIGIN`         | Required public HTTPS guest origin                                  |
| `AOS_GATEWAY_HERMES_TOKEN`         | Required Hermes Desktop Session token for Hermes                    |
| `AOS_GATEWAY_OPENCODE_DIRECTORY`   | Required fixed native directory for OpenCode                        |
| `AOS_GATEWAY_OPENCODE_USERNAME`    | Optional OpenCode Basic-auth username                               |
| `AOS_GATEWAY_OPENCODE_PASSWORD`    | Optional OpenCode Basic-auth password                               |
| `AOS_GATEWAY_OPENCLAW_TOKEN`       | Initial OpenClaw operator bootstrap token; removable after pairing  |
| `AOS_GATEWAY_OPENCLAW_DEVICE_FILE` | Required absolute persistent private device-state path for OpenClaw |

Example Hermes server:

```bash
AOS_GATEWAY_RUNTIME=hermes \
AOS_GATEWAY_UPSTREAM=http://127.0.0.1:9119 \
AOS_GATEWAY_HERMES_TOKEN="$HERMES_SESSION_TOKEN" \
  ./aos-gateway serve
```

The operator listener forwards only the selected native prefix. The guest listener exposes neither native forwarding nor operator APIs.

For OpenClaw, create a private writable directory owned by the gateway service
and set, for example,
`AOS_GATEWAY_OPENCLAW_DEVICE_FILE=/var/lib/aos-gateway/openclaw-device.json`.
The gateway creates the identity file with mode `0600`, signs the native
challenge with its stable Ed25519 key, and atomically persists the issued device
token. Do not place the file on ephemeral container storage; bind-mount that
directory if you package the guest gateway in a container. The supplied
Compose OpenClaw overlay contains only the web proxy and therefore has no guest
gateway volume to configure.

The client uses OpenClaw's ordinary `cli` identity and pairing policy. It does
not claim the reserved `gateway-client`/`backend` loopback exemption, because
that internal helper path does not create a pairing record or reusable device
token.

On its first connection, start the gateway once to create a pending device
request. On the OpenClaw host, inspect and approve that exact request:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

Then restart the guest gateway. It fails closed when the file is missing its
approved scopes, malformed, a symlink, or more permissive than `0600`. Grant
exactly `operator.read`, `operator.write`, and `operator.questions`; the guest
gateway does not request administrative or Talk scopes. Once the issued device
token is persisted, remove `AOS_GATEWAY_OPENCLAW_TOKEN` if the shared bootstrap
secret is not otherwise required; reconnect uses the scoped device token.

> [!IMPORTANT]
> The helper binds to loopback and does not provision TLS. Terminate public HTTPS at an operator-managed reverse proxy and forward only the intended guest origin to the guest listener.

The guest origin is a signed invitation audience, not a cosmetic link prefix.
Set `AOS_GATEWAY_GUEST_ORIGIN` to the final HTTPS guest origin in both the
gateway's managed service environment and any deliberately authorized minting
process. Changing it invalidates existing links. A `.env` file is not enough
for a systemd-managed process unless its unit imports that file.

## Create an invitation

Mint invitations locally; there is no HTTP minting endpoint. The Agent and
inline instruction are required. The reference is generated when omitted:

```bash
./aos-gateway invite \
  --agent interviewer \
  --expires-in 24h \
  --prefill 'Hey, Almog sent me here!' \
  --instruction 'Load the interview skill for Dan.' \
  --name 'Almog' \
  --title 'Interview' \
  --message 'Thanks for taking the time to speak with us.' \
  --lang en
```

Run `./aos-gateway invite --help` for optional branding fields. The command
prints only a URL such as `https://guest.example.com/#invite=<JWT>`.

By default the CLI generates a unique conversation reference, so each invitation starts an independently recoverable guest conversation. Supply `--ref STABLE_REFERENCE` only when another invitation should deliberately resolve to the same Agent and conversation. Keep explicit references opaque and free of personal or secret data.

The link is a reusable bearer credential until expiration. Share it through an appropriate private channel. The browser immediately exchanges the fragment for a Secure, HttpOnly, host-only, SameSite=Strict cookie and removes the fragment from the visible URL.

> [!WARNING]
> The invitation is a signed JWT, not an encrypted container. Its recipient can read every claim, including first-turn instructions. Never place secrets in an invitation.

## Use first-turn content

`--prefill` places an editable draft in the guest composer. It is not sent until the guest submits it.

`--instruction` supplies the required first-turn Agent instruction as one shell
argument. The guest UI does not display it after redemption, but the link
recipient can decode it from the JWT. The gateway applies it only while
initializing the first submitted participant turn. It may also appear in the
process argument list, shell history, or a native Agent's tool transcript; do
not use it for secrets.

## Create an invitation through an Agent

The native OpenCode and Hermes integrations include the `aos-invite-link`
skill. Ask the Agent to create an invite and provide:

- the exact target Agent or Hermes profile identifier; and
- the inline first-turn instruction.

You may also provide a stable reference, expiry, prefill, language, guest name,
logo URL, accent, title, or welcome message. The skill verifies the exact native
target before it runs `aos-gateway`. It never assumes that the current Agent is
the invite target.

The `aos-gateway` binary must be available to the native Agent process. It uses
`AOS_GATEWAY_GUEST_ORIGIN` when configured and asks only when it is absent. In
OpenCode Compose deployments the supplied image contains the binary. For local
OpenCode and Hermes installations, build the binary above and place it on the
process `PATH`. `AOS_GATEWAY_INVITE_SIGNING_KEY` authorizes bearer-link
minting, so grant it to an Agent process only after an explicit opt-in; do not
put it in a shell profile. The gateway itself needs the key, but an Agent may
safely lack it and report that minting is unavailable.

> [!WARNING]
> Every shell-capable Agent in the same native process may be able to read the
> signing key and mint invitations. Prefer a dedicated deployment and restrict
> the invited Agent's native tools and permissions for the guest's trust level.

The runtime stores a durable initialization marker or recoverable native Session identity so refreshes, delayed messages, and gateway restarts do not reapply first-turn content. Opening or dismissing the welcome screen does not create a Session or send a prompt.

## Understand guest limits

Every guest mutation checks the configured Origin, invitation expiry, and the Agent/reference binding. Guest history may include participant messages, attachments, and supported rich displays. It excludes system rows, reasoning, raw tool data, Subagents, permissions, management, unrelated Sessions, model changes, and executable slash commands.

Hermes, OpenCode, and OpenClaw provide chat, streaming, Stop, reconnect, and attachments where native support exists. OpenCode additionally supports its safe edit/regenerate flow. OpenCode and OpenClaw expose pending questions. OpenClaw guest edit/regenerate, Todos, transcription, and branches are explicitly unavailable. Hermes execution approvals remain excluded from guest chat.

> [!WARNING]
> Guest filtering is not an Agent sandbox. Configure the invited Agent's native filesystem, network, tools, and permissions for the guest's trust level. An Agent can repeat first-turn instructions or other runtime context in an ordinary answer.

Run one gateway instance for a given runtime state. Distributed creation locks are not provided. Manual native Session renaming, deletion, archival, or metadata edits can break reference recovery.

## Verify

```bash
go -C gateway test ./...
go -C gateway vet ./...
CGO_ENABLED=1 go -C gateway test -race ./...
bun run typecheck
bun run lint
bun run build
```

Use disposable native Agents and real credentials for live acceptance. Fixture or mocked tests do not establish a live invitation journey.
