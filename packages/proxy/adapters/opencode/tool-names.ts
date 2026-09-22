/** OpenCode's native tool names AOS renames. */
export const OPENCODE_CANONICAL_TOOL_NAMES = new Map<string, string>([
  ["task", "delegate_subagent"],
])

export function canonicalOpenCodeToolName(name: string) {
  return OPENCODE_CANONICAL_TOOL_NAMES.get(name) ?? name
}

/**
 * Projects one native tool call onto the canonical vocabulary AOS emits.
 *
 * Renaming alone is not enough for the delegation tool: OpenCode reports the
 * child's outcome as plain text, while the canonical activity result carries a
 * `summary`. Every other name, and every other result shape, passes through.
 */
export function canonicalOpenCodeToolCall<Args, Result>(
  name: string,
  args: Args,
  result: Result
): { toolName: string; args: Args; result: Result | { summary: string } } {
  const toolName = canonicalOpenCodeToolName(name)
  const summary =
    toolName === "delegate_subagent" && typeof result === "string"
      ? result.trim()
      : ""
  return { toolName, args, result: summary ? { summary } : result }
}
