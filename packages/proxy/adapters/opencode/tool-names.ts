import { ToolKind } from "../../core/events"

/** OpenCode's native tool names AOS renames. */
export const OPENCODE_CANONICAL_TOOL_NAMES = new Map<string, string>([
  ["task", "delegate_subagent"],
])

export function canonicalOpenCodeToolName(name: string) {
  return OPENCODE_CANONICAL_TOOL_NAMES.get(name) ?? name
}

/**
 * The name AOS gives a command the operator ran in the Session's own shell,
 * which OpenCode reports apart from the model's tool calls.
 */
export const OPENCODE_SHELL_TOOL = "shell"

/** What each canonical OpenCode tool does; any other tool has no kind. */
const OPENCODE_TOOL_KINDS = new Map<string, ToolKind>([
  ["read", ToolKind.Read],
  ["write", ToolKind.Edit],
  ["edit", ToolKind.Edit],
  ["patch", ToolKind.Edit],
  ["bash", ToolKind.Execute],
  [OPENCODE_SHELL_TOOL, ToolKind.Execute],
  ["grep", ToolKind.Search],
  ["glob", ToolKind.Search],
  ["list", ToolKind.Search],
  ["webfetch", ToolKind.Fetch],
  ["todowrite", ToolKind.Think],
  ["todoread", ToolKind.Think],
])

export function openCodeToolKind(canonicalName: string) {
  return OPENCODE_TOOL_KINDS.get(canonicalName)
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
