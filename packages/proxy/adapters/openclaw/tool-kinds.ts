import { ToolKind } from "../../core/events"

/**
 * What each OpenClaw built-in tool does. OpenClaw reports a call by the tool's
 * own name and renames nothing, so the name is the canonical one; a plugin
 * tool is unknown here and reads as `Other`.
 */
const OPENCLAW_TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  read: ToolKind.Read,
  memory_get: ToolKind.Read,
  write: ToolKind.Edit,
  edit: ToolKind.Edit,
  apply_patch: ToolKind.Edit,
  exec: ToolKind.Execute,
  bash: ToolKind.Execute,
  process: ToolKind.Execute,
  grep: ToolKind.Search,
  find: ToolKind.Search,
  ls: ToolKind.Search,
  web_search: ToolKind.Search,
  memory_search: ToolKind.Search,
  web_fetch: ToolKind.Fetch,
  browser: ToolKind.Fetch,
}

export function openClawToolKind(name: string): ToolKind {
  return Object.hasOwn(OPENCLAW_TOOL_KINDS, name)
    ? OPENCLAW_TOOL_KINDS[name]!
    : ToolKind.Other
}
