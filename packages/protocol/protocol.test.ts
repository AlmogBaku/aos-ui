import { describe, expect, it } from "vitest"

import {
  AgentAvatarSchema,
  AgentCatalogResponseSchema,
  AgentUpdateRequestSchema,
  ErrorResponseSchema,
  INTERACTION_PROTOCOL,
  RuntimeAuthStateSchema,
  RuntimeInfoSchema,
  TurnSteerRequestSchema,
  TurnSteerResponseSchema,
  TurnStopResponseSchema,
  SessionCatalogResponseSchema,
  SessionCreateResponseSchema,
  SessionHistoryResponseSchema,
  SessionActivityResponseSchema,
  SessionAudioResponseSchema,
  SessionAttachmentStageRequestSchema,
  SessionAttachmentStageResponseSchema,
  SessionContextResponseSchema,
  SessionModelUpdateRequestSchema,
  SessionPatchRequestSchema,
  SessionModelsResponseSchema,
  SessionTodosResponseSchema,
  SessionWorkspaceCapabilitiesResponseSchema,
} from "./index"
import {
  AOS_ARTIFACT_URI_SCHEME,
  AOS_JSONRPC_ERRORS,
  AOS_METHODS,
  AosAgentUpdateRequestSchema,
  AosArtifactDescriptorSchema,
  AosElicitationMetaSchema,
  AosExtensionsSchema,
  AosFocusNotificationSchema,
  AosHistoryPageTagSchema,
  AosReplayBeforeSchema,
  AosSessionResumeResponseMetaSchema,
  AosPermissionMetaSchema,
  AosSessionInfoMetaSchema,
  AosSessionUpdateRequestSchema,
  AosChunkMetaSchema,
  AosStateMetaSchema,
  AosToolCallMetaSchema,
  formatArtifactUri,
  parseArtifactUri,
} from "./acp"
import { McpAppViewSchema } from "./mcp-apps"

