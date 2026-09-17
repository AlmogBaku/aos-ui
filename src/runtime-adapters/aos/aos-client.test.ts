import { EventType } from "@ag-ui/core"
import { describe, expect, it, vi } from "vitest"

import { AosClientError, AosRemoteClient } from "./aos-client"

const catalog = {
  revision: "profiles:researcher@hermes-bots:7",
  agents: [
    {
      summary: {
        kind: "ready" as const,
        id: "researcher",
        name: "Researcher",
        activity: "unknown" as const,
        visibility: "visible" as const,
      },
      visibility: "visible" as const,
      selectable: true,
      editable: true,
      revision: "hermes-bots:7",
    },
  ],
}

/** The normalized failure fields a caller can observe, whatever the request. */
async function normalizedFailure(
  fetcher: typeof fetch,
  operation: (client: AosRemoteClient) => Promise<unknown>
) {
  const client = new AosRemoteClient({ fetcher: vi.fn(fetcher) })
  client.adoptSessionOwnership("session-1", "researcher")
  try {
    await operation(client)
    return undefined
  } catch (error) {
    const { name, kind, message, code } = error as AosClientError
    return { name, kind, message, code }
  }
}

describe("provider-neutral AOS browser client", () => {
  it("uses a normalized error description instead of proxy response details", async () => {
    const client = new AosRemoteClient({
      fetcher: vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "temporarily_unavailable",
              description:
                "The service is temporarily unavailable. Please try again.",
            },
          },
          { status: 503 }
        )
      ),
    })

    await expect(client.listAgentCatalog()).rejects.toMatchObject({
      name: "AosClientError",
      kind: "provider-unavailable",
      message: "The service is temporarily unavailable. Please try again.",
    } satisfies Partial<AosClientError>)
  })

  it("does not subscribe before a Session owner has been restored", () => {
    const client = new AosRemoteClient({ fetcher: vi.fn() })

    expect(() =>
      client.subscribeSessionInvalidation("unknown", vi.fn())
    ).not.toThrow()
  })

  it("rehydrates immutable Session ownership from normalized thread metadata", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      void input
      return Response.json({
        id: "session-1",
        agentId: "researcher",
        title: "Research",
        archived: false,
        updatedAt: "2026-01-02T00:00:00.000Z",
        status: "idle",
      })
    })
    const client = new AosRemoteClient({ fetcher })

    client.adoptSessionOwnership("session-1", "researcher")

    await expect(client.getSession("session-1")).resolves.toMatchObject({
      id: "session-1",
      agentId: "researcher",
    })
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "/api/aos/v1/agents/researcher/sessions/session-1"
    )
    expect(() => client.adoptSessionOwnership("session-1", "other")).toThrow(
      "Conflicting Session ownership metadata"
    )
  })

  it("maps a selected Session's normalized workspace, content, and audio operations", async () => {
    const session = {
      id: "opaque-session-1",
      agentId: "researcher",
      title: "Research",
      archived: false,
      updatedAt: "2026-01-02T00:00:00.000Z",
      status: "waiting-for-input" as const,
    }
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
        if (path.endsWith("/agents/researcher/sessions?limit=50&offset=0"))
          return Response.json({
            sessions: [session],
            total: 1,
            limit: 50,
            offset: 0,
          })
        if (path.endsWith("/workspace/capabilities"))
          return Response.json({
            agent: {
              transport: { streaming: true, resumable: true },
              reasoning: { supported: true, streaming: true },
              multimodal: {
                input: { image: true, audio: false, file: true },
                output: { audio: false },
              },
              humanInTheLoop: {
                supported: true,
                approvals: true,
                interrupts: true,
              },
            },
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
              todos: {
                status: "available",
                scope: "session",
                mode: "read-only-projection",
                source: "latest-completed-todo-tool-result",
              },
              activity: {
                status: "available",
                scope: "attached-active-session",
                coverage: "active-session-only",
                source: "session.info",
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
                protocol: "ag-ui-interrupt",
                scope: "run",
                choices: [
                  { value: "once", scope: "request" },
                  { value: "session", scope: "session" },
                  { value: "always", scope: "agent" },
                  { value: "deny", scope: "request" },
                ],
                maxPending: 1,
              },
              questions: {
                status: "available",
                protocol: "ag-ui-interrupt",
                scope: "run",
                answerModes: ["single", "multiple", "free-text"],
                cancellation: "native-empty-answer",
                maxQuestions: 1,
                maxChoicesPerQuestion: 1,
                maxAnswerValuesPerQuestion: 1,
                maxStringBytes: 1,
              },
              reactions: { status: "unavailable", reason: "not-supported" },
            },
            content: {
              attachments: {
                status: "available",
                scope: "attached-session",
                inputs: ["image", "file"],
                imageMimeTypes: ["image/png"],
                fileMimeTypes: "valid-type/subtype",
                maxMimeTypeBytes: 1,
                maxFilenameBytes: 1,
                maxCount: 1,
                maxImageBytes: 1,
                maxFileBytes: 1,
                maxTotalBytes: 1,
              },
              artifacts: { status: "unavailable", reason: "not-supported" },
              transcription: {
                status: "unavailable",
                reason: "not-supported",
              },
              speech: { status: "unavailable", reason: "not-supported" },
            },
          })
        if (path.endsWith("/workspace/models"))
          return Response.json({
            selectedId: "native/small",
            options: [{ id: "native/small", label: "Small", group: "Native" }],
          })
        if (path.endsWith("/workspace/models/select")) {
          expect(init?.method).toBe("POST")
          expect(init?.body).toBe(
            JSON.stringify({ selectedId: "native/small" })
          )
          return Response.json({ selectedId: "native/small" })
        }
        if (path.endsWith("/workspace/context"))
          return Response.json({
            usedTokens: 1200,
            maxTokens: 8000,
            estimated: true,
            source: "provider-usage-plus-estimate",
            breakdown: {
              systemTokens: 100,
              toolTokens: 200,
              messageTokens: 900,
            },
          })
        if (path.endsWith("/attachments/stage")) {
          expect(init?.method).toBe("POST")
          expect(JSON.parse(String(init?.body))).toEqual({
            attachments: [
              {
                type: "file",
                filename: "brief.pdf",
                mimeType: "application/pdf",
                dataUrl: "data:application/pdf;base64,AQ==",
              },
            ],
          })
          return Response.json({
            stageId: "stage-1",
            attachments: [
              {
                type: "file",
                filename: "brief.pdf",
                mimeType: "application/pdf",
              },
            ],
          })
        }
        if (path.endsWith("/artifacts/artifact-1"))
          return new Response(Uint8Array.from([1, 2, 3]), {
            headers: { "content-type": "application/pdf" },
          })
        if (path.endsWith("/audio/transcribe")) {
          expect(init?.method).toBe("POST")
          return Response.json({ transcript: "Hello" })
        }
        if (path.endsWith("/audio/speak"))
          return new Response(Uint8Array.from([1, 2]), {
            headers: { "content-type": "audio/mpeg" },
          })
        throw new Error(`Unexpected normalized request: ${path}`)
      }
    )
    const client = new AosRemoteClient({ fetcher })
    await client.listSessions("researcher")

    await expect(
      client.workspaceCapabilities(session.id)
    ).resolves.toMatchObject({
      workspace: {
        slashCommands: {
          status: "available",
          commands: [{ name: "help", description: "Show help" }],
        },
        models: { status: "available" },
      },
    })
    await client.workspaceCapabilities(session.id)
    await expect(client.models(session.id)).resolves.toMatchObject({
      selectedId: "native/small",
    })
    await expect(
      client.selectModel(session.id, "native/small")
    ).resolves.toEqual({ selectedId: "native/small" })
    await expect(client.context(session.id)).resolves.toMatchObject({
      usedTokens: 1200,
    })
    await expect(
      client.stageAttachments(session.id, [
        {
          type: "file",
          filename: "brief.pdf",
          mimeType: "application/pdf",
          dataUrl: "data:application/pdf;base64,AQ==",
        },
      ])
    ).resolves.toMatchObject({ stageId: "stage-1" })
    await expect(
      client.readArtifact(session.id, "artifact-1")
    ).resolves.toBeInstanceOf(Blob)
    expect(fetcher.mock.calls.map(([input]) => String(input))).not.toContain(
      "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/artifacts"
    )
    await expect(
      client.transcribe(session.id, new Blob(["audio"], { type: "audio/webm" }))
    ).resolves.toBe("Hello")
    await expect(client.speak(session.id, "Hello")).resolves.toBeInstanceOf(
      Blob
    )
    expect(
      fetcher.mock.calls.filter(([input]) =>
        String(input).endsWith("/workspace/capabilities")
      )
    ).toHaveLength(1)
    expect(
      fetcher.mock.calls.filter(([input]) =>
        /\/(?:workspace\/(?:todos|activity)|interactions\/pending|audio)$/u.test(
          String(input)
        )
      )
    ).toHaveLength(0)
  })

  it("uses an Agent directly for draft voice without requiring Session ownership", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith("/audio/transcribe"))
        return Response.json({ transcript: "Draft dictation" })
      if (path.endsWith("/audio/speak"))
        return new Response(new Blob(["audio"], { type: "audio/mpeg" }), {
          headers: { "content-type": "audio/mpeg" },
        })
      throw new Error(`Unexpected request: ${path}`)
    })
    const client = new AosRemoteClient({ fetcher })

    await expect(
      client.transcribeForAgent(
        "researcher",
        new Blob(["audio"], { type: "audio/webm" })
      )
    ).resolves.toBe("Draft dictation")
    await expect(
      client.speakForAgent("researcher", "Hello")
    ).resolves.toBeInstanceOf(Blob)
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/aos/v1/agents/researcher/audio/transcribe",
      "/api/aos/v1/agents/researcher/audio/speak",
    ])
  })

  it("projects PLAN snapshots and deltas without a Todo request", async () => {
    const session = {
      id: "session-1",
      agentId: "researcher",
      title: "Research",
      archived: false,
      updatedAt: "2026-01-02T00:00:00.000Z",
      status: "waiting-for-input" as const,
    }
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith("/agents/researcher/sessions?limit=50&offset=0"))
        return Response.json({
          sessions: [session],
          total: 1,
          limit: 50,
          offset: 0,
        })
      throw new Error(`Unexpected normalized request: ${path}`)
    })
    const client = new AosRemoteClient({ fetcher })
    await client.listSessions("researcher")
    const snapshots: unknown[] = []
    const unsubscribe = client.subscribeTodos("session-1", (todos) =>
      snapshots.push(todos)
    )
    await Promise.resolve()
    client.acceptRunEvent("session-1", {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "aos-plan:session-1",
      activityType: "PLAN",
      content: {
        todos: [{ id: "todo-1", label: "Ship", status: "active" }],
      },
      replace: true,
    })
    client.acceptRunEvent("session-1", {
      type: EventType.ACTIVITY_DELTA,
      messageId: "aos-plan:session-1",
      activityType: "PLAN",
      patch: [
        {
          op: "replace",
          path: "/todos",
          value: [{ id: "todo-1", label: "Ship", status: "completed" }],
        },
      ],
    })

    expect(snapshots).toEqual([
      [],
      [{ id: "todo-1", label: "Ship", status: "active" }],
      [{ id: "todo-1", label: "Ship", status: "completed" }],
    ])
    expect(fetcher).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("derives Session status from scoped AG-UI lifecycle events", async () => {
    const session = {
      id: "session-1",
      agentId: "researcher",
      title: "Research",
      archived: false,
      updatedAt: "2026-01-02T00:00:00.000Z",
      status: "idle" as const,
    }
    const client = new AosRemoteClient({
      fetcher: vi.fn(async () =>
        Response.json({
          sessions: [session],
          total: 1,
          limit: 50,
          offset: 0,
        })
      ),
    })
    await client.listSessions("researcher")
    const activities: unknown[] = []
    const unsubscribe = client.subscribeActivity((event) =>
      activities.push(event)
    )

    client.acceptRunEvent("session-1", {
      type: EventType.RUN_STARTED,
      threadId: "another-session",
      runId: "foreign-run",
    })
    expect(client.sessionStatus("session-1")).toBe("idle")

    client.acceptRunEvent("session-1", {
      type: EventType.RUN_STARTED,
      threadId: "session-1",
      runId: "run-1",
    })
    expect(client.sessionStatus("session-1")).toBe("running")

    client.acceptRunEvent("session-1", {
      type: EventType.RUN_FINISHED,
      threadId: "session-1",
      runId: "run-1",
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "question-1", reason: "question" }],
      },
    })
    expect(client.sessionStatus("session-1")).toBe("waiting-for-input")
    expect(activities).toEqual([
      expect.objectContaining({ type: "run-started", threadId: "session-1" }),
      expect.objectContaining({
        type: "attention-requested",
        threadId: "session-1",
        requestId: "question-1",
      }),
    ])
    unsubscribe()
  })

  it("reads only normalized same-origin runtime and catalog endpoints", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      const body = path.endsWith("/runtime")
        ? {
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
              sessionSteer: { status: "available" },
            },
          }
        : catalog
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    const client = new AosRemoteClient({ fetcher })

    await expect(client.runtimeInfo()).resolves.toMatchObject({
      status: "ready",
    })
    await expect(client.listAgentCatalog()).resolves.toEqual([
      {
        summary: catalog.agents[0].summary,
        visibility: "visible",
        selectable: true,
        editable: true,
      },
    ])

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/aos/v1/runtime",
      "/api/aos/v1/agents",
    ])
  })

  it("reconciles only real opened Session reads and keeps control/catalog reads direct", async () => {
    const scopes: unknown[] = []
    const reconciler = {
      async read<T>(scope: unknown, operation: () => Promise<T>) {
        scopes.push(scope)
        return operation()
      },
    }
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith("/agents")) return Response.json(catalog)
      if (path.endsWith("/runtime"))
        return Response.json({
          runtime: { id: "hermes", name: "Hermes" },
          status: "unavailable",
          capabilities: {
            agentCatalog: { status: "unavailable", reason: "offline" },
            agentVisibility: { status: "unavailable", reason: "offline" },
            sessionCatalog: { status: "unavailable", reason: "offline" },
            sessionHistory: { status: "unavailable", reason: "offline" },
            sessionDetail: { status: "unavailable", reason: "offline" },
            sessionCreation: { status: "unavailable", reason: "offline" },
            sessionTitle: { status: "unavailable", reason: "offline" },
            sessionArchival: { status: "unavailable", reason: "offline" },
            sessionDeletion: { status: "unavailable", reason: "offline" },
            sessionRun: { status: "unavailable", reason: "offline" },
            sessionStop: { status: "unavailable", reason: "offline" },
            sessionSteer: { status: "unavailable", reason: "offline" },
          },
        })
      if (path.endsWith("/sessions?limit=50&offset=0"))
        return Response.json({
          sessions: [
            {
              id: "hermes:researcher:stored",
              agentId: "researcher",
              title: "Research",
              archived: false,
              updatedAt: "2026-01-02T00:00:00.000Z",
              status: "idle",
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        })
      if (path.endsWith("/sessions/hermes%3Aresearcher%3Astored"))
        return Response.json({
          id: "hermes:researcher:stored",
          agentId: "researcher",
          title: "Research",
          archived: false,
          updatedAt: "2026-01-02T00:00:00.000Z",
          status: "idle",
        })
      if (path.includes("/sessions/hermes%3Aresearcher%3Astored/history?"))
        return Response.json({
          sessionId: "hermes:researcher:stored",
          messages: [],
          total: 0,
          limit: 200,
          offset: 0,
          nextOffset: 0,
        })
      if (path.endsWith("/sessions?limit=50&offset=0"))
        return Response.json({
          sessions: [],
          total: 0,
          limit: 50,
          offset: 0,
        })
      throw new Error(`Unexpected path: ${path}`)
    })
    const client = new AosRemoteClient({ fetcher, reconciler })

    await client.runtimeInfo()
    await client.listAgentCatalog()
    await client.listSessions("researcher")
    await client.listSessionCatalog()
    await client.getSession("hermes:researcher:stored")
    await client.loadHistory("hermes:researcher:stored")

    expect(scopes).toEqual([
      {
        workspaceId: "operator",
        agentId: "researcher",
        sessionId: "hermes:researcher:stored",
      },
      {
        workspaceId: "operator",
        agentId: "researcher",
        sessionId: "hermes:researcher:stored",
      },
    ])
  })

  it("sends the last observed Agent revision on visibility writes", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(catalog), {
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            revision: "profiles:researcher@hermes-bots:8",
            agent: {
              ...catalog.agents[0],
              visibility: "hidden",
              selectable: false,
              revision: "hermes-bots:8",
              summary: {
                ...catalog.agents[0].summary,
                visibility: "hidden",
              },
            },
          }),
          { headers: { "content-type": "application/json" } }
        )
      )
    const client = new AosRemoteClient({ fetcher })
    await client.listAgentCatalog()
    await client.updateAgentVisibility("researcher", "hidden")

    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/aos/v1/agents/researcher/visibility",
      expect.objectContaining({
        method: "PATCH",
        credentials: "same-origin",
        body: JSON.stringify({
          visibility: "hidden",
          revision: "hermes-bots:7",
        }),
      })
    )
  })

  it("rejects malformed provider-shaped catalog data", async () => {
    const client = new AosRemoteClient({
      fetcher: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...catalog,
              agents: [{ ...catalog.agents[0], ui_meta: { path: "/private" } }],
            })
          )
      ),
    })
    await expect(client.listAgentCatalog()).rejects.toThrow(
      "Invalid AOS proxy response"
    )
  })

  it("manages normalized Session metadata and lifecycle by observed ownership", async () => {
    const session = {
      id: "opaque-session-1",
      agentId: "researcher",
      title: "Research",
      archived: false,
      updatedAt: "2026-01-02T00:00:00.000Z",
      status: "idle" as const,
    }
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
        if (path.endsWith("/agents/researcher/sessions?limit=50&offset=0"))
          return Response.json({
            sessions: [session],
            total: 1,
            limit: 50,
            offset: 0,
          })
        if (
          path.endsWith("/agents/researcher/sessions") &&
          init?.method === "POST"
        )
          return Response.json(
            { session: { id: "opaque-session-2", agentId: "researcher" } },
            { status: 201 }
          )
        if (path.endsWith("/agents/researcher/sessions/opaque-session-1")) {
          if (init?.method === "PATCH" || init?.method === "DELETE")
            return new Response(null, { status: 204 })
          return Response.json(session)
        }
        if (path.endsWith("/agents/researcher/sessions/opaque-session-2"))
          return Response.json({
            ...session,
            id: "opaque-session-2",
            title: "New",
          })
        throw new Error(`Unexpected normalized request: ${path}`)
      }
    )
    const client = new AosRemoteClient({ fetcher })

    await expect(client.listSessions("researcher")).resolves.toMatchObject({
      sessions: [session],
    })
    await expect(
      client.getSessionMetadata(["opaque-session-1", "missing"])
    ).resolves.toEqual([
      {
        threadId: "opaque-session-1",
        agentId: "researcher",
        updatedAt: "2026-01-02T00:00:00.000Z",
        status: "idle",
      },
    ])
    await expect(
      client.createSession("researcher", { title: "New" })
    ).resolves.toEqual({ threadId: "opaque-session-2" })
    await expect(
      client.getSessionMetadata(["opaque-session-2"])
    ).resolves.toEqual([
      {
        threadId: "opaque-session-2",
        agentId: "researcher",
        updatedAt: "2026-01-02T00:00:00.000Z",
        status: "idle",
      },
    ])
    await expect(client.getSession("opaque-session-1")).resolves.toEqual(
      session
    )
    await client.renameSession("opaque-session-1", "Renamed")
    await client.archiveSession("opaque-session-1")
    await client.unarchiveSession("opaque-session-1")
    await client.deleteSession("opaque-session-1")
    await expect(client.archiveSession("unknown-session")).rejects.toThrow(
      "Session ownership is unknown"
    )

    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/aos/v1/agents/researcher/sessions?limit=50&offset=0",
      "/api/aos/v1/agents/researcher/sessions",
      "/api/aos/v1/agents/researcher/sessions/opaque-session-2",
      "/api/aos/v1/agents/researcher/sessions/opaque-session-1",
      "/api/aos/v1/agents/researcher/sessions/opaque-session-1",
      "/api/aos/v1/agents/researcher/sessions/opaque-session-1",
      "/api/aos/v1/agents/researcher/sessions/opaque-session-1",
      "/api/aos/v1/agents/researcher/sessions/opaque-session-1",
    ])
  })

  it("loads normalized chronological history pages without native disclosure", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith("/agents/researcher/sessions?limit=50&offset=0"))
        return Response.json({
          sessions: [
            {
              id: "opaque-session-1",
              agentId: "researcher",
              title: "Research",
              archived: false,
              updatedAt: "2026-01-02T00:00:00.000Z",
              status: "idle",
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        })
      const offset = 0
      return Response.json({
        sessionId: "opaque-session-1",
        messages: [
          {
            id: "message-1",
            role: "user",
            content: [
              {
                type: "text",
                text: "Question",
              },
            ],
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "aos-plan:opaque-session-1",
            role: "activity",
            activityType: "PLAN",
            content: {
              todos: [
                {
                  id: "todo-1",
                  label: "Ship",
                  status: "active",
                },
              ],
            },
          },
        ],
        total: 3,
        limit: 200,
        offset,
        nextOffset: 2,
      })
    })
    const client = new AosRemoteClient({ fetcher })
    await client.listSessions("researcher")
    const plans: unknown[] = []
    const unsubscribe = client.subscribeTodos("opaque-session-1", (todos) =>
      plans.push(todos)
    )
    await Promise.resolve()

    await expect(client.loadHistory("opaque-session-1")).resolves.toMatchObject(
      {
        sessionId: "opaque-session-1",
        messages: [{ id: "message-1" }],
      }
    )
    expect(plans).toEqual([
      [],
      [{ id: "todo-1", label: "Ship", status: "active" }],
    ])
    unsubscribe()
    expect(fetcher.mock.calls.slice(1).map(([input]) => String(input))).toEqual(
      [
        "/api/aos/v1/agents/researcher/sessions/opaque-session-1/history?limit=200&offset=0",
      ]
    )
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("/api/sessions")
  })

  it("sends deliberate Stop to the selected normalized Session route", async () => {
    const session = {
      id: "hermes:researcher:stored",
      agentId: "researcher",
      title: "Research",
      archived: false,
      updatedAt: "2026-01-02T00:00:00.000Z",
      status: "running" as const,
    }
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.endsWith("/agents/researcher/sessions?limit=50&offset=0"))
        return Response.json({
          sessions: [session],
          total: 1,
          limit: 50,
          offset: 0,
        })
      if (
        path.endsWith(
          "/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs/stop"
        )
      )
        return Response.json({ status: "stopping" }, { status: 202 })
      throw new Error(`Unexpected normalized request: ${path}`)
    })
    const client = new AosRemoteClient({ fetcher })
    await client.listSessions("researcher")

    await expect(client.stopRun("hermes:researcher:stored")).resolves.toEqual({
      status: "stopping",
    })
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/aos/v1/agents/researcher/sessions/hermes%3Aresearcher%3Astored/runs/stop",
      expect.objectContaining({ method: "POST", credentials: "same-origin" })
    )
  })

  it("steers with the internally tracked active run and preserves normalized conflicts", async () => {
    const session = {
      id: "stored",
      agentId: "researcher",
      title: "Research",
      archived: false,
      updatedAt: "2026-01-02T00:00:00.000Z",
      status: "running" as const,
    }
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
        if (path.endsWith("/agents/researcher/sessions?limit=50&offset=0"))
          return Response.json({
            sessions: [session],
            total: 1,
            limit: 50,
            offset: 0,
          })
        if (path.endsWith("/agents/researcher/sessions/stored/runs/steer")) {
          expect(JSON.parse(String(init?.body))).toEqual({
            requestId: "queue-item-1",
            expectedRunId: "run-1",
            text: "Use the newer API",
          })
          return Response.json({ status: "queued" }, { status: 202 })
        }
        throw new Error(`Unexpected normalized request: ${path}`)
      }
    )
    const client = new AosRemoteClient({ fetcher })
    await client.listSessions("researcher")
    client.acceptRunEvent("stored", {
      type: EventType.RUN_STARTED,
      threadId: "stored",
      runId: "run-1",
    })

    await expect(
      client.steerRun("stored", {
        requestId: "queue-item-1",
        text: "Use the newer API",
      })
    ).resolves.toEqual({ status: "queued" })
    expect(client.needsSteeringReconciliation("stored")).toBe(true)
    client.completeSteeringReconciliation("stored")
    expect(client.needsSteeringReconciliation("stored")).toBe(false)

    client.acceptRunEvent("stored", {
      type: EventType.CUSTOM,
      name: "aos.steer.accepted",
      value: {
        requestId: "queue-item-replayed",
        text: "Replay survived the lost HTTP acknowledgement",
        delivery: "steered",
      },
    })
    expect(client.needsSteeringReconciliation("stored")).toBe(true)

    const conflictClient = new AosRemoteClient({
      fetcher: vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "run_conflict",
              description: "The active run changed.",
            },
          },
          { status: 409 }
        )
      ),
    })
    conflictClient.adoptSessionOwnership("stored", "researcher")
    conflictClient.acceptRunEvent("stored", {
      type: EventType.RUN_STARTED,
      threadId: "stored",
      runId: "run-1",
    })
    await expect(
      conflictClient.steerRun("stored", {
        requestId: "queue-item-2",
        text: "Correction",
      })
    ).rejects.toMatchObject({ code: "run_conflict" })
  })

  it("prefers the provider Session status once no run is observed", async () => {
    let providerStatus: "running" | "idle" = "running"
    const client = new AosRemoteClient({
      fetcher: vi.fn(async () =>
        Response.json({
          sessions: [
            {
              id: "session-1",
              agentId: "researcher",
              title: "Research",
              archived: false,
              updatedAt: "2026-01-02T00:00:00.000Z",
              status: providerStatus,
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        })
      ),
    })

    await client.listSessions("researcher")
    expect(client.sessionStatus("session-1")).toBe("running")
    client.acceptRunEvent("session-1", {
      type: EventType.RUN_ERROR,
      code: "AOS_PROVIDER_RUN_FAILED",
      message: "The provider could not complete this run.",
    })
    expect(client.sessionStatus("session-1")).toBe("failed")

    providerStatus = "idle"
    await client.listSessions("researcher")

    expect(client.sessionStatus("session-1")).toBe("idle")
    await expect(client.getSessionMetadata(["session-1"])).resolves.toEqual([
      expect.objectContaining({ threadId: "session-1", status: "idle" }),
    ])
  })

  it("keeps an observed run's derived status ahead of a stale provider read", async () => {
    const client = new AosRemoteClient({
      fetcher: vi.fn(async () =>
        Response.json({
          sessions: [
            {
              id: "session-1",
              agentId: "researcher",
              title: "Research",
              archived: false,
              updatedAt: "2026-01-02T00:00:00.000Z",
              status: "idle" as const,
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        })
      ),
    })

    await client.listSessions("researcher")
    client.acceptRunEvent("session-1", {
      type: EventType.RUN_STARTED,
      threadId: "session-1",
      runId: "run-1",
    })
    await client.listSessions("researcher")

    expect(client.sessionStatus("session-1")).toBe("running")
  })

  it("keeps a recoverable run error running so the browser can reconnect", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ status: "steered" })
    )
    const client = new AosRemoteClient({ fetcher })
    client.adoptSessionOwnership("session-1", "researcher")
    client.acceptRunEvent("session-1", {
      type: EventType.RUN_STARTED,
      threadId: "session-1",
      runId: "run-1",
    })

    client.acceptRunEvent("session-1", {
      type: EventType.RUN_ERROR,
      code: "AOS_SEND_UNCERTAIN",
      message: "The message may have been accepted.",
    })

    expect(client.sessionStatus("session-1")).toBe("running")
    await expect(
      client.steerRun("session-1", {
        requestId: "queue-item-1",
        text: "Still steerable",
      })
    ).resolves.toEqual({ status: "steered" })
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      expectedRunId: "run-1",
    })
  })

  it("forgets the observed run on Stop so steering cannot target it", async () => {
    let providerStatus: "running" | "idle" = "running"
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = String(input)
      if (path.endsWith("/runs/stop"))
        return Response.json({ status: "stopping" }, { status: 202 })
      return Response.json({
        sessions: [
          {
            id: "session-1",
            agentId: "researcher",
            title: "Research",
            archived: false,
            updatedAt: "2026-01-02T00:00:00.000Z",
            status: providerStatus,
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      })
    })
    const client = new AosRemoteClient({ fetcher })
    await client.listSessions("researcher")
    client.acceptRunEvent("session-1", {
      type: EventType.RUN_STARTED,
      threadId: "session-1",
      runId: "run-1",
    })

    await expect(client.stopRun("session-1")).resolves.toEqual({
      status: "stopping",
    })

    await expect(
      client.steerRun("session-1", {
        requestId: "queue-item-1",
        text: "Too late",
      })
    ).rejects.toMatchObject({ code: "run_conflict" })
    providerStatus = "idle"
    await client.listSessions("researcher")
    expect(client.sessionStatus("session-1")).toBe("idle")
  })

  it.each([
    [
      "an unreachable proxy",
      async () => {
        throw new TypeError("Failed to fetch")
      },
      {
        name: "AosClientError",
        kind: "connection-interrupted",
        message: "AOS proxy request failed",
        code: undefined,
      },
    ],
    [
      "an unavailable provider",
      async () =>
        Response.json(
          {
            error: {
              code: "temporarily_unavailable",
              description:
                "The service is temporarily unavailable. Please try again.",
            },
          },
          { status: 503 }
        ),
      {
        name: "AosClientError",
        kind: "provider-unavailable",
        message: "The service is temporarily unavailable. Please try again.",
        code: "temporarily_unavailable",
      },
    ],
  ] satisfies Array<[string, typeof fetch, Record<string, unknown>]>)(
    "reports %s the same way for a Session write as for a Session read",
    async (_name, fetcher, expected) => {
      expect(
        await normalizedFailure(fetcher, (client) =>
          client.deleteSession("session-1")
        )
      ).toEqual(expected)
      expect(
        await normalizedFailure(fetcher, (client) =>
          client.getSession("session-1")
        )
      ).toEqual(expected)
    }
  )
})
