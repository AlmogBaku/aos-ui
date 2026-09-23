import { z } from "zod"

import {
  ArtifactDescriptorSchema,
  StopReason,
  ToolDiffSchema,
  ToolKind,
  ToolLocationSchema,
  TurnSteerResponseSchema,
  SessionTodosResponseSchema,
} from "../../protocol"

// The facts a stored Session message also carries live in the protocol, so a
// reload replays them; adapters keep reaching them through this vocabulary.
export {
  DiffChangeSchema,
  DiffOperation,
  StopReason,
  ToolDiffSchema,
  ToolKind,
  ToolLocationSchema,
  type ToolDiff,
  type ToolLocation,
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
  /** A piece of the text a running call has produced so far. */
  ToolCallOutputChunk: "tool-call-output-chunk",
  ToolCallFinished: "tool-call-finished",
  /** Output and exit of a terminal a tool call runs. */
  TerminalOutput: "terminal-output",
  /** The provider compacted the conversation's context. */
  CompactionUpdated: "compaction-updated",
  /** The Session now runs on another model. */
  ModelChanged: "model-changed",
  /** Progress of a subagent a tool call spawned. */
  SubagentUpdated: "subagent-updated",
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

const CountSchema = z.number().int().nonnegative()

/** What one provider call spent, as the provider reported it. */
export const TokenUsageSchema = z.strictObject({
  provider: z.string().optional(),
  model: z.string().optional(),
  inputTokens: CountSchema.optional(),
  outputTokens: CountSchema.optional(),
  totalTokens: CountSchema.optional(),
  reasoningTokens: CountSchema.optional(),
  /** Input tokens read from the provider's prompt cache. */
  cachedInputTokens: CountSchema.optional(),
  /** Input tokens written to the provider's prompt cache. */
  cachedWriteTokens: CountSchema.optional(),
})
export type TokenUsage = z.infer<typeof TokenUsageSchema>

const TOKEN_COUNT_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cachedInputTokens",
  "cachedWriteTokens",
] as const

export type TokenCounts = Omit<TokenUsage, "provider" | "model">

/** Sums every entry's counts, dropping counts no entry reported. */
export function sumTokenCounts(entries: readonly TokenUsage[]): TokenCounts {
  const total: TokenCounts = {}
  for (const entry of entries)
    for (const field of TOKEN_COUNT_KEYS) {
      const value = entry[field]
      if (value !== undefined) total[field] = (total[field] ?? 0) + value
    }
  return total
}

/** Sums usage per provider and model, dropping counts a provider omitted. */
export function aggregateTokenUsage(
  entries: readonly TokenUsage[]
): TokenUsage[] {
  const grouped = new Map<string, TokenUsage[]>()
  for (const entry of entries) {
    const key = `${entry.provider ?? ""} ${entry.model ?? ""}`
    grouped.set(key, [...(grouped.get(key) ?? []), entry])
  }
  return [...grouped.values()].map((group) => {
    const { provider, model } = group[0]!
    return {
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...sumTokenCounts(group),
    }
  })
}

/** What a turn cost, as the provider priced it; ISO 4217 currency. */
export const CostSchema = z.strictObject({
  amount: z.number().nonnegative(),
  currency: z.string().min(1).max(16),
})
export type Cost = z.infer<typeof CostSchema>

/** Timestamps are UTC ISO 8601, as `Date.prototype.toISOString` writes them. */
const TimestampSchema = z.string().datetime()

