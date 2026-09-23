---
name: aos-invite-link
description: Use when a user asks to create an AOS guest invitation for an Agent conversation.
---

# Create an AOS guest invitation

Use the trusted operator proxy's invitation endpoint. The proxy owns signing;
the skill needs no signing key, local AOS checkout, or Docker access.

Required inputs:

- operator proxy URL;
- Agent ID.

Before signing, recommend using a dedicated Agent for the guest-facing business
use case instead of a general-purpose or personal Agent. Recommend giving that
Agent only the focused skills the workflow needs—for example, a skill for one
specific kind of interview—and restricting its native tools, filesystem,
network, credentials, and approval policy accordingly. Agent visibility and
invitation scope are not an Agent sandbox.

If the selected Agent is broad or unrestricted, explain the risk and ask the
user to confirm that it is the intended Agent before signing. Do not create or
modify an Agent unless the user asks; this skill creates only the invitation.

The conversation reference is optional. Omit `ref` to generate a random
URL-safe reference. The invited Session is created lazily on first Send.

Require `AOS_RUNTIME_PROXY_URL` to name the operator proxy URL reachable from
the native runtime. If it is missing, `curl` is unavailable, or the request
fails, report setup-needed with that exact cause. Send one POST only; never
retry an uncertain response.

This is a plain HTTP call from the shell. It needs no browser, UI session, or
cookie. Never mint an invitation through a browser tool.

```bash
curl --fail-with-body --silent --show-error \
  --header 'content-type: application/json' \
  --data-binary "$request_json" \
  "${AOS_RUNTIME_PROXY_URL%/}/api/aos/v1/guest-invitations"
```

Errors carry a JSON `error.description` naming the cause. Report it verbatim:

- `201` — `{"url": ...}`.
- `400` — the description names the rejected field (for example
  `title: too long (max 256)` or `unknown field(s): agentId`). Fix that
  field; do not guess at others.
- `404` — the `agent` is not in the catalog.

Set `request_json` to a strict JSON object containing `agent`. The endpoint
uses the same fields as the local CLI: optional `ref`, `expiresIn`, `prefill`,
`instruction`, `lang`, `name`, `logo`, `accent`, `title`, and `message`. Omit
`ref` to generate one and omit `expiresIn` for the 72-hour default.

Read `url` from the JSON response. State that it is a reusable bearer credential
until expiry. The JWT is signed but not encrypted, so its holder can read every
claim. Never put secrets in `ui` or `firstTurn`.

By default, return `url` unchanged. When a calling workflow transforms it (for
example, shortening it or putting it in a draft), do the POST and the transform
in one shell process. Keep the URL in a variable or pipe, and print only the
derived result. Never write the raw URL to disk, log it, or pass it between
tools. A calling skill should invoke this skill rather than copy its request.
