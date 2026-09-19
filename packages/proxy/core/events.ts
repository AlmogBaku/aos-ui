import { z } from "zod"

/**
 * Proxy-owned run vocabulary.
 *
 * One schema per kind the proxy's runtimes emit, in the wire shapes they
 * already produce, so the coordinator, the ACP layer, and the guest projection
 * share one definition and nothing in the proxy depends on an event library.
 * The discriminator stays `type` and every literal keeps its spelling: these
 * are the bytes on the wire, not an internal naming choice.
 */

/** Every kind of run event the proxy carries from a runtime to its readers. */
export const RunEventKind = {
  RUN_STARTED: "RUN_STARTED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
  REASONING_START: "REASONING_START",
  REASONING_END: "REASONING_END",
  REASONING_MESSAGE_START: "REASONING_MESSAGE_START",
  REASONING_MESSAGE_CONTENT: "REASONING_MESSAGE_CONTENT",
  REASONING_MESSAGE_END: "REASONING_MESSAGE_END",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_END: "TOOL_CALL_END",
  TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
  ACTIVITY_SNAPSHOT: "ACTIVITY_SNAPSHOT",
  ACTIVITY_DELTA: "ACTIVITY_DELTA",
  CUSTOM: "CUSTOM",
} as const
export type RunEventKind = (typeof RunEventKind)[keyof typeof RunEventKind]

/**
 * Open by key: any JSON value under any key, and no key required. Provider
 * metadata, reply schemas, and activity payloads are all this shape, and
 * validating their interiors would contradict being open.
 */
const OpenRecordSchema = z.record(z.string(), z.any())

/** Fields every run event carries, whatever its kind. */
const baseEventFields = {
  timestamp: z.number().optional(),
  rawEvent: z.any().optional(),
  metadata: OpenRecordSchema.optional(),
}

/** Base fields plus the attribution every kind a subagent can emit carries. */
const subagentAttributedFields = {
  ...baseEventFields,
  subagentRunId: z.string().optional(),
}

/** Who an assistant-visible text message is attributed to. */
const TextMessageRoleSchema = z.enum([
  "developer",
  "system",
  "assistant",
  "user",
])

/** A question or approval the provider is waiting on; it ends a run segment. */
export const PendingRequestSchema = z.object({
  id: z.string(),
  reason: z.string(),
  message: z.string().optional(),
  toolCallId: z.string().optional(),
  responseSchema: OpenRecordSchema.optional(),
  expiresAt: z.string().optional(),
  metadata: OpenRecordSchema.optional(),
  subagentRunId: z.string().optional(),
})
export type PendingRequest = z.infer<typeof PendingRequestSchema>

/** The operator's answer to one pending request; it starts the next segment. */
export const RequestReplySchema = z.object({
  interruptId: z.string(),
  status: z.enum(["resolved", "cancelled"]),
  payload: z.any().optional(),
  metadata: OpenRecordSchema.optional(),
})
export type RequestReply = z.infer<typeof RequestReplySchema>

/** How a run segment ended: cleanly, or waiting on the operator. */
export const RunOutcomeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("success") }),
  z.strictObject({
    type: z.literal("interrupt"),
    interrupts: z.array(PendingRequestSchema).min(1),
  }),
])
export type RunOutcome = z.infer<typeof RunOutcomeSchema>

/** What one provider call spent, as the provider reported it. */
export const TokenUsageSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
})
export type TokenUsage = z.infer<typeof TokenUsageSchema>

/** One part of a user turn the proxy admits; prose only, never a blob. */
const TurnTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
})

/** The only message the proxy ever builds: the user turn being admitted. */
const TurnMessageSchema = z.object({
  id: z.string(),
  role: z.literal("user"),
  content: z.union([z.string(), z.array(TurnTextPartSchema)]),
})

/** A tool the caller offers the runtime for this turn. */
const TurnToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.any().optional(),
  metadata: OpenRecordSchema.optional(),
})

