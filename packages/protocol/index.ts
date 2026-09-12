import { z } from "zod"

export const AOS_API_PREFIX = "/api/aos/v1" as const

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

export const HermesAuthStateSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("authenticated"),
    method: z.enum(["static-token", "browser"]),
  }),
  z.strictObject({ status: z.literal("unauthenticated") }),
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.enum(["not-configured", "temporarily-unavailable"]),
  }),
])
export type HermesAuthState = z.infer<typeof HermesAuthStateSchema>

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

export const RuntimeInfoSchema = z.strictObject({
  runtime: z.strictObject({
    id: IdentifierSchema,
    name: z.string().min(1).max(256),
  }),
  status: z.enum(["ready", "degraded", "unavailable"]),
  capabilities: z.strictObject({
    agentCatalog: OperationCapabilitySchema,
    agentVisibility: OperationCapabilitySchema,
    sessionCreation: OperationCapabilitySchema,
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
export type SessionCatalogResponse = z.infer<typeof SessionCatalogResponseSchema>
export const SessionHistoryResponseSchema = z.strictObject({
  sessionId: IdentifierSchema,
  messages: z.array(z.unknown()).max(500),
  total: z.number().int().min(0),
  limit: z.number().int().min(1).max(500),
  offset: z.number().int().min(0),
})
export type SessionHistoryResponse = z.infer<typeof SessionHistoryResponseSchema>
export const SessionCreateRequestSchema = z.strictObject({
  title: z.string().min(1).max(4096).optional(),
})
export const SessionPatchRequestSchema = z
  .strictObject({ title: z.string().min(1).max(4096).optional(), archived: z.boolean().optional() })
  .refine((value) => (value.title !== undefined) !== (value.archived !== undefined))

export const ErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      "unauthenticated",
      "forbidden",
      "invalid_request",
      "not_found",
      "revision_conflict",
      "temporarily_unavailable",
      "internal_error",
    ]),
  }),
})
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>
