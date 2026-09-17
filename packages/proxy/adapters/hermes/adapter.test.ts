import { describe, expect, it, vi } from "vitest"

import {
  HermesAgentNotFoundError,
  HermesRevisionConflictError,
  HermesSessionConflictError,
  HermesSessionNotFoundError,
  HermesUnavailableError,
  HermesServerAdapter,
  type HermesRpcTransport,
} from "./adapter"
import {
  HermesAuthenticationError,
  HermesHttpError,
  HermesRpcRejectedError,
  HermesRpcUncertainError,
} from "./gateway"
import { rpcRouter } from "./test-utils/rpc-router"
import { ServerRunSteerUncertainError } from "../../core/runtime"
import { HermesRunPublicError, HermesRunRewindConflictError } from "./run"
import { HermesInteractionPublicError } from "./interactions"
import {
  HermesContentScopeError,
  HermesContentUnavailableError,
} from "./content"
import {
  HermesWorkspaceScopeError,
  HermesWorkspaceUnavailableError,
} from "./workspace"

function profile(hidden = false, revision: number | null = 7) {
  return {
    name: "researcher",
    display_name: "Researcher",
    description: "Investigates primary sources",
    ui_meta: {
      aos: { role: "agent", privatePath: "/srv/hermes/researcher" },
      "hermes-bots": { hidden, nativeOnly: "keep-server-side" },
    },
    ui_meta_revisions: revision === null ? {} : { "hermes-bots": revision },
  }
}

