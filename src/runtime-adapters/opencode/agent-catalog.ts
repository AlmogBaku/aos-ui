function hasCreatorRole(options: unknown) {
  return (
    typeof options === "object" &&
    options !== null &&
    "aos_ui_role" in options &&
    options.aos_ui_role === "creator"
  )
}

export function isSupportedAgent(agent: {
  native?: boolean | null
  mode: string
}) {
  return (
    agent.native !== true && (agent.mode === "primary" || agent.mode === "all")
  )
}

export function isCatalogAgent(agent: {
  native?: boolean | null
  mode: string
  options?: unknown
}) {
  return isSupportedAgent(agent) && !hasCreatorRole(agent.options)
}
