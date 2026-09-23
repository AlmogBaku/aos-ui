// One assistant turn arrives as one message whose parts are in provider order.
// Once the turn settles, everything before its final answer collapses into a
// single "Worked for …" disclosure that keeps its contents in that same order;
// while the turn runs, nothing folds.

import { isAosRichTool } from "@/components/tool-ui"
import type {
  ToolUiActionKind,
  ToolUiLocale,
  ToolUiLocaleLabels,
  ToolRunKind,
} from "@/components/tool-ui/locale"
import {
  toolActionKind,
  type ToolPresentationPart,
} from "@/components/tool-ui/tool-call-presentation"
import {
  diffStats,
  readAosToolArtifact,
  type AosDiffStats,
} from "@/components/tool-ui/tool-artifact"
import type { RichToolPart } from "@/components/tool-ui/types"

/**
 * The part fields a fold decision reads. An Assistant UI `PartState` and an
 * enriched leaf part both satisfy it, so the same predicates serve `groupBy`
 * and the components rendering the groups.
 */
export type TurnPart = {
  readonly type: string
  readonly toolName?: string
  readonly toolUI?: unknown
  readonly artifact?: unknown
}

/** The tool-UI registry `MessagePrimitive.GroupedParts` hands to a `groupBy`. */
export type TurnGroupContext = {
  readonly toolUIs?: Readonly<Record<string, unknown>>
}

export type TurnGroupKey = "group-working" | "group-reasoning" | "group-tool"

export type TurnLayout = {
  /** A live turn folds nothing, so only a settled turn has a fold. */
  readonly settled: boolean
  /** Position of the turn's final answer: its last text part. */
  readonly terminalIndex: number | undefined
}

const OUTSIDE: readonly TurnGroupKey[] = []
const WORKING: readonly TurnGroupKey[] = ["group-working"]
const WORKING_REASONING: readonly TurnGroupKey[] = [
  "group-working",
  "group-reasoning",
]
const WORKING_TOOL: readonly TurnGroupKey[] = ["group-working", "group-tool"]
const REASONING: readonly TurnGroupKey[] = ["group-reasoning"]
const TOOL: readonly TurnGroupKey[] = ["group-tool"]

/**
 * `MessagePrimitive.GroupedParts` memoizes its tree on this fingerprint instead
 * of the `groupBy` identity. The symbol is registered, so reading it needs no
 * export from the package.
 */
const GROUPBY_MEMO_KEY: unique symbol = Symbol.for(
  "@assistant-ui/groupBy.memoKey"
)

/** Parts that are the turn's outcome rather than its trace. */
const FIRST_CLASS_TYPES = new Set(["data", "image", "file", "source"])

/** A search that reads the network rather than the workspace. */
const WEB_SEARCH = /web|fetch|browse/

const TOOL_RUN_KINDS = {
  read: "readFiles",
  edit: "changedFiles",
  delete: "changedFiles",
  move: "changedFiles",
  command: "ranCommands",
  search: "searchedCode",
  fetch: "searchedWeb",
  skill: "loadedSkills",
  inspect: "inspected",
  subagent: "delegated",
  think: "usedTools",
  switchMode: "usedTools",
  generic: "usedTools",
} as const satisfies Record<ToolUiActionKind, ToolRunKind>

/**
 * A tool call the execution trace owns. A question is answered beside the
 * composer, and a registered or AOS rich view is first-class message content.
 */
export function isOrdinaryToolPart(
  part: TurnPart,
  context?: TurnGroupContext
): boolean {
  const { toolName } = part
  if (toolName === undefined || toolName === "question") return false
  if (part.toolUI !== undefined) return false
  if (context?.toolUIs?.[toolName] !== undefined) return false
  // The rich check reads provider fields only, all carried by a grouped part.
  return !isAosRichTool(part as unknown as RichToolPart)
}

/**
 * Parts that stay outside the fold and always visible: rich tool views,
 * question and permission flows, subagent activity, and attached data, media
 * or sources. `DESIGN.md` keeps meaningful rich output as message content.
 */
export function isFirstClassPart(
  part: TurnPart,
  context?: TurnGroupContext
): boolean {
  if (part.type === "tool-call") return !isOrdinaryToolPart(part, context)
  return FIRST_CLASS_TYPES.has(part.type)
}

/** Parts a settled fold absorbs: mid-turn prose, reasoning, ordinary tools. */
export function isFoldablePart(
  part: TurnPart,
  context?: TurnGroupContext
): boolean {
  if (
    part.type !== "reasoning" &&
    part.type !== "text" &&
    part.type !== "tool-call"
  )
    return false
  return !isFirstClassPart(part, context)
}

