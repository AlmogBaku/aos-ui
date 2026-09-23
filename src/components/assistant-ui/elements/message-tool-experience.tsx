"use client"

import type {
  EnrichedPartState,
  ToolCallMessagePart,
  ToolCallMessagePartComponent,
  ToolCallMessagePartStatus,
} from "@assistant-ui/react"
import { useAuiState } from "@assistant-ui/react"
import { useCallback, useMemo, useState } from "react"

import {
  ToolTimeline,
  type TimelineStep,
  type ToolTimelineState,
} from "./tool-timeline"
import { ToolCall } from "./tool-call"
import { describeToolRun, isOrdinaryToolPart, partsAt } from "./turn-fold"
import { useInsideTurnFold } from "./turn-working-fold"
import { useToolUiLocale } from "@/components/tool-ui"
import { readAosToolArtifact } from "@/components/tool-ui/tool-artifact"
import {
  DEFAULT_TOOL_ACTIONS,
  toolActionKind,
  toolIconForKind,
  toolSubject,
} from "@/components/tool-ui/tool-call-presentation"

export { toolIconKind } from "@/components/tool-ui/tool-call-presentation"

type ToolPart = Pick<
  ToolCallMessagePart,
  "toolCallId" | "toolName" | "args" | "artifact"
> & {
  status: Pick<ToolCallMessagePartStatus, "type">
}

type RuntimeToolPart = Extract<EnrichedPartState, { type: "tool-call" }>

const summaryOnlyToolNames = new Set([
  "skill",
  "use_skill",
  "load_skill",
  "tool_describe",
  "present_artifact",
])

export function shouldRenderToolDetails(toolName: string) {
  return !summaryOnlyToolNames.has(toolName)
}

export function createToolTimelineModel(
  parts: readonly ToolPart[],
  labels: {
    running: string
    pending: string
    failed: string
    complete: string
    actions?: typeof DEFAULT_TOOL_ACTIONS
  } = {
    running: "Running",
    pending: "Needs input",
    failed: "Stopped",
    complete: "Used",
    actions: DEFAULT_TOOL_ACTIONS,
  }
) {
  const actions = labels.actions ?? DEFAULT_TOOL_ACTIONS
  const steps: TimelineStep[] = parts.map((part) => {
    const kind = toolActionKind(part)
    const action = actions[kind]
    return {
      verb:
        part.status.type === "running"
          ? action.active
          : part.status.type === "requires-action"
            ? labels.pending
            : part.status.type === "incomplete"
              ? labels.failed
              : action.complete,
      chip: toolSubject(part, kind),
      icon: toolIconForKind(kind),
    }
  })
  return {
    steps,
    requiresAttention: parts.some(
      (part) => part.status.type === "requires-action"
    ),
  }
}

function isRuntimeToolPart(part: unknown): part is RuntimeToolPart {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "tool-call"
  )
}

export function createToolPartSelector() {
  let previous: readonly RuntimeToolPart[] = []
  return (parts: readonly unknown[]) => {
    const next = parts.filter(
      (part): part is RuntimeToolPart =>
        isRuntimeToolPart(part) && isOrdinaryToolPart(part)
    )
    if (
      previous.length === next.length &&
      previous.every((part, index) => part === next[index])
    )
      return previous
    previous = next
    return previous
  }
}

/** One semantic state for a run of tool calls, collapsed or expanded. */
export function toolRunState(
  parts: readonly {
    status: Pick<ToolCallMessagePartStatus, "type">
    isError?: boolean | undefined
  }[],
  streaming: boolean
): ToolTimelineState {
  if (parts.some((part) => part.status.type === "requires-action"))
    return "attention"
  // A call whose result is an error failed, even when the part completed.
  if (parts.some((part) => part.status.type === "incomplete" || part.isError))
    return "failed"
  if (streaming || parts.some((part) => part.status.type === "running"))
    return "running"
  return "complete"
}

