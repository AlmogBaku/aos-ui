import { z } from "zod"
import {
  AgentCapabilitiesSchema as AgUiAgentCapabilitiesSchema,
  type AgentCapabilities,
} from "@ag-ui/core"

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

export const SessionStatusSchema = z.enum([
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
  status: z
    .strictObject({
      type: z.literal("requires-action"),
      reason: z.literal("interrupt"),
    })
    .optional(),
  metadata: z
    .strictObject({ custom: z.record(z.string(), z.json()) })
    .optional(),
})
export type SessionMessage = z.infer<typeof SessionMessageSchema>

const TodoSchema = z.strictObject({
  id: IdentifierSchema,
  label: z.string().min(1).max(4096),
  status: z.enum(["pending", "active", "completed", "failed"]),
})

export const SessionPlanActivityMessageSchema = z.strictObject({
  id: IdentifierSchema,
  role: z.literal("activity"),
  activityType: z.literal("PLAN"),
  content: z.strictObject({
    todos: z.array(TodoSchema).max(10_000),
  }),
})
export type SessionPlanActivityMessage = z.infer<
  typeof SessionPlanActivityMessageSchema
>

export const SessionHistoryResponseSchema = z.strictObject({
  sessionId: IdentifierSchema,
  messages: z
    .array(
      z.discriminatedUnion("role", [
        SessionMessageSchema,
        SessionPlanActivityMessageSchema,
      ])
    )
    .max(501),
  total: z.number().int().min(0),
  limit: z.number().int().min(1).max(500),
  offset: z.number().int().min(0),
  nextOffset: z.number().int().min(0),
  execution: z
    .strictObject({
      status: SessionStatusSchema,
      runId: IdentifierSchema.optional(),
    })
    .optional(),
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

const CapabilityUnavailableSchema = z.strictObject({
  status: z.literal("unavailable"),
  reason: z.string().min(1).max(256),
})
// AG-UI currently brings Zod 3 while AOS uses Zod 4. Embedding its schema in a
// Zod 4 object is invalid, so validate through the public AG-UI schema instead.
const AgentCapabilitiesSchema = z.custom<AgentCapabilities>(
  (value) => AgUiAgentCapabilitiesSchema.safeParse(value).success
)
export const SlashCommandSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^\s/]+$/u),
  description: z.string().max(4096).optional(),
})
export type SlashCommand = z.infer<typeof SlashCommandSchema>
export const SessionWorkspaceCapabilitiesResponseSchema = z.strictObject({
  agent: AgentCapabilitiesSchema,
  workspace: z.strictObject({
    slashCommands: z.union([
      z.strictObject({
        status: z.literal("available"),
        scope: z.literal("attached-session"),
        commands: z.array(SlashCommandSchema).max(256),
      }),
      CapabilityUnavailableSchema,
    ]),
    models: z.strictObject({
      status: z.literal("available"),
      scope: z.literal("attached-session"),
      selection: z.literal("native-session"),
      choices: z.literal("provider-reported"),
    }),
    context: z.strictObject({
      status: z.literal("available"),
      scope: z.literal("attached-session"),
      source: z.literal("provider-usage-or-estimate"),
      breakdown: z.literal("provider-categories"),
    }),
    todos: z.union([
      z.strictObject({
        status: z.literal("available"),
        scope: z.literal("session"),
        mode: z.literal("read-only-projection"),
        source: z.literal("latest-completed-todo-tool-result"),
      }),
      CapabilityUnavailableSchema,
    ]),
    activity: z.union([
      z.strictObject({
        status: z.literal("available"),
        scope: z.literal("attached-active-session"),
        coverage: z.literal("active-session-only"),
        source: z.literal("session.info"),
      }),
      CapabilityUnavailableSchema,
    ]),
  }),
  interactions: z.strictObject({
    approvals: z.strictObject({
      status: z.literal("available"),
      protocol: z.literal("ag-ui-interrupt"),
      scope: z.literal("run"),
      choices: z.tuple([
        z.strictObject({
          value: z.literal("once"),
          scope: z.literal("request"),
        }),
        z.strictObject({
          value: z.literal("session"),
          scope: z.literal("session"),
        }),
        z.strictObject({
          value: z.literal("always"),
          scope: z.literal("agent"),
        }),
        z.strictObject({
          value: z.literal("deny"),
          scope: z.literal("request"),
        }),
      ]),
      maxPending: z.number().int().min(1).max(1_000),
    }),
    questions: z.strictObject({
      status: z.literal("available"),
      protocol: z.literal("ag-ui-interrupt"),
      scope: z.literal("run"),
      answerModes: z.tuple([
        z.literal("single"),
        z.literal("multiple"),
        z.literal("free-text"),
      ]),
      cancellation: z.literal("native-empty-answer"),
      maxQuestions: z.number().int().min(1).max(1_000),
      maxChoicesPerQuestion: z.number().int().min(1).max(1_000),
      maxAnswerValuesPerQuestion: z.number().int().min(1).max(1_000),
      maxStringBytes: z.number().int().min(1).max(1_000_000),
    }),
    reactions: CapabilityUnavailableSchema,
  }),
  content: z.strictObject({
    attachments: z.strictObject({
      status: z.literal("available"),
      scope: z.literal("attached-session"),
      inputs: z.tuple([z.literal("image"), z.literal("file")]),
      imageMimeTypes: z.array(z.string().min(1).max(256)).max(32),
      fileMimeTypes: z.literal("valid-type/subtype"),
      maxMimeTypeBytes: z.number().int().positive(),
      maxFilenameBytes: z.number().int().positive(),
      maxCount: z.number().int().positive(),
      maxImageBytes: z.number().int().positive(),
      maxFileBytes: z.number().int().positive(),
      maxTotalBytes: z.number().int().positive(),
    }),
    artifacts: z.union([
      z.strictObject({
        status: z.literal("available"),
        scope: z.literal("session"),
        maxBytes: z.number().int().positive(),
      }),
      CapabilityUnavailableSchema,
    ]),
    transcription: z.union([
      z.strictObject({
        status: z.literal("available"),
        scope: z.literal("attached-session"),
        acceptedMimeTypes: z.array(z.string().min(1).max(256)).max(32),
        mimeParameter: z.literal("codecs"),
        codecValues: z.array(z.string().min(1).max(64)).max(32),
        maxRecordingBytes: z.number().int().positive(),
        maxTranscriptBytes: z.number().int().positive(),
      }),
      CapabilityUnavailableSchema,
    ]),
    speech: z.union([
      z.strictObject({
        status: z.literal("available"),
        scope: z.literal("attached-session"),
        acceptedMimeTypes: z.array(z.string().min(1).max(256)).max(32),
        maxTextBytes: z.number().int().positive(),
        maxAudioBytes: z.number().int().positive(),
      }),
      CapabilityUnavailableSchema,
    ]),
  }),
})
export const SessionModelsResponseSchema = z.strictObject({
  selectedId: IdentifierSchema,
  options: z
    .array(
      z.strictObject({
        id: IdentifierSchema,
        label: z.string().min(1).max(256),
        group: z.string().min(1).max(256),
      })
    )
    .max(4_096),
})
export type SessionModelsResponse = z.infer<typeof SessionModelsResponseSchema>

