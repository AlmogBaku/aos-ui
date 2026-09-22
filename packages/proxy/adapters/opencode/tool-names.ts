/** OpenCode's native tool names AOS renames. */
export const OPENCODE_CANONICAL_TOOL_NAMES = new Map<string, string>([
  ["task", "delegate_subagent"],
])

export function canonicalOpenCodeToolName(name: string) {
  return OPENCODE_CANONICAL_TOOL_NAMES.get(name) ?? name
}
