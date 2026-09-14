# Share an invited chat

The Hermes V1 proxy can expose a JWT-scoped guest conversation on a separate
listener. Guests and operators use the same Hermes runtime, transport, and
Session coordinator, but different routes, authorization, projection, and
limits.

An invitation grants access only to its declared runtime, Agent, Session, and
operations. It does not grant access to the trusted operator listener or reveal
the Hermes token.

## Configure the guest listener

Add `guest` to the private proxy configuration, as shown in
[`deploy/proxy-config.hermes.example.json`](../deploy/proxy-config.hermes.example.json):

```json
{
  "guest": {
    "listen": {
      "host": "0.0.0.0",
      "port": 3001,
      "exposure": "private-container"
    },
    "publicOrigin": "https://guest.example.com",
    "invitations": {
      "keys": [
        {
          "id": "current",
          "secretFile": "/run/secrets/guest-invite-signing-key"
        }
      ],
      "ttlSeconds": 300,
      "clockSkewSeconds": 0
    }
  }
}
```

Generate a 32-byte base64url signing key, store it in an owner-only file, and
mount that file at the configured path:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' \
  > /absolute/private/path/guest-invite-signing-key
chmod 600 /absolute/private/path/guest-invite-signing-key
```

The Compose overlay publishes the guest listener separately on loopback port
`3001` by default. External HTTPS ingress must target only this port, preserve
SSE and WebSocket behavior, and expose neither `/api/aos/v1` nor native Hermes
routes. Nginx is optional.

The guest lane uses the same `runtime.tokenFile` as the operator lane. Do not
configure or mount a second Hermes token.

## Create an invitation

Create invitations through the trusted operator API. Validate the target Agent
and Session first; the proxy also verifies both before signing.

```bash
TOKEN="$(
  curl --fail --silent --show-error \
    --request POST \
    --header 'Origin: http://127.0.0.1:3000' \
    --header 'Content-Type: application/json' \
    --data '{
      "principalId": "guest_recipient",
      "invitationId": "invite_interview_01",
      "runtimeId": "hermes-default",
      "agentId": "interviewer",
      "sessionId": "20260914_084917_21de69",
      "operations": [
        "artifacts:read",
        "attachments:read",
        "errors:read",
        "interactions:respond",
        "messages:create",
        "messages:read",
        "messages:stop"
      ],
      "capabilities": [
        "artifact-metadata",
        "attachment-metadata",
        "custom-ui",
        "message-text",
        "safe-errors"
      ]
    }' \
    http://127.0.0.1:3000/api/aos/v1/guest-invitations \
  | jq --raw-output .token
)"

printf 'https://guest.example.com/#invite=%s\n' "$TOKEN"
```

Use the operator listener's exact configured `publicOrigin` in the `Origin`
header. Use stable native Agent and Session IDs from the normalized catalog;
never place a live Hermes Session ID in an invitation.

Choose only the operations and capabilities the recipient needs. For example,
a read-only invitation can grant only `messages:read` and `message-text`.
Invitation IDs and guest principal IDs are operator-chosen audit identities;
they must begin with `invite_` and `guest_` respectively.

The link fragment keeps the bearer token out of HTTP requests during initial
navigation. The browser captures it, removes it from the visible URL, and sends
it only as guest API authorization. The signed JWT is not encrypted: its
recipient can read every claim. Do not put secrets or private instructions in
it.

## Understand expiry and scope

The configured invitation TTL applies when the token is issued and is limited
to one hour. Expiry fails closed for reads, runs, Stop, interaction responses,
reconnect, and event observation. Expiring or disconnecting a guest detaches
only that guest; Hermes work and operator delivery continue.

Guest responses are projected before entering the guest queue. The guest lane
excludes reasoning, privileged roles, raw tool data, approval internals, native
metadata and positions, provider paths, and live Session IDs. Guest JWTs cannot
widen their scope through URLs, request bodies, AG-UI fields, or reconnect
cursors.

Questions and approvals use standard AG-UI interrupts. An authorized guest can
answer only when the invitation grants `interactions:respond`. Reopening the
original invitation link authorizes a fresh browser load; it does not resend a
prompt.

> [!WARNING]
> Guest filtering is not an Agent sandbox. Configure the invited Agent's native
> filesystem, network, tools, and permissions for the recipient's trust level.
> An Agent can repeat runtime context in an ordinary answer.

## Verify the boundary

From the guest origin, verify that:

- the invitation can read only its bound Session;
- a missing, changed, or expired bearer receives `401` or `403`;
- `/api/aos/v1`, `/hermes`, `/auth`, and native provider routes return `404`;
- streaming, Stop, reload, reconnect, and an interrupt response stay within the
  same Agent and Session; and
- an operator observing the same run continues receiving events if the guest
  disconnects or expires.

Live acceptance requires an approved disposable Session and real credentials.
Fixture or mocked tests do not establish a live invitation journey.
