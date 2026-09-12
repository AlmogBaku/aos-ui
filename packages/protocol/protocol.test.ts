import { describe, expect, it } from "vitest"

import {
  AgentCatalogResponseSchema,
  ErrorResponseSchema,
  OperatorAuthStateSchema,
  RuntimeAuthStateSchema,
  RuntimeInfoSchema,
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
  SessionModelSelectRequestSchema,
  SessionModelsResponseSchema,
  SessionTodosResponseSchema,
  SessionWorkspaceCapabilitiesResponseSchema,
  VisibilityUpdateRequestSchema,
} from "./index"

describe("AOS v1 normalized protocol", () => {
  it("validates the normalized Hermes Session workspace and content envelopes", () => {
    expect(
      SessionWorkspaceCapabilitiesResponseSchema.parse({
        workspace: {
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
          approvals: {
            status: "available",
            protocol: "ag-ui-interrupt",
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
            protocol: "ag-ui-interrupt",
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
      SessionModelSelectRequestSchema.parse({
        selectedId: '["native","small"]',
      })
    ).toEqual({ selectedId: '["native","small"]' })
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

  it("accepts only the public operator authentication states", () => {
    expect(
      OperatorAuthStateSchema.parse({
        status: "authenticated",
        operator: { id: "operator@example.test", displayName: "Operator" },
      })
    ).toEqual({
      status: "authenticated",
      operator: { id: "operator@example.test", displayName: "Operator" },
    })
    expect(() =>
      OperatorAuthStateSchema.parse({
        status: "authenticated",
        operator: { id: "operator@example.test", accessToken: "secret" },
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
          sessionDeletion: { status: "available" },
          sessionRun: { status: "available" },
          sessionStop: { status: "available" },
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
      ErrorResponseSchema.parse({ error: { code: "run_conflict" } })
    ).toEqual({ error: { code: "run_conflict" } })
    expect(
      ErrorResponseSchema.parse({
        error: { code: "run_capacity_exceeded" },
      })
    ).toEqual({ error: { code: "run_capacity_exceeded" } })
    expect(
      ErrorResponseSchema.parse({
        error: { code: "runtime_authentication_required" },
      })
    ).toEqual({ error: { code: "runtime_authentication_required" } })
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
})