/** The parts at `indices`, in order, skipping positions the message dropped. */
export function partsAt<T>(
  parts: readonly T[],
  indices: readonly number[]
): T[] {
  return indices.flatMap((index) => {
    const part = parts[index]
    return part === undefined ? [] : [part]
  })
}

/**
 * Where the turn's answer sits and how much of the turn folds behind it. The
 * status is the message status *type* so a caller can subscribe to a scalar
 * rather than to the whole streaming message.
 */
export function turnLayout(
  parts: readonly TurnPart[],
  status: string | undefined
): TurnLayout {
  // A turn waiting on the operator's answer is still live, not settled.
  const settled = status !== "running" && status !== "requires-action"
  const lastText = parts.findLastIndex((part) => part.type === "text")
  const terminalIndex = lastText === -1 ? undefined : lastText
  return { settled, terminalIndex }
}

/**
 * The per-message `groupBy` for `MessagePrimitive.GroupedParts`. A `groupBy`
 * sees one part with no position, so the message's own parts are closed over to
 * resolve it; an unmapped part is treated as outside the fold, which is what a
 * running turn wants anyway.
 *
 * Once the turn settles, every foldable part but the final answer folds, in
 * place, so the order stays chronological:
 *
 * - Nothing folds while the turn runs.
 * - A first-class part or the final answer splits the fold into adjacent
 *   `group-working` runs; only the run that opens the turn's work reports the
 *   turn's duration, and a later run names what it ran.
 * - Work after the final answer — a turn that kept going after its last prose
 *   and never wrote another — folds into its own run after that prose.
 * - A turn that ended mid-work has no text at all, so its whole trace folds.
 */
export function createTurnGroupBy(
  parts: readonly TurnPart[],
  layout: TurnLayout
) {
  const positions = new Map(parts.map((part, index) => [part, index]))
  const groupBy = (part: TurnPart, context?: TurnGroupContext) => {
    if (isFirstClassPart(part, context)) return OUTSIDE
    const index = positions.get(part)
    const folded =
      layout.settled && index !== undefined && index !== layout.terminalIndex
    switch (part.type) {
      case "reasoning":
        return folded ? WORKING_REASONING : REASONING
      case "tool-call":
        return folded ? WORKING_TOOL : TOOL
      case "text":
        return folded ? WORKING : OUTSIDE
      default:
        return OUTSIDE
    }
  }
  return Object.assign(groupBy, {
    [GROUPBY_MEMO_KEY]: `aos-turn:${layout.settled}:${layout.terminalIndex}`,
  })
}

export type TurnOutcome =
  "worked" | "stopped" | "failed" | "truncated" | "refused"

/**
 * Which headline a settled turn earns: it finished, you stopped it, the model
 * hit its length limit or declined, or it broke.
 */
export function turnOutcome(
  status: { readonly type: string; readonly reason?: string } | undefined
): TurnOutcome {
  if (status?.type !== "incomplete") return "worked"
  switch (status.reason) {
    case "cancelled":
      return "stopped"
    case "length":
      return "truncated"
    case "content-filter":
      return "refused"
    default:
      return "failed"
  }
}

/** What every tool call in the turn changed, summed over its reported diffs. */
export function turnDiffStats(parts: readonly TurnPart[]): AosDiffStats {
  return diffStats(
    parts.flatMap((part) =>
      part.type === "tool-call"
        ? (readAosToolArtifact(part.artifact)?.diffs ?? [])
        : []
    )
  )
}

function toolRunKind(part: ToolPresentationPart): ToolRunKind {
  const kind = TOOL_RUN_KINDS[toolActionKind(part)]
  return kind === "searchedCode" && WEB_SEARCH.test(part.toolName.toLowerCase())
    ? "searchedWeb"
    : kind
}

/**
 * What a run of tool calls did, as one sentence: each kind counted once in the
 * order it first appeared, joined the way the locale joins a list.
 */
export function describeToolRun(
  parts: readonly ToolPresentationPart[],
  labels: ToolUiLocaleLabels["assistant"]["toolRun"],
  locale: ToolUiLocale
): string {
  const counts = new Map<ToolRunKind, number>()
  for (const part of parts) {
    const kind = toolRunKind(part)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  if (counts.size === 0) return ""
  const sentence = new Intl.ListFormat(locale, { type: "conjunction" }).format(
    [...counts].map(([kind, count]) => labels[kind](count))
  )
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

/** A turn's span, at the granularity a reader cares about: whole seconds. */
export function formatTurnDuration(
  ms: number,
  labels: ToolUiLocaleLabels["assistant"]["duration"]
): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60
    ? labels.seconds(seconds)
    : labels.minutes(Math.floor(seconds / 60), seconds % 60)
}
