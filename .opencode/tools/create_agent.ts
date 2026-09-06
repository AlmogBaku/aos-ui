import { tool } from "@opencode-ai/plugin"

import {
  AGENT_DEFINITION_LIMITS,
  AGENT_PERMISSION_KEYS,
  writeAgentDefinition,
} from "../lib/agent-definition"

const permissionAction = () =>
  tool.schema.enum(["allow", "ask", "deny"]).optional()

const permissionShape = {
  read: permissionAction(),
  glob: permissionAction(),
  grep: permissionAction(),
  list: permissionAction(),
  edit: permissionAction(),
  bash: permissionAction(),
  task: permissionAction(),
  question: permissionAction(),
  webfetch: permissionAction(),
} satisfies Record<(typeof AGENT_PERMISSION_KEYS)[number], unknown>

export default tool({
  description:
    "Create one native project Agent after the user has confirmed its definition. This tool is restricted to the hidden agent-builder.",
  args: {
    agentId: tool.schema
      .string()
      .min(1)
      .max(AGENT_DEFINITION_LIMITS.id)
      .describe("Lowercase hyphenated provider Agent ID"),
    name: tool.schema.string().min(1).max(AGENT_DEFINITION_LIMITS.name),
    description: tool.schema
      .string()
      .min(1)
      .max(AGENT_DEFINITION_LIMITS.description),
    prompt: tool.schema.string().min(1).max(AGENT_DEFINITION_LIMITS.prompt),
    model: tool.schema
      .string()
      .min(1)
      .max(AGENT_DEFINITION_LIMITS.model)
      .optional(),
    permissions: tool.schema.object(permissionShape).optional(),
  },
  async execute(args, context) {
    if (context.agent !== "agent-builder") {
      throw new Error("Only the Agent Builder may create Agents")
    }

    await writeAgentDefinition(context.worktree, args)
    return {
      title: `Created ${args.agentId}`,
      output: `Agent ${args.agentId} is ready for activation.`,
      metadata: {
        aos_ui: {
          version: 1,
          kind: "agent-created",
          agentId: args.agentId,
          name: args.name,
          description: args.description,
          draftThreadId: context.sessionID,
        },
      },
    }
  },
})
