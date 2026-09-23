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

const Utf8MiBTextSchema = z
  .string()
  .min(1)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 1_048_576)

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
    sessionPin: OperationCapabilitySchema,
    sessionDeletion: OperationCapabilitySchema,
    sessionRun: OperationCapabilitySchema,
    sessionStop: OperationCapabilitySchema,
    sessionSteer: OperationCapabilitySchema,
    sessionReadState: OperationCapabilitySchema,
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
  /** Provider read state; absent when untracked or unknowable on this read. */
  unread: z.boolean().optional(),
  /** Provider pin state; absent when untracked or unknowable on this read. */
  pinned: z.boolean().optional(),
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

const SessionMessageAttachmentSchema = z.strictObject({
  id: IdentifierSchema,
  type: z.literal("file"),
  name: z
    .string()
    .min(1)
    .max(255)
    .refine(
      (value) =>
        !value.includes("/") &&
        !value.includes("\\") &&
        [...value].every((character) => {
          const code = character.charCodeAt(0)
          return code > 31 && code !== 127
        })
    ),
  contentType: z
    .string()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u
    )
    .optional(),
  status: z.strictObject({ type: z.literal("complete") }),
  content: z.array(z.never()).max(0),
})

/**
 * The failure a durable message carries when the provider failed its turn. The
 * run stream reports the same failure live, so a reload reads identically.
 */
export const SessionMessageErrorStatusSchema = z.strictObject({
  type: z.literal("incomplete"),
  reason: z.literal("error"),
  error: z.string().min(1).max(4096),
})

export const SessionMessageSchema = z.strictObject({
  id: IdentifierSchema,
  role: z.enum(["user", "assistant", "system"]),
  content: z.array(SessionMessagePartSchema).max(2_000),
  attachments: z.array(SessionMessageAttachmentSchema).max(16).optional(),
  createdAt: z.string().datetime(),
  /** When the turn's newest stored part landed; absent when the provider keeps no per-row time. */
  completedAt: z.string().datetime().optional(),
  // The two states a durable message may carry besides a plain completion: a
  // turn still waiting on the user, and a turn the provider failed. Both shapes
  // are the ones the workspace already renders for a live run.
  status: z
    .union([
      z.strictObject({
        type: z.literal("requires-action"),
        reason: z.literal("interrupt"),
      }),
      SessionMessageErrorStatusSchema,
    ])
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
    unread: z.boolean().optional(),
    pinned: z.boolean().optional(),
  })
  .refine(
    (value) =>
      [value.title, value.archived, value.unread, value.pinned].filter(
        (intent) => intent !== undefined
      ).length === 1,
    "Exactly one of title, archived, unread, pinned"
  )

export const RunStopResponseSchema = z.strictObject({
  status: z.enum(["stopping", "idle"]),
})
export type RunStopResponse = z.infer<typeof RunStopResponseSchema>

export const RunSteerRequestSchema = z.strictObject({
  requestId: IdentifierSchema,
  expectedRunId: IdentifierSchema,
  text: Utf8MiBTextSchema,
})
export type RunSteerRequest = z.infer<typeof RunSteerRequestSchema>

export const RunSteerResponseSchema = z.strictObject({
  status: z.enum(["steered", "queued"]),
})
export type RunSteerResponse = z.infer<typeof RunSteerResponseSchema>

const CapabilityUnavailableSchema = z.strictObject({
  status: z.literal("unavailable"),
  reason: z.string().min(1).max(256),
})
export const SlashCommandSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^\s/]+$/u),
  description: z.string().max(4_096).optional(),
})
export type SlashCommand = z.infer<typeof SlashCommandSchema>
export const MAX_SLASH_COMMANDS = 4_096
/**
 * How every runtime carries an approval or a question: as an ACP request the
 * operator answers over the same connection that serves the conversation.
 */