/** Ambient information the caller attaches to this turn. */
const TurnContextSchema = z.object({
  description: z.string(),
  value: z.string(),
})

/** One admitted user turn, or a batch of request replies. */
export const TurnInputSchema = z.object({
  threadId: z.string(),
  runId: z.string(),
  parentRunId: z.string().optional(),
  state: z
    .any()
    .optional()
    .transform((value) => value ?? undefined),
  messages: z.array(TurnMessageSchema),
  tools: z.array(TurnToolSchema),
  context: z.array(TurnContextSchema),
  forwardedProps: z.any().optional(),
  resume: z.array(RequestReplySchema).optional(),
})
export type TurnInput = z.infer<typeof TurnInputSchema>

const RunStartedEventSchema = z.looseObject({
  ...baseEventFields,
  type: z.literal(RunEventKind.RUN_STARTED),
  threadId: z.string(),
  runId: z.string(),
  parentRunId: z.string().optional(),
  input: TurnInputSchema.optional(),
})

const RunFinishedEventSchema = z.looseObject({
  ...baseEventFields,
  type: z.literal(RunEventKind.RUN_FINISHED),
  threadId: z.string(),
  runId: z.string(),
  result: z.any().optional(),
  // Released producers emitted `null` before omitting empty fields; tolerate it
  // and normalize, as the shapes on the wire already do.
  outcome: RunOutcomeSchema.nullable()
    .optional()
    .transform((value) => value ?? undefined),
  usage: z.array(TokenUsageSchema).optional(),
})

const RunErrorEventSchema = z.looseObject({
  ...baseEventFields,
  type: z.literal(RunEventKind.RUN_ERROR),
  message: z.string(),
  code: z.string().optional(),
  usage: z.array(TokenUsageSchema).optional(),
})

const TextMessageStartEventSchema = z.looseObject({
  ...subagentAttributedFields,
  type: z.literal(RunEventKind.TEXT_MESSAGE_START),
  messageId: z.string(),
  role: TextMessageRoleSchema.default("assistant"),
  name: z.string().optional(),
})

const TextMessageContentEventSchema = z.looseObject({
  ...subagentAttributedFields,
  type: z.literal(RunEventKind.TEXT_MESSAGE_CONTENT),
  messageId: z.string(),
  delta: z.string(),
})

const TextMessageEndEventSchema = z.looseObject({
  ...subagentAttributedFields,
  type: z.literal(RunEventKind.TEXT_MESSAGE_END),
  messageId: z.string(),
})

const ReasoningStartEventSchema = z.looseObject({
  ...subagentAttributedFields,
  type: z.literal(RunEventKind.REASONING_START),
  messageId: z.string(),
})

const ReasoningEndEventSchema = z.looseObject({
  ...subagentAttributedFields,
  type: z.literal(RunEventKind.REASONING_END),
  messageId: z.string(),
})

const ReasoningMessageStartEventSchema = z.looseObject({
  ...subagentAttributedFields,
  type: z.literal(RunEventKind.REASONING_MESSAGE_START),
  messageId: z.string(),
  role: z.literal("reasoning"),
})

const ReasoningMessageContentEventSchema = z.looseObject({
  ...subagentAttributedFields,
  type: z.literal(RunEventKind.REASONING_MESSAGE_CONTENT),
  messageId: z.string(),
  delta: z.string(),
})

const ReasoningMessageEndEventSchema = z.looseObject({
  ...subagentAttributedFields,
  type: z.literal(RunEventKind.REASONING_MESSAGE_END),
  messageId: z.string(),
})

const ToolCallStartEventSchema = z.looseObject({
  ...subagentAttributedFields,
  type: z.literal(RunEventKind.TOOL_CALL_START),
  toolCallId: z.string(),
  toolCallName: z.string(),
  // As with `outcome`, `null` is what released producers sent for "no parent".
  parentMessageId: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? undefined),
})

