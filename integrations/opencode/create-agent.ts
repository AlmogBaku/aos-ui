import type { AgentDefinitionInput } from "./agent-definition"
import { writeAgentDefinition } from "./agent-definition"

type AgentClient = {
  app: { agents(input: unknown): Promise<{ data?: unknown[] }> }
}

function isCreator(candidate: unknown, callerAgent: string) {
  if (!candidate || typeof candidate !== "object") return false
  const agent = candidate as Record<string, unknown>
  const options =
    agent.options && typeof agent.options === "object"
      ? (agent.options as Record<string, unknown>)
      : {}
  return (
    agent.name === callerAgent &&
    (agent.mode === "primary" || agent.mode === "all") &&
    agent.native !== true &&
    options.aos_ui_role === "creator"
  )
}

async function confirmCreator(
  client: AgentClient,
  worktree: string,
  callerAgent: string
) {
  const response = await client.app.agents({
    query: { directory: worktree },
    throwOnError: true,
  })
  return (response.data ?? []).some((candidate) =>
    isCreator(candidate, callerAgent)
  )
}

async function confirmAgentReady(
  client: AgentClient,
  worktree: string,
  definition: { agentId: string; name: string }
) {
  const response = await client.app.agents({
    query: { directory: worktree },
    throwOnError: true,
  })
  return (response.data ?? []).some((candidate) => {
    if (!candidate || typeof candidate !== "object") return false
    const agent = candidate as Record<string, unknown>
    const options =
      agent.options && typeof agent.options === "object"
        ? (agent.options as Record<string, unknown>)
        : {}
    return (
      agent.name === definition.agentId &&
      (agent.mode === "primary" || agent.mode === "all") &&
      agent.hidden !== true &&
      agent.native !== true &&
      options.aos_ui_managed === true &&
      options.aos_ui_name === definition.name
    )
  })
}

export async function createAgent(
  client: AgentClient,
  worktree: string,
  callerAgent: string,
  input: AgentDefinitionInput
) {
  if (!(await confirmCreator(client, worktree, callerAgent)))
    throw new Error("Only the Agent Builder may create Agents")

  const { definition } = await writeAgentDefinition(worktree, input)
  let ready = false
  try {
    ready = await confirmAgentReady(client, worktree, definition)
  } catch {
    ready = false
  }

  return {
    version: 1 as const,
    kind: "agent-created" as const,
    agentId: definition.agentId,
    name: definition.name,
    description: definition.description,
    saved: true as const,
    status: ready ? ("ready" as const) : ("setup-needed" as const),
  }
}