/** How far a delegated subagent has got. */
export const SubagentStatus = {
  Running: "running",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const
export type SubagentStatus =
  (typeof SubagentStatus)[keyof typeof SubagentStatus]

/**
 * A subagent a tool call delegated to, keyed by `id`. A later report is a
 * patch: it restates only what changed.
 */
export const SubagentSchema = z.strictObject({
  id: z.string().min(1),
  goal: z.string().optional(),
  model: z.string().min(1).optional(),
  /** 1 for a subagent the turn spawned, 2 for one that subagent spawned. */
  depth: z.number().int().min(1).optional(),
  status: z.enum(SubagentStatus).optional(),
  /** Every token the subagent spent. */
  tokens: CountSchema.optional(),
  filesRead: z.array(z.string()).optional(),
  filesWritten: z.array(z.string()).optional(),
  durationMs: CountSchema.optional(),
  /** The provider Session the subagent runs in, when it has its own. */
  childSessionId: z.string().min(1).optional(),
  summary: z.string().optional(),
})
export type Subagent = z.infer<typeof SubagentSchema>

/** Where a compaction has got. */
export const CompactionStatus = {
  Started: "started",
  Completed: "completed",
  Failed: "failed",
  /** It ended unconfirmed: nothing says the context was compacted. */
  Cancelled: "cancelled",
} as const
export type CompactionStatus =
  (typeof CompactionStatus)[keyof typeof CompactionStatus]

/**
 * The subagent that produced an event; absent means the turn's own agent did.
 * Only what a subagent streams back into its parent's turn carries it.
 */
const subagentId = z.string().min(1).optional()

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

/** What starts a turn segment: a prompt, or the replies that continue one. */
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
    /** Absent reads as `EndTurn`, or `Cancelled` once Stop was requested. */
    stopReason: z.enum(StopReason).optional(),
    /** Every provider call of the turn; readers sum them into one usage. */
    usage: z.array(TokenUsageSchema).optional(),
    cost: CostSchema.optional(),
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
    /** The provider and model the turn ran on, when the failure names them. */
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  }),
  /** Assistant prose; `messageId` names the assistant message it belongs to. */
  turnEvent(TurnEventKind.MessageChunk, {
    messageId: z.string(),
    text: z.string(),
    subagentId,
  }),
  /** Reasoning; `messageId` names the assistant message it reasons toward. */
  turnEvent(TurnEventKind.ThoughtChunk, {
    messageId: z.string(),
    text: z.string(),
    subagentId,
  }),
  turnEvent(TurnEventKind.ToolCallStarted, {
    toolCallId: z.string(),
    /** What a reader shows for the call. */
    title: z.string(),
    /** The canonical tool name, the one tool presentation keys on. */
    name: z.string().min(1).optional(),
    /** Named apart from the event's own `kind` discriminator. */
    toolKind: z.enum(ToolKind).optional(),
    locations: z.array(ToolLocationSchema).optional(),
    startedAt: TimestampSchema.optional(),
    /** The assistant message that made the call. */
    parentMessageId: z.string().optional(),
    /** The subagent this call delegated to. */
    subagent: SubagentSchema.optional(),
    subagentId,
  }),
  /** A piece of the call's JSON arguments text. */
  turnEvent(TurnEventKind.ToolCallInputChunk, {
    toolCallId: z.string(),
    delta: z.string(),
  }),
  turnEvent(TurnEventKind.ToolCallInputEnded, { toolCallId: z.string() }),
  /** Streamed output a later `ToolCallFinished` replaces with the whole. */
  turnEvent(TurnEventKind.ToolCallOutputChunk, {
    toolCallId: z.string(),
    text: z.string(),
  }),
  turnEvent(TurnEventKind.ToolCallFinished, {
    toolCallId: z.string(),
    /** The result text; JSON when the tool returned structured output. */
    output: z.string(),
    /** The provider reported the call as failed. */
    failed: z.boolean(),
    /** The files the call changed. */
    diffs: z.array(ToolDiffSchema).optional(),
    /** Replaces the locations the call started with. */
    locations: z.array(ToolLocationSchema).optional(),
    completedAt: TimestampSchema.optional(),
    /** How long the call ran, for a provider that reports a span. */
    durationMs: CountSchema.optional(),
  }),
  /**
   * One step of a terminal a tool call runs, after that call started: the
   * first names the command, `data` appends plain text, `exit` ends it.
   */
  turnEvent(TurnEventKind.TerminalOutput, {
    terminalId: z.string().min(1),
    toolCallId: z.string(),
    command: z.string().optional(),
    /** Absolute working directory. */
    cwd: z.string().min(1).optional(),
    data: z.string().optional(),
    /** Present once the process exited, even when neither value is known. */
    exit: z
      .strictObject({
        exitCode: z.number().int().optional(),
        signal: z.string().min(1).optional(),
      })
      .optional(),
  }),
  /** `summary` belongs to a completed compaction, `error` to a failed one. */
  turnEvent(TurnEventKind.CompactionUpdated, {
    compactionId: z.string().min(1),
    status: z.enum(CompactionStatus),
    summary: z.string().optional(),
    error: z.string().optional(),
  }),
  /** `modelId` is the model's id in the Session's model catalog. */
  turnEvent(TurnEventKind.ModelChanged, { modelId: z.string().min(1) }),
  /** A patch of the subagent `toolCallId` spawned. */
  turnEvent(TurnEventKind.SubagentUpdated, {
    toolCallId: z.string(),
    subagent: SubagentSchema,
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
    delivery: TurnSteerResponseSchema.shape.status,
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
