import { z } from "zod"

import {
  AgentCatalogResponseSchema,
  RunSteerResponseSchema,
  SessionContextResponseSchema,
  SessionMessageErrorStatusSchema,
  SessionStatusSchema,
  SessionTodosResponseSchema,
  SessionWorkspaceCapabilitiesResponseSchema,
  VisibilityUpdateRequestSchema,
  VisibilityUpdateResponseSchema,
} from "./index"

/**
 * The AOS extension contract carried over ACP v2 between the Bun proxy (agent
 * side) and the browser (client side). ACP defines the run stream, sessions,
 * config options, permissions, and plans; everything AOS needs beyond that
 * travels as underscore-prefixed extension methods and `_meta.aos` payloads
 * defined here. Both ends import this module and nothing else defines these
 * shapes.
 */

export const ACP_PROTOCOL_VERSION = 2 as const
export const AOS_ACP_OPERATOR_PATH = "/api/aos/v1/acp" as const
export const AOS_ACP_GUEST_PATH = "/api/guest/v1/acp" as const
export const AOS_META_KEY = "aos" as const
export const AOS_EXTENSION_VERSION = 1 as const
export const AOS_AUTH_METHOD_INVITE = "aos-invite" as const
export const AOS_ATTACHMENT_URI_SCHEME = "aos-attachment:" as const

export const AOS_METHODS = {
  session: {
    update: "_aos/session/update",
    steer: "_aos/session/steer",
    focus: "_aos/session/focus",
  },
  agents: {
    list: "_aos/agents/list",
    setVisibility: "_aos/agents/set_visibility",
  },
  notify: {
    activity: "_aos/activity",
    artifact: "_aos/artifact",
    steerAccepted: "_aos/steer_accepted",
    composerPrefill: "_aos/composer_prefill",
    catalogInvalidated: "_aos/catalog_invalidated",
    sessionInvalidated: "_aos/session_invalidated",
    error: "_aos/error",
  },
} as const

/** Vendor stop reasons used on `state_update { state: "idle" }`. */
export const AOS_STOP_REASONS = {
  error: "_aos_error",
  uncertain: "_aos_uncertain",
} as const

/** Vendor permission option kind for Hermes' "allow for this session" scope. */
export const AOS_PERMISSION_KIND_SESSION = "_allow_session" as const

/** The single plan a Session carries: its Todos. */
export const AOS_PLAN_ID = "todos" as const

/**
 * JSON-RPC error codes the proxy returns beyond the standard ones. Both ends
 * import this table; the proxy maps `ServerRuntimePublicError` codes onto it.
 */
export const AOS_JSONRPC_ERRORS = {
  authenticationRequired: -32001,
  runInProgress: -32002,
  staleInterrupt: -32003,
  notFound: -32004,
  revisionConflict: -32005,
  temporarilyUnavailable: -32006,
  connectionInterrupted: -32007,
  uncertainMutation: -32008,
  invalidRequest: -32602,
} as const
export type AosJsonRpcErrorCode =
  (typeof AOS_JSONRPC_ERRORS)[keyof typeof AOS_JSONRPC_ERRORS]

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
const SequenceSchema = z.number().int().min(0)
const LaneSchema = z.enum(["operator", "guest"])

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export const AosExtensionsSchema = z.strictObject({
  steer: z.boolean(),
  rewind: z.boolean(),
  artifacts: z.boolean(),
  composerPrefill: z.boolean(),
  agents: z.boolean(),
  invalidation: z.boolean(),
  activity: z.boolean(),
  readState: z.boolean(),
  focus: z.boolean(),
  guestProjection: z.boolean(),
})
export type AosExtensions = z.infer<typeof AosExtensionsSchema>

/** `InitializeResponse._meta.aos` */
export const AosInitializeMetaSchema = z.strictObject({
  version: z.literal(AOS_EXTENSION_VERSION),
  lane: LaneSchema,
  extensions: AosExtensionsSchema,
})
export type AosInitializeMeta = z.infer<typeof AosInitializeMetaSchema>

/** `LoginAuthRequest._meta.aos` for the guest lane. */
export const AosLoginMetaSchema = z.strictObject({
  token: z.string().min(1).max(4096),
})

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

/** `NewSessionRequest._meta.aos` */
export const AosSessionNewMetaSchema = z.strictObject({
  agentId: IdentifierSchema,
  title: z.string().min(1).max(4096).optional(),
})

/** `ListSessionsRequest._meta.aos` */
export const AosSessionListMetaSchema = z.strictObject({
  agentId: IdentifierSchema.optional(),
})

/**
 * `SessionInfo._meta.aos` on `session/list` entries and
 * `session_info_update._meta.aos`. `unread` is absent when the runtime does not
 * track read state or this read cannot know it; absent never overwrites a
 * known value.
 */
export const AosSessionInfoMetaSchema = z.strictObject({
  agentId: IdentifierSchema,
  status: SessionStatusSchema,
  archived: z.boolean(),
  unread: z.boolean().optional(),
})
export type AosSessionInfoMeta = z.infer<typeof AosSessionInfoMetaSchema>

