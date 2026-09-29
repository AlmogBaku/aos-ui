import type {
  SessionUpdate,
  ToolCallContent,
  Usage,
} from "@agentclientprotocol/sdk/experimental/v2"

import {
  AOS_META_KEY,
  AosArtifactDescriptorSchema,
  AOS_STOP_REASONS,
  AosStateMetaSchema,
  AosSubagentSchema,
} from "../../../protocol/acp"
import {
  CompactionStatus,
  isAwaitingStopFailure,
  isUncertainFailure,
  sumTokenCounts,
  TurnEventKind,
  type Subagent,
  type TokenUsage,
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
import { pendingRequestToOutbound } from "./requests"
import {
  artifactOutbound,
  chunkOutbound,
  planUpdate,
  turnMeta,
  stateOutbound,
  TodosSchema,
  toolContentOutbound,
  ACP_STOP_REASON,
  diffContent,
  outputContent,
  textContent,
  toolOutbound,
  update,
} from "./updates"

const ACP_COMPACTION_STATUS = {
  [CompactionStatus.Started]: "in_progress",
  [CompactionStatus.Completed]: "completed",
  [CompactionStatus.Failed]: "failed",
  [CompactionStatus.Cancelled]: "cancelled",
} as const satisfies Record<CompactionStatus, string>

/**
 * The message a patch hangs off. The adapter names every message where it is
 * born, the way its history names it too; the reducer only passes the id on.
 * A patch without an id of its own lands on its call's message, else on the
 * message the adapter last named, and a turn id always exists.
 */
function attachedTo(
  state: TranslateState,
  context: TranslateContext,
  toolCallId?: string
) {
  return (
    (toolCallId === undefined ? undefined : state.toolMessages[toolCallId]) ??
    state.messageId ??
    context.turnId
  )
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

/** An update whose ACP fields carry every fact but the turn it belongs to. */
function turnUpdate(context: TranslateContext, value: SessionUpdate) {
  return update({ ...value, _meta: { [AOS_META_KEY]: turnMeta(context) } })
}

/** The subagent an event came from and, once seen, the call that spawned it. */
function attribution(state: TranslateState, subagentId: string | undefined) {
  if (subagentId === undefined) return {}
  const parentToolCallId = state.subagents[subagentId]
  return {
    subagentId,
    ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
  }
}

/**
 * Adapters are typed, not validated: a subagent the wire contract refuses is
 * dropped rather than costing the browser the whole tool meta.
 */
function wireSubagent(subagent: Subagent | undefined) {
  const parsed = AosSubagentSchema.safeParse(subagent)
  return parsed.success ? { subagent: parsed.data } : {}
}

/**
 * One ACP usage for the whole turn. ACP requires the input and output counts,
 * so a turn whose provider reported neither reports no usage rather than zeros.
 */
function turnUsage(entries: readonly TokenUsage[]): Usage | undefined {
  const counts = sumTokenCounts(entries)
  const { inputTokens, outputTokens } = counts
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  return {
    inputTokens,
    outputTokens,
    totalTokens: counts.totalTokens ?? inputTokens + outputTokens,
    ...(counts.reasoningTokens === undefined
      ? {}
      : { thoughtTokens: counts.reasoningTokens }),
    ...(counts.cachedInputTokens === undefined
      ? {}
      : { cachedReadTokens: counts.cachedInputTokens }),
    ...(counts.cachedWriteTokens === undefined
      ? {}
      : { cachedWriteTokens: counts.cachedWriteTokens }),
  }
}

function chunkStep(
  state: TranslateState,
  context: TranslateContext,
  event: TurnEventOf<
    typeof TurnEventKind.MessageChunk | typeof TurnEventKind.ThoughtChunk
  >
): Step {
  const message = event.kind === TurnEventKind.MessageChunk
  return {
    // A thought is its own message, so only a reply names where patches go.
    state: message ? { ...state, messageId: event.messageId } : state,
    outbound: [
      chunkOutbound(
        context,
        message ? "agent_message_chunk" : "agent_thought_chunk",
        event.messageId,
        event.text,
        attribution(state, event.subagentId)
      ),
    ],
  }
}

function artifactStep(
  state: TranslateState,
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.ArtifactPublished>
): Step {
  // Adapters are typed, not validated: the wire contract still refuses a
  // malformed descriptor, as it refuses malformed Todos below.
  const artifact = AosArtifactDescriptorSchema.safeParse(event.artifact)
  if (!artifact.success) return { state, outbound: [] }
  // A link is message content, so it lands on the message the adapter last
  // named: the reply its MEDIA line streamed in, or the one its tool ran in.
  return {
    state,
    outbound: [
      artifactOutbound(
        context,
        "agent_message_chunk",
        attachedTo(state, context),
        artifact.data
      ),
    ],
  }
}

function steerStep(
  state: TranslateState,
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.SteerAccepted>
): Step {
  // A provider that stores an accepted correction as a user turn at once
  // already showed it in the replayed history, so announcing it again would
  // show the same words twice. Acceptances arrive in the order history
  // recorded them, so counting them down is enough.
  if (context.steerAck === "in-history" && state.replayedCorrections > 0)
    return {
      state: { ...state, replayedCorrections: state.replayedCorrections - 1 },
      outbound: [],
    }
  return {
    state,
    outbound: [
      {
        kind: "steer-accepted",
        turnId: context.turnId,
        requestId: event.requestId,
        text: event.text,
        delivery: event.delivery,
      },
    ],
  }
}

/**
 * The prompt's message id the browser saw this turn under, mapped to the id
 * the provider saved it as. An agent message needs no entry: the adapter set
 * its id where it was born, the one history gives it. An id the wire contract
 * refuses drops the map.
 */
function savedIdsOf(
  event: TurnEventOf<
    typeof TurnEventKind.TurnEnded | typeof TurnEventKind.TurnFailed
  >
) {
  const { user } = event.saved ?? {}
  if (!user || user.messageId === user.savedId) return undefined
  const savedIds = AosStateMetaSchema.shape.savedIds.safeParse({
    [user.messageId]: user.savedId,
  })
  return savedIds.success ? savedIds.data : undefined
}

function endedOutbound(
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.TurnEnded>
): AcpOutbound[] {
  const outbound: AcpOutbound[] = []
  const savedIds = savedIdsOf(event)
  if (event.composerPrefill !== undefined)
    outbound.push({
      kind: "composer-prefill",
      turnId: context.turnId,
      text: event.composerPrefill,
    })
  const usage = event.usage && turnUsage(event.usage)
  outbound.push(
    stateOutbound(
      context,
      {
        state: "idle",
        stopReason: event.stopReason
          ? ACP_STOP_REASON[event.stopReason]
          : context.stopping
            ? "cancelled"
            : "end_turn",
        ...(usage ? { usage } : {}),
      },
      {
        ...(event.cost ? { cost: event.cost } : {}),
        ...(savedIds ? { savedIds } : {}),
      }
    )
  )
  return outbound
}

function requiresActionOutbound(
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.TurnRequiresAction>
): AcpOutbound[] {
  return [
    stateOutbound(context, { state: "requires_action" }),
    ...event.requests.map((request) => pendingRequestToOutbound(request)),
  ]
}

function failedOutbound(
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.TurnFailed>
): AcpOutbound[] {
  const failure = {
    ...(event.code ? { code: event.code } : {}),
    ...(event.message !== undefined
      ? { message: event.message.slice(0, 4_096) }
      : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.model ? { model: event.model } : {}),
  }
  const savedIds = savedIdsOf(event)
  return [
    stateOutbound(
      context,
      // A turn held on a question no client here can answer waits all the
      // same: only Stop ends it.
      isAwaitingStopFailure(event)
        ? { state: "requires_action" }
        : {
            state: "idle",
            stopReason: isUncertainFailure(event)
              ? AOS_STOP_REASONS.uncertain
              : AOS_STOP_REASONS.error,
          },
      { ...failure, ...(savedIds ? { savedIds } : {}) }
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
    ...(event.name ? { name: event.name } : {}),
    ...(event.toolKind ? { kind: event.toolKind } : {}),
    ...(event.locations ? { locations: event.locations } : {}),
  }
  const extra = {
    ...(event.startedAt ? { startedAt: event.startedAt } : {}),
    ...wireSubagent(event.subagent),
    ...attribution(state, event.subagentId),
    ...(event.app ? { app: {} } : {}),
  }
  const messageId = event.parentMessageId ?? attachedTo(state, context)
  const opened = openArgs(
    {
      ...state,
      messageId,
      toolMessages: { ...state.toolMessages, [event.toolCallId]: messageId },
    },
    event.toolCallId,
    ""
  )
  return {
    state: event.subagent
      ? {
          ...opened,
          subagents: {
            ...opened.subagents,
            [event.subagent.id]: event.toolCallId,
          },
        }
      : opened,
    outbound: [toolOutbound(context, messageId, call, extra)],
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
      toolOutbound(
        context,
        attachedTo(state, context, event.toolCallId),
        call,
        {
          argsTextDelta: event.delta,
        }
      ),
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
      toolOutbound(
        context,
        attachedTo(state, context, event.toolCallId),
        call,
        { argsText }
      ),
    ],
  }
}

function toolFinished(
  state: TranslateState,
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.ToolCallFinished>
): Step {
  // The settled content replaces everything streamed into the call, so it
  // restates the terminals the call announced.
  const terminals = Object.entries(state.terminals).flatMap(
    ([terminalId, toolCallId]): ToolCallContent[] =>
      toolCallId === event.toolCallId ? [{ type: "terminal", terminalId }] : []
  )
  const output = jsonOr(event.output, event.output)
  const call = {
    toolCallId: event.toolCallId,
    ...(event.name ? { title: event.name, name: event.name } : {}),
    status: event.failed ? "failed" : "completed",
    rawOutput: output,
    content: [
      outputContent(output),
      ...(event.diffs ?? []).map(diffContent),
      ...terminals,
    ],
    ...(event.locations ? { locations: event.locations } : {}),
  }
  const extra = {
    ...(event.completedAt ? { completedAt: event.completedAt } : {}),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.app ? { app: {} } : {}),
  }
  return {
    state,
    outbound: [
      toolOutbound(
        context,
        attachedTo(state, context, event.toolCallId),
        call,
        extra
      ),
    ],
  }
}

function toolOutputChunk(
  state: TranslateState,
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.ToolCallOutputChunk>
): AcpOutbound[] {
  return [
    toolContentOutbound(
      context,
      attachedTo(state, context, event.toolCallId),
      event.toolCallId,
      textContent(event.text)
    ),
  ]
}

/**
 * A terminal's first output announces it, both as ACP's terminal and as the
 * call's content; later output only appends. ACP carries terminal output as
 * base64 bytes, so the adapter's text travels as its UTF-8 encoding.
 */
function terminalStep(
  state: TranslateState,
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.TerminalOutput>
): Step {
  const { terminalId, command, cwd, data, exit } = event
  const first = state.terminals[terminalId] === undefined
  const outbound: AcpOutbound[] = []
  if (first || command !== undefined || cwd !== undefined)
    outbound.push(
      turnUpdate(context, {
        sessionUpdate: "terminal_update",
        terminalId,
        ...(command === undefined ? {} : { command }),
        ...(cwd === undefined ? {} : { cwd }),
      })
    )
  if (first)
    outbound.push(
      toolContentOutbound(
        context,
        attachedTo(state, context, event.toolCallId),
        event.toolCallId,
        {
          type: "terminal",
          terminalId,
        }
      )
    )
  if (data)
    outbound.push(
      turnUpdate(context, {
        sessionUpdate: "terminal_output_chunk",
        terminalId,
        data: Buffer.from(data, "utf8").toString("base64"),
      })
    )
  if (exit)
    outbound.push(
      turnUpdate(context, {
        sessionUpdate: "terminal_update",
        terminalId,
        exitStatus: exit,
      })
    )
  return {
    state: first
      ? {
          ...state,
          terminals: { ...state.terminals, [terminalId]: event.toolCallId },
        }
      : state,
    outbound,
  }
}

/** ACP admits a summary only on a completed compaction, an error on a failed one. */
function compactionOutbound(
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.CompactionUpdated>
): AcpOutbound[] {
  const { compactionId, status, summary, error } = event
  return [
    turnUpdate(context, {
      sessionUpdate: "compaction_update",
      compactionId,
      status: ACP_COMPACTION_STATUS[status],
      ...(status === CompactionStatus.Completed && summary !== undefined
        ? { summary: [{ type: "text", text: summary }] }
        : {}),
      ...(status === CompactionStatus.Failed && error !== undefined
        ? { error }
        : {}),
    }),
  ]
}

function subagentOutbound(
  state: TranslateState,
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.SubagentUpdated>
): AcpOutbound[] {
  const extra = wireSubagent(event.subagent)
  if (!extra.subagent) return []
  return [
    toolOutbound(
      context,
      attachedTo(state, context, event.toolCallId),
      { toolCallId: event.toolCallId },
      extra
    ),
  ]
}

function planOutbound(
  context: TranslateContext,
  event: TurnEventOf<typeof TurnEventKind.PlanUpdated>
): AcpOutbound[] {
  const todos = TodosSchema.safeParse(event.todos)
  return todos.success
    ? [update(planUpdate(todos.data, turnMeta(context)))]
    : []
}

export const translateTurnEvent = ((state, event: TurnEvent, context) => {
  switch (event.kind) {
    case TurnEventKind.TurnStarted:
      return {
        state,
        outbound: [
          stateOutbound(
            context,
            { state: "running" },
            event.startedAt ? { at: event.startedAt } : undefined
          ),
        ],
      }
    case TurnEventKind.MessageChunk:
    case TurnEventKind.ThoughtChunk:
      return chunkStep(state, context, event)
    case TurnEventKind.ToolCallStarted:
      return toolStarted(state, context, event)
    case TurnEventKind.ToolCallInputChunk:
      return toolInputChunk(state, context, event)
    case TurnEventKind.ToolCallInputEnded:
      return toolInputEnded(state, context, event)
    case TurnEventKind.ToolCallOutputChunk:
      return { state, outbound: toolOutputChunk(state, context, event) }
    case TurnEventKind.ToolCallFinished:
      return toolFinished(state, context, event)
    case TurnEventKind.TerminalOutput:
      return terminalStep(state, context, event)
    case TurnEventKind.CompactionUpdated:
      return { state, outbound: compactionOutbound(context, event) }
    case TurnEventKind.ModelChanged:
      return {
        state,
        outbound: [{ kind: "model-changed", modelId: event.modelId }],
      }
    case TurnEventKind.SubagentUpdated:
      return { state, outbound: subagentOutbound(state, context, event) }
    case TurnEventKind.PlanUpdated:
      return { state, outbound: planOutbound(context, event) }
    case TurnEventKind.ArtifactPublished:
      return artifactStep(state, context, event)
    case TurnEventKind.SteerAccepted:
      return steerStep(state, context, event)
    case TurnEventKind.TurnEnded:
      return {
        state: initialTranslateState,
        outbound: endedOutbound(context, event),
      }
    // A wait pauses the turn, so what the turn opened stays open.
    case TurnEventKind.TurnRequiresAction:
      return { state, outbound: requiresActionOutbound(context, event) }
    case TurnEventKind.TurnFailed:
      // A failure awaiting Stop reports on a run that is still going, so the
      // segment keeps its state until the run actually ends.
      return {
        state: isAwaitingStopFailure(event) ? state : initialTranslateState,
        outbound: failedOutbound(context, event),
      }
  }
}) satisfies TranslateTurnEvent
