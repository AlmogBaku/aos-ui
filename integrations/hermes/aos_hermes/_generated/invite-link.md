---
name: aos-invite-link
description: Use when a user asks to create a signed AOS guest invitation for a specific OpenCode Agent or Hermes profile.
---

# Create an invite link

Collect these required values from the user without inferring them:

- the deployed guest origin, such as `https://guest.example.com`;
- the exact target Agent identifier; and
- the inline first-turn Agent instruction.

Accept an optional stable reference, expiry, prefill, language, guest name, logo URL, accent, title, and welcome message. The default expiry is 24 hours. An omitted reference creates a new random conversation reference; use an explicit reference only when another invitation should reopen the same Agent conversation.

## Verify the target

Use the native runtime that loaded this skill.

- In OpenCode, run `opencode agent list` in the current worktree. Continue only when exactly one listed Agent identifier equals the user-supplied value.
- In Hermes, run `hermes profile show "$agent"`. Continue only when the exact profile exists.

Reject `agent-builder`, `build`, `plan`, `general`, and `explore`, plus any target marked as a creator, hidden, or system-only. AOS guest filtering is not an Agent sandbox: remind the user to choose an Agent whose native filesystem, network, tools, and permissions match the guest's trust level.

## Mint the invitation

Invoke `aos-gateway` with a Bash array so each value remains one argument. Encode each user-supplied literal as a single-quoted shell word, replacing every embedded `'` with `'"'"'`. Populate variables, then build and execute this shape:

```bash
args=(aos-gateway invite --agent "$agent" --instruction "$instruction")
# Append only the optional flags the user supplied:
# --ref --expires-in --prefill --lang --name --logo --accent --title --message
AOS_GATEWAY_GUEST_ORIGIN="$guest_origin" "${args[@]}"
```

Execute the array directly. Treat a missing signing key, failed Agent lookup, nonzero CLI exit, or output that is not exactly one invite URL as failure. Never retry an uncertain mint automatically.

Return the URL without decoding or rewriting it. State that it is a reusable bearer credential until expiry and that its signed JWT claims, including the instruction, are readable by anyone holding the link. The inline instruction can also appear in the native tool transcript and process argument list; never accept secrets in it.
