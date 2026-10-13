import type {
  AgentSummary,
  SessionActionCapabilities,
  WorkspaceAdapter,
  WorkspaceCapabilities,
} from "./contracts"

/** Session actions are runtime-declared, so an unread runtime offers none. */
export function getWorkspaceCapabilities(
  workspace: WorkspaceAdapter,
  agents: readonly AgentSummary[] = [],
  sessionActions?: SessionActionCapabilities
): WorkspaceCapabilities {
  return {
    agentCatalog: typeof workspace.listAgentCatalog === "function",
    agentUpdates: typeof workspace.updateAgent === "function",
    todos: typeof workspace.subscribeTodos === "function",
    agentCreation:
      agents.filter((agent) => agent.role === "creator").length === 1,
    activityEvents: typeof workspace.subscribeActivity === "function",
    sessionReadState: typeof workspace.markSessionRead === "function",
    sessionRename: sessionActions?.rename ?? false,
    sessionArchival: sessionActions?.archive ?? false,
    sessionDeletion: sessionActions?.delete ?? false,
    sessionPin: sessionActions?.pin ?? false,
  }
}