export const AosExecutionSchema = z.strictObject({
  status: SessionStatusSchema,
  runId: IdentifierSchema.optional(),
})

/** `NewSessionResponse._meta.aos` */
export const AosSessionNewResponseMetaSchema = z.strictObject({
  session: AosSessionInfoMetaSchema,
  capabilities: SessionWorkspaceCapabilitiesResponseSchema,
})

/** `ResumeSessionRequest._meta.aos` */
export const AosSessionResumeMetaSchema = z.strictObject({
  /** Owning Agent, when the client knows it before listing (deep links). */
  agentId: IdentifierSchema.optional(),
  /** Last `_meta.aos.sequence` the client saw for `runId`. */
  after: SequenceSchema.optional(),
  runId: IdentifierSchema.optional(),
})

/**
 * `PromptResponse._meta.aos`. The pinned SDK's v2 `PromptResponse` has no
 * `messageId` field and its client parser strips unknown keys, so the proxy's
 * minted user message id travels here.
 */
export const AosPromptResponseMetaSchema = z.strictObject({
  messageId: IdentifierSchema,
})

/**
 * `ResumeSessionResponse._meta.aos`. `resync: true` means `after` was beyond
 * bounded replay; the client must resume again with `replayFrom: { type:
 * "start" }`.
 */
export const AosSessionResumeResponseMetaSchema = z.strictObject({
  session: AosSessionInfoMetaSchema,
  execution: AosExecutionSchema,
  capabilities: SessionWorkspaceCapabilitiesResponseSchema,
  resync: z.boolean().optional(),
})

/** `PromptRequest._meta.aos` */
export const AosPromptMetaSchema = z.strictObject({
  /** User turn to rewind before Edit or Retry; validated authoritatively. */
  rewindSourceId: IdentifierSchema.optional(),
  /** Server-staged attachment batch referenced by `resource_link` blocks. */
  attachmentStageId: IdentifierSchema.optional(),
})

/** `_aos/session/update` params: exactly one intent per write. */
export const AosSessionUpdateRequestSchema = z
  .strictObject({
    sessionId: IdentifierSchema,
    title: z.string().min(1).max(4096).optional(),
    archived: z.boolean().optional(),
    unread: z.boolean().optional(),
  })
  .refine(
    (value) =>
      [value.title, value.archived, value.unread].filter(
        (intent) => intent !== undefined
      ).length === 1,
    "Exactly one of title, archived, unread"
  )
export type AosSessionUpdateRequest = z.infer<
  typeof AosSessionUpdateRequestSchema
>

/** `_aos/session/steer` params and response. */
export const AosSteerRequestSchema = z.strictObject({
  sessionId: IdentifierSchema,
  requestId: IdentifierSchema,
  text: z.string().min(1),
})
export const AosSteerResponseSchema = RunSteerResponseSchema

/** `_aos/session/focus` notification: the exposed Session, or none. */
export const AosFocusNotificationSchema = z.strictObject({
  sessionId: IdentifierSchema.nullable(),
})

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

export const AosAgentsListResponseSchema = AgentCatalogResponseSchema
export const AosSetVisibilityRequestSchema =
  VisibilityUpdateRequestSchema.extend({ agentId: IdentifierSchema })
export const AosSetVisibilityResponseSchema = VisibilityUpdateResponseSchema

// ---------------------------------------------------------------------------
// run stream `_meta.aos`
// ---------------------------------------------------------------------------

/** Base for every `session/update` the proxy emits from a run segment. */
const RunMetaBase = {
  sequence: SequenceSchema,
  runId: IdentifierSchema,
}

/** `state_update._meta.aos` */
export const AosStateMetaSchema = z.strictObject({
  ...RunMetaBase,
  /** Stop was acknowledged but the provider has not settled yet. */
  execution: z.literal("stopping").optional(),
  /** Present with the `_aos_error` and `_aos_uncertain` stop reasons. */
  code: z.string().min(1).max(128).optional(),
  message: z.string().max(4096).optional(),
})

/** `agent_message_chunk` / `agent_thought_chunk` `_meta.aos` */
export const AosChunkMetaSchema = z.strictObject(RunMetaBase)

/**
 * `agent_message._meta.aos` on a replayed turn the provider failed. A replay has
 * no run of its own to settle, so the durable failure travels with the message
 * it belongs to instead of through a run's `state_update`.
 */
export const AosHistoryStatusMetaSchema = z.strictObject({
  ...RunMetaBase,
  status: SessionMessageErrorStatusSchema,
})
export type AosHistoryStatusMeta = z.infer<typeof AosHistoryStatusMetaSchema>

/** `tool_call_update._meta.aos` */
export const AosToolCallMetaSchema = z.strictObject({
  ...RunMetaBase,
  messageId: IdentifierSchema,
  /** Streaming arguments text; ACP replaces `rawInput` wholesale. */
  argsTextDelta: z.string().optional(),
  argsText: z.string().optional(),
})

