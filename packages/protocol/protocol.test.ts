import { describe, expect, it } from "vitest"

import {
  AgentCatalogResponseSchema,
  ErrorResponseSchema,
  INTERACTION_PROTOCOL,
  RuntimeAuthStateSchema,
  RuntimeInfoSchema,
  RunSteerRequestSchema,
  RunSteerResponseSchema,
  RunStopResponseSchema,
  SessionCatalogResponseSchema,
  SessionCreateResponseSchema,
  SessionHistoryResponseSchema,
  SessionInteractionSnapshotResponseSchema,
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
  VisibilityUpdateRequestSchema,
} from "./index"
import {
  AosArtifactDescriptorSchema,
  AosElicitationMetaSchema,
  AosFocusNotificationSchema,
  AosPermissionMetaSchema,
  AosSessionUpdateRequestSchema,
  AosChunkMetaSchema,
  AosStateMetaSchema,
  AosToolCallMetaSchema,
} from "./acp"

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
          scope: "run",
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
          scope: "run",
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
          scope: "run",
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
            reason: "session-info-unavailable",
          },
        },
        interactions: {
          steering: {
            status: "available",
            scope: "active-run",
            semantics: "visible-user-message",
            input: "text",
            fallback: "provider-queue",
          },
          approvals: {
            status: "available",
            protocol: INTERACTION_PROTOCOL,
            scope: "run",
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
            scope: "run",
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
      SessionInteractionSnapshotResponseSchema.parse({
        runId: "aos-hermes-restored-interaction",
        running: true,
        status: "waiting-for-input",
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: "approval-1",
              reason: "approval",
              message: "Allow this action?",
              responseSchema: { type: "string", enum: ["once", "deny"] },
            },
          ],
        },
      })
    ).toMatchObject({
      status: "waiting-for-input",
      outcome: { type: "interrupt" },
    })
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
    expect(RunStopResponseSchema.parse({ status: "stopping" })).toEqual({
      status: "stopping",
    })
    expect(() =>
      RunStopResponseSchema.parse({
        status: "stopping",
        liveSessionId: "native-secret",
      })
    ).toThrow()
  })

  it("validates strict active-turn steering envelopes and their UTF-8 limit", () => {
    expect(
      RunSteerRequestSchema.parse({
        requestId: "queue-item-1",
        expectedRunId: "run-1",
        text: "Please use the newer API",
      })
    ).toEqual({
      requestId: "queue-item-1",
      expectedRunId: "run-1",
      text: "Please use the newer API",
    })
    expect(RunSteerResponseSchema.parse({ status: "steered" })).toEqual({
      status: "steered",
    })
    expect(RunSteerResponseSchema.parse({ status: "queued" })).toEqual({
      status: "queued",
    })
    expect(() =>
      RunSteerRequestSchema.parse({
        requestId: "queue-item-1",
        expectedRunId: "run-1",
        text: "",
      })
    ).toThrow()
    expect(() =>
      RunSteerRequestSchema.parse({
        requestId: "queue-item-1",
        expectedRunId: "run-1",
        text: "😀".repeat(262_145),
      })
    ).toThrow()
    expect(() =>
      RunSteerRequestSchema.parse({
        requestId: "queue-item-1",
        expectedRunId: "run-1",
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
          sessionRun: { status: "available" },
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
          code: "run_conflict",
          description: "A run is already active for this session.",
        },
      })
    ).toEqual({
      error: {
        code: "run_conflict",
        description: "A run is already active for this session.",
      },
    })
    expect(
      ErrorResponseSchema.parse({
        error: {
          code: "run_capacity_exceeded",
          description: "AOS is at capacity. Please try again shortly.",
        },
      })
    ).toEqual({
      error: {
        code: "run_capacity_exceeded",
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
          },
          visibility: "visible",
          selectable: true,
          editable: true,
          revision: "hermes-bots:7",
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

  it("requires the observed revision on every visibility update", () => {
    expect(
      VisibilityUpdateRequestSchema.parse({
        visibility: "hidden",
        revision: "hermes-bots:7",
      })
    ).toEqual({ visibility: "hidden", revision: "hermes-bots:7" })
    expect(() =>
      VisibilityUpdateRequestSchema.parse({ visibility: "hidden" })
    ).toThrow()
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
})
