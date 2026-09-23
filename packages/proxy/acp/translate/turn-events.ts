import {
  AosArtifactDescriptorSchema,
  AOS_STOP_REASONS,
} from "../../../protocol/acp"
import {
  isAwaitingStopFailure,
  isUncertainFailure,
  TurnEventKind,
  type TurnEvent,
  type TurnEventOf,
} from "../../core/events"
import {
  initialTranslateState,
  type AcpOutbound,
  type TranslateContext,
  type TranslateTurnEvent,
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

/**
 * One ACP assistant message per run segment: the first message chunk, thought
 * chunk, or tool call of the segment fixes its id, and every later chunk and
 * tool call of the segment carries that one id, so reasoning stays on the turn
 * it answers with and a provider that rotates its own message id mid-turn
 * (Hermes does at every `message.interim`) still streams the one turn its
 * history replays. A segment's terminal event resets it with the rest of the
 * segment state.
 */
function segmentMessage(state: TranslateState, messageId: string) {
  const id = state.messageId ?? messageId
  return {
    state: state.messageId === undefined ? { ...state, messageId: id } : state,
    messageId: id,
  }
}

/** The assistant message a later tool patch hangs off; a run id always exists. */
function attachedTo(state: TranslateState, context: TranslateContext) {
  return state.messageId ?? context.runId
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

type Step = { state: TranslateState; outbound: AcpOutbound[] }

function chunkStep(
  state: TranslateState,
  context: TranslateContext,
  event: TurnEventOf<
    typeof TurnEventKind.MessageChunk | typeof TurnEventKind.ThoughtChunk
  >
): Step {
  const segment = segmentMessage(state, event.messageId)
  const sessionUpdate =
    event.kind === TurnEventKind.MessageChunk
      ? "agent_message_chunk"
      : "agent_thought_chunk"
  return {
    state: segment.state,
    outbound: [
      chunkOutbound(context, sessionUpdate, segment.messageId, event.text),
    ],
  }
}

function artifactOutbound(
  state: TranslateState,
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.ArtifactPublished>
): AcpOutbound[] {
  // Adapters are typed, not validated: the wire contract still refuses a
  // malformed descriptor, as it refuses malformed Todos below.
  const artifact = AosArtifactDescriptorSchema.safeParse(event.artifact)
  if (!artifact.success) return []
  return [
    {
      kind: "artifact",
      runId: context.runId,
      ...(state.messageId ? { messageId: state.messageId } : {}),
      artifact: artifact.data,
    },
  ]
}

function steerStep(
  state: TranslateState,
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.SteerAccepted>
): Step {
  // The replayed history already carried this correction as the user turn
  // Hermes persisted the moment it accepted the redirect, so announcing it
  // again would show the same words twice. Acceptances arrive in the order
  // history recorded them, so counting them down is enough.
  if (state.replayedCorrections > 0)
    return {
      state: { ...state, replayedCorrections: state.replayedCorrections - 1 },
      outbound: [],
    }
  return {
    state,
    outbound: [
      {
        kind: "steer-accepted",
        runId: context.runId,
        requestId: event.requestId,
        text: event.text,
        delivery: event.delivery,
      },
    ],
  }
}

function endedOutbound(
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.TurnEnded>
): AcpOutbound[] {
  const outbound: AcpOutbound[] = []
  if (event.composerPrefill !== undefined)
    outbound.push({
      kind: "composer-prefill",
      runId: context.runId,
      text: event.composerPrefill,
    })
  outbound.push(
    stateOutbound(context, {
      state: "idle",
      stopReason: context.stopping ? "cancelled" : "end_turn",
    })
  )
  return outbound
}

function requiresActionOutbound(
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.TurnRequiresAction>
): AcpOutbound[] {
  return [
    stateOutbound(context, { state: "requires_action" }),
    ...event.requests.map((request) =>
      pendingRequestToOutbound(request, context.lane)
    ),
  ]
}

function failedOutbound(
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.TurnFailed>
): AcpOutbound[] {
  const failure = {
    ...(event.code ? { code: event.code } : {}),
    message: event.message.slice(0, 4_096),
  }
  return [
    stateOutbound(
      context,
      isAwaitingStopFailure(event)
        ? { state: "running" }
        : {
            state: "idle",
            stopReason: isUncertainFailure(event)
              ? AOS_STOP_REASONS.uncertain
              : AOS_STOP_REASONS.error,
          },
      failure
    ),
  ]
}

function toolStarted(
  state: TranslateState,
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.ToolCallStarted>
): Step {
  const call = {
    toolCallId: event.toolCallId,
    title: event.title,
    status: "in_progress",
  }
  // The adapter's parent id only names the segment when nothing has yet.
  const segment = segmentMessage(state, event.parentMessageId ?? context.runId)
  return {
    state: openArgs(segment.state, event.toolCallId, ""),
    outbound: [toolOutbound(context, segment.messageId, call)],
  }
}

function toolInputChunk(
  state: TranslateState,
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.ToolCallInputChunk>
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

function toolInputEnded(
  state: TranslateState,
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.ToolCallInputEnded>
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

function toolFinished(
  state: TranslateState,
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.ToolCallFinished>
): Step {
  const call = {
    toolCallId: event.toolCallId,
    status: event.failed ? "failed" : "completed",
    rawOutput: jsonOr(event.output, event.output),
    content: [
      { type: "content", content: { type: "text", text: event.output } },
    ],
  }
  return {
    state,
    outbound: [toolOutbound(context, attachedTo(state, context), call)],
  }
}

function planOutbound(
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.PlanUpdated>
): AcpOutbound[] {
  const todos = TodosSchema.safeParse(event.todos)
  return todos.success ? [update(planUpdate(todos.data, runMeta(context)))] : []
}

export const translateTurnEvent = ((state, event: TurnEvent, context) => {
  switch (event.kind) {
    case TurnEventKind.TurnStarted:
      return { state, outbound: [stateOutbound(context, { state: "running" })] }
    case TurnEventKind.MessageChunk:
    case TurnEventKind.ThoughtChunk:
      return chunkStep(state, context, event)
    case TurnEventKind.ToolCallStarted:
      return toolStarted(state, context, event)
    case TurnEventKind.ToolCallInputChunk:
      return toolInputChunk(state, context, event)
    case TurnEventKind.ToolCallInputEnded:
      return toolInputEnded(state, context, event)
    case TurnEventKind.ToolCallFinished:
      return toolFinished(state, context, event)
    case TurnEventKind.PlanUpdated:
      return { state, outbound: planOutbound(context, event) }
    case TurnEventKind.ArtifactPublished:
      return { state, outbound: artifactOutbound(state, context, event) }
    case TurnEventKind.SteerAccepted:
      return steerStep(state, context, event)
    case TurnEventKind.TurnEnded:
      return {
        state: initialTranslateState,
        outbound: endedOutbound(context, event),
      }
    case TurnEventKind.TurnRequiresAction:
      return {
        state: initialTranslateState,
        outbound: requiresActionOutbound(context, event),
      }
    case TurnEventKind.TurnFailed:
      // A failure awaiting Stop reports on a run that is still going, so the
      // segment keeps its state until the run actually ends.
      return {
        state: isAwaitingStopFailure(event) ? state : initialTranslateState,
        outbound: failedOutbound(context, event),
      }
  }
}) satisfies TranslateTurnEvent
