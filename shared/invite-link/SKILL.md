---
name: aos-invite-link
description: Use when a user asks to create an AOS guest invitation for an Agent conversation.
---

# Create an AOS guest invitation

Use the proxy's `invite` CLI command. It signs locally with the configured
guest key and does not contact the proxy or native runtime.

Required inputs:

- proxy configuration file;
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

The conversation reference is optional. Omit `--ref` to generate a random
URL-safe reference. The invited Session is created lazily on first Send.

```bash
AOS_RUNTIME_PROXY_CONFIG="$config_file" \
  bun run gateway -- invite --agent "$agent_id"
```

The default expiry is 72 hours. Optional `--title`, `--message`, `--prefill`,
and `--lang en|he` values affect presentation only. `--instruction` seeds one
private first-turn instruction when the Session is created.

Return the printed URL unchanged. State that it is a reusable bearer credential
until expiry. The JWT is signed but not encrypted, so its holder can read every
claim. Never put secrets in presentation fields or `--instruction`.
