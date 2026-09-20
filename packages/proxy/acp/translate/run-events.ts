import {
  AOS_STOP_REASONS,
  AosArtifactDescriptorSchema,
  AosSteerAcceptedNotificationSchema,
} from "../../../protocol/acp"
import {
  isUncertainError,
  pendingRequestsOf,
  RunEventKind,
  type RunEvent,
  type RunEventOf,
} from "../../core/events"
import {
  initialTranslateState,
  type AcpOutbound,
  type TranslateContext,
  type TranslateRunEvent,
  type TranslateState,
} from "../types"
import { pendingRequestToOutbound } from "./interrupts"
import {
  chunkOutbound,
  planUpdate,
  runMeta,
  stateOutbound,
  TodosSchema,
  toolOutbound,
  update,
} from "./updates"

const SteerAcceptedSchema = AosSteerAcceptedNotificationSchema.pick({
  requestId: true,
  text: true,
  delivery: true,
})

type ActivityEvent =
  | RunEventOf<typeof RunEventKind.ACTIVITY_SNAPSHOT>
  | RunEventOf<typeof RunEventKind.ACTIVITY_DELTA>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const REASONING_SUFFIX = ":reasoning"

/** Adapters name the reasoning half of a turn `<assistant id>:reasoning`. */
function assistantIdOf(messageId: string) {
  return messageId.endsWith(REASONING_SUFFIX)
    ? messageId.slice(0, -REASONING_SUFFIX.length)
    : messageId
}

/**
 * One ACP assistant message per run segment: the first text or reasoning start
 * of the segment fixes its id, and every later chunk and tool call of the
 * segment carries that one id, so reasoning stays on the turn it answers with.
 * `RUN_FINISHED` and `RUN_ERROR` reset it with the rest of the segment state.
 */
function segmentMessage(state: TranslateState, messageId: string) {
  const id = state.messageId ?? messageId
  return {
    state: state.messageId === undefined ? { ...state, messageId: id } : state,
    messageId: id,
  }
}

/** The assistant message a tool call hangs off; a run id always exists. */
function attachedTo(
  state: TranslateState,
  context: TranslateContext,
  parentMessageId?: string
) {
  return parentMessageId ?? state.messageId ?? context.runId
}

function openArgs(
  state: TranslateState,
  toolCallId: string,
  argsText: string
): TranslateState {
  return {
    ...state,
    toolArgsText: { ...state.toolArgsText, [toolCallId]: argsText },
  }
}

function jsonOr(text: string, fallback: unknown): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * Hermes marks a failed tool `{ status: "failed" }` (`projectHermesToolResult`),
 * OpenClaw and OpenCode `{ status: "error" }` or `{ isError: true }`.
 */
function resultFailed(output: unknown): boolean {
  if (!isRecord(output)) return false
  return (
    output.isError === true ||
    output.status === "failed" ||
    output.status === "error"
  )
}

/** Adapters send one JSON-Patch `replace` of `/todos` carrying the whole list. */
function replacedTodos(patch: readonly unknown[]): unknown {
  const [operation, ...rest] = patch
  if (rest.length > 0 || !isRecord(operation)) return undefined
  return operation.op === "replace" && operation.path === "/todos"
    ? operation.value
    : undefined
}

