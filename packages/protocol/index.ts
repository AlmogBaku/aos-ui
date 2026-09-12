import { z } from "zod"

export const AOS_API_PREFIX = "/api/aos/v1" as const
export const SESSION_CATALOG_MAX_WINDOW = 1_000 as const

const IdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
  )

const OperatorSchema = z.strictObject({
  id: IdentifierSchema,
  displayName: z.string().min(1).max(256).optional(),
})

export const OperatorAuthStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unauthenticated") }),
  z.strictObject({
    status: z.literal("authenticated"),
    operator: OperatorSchema,
  }),
])
export type OperatorAuthState = z.infer<typeof OperatorAuthStateSchema>

export const RuntimeAuthStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("authenticated") }),
  z.strictObject({ status: z.literal("authentication-required") }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.literal("temporarily-unavailable"),
  }),
])
export type RuntimeAuthState = z.infer<typeof RuntimeAuthStateSchema>

const AvailableCapabilitySchema = z.strictObject({
  status: z.literal("available"),
  concurrency: z.literal("revision").optional(),
})
const UnavailableCapabilitySchema = z.strictObject({
  status: z.literal("unavailable"),
  reason: z.string().min(1).max(256),
})
export const OperationCapabilitySchema = z.discriminatedUnion("status", [
  AvailableCapabilitySchema,
  UnavailableCapabilitySchema,
])

const SessionCatalogCapabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    scope: z.literal("workspace"),
    order: z.literal("recent"),
    defaultPageSize: z.literal(50),
    maxPageSize: z.literal(100),
    maxWindow: z.literal(SESSION_CATALOG_MAX_WINDOW),
  }),
  UnavailableCapabilitySchema,
])

const SessionHistoryCapabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    order: z.literal("chronological"),
    compacted: z.literal(true),
    loading: z.literal("on-open"),
    defaultPageSize: z.literal(200),
    maxPageSize: z.literal(500),
  }),
  UnavailableCapabilitySchema,
])

export const RuntimeInfoSchema = z.strictObject({
  runtime: z.strictObject({
    id: IdentifierSchema,
    name: z.string().min(1).max(256),
  }),
  status: z.enum(["ready", "degraded", "unavailable"]),
  capabilities: z.strictObject({
    agentCatalog: OperationCapabilitySchema,
    agentVisibility: OperationCapabilitySchema,
    sessionCatalog: SessionCatalogCapabilitySchema,
    sessionHistory: SessionHistoryCapabilitySchema,
    sessionDetail: OperationCapabilitySchema,
    sessionCreation: OperationCapabilitySchema,
    sessionTitle: OperationCapabilitySchema,
    sessionArchival: OperationCapabilitySchema,
    sessionDeletion: OperationCapabilitySchema,
    sessionRun: OperationCapabilitySchema,
    sessionStop: OperationCapabilitySchema,
  }),
})
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>

const AgentSummarySchema = z.strictObject({
  kind: z.literal("ready"),
  id: IdentifierSchema,
  name: z.string().min(1).max(256),
  description: z.string().max(4096).optional(),
  status: z
    .enum(["idle", "active", "running", "attention", "unknown"])
    .optional(),
  activity: z.enum(["active", "idle", "unknown"]).optional(),
  visibility: z.enum(["visible", "hidden"]).optional(),
  role: z.literal("creator").optional(),
})

export const AgentCatalogEntrySchema = z.strictObject({
  summary: AgentSummarySchema,
  visibility: z.enum(["visible", "hidden"]),
  selectable: z.boolean(),
  editable: z.boolean(),
  revision: IdentifierSchema,
})
export type AgentCatalogEntry = z.infer<typeof AgentCatalogEntrySchema>

export const AgentCatalogResponseSchema = z.strictObject({
  revision: IdentifierSchema,
  agents: z.array(AgentCatalogEntrySchema).max(1_000),
})
export type AgentCatalogResponse = z.infer<typeof AgentCatalogResponseSchema>

export const VisibilityUpdateRequestSchema = z.strictObject({
  visibility: z.enum(["visible", "hidden"]),
  revision: IdentifierSchema,
})
export type VisibilityUpdateRequest = z.infer<
  typeof VisibilityUpdateRequestSchema
>

export const VisibilityUpdateResponseSchema = z.strictObject({
  revision: IdentifierSchema,
  agent: AgentCatalogEntrySchema,
})
export type VisibilityUpdateResponse = z.infer<
  typeof VisibilityUpdateResponseSchema
>

const SessionStatusSchema = z.enum([
  "idle",
  "running",
  "waiting-for-input",
  "failed",
  "unknown",
])
export const SessionSchema = z.strictObject({
  id: IdentifierSchema,
  agentId: IdentifierSchema,
  title: z.string().min(1).max(4096),
  archived: z.boolean(),
  updatedAt: z.string().datetime(),
  status: SessionStatusSchema,
})
export type Session = z.infer<typeof SessionSchema>
export const SessionCatalogResponseSchema = z.strictObject({
  sessions: z.array(SessionSchema).max(100),
  total: z.number().int().min(0),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0),
})
export type SessionCatalogResponse = z.infer<
  typeof SessionCatalogResponseSchema
>

const JsonRecordSchema = z.record(z.string(), z.json())
const SessionMessagePartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string().max(1_000_000) }),
  z.strictObject({
    type: z.literal("reasoning"),
    text: z.string().max(1_000_000),
  }),
  z.strictObject({
    type: z.literal("image"),
    image: z.string().min(1).max(25_000_000),
    filename: z.string().min(1).max(4096).optional(),
  }),
  z.strictObject({
    type: z.literal("tool-call"),
    toolCallId: IdentifierSchema,
    toolName: IdentifierSchema,
    args: JsonRecordSchema,
    argsText: z.string().max(1_000_000),
    result: z.json().optional(),
    isError: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("data"),
    name: IdentifierSchema,
    data: z.json(),
  }),
])

export const SessionMessageSchema = z.strictObject({
  id: IdentifierSchema,
  role: z.enum(["user", "assistant", "system"]),
  content: z.array(SessionMessagePartSchema).max(2_000),
  createdAt: z.string().datetime(),
})
export type SessionMessage = z.infer<typeof SessionMessageSchema>

export const SessionHistoryResponseSchema = z.strictObject({
  sessionId: IdentifierSchema,
  messages: z.array(SessionMessageSchema).max(500),
  total: z.number().int().min(0),
  limit: z.number().int().min(1).max(500),
  offset: z.number().int().min(0),
  nextOffset: z.number().int().min(0),
})
export type SessionHistoryResponse = z.infer<
  typeof SessionHistoryResponseSchema
>
export const SessionCreateRequestSchema = z.strictObject({
  title: z.string().min(1).max(4096).optional(),
})
export const SessionCreateResponseSchema = z.strictObject({
  session: z.strictObject({ id: IdentifierSchema, agentId: IdentifierSchema }),
})
export const SessionPatchRequestSchema = z
  .strictObject({
    title: z.string().min(1).max(4096).optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (value) => (value.title !== undefined) !== (value.archived !== undefined)
  )

export const RunStopResponseSchema = z.strictObject({
  status: z.enum(["stopping", "idle"]),
})
export type RunStopResponse = z.infer<typeof RunStopResponseSchema>

export const ErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      "unauthenticated",
      "forbidden",
      "invalid_request",
      "not_found",
      "revision_conflict",
      "run_conflict",
      "run_capacity_exceeded",
      "runtime_authentication_required",
      "temporarily_unavailable",
      "internal_error",
    ]),
  }),
})
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>
