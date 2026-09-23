---
name: aos-agent-creator
description: Create a native Agent after interviewing the user and confirming its purpose, instructions, and allowed capabilities.
---

# Create an Agent

1. Establish the Agent's purpose, expected inputs and outputs, and boundaries. Ask one focused question at a time; reuse answers already given. Ask in prose when the answer is genuinely open, such as what the Agent is for. When you use the harness's own question tool, carry two or three concrete options rather than an empty field, and leave room for an answer you did not list.
2. Draft a concise name, description, instructions, and least-privilege capabilities supported by this harness. Use operator-approved model defaults. Ask the user to confirm the proposed definition before writing it.
3. After confirmation, create the Agent once with this harness's own means, following `reference/harness-<harness>.md` beside this skill (`hermes`, `openclaw`, or `opencode`). If creation may already have happened, list the harness's Agents before retrying.
4. Report what you created accurately, including any step the operator still has to finish. A written file is not proof the Agent runs. AOS shows the new Agent once the harness lists it.
5. Keep this conversation owned by the creator. Let the user select the new Agent and start its first Session when ready.

Never modify, rename, or delete an existing Agent, and never reuse an Agent id that is already taken. Never copy credentials, clone the creator itself, or place secrets in instructions, files, or messages.

If the Agent will serve invited guests, establish the external audience and
data boundary before drafting it. Recommend a dedicated Agent for that business
workflow and only the focused skills it needs. Restrict its native tools,
filesystem, network, credentials, and approval policy accordingly. Agent
visibility and invitation scope are authorization boundaries, not an Agent
sandbox.

The created Agent should use the `aos-ui` MCP tools for appropriate structured output. Todos are native Session execution state.
