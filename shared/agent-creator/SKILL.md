---
name: aos-agent-creator
description: Create a native Agent after interviewing the user and confirming its purpose, instructions, and allowed capabilities.
---

# Create an Agent

1. Establish the Agent's purpose, expected inputs and outputs, and boundaries. Open with one short question, what the Agent should do, followed by two short examples of work it could take on, and nothing else: no introduction, no outline of the steps ahead, no commands. After that, ask one focused question per message and reuse answers already given. Ask in prose when the answer is genuinely open. When you use the harness's own question tool, carry two or three concrete options rather than an empty field, and leave room for an answer you did not list. Never ask the user to approve something they have not seen: write the draft, plan, or list in your message, or in the question itself; tool output does not count.
2. When this harness offers the `capability-build` skill, build the Agent through it, as a capability whose install creates the Agent. It replaces steps 3 and 5 here; everything else in this skill still applies. Run it in this conversation and skip its branch step: this Session already is the dedicated place for the work.
3. Draft a concise name, description, instructions, and least-privilege capabilities supported by this harness. Use operator-approved model defaults. Ask the user to confirm the proposed definition before writing it.
4. After confirmation, rename this conversation's own Session to the Agent's name, so AOS shows the draft by that name. Follow `reference/harness-<harness>.md` beside this skill (`hermes` or `opencode`); where the reference has no rename step, skip it. Never choose or set an icon: AOS assigns one.
5. Create the Agent once with this harness's own means, following the same reference. If creation may already have happened, list the harness's Agents before retrying. Make sure the Agent's model is properly configured and has every credential and environment value it needs; ask the operator for anything missing.
6. As soon as the Agent exists, stamp it with this conversation's own Session id, following the same reference; where the reference has no stamp step, skip it. The stamp is how AOS knows this draft is done, on every device. Stamp only the Agent you created.
7. Report what you created accurately, including any step the operator still has to finish. A written file is not proof the Agent runs. AOS shows the new Agent once the harness lists it.
8. Keep this conversation owned by the creator. Let the user select the new Agent and start its first Session when ready.

Never modify, rename, or delete an existing Agent, and never reuse an Agent id that is already taken. Never copy credentials, clone the creator itself, or place secrets in instructions, files, or messages.

If the Agent will serve invited guests, establish the external audience and
data boundary before drafting it. Recommend a dedicated Agent for that business
workflow and only the focused skills it needs. Restrict its native tools,
filesystem, network, credentials, and approval policy accordingly. Agent
visibility and invitation scope are authorization boundaries, not an Agent
sandbox.

The created Agent should use the `aos-ui` MCP tools for appropriate structured output. Todos are native Session execution state.