export const INTERACTION_PROTOCOL = "acp-request" as const
export const SessionWorkspaceCapabilitiesResponseSchema = z.strictObject({
  workspace: z.strictObject({
    slashCommands: z
      .union([
        z.strictObject({
          status: z.literal("available"),
          scope: z.literal("attached-session"),
          commands: z.array(SlashCommandSchema).max(MAX_SLASH_COMMANDS),
        }),
        CapabilityUnavailableSchema,
      ])
      .optional()
      .default({
        status: "unavailable",
        reason: "runtime-does-not-advertise-slash-commands",
      }),
    models: z.union([
      z.strictObject({
        status: z.literal("available"),
        scope: z.literal("attached-session"),
        selection: z.literal("native-session"),
        choices: z.literal("provider-reported"),
      }),
      CapabilityUnavailableSchema,
    ]),
    context: z.union([
      z.strictObject({
        status: z.literal("available"),
        scope: z.literal("attached-session"),
        source: z.literal("provider-usage-or-estimate"),
        breakdown: z.literal("provider-categories"),
      }),
      CapabilityUnavailableSchema,
    ]),
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
        source: z.literal("provider-session-state"),
      }),
      CapabilityUnavailableSchema,
    ]),
  }),
  interactions: z.strictObject({
    steering: z.union([
      z.strictObject({
        status: z.literal("available"),
        scope: z.literal("active-run"),
        semantics: z.literal("visible-user-message"),
        input: z.literal("text"),
        fallback: z.literal("provider-queue"),
      }),
      CapabilityUnavailableSchema,
    ]),
    approvals: z.strictObject({
      status: z.literal("available"),
      protocol: z.literal(INTERACTION_PROTOCOL),
      scope: z.literal("run"),
      choices: z
        .array(
          z.discriminatedUnion("value", [
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
          ])
        )
        .min(1)
        .max(4)
        .refine(
          (choices) =>
            new Set(choices.map(({ value }) => value)).size === choices.length,
          "Duplicate approval choice"
        ),
      maxPending: z.number().int().min(1).max(1_000),
    }),
    questions: z.strictObject({
      status: z.literal("available"),
      protocol: z.literal(INTERACTION_PROTOCOL),
      scope: z.literal("run"),
      answerModes: z.tuple([
        z.literal("single"),
        z.literal("multiple"),
        z.literal("free-text"),
      ]),
      cancellation: z.enum([
        "native-empty-answer",
        "native-reject",
        "native-cancel",
      ]),
      maxQuestions: z.number().int().min(1).max(1_000),
      maxChoicesPerQuestion: z.number().int().min(1).max(1_000),
      maxAnswerValuesPerQuestion: z.union([
        z.number().int().min(1).max(1_000),
        z.literal("complete-request"),
      ]),
      maxStringBytes: z.number().int().min(1).max(1_000_000),
    }),
    reactions: CapabilityUnavailableSchema,
  }),
  content: z.strictObject({
    attachments: z.union([
      z.strictObject({
        status: z.literal("available"),
        scope: z.literal("attached-session"),
        inputs: z.tuple([z.literal("image"), z.literal("file")]),
        imageMimeTypes: z.union([
          z.array(z.string().min(1).max(256)).max(32),
          z.literal("provider-dependent"),
        ]),
        fileMimeTypes: z.enum(["valid-type/subtype", "provider-dependent"]),
        maxMimeTypeBytes: z.number().int().positive(),
        maxFilenameBytes: z.number().int().positive(),
        maxCount: z.number().int().positive(),
        maxImageBytes: z.number().int().positive(),
        maxFileBytes: z.number().int().positive(),
        maxTotalBytes: z.union([
          z.number().int().positive(),
          z.literal("complete-request"),
        ]),
        maxEncodedRequestBytes: z.number().int().positive().optional(),
        completeRequestValidation: z.literal("native-run-input").optional(),
      }),
      CapabilityUnavailableSchema,
    ]),
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
        scope: z.literal("agent"),
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
        scope: z.literal("agent"),
        acceptedMimeTypes: z.array(z.string().min(1).max(256)).max(32),
        maxTextBytes: z.number().int().positive(),
        maxAudioBytes: z.number().int().positive(),
      }),
      CapabilityUnavailableSchema,
    ]),
  }),
})

