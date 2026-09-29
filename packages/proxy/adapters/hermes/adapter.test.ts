import { describe, expect, it, vi } from "vitest"
import type { AgentUpdatePatch } from "../../../protocol"

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
import { createHermesHttp } from "./http"
import { rpcRouter } from "./test-utils/rpc-router"
import { useFakeClock } from "../../../../test/support/fake-clock"
import { captureLogs } from "../../../../test/support/log-capture"
import { PendingRequestKind } from "../../core/events"
import {
  ServerAgentUpdateUnsupportedError,
  ServerTurnSteerUncertainError,
} from "../../core/runtime"
import { HermesTurnPublicError, HermesTurnRewindConflictError } from "./run"
import { HermesInteractionPublicError } from "./interactions"
import {
  HermesContentScopeError,
  HermesContentUnavailableError,
  HermesContentUnreadableError,
} from "./content"
import {
  HermesWorkspaceScopeError,
  HermesWorkspaceUnavailableError,
} from "./workspace"

function profile(
  hidden = false,
  revision: number | null = 7,
  aos: { avatar?: unknown; revision?: number } = {}
) {
  return {
    name: "researcher",
    display_name: "Researcher",
    description: "Investigates primary sources",
    ui_meta: {
      aos: {
        role: "agent",
        privatePath: "/srv/hermes/researcher",
        ...(aos.avatar === undefined ? {} : { avatar: aos.avatar }),
      },
      "hermes-bots": { hidden, nativeOnly: "keep-server-side" },
    },
    ...(revision === null
      ? {}
      : {
          ui_meta_revisions: {
            "hermes-bots": revision,
            ...(aos.revision === undefined ? {} : { aos: aos.revision }),
          },
        }),
  }
}

/**
 * The dashboard HTTP API for the researcher's owned Session `stored`: its
 * detail row and, when given, its stored `messages`. `other` answers any
 * further path; everything else is unexpected.
 */
function ownedSessionHttp(
  messages?: readonly unknown[],
  other?: (path: string) => unknown
) {
  return vi.fn(async (path: string) => {
    if (path.startsWith("/api/sessions/stored?"))
      return { id: "stored", profile: "researcher", title: "Owned" }
    if (messages && path.includes("/messages?"))
      return { session_id: "stored", messages }
    if (other) return other(path)
    throw new Error(`unexpected ${path}`)
  })
}

