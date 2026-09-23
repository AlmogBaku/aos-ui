import {
  ArrowLeftRightIcon,
  BotIcon,
  BookOpenIcon,
  BrainIcon,
  FileTextIcon,
  FolderInputIcon,
  GlobeIcon,
  PencilIcon,
  ScanSearchIcon,
  SearchIcon,
  SquareTerminalIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react"

import type { ToolUiActionKind, ToolUiLocaleLabels } from "./locale"
import { safeToolDisplayValue } from "./safe-presentation"
import {
  readAosToolArtifact,
  type AosToolKind,
  type AosToolLocation,
} from "./tool-artifact"

export const DEFAULT_TOOL_ACTIONS: ToolUiLocaleLabels["assistant"]["toolActions"] =
  {
    skill: { active: "Loading", complete: "Loaded" },
    read: { active: "Reading", complete: "Read" },
    edit: { active: "Editing", complete: "Edited" },
    delete: { active: "Deleting", complete: "Deleted" },
    move: { active: "Moving", complete: "Moved" },
    command: { active: "Running", complete: "Ran" },
    search: { active: "Searching", complete: "Searched" },
    fetch: { active: "Fetching", complete: "Fetched" },
    think: { active: "Thinking", complete: "Thought" },
    switchMode: { active: "Switching mode", complete: "Switched mode" },
    inspect: { active: "Inspecting", complete: "Inspected" },
    subagent: { active: "Delegating", complete: "Delegated" },
    generic: { active: "Using", complete: "Used" },
  }

/** What a tool name alone reveals; the provider's ACP kind says more. */
export type ToolNameKind = Extract<
  ToolUiActionKind,
  | "skill"
  | "read"
  | "edit"
  | "command"
  | "search"
  | "inspect"
  | "subagent"
  | "generic"
>

/** A word boundary in a tool name: start, end, `_`, `-`, `.`, or a space. */
const word = (words: string) =>
  new RegExp(`(^|[_\\s.-])(${words})([_\\s.-]|$)`, "u")

const SKILL = /skill/u
const INSPECT = word("describe|inspect")
const SEARCH = word("search|find|grep|glob")
const EDIT = word("edit|write|patch|create")
const READ = word("read|view")
const COMMAND = word("bash|shell|terminal|console|command|exec|run")
const SUBAGENT = word("subagent|delegate|task")

export function toolIconKind(toolName: string): ToolNameKind {
  const name = toolName.toLowerCase()
  if (SKILL.test(name)) return "skill"
  if (INSPECT.test(name)) return "inspect"
  if (SEARCH.test(name)) return "search"
  if (EDIT.test(name)) return "edit"
  if (READ.test(name)) return "read"
  if (COMMAND.test(name)) return "command"
  if (SUBAGENT.test(name)) return "subagent"
  return "generic"
}

const ACP_ACTION_KINDS = {
  read: "read",
  edit: "edit",
  delete: "delete",
  move: "move",
  search: "search",
  execute: "command",
  think: "think",
  fetch: "fetch",
  switch_mode: "switchMode",
  other: undefined,
} as const satisfies Record<AosToolKind, ToolUiActionKind | undefined>

/** The fields of a tool-call part that decide how its row reads. */
export type ToolPresentationPart = {
  readonly toolName: string
  readonly args?: unknown
  readonly artifact?: unknown
}

/**
 * What a tool call did: the provider's ACP kind when it declared one, and the
 * tool name's meaning otherwise. `other` declares nothing, so the name decides.
 */
export function toolActionKind(part: ToolPresentationPart): ToolUiActionKind {
  const kind = readAosToolArtifact(part.artifact)?.kind
  return (kind && ACP_ACTION_KINDS[kind]) ?? toolIconKind(part.toolName)
}

const toolIcons = {
  skill: BookOpenIcon,
  read: FileTextIcon,
  edit: PencilIcon,
  delete: Trash2Icon,
  move: FolderInputIcon,
  command: SquareTerminalIcon,
  search: SearchIcon,
  fetch: GlobeIcon,
  think: BrainIcon,
  switchMode: ArrowLeftRightIcon,
  inspect: ScanSearchIcon,
  subagent: BotIcon,
  generic: WrenchIcon,
} satisfies Record<ToolUiActionKind, typeof WrenchIcon>

export function toolIconForKind(kind: ToolUiActionKind) {
  return toolIcons[kind]
}

export function toolIconForName(toolName: string) {
  return toolIcons[toolIconKind(toolName)]
}

const PRIMARY_ARGUMENT_KEYS: Record<ToolUiActionKind, readonly string[]> = {
  skill: ["skill", "name"],
  command: ["command", "name"],
  search: ["query", "pattern", "path", "name"],
  inspect: ["tool", "name"],
  read: ["path", "file_path", "name"],
  edit: ["path", "file_path", "name"],
  delete: ["path", "file_path", "name"],
  move: ["source", "path", "from", "name"],
  fetch: ["url", "query", "name"],
  think: ["title", "thought"],
  switchMode: ["mode", "modeId", "mode_id"],
  subagent: ["path", "query", "question", "command", "name", "title"],
  generic: ["path", "query", "question", "command", "name", "title"],
}

export function toolPrimaryArgument(
  toolName: string,
  args: unknown,
  fallback = toolName,
  kind: ToolUiActionKind = toolIconKind(toolName)
) {
  return safeToolDisplayValue(args, PRIMARY_ARGUMENT_KEYS[kind], fallback)
}

/** A location as a reader cites it: `path` or `path:line`. */
export function formatToolLocation(location: AosToolLocation) {
  return location.line === undefined
    ? location.path
    : `${location.path}:${location.line}`
}

const FILE_KINDS = new Set<ToolUiActionKind>(["read", "edit", "delete", "move"])

/**
 * The one thing a tool row names: a file tool's first location, otherwise
 * the call's primary argument, otherwise its first location or its name.
 */
export function toolSubject(
  part: ToolPresentationPart,
  kind: ToolUiActionKind = toolActionKind(part)
) {
  const first = readAosToolArtifact(part.artifact)?.locations?.[0]
  if (first && FILE_KINDS.has(kind)) return formatToolLocation(first)
  const primary = toolPrimaryArgument(part.toolName, part.args, "", kind)
  if (primary) return primary
  return first ? formatToolLocation(first) : part.toolName
}

/** A tool call's span, down to the second; a sub-second call says so. */
export function formatToolDuration(
  ms: number,
  labels: ToolUiLocaleLabels["assistant"]["duration"]
) {
  if (ms < 1000) return labels.underSecond
  const seconds = Math.floor(ms / 1000)
  return seconds < 60
    ? labels.seconds(seconds)
    : labels.minutes(Math.floor(seconds / 60), seconds % 60)
}