describe("Hermes server adapter", () => {
  it("binds workspace models, context, Todos, and activity to the owned stored Session", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "session.resume")
        return {
          session_id: "live-secret",
          running: true,
          status: "working",
          info: {
            running: true,
            usage: {
              context_source: "provider_usage",
              context_estimated: false,
              context_used: 20,
              context_max: 100,
            },
          },
        }
      if (method === "model.options")
        return {
          provider: "native",
          model: "small",
          providers: [{ slug: "native", name: "Native", models: ["small"] }],
        }
      throw new Error(`unexpected ${method}`)
    })
    const http = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions/stored?"))
        return { id: "stored", profile: "researcher", title: "Owned" }
      if (path.includes("/messages?"))
        return {
          session_id: "stored",
          messages: [
            {
              role: "assistant",
              tool_calls: [{ id: "todo-call", function: { name: "todo" } }],
            },
            {
              role: "tool",
              tool_call_id: "todo-call",
              content: JSON.stringify({
                todos: [{ id: "one", content: "Inspect", status: "active" }],
              }),
            },
          ],
        }
      throw new Error(`unexpected ${path}`)
    })
    const adapter = new HermesServerAdapter({ request, http })
    const threadId = "stored"

    await expect(adapter.models("researcher", threadId)).resolves.toEqual({
      selectedId: '["native","small"]',
      options: [{ id: '["native","small"]', label: "small", group: "Native" }],
    })
    await expect(adapter.context("researcher", threadId)).resolves.toEqual({
      usedTokens: 20,
      maxTokens: 100,
      source: "provider-usage",
    })
    await expect(adapter.todos("researcher", threadId)).resolves.toEqual([
      { id: "one", label: "Inspect", status: "active" },
    ])
    await expect(adapter.activity("researcher", threadId)).resolves.toEqual({
      status: "available",
      scope: "attached-active-session",
      coverage: "active-session-only",
      state: "running",
    })
    vi.spyOn(adapter, "slashCommands").mockResolvedValue([])
    expect(
      JSON.stringify(
        await adapter.workspaceCapabilities("researcher", threadId)
      )
    ).not.toContain("live-secret")
  })

  it("stages owned attachments and reads only a published same-Session artifact", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "session.resume")
        return { session_id: "live-secret", running: false, status: "idle" }
      if (method === "image.attach_bytes")
        return { attached: true, path: "/private/image.png" }
      throw new Error(`unexpected ${method}`)
    })
    const http = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions/stored?"))
        return { id: "stored", profile: "researcher", title: "Owned" }
      if (path.includes("/messages?"))
        return {
          session_id: "stored",
          messages: [
            {
              role: "tool",
              content: JSON.stringify({
                ok: true,
                type: "aos.artifact",
                artifact: {
                  id: "artifact-1",
                  path: "reports/result.txt",
                  filename: "result.txt",
                },
              }),
            },
          ],
        }
      if (path.startsWith("/api/fs/read-data-url?"))
        return { dataUrl: "data:text/plain;base64,aGVsbG8=" }
      throw new Error(`unexpected ${path}`)
    })
    const adapter = new HermesServerAdapter({ request, http })
    const threadId = "stored"

    const staged = await adapter.stageAttachments("researcher", threadId, [
      { type: "image", dataUrl: "data:image/png;base64,aGVsbG8=" },
    ])
    expect(staged.public).toEqual([
      { type: "image", dataUrl: "data:image/png;base64,aGVsbG8=" },
    ])
    expect(JSON.stringify(staged.public)).not.toContain("/private")
    expect(request).toHaveBeenCalledWith(
      "image.attach_bytes",
      {
        session_id: "live-secret",
        content_base64: "data:image/png;base64,aGVsbG8=",
        filename: "image.png",
      },
      { maxResponseBytes: 65_536 }
    )

    await expect(
      adapter.artifact("researcher", threadId, "artifact-1")
    ).resolves.toEqual({
      bytes: Uint8Array.from([104, 101, 108, 108, 111]),
      filename: "result.txt",
      mimeType: "text/plain",
    })
    expect(http.mock.calls.at(-1)?.[0]).toContain(
      "path=reports%2Fresult.txt&profile=researcher&session_id=stored"
    )
    expect(http.mock.calls.at(-1)?.[1]).toEqual({
      maxResponseBytes: 26_214_400,
    })
  })

  it("resolves trusted TTS media through its opaque Session artifact", async () => {
    const audioPath = "/home/alice/voice-memos/out/quick-brief.mp3"
    const messages = [
      {
        id: "assistant-tts",
        role: "assistant",
        tool_calls: [
          {
            id: "tts-call",
            function: {
              name: "text_to_speech",
              arguments: '{"text":"Quarterly update"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tts-call",
        tool_name: "text_to_speech",
        content: JSON.stringify({
          success: true,
          file_path: audioPath,
          file_paths: [audioPath],
          media_tag: `MEDIA:${audioPath}`,
          provider: "edge",
        }),
      },
      {
        id: "assistant-final",
        role: "assistant",
        content: `MEDIA:${audioPath}`,
      },
    ]
    const request = vi.fn(async (method: string) => {
      if (method === "session.resume")
        return { session_id: "live-secret", running: false, status: "idle" }
      throw new Error(`unexpected ${method}`)
    })
    const http = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions/stored?"))
        return { id: "stored", profile: "researcher", title: "Owned" }
      if (path.includes("/messages?")) return { session_id: "stored", messages }
      if (path.startsWith("/api/fs/read-data-url?"))
        return { dataUrl: "data:audio/mpeg;base64,aGVsbG8=" }
      throw new Error(`unexpected ${path}`)
    })
    const adapter = new HermesServerAdapter({ request, http })
    const history = await adapter.history("researcher", "stored", 200, 0)
    const descriptor = history.messages
      .flatMap((message) =>
        message.role === "assistant" ? message.content : []
      )
      .find((part) => part.type === "data" && part.name === "aos.artifact")

    expect(descriptor?.type).toBe("data")
    if (descriptor?.type !== "data" || typeof descriptor.data.id !== "string")
      throw new Error("Expected a projected TTS artifact")

    await expect(
      adapter.artifact("researcher", "stored", descriptor.data.id)
    ).resolves.toEqual({
      bytes: Uint8Array.from([104, 101, 108, 108, 111]),
      filename: "quick-brief.mp3",
      mimeType: "audio/mpeg",
    })
    expect(http.mock.calls.at(-1)?.[0]).toContain(
      `path=${encodeURIComponent(audioPath)}&profile=researcher&session_id=stored`
    )
    expect(JSON.stringify(history)).not.toContain(audioPath)
  })

  it("restores pending interactions from authoritative owned Session state", async () => {
    // Hermes re-delivers a server request still waiting on this Session as an
    // `open_requests` entry of the resume that rebinds it.
    const router = rpcRouter({
      "session.resume": async () => ({
        session_id: "live-secret",
        running: true,
        open_requests: [
          {
            id: "srq-00000000000b",
            method: "approval",
            params: {
              session_id: "live-secret",
              request_id: "approval-1",
              command: "Allow this action?",
            },
          },
        ],
      }),
    })
    const http = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions/stored?"))
        return { id: "stored", profile: "researcher", title: "Owned" }
      throw new Error(`unexpected ${path}`)
    })
    const adapter = new HermesServerAdapter({ ...router, http })

    await expect(
      adapter.pendingInteractions("researcher", "stored")
    ).resolves.toMatchObject({
      runId: "aos-hermes-restored-interaction",
      running: true,
      status: "waiting-for-input",
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "srq-00000000000b", reason: "approval" }],
      },
    })
    expect(router.calls("session.resume")[0]?.params).toEqual({
      session_id: "stored",
      profile: "researcher",
      omit_messages: true,
    })
    // The re-delivered request is never answered on AOS' behalf.
    expect(router.requests.answer("srq-00000000000b")).toBeUndefined()
    expect(router.requests.refusal("srq-00000000000b")).toBeUndefined()
  })

  it("implements the server-only native run boundary over exact Hermes operations", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "session.resume")
        return { session_id: "live-secret", running: false }
      if (method === "session.events.since")
        return {
          epoch: "epoch-1",
          last_seen: 4,
          truncated: false,
          events: [],
        }
      if (method === "prompt.submit") return { status: "streaming" }
      if (method === "session.redirect")
        return { status: "redirected", text: "Use the newer API" }
      if (method === "session.interrupt") return { status: "interrupted" }
      if (method === "session.active_list")
        return { sessions: [{ id: "live-secret", status: "working" }] }
      throw new Error(`unexpected ${method}`)
    })
    const stopObservation = vi.fn()
    const onEvent = vi.fn(() => stopObservation)
    const adapter = new HermesServerAdapter({ request, onEvent })
    const scope = {
      agentId: "researcher",
      sessionId: "stored",
      threadId: "stored",
    }

    await expect(adapter.native.resume(scope)).resolves.toEqual({
      liveSessionId: "live-secret",
      running: false,
    })
    await expect(
      adapter.native.observe("live-secret", vi.fn())
    ).resolves.toEqual(expect.any(Function))
    await expect(adapter.native.replay("live-secret", 2)).resolves.toEqual({
      epoch: "epoch-1",
      lastSeen: 4,
      truncated: false,
      events: [],
    })
    await expect(
      adapter.native.submit("live-secret", {
        scope,
        text: "Hello",
        runId: "run-1",
      })
    ).resolves.toEqual({ acknowledgement: "accepted", status: "streaming" })
    await expect(
      adapter.native.redirect("live-secret", "Use the newer API")
    ).resolves.toBe("redirected")
    await expect(adapter.native.interrupt("live-secret")).resolves.toBe(
      "interrupted"
    )
    await expect(adapter.native.status("live-secret")).resolves.toBe("working")
    expect(request.mock.calls).toEqual([
      [
        "session.resume",
        { session_id: "stored", profile: "researcher", omit_messages: true },
      ],
      [
        "session.events.since",
        { session_id: "live-secret", last_seen: 2 },
        { maxResponseBytes: 6_291_456 },
      ],
      ["prompt.submit", { session_id: "live-secret", text: "Hello" }],
      [
        "session.redirect",
        { session_id: "live-secret", text: "Use the newer API" },
      ],
      ["session.interrupt", { session_id: "live-secret" }],
      ["session.active_list", {}],
    ])
    // Two AOS observers, each subscribing once for the whole runtime's life:
    // the attachment registry routes native frames and interactions watch
    // `request.cancel`.
    expect(onEvent).toHaveBeenCalledTimes(2)
  })

  it.each(["redirected", "queued"] as const)(
    "accepts only the native %s redirect acknowledgement",
    async (status) => {
      const adapter = new HermesServerAdapter({
        request: vi.fn(async () => ({ status, text: "Correction" })),
      })

      await expect(
        adapter.native.redirect("live-secret", "Correction")
      ).resolves.toBe(status)
    }
  )

  it("rejects malformed redirect acknowledgements and classifies a lost response as uncertain", async () => {
    const malformed = new HermesServerAdapter({
      request: vi.fn(async () => ({ status: "accepted" })),
    })
    await expect(
      malformed.native.redirect("live-secret", "Correction")
    ).rejects.toBeInstanceOf(HermesUnavailableError)

    const uncertain = new HermesServerAdapter({
      request: vi.fn(async () => {
        throw new HermesRpcUncertainError()
      }),
    })
    await expect(
      uncertain.native.redirect("live-secret", "Correction")
    ).rejects.toBeInstanceOf(ServerRunSteerUncertainError)
  })

  it("rewinds Edit or Retry at the authoritative durable user row", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "prompt.submit") return { status: "streaming" }
      throw new Error(`unexpected ${method}`)
    })
    const http = vi.fn(async (path: string) => {
      if (path.includes("/messages?"))
        return {
          session_id: "stored",
          messages: [
            { row_id: 10, role: "user", text: "Keep" },
            { row_id: 11, role: "assistant", text: "Kept reply" },
            { row_id: 12, role: "user", text: "Original" },
            { row_id: 13, role: "assistant", text: "Old reply" },
          ],
        }
      throw new Error(`unexpected ${path}`)
    })
    const adapter = new HermesServerAdapter({ request, http })
    const scope = {
      agentId: "researcher",
      sessionId: "stored",
      threadId: "stored",
    }

    await expect(
      adapter.native.submit("live-secret", {
        scope,
        text: "Edited",
        runId: "edit-run",
        rewindSourceId: "hermes-row-12",
      })
    ).resolves.toEqual({ acknowledgement: "accepted", status: "streaming" })

    expect(request).toHaveBeenCalledWith("prompt.submit", {
      session_id: "live-secret",
      text: "Edited",
      confirm_truncate: true,
      truncate_before_row_id: 12,
    })
  })

  it("guards a first-turn rewind and never appends when the source is stale", async () => {
    const request = vi.fn(async () => ({ status: "streaming" }))
    let messages: readonly unknown[] = [
      { row_id: 10, role: "user", text: "Original" },
      { row_id: 11, role: "assistant", text: "Old reply" },
    ]
    const adapter = new HermesServerAdapter({
      request,
      http: async (path: string) => {
        if (path.includes("/messages?"))
          return { session_id: "stored", messages }
        throw new Error(`unexpected ${path}`)
      },
    })
    const scope = {
      agentId: "researcher",
      sessionId: "stored",
      threadId: "stored",
    }

    await adapter.native.submit("live-secret", {
      scope,
      text: "Retry",
      runId: "retry-run",
      rewindSourceId: "hermes-row-10",
    })
    expect(request).toHaveBeenLastCalledWith("prompt.submit", {
      session_id: "live-secret",
      text: "Retry",
      confirm_truncate: true,
      confirm_empty_truncate: true,
      truncate_before_row_id: 10,
    })

    request.mockClear()
    messages = [{ row_id: 12, role: "assistant", text: "Changed" }]
    await expect(
      adapter.native.submit("live-secret", {
        scope,
        text: "Retry",
        runId: "stale-retry-run",
        rewindSourceId: "hermes-row-10",
      })
    ).rejects.toBeInstanceOf(HermesRunRewindConflictError)
    expect(request).not.toHaveBeenCalled()
  })

  it("merges multiple Agent catalogs into deterministic bounded global pages", async () => {
    const rows = (profileName: string, newest: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `${profileName}-${newest - index}`,
        profile: profileName,
        title: `${profileName} ${newest - index}`,
        last_active: newest - index,
      }))
    const alpha = rows("alpha", 120, 60)
    const beta = rows("beta", 60, 60)
    const request = vi.fn(async () => ({
      profiles: [
        { name: "alpha", ui_meta: {}, ui_meta_revisions: {} },
        { name: "beta", ui_meta: {}, ui_meta_revisions: {} },
      ],
    }))
    const http = vi.fn(async (path: string) => {
      const url = new URL(path, "http://native.test")
      const profileName = url.searchParams.get("profile")!
      const limit = Number(url.searchParams.get("limit"))
      const offset = Number(url.searchParams.get("offset"))
      const source = profileName === "alpha" ? alpha : beta
      return {
        sessions: source.slice(offset, offset + limit),
        total: source.length,
      }
    })
    const adapter = new HermesServerAdapter({ request, http })

    const first = await adapter.listAllSessions(50, 0)
    const second = await adapter.listAllSessions(50, 50)

    expect(first.sessions).toHaveLength(50)
    expect(first.sessions[0]?.id).toBe("alpha-120")
    expect(first.sessions.at(-1)?.id).toBe("alpha-71")
    expect(second.sessions).toHaveLength(50)
    expect(second.sessions.slice(0, 10).map(({ id }) => id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `alpha-${70 - index}`)
    )
    expect(second.sessions[10]?.id).toBe("beta-60")
    expect(
      new Set([...first.sessions, ...second.sessions].map(({ id }) => id)).size
    ).toBe(100)
    expect(first.total).toBe(120)
    expect(second.total).toBe(120)
  })

  it("keeps the creator available to New Agent without cataloging creator Sessions", async () => {
    const request = vi.fn(async () => ({
      profiles: [
        { name: "researcher", ui_meta: {}, ui_meta_revisions: {} },
        {
          name: "aos-creator",
          ui_meta: { aos: { role: "creator" } },
          ui_meta_revisions: {},
        },
      ],
    }))
    const http = vi.fn(async (path: string) => ({
      sessions: [
        {
          id: "research-session",
          profile: new URL(path, "http://native.test").searchParams.get(
            "profile"
          ),
          last_active: 10,
        },
      ],
      total: 1,
    }))
    const adapter = new HermesServerAdapter({ request, http })

    const agents = await adapter.listAgents()
    const catalog = await adapter.listAllSessions(50, 0)

    expect(
      agents.agents.find(({ summary }) => summary.id === "aos-creator")
    ).toMatchObject({
      summary: { role: "creator" },
      selectable: false,
    })
    expect(catalog.sessions.map(({ agentId }) => agentId)).toEqual([
      "researcher",
    ])
    expect(http.mock.calls.map(([path]) => path)).toEqual([
      "/api/sessions?profile=researcher&limit=50&offset=0&order=recent&archived=include&exclude_sources=cron%2Ctool%2Ckanban",
    ])
  })

  it("creates Agent-owned lazy Sessions using the native stored identity", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "profiles.list") return { profiles: [profile()] }
      if (method === "session.create")
        return { session_id: "live-private", stored_session_id: "stored/1" }
      throw new Error("unexpected native request")
    })
    const adapter = new HermesServerAdapter({ request })

    await expect(
      adapter.createSession("researcher", "New Session")
    ).resolves.toEqual({
      session: {
        id: "stored/1",
        agentId: "researcher",
      },
    })
    expect(request.mock.calls).toEqual([
      ["profiles.list", { include_sessions: false }],
      [
        "session.create",
        {
          profile: "researcher",
          close_on_disconnect: false,
          title: "New Session",
        },
      ],
    ])

    request.mockClear()
    await expect(adapter.createSession("other")).rejects.toBeInstanceOf(
      HermesAgentNotFoundError
    )
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("leaves a new Session untitled so Hermes can auto-title its first exchange", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "profiles.list") return { profiles: [profile()] }
      if (method === "session.create")
        return { session_id: "live-private", stored_session_id: "stored/2" }
      throw new Error("unexpected native request")
    })
    const adapter = new HermesServerAdapter({ request })

    await adapter.createSession("researcher")

    expect(request.mock.calls).toEqual([
      ["profiles.list", { include_sessions: false }],
      [
        "session.create",
        {
          profile: "researcher",
          close_on_disconnect: false,
        },
      ],
    ])
  })

  it("resolves an invited Session without creating when creation is absent", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "session.list") return { sessions: [] }
      throw new Error(`unexpected ${method}`)
    })
    const adapter = new HermesServerAdapter({ request })

    await expect(
      adapter.resolveInvitedSession("researcher", "guest_ref")
    ).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith("session.list", {
      profile: "researcher",
      title: "aos-invite:guest_ref",
      include_hidden: true,
    })
  })

  it("creates one missing invited Session lazily with its first-turn instruction", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let created = false
    const request = vi.fn(async (method: string) => {
      if (method === "session.list") {
        await gate
        return {
          sessions: created
            ? [
                {
                  id: "stored-1",
                  resolved_id: "stored-1",
                  title: "aos-invite:guest_ref",
                },
              ]
            : [],
        }
      }
      if (method === "session.create") {
        created = true
        return { session_id: "live-private", stored_session_id: "stored-1" }
      }
      if (method === "session.title") return { ok: true }
      throw new Error(`unexpected ${method}`)
    })
    const adapter = new HermesServerAdapter({ request })
    const create = {
      firstTurnInstruction: "Load the interview skill.",
    }
    const first = adapter.resolveInvitedSession(
      "researcher",
      "guest_ref",
      create
    )
    const second = adapter.resolveInvitedSession(
      "researcher",
      "guest_ref",
      create
    )
    release()

    await expect(Promise.all([first, second])).resolves.toEqual([
      { sessionId: "stored-1", created: true },
      { sessionId: "stored-1", created: true },
    ])
    expect(request.mock.calls).toEqual([
      [
        "session.list",
        {
          profile: "researcher",
          title: "aos-invite:guest_ref",
          include_hidden: true,
        },
      ],
      [
        "session.create",
        {
          profile: "researcher",
          title: "aos-invite:guest_ref",
          close_on_disconnect: false,
          messages: [
            {
              role: "user",
              content: JSON.stringify({
                v: 1,
                type: "aos.guest.first-turn",
                instruction: "Load the interview skill.",
              }),
            },
          ],
        },
      ],
      [
        "session.title",
        {
          session_id: "live-private",
          title: "aos-invite:guest_ref",
        },
      ],
      [
        "session.list",
        {
          profile: "researcher",
          title: "aos-invite:guest_ref",
          include_hidden: true,
        },
      ],
    ])
  })

  it("reuses only an exact invited Session and rejects duplicate matches", async () => {
    const exactRequest = vi.fn(async () => ({
      sessions: [
        {
          id: "stored-1",
          resolved_id: "resolved-1",
          profile: "researcher",
          title: "aos-invite:guest_ref",
        },
      ],
    }))
    const exact = new HermesServerAdapter({ request: exactRequest })
    await expect(
      exact.resolveInvitedSession("researcher", "guest_ref", {})
    ).resolves.toEqual({ sessionId: "resolved-1", created: false })
    expect(exactRequest).toHaveBeenCalledOnce()

    const nativeListShape = new HermesServerAdapter({
      request: vi.fn(async () => ({
        sessions: [
          {
            id: "stored-2",
            resolved_id: "stored-2",
            title: "aos-invite:guest_ref",
            preview: "Hello",
            message_count: 1,
            source: "dashboard",
          },
        ],
      })),
    })
    await expect(
      nativeListShape.resolveInvitedSession("researcher", "guest_ref")
    ).resolves.toEqual({ sessionId: "stored-2", created: false })

    const ambiguous = new HermesServerAdapter({
      request: vi.fn(async () => ({
        sessions: [
          { id: "one", profile: "researcher", title: "aos-invite:guest_ref" },
          { id: "two", profile: "researcher", title: "aos-invite:guest_ref" },
        ],
      })),
    })
    await expect(
      ambiguous.resolveInvitedSession("researcher", "guest_ref")
    ).rejects.toBeInstanceOf(HermesSessionConflictError)
  })

  it("fails closed when Hermes does not return the exact invited profile and title", async () => {
    const wrongProfile = new HermesServerAdapter({
      request: vi.fn(async () => ({
        sessions: [
          {
            id: "stored-1",
            profile: "other",
            title: "aos-invite:guest_ref",
          },
        ],
      })),
    })
    await expect(
      wrongProfile.resolveInvitedSession("researcher", "guest_ref")
    ).rejects.toBeInstanceOf(HermesUnavailableError)

    const wrongTitle = new HermesServerAdapter({
      request: vi.fn(async () => ({
        sessions: [
          {
            id: "stored-1",
            profile: "researcher",
            title: "aos-invite:other_ref",
          },
        ],
      })),
    })
    await expect(
      wrongTitle.resolveInvitedSession("researcher", "guest_ref")
    ).rejects.toBeInstanceOf(HermesUnavailableError)
  })

  it("projects an unpersisted lazy Session from its native resume snapshot", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "session.resume")
        return {
          session_id: "live-private",
          stored_session_id: "stored/1",
          message_count: 0,
          messages: [],
          info: { lazy: true, profile_name: "researcher" },
        }
      throw new Error(`unexpected ${method}`)
    })
    const adapter = new HermesServerAdapter({
      request,
      http: vi.fn(async () => {
        throw new HermesHttpError(404)
      }),
    })

    await expect(adapter.getSession("researcher", "stored/1")).resolves.toEqual(
      {
        id: "stored/1",
        agentId: "researcher",
        title: "stored/1",
        archived: false,
        updatedAt: "1970-01-01T00:00:00.000Z",
        status: "idle",
      }
    )
    expect(request).toHaveBeenCalledWith("session.resume", {
      session_id: "stored/1",
      profile: "researcher",
      omit_messages: true,
    })
  })

  it("returns empty Todos for an unpersisted lazy Session", async () => {
    const adapter = new HermesServerAdapter({
      request: vi.fn(async (method: string) => {
        if (method === "session.resume")
          return {
            session_id: "live-private",
            stored_session_id: "stored/1",
            message_count: 0,
            messages: [],
            info: { lazy: true, profile_name: "researcher" },
          }
        throw new Error(`unexpected ${method}`)
      }),
      http: vi.fn(async () => {
        throw new HermesHttpError(404)
      }),
    })

    await expect(adapter.todos("researcher", "stored/1")).resolves.toEqual([])
  })

  it("distinguishes missing and conflicting stored Session operations from outages", async () => {
    const missing = new HermesServerAdapter({
      request: vi.fn(),
      http: vi.fn(async () => {
        throw new HermesHttpError(404)
      }),
    })
    await expect(
      missing.getSession("researcher", "missing")
    ).rejects.toBeInstanceOf(HermesSessionNotFoundError)

    const conflict = new HermesServerAdapter({
      request: vi.fn(),
      http: vi
        .fn()
        .mockResolvedValueOnce({
          id: "stored",
          profile: "researcher",
          title: "Owned",
        })
        .mockRejectedValueOnce(new HermesHttpError(409)),
    })
    await expect(
      conflict.mutateSession("researcher", "stored", "PATCH", {
        archived: true,
      })
    ).rejects.toBeInstanceOf(HermesSessionConflictError)
  })

  it("maps malformed native Session pages to temporary unavailability", async () => {
    const malformedCatalog = new HermesServerAdapter({
      request: vi.fn(),
      http: vi.fn(async () => ({
        sessions: [{ id: "stored", profile: "researcher" }],
        total: 1.5,
      })),
    })
    await expect(
      malformedCatalog.listSessions("researcher", 50, 0)
    ).rejects.toBeInstanceOf(HermesUnavailableError)

    const removedDuringHistory = new HermesServerAdapter({
      request: vi.fn(),
      http: vi
        .fn()
        .mockResolvedValueOnce({
          id: "stored",
          profile: "researcher",
          title: "Owned",
        })
        .mockRejectedValueOnce(new HermesHttpError(404)),
    })
    await expect(
      removedDuringHistory.history("researcher", "stored", 200, 0)
    ).rejects.toBeInstanceOf(HermesSessionNotFoundError)
  })

  it("uses the bounded native recent catalog and exposes only stable stored identities", async () => {
    const http = vi.fn(async (path: string) => {
      expect(path).toBe(
        "/api/sessions?profile=researcher&limit=50&offset=0&order=recent&archived=include&exclude_sources=cron%2Ctool%2Ckanban"
      )
      return {
        sessions: [
          {
            id: "stored/1",
            profile: "researcher",
            title: "One",
            last_active: 1,
            is_active: true,
            session_id: "live-secret",
          },
        ],
        total: 1,
      }
    })
    const adapter = new HermesServerAdapter({ request: vi.fn(), http })
    await expect(adapter.listSessions("researcher", 50, 0)).resolves.toEqual({
      sessions: [
        {
          id: "stored/1",
          agentId: "researcher",
          title: "One",
          archived: false,
          updatedAt: "1970-01-01T00:00:01.000Z",
          status: "running",
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    })
  })

  it("rejects duplicate stored Session IDs and projects owned compacted chronological history", async () => {
    const http = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions?profile=researcher"))
        return {
          sessions: [
            { id: "same", profile: "researcher" },
            { id: "same", profile: "researcher" },
          ],
        }
      if (path.startsWith("/api/sessions/stored?"))
        return { id: "stored", profile: "researcher", title: "Owned" }
      return {
        session_id: "stored",
        messages: [
          { id: "user-1", role: "user", content: "first", timestamp: 1 },
          {
            id: "assistant-1",
            role: "assistant",
            reasoning: "thinking",
            content: "second",
            timestamp: 2,
          },
        ],
        pagination: { limit: 200, offset: 0, returned: 2, total: 2 },
      }
    })
    const adapter = new HermesServerAdapter({ request: vi.fn(), http })
    await expect(
      adapter.listSessions("researcher", 50, 0)
    ).rejects.toBeInstanceOf(HermesUnavailableError)
    await expect(
      adapter.history("researcher", "stored", 200, 0)
    ).resolves.toEqual({
      sessionId: "stored",
      messages: [
        {
          id: "user-1",
          role: "user",
          content: [{ type: "text", text: "first" }],
          createdAt: "1970-01-01T00:00:01.000Z",
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: [
            { type: "reasoning", text: "thinking" },
            { type: "text", text: "second" },
          ],
          createdAt: "1970-01-01T00:00:02.000Z",
        },
      ],
      total: 2,
      limit: 200,
      offset: 0,
      nextOffset: 2,
    })
    expect(http.mock.calls.slice(1).map(([path]) => path)).toEqual([
      "/api/sessions/stored?profile=researcher",
      "/api/sessions/stored/messages?profile=researcher&limit=200&offset=0&order=latest&include_compacted=true",
    ])
  })

  describe("native history pagination", () => {
    const messages = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `message-${index}`,
        role: "user",
        content: `message ${index}`,
        timestamp: index + 1,
      }))

    const adapterFor = (page: Record<string, unknown>) =>
      new HermesServerAdapter({
        request: vi.fn(),
        http: vi.fn(async (path: string) =>
          path.startsWith("/api/sessions/stored?")
            ? { id: "stored", profile: "researcher" }
            : { session_id: "stored", ...page }
        ),
      })

    it("loads the newest native rows for the initial conversation page", async () => {
      const http = vi.fn(async (path: string) => {
        if (path.startsWith("/api/sessions/stored?"))
          return { id: "stored", profile: "researcher" }
        const order = new URL(`http://hermes${path}`).searchParams.get("order")
        const page =
          order === "latest"
            ? [
                {
                  id: "user-new",
                  role: "user",
                  content: "new question",
                  timestamp: 3,
                },
                {
                  id: "assistant-new",
                  role: "assistant",
                  content: "new answer",
                  timestamp: 4,
                },
              ]
            : [
                {
                  id: "user-old",
                  role: "user",
                  content: "old question",
                  timestamp: 1,
                },
                {
                  id: "assistant-old",
                  role: "assistant",
                  content: "old answer",
                  timestamp: 2,
                },
              ]
        return {
          session_id: "stored",
          messages: page,
          pagination: { limit: 2, offset: 0, order, returned: 2, total: 4 },
        }
      })
      const adapter = new HermesServerAdapter({ request: vi.fn(), http })

      const history = await adapter.history("researcher", "stored", 2, 0)

      expect(history.messages.map(({ id }) => id)).toEqual([
        "user-new",
        "assistant-new",
      ])
    })

    it.each([
      {
        name: "preserves a known native total",
        limit: 2,
        offset: 2,
        page: {
          messages: messages(2),
          pagination: { limit: 2, offset: 2, returned: 2, total: 10 },
        },
        total: 10,
        nextOffset: 4,
      },
      {
        name: "continues after a full page without a total",
        limit: 2,
        offset: 0,
        page: {
          messages: messages(2),
          pagination: { limit: 2, offset: 0, returned: 2 },
        },
        total: 3,
        nextOffset: 2,
      },
      {
        name: "stops after a short page without a total",
        limit: 2,
        offset: 2,
        page: {
          messages: messages(1),
          pagination: { limit: 2, offset: 2, returned: 1 },
        },
        total: 3,
        nextOffset: 3,
      },
      {
        name: "stops after an empty exact-boundary page",
        limit: 2,
        offset: 2,
        page: {
          messages: [],
          pagination: { limit: 2, offset: 2, returned: 0 },
        },
        total: 2,
        nextOffset: 2,
      },
      {
        name: "supports a legacy page at a nonzero offset",
        limit: 2,
        offset: 5,
        page: { messages: messages(1) },
        total: 6,
        nextOffset: 6,
      },
    ])("$name", async ({ limit, offset, page, total, nextOffset }) => {
      await expect(
        adapterFor(page).history("researcher", "stored", limit, offset)
      ).resolves.toMatchObject({ total, nextOffset, limit, offset })
    })

    it.each([
      ["zero limit", { limit: 0, offset: 0, returned: 0 }, 2, 0, 0],
      ["fractional limit", { limit: 1.5, offset: 0, returned: 0 }, 2, 0, 0],
      ["oversized limit", { limit: 3, offset: 0, returned: 0 }, 2, 0, 0],
      ["mismatched offset", { limit: 2, offset: 1, returned: 0 }, 2, 0, 0],
      ["negative returned", { limit: 2, offset: 0, returned: -1 }, 2, 0, 0],
      ["fractional returned", { limit: 2, offset: 0, returned: 0.5 }, 2, 0, 0],
      ["returned above limit", { limit: 2, offset: 0, returned: 3 }, 2, 0, 0],
      [
        "returned/message mismatch",
        { limit: 2, offset: 0, returned: 1 },
        2,
        0,
        0,
      ],
      [
        "negative total",
        { limit: 2, offset: 0, returned: 0, total: -1 },
        2,
        0,
        0,
      ],
      [
        "fractional total",
        { limit: 2, offset: 0, returned: 0, total: 0.5 },
        2,
        0,
        0,
      ],
      [
        "unsafe total",
        {
          limit: 2,
          offset: 0,
          returned: 0,
          total: Number.MAX_SAFE_INTEGER + 1,
        },
        2,
        0,
        0,
      ],
      [
        "total behind page",
        { limit: 2, offset: 2, returned: 1, total: 2 },
        2,
        2,
        1,
      ],
      [
        "unsafe next offset",
        {
          limit: 2,
          offset: Number.MAX_SAFE_INTEGER,
          returned: 1,
        },
        2,
        Number.MAX_SAFE_INTEGER,
        1,
      ],
      [
        "unsafe continuation sentinel",
        {
          limit: 1,
          offset: Number.MAX_SAFE_INTEGER - 1,
          returned: 1,
        },
        1,
        Number.MAX_SAFE_INTEGER - 1,
        1,
      ],
    ])("rejects %s", async (_name, pagination, limit, offset, messageCount) => {
      await expect(
        adapterFor({ messages: messages(messageCount), pagination }).history(
          "researcher",
          "stored",
          limit,
          offset
        )
      ).rejects.toBeInstanceOf(HermesUnavailableError)
    })
  })

  it("projects profile names as Agent IDs without leaking native metadata", async () => {
    const request = vi.fn(async () => ({ profiles: [profile()] }))
    const adapter = new HermesServerAdapter({ request } as HermesRpcTransport)

    const catalog = await adapter.listAgents()

    expect(request).toHaveBeenCalledWith("profiles.list", {
      include_sessions: false,
    })
    expect(catalog).toEqual({
      revision: "profiles:researcher@hermes-bots:7",
      agents: [
        {
          summary: {
            kind: "ready",
            id: "researcher",
            name: "Researcher",
            description: "Investigates primary sources",
            visibility: "visible",
          },
          visibility: "visible",
          selectable: true,
          editable: true,
          revision: "hermes-bots:7",
        },
      ],
    })
    expect(JSON.stringify(catalog)).not.toContain("privatePath")
    expect(JSON.stringify(catalog)).not.toContain("nativeOnly")
  })

  it("marks visibility unavailable when Hermes omits the CAS revision", async () => {
    const adapter = new HermesServerAdapter({
      request: vi.fn(async () => ({ profiles: [profile(false, null)] })),
    })
    const catalog = await adapter.listAgents()
    expect(catalog.agents[0]).toMatchObject({
      editable: false,
      revision: "unavailable",
    })
    expect((await adapter.runtimeInfo()).capabilities.agentVisibility).toEqual({
      status: "unavailable",
      reason: "native-revision-unavailable",
    })
  })

  it("updates visibility with the observed revision and confirms an authoritative reread", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ profiles: [profile()] })
      .mockResolvedValueOnce(profile())
      .mockResolvedValueOnce({ applied: { ui_meta: true } })
      .mockResolvedValueOnce({ profiles: [profile(true, 8)] })
    const adapter = new HermesServerAdapter({ request })

    const updated = await adapter.updateAgentVisibility(
      "researcher",
      "hidden",
      "hermes-bots:7"
    )

    expect(request.mock.calls).toEqual([
      ["profiles.list", { include_sessions: false }],
      ["profiles.describe", { name: "researcher" }],
      [
        "profiles.configure",
        {
          name: "researcher",
          ui_meta: {
            "hermes-bots": {
              hidden: true,
              nativeOnly: "keep-server-side",
            },
          },
          ui_meta_expected_revisions: { "hermes-bots": 7 },
        },
      ],
      ["profiles.list", { include_sessions: false }],
    ])
    expect(updated.agent).toMatchObject({
      visibility: "hidden",
      selectable: false,
      revision: "hermes-bots:8",
    })
  })

  it("rejects a stale revision before mutating Hermes", async () => {
    const request = vi.fn(async () => ({ profiles: [profile()] }))
    const adapter = new HermesServerAdapter({ request })
    await expect(
      adapter.updateAgentVisibility("researcher", "hidden", "hermes-bots:6")
    ).rejects.toBeInstanceOf(HermesRevisionConflictError)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("distinguishes rejected Hermes credentials from a temporary outage", async () => {
    const unauthenticated = new HermesServerAdapter({
      request: vi.fn(async () => {
        throw new HermesAuthenticationError()
      }),
    })
    const unavailable = new HermesServerAdapter({
      request: vi.fn(async () => {
        throw new Error("connection refused")
      }),
    })
    await expect(unauthenticated.authState()).resolves.toEqual({
      status: "authentication-required",
    })
    await expect(unauthenticated.listAgents()).rejects.toBeInstanceOf(
      HermesAuthenticationError
    )
    await expect(unavailable.authState()).resolves.toEqual({
      status: "unavailable",
      reason: "temporarily-unavailable",
    })
  })

  it("refuses to observe a native Session that was never attached", async () => {
    const adapter = new HermesServerAdapter({ request: vi.fn() })

    await expect(
      adapter.native.observe("live-session", vi.fn())
    ).rejects.toBeInstanceOf(HermesUnavailableError)
  })

  it("rejects an oversized native live Session identity", async () => {
    const adapter = new HermesServerAdapter({
      request: vi.fn(async () => ({ session_id: "x".repeat(257) })),
    })

    await expect(
      adapter.native.resume({
        agentId: "researcher",
        sessionId: "stored",
        threadId: "stored",
      })
    ).rejects.toBeInstanceOf(HermesUnavailableError)
  })

  it("re-resumes the durable Session when Hermes rejects a heal as gone", async () => {
    let resumes = 0
    const router = rpcRouter({
      "session.resume": async () => {
        resumes += 1
        if (resumes === 2) throw new HermesRpcRejectedError(4007)
        return { session_id: resumes === 1 ? "live-first" : "live-second" }
      },
    })
    const adapter = new HermesServerAdapter(router)
    const scope = {
      agentId: "researcher",
      sessionId: "stored",
      threadId: "stored",
    }
    await expect(adapter.native.resume(scope)).resolves.toMatchObject({
      liveSessionId: "live-first",
    })
    const signals: string[] = []
    await adapter.native.observe("live-first", (signal) =>
      signals.push(
        signal.kind === "lost" ? `lost:${signal.reason}` : signal.kind
      )
    )

    await router.connection.restored()

    expect(signals).toEqual(["lost:rebound"])
    await expect(adapter.native.resume(scope)).resolves.toMatchObject({
      liveSessionId: "live-second",
    })
    expect(router.calls("session.resume")).toHaveLength(3)
  })

  it("writes an attachment rebind failure to the runtime log", async () => {
    const warn = vi.fn()
    let resumes = 0
    const router = rpcRouter({
      "session.resume": async () => {
        resumes += 1
        if (resumes === 2) throw new HermesUnavailableError()
        return { session_id: "live-first" }
      },
    })
    const adapter = new HermesServerAdapter(router, { log: { warn } })
    const scope = {
      agentId: "researcher",
      sessionId: "stored",
      threadId: "stored",
    }
    await adapter.native.resume(scope)
    await adapter.native.observe("live-first", vi.fn())

    await router.connection.restored()

    expect(warn).toHaveBeenCalledWith("hermes.attachment.rebind_failed", {
      reason: expect.any(String),
    })
  })

  it("publishes each native failure class under its own public error code", async () => {
    const adapter = new HermesServerAdapter({ request: vi.fn() })

    expect(adapter.publicError(new HermesAuthenticationError())).toEqual({
      code: "runtime_authentication_required",
      status: 401,
    })
    for (const cause of [
      new HermesAgentNotFoundError(),
      new HermesSessionNotFoundError(),
      new HermesWorkspaceScopeError(),
      new HermesContentScopeError(),
      new HermesInteractionPublicError("AOS_INTERACTION_NOT_FOUND"),
    ])
      expect(adapter.publicError(cause)).toEqual({
        code: "not_found",
        status: 404,
      })
    for (const cause of [
      new HermesRevisionConflictError(),
      new HermesSessionConflictError(),
    ])
      expect(adapter.publicError(cause)).toEqual({
        code: "revision_conflict",
        status: 409,
      })
    // An unconfirmed Stop may have been accepted: the browser reconciles.
    expect(
      adapter.publicError(
        new HermesRunPublicError(
          "AOS_STOP_UNCERTAIN",
          "Stop was not confirmed."
        )
      )
    ).toEqual({ code: "uncertain_mutation", status: 409 })
    for (const cause of [
      new HermesUnavailableError(),
      new HermesWorkspaceUnavailableError(),
      new HermesContentUnavailableError(),
      new HermesRunPublicError(
        "AOS_PROVIDER_UNAVAILABLE",
        "Hermes is unavailable."
      ),
      new HermesInteractionPublicError("AOS_PROVIDER_UNAVAILABLE"),
    ])
      expect(adapter.publicError(cause)).toEqual({
        code: "temporarily_unavailable",
        status: 503,
      })
    expect(
      adapter.publicError(
        new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
      )
    ).toEqual({ code: "invalid_request", status: 400 })
    expect(adapter.publicError(new Error("unclassified"))).toBeUndefined()
  })

  it("releases the interaction retainer when discovery finds no pending request", async () => {
    vi.useFakeTimers()
    try {
      let resumes = 0
      const router = rpcRouter({
        "session.resume": async () => {
          resumes += 1
          return {
            session_id: "live-secret",
            running: false,
            status: "idle",
            ...(resumes === 1
              ? {
                  open_requests: [
                    {
                      id: "srq-00000000000c",
                      method: "approval",
                      params: {
                        session_id: "live-secret",
                        request_id: "approval-1",
                        command: "Allow this action?",
                        choices: ["once", "deny"],
                      },
                    },
                  ],
                }
              : {}),
          }
        },
        "session.close": async () => ({ closed: true }),
      })
      const adapter = new HermesServerAdapter(router, { sessionIdleMs: 1_000 })
      const scope = {
        agentId: "researcher",
        sessionId: "stored",
        threadId: "stored",
        runId: "run-1",
      }

      expect(await adapter.native.inspectExecution(scope)).toMatchObject({
        status: "waiting-for-input",
        outcome: {
          interrupts: [{ id: "srq-00000000000c", reason: "approval" }],
        },
      })
      // A live request for the same Session keeps the attachment retained.
      router.requests.deliver(
        "approval",
        {
          session_id: "live-secret",
          request_id: "approval-2",
          command: "Allow the next action?",
          choices: ["once", "deny"],
        },
        { id: "srq-00000000000d" }
      )
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(router.calls("session.close")).toHaveLength(0)

      expect(await adapter.native.inspectExecution(scope)).toMatchObject({
        status: "idle",
      })
      await vi.advanceTimersByTimeAsync(1_000)

      expect(router.calls("session.close")[0]?.params).toEqual({
        session_id: "live-secret",
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports a missing Agent separately from a Hermes outage", async () => {
    const adapter = new HermesServerAdapter({
      request: vi.fn(async () => ({ profiles: [profile()] })),
    })
    await expect(
      adapter.updateAgentVisibility("missing-agent", "hidden", "hermes-bots:7")
    ).rejects.toBeInstanceOf(HermesAgentNotFoundError)
  })
})
