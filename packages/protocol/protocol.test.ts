import { describe, expect, it } from "vitest"

import {
  AgentCatalogResponseSchema,
  HermesAuthStateSchema,
  OperatorAuthStateSchema,
  RuntimeInfoSchema,
  SessionCatalogResponseSchema,
  SessionCreateResponseSchema,
  SessionHistoryResponseSchema,
  VisibilityUpdateRequestSchema,
} from "./index"

describe("AOS v1 normalized protocol", () => {
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

  it("keeps native Hermes authentication material outside browser state", () => {
    expect(
      HermesAuthStateSchema.parse({
        status: "authenticated",
        method: "static-token",
      })
    ).toEqual({ status: "authenticated", method: "static-token" })
    expect(() =>
      HermesAuthStateSchema.parse({
        status: "authenticated",
        method: "static-token",
        token: "secret",
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
