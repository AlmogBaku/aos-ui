import { z } from "zod"

import {
  AgentCatalogResponseSchema,
  AgentUpdateFields,
  AgentUpdateResponseSchema,
  ArtifactDescriptorSchema,
  type ArtifactDescriptor,
  TurnSteerResponseSchema,
  SessionContextResponseSchema,
  SessionStatusSchema,
  SessionTodosResponseSchema,
  SessionWorkspaceCapabilitiesResponseSchema,
  writesAgentField,
} from "./index"

/**
 * The AOS extension contract carried over ACP v2 between the Bun proxy (agent
 * side) and the browser (client side). ACP defines the turn stream, sessions,
 * config options, permissions, and plans; everything AOS needs beyond that
 * travels as underscore-prefixed extension methods and `_meta.aos` payloads
 * defined here. Both ends import this module and nothing else defines these
 * shapes.
 *
 * Client-to-agent shapes are strict: the proxy rejects what it does not
 * define. Agent-to-client shapes are read leniently (`readObject`): the
 * browser validates every key it knows and drops the rest, so a proxy that
 * adds a key never costs the browser the whole payload. The proxy's builders
 * stay exact through the inferred types.
 */

export const ACP_PROTOCOL_VERSION = 2 as const
export const AOS_ACP_OPERATOR_PATH = "/api/aos/v1/acp" as const
export const AOS_ACP_GUEST_PATH = "/api/guest/v1/acp" as const
export const AOS_META_KEY = "aos" as const
export const AOS_EXTENSION_VERSION = 1 as const
export const AOS_AUTH_METHOD_INVITE = "aos-invite" as const
export const AOS_ATTACHMENT_URI_SCHEME = "aos-attachment:" as const
export const AOS_ARTIFACT_URI_SCHEME = "artifact:" as const

