import type { AgentSummary } from "./contracts"

/** Native metadata is the only authority; names never confer a role. */
export function getAgentCreator(agents: readonly AgentSummary[]) {
  const creators = agents.filter((agent) => agent.role === "creator")
  if (creators.length > 1)
    throw new Error("Multiple creator Agents are configured")
  return creators[0]
}

export function isRosterAgent(agent: AgentSummary) {
  return agent.role !== "creator" && agent.visibility !== "hidden"
}