/**
 * A running terminal opens its run while the turn is live, so its output is
 * seen as it streams; the user's own open or close always wins.
 */
export function hasRunningTerminal(
  parts: readonly Pick<ToolPart, "artifact" | "status">[]
) {
  return parts.some(
    (part) =>
      part.status.type === "running" &&
      readAosToolArtifact(part.artifact)?.terminals?.some(
        (terminal) => terminal.running
      ) === true
  )
}

/**
 * One run of consecutive ordinary tool calls, as a single compact timeline
 * labelled by what the run did. Inside a settled turn's fold the rows are
 * already shown, so one click on the fold reveals the whole trace; a live or
 * trailing run keeps its own disclosure and shimmers on the active step.
 */
export function ToolRunGroup({
  renderTool,
  indices,
}: {
  renderTool: ToolCallMessagePartComponent
  /** Source-part positions for one contiguous run, in order. */
  indices: readonly number[]
}) {
  const flat = useInsideTurnFold()
  const selectParts = useMemo(() => createToolPartSelector(), [])
  const parts = useAuiState((state) =>
    selectParts(partsAt(state.message.parts, indices))
  )
  const streaming = useAuiState(
    (state) => state.message.status?.type === "running"
  )
  const { labels, locale } = useToolUiLocale()
  const model = useMemo(
    () =>
      createToolTimelineModel(parts, {
        running: labels.states.running,
        pending: labels.states.pending,
        failed: labels.states.failed,
        complete: labels.states.complete,
        actions: labels.assistant.toolActions,
      }),
    [labels.assistant.toolActions, labels.states, parts]
  )
  const timelineState = toolRunState(parts, streaming)
  const [chosenOpen, setChosenOpen] = useState<boolean>()
  const open = chosenOpen ?? (streaming && hasRunningTerminal(parts))
  const onOpenChange = useCallback((next: boolean) => setChosenOpen(next), [])
  if (!parts.length) return null
  return (
    <div data-slot="message-tool-experience" className="mt-0.5 mb-1.5">
      <ToolTimeline
        steps={model.steps}
        visibleSteps={model.steps.length}
        streaming={streaming}
        collapsible={!flat}
        open={open}
        onOpenChange={onOpenChange}
        restingLabel={describeToolRun(parts, labels.assistant.toolRun, locale)}
        activeLabel={labels.states.running}
        state={timelineState}
        statusLabel={
          timelineState === "attention"
            ? labels.states.pending
            : timelineState === "failed"
              ? labels.states.failed
              : timelineState === "running"
                ? labels.states.running
                : labels.states.complete
        }
        stats={[]}
        details={
          <div
            data-slot="message-tool-details"
            className="flex min-w-0 flex-col gap-0.5"
          >
            {parts.map((part) => {
              // Artifact data parts are the single canonical artifact card.
              // Keep the command in the timeline but do not mirror its payload.
              if (!shouldRenderToolDetails(part.toolName)) {
                const kind = toolActionKind(part)
                const action = labels.assistant.toolActions[kind]
                const running = part.status.type === "running"
                return (
                  <ToolCall
                    key={part.toolCallId}
                    label={action.complete}
                    activeLabel={action.active}
                    query={toolSubject(part, kind)}
                    request=""
                    result=""
                    running={running}
                    state={
                      running
                        ? "running"
                        : part.status.type === "requires-action"
                          ? "attention"
                          : part.status.type === "incomplete"
                            ? "failed"
                            : "complete"
                    }
                    collapsible={false}
                    open={false}
                    onOpenChange={() => undefined}
                    icon={toolIconForKind(kind)}
                  />
                )
              }
              const RenderTool = renderTool
              return (
                <div key={part.toolCallId}>
                  <RenderTool {...part} argsText={part.argsText} />
                </div>
              )
            })}
          </div>
        }
      />
    </div>
  )
}