export const AOS_METHODS = {
  session: {
    update: "_aos/session/update",
    steer: "_aos/session/steer",
    focus: "_aos/session/focus",
  },
  agents: {
    list: "_aos/agents/list",
    update: "_aos/agents/update",
  },
  notify: {
    activity: "_aos/activity",
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
  turnInProgress: -32002,
  staleRequest: -32003,
  notFound: -32004,
  revisionConflict: -32005,
  temporarilyUnavailable: -32006,
  connectionInterrupted: -32007,
  uncertainMutation: -32008,
  unsupported: -32009,
  invalidRequest: -32602,
} as const
export type AosJsonRpcErrorCode =
  (typeof AOS_JSONRPC_ERRORS)[keyof typeof AOS_JSONRPC_ERRORS]

export const IdentifierSchema = z
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

/** An agent-to-client object: known keys validated, unknown keys dropped. */
const readObject = z.object

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export const AosExtensionsSchema = readObject({
  steer: z.boolean(),
  rewind: z.boolean(),
  composerPrefill: z.boolean(),
  agents: z.boolean(),
  invalidation: z.boolean(),
  activity: z.boolean(),
  readState: z.boolean(),
  focus: z.boolean(),
  guestProjection: z.boolean(),
  /** `session/resume` accepts `replayFrom: { type: "_aos/before" }`. */
  historyPages: z.boolean().default(false),
})
export type AosExtensions = z.infer<typeof AosExtensionsSchema>

/**
 * `ClientCapabilities._meta.aos` on `initialize`: the AOS extensions this
 * client understands. Without `historyPages`, a from-start resume replays the
 * whole Session, as ACP's `replayFrom: { type: "start" }` requires.
 */
export const AosClientCapabilitiesMetaSchema = readObject({
  historyPages: z.boolean().default(false),
})
export type AosClientCapabilitiesMeta = z.infer<
  typeof AosClientCapabilitiesMetaSchema
>

/** `InitializeResponse._meta.aos` */
export const AosInitializeMetaSchema = readObject({
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
 * `session_info_update._meta.aos`. `unread`, `pinned`, and `createdAt` are
 * absent when the runtime does not track that state or this read cannot know
 * it; absent never overwrites a known value.
 */
export const AosSessionInfoMetaSchema = readObject({
  agentId: IdentifierSchema,
  status: SessionStatusSchema,
  archived: z.boolean(),
  createdAt: z.string().datetime().optional(),
  unread: z.boolean().optional(),
  pinned: z.boolean().optional(),
})
export type AosSessionInfoMeta = z.infer<typeof AosSessionInfoMetaSchema>

export const AosExecutionSchema = readObject({
  status: SessionStatusSchema,
  turnId: IdentifierSchema.optional(),
})

/** `NewSessionResponse._meta.aos` */
export const AosSessionNewResponseMetaSchema = readObject({
  session: AosSessionInfoMetaSchema,
  capabilities: SessionWorkspaceCapabilitiesResponseSchema,
})

/** `ResumeSessionRequest._meta.aos` */
export const AosSessionResumeMetaSchema = z.strictObject({
  /** Owning Agent, when the client knows it before listing (deep links). */
  agentId: IdentifierSchema.optional(),
  /** Last `_meta.aos.sequence` the client saw for `turnId`. */
  after: SequenceSchema.optional(),
  turnId: IdentifierSchema.optional(),
})

/**
 * `PromptResponse._meta.aos`. The pinned SDK's v2 `PromptResponse` has no
 * `messageId` field and its client parser strips unknown keys, so the proxy's
 * minted user message id travels here.
 */
export const AosPromptResponseMetaSchema = readObject({
  messageId: IdentifierSchema,
})

/**
 * The reserved `replayFrom` extension variant that reads one older page of a
 * Session this connection is already a member of. `cursor` is the opaque
 * `history.nextCursor` a previous resume returned; the server picks the page
 * size, so the client sends no limit. Like every ACP type it may carry `_meta`.
 */
export const AOS_REPLAY_BEFORE = "_aos/before" as const
export const AosReplayBeforeSchema = z.strictObject({
  type: z.literal(AOS_REPLAY_BEFORE),
  cursor: z.string().min(1).max(256),
  _meta: z.record(z.string(), z.unknown()).nullish(),
})
export type AosReplayBefore = z.infer<typeof AosReplayBeforeSchema>

/**
 * `_meta.aos.history` on a resume that replayed. It follows ACP v2
 * `session/list` pagination: `nextCursor` is opaque and its absence means the
 * replayed page reached the Session's beginning, unless `truncated` says older
 * history exists but this server cannot reach it.
 */
export const AosHistoryCursorSchema = readObject({
  nextCursor: z.string().min(1).max(256).optional(),
  truncated: z.boolean().optional(),
})
export type AosHistoryCursor = z.infer<typeof AosHistoryCursorSchema>

/**
 * `ResumeSessionResponse._meta.aos` for a `_aos/before` page read: only the
 * cursor, since a page read never re-attaches.
 */
export const AosHistoryPageResponseMetaSchema = readObject({
  history: AosHistoryCursorSchema,
})

/**
 * Read from the `_meta.aos` of any `session/update`: present only on an update
 * that belongs to a `_aos/before` page, never on a live or start-replay one.
 * ACP notifications carry no request id, so this tag is what keeps a page apart
 * from live updates for the same Session.
 */
export const AosHistoryPageTagSchema = readObject({
  historyPage: readObject({ cursor: z.string().min(1).max(256) }).optional(),
})

/**
 * `ResumeSessionResponse._meta.aos`. `resync: true` means `after` was beyond
 * bounded replay; the client must resume again with `replayFrom: { type:
 * "start" }`.
 */
export const AosSessionResumeResponseMetaSchema = readObject({
  session: AosSessionInfoMetaSchema,
  execution: AosExecutionSchema,
  capabilities: SessionWorkspaceCapabilitiesResponseSchema,
  resync: z.boolean().optional(),
  /** Present whenever this resume replayed history. */
  history: AosHistoryCursorSchema.optional(),
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
    pinned: z.boolean().optional(),
  })
  .refine(
    (value) =>
      [value.title, value.archived, value.unread, value.pinned].filter(
        (intent) => intent !== undefined
      ).length === 1,
    "Exactly one of title, archived, unread, pinned"
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
export const AosSteerResponseSchema = TurnSteerResponseSchema

/**
 * `_aos/session/focus` notification: the exposed Session, or none, plus the
 * workspace presence the browser re-sends every `PRESENCE_HEARTBEAT_MS`. An
 * absent `foreground` means an exposed Session is in the foreground, and an
 * absent `idle` means the operator is still interacting.
 */
export const AosFocusNotificationSchema = z.strictObject({
  sessionId: IdentifierSchema.nullable(),
  foreground: z.boolean().optional(),
  idle: z.boolean().optional(),
})

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

export const AosAgentsListResponseSchema = AgentCatalogResponseSchema
/** `_aos/agents/update` params: at least one of visibility and avatar. */
export const AosAgentUpdateRequestSchema = z
  .strictObject({ agentId: IdentifierSchema, ...AgentUpdateFields })
  .refine(writesAgentField, "At least one of visibility, avatar")
export type AosAgentUpdateRequest = z.infer<typeof AosAgentUpdateRequestSchema>
export const AosAgentUpdateResponseSchema = AgentUpdateResponseSchema

// ---------------------------------------------------------------------------
// turn stream `_meta.aos`
// ---------------------------------------------------------------------------

/** Base for every `session/update` the proxy emits from a turn segment. */
const TurnMetaBase = {
  sequence: SequenceSchema,
  turnId: IdentifierSchema,
}

/**
 * `_meta.aos` of a `terminal_update`, `terminal_output_chunk`, or
 * `compaction_update`: ACP's own fields carry every fact, so only the turn it
 * belongs to travels here.
 */
export const AosTurnMetaSchema = readObject(TurnMetaBase)

const CountSchema = z.number().int().nonnegative()

/** What a turn cost, as the provider priced it; ISO 4217 currency. */
export const AosCostSchema = readObject({
  amount: z.number().nonnegative(),
  currency: z.string().min(1).max(16),
})
export type AosCost = z.infer<typeof AosCostSchema>

/** How far a delegated subagent has got. */
export const AOS_SUBAGENT_STATUSES = [
  "running",
  "completed",
  "failed",
  "cancelled",
] as const

/**
 * One delegated subagent, as a patch keyed by `id`: a later report restates
 * only what changed, so an omitted key leaves the known value standing.
 */
export const AosSubagentSchema = readObject({
  id: IdentifierSchema,
  goal: z.string().max(65_536).optional(),
  model: z.string().min(1).max(256).optional(),
  /** 1 for a subagent the turn spawned, 2 for one that subagent spawned. */
  depth: z.number().int().min(1).optional(),
  status: z.enum(AOS_SUBAGENT_STATUSES).optional(),
  /** Every token the subagent spent. */
  tokens: CountSchema.optional(),
  filesRead: z.array(z.string()).optional(),
  filesWritten: z.array(z.string()).optional(),
  durationMs: CountSchema.optional(),
  /** The provider Session the subagent runs in, when it has its own. */
  childSessionId: IdentifierSchema.optional(),
  summary: z.string().max(65_536).optional(),
})
export type AosSubagent = z.infer<typeof AosSubagentSchema>

/**
 * Names the delegated subagent a chunk or tool call came from and, when the
 * spawning call is in the same stream, that call. Absent means the turn's own
 * agent produced it.
 */
const SubagentAttribution = {
  subagentId: IdentifierSchema.optional(),
  parentToolCallId: IdentifierSchema.optional(),
}

/** `state_update._meta.aos` */
export const AosStateMetaSchema = readObject({
  ...TurnMetaBase,
  /**
   * When the state took effect. The two state updates that bracket a turn carry
   * the turn's span, live and on replay alike, so the browser reads a turn's
   * duration from the wire rather than from its own clock.
   */
  at: z.string().datetime().optional(),
  /** Stop was acknowledged but the provider has not settled yet. */
  execution: z.literal("stopping").optional(),
  /**
   * Present with the `_aos_error` and `_aos_uncertain` stop reasons, and on a
   * `running` update when the turn reports a final failure but stays active
   * until it is stopped.
   */
  code: z.string().min(1).max(128).optional(),
  message: z.string().max(4096).optional(),
  /** The provider and model a failed turn ran on, when the failure names them. */
  provider: z.string().min(1).max(256).optional(),
  model: z.string().min(1).max(256).optional(),
  /**
   * What the turn cost, on its `idle` update. ACP prices only a Session's
   * cumulative spend, on a `usage_update` that also needs the context window.
   */
  cost: AosCostSchema.optional(),
  /**
   * On a turn's `idle` update: each message id the turn streamed under, mapped
   * to the id the provider saved that message under. The browser re-keys those
   * messages, so an edit and a later history replay address the saved rows.
   */
  savedIds: z
    .record(z.string().min(1).max(512), z.string().min(1).max(512))
    .optional(),
})

/** `agent_message_chunk` / `agent_thought_chunk` `_meta.aos` */
export const AosChunkMetaSchema = readObject({
  ...TurnMetaBase,
  ...SubagentAttribution,
})

/** `tool_call_update` / `tool_call_content_chunk` `_meta.aos` */
export const AosToolCallMetaSchema = readObject({
  ...TurnMetaBase,
  ...SubagentAttribution,
  messageId: IdentifierSchema,
  /** Streaming arguments text; ACP replaces `rawInput` wholesale. */
  argsTextDelta: z.string().optional(),
  argsText: z.string().optional(),
  /** When the call started and finished, as the provider timed it. */
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  /** How long the call ran, when the provider reports a span, not the ends. */
  durationMs: CountSchema.optional(),
  /** The subagent this call spawned; later updates patch it by `id`. */
  subagent: AosSubagentSchema.optional(),
  /** The tool declares an MCP App view; a flag only, never a resource URI. */
  app: z.strictObject({}).optional(),
})

/** `plan_update._meta.aos`: the lossless Session Todos. */
export const AosPlanMetaSchema = readObject({
  sequence: SequenceSchema,
  turnId: IdentifierSchema.optional(),
  todos: SessionTodosResponseSchema.shape.todos,
})

/**
 * `usage_update._meta.aos`. ACP's `usage_update` carries the used and total
 * token counts alone, so how the provider arrived at them and its own
 * attribution of what they hold travel here. A provider that attributes nothing
 * sends no breakdown rather than a guessed one, and usage belongs to the Session
 * rather than to a turn, so this meta names neither a turn nor a sequence.
 */
export const AosUsageMetaSchema = readObject({
  source: SessionContextResponseSchema.shape.source,
  estimated: SessionContextResponseSchema.shape.estimated,
  breakdown: SessionContextResponseSchema.shape.breakdown,
})
export type AosUsageMeta = z.infer<typeof AosUsageMetaSchema>

// ---------------------------------------------------------------------------
// pending requests `_meta.aos`
// ---------------------------------------------------------------------------

/** `RequestPermissionRequest._meta.aos` */
export const AosPermissionMetaSchema = readObject({
  requestId: IdentifierSchema,
  expiresAt: z.string().datetime().optional(),
  message: z.string().max(4096).optional(),
})

export const AosQuestionOptionSchema = readObject({
  label: z.string().min(1).max(4096),
  value: z.string().max(4096).optional(),
  description: z.string().max(4096).optional(),
})
export const AosQuestionSchema = readObject({
  id: IdentifierSchema.optional(),
  /**
   * The provider's own short label for the question, when it has one. A
   * provider that carries only the question's words omits it, and the browser
   * labels the question by its place in the batch, in the reader's language.
   */
  header: z.string().min(1).max(256).optional(),
  prompt: z.string().max(65_536),
  options: z.array(AosQuestionOptionSchema).max(64),
  multiple: z.boolean().optional(),
  custom: z.boolean().optional(),
})
export type AosQuestion = z.infer<typeof AosQuestionSchema>

/** `CreateElicitationRequest._meta.aos`: lossless projection of the questions. */
export const AosElicitationMetaSchema = readObject({
  requestId: IdentifierSchema,
  expiresAt: z.string().datetime().optional(),
  questions: z.array(AosQuestionSchema).min(1).max(64),
})

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

/** One published artifact; `ArtifactDescriptorSchema` in `./index` defines it. */
export const AosArtifactDescriptorSchema = ArtifactDescriptorSchema
export type AosArtifactDescriptor = ArtifactDescriptor

const ARTIFACT_URI_PREFIX = `${AOS_ARTIFACT_URI_SCHEME}//`

/**
 * The uri of the `resource_link` a published artifact is announced as. It
 * carries only the opaque artifact id: never a native path, and no route, since
 * the reader already knows the Session and lane it reads through.
 */
export function formatArtifactUri(artifactId: string) {
  return `${ARTIFACT_URI_PREFIX}${encodeURIComponent(artifactId)}`
}

/** The artifact id an `artifact://` uri names, or `undefined` for any other uri. */
export function parseArtifactUri(uri: string): string | undefined {
  if (!uri.startsWith(ARTIFACT_URI_PREFIX)) return undefined
  const encoded = uri.slice(ARTIFACT_URI_PREFIX.length)
  if (/[/?#]/u.test(encoded)) return undefined
  let artifactId: string
  try {
    artifactId = decodeURIComponent(encoded)
  } catch {
    return undefined
  }
  return IdentifierSchema.safeParse(artifactId).success ? artifactId : undefined
}

// ---------------------------------------------------------------------------
// extension notifications (agent → client)
// ---------------------------------------------------------------------------

/** `_aos/steer_accepted` */
export const AosSteerAcceptedNotificationSchema = readObject({
  sessionId: IdentifierSchema,
  ...TurnMetaBase,
  requestId: IdentifierSchema,
  text: z.string(),
  delivery: TurnSteerResponseSchema.shape.status,
})

/** `_aos/composer_prefill` */
export const AosComposerPrefillNotificationSchema = readObject({
  sessionId: IdentifierSchema,
  turnId: IdentifierSchema,
  text: z.string(),
})

/** `_aos/catalog_invalidated` (no params) and `_aos/session_invalidated`. */
export const AosSessionInvalidatedNotificationSchema = readObject({
  sessionId: IdentifierSchema,
})

/** `_aos/error`: a failure with no request to answer, e.g. a rejected cancel. */
export const AosErrorNotificationSchema = readObject({
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
  readObject({
    ...ActivityBase,
    type: z.enum(["turn-started", "turn-finished", "turn-failed"]),
    turnId: IdentifierSchema,
  }),
  readObject({
    ...ActivityBase,
    type: z.literal("attention-requested"),
    requestId: IdentifierSchema,
    attentionKind: z.enum(["question", "permission"]),
  }),
  readObject({
    ...ActivityBase,
    type: z.literal("attention-resolved"),
    requestId: IdentifierSchema,
  }),
  readObject({
    ...ActivityBase,
    type: z.literal("unread-changed"),
    unread: z.boolean(),
  }),
])
export type AosActivityNotification = z.infer<
  typeof AosActivityNotificationSchema
>