export const SessionModelSelectRequestSchema = z.strictObject({
  selectedId: IdentifierSchema,
})

export const SessionContextResponseSchema = z.strictObject({
  usedTokens: z.number().int().min(0),
  maxTokens: z.number().int().positive(),
  estimated: z.literal(true).optional(),
  source: z.enum([
    "provider-usage",
    "provider-usage-plus-estimate",
    "local-estimate",
  ]),
  breakdown: z
    .strictObject({
      systemTokens: z.number().int().min(0),
      toolTokens: z.number().int().min(0),
      messageTokens: z.number().int().min(0),
    })
    .optional(),
})
export type SessionContextResponse = z.infer<
  typeof SessionContextResponseSchema
>

export const SessionTodosResponseSchema = z.strictObject({
  todos: z.array(TodoSchema).max(10_000),
})
export type SessionTodosResponse = z.infer<typeof SessionTodosResponseSchema>

export const SessionActivityResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.enum([
      "session-not-attached",
      "session-idle",
      "session-info-unavailable",
    ]),
  }),
  z.strictObject({
    status: z.literal("available"),
    scope: z.literal("attached-active-session"),
    coverage: z.literal("active-session-only"),
    state: z.enum(["running", "waiting-for-input", "idle", "unknown"]),
  }),
])
export type SessionActivityResponse = z.infer<
  typeof SessionActivityResponseSchema
