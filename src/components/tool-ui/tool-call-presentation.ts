import {
  BotIcon,
  BookOpenIcon,
  FileTextIcon,
  PencilIcon,
  ScanSearchIcon,
  SearchIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from "lucide-react"

import type { ToolUiActionKind, ToolUiLocaleLabels } from "./locale"
import { safeToolDisplayValue } from "./safe-presentation"

export const DEFAULT_TOOL_ACTIONS: ToolUiLocaleLabels["assistant"]["toolActions"] =
  {
    skill: { active: "Loading", complete: "Loaded" },
    read: { active: "Reading", complete: "Read" },
    edit: { active: "Editing", complete: "Edited" },
    command: { active: "Running", complete: "Ran" },
    search: { active: "Searching", complete: "Searched" },
    inspect: { active: "Inspecting", complete: "Inspected" },
    subagent: { active: "Delegating", complete: "Delegated" },
    generic: { active: "Using", complete: "Used" },
  }

export function toolIconKind(toolName: string): ToolUiActionKind {
  const name = toolName.toLowerCase()
  if (name.includes("skill")) return "skill"
  if (/(^|_)(describe|inspect)(_|$)/.test(name)) return "inspect"
  if (/(^|_)(search|find|grep|glob)(_|$)/.test(name)) return "search"
  if (/(^|_)(edit|write|patch|create)(_|$)/.test(name)) return "edit"
  if (/(^|_)(read|view)(_|$)/.test(name)) return "read"
  if (/(^|_)(bash|shell|terminal|console|command|exec|run)(_|$)/.test(name))
    return "command"
  if (/(^|_)(subagent|delegate|task)(_|$)/.test(name)) return "subagent"
  return "generic"
}

const toolIcons = {
  skill: BookOpenIcon,
  read: FileTextIcon,
  edit: PencilIcon,
  command: SquareTerminalIcon,
  search: SearchIcon,
  inspect: ScanSearchIcon,
  subagent: BotIcon,
  generic: WrenchIcon,
} satisfies Record<ToolUiActionKind, typeof WrenchIcon>

export function toolIconForName(toolName: string) {
  return toolIcons[toolIconKind(toolName)]
}

export function toolPrimaryArgument(
  toolName: string,
  args: unknown,
  fallback = toolName
) {
  const kind = toolIconKind(toolName)
  const keys =
    kind === "skill"
      ? ["skill", "name"]
      : kind === "command"
        ? ["command", "name"]
        : kind === "search"
          ? ["query", "path", "name"]
          : kind === "inspect"
            ? ["tool", "name"]
            : kind === "read" || kind === "edit"
              ? ["path", "name"]
              : ["path", "query", "question", "command", "name", "title"]
  return safeToolDisplayValue(args, keys, fallback)
}