describe("Hermes server adapter", () => {
  it("binds workspace models, context, Todos, and activity to the owned stored Session", async () => {
    const router = rpcRouter({
      "session.resume": async () => ({
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
      }),
      "model.options": async () => ({
        provider: "native",
        model: "small",
        providers: [{ slug: "native", name: "Native", models: ["small"] }],
      }),
    })
    const http = ownedSessionHttp([
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
    ])
    const adapter = new HermesServerAdapter({ ...router, http })
    const sessionId = "stored"

    await expect(adapter.models("researcher", sessionId)).resolves.toEqual({
      selectedId: '["native","small"]',
      options: [{ id: '["native","small"]', label: "small", group: "Native" }],
    })
    await expect(adapter.context("researcher", sessionId)).resolves.toEqual({
      usedTokens: 20,
      maxTokens: 100,
      source: "provider-usage",
    })
    await expect(adapter.todos("researcher", sessionId)).resolves.toEqual([
      { id: "one", label: "Inspect", status: "active" },
    ])
    await expect(adapter.activity("researcher", sessionId)).resolves.toEqual({
      status: "available",
      scope: "active-session",
      coverage: "active-session-only",
      state: "running",
    })
    vi.spyOn(adapter, "slashCommands").mockResolvedValue([])
    expect(
      JSON.stringify(
        await adapter.workspaceCapabilities("researcher", sessionId)
      )
    ).not.toContain("live-secret")
  })

  it("refreshes the Session's reported model from its own writes and events", async () => {
    const router = rpcRouter({
      "session.resume": async () => ({
        session_id: "live-secret",
        running: false,
        info: { provider: "native", model: "small" },
      }),
      "config.set": async () => ({
        key: "model",
        scope: "session",
        value: "large",
      }),
      "model.options": async () => ({
        provider: "native",
        model: "small",
        providers: [
          { slug: "native", name: "Native", models: ["small", "large"] },
        ],
      }),
    })
    const adapter = new HermesServerAdapter({
      ...router,
      http: ownedSessionHttp(),
    })

    await adapter.native.resume({
      agentId: "researcher",
      providerSessionId: "stored",
      sessionId: "stored",
    })
    await adapter.native.subscribeLive("live-secret", vi.fn())
    await expect(adapter.models("researcher", "stored")).resolves.toMatchObject(
      { selectedId: '["native","small"]' }
    )
    // A write is authoritative for its own answer, before Hermes echoes it.
    await expect(
      adapter.updateModel("researcher", "stored", {
        selectedId: '["native","large"]',
      })
    ).resolves.toEqual({ selectedId: '["native","large"]' })
    // Hermes then pushes session.info for every model or effort change, and
    // attach-time state would otherwise name the model for the life of the
    // connection.
    router.publish({
      type: "session.info",
      session_id: "live-secret",
      payload: {
        provider: "native",
        model: "large-2026-09",
        reasoning_effort: "high",
        running: false,
      },
    })

    await expect(adapter.models("researcher", "stored")).resolves.toMatchObject(
      {
        selectedId: '["native","large-2026-09"]',
        effortId: "high",
      }
    )
  })

  it("stages owned attachments and reads only a published same-Session artifact", async () => {
    const router = rpcRouter({
      "session.resume": async () => ({
        session_id: "live-secret",
        running: false,
        status: "idle",
      }),
      "image.attach_bytes": async () => ({
        attached: true,
        path: "/private/image.png",
      }),
    })
    // Hermes saves the image's user row only once its turn starts.
    const http = ownedSessionHttp(
      [
        {
          role: "tool",
          content: JSON.stringify({
            ok: true,
            type: "aos.artifact",
            artifact: {
              id: "artifact-1",
              workdir: "/home/agent/scratch",
              path: "reports/result.txt",
              filename: "result.txt",
            },
          }),
        },
      ],
      (path) => {
        if (path.startsWith("/api/fs/read-data-url?"))
          return { dataUrl: "data:text/plain;base64,aGVsbG8=" }
        throw new Error(`unexpected ${path}`)
      }
    )
    const adapter = new HermesServerAdapter({ ...router, http })
    const sessionId = "stored"

    const staged = await adapter.stageAttachments("researcher", sessionId, [
      { type: "image", dataUrl: "data:image/png;base64,aGVsbG8=" },
    ])
    expect(router.calls("image.attach_bytes")).toEqual([
      {
        params: {
          session_id: "live-secret",
          content_base64: "data:image/png;base64,aGVsbG8=",
          filename: "image.png",
        },
        maxResponseBytes: 65_536,
      },
    ])

    const [imageId] = staged.artifactIds?.() ?? []
    await expect(
      adapter.artifact("researcher", sessionId, imageId!)
    ).resolves.toMatchObject({ filename: "image.png" })
    expect(http.mock.calls.at(-1)?.[0]).toContain(
      `path=${encodeURIComponent("/private/image.png")}`
    )

    await expect(
      adapter.artifact("researcher", sessionId, "artifact-1")
    ).resolves.toEqual({
      bytes: Uint8Array.from([104, 101, 108, 108, 111]),
      filename: "result.txt",
      mimeType: "text/plain",
    })
    expect(http.mock.calls.at(-1)?.[0]).toContain(
      `path=${encodeURIComponent("/home/agent/scratch/reports/result.txt")}&profile=researcher&session_id=stored`
    )
    expect(http.mock.calls.at(-1)?.[1]).toEqual({
      maxResponseBytes: 26_214_400,
    })
  })

  it("reads what the aos-ui MCP tool and an assistant MEDIA line published", async () => {
    const reportPath = "/home/alice/reports/q3.pdf"
    const chartPath = "/home/alice/reports/chart.png"
    const messages = [
      {
        id: "assistant-present",
        role: "assistant",
        tool_calls: [
          {
            id: "present-call",
            function: {
              name: "mcp__aos_ui__present_artifact",
              arguments: JSON.stringify({ path: reportPath }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "present-call",
        tool_name: "mcp__aos_ui__present_artifact",
        // Hermes wraps an MCP tool's text content as `{"result": <text>}`.
        content: JSON.stringify({
          result: JSON.stringify({
            ok: true,
            type: "aos.artifact",
            artifact: {
              path: reportPath,
              filename: "q3.pdf",
              mimeType: "application/pdf",
            },
          }),
        }),
      },
      {
        id: "assistant-final",
        role: "assistant",
        content: `Here is the chart.\nMEDIA:${chartPath}`,
      },
    ]
    const http = ownedSessionHttp(messages, (path) => {
      if (path.startsWith("/api/fs/read-data-url?"))
        return { dataUrl: "data:application/octet-stream;base64,aGVsbG8=" }
      throw new Error(`unexpected ${path}`)
    })
    const adapter = new HermesServerAdapter({ ...rpcRouter(), http })
    const history = await adapter.history("researcher", "stored", 200, 0)
    const artifacts = history.messages.flatMap((message) =>
      message.content.flatMap((part) =>
        part.type === "data" &&
        part.name === "aos.artifact" &&
        typeof part.data.id === "string" &&
        typeof part.data.filename === "string"
          ? [{ id: part.data.id, filename: part.data.filename }]
          : []
      )
    )

    expect(artifacts.map(({ filename }) => filename)).toEqual([
      "q3.pdf",
      "chart.png",
    ])
    expect(JSON.stringify(history)).not.toContain("/home/alice")
    for (const [artifact, path] of [
      [artifacts[0]!, reportPath],
      [artifacts[1]!, chartPath],
    ] as const) {
      await expect(
        adapter.artifact("researcher", "stored", artifact.id)
      ).resolves.toMatchObject({ filename: artifact.filename })
      expect(http.mock.calls.at(-1)?.[0]).toContain(
        `path=${encodeURIComponent(path)}&profile=researcher`
      )
    }
  })

  it("reports an output the provider can no longer read as not found", async () => {
    // A default `text_to_speech` delivery lands in the media cache Hermes prunes
    // at a 24-hour age, so its receipt outlives its bytes and `read-data-url`
    // answers 404. The Session's published artifact reads from the same
    // endpoint and must stay unaffected.
    const audioPath = "/home/alice/.hermes/cache/audio/tts_20260915_184023.mp3"
    const messages = [
      {
        id: "assistant-tools",
        role: "assistant",
        tool_calls: [
          {
            id: "artifact-call",
            function: {
              name: "tool_call",
              arguments: JSON.stringify({
                name: "present_artifact",
                arguments: {
                  mimeType: "text/markdown",
                  path: "interview-brief.md",
                  title: "Interview Brief",
                },
              }),
            },
          },
          {
            id: "tts-call",
            function: {
              name: "text_to_speech",
              arguments: '{"speed":1.05,"text":"Interview brief"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "artifact-call",
        tool_name: "present_artifact",
        content: JSON.stringify({
          ok: true,
          type: "aos.artifact",
          artifact: {
            id: "hermes-artifact-3d43f638eb6049e8aaf7cb0c8d96ad3b",
            workdir: "/home/alice/interviews",
            path: "interview-brief.md",
            filename: "Interview Brief — VP AI",
            sizeBytes: 11_102,
            mimeType: "text/markdown",
          },
        }),
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
          provider: "elevenlabs",
          voice_compatible: false,
          chunk_count: 1,
          delivery_file_count: 1,
          combined_chunks: false,
        }),
      },
      {
        id: "assistant-final",
        role: "assistant",
        content: `MEDIA:${audioPath}`,
      },
    ]
    let audioFailure = new HermesHttpError(404)
    const http = ownedSessionHttp(messages, (path) => {
      if (path.startsWith("/api/fs/read-data-url?")) {
        if (path.includes(encodeURIComponent(audioPath))) throw audioFailure
        return { dataUrl: "data:text/markdown;base64,IyBCcmllZg==" }
      }
      throw new Error(`unexpected ${path}`)
    })
    const adapter = new HermesServerAdapter({ ...rpcRouter(), http })
    const history = await adapter.history("researcher", "stored", 200, 0)
    const mediaId = history.messages
      .flatMap((message) =>
        message.role === "assistant" ? message.content : []
      )
      .find(
        (part) =>
          part.type === "data" &&
          part.name === "aos.artifact" &&
          part.data.mimeType === "audio/mpeg"
      )
    if (mediaId?.type !== "data" || typeof mediaId.data.id !== "string")
      throw new Error("Expected a projected TTS artifact")

    const unreadable = await adapter
      .artifact("researcher", "stored", mediaId.data.id)
      .then(() => undefined)
      .catch((error: unknown) => error)
    expect(unreadable).toBeInstanceOf(HermesContentUnreadableError)
    expect(adapter.publicError(unreadable)?.kind).toBe("gone")
    expect(String(unreadable)).not.toContain(audioPath)

    // The same endpoint still serves the artifact the tool published.
    await expect(
      adapter.artifact(
        "researcher",
        "stored",
        "hermes-artifact-3d43f638eb6049e8aaf7cb0c8d96ad3b"
      )
    ).resolves.toEqual({
      bytes: Uint8Array.from([35, 32, 66, 114, 105, 101, 102]),
      filename: "Interview Brief — VP AI",
      mimeType: "text/markdown",
    })

    // A file Hermes refuses on its own merits answers 403, not 401: reporting
    // that as a credential failure would send the operator to fix a gateway
    // token that is working.
    audioFailure = new HermesHttpError(403)
    const refused = await adapter
      .artifact("researcher", "stored", mediaId.data.id)
      .then(() => undefined)
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(HermesContentUnreadableError)
    expect(adapter.publicError(refused)?.kind).toBe("gone")

    // An output grown past the read bound is gone the same way.
    audioFailure = new HermesHttpError(413)
    await expect(
      adapter.artifact("researcher", "stored", mediaId.data.id)
    ).rejects.toBeInstanceOf(HermesContentUnreadableError)

    // A provider outage stays retryable: only a refusal of the file itself is
    // reported as the output being gone.
    audioFailure = new HermesHttpError(500)
    const outage = await adapter
      .artifact("researcher", "stored", mediaId.data.id)
      .then(() => undefined)
      .catch((error: unknown) => error)
    expect(outage).toBeInstanceOf(HermesContentUnavailableError)
    expect(adapter.publicError(outage)?.kind).toBe("unavailable")
  })

  it("restores pending interactions from owned Session state and reconciles them through a fresh resume that re-delivers what is still open", async () => {
    // A heal rebinds the Session, so reconciliation must ask Hermes again: only
    // its own `open_requests` re-delivery confirms the request is still open,
    // and a cached binding would expire a card the user can still answer.
    const router = rpcRouter({
      "session.resume": async () => ({
        session_id: "live-secret",
        running: true,
        open_requests: [
          {
            id: "srq-00000000000c",
            method: "clarify",
            params: { session_id: "live-secret", question: "Which region?" },
          },
        ],
      }),
    })
    const adapter = new HermesServerAdapter({
      ...router,
      http: ownedSessionHttp(),
    })

    await adapter.pendingInteractions("researcher", "stored")
    const reconciled = await adapter.pendingInteractions("researcher", "stored")

    expect(router.calls("session.resume")).toHaveLength(2)
    expect(router.calls("session.resume")[0]?.params).toEqual({
      session_id: "stored",
      profile: "researcher",
      omit_messages: true,
    })
    expect(reconciled).toMatchObject({
      turnId: "aos-hermes-restored-interaction",
      running: true,
      status: "waiting-for-input",
      requests: [
        { requestId: "srq-00000000000c", kind: PendingRequestKind.Elicitation },
      ],
    })
    // The re-delivered request is never answered on AOS' behalf.
    expect(router.requests.answer("srq-00000000000c")).toBeUndefined()
    expect(router.requests.refusal("srq-00000000000c")).toBeUndefined()
  })

  it.each(["redirected", "queued"] as const)(
    "accepts only the native %s redirect acknowledgement",
    async (status) => {
      const request = vi.fn(async () => ({ status, text: "Correction" }))
      const adapter = new HermesServerAdapter({ request })

      await expect(
        adapter.native.redirect("live-secret", "Correction")
      ).resolves.toBe(status)
      expect(request).toHaveBeenCalledWith("session.redirect", {
        session_id: "live-secret",
        text: "Correction",
      })
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
    ).rejects.toBeInstanceOf(ServerTurnSteerUncertainError)
  })

  it("queues a correction Hermes declines outside a model request, as during compaction", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "session.redirect")
        return { status: "rejected", text: "Correction" }
      if (method === "prompt.submit") return { status: "queued" }
      throw new Error(`unexpected ${method}`)
    })
    const adapter = new HermesServerAdapter({ request })

    await expect(
      adapter.native.redirect("live-secret", "Correction")
    ).resolves.toBe("queued")
    expect(request.mock.calls.at(-1)).toEqual([
      "prompt.submit",
      { session_id: "live-secret", text: "Correction", queued: true },
      { signal: undefined },
    ])
  })

  it("keeps a declined correction's queued submit uncertain or unavailable as Hermes answers it", async () => {
    const declined = (submit: () => Promise<unknown>) =>
      new HermesServerAdapter({
        request: vi.fn(async (method: string) =>
          method === "session.redirect"
            ? { status: "rejected", text: "Correction" }
            : submit()
        ),
      }).native.redirect("live-secret", "Correction")

    await expect(
      declined(async () => {
        throw new HermesRpcUncertainError()
      })
    ).rejects.toBeInstanceOf(ServerTurnSteerUncertainError)
    await expect(
      declined(async () => {
        throw new HermesRpcRejectedError(-32600)
      })
    ).rejects.toBeInstanceOf(HermesUnavailableError)
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
      providerSessionId: "stored",
      sessionId: "stored",
    }

    await adapter.native.submit("live-secret", {
      scope,
      text: "Retry",
      turnId: "retry-run",
      rewindSourceId: "hermes-row-10",
    })
    expect(request).toHaveBeenLastCalledWith(
      "prompt.submit",
      {
        session_id: "live-secret",
        text: "Retry",
        confirm_truncate: true,
        confirm_empty_truncate: true,
        truncate_before_row_id: 10,
      },
      { signal: undefined }
    )

    request.mockClear()
    messages = [{ row_id: 12, role: "assistant", text: "Changed" }]
    await expect(
      adapter.native.submit("live-secret", {
        scope,
        text: "Retry",
        turnId: "stale-retry-run",
        rewindSourceId: "hermes-row-10",
      })
    ).rejects.toBeInstanceOf(HermesTurnRewindConflictError)
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

  describe("with Hermes back-filling pinned Sessions onto every page", () => {
    // Hermes's dashboard list appends every pinned Session a page missed,
    // after the `limit` rows, on every page; `total` counts each Session once.
    const catalog = (counts: Record<string, number>, pinnedIndexes: number[]) =>
      Object.fromEntries(
        Object.entries(counts).map(([profileName, count], profileIndex) => [
          profileName,
          Array.from({ length: count }, (_, index) => ({
            id: `${profileName}-${index}`,
            profile: profileName,
            title: `${profileName} ${index}`,
            // Interleaved recency, newest first within each profile.
            last_active: 10_000 - index * 10 - profileIndex,
            pinned: pinnedIndexes.includes(index),
          })),
        ])
      )
    const hermesWithPins = (
      rowsByProfile: Record<string, Array<{ id: string; pinned: boolean }>>,
      /** Hermes counts hidden rows its list leaves out. */
      hiddenByProfile: Record<string, number> = {}
    ) => {
      const request = vi.fn(async () => ({
        profiles: Object.keys(rowsByProfile).map((name) => ({
          name,
          ui_meta: {},
          ui_meta_revisions: {},
        })),
      }))
      const http = vi.fn(async (path: string) => {
        const url = new URL(path, "http://native.test")
        const profileName = url.searchParams.get("profile")!
        const rows = rowsByProfile[profileName]!
        const limit = Number(url.searchParams.get("limit"))
        const offset = Number(url.searchParams.get("offset"))
        const page = rows.slice(offset, offset + limit)
        const backfill = rows.filter((row) => row.pinned && !page.includes(row))
        return {
          sessions: [...page, ...backfill],
          total: rows.length + (hiddenByProfile[profileName] ?? 0),
        }
      })
      return new HermesServerAdapter({ request, http })
    }
    const ids = (sessions: Array<{ id: string }>) =>
      sessions.map(({ id }) => id)
    /** Pages the way ACP `session/list` does: the next offset is this one plus the rows served. */
    const pageToEnd = async (
      list: (
        limit: number,
        offset: number
      ) => Promise<{
        sessions: Array<{ id: string }>
        total: number
      }>
    ) => {
      const served: string[] = []
      let offset = 0
      let pages = 0
      for (;;) {
        const page = await list(50, offset)
        pages += 1
        served.push(...ids(page.sessions))
        if (!page.sessions.length && offset < page.total)
          throw new Error(`the cursor stalled at ${offset}`)
        offset += page.sessions.length
        if (offset >= page.total) return { served, pages }
      }
    }

    it("serves the all-Agents page at offset 150 with each Session once", async () => {
      const rows = catalog({ alpha: 120, beta: 90, gamma: 30 }, [2, 70, 110])
      const adapter = hermesWithPins(rows)
      const everything = Object.values(rows)
        .flat()
        .sort((left, right) => right.last_active - left.last_active)

      const page = await adapter.listAllSessions(50, 150)

      expect(ids(page.sessions)).toEqual(ids(everything.slice(150, 200)))
      expect(page.total).toBe(240)
    })

    it("serves a per-Agent page past the first with only its own rows", async () => {
      const rows = catalog({ alpha: 180 }, [1, 5, 170])
      const adapter = hermesWithPins(rows)

      const page = await adapter.listSessions("alpha", 50, 100)

      expect(ids(page.sessions)).toEqual(ids(rows.alpha!.slice(100, 150)))
      expect(page.total).toBe(180)
    })

    it("follows the cursor to the end of every catalog without skipping or repeating a Session", async () => {
      const rows = catalog({ alpha: 223, beta: 101, gamma: 7 }, [0, 3, 99, 200])
      const adapter = hermesWithPins(rows, { beta: 2, gamma: 1 })
      const everything = Object.values(rows)
        .flat()
        .sort((left, right) => right.last_active - left.last_active)

      const all = await pageToEnd((limit, offset) =>
        adapter.listAllSessions(limit, offset)
      )
      expect(all.pages).toBe(7)
      expect(all.served).toEqual(ids(everything))

      for (const [profileName, profileRows] of Object.entries(rows)) {
        const own = await pageToEnd((limit, offset) =>
          adapter.listSessions(profileName, limit, offset)
        )
        expect(own.served).toEqual(ids(profileRows))
      }
    })
  })

  it("catalogs creator-owned Sessions while keeping the creator unselectable", async () => {
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
    const http = vi.fn(async (path: string) => {
      const profileName = new URL(path, "http://native.test").searchParams.get(
        "profile"
      )
      return {
        sessions: [
          {
            id: `${profileName}-session`,
            profile: profileName,
            last_active: profileName === "researcher" ? 20 : 10,
          },
        ],
        total: 1,
      }
    })
    const adapter = new HermesServerAdapter({ request, http })

    const agents = await adapter.listAgents()
    const catalog = await adapter.listAllSessions(50, 0)

    expect(
      agents.agents.find(({ summary }) => summary.id === "aos-creator")
    ).toMatchObject({
      summary: { role: "creator" },
      selectable: false,
    })
    expect(
      catalog.sessions.map(({ id, agentId }) => ({ id, agentId }))
    ).toEqual([
      { id: "researcher-session", agentId: "researcher" },
      { id: "aos-creator-session", agentId: "aos-creator" },
    ])
    expect(http.mock.calls.map(([path]) => path)).toEqual([
      "/api/sessions?profile=researcher&limit=50&offset=0&order=recent&archived=include&exclude_sources=cron%2Ctool%2Ckanban",
      "/api/sessions?profile=aos-creator&limit=50&offset=0&order=recent&archived=include&exclude_sources=cron%2Ctool%2Ckanban",
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
          source: "aos-ui",
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
          source: "aos-ui",
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
      if (method === "session.close") return { closed: true }
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
      { providerSessionId: "stored-1", created: true },
      { providerSessionId: "stored-1", created: true },
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
          source: "aos-ui",
          close_on_disconnect: false,
          follow_profile_config: true,
          messages: [
            {
              role: "user",
              content: JSON.stringify({
                v: 1,
                type: "aos.guest.first-turn",
                instruction: "Load the interview skill.",
              }),
            },
            // Hermes merges consecutive user rows, which would erase the
            // guest's first message id and so its Edit target.
            {
              role: "assistant",
              content: "Understood.",
              display_kind: "hidden",
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
      // The first prompt resumes from the store, so the seed rows carry the
      // row ids an Edit before any reload rewinds to.
      ["session.close", { session_id: "live-private" }],
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
    ).resolves.toEqual({ providerSessionId: "resolved-1", created: false })
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
    ).resolves.toEqual({ providerSessionId: "stored-2", created: false })

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

  /** Hermes' resume answer for a lazy Session no turn has stored yet. */
  const lazySnapshot = {
    session_id: "live-private",
    stored_session_id: "stored/1",
    message_count: 0,
    messages: [],
    info: { lazy: true, profile_name: "researcher" },
  }
  /** An adapter whose dashboard has no row for any Session yet. */
  const unstoredAdapter = (resume: Record<string, unknown>) => {
    const router = rpcRouter({ "session.resume": async () => resume })
    const adapter = new HermesServerAdapter({
      ...router,
      http: vi.fn(async () => {
        throw new HermesHttpError(404)
      }),
    })
    return { adapter, router }
  }

  it("projects an unpersisted lazy Session from its native resume snapshot", async () => {
    const { adapter, router } = unstoredAdapter(lazySnapshot)

    await expect(adapter.getSession("researcher", "stored/1")).resolves.toEqual(
      {
        // Hermes stores no title or date before the first turn.
        id: "stored/1",
        agentId: "researcher",
        archived: false,
        status: "idle",
      }
    )
    expect(router.calls("session.resume")[0]?.params).toEqual({
      session_id: "stored/1",
      profile: "researcher",
      omit_messages: true,
    })
  })

  it("keeps a Session it holds live until Hermes stores its first turn", async () => {
    // Hermes answers from the live record, which names no stored id, until
    // the first turn is stored.
    const { adapter } = unstoredAdapter({
      session_id: "live-1",
      session_key: "stored/1",
      message_count: 2,
      messages: [],
      running: true,
      status: "streaming",
    })

    // A live record this proxy never bound proves nothing.
    await expect(
      adapter.getSession("researcher", "stored/1")
    ).rejects.toBeInstanceOf(HermesSessionNotFoundError)
    await adapter.native.inspectExecution({
      agentId: "researcher",
      providerSessionId: "stored/1",
      sessionId: "stored/1",
      turnId: "run-1",
    })
    await expect(
      adapter.getSession("researcher", "stored/1")
    ).resolves.toMatchObject({ id: "stored/1", agentId: "researcher" })
  })

  it("returns empty Todos for an unpersisted lazy Session", async () => {
    const { adapter } = unstoredAdapter(lazySnapshot)

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
      conflict.updateSession("researcher", "stored", {
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
            started_at: 0.5,
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
          createdAt: "1970-01-01T00:00:00.500Z",
          updatedAt: "1970-01-01T00:00:01.000Z",
          // `is_active` is Hermes' five-minute recency window, not a live turn.
          status: "idle",
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    })
  })

  it("reads a Session's creation time from its detail row", async () => {
    const adapter = new HermesServerAdapter({
      request: vi.fn(),
      http: vi.fn(async () => ({
        id: "stored/1",
        profile: "researcher",
        title: "One",
        started_at: 1_700_000_000,
        last_active: 1_700_000_100,
      })),
    })

    await expect(
      adapter.getSession("researcher", "stored/1")
    ).resolves.toMatchObject({ createdAt: "2023-11-14T22:13:20.000Z" })
  })

  it("reads a recently active Session as settled, not running", async () => {
    const row = {
      id: "stored/1",
      profile: "researcher",
      title: "One",
      last_active: 1,
      is_active: true,
    }
    const adapter = new HermesServerAdapter({
      request: vi.fn(),
      http: vi.fn(async (path: string) =>
        path.startsWith("/api/sessions?") ? { sessions: [row], total: 1 } : row
      ),
    })

    const page = await adapter.listSessions("researcher", 50, 0)
    expect(page.sessions.map((session) => session.status)).toEqual(["idle"])
    await expect(
      adapter.getSession("researcher", "stored/1")
    ).resolves.toMatchObject({ status: "idle" })
  })

  it("projects the native derived read state and pin per catalog row and omits each when absent", async () => {
    const adapter = new HermesServerAdapter({
      request: vi.fn(),
      http: vi.fn(async () => ({
        sessions: [
          {
            id: "stored/1",
            profile: "researcher",
            title: "One",
            unread: true,
            pinned: true,
          },
          {
            id: "stored/2",
            profile: "researcher",
            title: "Two",
            unread: false,
            pinned: false,
          },
          { id: "stored/3", profile: "researcher", title: "Three" },
        ],
        total: 3,
      })),
    })

    const page = await adapter.listSessions("researcher", 50, 0)

    expect(page.sessions.map((entry) => entry.unread)).toEqual([
      true,
      false,
      undefined,
    ])
    expect(page.sessions.map((entry) => entry.pinned)).toEqual([
      true,
      false,
      undefined,
    ])
    expect(Object.keys(page.sessions[2])).not.toContain("unread")
    expect(Object.keys(page.sessions[2])).not.toContain("pinned")
  })

  it("treats a non-boolean native read state or pin as a malformed catalog payload", async () => {
    for (const flag of [{ unread: 1 }, { pinned: 1 }]) {
      const adapter = new HermesServerAdapter({
        request: vi.fn(),
        http: vi.fn(async () => ({
          sessions: [
            { id: "stored/1", profile: "researcher", title: "One", ...flag },
          ],
          total: 1,
        })),
      })

      await expect(
        adapter.listSessions("researcher", 50, 0)
      ).rejects.toBeInstanceOf(HermesUnavailableError)
    }
  })

  it("reads the stored flags the Session detail read reports as integers", async () => {
    const adapter = new HermesServerAdapter({
      request: vi.fn(),
      http: vi.fn(async () => ({
        id: "stored/1",
        profile: "researcher",
        title: "One",
        archived: 1,
        pinned: 1,
      })),
    })

    await expect(adapter.getSession("researcher", "stored/1")).resolves.toEqual(
      {
        id: "stored/1",
        agentId: "researcher",
        title: "One",
        archived: true,
        pinned: true,
        status: "idle",
      }
    )
  })

  it("omits read state from the Session detail read that cannot derive it", async () => {
    const adapter = new HermesServerAdapter({
      request: vi.fn(),
      http: vi.fn(async () => ({
        id: "stored/1",
        profile: "researcher",
        title: "One",
        unread: true,
      })),
    })

    const session = await adapter.getSession("researcher", "stored/1")

    expect(Object.keys(session)).not.toContain("unread")
  })

  it("marks a Session read and pins it with the exact native profile-scoped patch bodies", async () => {
    const http = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions/stored%2F1?"))
        return { id: "stored/1", profile: "researcher", title: "One" }
      throw new Error(`unexpected ${path}`)
    })
    const adapter = new HermesServerAdapter({ request: vi.fn(), http })

    await adapter.updateSession("researcher", "stored/1", {
      unread: false,
    })

    expect(http).toHaveBeenLastCalledWith(
      "/api/sessions/stored%2F1?profile=researcher",
      { method: "PATCH", body: { unread: false, profile: "researcher" } }
    )

    await adapter.updateSession("researcher", "stored/1", {
      pinned: true,
    })

    expect(http).toHaveBeenLastCalledWith(
      "/api/sessions/stored%2F1?profile=researcher",
      { method: "PATCH", body: { pinned: true, profile: "researcher" } }
    )
  })

  it("declares the native pin and read state available, and read state temporarily unavailable during an outage", async () => {
    const ready = new HermesServerAdapter({
      request: vi.fn(async () => ({ profiles: [profile()] })),
    })
    const { capabilities } = await ready.runtimeInfo()
    expect(capabilities.sessionPin).toEqual({ status: "available" })
    expect(capabilities.sessionReadState).toEqual({ status: "available" })

    const offline = new HermesServerAdapter({
      request: vi.fn(async () => {
        throw new Error("Hermes request failed")
      }),
    })
    expect((await offline.runtimeInfo()).capabilities.sessionReadState).toEqual(
      {
        status: "unavailable",
        reason: "temporarily-unavailable",
      }
    )
  })

  it("wakes catalog observers only on the native sessions.changed broadcast", async () => {
    const observers = new Set<(event: unknown) => void>()
    const deliver = (event: unknown) => {
      for (const observer of [...observers]) observer(event)
    }
    const listener = vi.fn()
    const adapter = new HermesServerAdapter({
      request: vi.fn(),
      subscribeEvents: vi.fn((next: (event: unknown) => void) => {
        observers.add(next)
        return () => observers.delete(next)
      }),
    })

    const unsubscribe = await adapter.subscribeCatalogChanges!(listener)
    deliver({
      type: "message",
      session_id: "live-session",
      payload: { text: "unrelated" },
    })
    expect(listener).not.toHaveBeenCalled()

    deliver({ type: "sessions.changed", session_id: "", payload: {} })
    expect(listener).toHaveBeenCalledOnce()

    unsubscribe()
    deliver({ type: "sessions.changed", session_id: "", payload: {} })
    expect(listener).toHaveBeenCalledOnce()

    // A transport that cannot subscribe offers no feed for the catalog to dial.
    expect(
      new HermesServerAdapter({ request: vi.fn() }).subscribeCatalogChanges
    ).toBeUndefined()
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
          id: "user-1-1-thought",
          role: "assistant",
          content: [{ type: "reasoning", text: "thinking" }],
          createdAt: "1970-01-01T00:00:02.000Z",
        },
        {
          id: "user-1-1",
          role: "assistant",
          content: [{ type: "text", text: "second" }],
          createdAt: "1970-01-01T00:00:02.000Z",
          completedAt: "1970-01-01T00:00:02.000Z",
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
        "user-new-1",
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

  describe("native history pages of display chrome", () => {
    const chrome = (index: number) => ({
      id: `chrome-${index}`,
      role: "user",
      display_kind: "model_switch",
      content:
        "[System: The active model for this chat has changed to anthropic/small]",
      timestamp: index + 1,
    })

    /** Serves a distinct native page per requested offset and records the scan. */
    const scanAdapter = (
      limit: number,
      page: (offset: number) => readonly unknown[]
    ) => {
      const offsets: number[] = []
      const http = vi.fn(async (path: string) => {
        if (path.startsWith("/api/sessions/stored?"))
          return { id: "stored", profile: "researcher" }
        const query = new URL(`http://hermes${path}`).searchParams
        const offset = Number(query.get("offset"))
        offsets.push(offset)
        const rows = page(offset)
        return {
          session_id: "stored",
          messages: rows,
          pagination: {
            limit: Number(query.get("limit")),
            offset,
            order: query.get("order"),
            returned: rows.length,
          },
        }
      })
      return {
        adapter: new HermesServerAdapter({ request: vi.fn(), http }),
        offsets,
      }
    }

    it("reads older native pages until the conversation page is filled", async () => {
      const { adapter, offsets } = scanAdapter(2, (offset) => {
        if (offset === 0) return [chrome(0), chrome(1)]
        if (offset === 2)
          return [
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
        return []
      })

      const history = await adapter.history("researcher", "stored", 2, 0)

      expect(history.messages.map(({ id }) => id)).toEqual([
        "user-old",
        "user-old-1",
      ])
      expect(history).toMatchObject({ offset: 0, nextOffset: 4, total: 5 })
      expect(offsets).toEqual([0, 2])
    })

    it("returns a page that mixes chrome with conversation after one fetch", async () => {
      const { adapter, offsets } = scanAdapter(2, (offset) =>
        offset === 0
          ? [
              chrome(0),
              {
                id: "user-new",
                role: "user",
                content: "new question",
                timestamp: 2,
              },
            ]
          : [{ id: "user-old", role: "user", content: "older", timestamp: 1 }]
      )

      const history = await adapter.history("researcher", "stored", 2, 0)

      expect(history.messages.map(({ id }) => id)).toEqual(["user-new"])
      // The chrome row older than the page's turn start is the next page's.
      expect(history).toMatchObject({ nextOffset: 1, total: 3 })
      expect(offsets).toEqual([0])
    })

    it("stops at the scan budget instead of reading an all-chrome store forever", async () => {
      const { adapter, offsets } = scanAdapter(2, (offset) => [
        chrome(offset),
        chrome(offset + 1),
      ])

      const history = await adapter.history("researcher", "stored", 2, 0)

      expect(history.messages).toEqual([])
      expect(offsets.length).toBeGreaterThan(1)
      expect(offsets.length).toBeLessThanOrEqual(33)
      expect(offsets).toEqual(
        Array.from({ length: offsets.length }, (_, index) => index * 2)
      )
      expect(history).toMatchObject({
        nextOffset: offsets.length * 2,
        total: offsets.length * 2 + 1,
      })
    })

    it("reports an exhausted chrome-only history without a further fetch", async () => {
      const { adapter, offsets } = scanAdapter(2, () => [chrome(0)])

      const history = await adapter.history("researcher", "stored", 2, 0)

      expect(history.messages).toEqual([])
      expect(history.nextOffset).toBe(1)
      expect(history.total).toBe(history.nextOffset)
      expect(offsets).toEqual([0])
    })

    it("pairs a tool result with its assistant tool call from an older page", async () => {
      const { adapter, offsets } = scanAdapter(2, (offset) => {
        if (offset === 0)
          return [
            chrome(9),
            {
              role: "tool",
              tool_call_id: "skill-call",
              tool_name: "use_skill",
              content: JSON.stringify({ success: true }),
            },
          ]
        if (offset === 2)
          return [
            chrome(8),
            {
              id: "assistant-skill",
              role: "assistant",
              tool_calls: [
                {
                  id: "skill-call",
                  function: {
                    name: "use_skill",
                    arguments: JSON.stringify({ name: "grilling" }),
                  },
                },
              ],
              timestamp: 1,
            },
          ]
        return []
      })

      const history = await adapter.history("researcher", "stored", 2, 0)

      expect(history.messages).toMatchObject([
        {
          id: "assistant-skill",
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "skill-call",
              toolName: "use_skill",
              result: { success: true },
            },
          ],
        },
      ])
      expect(offsets).toEqual([0, 2])
    })
  })

  describe("turn-aligned history pages", () => {
    const user = (id: string) => ({ id, role: "user", content: id })
    const assistant = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      role: "assistant",
      content: id,
      ...extra,
    })
    const todoCall = assistant("a-todo", {
      tool_calls: [{ id: "todo-call", function: { name: "todo" } }],
    })
    const todoResult = {
      role: "tool",
      tool_call_id: "todo-call",
      content: JSON.stringify({
        todos: [{ id: "one", content: "Inspect", status: "active" }],
      }),
    }

    /** Serves a chronological transcript the way Hermes' `order=latest` pages it. */
    const transcriptAdapter = (
      store: readonly unknown[],
      request = vi.fn(async (method: string): Promise<unknown> => {
        throw new Error(`unexpected ${method}`)
      })
    ) => {
      const http = vi.fn(async (path: string) => {
        if (path.startsWith("/api/sessions/stored?"))
          return { id: "stored", profile: "researcher" }
        const query = new URL(`http://hermes${path}`).searchParams
        const limit = Number(query.get("limit"))
        const offset = Number(query.get("offset"))
        const end = Math.max(0, store.length - offset)
        const rows = store.slice(Math.max(0, end - limit), end)
        return {
          session_id: "stored",
          messages: rows,
          pagination: {
            limit,
            offset,
            returned: rows.length,
            total: store.length,
          },
        }
      })
      return new HermesServerAdapter({ request, http })
    }

    it("snaps each page to a turn start and re-reads the dropped rows", async () => {
      const adapter = transcriptAdapter([
        user("u1"),
        assistant("a1"),
        user("u2"),
        assistant("a2", {
          tool_calls: [{ id: "call-2", function: { name: "terminal" } }],
        }),
        { role: "tool", tool_call_id: "call-2", content: "ok" },
        assistant("a2b"),
        user("u3"),
        assistant("a3"),
      ])

      const newest = await adapter.history("researcher", "stored", 4, 0)
      const middle = await adapter.history("researcher", "stored", 4, 2)
      const oldest = await adapter.history("researcher", "stored", 4, 6)

      expect(newest.messages.map(({ id }) => id)).toEqual(["u3", "u3-1"])
      expect(newest).toMatchObject({ nextOffset: 2, total: 8 })
      expect(middle.messages.map(({ id }) => id)).toEqual([
        "u2",
        "u2-1",
        "u2-2",
      ])
      expect(middle).toMatchObject({ nextOffset: 6, total: 8 })
      expect(oldest.messages.map(({ id }) => id)).toEqual(["u1", "u1-1"])
      expect(oldest).toMatchObject({ nextOffset: 8, total: 8 })
    })

    it("keeps the rows before the first prompt on a page that reached the start", async () => {
      const adapter = transcriptAdapter([
        assistant("greeting"),
        user("u1"),
        assistant("a1"),
      ])

      const history = await adapter.history("researcher", "stored", 3, 0)

      expect(history.messages.map(({ id }) => id)).toEqual([
        "greeting",
        "u1",
        "u1-1",
      ])
      expect(history).toMatchObject({ nextOffset: 3, total: 3 })
    })

    it("keeps a page whole when one turn is longer than the page", async () => {
      const adapter = transcriptAdapter([
        user("u1"),
        assistant("a1", {
          tool_calls: [{ id: "call-1", function: { name: "terminal" } }],
        }),
        { role: "tool", tool_call_id: "call-1", content: "ok" },
        assistant("a1b"),
        assistant("a1c"),
      ])

      const history = await adapter.history("researcher", "stored", 3, 0)

      expect(history.messages.map(({ id }) => id)).toEqual(["a1b"])
      expect(history).toMatchObject({ nextOffset: 3, total: 5 })
    })

    it("adds no plan and restores no turn on an older page", async () => {
      const request = vi.fn(async (method: string): Promise<unknown> => {
        throw new Error(`unexpected ${method}`)
      })
      const adapter = transcriptAdapter(
        [user("u1"), todoCall, todoResult, user("u2"), user("u3")],
        request
      )

      const history = await adapter.history("researcher", "stored", 4, 1)

      expect(history.messages.map(({ role }) => role)).toEqual([
        "user",
        "assistant",
        "user",
      ])
      expect(request).not.toHaveBeenCalled()
    })

    it("restores the failed turn on the newest page of a long Session", async () => {
      const request = vi.fn(async (method: string): Promise<unknown> => {
        if (method === "session.resume")
          return {
            session_id: "live-secret",
            running: false,
            status: "idle",
            inflight: {
              user: "u3",
              assistant: "partial answer",
              streaming: false,
              status: "error",
              recoverable: true,
              error: "provider failed",
            },
          }
        throw new Error(`unexpected ${method}`)
      })
      const adapter = transcriptAdapter(
        [user("u1"), todoCall, todoResult, assistant("a1"), user("u3")],
        request
      )

      const history = await adapter.history("researcher", "stored", 2, 0)

      expect(history.messages.map(({ role }) => role)).toEqual([
        "user",
        "assistant",
      ])
      expect(history.messages.at(-1)).toMatchObject({
        role: "assistant",
        status: { type: "incomplete", reason: "error" },
      })
      expect(history).toMatchObject({ nextOffset: 1, total: 5 })
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
      revision: expect.stringMatching(/^profiles:[0-9a-f]{64}$/),
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
          avatarEditable: true,
          revision: "hermes-bots:7,aos:0",
        },
      ],
    })
    expect(JSON.stringify(catalog)).not.toContain("privatePath")
    expect(JSON.stringify(catalog)).not.toContain("nativeOnly")
  })

  it("keeps the catalog revision inside the identifier bound for many long profile names", async () => {
    const many = Array.from({ length: 24 }, (_, index) => ({
      ...profile(),
      name: `aos-synthetic-role-with-a-long-name-${index}`,
      display_name: `Role ${index}`,
    }))
    const adapter = new HermesServerAdapter({
      request: vi.fn(async () => ({ profiles: many })),
    })

    const catalog = await adapter.listAgents()

    expect(catalog.agents).toHaveLength(many.length)
    expect(catalog.revision.length).toBeLessThanOrEqual(256)
  })

  it("changes the catalog revision when an Agent's own revision changes", async () => {
    const revisionFor = async (revision: number) => {
      const adapter = new HermesServerAdapter({
        request: vi.fn(async () => ({
          profiles: [profile(false, revision)],
        })),
      })
      return (await adapter.listAgents()).revision
    }

    expect(await revisionFor(7)).toBe(await revisionFor(7))
    expect(await revisionFor(7)).not.toBe(await revisionFor(8))
  })

  it("marks visibility unavailable when Hermes omits the CAS revision map", async () => {
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

  it("treats a profile never written through the CAS as revision 0 and edits it", async () => {
    // Hermes sends `ui_meta_revisions: {}` for such a profile and compares a
    // write against 0; the row is editable, not provider-managed.
    const untouched = {
      name: "default",
      display_name: "Default",
      ui_meta: { "hermes-bots": { shape: "squircle", color: "#8b5cf6" } },
      ui_meta_revisions: {},
    }
    const request = vi
      .fn()
      .mockResolvedValueOnce({ profiles: [untouched] })
      .mockResolvedValueOnce({ profiles: [untouched] })
      .mockResolvedValueOnce({ applied: { ui_meta: true } })
      .mockResolvedValueOnce({
        profiles: [
          {
            ...untouched,
            ui_meta: {
              "hermes-bots": {
                ...untouched.ui_meta["hermes-bots"],
                hidden: true,
              },
            },
            ui_meta_revisions: { "hermes-bots": 1 },
          },
        ],
      })
    const adapter = new HermesServerAdapter({ request })

    expect((await adapter.listAgents()).agents[0]).toMatchObject({
      editable: true,
      revision: "hermes-bots:0,aos:0",
    })

    const updated = await adapter.updateAgent(
      "default",
      { visibility: "hidden" },
      "hermes-bots:0,aos:0"
    )

    expect(
      request.mock.calls.filter(([method]) => method === "profiles.configure")
    ).toEqual([
      [
        "profiles.configure",
        {
          name: "default",
          ui_meta: {
            "hermes-bots": {
              shape: "squircle",
              color: "#8b5cf6",
              hidden: true,
            },
          },
          ui_meta_expected_revisions: { "hermes-bots": 0 },
        },
      ],
    ])
    expect(updated.agent).toMatchObject({
      visibility: "hidden",
      revision: "hermes-bots:1,aos:0",
    })
  })

  it("updates visibility from the list row's revision and confirms an authoritative reread", async () => {
    // `profiles.describe` carries neither `ui_meta` nor its revisions, so the
    // list row is the only read; Hermes's own CAS on configure guards the race.
    const request = vi
      .fn()
      .mockResolvedValueOnce({ profiles: [profile()] })
      .mockResolvedValueOnce({ applied: { ui_meta: true } })
      .mockResolvedValueOnce({ profiles: [profile(true, 8)] })
    const adapter = new HermesServerAdapter({ request })

    const updated = await adapter.updateAgent(
      "researcher",
      { visibility: "hidden" },
      "hermes-bots:7,aos:0"
    )

    expect(request.mock.calls).toEqual([
      ["profiles.list", { include_sessions: false }],
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
      revision: "hermes-bots:8,aos:0",
    })
  })

  it("rejects a stale revision before mutating Hermes", async () => {
    const request = vi.fn(async () => ({ profiles: [profile()] }))
    const adapter = new HermesServerAdapter({ request })
    await expect(
      adapter.updateAgent(
        "researcher",
        { visibility: "hidden" },
        "hermes-bots:6,aos:0"
      )
    ).rejects.toBeInstanceOf(HermesRevisionConflictError)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("surfaces a token-shaped stored avatar", async () => {
    const adapter = new HermesServerAdapter({
      request: vi.fn(async () => ({
        profiles: [profile(false, 7, { avatar: "ring/blue", revision: 3 })],
      })),
    })

    expect((await adapter.listAgents()).agents[0]).toMatchObject({
      summary: { avatar: "ring/blue" },
      avatarEditable: true,
      revision: "hermes-bots:7,aos:3",
    })
  })

  it("reads a stored avatar that is not token-shaped as no avatar", async () => {
    for (const avatar of ["Ring/Blue", "a/b/c", 42, { tone: "blue" }]) {
      const adapter = new HermesServerAdapter({
        request: vi.fn(async () => ({
          profiles: [profile(false, 7, { avatar, revision: 3 })],
        })),
      })

      const [agent] = (await adapter.listAgents()).agents
      expect(agent?.summary).not.toHaveProperty("avatar")
    }
  })

  it("refuses an update when the aos revision moved on", async () => {
    const request = vi.fn(async () => ({
      profiles: [profile(false, 7, { revision: 3 })],
    }))
    const adapter = new HermesServerAdapter({ request })

    await expect(
      adapter.updateAgent(
        "researcher",
        { avatar: "ring/blue" },
        "hermes-bots:7,aos:2"
      )
    ).rejects.toBeInstanceOf(HermesRevisionConflictError)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("hides an Agent and clears its avatar in one configure", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        profiles: [profile(false, 7, { avatar: "ring/blue", revision: 3 })],
      })
      .mockResolvedValueOnce({ applied: { ui_meta: true } })
      .mockResolvedValueOnce({
        profiles: [profile(true, 8, { revision: 4 })],
      })
    const adapter = new HermesServerAdapter({ request })

    const updated = await adapter.updateAgent(
      "researcher",
      { visibility: "hidden", avatar: null },
      "hermes-bots:7,aos:3"
    )

    expect(
      request.mock.calls.filter(([method]) => method === "profiles.configure")
    ).toEqual([
      [
        "profiles.configure",
        {
          name: "researcher",
          ui_meta: {
            "hermes-bots": { hidden: true, nativeOnly: "keep-server-side" },
            aos: { role: "agent", privatePath: "/srv/hermes/researcher" },
          },
          ui_meta_expected_revisions: { "hermes-bots": 7, aos: 3 },
        },
      ],
    ])
    expect(updated.agent).toMatchObject({
      visibility: "hidden",
      revision: "hermes-bots:8,aos:4",
    })
    expect(updated.agent.summary).not.toHaveProperty("avatar")
  })

  it("writes an avatar alone, keeping the other aos keys", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ profiles: [profile(false, 7, { revision: 3 })] })
      .mockResolvedValueOnce({ applied: { ui_meta: true } })
      .mockResolvedValueOnce({
        profiles: [profile(false, 7, { avatar: "dome/sage", revision: 4 })],
      })
    const adapter = new HermesServerAdapter({ request })

    const updated = await adapter.updateAgent(
      "researcher",
      { avatar: "dome/sage" },
      "hermes-bots:7,aos:3"
    )

    expect(
      request.mock.calls.filter(([method]) => method === "profiles.configure")
    ).toEqual([
      [
        "profiles.configure",
        {
          name: "researcher",
          ui_meta: {
            aos: {
              role: "agent",
              privatePath: "/srv/hermes/researcher",
              avatar: "dome/sage",
            },
          },
          ui_meta_expected_revisions: { aos: 3 },
        },
      ],
    ])
    expect(updated.agent.summary).toMatchObject({ avatar: "dome/sage" })
  })

  it("rejects a write the confirming reread does not show", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ profiles: [profile(false, 7, { revision: 3 })] })
      .mockResolvedValueOnce({ applied: { ui_meta: true } })
      .mockResolvedValueOnce({ profiles: [profile(false, 7, { revision: 4 })] })
    const adapter = new HermesServerAdapter({ request })

    await expect(
      adapter.updateAgent(
        "researcher",
        { avatar: "dome/sage" },
        "hermes-bots:7,aos:3"
      )
    ).rejects.toBeInstanceOf(HermesUnavailableError)
  })

  it("sends no native request for a malformed avatar reaching the adapter directly", async () => {
    const request = vi.fn(async () => ({ profiles: [profile(false, 7)] }))
    const adapter = new HermesServerAdapter({ request })

    for (const avatar of ["Not A Token", "ring", "ring/blue/extra", 7])
      await expect(
        adapter.updateAgent(
          "researcher",
          { avatar } as unknown as AgentUpdatePatch,
          "hermes-bots:7,aos:0"
        )
      ).rejects.toBeInstanceOf(ServerAgentUpdateUnsupportedError)
    expect(request).not.toHaveBeenCalled()
  })

  it("refuses an update aimed at the creator", async () => {
    const creator = {
      name: "aos-creator",
      ui_meta: { aos: { role: "creator" } },
      ui_meta_revisions: {},
    }
    const request = vi.fn(async () => ({ profiles: [creator] }))
    const adapter = new HermesServerAdapter({ request })

    expect((await adapter.listAgents()).agents[0]).toMatchObject({
      editable: false,
      avatarEditable: false,
    })
    await expect(
      adapter.updateAgent(
        "aos-creator",
        { avatar: "ring/blue" },
        "hermes-bots:0,aos:0"
      )
    ).rejects.toBeInstanceOf(HermesUnavailableError)
    expect(
      request.mock.calls.some(([method]) => method === "profiles.configure")
    ).toBe(false)
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
    await expect(unauthenticated.listAgents()).rejects.toBeInstanceOf(
      HermesAuthenticationError
    )
    await expect(unavailable.listAgents()).rejects.toBeInstanceOf(
      HermesUnavailableError
    )
  })

  it("rejects an oversized native live Session identity", async () => {
    const adapter = new HermesServerAdapter({
      request: vi.fn(async () => ({ session_id: "x".repeat(257) })),
    })

    await expect(
      adapter.native.resume({
        agentId: "researcher",
        providerSessionId: "stored",
        sessionId: "stored",
      })
    ).rejects.toBeInstanceOf(HermesUnavailableError)
  })

  it("resumes without a visible failure once Hermes settles a disconnect", async () => {
    let resumes = 0
    const router = rpcRouter({
      "session.resume": async () => {
        resumes += 1
        if (resumes < 3)
          throw new HermesRpcRejectedError(
            4009,
            "session disconnect interrupt settling"
          )
        return { session_id: "live-secret" }
      },
    })
    const wait = vi.fn(async () => undefined)
    const adapter = new HermesServerAdapter(router, {
      retry: { delaysMs: [0, 0, 0], wait },
    })

    await expect(
      adapter.native.resume({
        agentId: "researcher",
        providerSessionId: "stored",
        sessionId: "stored",
      })
    ).resolves.toMatchObject({ liveSessionId: "live-secret" })
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it.each([
    [4009, "session disconnect interrupt settling", 3],
    // A live record reaped between lookup and recheck: the Session still exists.
    [4007, "session no longer live; retry resume", 3],
    // Hermes' answer to malformed params, never to a missing Session.
    [-32602, "invalid params: expected an object", 1],
  ] as const)(
    "reports a resume refusal %s that is not a gone Session as unavailable",
    async (code, message, attempts) => {
      const router = rpcRouter({
        "session.resume": async () => {
          throw new HermesRpcRejectedError(code, message)
        },
      })
      const adapter = new HermesServerAdapter(router, {
        retry: { delaysMs: [0, 0], wait: async () => undefined },
      })

      await expect(
        adapter.native.resume({
          agentId: "researcher",
          providerSessionId: "stored",
          sessionId: "stored",
        })
      ).rejects.toBeInstanceOf(HermesUnavailableError)
      expect(router.calls("session.resume")).toHaveLength(attempts)
    }
  )

  it("reports a Session gone once its durable resume finds no record", async () => {
    let resumes = 0
    const router = rpcRouter({
      "session.resume": async () => {
        resumes += 1
        if (resumes > 1)
          throw new HermesRpcRejectedError(4007, "session not found")
        return { session_id: "live-first" }
      },
    })
    const adapter = new HermesServerAdapter(router)
    const scope = {
      agentId: "researcher",
      providerSessionId: "stored",
      sessionId: "stored",
    }
    await expect(adapter.native.resume(scope)).resolves.toMatchObject({
      liveSessionId: "live-first",
    })
    const signals: string[] = []
    await adapter.native.subscribeLive("live-first", (signal) =>
      signals.push(
        signal.kind === "lost" ? `lost:${signal.reason}` : signal.kind
      )
    )

    await router.connection.restored()

    expect(signals).toEqual(["lost:rebound"])
    const error = await adapter.turns
      .start(scope, { turnId: "run-1", messageId: "user", prompt: "Hello" })
      .catch((cause: unknown) => cause)
    expect(adapter.publicError(error)?.kind).toBe("gone")
  })

  it.each([
    [
      "its Session is gone",
      () => new HermesRpcRejectedError(4007, "session not found"),
      "gone",
    ],
    [
      "Hermes refuses the token",
      () => new HermesAuthenticationError(),
      "runtime_authentication_required",
    ],
  ])(
    "stops watching a Session's turns once %s",
    async (_case, refusal, kind) => {
      const clock = useFakeClock()
      const router = rpcRouter({
        "session.resume": async () => {
          throw refusal()
        },
      })
      const adapter = new HermesServerAdapter(router)
      const onError = vi.fn()
      const stop = adapter.turns.subscribeTurns(
        {
          agentId: "researcher",
          providerSessionId: "stored",
          sessionId: "stored",
        },
        { onTurn: vi.fn(), onError }
      )
      await clock.advance(60_000)

      expect(router.calls("session.resume")).toHaveLength(1)
      expect(onError).toHaveBeenCalledOnce()
      expect(adapter.publicError(onError.mock.calls[0]![0])?.kind).toBe(kind)
      stop()
    }
  )

  it("writes an attachment rebind failure to the runtime log", async () => {
    const logs = captureLogs()
    let resumes = 0
    const router = rpcRouter({
      "session.resume": async () => {
        resumes += 1
        if (resumes === 2) throw new HermesUnavailableError()
        return { session_id: "live-first" }
      },
    })
    const adapter = new HermesServerAdapter(router, { log: logs.logger })
    const scope = {
      agentId: "researcher",
      providerSessionId: "stored",
      sessionId: "stored",
    }
    await adapter.native.resume(scope)
    await adapter.native.subscribeLive("live-first", vi.fn())

    await router.connection.restored()

    expect(logs.records()).toContainEqual({
      level: "warn",
      message: "hermes.attachment.rebind_failed",
      fields: { reason: expect.any(String), attempt: 0 },
    })
  })

  it("publishes each native failure class under its own public kind", async () => {
    const adapter = new HermesServerAdapter({ request: vi.fn() })
    const kindOf = (cause: unknown) => adapter.publicError(cause)?.kind

    const refused = new HermesAuthenticationError()
    // The native error travels along, so a log still reads what failed.
    expect(adapter.publicError(refused)).toEqual({
      kind: "runtime_authentication_required",
      code: "runtime_authentication_required",
      cause: refused,
    })
    for (const cause of [
      new HermesAgentNotFoundError(),
      new HermesSessionNotFoundError(),
      new HermesWorkspaceScopeError(),
      new HermesContentScopeError(),
      new HermesContentUnreadableError(),
      new HermesInteractionPublicError("AOS_INTERACTION_NOT_FOUND"),
    ])
      expect(kindOf(cause)).toBe("gone")
    for (const cause of [
      new HermesRevisionConflictError(),
      new HermesSessionConflictError(),
    ])
      expect(kindOf(cause)).toBe("revision_conflict")
    // An unconfirmed Stop may have been accepted: the browser reconciles.
    expect(
      kindOf(
        new HermesTurnPublicError(
          "AOS_STOP_UNCERTAIN",
          "Stop was not confirmed."
        )
      )
    ).toBe("uncertain")
    for (const cause of [
      new HermesUnavailableError(),
      new HermesWorkspaceUnavailableError(),
      new HermesContentUnavailableError(),
      new HermesTurnPublicError(
        "AOS_PROVIDER_UNAVAILABLE",
        "Hermes is unavailable."
      ),
      new HermesInteractionPublicError("AOS_PROVIDER_UNAVAILABLE"),
    ])
      expect(kindOf(cause)).toBe("unavailable")
    expect(
      kindOf(new HermesInteractionPublicError("AOS_INVALID_INTERACTION"))
    ).toBe("invalid_request")
    expect(adapter.publicError(new Error("unclassified"))).toBeUndefined()
  })

  it.each([
    [
      "a model switch",
      "uncertain",
      (adapter: HermesServerAdapter) =>
        adapter.updateModel("researcher", "stored", {
          selectedId: '["native","large"]',
        }),
    ],
    [
      "an Agent update",
      "uncertain",
      (adapter: HermesServerAdapter) =>
        adapter.updateAgent(
          "researcher",
          { visibility: "hidden" },
          "hermes-bots:7,aos:0"
        ),
    ],
    [
      "a Session archive",
      "uncertain",
      (adapter: HermesServerAdapter) =>
        adapter.updateSession("researcher", "stored", { archived: true }),
    ],
    // A read changed nothing, so the same lost answer is only an outage.
    [
      "a model catalog read",
      "unavailable",
      (adapter: HermesServerAdapter) => adapter.models("researcher", "stored"),
    ],
  ] as const)(
    "classifies %s that lost its answer as %s",
    async (_case, kind, attempt) => {
      const adapter = new HermesServerAdapter({
        request: vi.fn(async (method: string) => {
          if (method === "session.resume")
            return { session_id: "live-secret", running: false }
          if (method === "profiles.list") return { profiles: [profile()] }
          // The frame went out and its outcome was lost.
          throw new HermesRpcUncertainError()
        }),
        // The real client, so the write reaches the fetcher before it fails.
        http: createHermesHttp({
          baseUrl: "http://hermes.test",
          credentials: async () => ({}),
          fetcher: vi.fn(
            async (_url: RequestInfo | URL, init?: RequestInit) => {
              if (init?.method === "PATCH") throw new TypeError("fetch failed")
              return Response.json({
                id: "stored",
                profile: "researcher",
                title: "Owned",
              })
            }
          ),
        }).http,
      })

      const failure = await attempt(adapter).catch((cause: unknown) => cause)
      expect(adapter.publicError(failure)?.kind).toBe(kind)
    }
  )

  it("closes an idle Session once no pending request retains it, but never an unsent draft", async () => {
    vi.useFakeTimers()
    try {
      let resumes = 0
      const router = rpcRouter({
        "session.resume": async (params) => {
          if (params.session_id === "draft")
            return {
              session_id: "live-draft",
              stored_session_id: "draft",
              message_count: 0,
              messages: [],
              info: { lazy: true, profile_name: "researcher" },
            }
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
        providerSessionId: "stored",
        sessionId: "stored",
        turnId: "run-1",
      }

      expect(await adapter.native.inspectExecution(scope)).toMatchObject({
        status: "waiting-for-input",
        requests: [
          {
            requestId: "srq-00000000000c",
            kind: PendingRequestKind.Permission,
          },
        ],
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
      // An unsent draft exists only in its live Session, so idling it out must
      // never close it natively.
      await adapter.native.inspectExecution({
        ...scope,
        providerSessionId: "draft",
        sessionId: "draft",
      })
      await vi.advanceTimersByTimeAsync(1_000)

      expect(router.calls("session.close").map(({ params }) => params)).toEqual(
        [{ session_id: "live-secret" }]
      )
    } finally {
      vi.useRealTimers()
    }
  })

  describe("retained failed turn", () => {
    const inflight = {
      user: "Summarize the filing",
      assistant: "I could not reach the model.",
      streaming: false,
      status: "error",
      recoverable: true,
      error:
        "AWS Bedrock did not answer after 3 attempts. Provider said: ValidationException at https://bedrock.internal/model/invoke?token=native-secret",
      error_surface: {
        layer: "provider",
        code: "validation_exception",
        retryable: true,
        provider: "bedrock",
        model: "sonnet",
      },
    }

    function failedTurnAdapter(
      rows: readonly unknown[],
      snapshot: Record<string, unknown> | undefined = inflight
    ) {
      const request = vi.fn(async (method: string) => {
        if (method === "session.resume")
          return {
            session_id: "live-secret",
            running: false,
            status: "idle",
            ...(snapshot ? { inflight: snapshot } : {}),
          }
        throw new Error(`unexpected ${method}`)
      })
      return {
        adapter: new HermesServerAdapter({
          request,
          http: ownedSessionHttp(rows),
        }),
        request,
      }
    }

    const unansweredPrompt = [
      {
        id: "user-1",
        role: "user",
        content: "Summarize the filing",
        timestamp: 1,
      },
    ]

    it("restores the failed turn Hermes kept out of its transcript", async () => {
      const { adapter } = failedTurnAdapter(unansweredPrompt)

      const history = await adapter.history("researcher", "stored", 200, 0)

      expect(history.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "I could not reach the model." }],
        status: {
          type: "incomplete",
          reason: "error",
          error:
            "Hermes' model provider returned an error for this turn. Retry, switch models with /model, or continue in a new Session.",
        },
        turnErrorCode: "AOS_PROVIDER_RETRYABLE_FAILURE",
      })
      // This retained cause names a credential and an internal host, so the
      // detail is dropped whole and the headline stands alone.
      const serialized = JSON.stringify(history)
      expect(serialized).not.toContain("AWS Bedrock")
      expect(serialized).not.toContain("native-secret")
      expect(serialized).not.toContain("ValidationException")
    })

    it("resumes once for a burst of history loads on the same Session", async () => {
      const { adapter, request } = failedTurnAdapter(unansweredPrompt)

      const [first, second] = await Promise.all([
        adapter.history("researcher", "stored", 200, 0),
        adapter.history("researcher", "stored", 200, 0),
      ])
      const third = await adapter.history("researcher", "stored", 200, 0)

      for (const history of [first, second, third])
        expect(history!.messages.at(-1)).toMatchObject({
          role: "assistant",
          status: { type: "incomplete", reason: "error" },
        })
      expect(
        request.mock.calls.filter(([method]) => method === "session.resume")
      ).toHaveLength(1)
    })

    it("never resumes a Session whose transcript ends with an answer", async () => {
      const { adapter, request } = failedTurnAdapter([
        ...unansweredPrompt,
        {
          id: "assistant-1",
          role: "assistant",
          content: "Here is the summary.",
          timestamp: 2,
        },
      ])

      const history = await adapter.history("researcher", "stored", 200, 0)

      expect(history.messages.at(-1)).toMatchObject({
        content: [{ type: "text", text: "Here is the summary." }],
      })
      expect(history.messages.at(-1)).not.toHaveProperty("status")
      expect(request).not.toHaveBeenCalled()
    })

    it("restores nothing for a retained turn belonging to another prompt", async () => {
      const { adapter, request } = failedTurnAdapter(unansweredPrompt, {
        ...inflight,
        user: "A different prompt",
      })

      const history = await adapter.history("researcher", "stored", 200, 0)

      expect(history.messages.map(({ role }) => role)).toEqual(["user"])
      expect(request).toHaveBeenCalled()
    })

    it("serves the authoritative transcript when Hermes cannot be resumed", async () => {
      const adapter = new HermesServerAdapter({
        request: vi.fn(async () => {
          throw new HermesHttpError(503)
        }),
        http: ownedSessionHttp(unansweredPrompt),
      })

      await expect(
        adapter.history("researcher", "stored", 200, 0)
      ).resolves.toMatchObject({ messages: [{ role: "user" }] })
    })
  })

  it("reports a missing Agent separately from a Hermes outage", async () => {
    const adapter = new HermesServerAdapter({
      request: vi.fn(async () => ({ profiles: [profile()] })),
    })
    await expect(
      adapter.updateAgent(
        "missing-agent",
        { visibility: "hidden" },
        "hermes-bots:7,aos:0"
      )
    ).rejects.toBeInstanceOf(HermesAgentNotFoundError)
  })
})