>

export const SessionInteractionSnapshotResponseSchema = z.strictObject({
  runId: IdentifierSchema,
  running: z.boolean(),
  status: z.enum(["waiting-for-input", "running", "idle", "unknown"]),
  outcome: z
    .strictObject({
      type: z.literal("interrupt"),
      interrupts: z
        .array(
          z.strictObject({
            id: IdentifierSchema,
            reason: z.string().min(1).max(256),
            message: z.string().max(65_536).optional(),
            toolCallId: IdentifierSchema.optional(),
            responseSchema: z.record(z.string(), z.unknown()).optional(),
            expiresAt: z.string().max(256).optional(),
            metadata: z.record(z.string(), z.unknown()).optional(),
            subagentRunId: IdentifierSchema.optional(),
          })
        )
        .min(1)
        .max(64),
    })
    .optional(),
})
export type SessionInteractionSnapshotResponse = z.infer<
  typeof SessionInteractionSnapshotResponseSchema
>

const SessionAttachmentSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("image"),
    dataUrl: z.string().min(1).max(35_000_000),
    filename: z.string().min(1).max(255).optional(),
  }),
  z.strictObject({
    type: z.literal("file"),
    dataUrl: z.string().min(1).max(35_000_000),
    filename: z.string().min(1).max(255).optional(),
    mimeType: z.string().min(1).max(256).optional(),
  }),
])
export const SessionAttachmentStageRequestSchema = z.strictObject({
  attachments: z.array(SessionAttachmentSchema).max(16),
})
export type SessionAttachmentStageRequest = z.infer<
  typeof SessionAttachmentStageRequestSchema
>
const PublicSessionAttachmentSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("image"),
    dataUrl: z.string().min(1).max(35_000_000),
    filename: z.string().min(1).max(255).optional(),
  }),
  z.strictObject({
    type: z.literal("file"),
    filename: z.string().min(1).max(255).optional(),
    mimeType: z.string().min(1).max(256),
  }),
])
export const SessionAttachmentStageResponseSchema = z.strictObject({
  stageId: IdentifierSchema,
  attachments: z.array(PublicSessionAttachmentSchema).max(16),
})
export type SessionAttachmentStageResponse = z.infer<
  typeof SessionAttachmentStageResponseSchema
>

const AudioReadinessSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready") }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.string().min(1).max(256),
  }),
  z.strictObject({
    status: z.literal("unverified"),
    reason: z.string().min(1).max(256),
  }),
])
export const SessionAudioResponseSchema = z.strictObject({
  transcription: AudioReadinessSchema,
  speech: AudioReadinessSchema,
})
export const SessionTranscriptionRequestSchema = z.strictObject({
  dataUrl: z.string().min(1).max(7_500_000),
  mimeType: z.string().min(1).max(128),
})
export const SessionTranscriptionResponseSchema = z.strictObject({
  transcript: z.string().max(1_000_000),
})
export const SessionSpeechRequestSchema = z.strictObject({
  text: z.string().min(1).max(32_000),
})

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
      "connection_interrupted",
      "uncertain_mutation",
      "internal_error",
    ]),
    description: z.string().min(1).max(512),
  }),
})
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>