describe("AOS v1 normalized protocol", () => {
  it("preserves provider-specific approval choices and question cancellation", () => {
    expect(
      SessionWorkspaceCapabilitiesResponseSchema.shape.interactions.parse({
        steering: {
          status: "unavailable",
          reason: "native-steering-unavailable",
        },
        approvals: {
          status: "available",
          protocol: INTERACTION_PROTOCOL,
          scope: "turn",
          choices: [
            { value: "once", scope: "request" },
            { value: "always", scope: "agent" },
            { value: "deny", scope: "request" },
          ],
          maxPending: 64,
        },
        questions: {
          status: "available",
          protocol: INTERACTION_PROTOCOL,
          scope: "turn",
          answerModes: ["single", "multiple", "free-text"],
          cancellation: "native-reject",
          maxQuestions: 32,
          maxChoicesPerQuestion: 64,
          maxAnswerValuesPerQuestion: 64,
          maxStringBytes: 4096,
        },
        reactions: {
          status: "unavailable",
          reason: "native-reaction-operation-unavailable",
        },
      })
    ).toMatchObject({
      approvals: {
        choices: [
          { value: "once", scope: "request" },
          { value: "always", scope: "agent" },
          { value: "deny", scope: "request" },
        ],
      },
      questions: { cancellation: "native-reject" },
    })
  })

  it("preserves native cancellation and complete-request answer limits", () => {
    const parsed =
      SessionWorkspaceCapabilitiesResponseSchema.shape.interactions.shape.questions.parse(
        {
          status: "available",
          protocol: INTERACTION_PROTOCOL,
          scope: "turn",
          answerModes: ["single", "multiple", "free-text"],
          cancellation: "native-cancel",
          maxQuestions: 3,
          maxChoicesPerQuestion: 4,
          maxAnswerValuesPerQuestion: "complete-request",
          maxStringBytes: 4096,
        }
      )

    expect(parsed).toMatchObject({
      cancellation: "native-cancel",
      maxAnswerValuesPerQuestion: "complete-request",
    })
  })

  it("preserves unavailable model and context operations", () => {
    expect(
      SessionWorkspaceCapabilitiesResponseSchema.shape.workspace
        .pick({ models: true, context: true })
        .parse({
          models: {
            status: "unavailable",
            reason: "native-model-selection-unavailable",
          },
          context: {
            status: "unavailable",
            reason: "native-context-accounting-unavailable",
          },
        })
    ).toEqual({
      models: {
        status: "unavailable",
        reason: "native-model-selection-unavailable",
      },
      context: {
        status: "unavailable",
        reason: "native-context-accounting-unavailable",
      },
    })
  })

  it("preserves negotiated attachment limits without inventing provider policy", () => {
    const parsed =
      SessionWorkspaceCapabilitiesResponseSchema.shape.content.shape.attachments.parse(
        {
          status: "available",
          scope: "attached-session",
          inputs: ["image", "file"],
          imageMimeTypes: "provider-dependent",
          fileMimeTypes: "provider-dependent",
          maxMimeTypeBytes: 256,
          maxFilenameBytes: 255,
          maxCount: 16,
          maxImageBytes: 10_000_000,
          maxFileBytes: 25_000_000,
          maxTotalBytes: "complete-request",
          maxEncodedRequestBytes: 26_214_400,
          completeRequestValidation: "native-run-input",
        }
      )

    expect(parsed).toMatchObject({
      imageMimeTypes: "provider-dependent",
      maxTotalBytes: "complete-request",
      maxEncodedRequestBytes: 26_214_400,
      completeRequestValidation: "native-run-input",
    })
  })

  it("represents a missing native attachment capability without hiding other capabilities", () => {
    expect(
      SessionWorkspaceCapabilitiesResponseSchema.shape.content.shape.attachments.parse(
        {
          status: "unavailable",
          reason: "native-attachment-policy-unavailable",
        }
      )
    ).toEqual({
      status: "unavailable",
      reason: "native-attachment-policy-unavailable",
    })
  })

  it("validates the normalized Hermes Session workspace and content envelopes", () => {
    expect(
      SessionWorkspaceCapabilitiesResponseSchema.parse({
        workspace: {
          slashCommands: {
            status: "available",
            scope: "attached-session",
            commands: [{ name: "help", description: "Show help" }],
          },
          models: {
            status: "available",
            scope: "attached-session",
            selection: "native-session",
            choices: "provider-reported",
          },
          context: {
            status: "available",
            scope: "attached-session",
            source: "provider-usage-or-estimate",
            breakdown: "provider-categories",
          },
          todos: { status: "unavailable", reason: "history-unavailable" },
          activity: {
            status: "unavailable",
            reason: "session-state-unavailable",
          },
        },
        interactions: {
          steering: {
            status: "available",
            scope: "active-turn",
            semantics: "visible-user-message",
            input: "text",
            fallback: "provider-queue",
          },
          approvals: {
            status: "available",
            protocol: INTERACTION_PROTOCOL,
            scope: "turn",
            choices: [
              { value: "once", scope: "request" },
              { value: "session", scope: "session" },
              { value: "always", scope: "agent" },
              { value: "deny", scope: "request" },
            ],
            maxPending: 64,
          },
          questions: {
            status: "available",
            protocol: INTERACTION_PROTOCOL,
            scope: "turn",
            answerModes: ["single", "multiple", "free-text"],
            cancellation: "native-empty-answer",
            maxQuestions: 32,
            maxChoicesPerQuestion: 64,
            maxAnswerValuesPerQuestion: 64,
            maxStringBytes: 4096,
          },
          reactions: {
            status: "unavailable",
            reason: "native-reaction-operation-unavailable",
          },
        },
        content: {
          attachments: {
            status: "available",
            scope: "attached-session",
            inputs: ["image", "file"],
            imageMimeTypes: ["image/png"],
            fileMimeTypes: "valid-type/subtype",
            maxMimeTypeBytes: 256,
            maxFilenameBytes: 255,
            maxCount: 16,
            maxImageBytes: 26214400,
            maxFileBytes: 26214400,
            maxTotalBytes: 26214400,
          },
          artifacts: {
            status: "available",
            scope: "session",
            maxBytes: 26214400,
          },
          mcpApps: { status: "unavailable", reason: "not-supported" },
          transcription: {
            status: "unavailable",
            reason: "native-transcription-unavailable",
          },
          speech: {
            status: "unavailable",
            reason: "native-speech-unavailable",
          },
        },
      })
    ).toMatchObject({ interactions: { reactions: { status: "unavailable" } } })
    expect(
      SessionModelsResponseSchema.parse({
        selectedId: '["native","small"]',
        options: [
          {
            id: '["native","small"]',
            label: "small",
            group: "Native",
          },
        ],
      })
    ).toMatchObject({ selectedId: '["native","small"]' })
    expect(
      SessionModelUpdateRequestSchema.parse({
        selectedId: '["native","small"]',
      })
    ).toEqual({ selectedId: '["native","small"]' })
    expect(SessionModelUpdateRequestSchema.parse({ effortId: "high" })).toEqual(
      { effortId: "high" }
    )
    // One resource, one write: a patch that changes neither half is not a write.
    expect(SessionModelUpdateRequestSchema.safeParse({}).success).toBe(false)
    expect(
      SessionContextResponseSchema.parse({
        usedTokens: 12,
        maxTokens: 100,
        source: "provider-usage",
      })
    ).toMatchObject({ usedTokens: 12 })
    expect(
      SessionTodosResponseSchema.parse({
        todos: [{ id: "todo-1", label: "Inspect", status: "active" }],
      })
    ).toMatchObject({ todos: [{ id: "todo-1" }] })
    expect(
      SessionActivityResponseSchema.parse({
        status: "available",
        scope: "attached-active-session",
        coverage: "active-session-only",
        state: "waiting-for-input",
      })
    ).toMatchObject({ state: "waiting-for-input" })
    expect(
      SessionAudioResponseSchema.parse({
        transcription: { status: "ready" },
        speech: { status: "unavailable", reason: "not-configured" },
      })
    ).toMatchObject({ transcription: { status: "ready" } })
    const staged = SessionAttachmentStageResponseSchema.parse({
      stageId: "stage-1",
      attachments: [
        {
          type: "file",
          filename: "notes.txt",
          mimeType: "text/plain",
        },
      ],
    })
    expect(staged.stageId).toBe("stage-1")
    expect(() =>
      SessionAttachmentStageRequestSchema.parse({
        attachments: [
          {
            type: "file",
            dataUrl: "data:text/plain;base64,YQ==",
            mimeType: "text/plain",
            nativePath: "/private/notes.txt",
          },
        ],
      })
    ).toThrow()
  })
  it("exposes only the normalized Stop settlement state", () => {
    expect(TurnStopResponseSchema.parse({ status: "stopping" })).toEqual({
      status: "stopping",
    })
    expect(() =>
      TurnStopResponseSchema.parse({
        status: "stopping",
        liveSessionId: "native-secret",
      })
    ).toThrow()
  })

  it("validates strict active-turn steering envelopes and their UTF-8 limit", () => {
    expect(
      TurnSteerRequestSchema.parse({
        requestId: "queue-item-1",
        expectedTurnId: "run-1",
        text: "Please use the newer API",
      })
    ).toEqual({
      requestId: "queue-item-1",
      expectedTurnId: "run-1",
      text: "Please use the newer API",
    })
    expect(TurnSteerResponseSchema.parse({ status: "steered" })).toEqual({
      status: "steered",
    })
    expect(TurnSteerResponseSchema.parse({ status: "queued" })).toEqual({
      status: "queued",
    })
    expect(() =>
      TurnSteerRequestSchema.parse({
        requestId: "queue-item-1",
        expectedTurnId: "run-1",
        text: "",
      })
    ).toThrow()
    expect(() =>
      TurnSteerRequestSchema.parse({
        requestId: "queue-item-1",
        expectedTurnId: "run-1",
        text: "😀".repeat(262_145),
      })
    ).toThrow()
    expect(() =>
      TurnSteerRequestSchema.parse({
        requestId: "queue-item-1",
        expectedTurnId: "run-1",
        text: "valid",
        nativeSessionId: "private",
      })
    ).toThrow()
  })

  it("keeps runtime authentication provider-neutral and server-only", () => {
    expect(
      RuntimeAuthStateSchema.parse({
        status: "authenticated",
      })
    ).toEqual({ status: "authenticated" })
    expect(
      RuntimeAuthStateSchema.parse({ status: "authentication-required" })
    ).toEqual({ status: "authentication-required" })
    expect(() =>
      RuntimeAuthStateSchema.parse({
        status: "authenticated",
        method: "static-token",
      })
    ).toThrow()
  })

  it("describes operation-specific runtime capabilities without booleans", () => {
    expect(
      RuntimeInfoSchema.parse({
        runtime: { id: "hermes", name: "Hermes" },
        status: "ready",
        capabilities: {
          agentCatalog: { status: "available" },
          agentVisibility: {
            status: "available",
            concurrency: "revision",
          },
          sessionCatalog: {
            status: "available",
            scope: "workspace",
            order: "recent",
            defaultPageSize: 50,
            maxPageSize: 100,
            maxWindow: 1_000,
          },
          sessionHistory: {
            status: "available",
            order: "chronological",
            compacted: true,
            loading: "on-open",
            defaultPageSize: 200,
            maxPageSize: 500,
          },
          sessionDetail: { status: "available" },
          sessionCreation: { status: "available" },
          sessionTitle: { status: "available" },
          sessionArchival: { status: "available" },
          sessionPin: { status: "available" },
          sessionDeletion: { status: "available" },
          sessionTurn: { status: "available" },
          sessionStop: { status: "available" },
          sessionSteer: { status: "available" },
          sessionReadState: { status: "available" },
        },
      }).status
    ).toBe("ready")
    expect(() =>
      RuntimeInfoSchema.parse({
        runtime: { id: "hermes", name: "Hermes" },
        status: "ready",
        capabilities: { agentCatalog: true },
      })
    ).toThrow()
  })

  it("exposes a provider-neutral run admission conflict", () => {
    expect(
      ErrorResponseSchema.parse({
        error: {
          code: "turn_conflict",
          description: "A turn is already active for this session.",
        },
      })
    ).toEqual({
      error: {
        code: "turn_conflict",
        description: "A turn is already active for this session.",
      },
    })
    expect(
      ErrorResponseSchema.parse({
        error: {
          code: "turn_capacity_exceeded",
          description: "AOS is at capacity. Please try again shortly.",
        },
      })
    ).toEqual({
      error: {
        code: "turn_capacity_exceeded",
        description: "AOS is at capacity. Please try again shortly.",
      },
    })
    expect(
      ErrorResponseSchema.parse({
        error: {
          code: "runtime_authentication_required",
          description: "Connect the configured runtime to continue.",
        },
      })
    ).toEqual({
      error: {
        code: "runtime_authentication_required",
        description: "Connect the configured runtime to continue.",
      },
    })
  })

  it("validates normalized Agent entries and rejects native profile metadata", () => {
    const payload = {
      revision: "profiles:12",
      agents: [
        {
          summary: {
            kind: "ready",
            id: "researcher",
            name: "Researcher",
            description: "Investigates primary sources",
            activity: "idle",
            visibility: "visible",
            avatar: "ring/blue",
          },
          visibility: "visible",
          selectable: true,
          editable: true,
          avatarEditable: true,
          revision: "hermes-bots:7,aos:2",
        },
      ],
    }
    expect(AgentCatalogResponseSchema.parse(payload)).toEqual(payload)
    expect(() =>
      AgentCatalogResponseSchema.parse({
        ...payload,
        agents: [
          {
            ...payload.agents[0],
            ui_meta_revisions: { "hermes-bots": 7 },
          },
        ],
      })
    ).toThrow()
  })

  it("accepts only token-shaped Agent avatars", () => {
    expect(AgentAvatarSchema.parse("ring/blue")).toBe("ring/blue")
    expect(AgentAvatarSchema.parse("chamfer-crop/amber-2")).toBe(
      "chamfer-crop/amber-2"
    )
    for (const invalid of [
      "Ring/Blue",
      "a/b/c",
      "ring",
      "/blue",
      `${"a".repeat(33)}/blue`,
      `ring/${"b".repeat(33)}`,
    ])
      expect(AgentAvatarSchema.safeParse(invalid).success).toBe(false)
  })

  it("refuses a catalog entry whose avatar is not token-shaped", () => {
    const entry = {
      summary: { kind: "ready", id: "agent-a", name: "Agent A" },
      visibility: "visible",
      selectable: true,
      editable: true,
      avatarEditable: false,
      revision: "rev-1",
    }
    expect(
      AgentCatalogResponseSchema.safeParse({ revision: "r", agents: [entry] })
        .success
    ).toBe(true)
    expect(
      AgentCatalogResponseSchema.safeParse({
        revision: "r",
        agents: [{ ...entry, summary: { ...entry.summary, avatar: "a/b/c" } }],
      }).success
    ).toBe(false)
  })

  it("requires the observed revision and at least one field on every Agent update", () => {
    expect(
      AgentUpdateRequestSchema.parse({
        visibility: "hidden",
        avatar: null,
        revision: "rev-1",
      })
    ).toEqual({ visibility: "hidden", avatar: null, revision: "rev-1" })
    expect(
      AgentUpdateRequestSchema.parse({ avatar: "ring/blue", revision: "rev-1" })
    ).toEqual({ avatar: "ring/blue", revision: "rev-1" })
    expect(() =>
      AgentUpdateRequestSchema.parse({ visibility: "hidden" })
    ).toThrow()
    expect(() =>
      AgentUpdateRequestSchema.parse({ revision: "rev-1" })
    ).toThrow()
    expect(() => AgentUpdateRequestSchema.parse({})).toThrow()
    expect(() =>
      AgentUpdateRequestSchema.parse({ avatar: "Ring/Blue", revision: "rev-1" })
    ).toThrow()
    expect(() =>
      AgentUpdateRequestSchema.parse({ name: "Renamed", revision: "rev-1" })
    ).toThrow()
  })

  it("addresses an ACP Agent update by agentId", () => {
    expect(AOS_METHODS.agents.update).toBe("_aos/agents/update")
    expect(
      AosAgentUpdateRequestSchema.parse({
        agentId: "agent-a",
        revision: "rev-1",
        visibility: "visible",
        avatar: "ring/blue",
      })
    ).toEqual({
      agentId: "agent-a",
      revision: "rev-1",
      visibility: "visible",
      avatar: "ring/blue",
    })
    expect(() =>
      AosAgentUpdateRequestSchema.parse({ agentId: "agent-a", revision: "r" })
    ).toThrow()
    expect(() =>
      AosAgentUpdateRequestSchema.parse({ revision: "r", avatar: null })
    ).toThrow()
  })

  it("gives an unsupported runtime refusal its own JSON-RPC code", () => {
    expect(AOS_JSONRPC_ERRORS.unsupported).toBe(-32009)
    expect(new Set(Object.values(AOS_JSONRPC_ERRORS)).size).toBe(
      Object.values(AOS_JSONRPC_ERRORS).length
    )
  })

  it("accepts bounded normalized Session pages without native identities", () => {
    expect(
      SessionCatalogResponseSchema.parse({
        sessions: [
          {
            id: "hermes:researcher:stored-1",
            agentId: "researcher",
            title: "Research",
            archived: false,
            createdAt: "2025-12-31T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            status: "idle",
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      })
    ).toMatchObject({ total: 1 })
    expect(() =>
      SessionCatalogResponseSchema.parse({
        sessions: [],
        total: 0,
        limit: 101,
        offset: 0,
      })
    ).toThrow()
  })

  it("reads a Session's creation time when the proxy knows it", () => {
    const meta = { agentId: "agent-a", status: "idle", archived: false }
    expect(AosSessionInfoMetaSchema.parse(meta)).toEqual(meta)
    expect(
      AosSessionInfoMetaSchema.parse({
        ...meta,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
    ).toEqual({ ...meta, createdAt: "2026-01-01T00:00:00.000Z" })
  })

  it("admits exactly one Session mutation intent per patch", () => {
    expect(SessionPatchRequestSchema.parse({ unread: false })).toEqual({
      unread: false,
    })
    expect(SessionPatchRequestSchema.parse({ pinned: true })).toEqual({
      pinned: true,
    })
    expect(() =>
      SessionPatchRequestSchema.parse({ unread: false, archived: true })
    ).toThrow()
    expect(() =>
      SessionPatchRequestSchema.parse({ pinned: true, archived: true })
    ).toThrow()
    expect(() => SessionPatchRequestSchema.parse({})).toThrow()
  })

  it("admits exactly one Session mutation intent per ACP update", () => {
    const sessionId = "hermes:researcher:stored-1"

    expect(
      AosSessionUpdateRequestSchema.parse({ sessionId, pinned: true })
    ).toEqual({ sessionId, pinned: true })
    expect(
      AosSessionUpdateRequestSchema.parse({ sessionId, unread: false })
    ).toEqual({ sessionId, unread: false })
    expect(() =>
      AosSessionUpdateRequestSchema.parse({
        sessionId,
        pinned: true,
        archived: true,
      })
    ).toThrow()
    expect(() => AosSessionUpdateRequestSchema.parse({ sessionId })).toThrow()
  })

  it("accepts only normalized history parts and stable Session creation identities", () => {
    const response = SessionHistoryResponseSchema.parse({
      sessionId: "hermes:researcher:stored-1",
      messages: [
        {
          id: "user-1",
          role: "user",
          createdAt: "2026-01-01T00:00:00.000Z",
          content: [
            { type: "text", text: "Inspect this" },
            { type: "image", image: "data:image/png;base64,YQ==" },
          ],
        },
        {
          id: "assistant-1",
          role: "assistant",
          createdAt: "2026-01-01T00:00:01.000Z",
          content: [
            { type: "reasoning", text: "Reading" },
            {
              type: "tool-call",
              toolCallId: "read-1",
              toolName: "read_file",
              args: { path: "README.md" },
              argsText: '{"path":"README.md"}',
              result: { ok: true },
            },
            {
              type: "data",
              name: "aos.artifact",
              data: { id: "artifact-1", filename: "report.md" },
            },
            { type: "text", text: "Done" },
          ],
        },
      ],
      total: 2,
      limit: 200,
      offset: 0,
      nextOffset: 2,
    })

    expect(response.messages).toHaveLength(2)
    expect(
      SessionCreateResponseSchema.parse({
        session: {
          id: "hermes:researcher:stored-1",
          agentId: "researcher",
        },
      })
    ).toEqual({
      session: {
        id: "hermes:researcher:stored-1",
        agentId: "researcher",
      },
    })
    expect(() =>
      SessionHistoryResponseSchema.parse({
        ...response,
        messages: [
          {
            id: "native-1",
            role: "assistant",
            createdAt: "2026-01-01T00:00:00.000Z",
            content: [{ type: "text", text: "No leak" }],
            native_position: 41,
          },
        ],
      })
    ).toThrow()
  })

  it("reads a turn meta a later proxy extended, keeping its known keys", () => {
    const meta = AosToolCallMetaSchema.parse({
      sequence: 3,
      turnId: "turn-1",
      messageId: "message-1",
      addedLater: { nested: true },
    })
    expect(meta).toEqual({
      sequence: 3,
      turnId: "turn-1",
      messageId: "message-1",
    })
    expect(() =>
      AosToolCallMetaSchema.parse({ sequence: 3, turnId: 7, messageId: "m" })
    ).toThrow()
  })

  it("reads the provider facts a turn meta carries", () => {
    const subagent = {
      id: "sub-1",
      goal: "audit",
      model: "claude",
      depth: 1,
      status: "completed",
      tokens: 12,
      filesRead: ["/repo/a.ts"],
      filesWritten: [],
      durationMs: 40,
      childSessionId: "session-2",
      summary: "done",
    }
    const tool = {
      sequence: 3,
      turnId: "turn-1",
      messageId: "message-1",
      subagentId: "sub-0",
      parentToolCallId: "call-0",
      startedAt: "2026-09-22T10:00:00.000Z",
      completedAt: "2026-09-22T10:00:01.000Z",
      durationMs: 1000,
      subagent,
    }
    expect(AosToolCallMetaSchema.parse(tool)).toEqual(tool)
    expect(
      AosChunkMetaSchema.parse({
        sequence: 3,
        turnId: "turn-1",
        subagentId: "sub-1",
      })
    ).toEqual({ sequence: 3, turnId: "turn-1", subagentId: "sub-1" })
    const failed = {
      sequence: 3,
      turnId: "turn-1",
      provider: "anthropic",
      model: "claude",
      cost: { amount: 0.25, currency: "USD" },
    }
    expect(AosStateMetaSchema.parse(failed)).toEqual(failed)
  })

  it("keeps a subagent's known keys and refuses a status it does not name", () => {
    const base = { sequence: 3, turnId: "turn-1", messageId: "message-1" }
    expect(
      AosToolCallMetaSchema.parse({
        ...base,
        subagent: { id: "sub-1", addedLater: true },
      }).subagent
    ).toEqual({ id: "sub-1" })
    expect(
      AosToolCallMetaSchema.safeParse({
        ...base,
        subagent: { id: "sub-1", status: "timeout" },
      }).success
    ).toBe(false)
  })

  it("names a pending request by requestId on permissions and questions", () => {
    expect(
      AosPermissionMetaSchema.parse({ requestId: "request-1", extra: 1 })
    ).toEqual({ requestId: "request-1" })
    expect(
      AosElicitationMetaSchema.safeParse({
        interruptId: "request-1",
        questions: [{ prompt: "Which?", options: [] }],
      }).success
    ).toBe(false)
  })

  it("reads a focus report with or without the presence flags", () => {
    expect(
      AosFocusNotificationSchema.parse({ sessionId: "session-1" })
    ).toEqual({ sessionId: "session-1" })
    expect(AosFocusNotificationSchema.parse({ sessionId: null })).toEqual({
      sessionId: null,
    })
    const reported = {
      sessionId: "session-1",
      foreground: false,
      idle: true,
    }
    expect(AosFocusNotificationSchema.parse(reported)).toEqual(reported)
    expect(() =>
      AosFocusNotificationSchema.parse({ sessionId: null, visible: true })
    ).toThrow()
  })

  // The two descriptors Hermes actually publishes: an audio file it recognized
  // by extension, and a `present_artifact` receipt carrying a size for a file
  // whose media type nothing could guess.
  it.each([
    [
      "a media artifact",
      {
        id: "hermes-media-2f6b1c0d4e8a9b7c3d5e1f0a2b4c6d8e",
        filename: "reply.mp3",
        mimeType: "audio/mpeg",
        source: {
          type: "provider",
          reference: "hermes-media-2f6b1c0d4e8a9b7c3d5e1f0a2b4c6d8e",
        },
      },
    ],
    [
      "a published artifact receipt",
      {
        id: "hermes-artifact-9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
        filename: "Quarterly report",
        sizeBytes: 5_242_880,
        source: {
          type: "provider",
          reference: "hermes-artifact-9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
        },
      },
    ],
  ])("accepts %s as its publisher emits it", (_label, descriptor) => {
    expect(AosArtifactDescriptorSchema.parse(descriptor)).toEqual(descriptor)
  })

  it.each([
    ["an unknown field", { sizeBytes: 1, description: "A report" }],
    ["a fractional size", { sizeBytes: 1.5 }],
    ["a negative size", { sizeBytes: -1 }],
    ["an empty media type", { mimeType: "" }],
  ])("refuses an artifact descriptor with %s", (_label, patch) => {
    expect(() =>
      AosArtifactDescriptorSchema.parse({
        id: "artifact-1",
        filename: "report.md",
        source: { type: "provider", reference: "artifact-1" },
        ...patch,
      })
    ).toThrow()
  })

  it.each(["art-1", "report 2026/q3?#final.md", "תרשים:1"])(
    "names the artifact %s in a link uri it reads back",
    (artifactId) => {
      const uri = formatArtifactUri(artifactId)

      expect(uri.startsWith("artifact://")).toBe(true)
      expect(new URL(uri).protocol).toBe(AOS_ARTIFACT_URI_SCHEME)
      expect(parseArtifactUri(uri)).toBe(artifactId)
    }
  )

  it("encodes an id so no route or query can ride on a link", () => {
    expect(formatArtifactUri("a/b?c#d")).toBe("artifact://a%2Fb%3Fc%23d")
  })

  it.each([
    "https://aos.example/api/aos/v1/artifacts/art-1",
    "artifact:art-1",
    "artifact://",
    "artifact://a/b",
    "artifact://a?b",
    "artifact://%E0%A4%A",
    "aos-attachment:stage-1/att-1",
  ])("reads no artifact from %s", (uri) => {
    expect(parseArtifactUri(uri)).toBeUndefined()
  })

  it("reads an older history page only through a server-issued cursor", () => {
    expect(
      AosReplayBeforeSchema.parse({ type: "_aos/before", cursor: "500" })
    ).toEqual({ type: "_aos/before", cursor: "500" })
    expect(
      AosReplayBeforeSchema.parse({
        type: "_aos/before",
        cursor: "500",
        _meta: { client: {} },
      })
    ).toMatchObject({ cursor: "500" })
    for (const invalid of [
      { type: "_aos/before" },
      { type: "_aos/before", cursor: 500 },
      { type: "_aos/before", cursor: "" },
      { type: "_aos/before", cursor: "500", limit: 10 },
      { type: "_aos/after", cursor: "500" },
    ]) {
      expect(AosReplayBeforeSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it("reads the history cursor a replaying resume returns", () => {
    const history = AosSessionResumeResponseMetaSchema.shape.history
    expect(history.parse({ nextCursor: "500" })).toEqual({ nextCursor: "500" })
    expect(history.parse({ truncated: true })).toEqual({ truncated: true })
    expect(history.parse(undefined)).toBeUndefined()
  })

  it("tells an older page's updates apart from live ones", () => {
    expect(
      AosHistoryPageTagSchema.parse({
        sequence: 0,
        turnId: "history",
        historyPage: { cursor: "500" },
      }).historyPage
    ).toEqual({ cursor: "500" })
    expect(
      AosHistoryPageTagSchema.parse({ sequence: 3, turnId: "turn-1" })
        .historyPage
    ).toBeUndefined()
  })

  it("reads an older proxy's extensions as offering no history pages", () => {
    const extensions = {
      steer: true,
      rewind: true,
      composerPrefill: true,
      agents: true,
      invalidation: true,
      activity: true,
      readState: true,
      focus: true,
      guestProjection: true,
    }
    expect(AosExtensionsSchema.parse(extensions).historyPages).toBe(false)
    expect(
      AosExtensionsSchema.parse({ ...extensions, historyPages: true })
        .historyPages
    ).toBe(true)
  })

  it("announces artifacts in the message stream, not as a notification", () => {
    expect(Object.values(AOS_METHODS.notify)).not.toContain("_aos/artifact")
  })
})

describe("MCP App view", () => {
  it("carries the view's HTML, sandbox policy, and the call it renders", () => {
    const view = {
      html: "<!doctype html><p>forecast</p>",
      csp: { connectDomains: ["https://api.weather.example"] },
      permissions: { clipboardWrite: {} },
      prefersBorder: true,
      toolInput: { city: "Haifa" },
      toolResult: { content: [{ type: "text", text: "sunny" }] },
    }
    expect(McpAppViewSchema.parse(view)).toEqual(view)
  })

  it("never carries a resource URI", () => {
    expect(
      McpAppViewSchema.safeParse({ html: "", resourceUri: "ui://x/view" })
        .success
    ).toBe(false)
  })
})