function planTodos(event: ActivityEvent) {
  if (event.activityType !== "PLAN") return undefined
  const value =
    event.type === RunEventKind.ACTIVITY_SNAPSHOT
      ? event.content.todos
      : replacedTodos(event.patch)
  const parsed = TodosSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

type Step = { state: TranslateState; outbound: AcpOutbound[] }

function customOutbound(
  state: TranslateState,
  context: TranslateContext,
  event: RunEventOf<typeof RunEventKind.CUSTOM>
): Step {
  if (event.name === "aos.artifact") {
    const artifact = AosArtifactDescriptorSchema.safeParse(event.value)
    if (!artifact.success) return { state, outbound: [] }
    return {
      state,
      outbound: [
        {
          kind: "artifact",
          runId: context.runId,
          ...(state.messageId ? { messageId: state.messageId } : {}),
          artifact: artifact.data,
        },
      ],
    }
  }
  if (event.name !== "aos.steer.accepted") return { state, outbound: [] }
  // The replayed history already carried this correction as the user turn
  // Hermes persisted the moment it accepted the redirect, so announcing it
  // again would show the same words twice. Acceptances arrive in the order
  // history recorded them, so counting them down is enough.
  if (state.replayedCorrections > 0)
    return {
      state: { ...state, replayedCorrections: state.replayedCorrections - 1 },
      outbound: [],
    }
  const accepted = SteerAcceptedSchema.safeParse(event.value)
  return {
    state,
    outbound: accepted.success
      ? [{ kind: "steer-accepted", runId: context.runId, ...accepted.data }]
      : [],
  }
}

function finishedOutbound(
  context: TranslateContext,
  event: RunEventOf<typeof RunEventKind.RUN_FINISHED>
): AcpOutbound[] {
  const requests = pendingRequestsOf(event)
  if (requests.length > 0)
    return [
      stateOutbound(context, { state: "requires_action" }),
      ...requests.map((request) =>
        pendingRequestToOutbound(request, context.lane)
      ),
    ]
  const prefill = isRecord(event.result)
    ? event.result["aos.composerPrefill"]
    : undefined
  const outbound: AcpOutbound[] = []
  if (typeof prefill === "string")
    outbound.push({
      kind: "composer-prefill",
      runId: context.runId,
      text: prefill,
    })
  outbound.push(
    stateOutbound(context, {
      state: "idle",
      stopReason: context.stopping ? "cancelled" : "end_turn",
    })
  )
  return outbound
}

function errorOutbound(
  context: TranslateContext,
  event: RunEventOf<typeof RunEventKind.RUN_ERROR>
): AcpOutbound[] {
  return [
    stateOutbound(
      context,
      {
        state: "idle",
        stopReason: isUncertainError(event)
          ? AOS_STOP_REASONS.uncertain
          : AOS_STOP_REASONS.error,
      },
      {
        ...(event.code ? { code: event.code } : {}),
        message: event.message.slice(0, 4_096),
      }
    ),
  ]
}

function toolStarted(
  state: TranslateState,
  context: TranslateContext,
  event: RunEventOf<typeof RunEventKind.TOOL_CALL_START>
): Step {
  const call = {
    toolCallId: event.toolCallId,
    title: event.toolCallName,
    status: "in_progress",
  }
  const messageId = attachedTo(state, context, event.parentMessageId)
  return {
    state: openArgs(state, event.toolCallId, ""),
    outbound: [toolOutbound(context, messageId, call)],
  }
}

function toolArgs(
  state: TranslateState,
  context: TranslateContext,
  event: RunEventOf<typeof RunEventKind.TOOL_CALL_ARGS>
): Step {
  const argsText = (state.toolArgsText[event.toolCallId] ?? "") + event.delta
  const call = { toolCallId: event.toolCallId }
  return {
    state: openArgs(state, event.toolCallId, argsText),
    outbound: [
      toolOutbound(context, attachedTo(state, context), call, {
        argsTextDelta: event.delta,
      }),
    ],
  }
}

function toolEnded(
  state: TranslateState,
  context: TranslateContext,
  event: RunEventOf<typeof RunEventKind.TOOL_CALL_END>
): Step {
  const { [event.toolCallId]: argsText = "", ...toolArgsText } =
    state.toolArgsText
  const call = {
    toolCallId: event.toolCallId,
    rawInput: jsonOr(argsText, { text: argsText }),
  }
  return {
    state: { ...state, toolArgsText },
    outbound: [
      toolOutbound(context, attachedTo(state, context), call, { argsText }),
    ],
  }
}

function toolSettled(
  state: TranslateState,
  context: TranslateContext,
  event: RunEventOf<typeof RunEventKind.TOOL_CALL_RESULT>
): Step {
  const output = jsonOr(event.content, event.content)
  const call = {
    toolCallId: event.toolCallId,
    status: resultFailed(output) ? "failed" : "completed",
    rawOutput: output,
    content: [
      { type: "content", content: { type: "text", text: event.content } },
    ],
  }
  return {
    state,
    outbound: [toolOutbound(context, attachedTo(state, context), call)],
  }
}

export const translateRunEvent = ((state, event: RunEvent, context) => {
  switch (event.type) {
    case RunEventKind.RUN_STARTED:
      return { state, outbound: [stateOutbound(context, { state: "running" })] }
    case RunEventKind.TEXT_MESSAGE_START:
      return {
        state: segmentMessage(state, event.messageId).state,
        outbound: [],
      }
    case RunEventKind.REASONING_START:
    case RunEventKind.REASONING_MESSAGE_START:
      return {
        state: segmentMessage(state, assistantIdOf(event.messageId)).state,
        outbound: [],
      }
    case RunEventKind.TEXT_MESSAGE_CONTENT:
    case RunEventKind.REASONING_MESSAGE_CONTENT: {
      const prose = event.type === RunEventKind.TEXT_MESSAGE_CONTENT
      const segment = segmentMessage(
        state,
        prose ? event.messageId : assistantIdOf(event.messageId)
      )
      return {
        state: segment.state,
        outbound: [
          chunkOutbound(
            context,
            prose ? "agent_message_chunk" : "agent_thought_chunk",
            segment.messageId,
            event.delta
          ),
        ],
      }
    }
    case RunEventKind.TOOL_CALL_START:
      return toolStarted(state, context, event)
    case RunEventKind.TOOL_CALL_ARGS:
      return toolArgs(state, context, event)
    case RunEventKind.TOOL_CALL_END:
      return toolEnded(state, context, event)
    case RunEventKind.TOOL_CALL_RESULT:
      return toolSettled(state, context, event)
    case RunEventKind.ACTIVITY_SNAPSHOT:
    case RunEventKind.ACTIVITY_DELTA: {
      const todos = planTodos(event)
      const plan = todos ? [update(planUpdate(todos, runMeta(context)))] : []
      return { state, outbound: plan }
    }
    case RunEventKind.CUSTOM:
      return customOutbound(state, context, event)
    case RunEventKind.RUN_FINISHED:
      return {
        state: initialTranslateState,
        outbound: finishedOutbound(context, event),
      }
    case RunEventKind.RUN_ERROR:
      return {
        state: initialTranslateState,
        outbound: errorOutbound(context, event),
      }
    default:
      return { state, outbound: [] }
  }
}) satisfies TranslateRunEvent