/** `plan_update._meta.aos`: the lossless Session Todos. */
export const AosPlanMetaSchema = z.strictObject({
  sequence: SequenceSchema,
  runId: IdentifierSchema.optional(),
  todos: SessionTodosResponseSchema.shape.todos,
})

/**
 * `usage_update._meta.aos`. ACP's `usage_update` carries the used and total
 * token counts alone, so how the provider arrived at them and its own
 * attribution of what they hold travel here. A provider that attributes nothing
 * sends no breakdown rather than a guessed one, and usage belongs to the Session
 * rather than to a run, so this meta names neither a run nor a sequence.
 */
export const AosUsageMetaSchema = z.strictObject({
  source: SessionContextResponseSchema.shape.source,
  estimated: SessionContextResponseSchema.shape.estimated,
  breakdown: SessionContextResponseSchema.shape.breakdown,
})
export type AosUsageMeta = z.infer<typeof AosUsageMetaSchema>

// ---------------------------------------------------------------------------
// pending requests `_meta.aos`
// ---------------------------------------------------------------------------

/** `RequestPermissionRequest._meta.aos` */
export const AosPermissionMetaSchema = z.strictObject({
  interruptId: IdentifierSchema,
  expiresAt: z.string().datetime().optional(),
  message: z.string().max(4096).optional(),
})

export const AosQuestionOptionSchema = z.strictObject({
  label: z.string().min(1).max(4096),
  value: z.string().max(4096).optional(),
  description: z.string().max(4096).optional(),
})
export const AosQuestionSchema = z.strictObject({
  id: IdentifierSchema.optional(),
  header: z.string().min(1).max(256),
  prompt: z.string().max(65_536),
  options: z.array(AosQuestionOptionSchema).max(64),
  multiple: z.boolean().optional(),
  custom: z.boolean().optional(),
})
export type AosQuestion = z.infer<typeof AosQuestionSchema>

/** `CreateElicitationRequest._meta.aos`: lossless projection of the questions. */
export const AosElicitationMetaSchema = z.strictObject({
  interruptId: IdentifierSchema,
  expiresAt: z.string().datetime().optional(),
  questions: z.array(AosQuestionSchema).min(1).max(64),
})

// ---------------------------------------------------------------------------
// extension notifications (agent → client)
// ---------------------------------------------------------------------------

/**
 * One published artifact, as every producer emits it and the browser accepts
 * it: only the identity, the name, and the source are guaranteed. A publishing
 * tool reports a media type and a size when it knows them.
 */
export const AosArtifactDescriptorSchema = z.strictObject({
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
export type AosArtifactDescriptor = z.infer<typeof AosArtifactDescriptorSchema>

/** `_aos/artifact` */
export const AosArtifactNotificationSchema = z.strictObject({
  sessionId: IdentifierSchema,
  ...RunMetaBase,
  messageId: IdentifierSchema.optional(),
  artifact: AosArtifactDescriptorSchema,
})

/** `_aos/steer_accepted` */
export const AosSteerAcceptedNotificationSchema = z.strictObject({
  sessionId: IdentifierSchema,
  ...RunMetaBase,
  requestId: IdentifierSchema,
  text: z.string(),
  delivery: RunSteerResponseSchema.shape.status,
})

/** `_aos/composer_prefill` */
export const AosComposerPrefillNotificationSchema = z.strictObject({
  sessionId: IdentifierSchema,
  runId: IdentifierSchema,
  text: z.string(),
})

/** `_aos/catalog_invalidated` (no params) and `_aos/session_invalidated`. */
export const AosSessionInvalidatedNotificationSchema = z.strictObject({
  sessionId: IdentifierSchema,
})

/** `_aos/error`: a failure with no request to answer, e.g. a rejected cancel. */
export const AosErrorNotificationSchema = z.strictObject({
  sessionId: IdentifierSchema.optional(),
  code: z.string().min(1).max(128),
  message: z.string().max(4096),
})

const ActivityBase = {
  agentId: IdentifierSchema,
  sessionId: IdentifierSchema,
  occurredAt: z.string().datetime(),
}

/**
 * `_aos/activity`: content-free workspace events for every Session the
 * connection may observe. Hydrated on connect from coordinator snapshots and
 * the session list.
 */
export const AosActivityNotificationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...ActivityBase,
    type: z.literal("run-started"),
    lifecycleId: IdentifierSchema,
  }),
  z.strictObject({
    ...ActivityBase,
    type: z.enum(["run-finished", "run-failed"]),
    lifecycleId: IdentifierSchema,
  }),
  z.strictObject({
    ...ActivityBase,
    type: z.literal("attention-requested"),
    requestId: IdentifierSchema,
    attentionKind: z.enum(["question", "permission"]),
  }),
  z.strictObject({
    ...ActivityBase,
    type: z.literal("attention-resolved"),
    requestId: IdentifierSchema,
  }),
  z.strictObject({
    ...ActivityBase,
    type: z.literal("unread-changed"),
    unread: z.boolean(),
  }),
])
export type AosActivityNotification = z.infer<
  typeof AosActivityNotificationSchema
>
