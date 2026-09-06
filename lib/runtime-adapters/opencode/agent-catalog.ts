/** Shared with the provider-side management service; no filesystem dependencies. */
export const RESERVED_AGENT_IDS = new Set([
  "agent-builder",
  "build",
  "plan",
  "general",
  "explore",
  "compaction",
  "title",
  "summary",
  "en",
  "he",
])

export function isManagedAgentId(id: string) {
  return (
    id.length <= 48 &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) &&
    !RESERVED_AGENT_IDS.has(id)
  )
}

export function hasManagedAgentMetadata(options: Record<string, unknown>) {
  return (
    options.aos_ui_managed === true ||
    (typeof options.aos_ui_name === "string" &&
      options.aos_ui_name.trim().length > 0 &&
      options.aos_ui_name.length <= 80)
  )
}

export function isCatalogAgent(agent: {
  name: string
  native?: boolean | null
  mode: string
}) {
  return (
    agent.name !== "agent-builder" &&
    agent.native !== true &&
    (agent.mode === "primary" || agent.mode === "all")
  )
}