const ToolCallArgsEventSchema = z.looseObject({
  ...subagentAttributedFields,
  type: z.literal(RunEventKind.TOOL_CALL_ARGS),
  toolCallId: z.string(),
  delta: z.string(),
})

const ToolCallEndEventSchema = z.looseObject({
  ...subagentAttributedFields,
  type: z.literal(RunEventKind.TOOL_CALL_END),
  toolCallId: z.string(),
})

const ToolCallResultEventSchema = z.looseObject({
  ...subagentAttributedFields,
  type: z.literal(RunEventKind.TOOL_CALL_RESULT),
  messageId: z.string(),
  toolCallId: z.string(),
  content: z.string(),
  role: z.literal("tool").optional(),
})

const ActivitySnapshotEventSchema = z.looseObject({
  ...subagentAttributedFields,
  type: z.literal(RunEventKind.ACTIVITY_SNAPSHOT),
  messageId: z.string(),
  activityType: z.string(),
  content: OpenRecordSchema,
  replace: z.boolean().default(true),
})

const ActivityDeltaEventSchema = z.looseObject({
  ...subagentAttributedFields,
  type: z.literal(RunEventKind.ACTIVITY_DELTA),
  messageId: z.string(),
  activityType: z.string(),
  patch: z.array(z.any()),
})

const CustomEventSchema = z.looseObject({
  ...subagentAttributedFields,
  type: z.literal(RunEventKind.CUSTOM),
  name: z.string(),
  value: z.any().optional(),
})

export const RunEventSchema = z.discriminatedUnion("type", [
  RunStartedEventSchema,
  RunFinishedEventSchema,
  RunErrorEventSchema,
  TextMessageStartEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  ReasoningStartEventSchema,
  ReasoningEndEventSchema,
  ReasoningMessageStartEventSchema,
  ReasoningMessageContentEventSchema,
  ReasoningMessageEndEventSchema,
  ToolCallStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallEndEventSchema,
  ToolCallResultEventSchema,
  ActivitySnapshotEventSchema,
  ActivityDeltaEventSchema,
  CustomEventSchema,
])
export type RunEvent = z.infer<typeof RunEventSchema>
export type RunEventOf<Kind extends RunEventKind> = Extract<
  RunEvent,
  { type: Kind }
>

/** Rejects anything an adapter may have emitted that is not a run event. */
export function isRunEvent(candidate: unknown): candidate is RunEvent {
  return RunEventSchema.safeParse(candidate).success
}

/** Error codes after which Send, Stop, steer, and replies must not be retried. */
export const UNCERTAIN_ERROR_CODES = [
  "AOS_SEND_UNCERTAIN",
  "AOS_INTERACTION_UNCERTAIN",
  "AOS_CONNECTION_INTERRUPTED",
  "AOS_RESET_REQUIRED",
] as const
export type UncertainErrorCode = (typeof UNCERTAIN_ERROR_CODES)[number]

export function isUncertainError(event: RunEvent): boolean {
  return (
    event.type === RunEventKind.RUN_ERROR &&
    UNCERTAIN_ERROR_CODES.some((code) => code === event.code)
  )
}

/**
 * Workspace-wide execution events published by the coordinator observer for
 * every Session it drives, independent of run-stream subscribers. Timestamps
 * are RFC 3339 strings.
 */
export type ExecutionEvent = {
  agentId: string
  sessionId: string
  runId: string
  occurredAt: string
} & (
  | { type: "run-started" | "run-finished" | "run-failed" }
  | { type: "attention-requested"; request: PendingRequest }
  | { type: "attention-resolved"; interruptId: string }
)

/** Pending requests carried by a segment's terminal event, if any. */
export function pendingRequestsOf(event: RunEvent): PendingRequest[] {
  if (event.type !== RunEventKind.RUN_FINISHED) return []
  return event.outcome?.type === "interrupt" ? event.outcome.interrupts : []
}
