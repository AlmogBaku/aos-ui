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
import { HermesAuthenticationError } from "./transport"
import { HermesHttpError } from "./transport"

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
    const threadId = "hermes:researcher:stored"

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
    expect(JSON.stringify(await adapter.workspaceCapabilities())).not.toContain(
      "live-secret"
    )
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
    const threadId = "hermes:researcher:stored"

    const staged = await adapter.stageAttachments("researcher", threadId, [
      { type: "image", dataUrl: "data:image/png;base64,aGVsbG8=" },
    ])
    expect(staged.public).toEqual([
      { type: "image", dataUrl: "data:image/png;base64,aGVsbG8=" },
    ])
    expect(JSON.stringify(staged.public)).not.toContain("/private")

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
  })

  it("restores pending interactions from authoritative owned Session state", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "session.resume")
        return {
          session_id: "live-secret",
          running: true,
          pending_approval: {
            request_id: "approval-1",
            message: "Allow this action?",
            choices: ["once", "deny"],
          },
        }
      throw new Error(`unexpected ${method}`)
    })
    const http = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions/stored?"))
        return { id: "stored", profile: "researcher", title: "Owned" }
      throw new Error(`unexpected ${path}`)
    })
    const adapter = new HermesServerAdapter({ request, http })

    await expect(
      adapter.pendingInteractions("researcher", "hermes:researcher:stored")
    ).resolves.toMatchObject({
      runId: "aos-hermes-restored-interaction",
      running: true,
      status: "waiting-for-input",
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "approval-1", reason: "approval" }],
      },
    })
    expect(request).toHaveBeenCalledWith("session.resume", {
      session_id: "stored",
      profile: "researcher",
      omit_messages: true,
    })
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
      if (method === "prompt.submit") return { accepted: true }
      if (method === "session.interrupt") return { interrupted: true }
      if (method === "session.active_list")
        return { sessions: [{ id: "live-secret", status: "working" }] }
      throw new Error(`unexpected ${method}`)
    })
    const stopObservation = vi.fn()
    const observeEvents = vi.fn(async () => stopObservation)
    const adapter = new HermesServerAdapter({ request, observeEvents })
    const scope = {
      agentId: "researcher",
      sessionId: "stored",
      threadId: "hermes:researcher:stored",
    }

    await expect(adapter.resume(scope)).resolves.toEqual({
      liveSessionId: "live-secret",
    })
    await expect(
      adapter.observe("live-secret", vi.fn(), vi.fn())
    ).resolves.toBe(stopObservation)
    await expect(adapter.recover("live-secret", 2)).resolves.toEqual({
      epoch: "epoch-1",
      lastSeen: 4,
      truncated: false,
      events: [],
    })
    await expect(
      adapter.submit("live-secret", { text: "Hello", runId: "run-1" })
    ).resolves.toEqual({ acknowledgement: "accepted" })
    await expect(adapter.interrupt("live-secret")).resolves.toBeUndefined()
    await expect(adapter.status("live-secret")).resolves.toBe("running")
    expect(request.mock.calls).toEqual([
      [
        "session.resume",
        { session_id: "stored", profile: "researcher", omit_messages: true },
      ],
      ["session.events.since", { session_id: "live-secret", last_seen: 2 }],
      ["prompt.submit", { session_id: "live-secret", text: "Hello" }],
      ["session.interrupt", { session_id: "live-secret" }],
      ["session.active_list", {}],
    ])
    expect(observeEvents).toHaveBeenCalledTimes(1)
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
    expect(first.sessions[0]?.id).toBe("hermes:alpha:alpha-120")
    expect(first.sessions.at(-1)?.id).toBe("hermes:alpha:alpha-71")
    expect(second.sessions).toHaveLength(50)
    expect(second.sessions.slice(0, 10).map(({ id }) => id)).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `hermes:alpha:alpha-${70 - index}`
      )
    )
    expect(second.sessions[10]?.id).toBe("hermes:beta:beta-60")
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

  it("creates only Agent-owned Sessions and returns a stable stored identity", async () => {
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
        id: "hermes:researcher:stored%2F1",
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
          id: "hermes:researcher:stored%2F1",
          agentId: "researcher",
          title: "One",
          archived: false,
          updatedAt: "1970-01-01T00:00:01.000Z",
          status: "unknown",
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
        pagination: { total: 2 },
      }
    })
    const adapter = new HermesServerAdapter({ request: vi.fn(), http })
    await expect(
      adapter.listSessions("researcher", 50, 0)
    ).rejects.toBeInstanceOf(HermesUnavailableError)
    await expect(
      adapter.history("researcher", "stored", 200, 0)
    ).resolves.toEqual({
      sessionId: "hermes:researcher:stored",
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
      "/api/sessions/stored/messages?profile=researcher&limit=200&offset=0&order=oldest&include_compacted=true",
    ])
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
            activity: "unknown",
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

  it("observes only bounded events for the exact resumed native Session", async () => {
    let nativeListener: ((event: unknown) => void) | undefined
    const stop = vi.fn()
    const listener = vi.fn()
    const disconnected = vi.fn()
    const observeEvents = vi.fn(async (next: (event: unknown) => void) => {
      nativeListener = next
      return stop
    })
    const adapter = new HermesServerAdapter({
      request: vi.fn(),
      observeEvents,
    })

    await adapter.observe("live-session", listener, disconnected)
    nativeListener!({ type: "message", session_id: "other-session" })
    nativeListener!({
      type: "message",
      session_id: "live-session",
      payload: "x".repeat(4_194_305),
    })
    expect(disconnected).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(listener).not.toHaveBeenCalled()
  })

  it("ignores oversized foreign Session events before accepting an exact event", async () => {
    let nativeListener: ((event: unknown) => void) | undefined
    const listener = vi.fn()
    const disconnected = vi.fn()
    const adapter = new HermesServerAdapter({
      request: vi.fn(),
      observeEvents: vi.fn(async (next) => {
        nativeListener = next
        return vi.fn()
      }),
    })
    await adapter.observe("live-session", listener, disconnected)
    nativeListener!({
      type: "message",
      session_id: "other-session",
      payload: "x".repeat(4_194_305),
    })
    const expected = {
      type: "message",
      session_id: "live-session",
      payload: { text: "changed" },
    }
    nativeListener!(expected)

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(expected)
    expect(disconnected).not.toHaveBeenCalled()
  })

  it("disconnects once on a deeply nested active Session event and rejects oversized live identities", async () => {
    let nativeListener: ((event: unknown) => void) | undefined
    const disconnected = vi.fn()
    const stop = vi.fn()
    const request = vi.fn(async () => ({ session_id: "x".repeat(257) }))
    const adapter = new HermesServerAdapter({
      request,
      observeEvents: vi.fn(async (next) => {
        nativeListener = next
        return stop
      }),
    })
    await adapter.observe("live-session", vi.fn(), disconnected)
    let payload: unknown = "leaf"
    for (let index = 0; index < 20; index += 1) payload = { nested: payload }
    nativeListener!({ type: "message", session_id: "live-session", payload })
    nativeListener!({ type: "message", session_id: "live-session", payload })

    expect(disconnected).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    await expect(
      adapter.resume({
        agentId: "researcher",
        sessionId: "stored",
        threadId: "hermes:researcher:stored",
      })
    ).rejects.toBeInstanceOf(HermesUnavailableError)
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
