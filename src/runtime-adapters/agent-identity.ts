import type { AgentSummary } from "./contracts"

/**
 * Native metadata is the only authority; names never confer a role. Two
 * creators name none: creation is unavailable rather than guessed, and the
 * roster they hide from is unaffected.
 */
export function getAgentCreator(agents: readonly AgentSummary[]) {
  const creators = agents.filter((agent) => agent.role === "creator")
  return creators.length === 1 ? creators[0] : undefined
}

export function isRosterAgent(
  agent: Pick<AgentSummary, "role" | "visibility">
) {
  return agent.role !== "creator" && agent.visibility !== "hidden"
}
