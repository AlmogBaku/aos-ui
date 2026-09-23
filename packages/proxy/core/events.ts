import { z } from "zod"

import {
  ArtifactDescriptorSchema,
  RunSteerResponseSchema,
  SessionTodosResponseSchema,
} from "../../protocol"

/**
 * Proxy-owned turn vocabulary.
 *
 * Adapters report what a provider turn did in these transport-free facts, the
 * coordinator journals and replays them, and only the ACP translator knows how
 * each one is spelled on the wire. Every kind carries the facts some reader
 * uses and nothing else, so a new provider maps onto a closed set of meanings
 * rather than a protocol's framing.
 */

/** Every kind of turn event the proxy carries from a runtime to its readers. */
export const TurnEventKind = {
  TurnStarted: "turn-started",
  /** The turn finished cleanly. */
  TurnEnded: "turn-ended",
  /** The turn paused on requests only the operator can answer. */
  TurnRequiresAction: "turn-requires-action",
  TurnFailed: "turn-failed",
  MessageChunk: "message-chunk",
  ThoughtChunk: "thought-chunk",
  ToolCallStarted: "tool-call-started",
  ToolCallInputChunk: "tool-call-input-chunk",
  ToolCallInputEnded: "tool-call-input-ended",
  ToolCallFinished: "tool-call-finished",
  PlanUpdated: "plan-updated",
  ArtifactPublished: "artifact-published",
  SteerAccepted: "steer-accepted",
} as const
export type TurnEventKind = (typeof TurnEventKind)[keyof typeof TurnEventKind]

/** What a pending request asks of the operator. */
export const PendingRequestKind = {
  /** Approve or deny an operation; the reply payload is the chosen option. */
  Permission: "permission",
  /** Answer questions; the reply payload is `{ answers: string[][] }`. */
  Elicitation: "elicitation",
} as const
export type PendingRequestKind =
  (typeof PendingRequestKind)[keyof typeof PendingRequestKind]

/** How the operator settled a pending request. */
export const ReplyStatus = {
  Resolved: "resolved",
  Cancelled: "cancelled",
} as const
export type ReplyStatus = (typeof ReplyStatus)[keyof typeof ReplyStatus]

/** A question or approval the provider is waiting on; it ends a turn segment. */
export const PendingRequestSchema = z.strictObject({
  requestId: z.string(),
  kind: z.enum([PendingRequestKind.Permission, PendingRequestKind.Elicitation]),
  message: z.string().optional(),
  toolCallId: z.string().optional(),
  /** JSON Schema of the expected answer: a permission's `enum` of choices. */
  responseSchema: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string().optional(),
})
export type PendingRequest = z.infer<typeof PendingRequestSchema>

/** The operator's answer to one pending request; it starts the next segment. */
export const RequestReplySchema = z.strictObject({
  requestId: z.string(),
  status: z.enum([ReplyStatus.Resolved, ReplyStatus.Cancelled]),
  payload: z.unknown().optional(),
})
export type RequestReply = z.infer<typeof RequestReplySchema>

/** What one provider call spent, as the provider reported it. */
export const TokenUsageSchema = z.strictObject({
  provider: z.string().optional(),
  model: z.string().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
})
export type TokenUsage = z.infer<typeof TokenUsageSchema>

const TOKEN_COUNT_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cachedInputTokens",
] as const

/** Sums usage per provider and model, dropping counts a provider omitted. */
export function aggregateTokenUsage(
  entries: readonly TokenUsage[]
): TokenUsage[] {
  const grouped = new Map<string, TokenUsage>()
  for (const entry of entries) {
    const key = `${entry.provider ?? ""} ${entry.model ?? ""}`
    const target = grouped.get(key) ?? {
      ...(entry.provider === undefined ? {} : { provider: entry.provider }),
      ...(entry.model === undefined ? {} : { model: entry.model }),
    }
    for (const field of TOKEN_COUNT_KEYS) {
      const value = entry[field]
      if (value === undefined) continue
      target[field] = (target[field] ?? 0) + value
    }
    grouped.set(key, target)
  }
  return [...grouped.values()]
}

/** One admitted user prompt. */
export const PromptTurnInputSchema = z.strictObject({
  turnId: z.string(),
  /** The user message this prompt becomes. */
  messageId: z.string(),
  prompt: z.string(),
  /** User turn to rewind before Edit or Retry; validated authoritatively. */
  rewindSourceId: z.string().optional(),
})
export type PromptTurnInput = z.infer<typeof PromptTurnInputSchema>

/** The replies that answer every request a paused turn is waiting on. */
export const RepliesTurnInputSchema = z.strictObject({
  turnId: z.string(),
  replies: z.array(RequestReplySchema).min(1),
})
export type RepliesTurnInput = z.infer<typeof RepliesTurnInputSchema>

/** What starts a turn segment: a prompt, or the replies that resume one. */
export const TurnInputSchema = z.union([
  PromptTurnInputSchema,
  RepliesTurnInputSchema,
])
export type TurnInput = z.infer<typeof TurnInputSchema>

export function isRepliesTurn(input: TurnInput): input is RepliesTurnInput {
  return "replies" in input
}

function turnEvent<
  const Kind extends TurnEventKind,
  const Shape extends z.ZodRawShape,
>(kind: Kind, shape: Shape) {
  return z.strictObject({ kind: z.literal(kind), ...shape })
}

