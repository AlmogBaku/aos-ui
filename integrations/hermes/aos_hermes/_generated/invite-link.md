---
name: aos-invite-link
description: Use when a user asks to create a scoped AOS guest invitation for an existing Agent or Session.
---

# Create an AOS guest invitation

Use the trusted operator listener. The TypeScript proxy validates the Agent and
optional Session before signing; do not call a native runtime or mint a JWT
locally.

Collect these exact values:

- operator origin and guest origin;
- runtime ID;
- Agent ID and optional durable Session ID;
- guest principal ID beginning with `guest_`;
- invitation ID beginning with `invite_`;
- the smallest required operations and output capabilities.

Allowed operations are `artifacts:read`, `attachments:read`, `errors:read`,
`interactions:respond`, `messages:create`, `messages:read`, and
`messages:stop`. Allowed capabilities are `artifact-metadata`,
`attachment-metadata`, `custom-ui`, `message-text`, and `safe-errors`.

POST the grant to `/api/aos/v1/guest-invitations` on the operator origin with
that exact origin in the `Origin` header. Treat a non-201 response, invalid
JSON, or missing `token` as failure. Do not retry an uncertain request.

```bash
curl --fail --silent --show-error \
  --request POST \
  --header "Origin: $operator_origin" \
  --header "Content-Type: application/json" \
  --data "$grant_json" \
  "$operator_origin/api/aos/v1/guest-invitations"
```

Read the `token` field and return
`$guest_origin/#invite=$token` without decoding or rewriting it. State that
the link is a reusable bearer credential until expiry and that JWT claims are
readable by its holder. Never place secrets or a live provider Session ID in
the grant.