export const GuestRuntimeCapabilitiesResponseSchema =
  SessionWorkspaceCapabilitiesResponseSchema.pick({
    workspace: true,
    interactions: true,
    content: true,
  }).extend({
    workspace: SessionWorkspaceCapabilitiesResponseSchema.shape.workspace
      .pick({ slashCommands: true })
      .optional()
      .default({
        slashCommands: {
          status: "unavailable",
          reason: "runtime-does-not-advertise-slash-commands",
        },
      }),
    interactions:
      SessionWorkspaceCapabilitiesResponseSchema.shape.interactions.extend({
        steering: CapabilityUnavailableSchema,
        approvals:
          SessionWorkspaceCapabilitiesResponseSchema.shape.interactions.shape.approvals.extend(
            {
              choices: z
                .array(
                  z.strictObject({
                    value: z.enum(["once", "session", "deny"]),
                    scope: z.enum(["request", "session"]),
                  })
                )
                .max(3),
            }
          ),
      }),
  })
export type GuestRuntimeCapabilitiesResponse = z.infer<
  typeof GuestRuntimeCapabilitiesResponseSchema
>

export const SessionModelsResponseSchema = z.strictObject({
  selectedId: IdentifierSchema,
  /** The provider-reported reasoning effort of the Session; absent = provider default. */
  effortId: IdentifierSchema.optional(),
  options: z
    .array(
      z.strictObject({
        id: IdentifierSchema,
        label: z.string().min(1).max(256),
        group: z.string().min(1).max(256),
        /** Provider-reported reasoning effort ids; absent when the model has none. */
        efforts: z.array(IdentifierSchema).min(1).max(16).optional(),
      })
    )
    .max(4_096),
})
export type SessionModelsResponse = z.infer<typeof SessionModelsResponseSchema>

/**
 * A partial update of the Session's model state: the model, its reasoning
 * effort, or both. At least one half must be present.
 */
export const SessionModelUpdateRequestSchema = z
  .strictObject({
    selectedId: IdentifierSchema.optional(),
    effortId: IdentifierSchema.optional(),
  })
  .refine(
    (patch) => patch.selectedId !== undefined || patch.effortId !== undefined,
    { message: "empty model update" }
  )
export type SessionModelUpdateRequest = z.infer<
  typeof SessionModelUpdateRequestSchema
>

/**
 * The Session's model state after the update, which is authoritative: a
 * provider may resolve the request to a model other than the requested id, and
 * the effort is absent while the Session runs on the provider's own default.
 */
export const SessionModelUpdateResponseSchema = z.strictObject({
  selectedId: IdentifierSchema,
  effortId: IdentifierSchema.optional(),
})
export type SessionModelUpdateResponse = z.infer<
  typeof SessionModelUpdateResponseSchema
>

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

/**
 * One published artifact, as every producer emits it and the browser accepts
 * it: only the identity, the name, and the source are guaranteed. A publishing
 * tool reports a media type and a size when it knows them.
 */
export const ArtifactDescriptorSchema = z.strictObject({
  id: IdentifierSchema,
  filename: z.string().min(1).max(4096),
  mimeType: z.string().min(1).max(256).optional(),
  sizeBytes: z.number().int().min(0).optional(),
  source: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("inline"),
      encoding: z.enum(["utf8", "base64"]),
      data: z.string(),
    }),
    z.strictObject({ type: z.literal("url"), url: z.string().url() }),
    z.strictObject({
      type: z.literal("provider"),
      reference: z.string().min(1),
    }),
  ]),
})
export type ArtifactDescriptor = z.infer<typeof ArtifactDescriptorSchema>

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
      "registration_limit_exceeded",
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
