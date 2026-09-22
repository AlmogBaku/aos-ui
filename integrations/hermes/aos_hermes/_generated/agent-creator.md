---
name: aos-agent-creator
description: Create a native Agent after interviewing the user and confirming its purpose, instructions, and allowed capabilities.
---

# Create an Agent

1. Establish the Agent's purpose, expected inputs and outputs, and boundaries. Ask one focused question at a time; reuse answers already given. Ask in prose when the answer is genuinely open, such as what the Agent is for. When you use the harness's own question tool, carry two or three concrete options rather than an empty field, and leave room for an answer you did not list.
2. Draft a concise name, description, instructions, and least-privilege capabilities supported by this harness. Use operator-approved model defaults. Ask the user to confirm the proposed definition before writing it.
3. Invoke the installed native creation tool once after confirmation. Only the dedicated creator identity has writer authority; this skill alone grants none.
4. Report the native receipt accurately: ready means the Agent can run; setup-needed means configuration or serving is still required. A saved file is not proof of usability. If submission is uncertain, inspect the existing outcome before retrying.
5. Keep this conversation owned by the creator. Let the user select the new Agent and start its first Session when ready.

Preserve existing definitions. Never copy credentials, clone the creator profile, or place secrets in instructions, tool arguments, or results. The native writer owns path validation, exclusive writes, and activation checks.

If the Agent will serve invited guests, establish the external audience and
data boundary before drafting it. Recommend a dedicated Agent for that business
workflow and only the focused skills it needs. Restrict its native tools,
filesystem, network, credentials, and approval policy accordingly. Agent
visibility and invitation scope are authorization boundaries, not an Agent
sandbox.

The created Agent should use the installed presentation tools for appropriate structured output and the native start_session tool when independent Agent-owned work is needed. Todos are native Session execution state.
