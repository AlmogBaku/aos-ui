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
import {
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "./reasoning.aui"
import { isAosRichTool, useToolUiLocale } from "@/components/tool-ui"
import {
  DEFAULT_TOOL_ACTIONS,
  toolIconForName,
  toolIconKind,
  toolPrimaryArgument,
} from "@/components/tool-ui/tool-call-presentation"

export { toolIconKind } from "@/components/tool-ui/tool-call-presentation"

type ToolPart = Pick<
  ToolCallMessagePart,
  "toolCallId" | "toolName" | "args"
> & {
  status: Pick<ToolCallMessagePartStatus, "type">
}

type RuntimeToolPart = Extract<EnrichedPartState, { type: "tool-call" }>
type RuntimeReasoningPart = Extract<EnrichedPartState, { type: "reasoning" }>
type RuntimeTextPart = Extract<EnrichedPartState, { type: "text" }>
type RuntimeExecutionPart =
  RuntimeReasoningPart | RuntimeTextPart | RuntimeToolPart

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
    const action = actions[toolIconKind(part.toolName)]
    return {
      verb:
        part.status.type === "running"
          ? action.active
          : part.status.type === "requires-action"
            ? labels.pending
            : part.status.type === "incomplete"
              ? labels.failed
              : action.complete,
      chip: toolPrimaryArgument(part.toolName, part.args),
      icon: toolIconForName(part.toolName),
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

function isRuntimeReasoningPart(part: unknown): part is RuntimeReasoningPart {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "reasoning"
  )
}

function isRuntimeTextPart(part: unknown): part is RuntimeTextPart {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "text"
  )
}

function isOrdinaryToolPart(part: RuntimeToolPart) {
  return part.toolName !== "question" && !part.toolUI && !isAosRichTool(part)
}

function isExecutionBoundaryPart(part: unknown) {
  return (
    isRuntimeReasoningPart(part) ||
    (isRuntimeToolPart(part) && isOrdinaryToolPart(part))
  )
}

export function isIntermediateExecutionText(
  parts: readonly unknown[],
  index: number
) {
  return (
    isRuntimeTextPart(parts[index]) &&
    parts.slice(index + 1).some(isExecutionBoundaryPart)
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

export function createExecutionPartSelector() {
  let previous: readonly RuntimeExecutionPart[] = []
  return (parts: readonly unknown[]) => {
    const next = parts.filter(
      (part, index): part is RuntimeExecutionPart =>
        isExecutionBoundaryPart(part) ||
        (isRuntimeTextPart(part) && isIntermediateExecutionText(parts, index))
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

export function executionTimelineState(
  parts: readonly {
    type: RuntimeExecutionPart["type"]
    status: Pick<ToolCallMessagePartStatus, "type">
  }[],
  streaming: boolean
): ToolTimelineState {
  if (
    parts.some(
      (part) =>
        part.type === "tool-call" && part.status.type === "requires-action"
    )
  )
    return "attention"
  if (
    parts.some(
      (part) => part.type === "tool-call" && part.status.type === "incomplete"
    )
  )
    return "failed"
  if (streaming || parts.some((part) => part.status.type === "running"))
    return "running"
  return "complete"
}

export function MessageToolExperience({
  renderTool,
}: {
  renderTool: ToolCallMessagePartComponent
}) {
  const selectParts = useMemo(() => createExecutionPartSelector(), [])
  const parts = useAuiState((state) => selectParts(state.message.parts))
  const toolParts = useMemo(() => parts.filter(isRuntimeToolPart), [parts])
  const reasoningParts = useMemo(
    () => parts.filter(isRuntimeReasoningPart),
    [parts]
  )
  const status = useAuiState((state) => state.message.status)
  const { labels } = useToolUiLocale()
  const model = useMemo(
    () =>
      createToolTimelineModel(toolParts, {
        running: labels.states.running,
        pending: labels.states.pending,
        failed: labels.states.failed,
        complete: labels.states.complete,
        actions: labels.assistant.toolActions,
      }),
    [labels.assistant.toolActions, labels.states, toolParts]
  )
  const streaming = status?.type === "running"
  const timelineState = executionTimelineState(parts, streaming)
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined)
  // Execution stays compact even while active. Shimmering conveys activity;
  // semantic UI is rendered separately in the ordinary message flow.
  const open = userOpen ?? false
  const onOpenChange = useCallback((next: boolean) => setUserOpen(next), [])
  if (!parts.length) return null
  const restingLabel = reasoningParts.length
    ? toolParts.length
      ? `${labels.assistant.reasoning} · ${labels.assistant.toolCalls(toolParts.length)}`
      : labels.assistant.reasoning
    : labels.assistant.toolCalls(toolParts.length)
  return (
    <div data-slot="message-tool-experience" className="mt-0.5 mb-1.5">
      <ToolTimeline
        steps={model.steps}
        visibleSteps={model.steps.length}
        streaming={streaming}
        open={open}
        onOpenChange={onOpenChange}
        restingLabel={restingLabel}
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
            {parts.map((part, index) => {
              if (part.type === "text") {
                return (
                  <p
                    key={`text-${index}`}
                    data-slot="execution-message"
                    className="py-1 text-sm leading-relaxed whitespace-pre-wrap text-foreground/70"
                    dir="auto"
                  >
                    {part.text}
                  </p>
                )
              }
              if (part.type === "reasoning") {
                const running = part.status.type === "running"
                return (
                  <ReasoningRoot
                    key={`reasoning-${index}`}
                    className="mb-0"
                    variant="ghost"
                    streaming={running}
                  >
                    <ReasoningTrigger
                      active={running}
                      className="gap-1 py-0 text-xs leading-4 [&_[data-slot=reasoning-trigger-chevron]]:text-foreground/35 [&_[data-slot=reasoning-trigger-icon]]:text-foreground/35"
                    />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>
                        <div className="whitespace-pre-wrap">{part.text}</div>
                      </ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                )
              }
              // Artifact data parts are the single canonical artifact card.
              // Keep the command in the timeline but do not mirror its payload.
              if (!shouldRenderToolDetails(part.toolName)) {
                const action =
                  labels.assistant.toolActions[toolIconKind(part.toolName)]
                const running = part.status.type === "running"
                return (
                  <ToolCall
                    key={part.toolCallId}
                    label={action.complete}
                    activeLabel={action.active}
                    query={toolPrimaryArgument(part.toolName, part.args)}
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
                    icon={toolIconForName(part.toolName)}
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