export const TurnEventSchema = z.discriminatedUnion("kind", [
  turnEvent(TurnEventKind.TurnStarted, {}),
  turnEvent(TurnEventKind.TurnEnded, {
    usage: z.array(TokenUsageSchema).optional(),
    /** Text the provider asks the composer to start the next prompt with. */
    composerPrefill: z.string().optional(),
  }),
  turnEvent(TurnEventKind.TurnRequiresAction, {
    requests: z.array(PendingRequestSchema).min(1),
  }),
  turnEvent(TurnEventKind.TurnFailed, {
    code: z.string().optional(),
    message: z.string(),
    /**
     * The failure is final, but the provider's turn outlives it and ends only
     * when stopped: the turn stays active and stoppable, and its settlement,
     * not this event, ends it.
     */
    awaitingStop: z.literal(true).optional(),
  }),
  /** Assistant prose; `messageId` names the assistant message it belongs to. */
  turnEvent(TurnEventKind.MessageChunk, {
    messageId: z.string(),
    text: z.string(),
  }),
  /** Reasoning; `messageId` names the assistant message it reasons toward. */
  turnEvent(TurnEventKind.ThoughtChunk, {
    messageId: z.string(),
    text: z.string(),
  }),
  turnEvent(TurnEventKind.ToolCallStarted, {
    toolCallId: z.string(),
    title: z.string(),
    /** The assistant message that made the call. */
    parentMessageId: z.string().optional(),
  }),
  /** A piece of the call's JSON arguments text. */
  turnEvent(TurnEventKind.ToolCallInputChunk, {
    toolCallId: z.string(),
    delta: z.string(),
  }),
  turnEvent(TurnEventKind.ToolCallInputEnded, { toolCallId: z.string() }),
  turnEvent(TurnEventKind.ToolCallFinished, {
    toolCallId: z.string(),
    /** The result text; JSON when the tool returned structured output. */
    output: z.string(),
    /** The provider reported the call as failed. */
    failed: z.boolean(),
  }),
  /** The Session's whole Todo list, replacing the previous one. */
  turnEvent(TurnEventKind.PlanUpdated, {
    todos: SessionTodosResponseSchema.shape.todos,
  }),
  turnEvent(TurnEventKind.ArtifactPublished, {
    artifact: ArtifactDescriptorSchema,
  }),
  /** A mid-turn correction the provider accepted; the coordinator emits it. */
  turnEvent(TurnEventKind.SteerAccepted, {
    requestId: z.string(),
    text: z.string(),
    delivery: RunSteerResponseSchema.shape.status,
  }),
])
export type TurnEvent = z.infer<typeof TurnEventSchema>
export type TurnEventOf<Kind extends TurnEventKind> = Extract<
  TurnEvent,
  { kind: Kind }
>

/** Rejects anything an adapter may have emitted that is not a turn event. */
export function isTurnEvent(candidate: unknown): candidate is TurnEvent {
  return TurnEventSchema.safeParse(candidate).success
}

/** Error codes after which Send, Stop, steer, and replies must not be retried. */
export const UNCERTAIN_ERROR_CODES = [
  "AOS_SEND_UNCERTAIN",
  "AOS_INTERACTION_UNCERTAIN",
  "AOS_STOP_UNCERTAIN",
  "AOS_CONNECTION_INTERRUPTED",
  "AOS_RESET_REQUIRED",
] as const
export type UncertainErrorCode = (typeof UNCERTAIN_ERROR_CODES)[number]

export function isUncertainFailure(event: TurnEvent): boolean {
  return (
    event.kind === TurnEventKind.TurnFailed &&
    UNCERTAIN_ERROR_CODES.some((code) => code === event.code)
  )
}

/**
 * The codes an adapter publishes when it stopped consuming a turn that may
 * still be alive in the provider. The turn is not over, so its journal outlives
 * the failure and the browser reconciles by redialing with the same turn id. A
 * reset is deliberately absent: that cursor can never be served again, so its
 * journal must not be retained.
 */
export const REDIALABLE_ERROR_CODES = [
  "AOS_SEND_UNCERTAIN",
  "AOS_INTERACTION_UNCERTAIN",
  "AOS_STOP_UNCERTAIN",
  "AOS_CONNECTION_INTERRUPTED",
] as const

export function isRedialableFailure(event: TurnEvent): boolean {
  return (
    event.kind === TurnEventKind.TurnFailed &&
    REDIALABLE_ERROR_CODES.some((code) => code === event.code)
  )
}

/** A final failure the turn reports before its provider turn has been stopped. */
export function isAwaitingStopFailure(event: TurnEvent): boolean {
  return event.kind === TurnEventKind.TurnFailed && event.awaitingStop === true
}

/** Requests a segment's terminal event leaves waiting, if any. */
export function pendingRequestsOf(event: TurnEvent): PendingRequest[] {
  return event.kind === TurnEventKind.TurnRequiresAction ? event.requests : []
}

/**
 * Workspace-wide execution events published by the coordinator observer for
 * every Session it drives, independent of turn-stream subscribers. Timestamps
 * are RFC 3339 strings.
 */
export type ExecutionEvent = {
  agentId: string
  sessionId: string
  turnId: string
  occurredAt: string
} & (
  | { kind: "turn-started" | "turn-finished" | "turn-failed" }
  | { kind: "attention-requested"; request: PendingRequest }
  | { kind: "attention-resolved"; requestId: string }
)
