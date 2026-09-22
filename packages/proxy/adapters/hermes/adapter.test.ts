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
  HermesContentUnreadableError,
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
    ...(revision === null
      ? {}
      : { ui_meta_revisions: { "hermes-bots": revision } }),
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

  it("refreshes the Session's reported model from its own writes and events", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "session.resume")
        return {
          session_id: "live-secret",
          running: false,
          info: { provider: "native", model: "small" },
        }
      if (method === "config.set")
        return { key: "model", scope: "session", value: "large" }
      if (method === "model.options")
        return {
          provider: "native",
          model: "small",
          providers: [
            { slug: "native", name: "Native", models: ["small", "large"] },
          ],
        }
      throw new Error(`unexpected ${method}`)
    })
    const http = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions/stored?"))
        return { id: "stored", profile: "researcher", title: "Owned" }
      throw new Error(`unexpected ${path}`)
    })
    const observers = new Set<(event: unknown) => void>()
    const deliver = (event: unknown) => {
      for (const observer of [...observers]) observer(event)
    }
    const adapter = new HermesServerAdapter({
      request,
      http,
      onEvent: vi.fn((next: (event: unknown) => void) => {
        observers.add(next)
        return () => observers.delete(next)
      }),
    })

    await adapter.subscribeSessionInvalidation("researcher", "stored", vi.fn())
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
    deliver({
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
        // The receipt shape a live Hermes `text_to_speech` writes: one absolute
        // delivery path repeated in `file_path`, `file_paths` and the `MEDIA:`
        // directive, alongside the delivery bookkeeping AOS ignores.
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
          delivery_profile: {
            platform: "default",
            max_file_bytes: 10_485_760,
            target_file_bytes: 8_912_896,
          },
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
    const request = vi.fn(async (method: string) => {
      if (method === "session.resume")
        return { session_id: "live-secret", running: false, status: "idle" }
      throw new Error(`unexpected ${method}`)
    })
    const http = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions/stored?"))
        return { id: "stored", profile: "researcher", title: "Owned" }
      if (path.includes("/messages?")) return { session_id: "stored", messages }
      if (path.startsWith("/api/fs/read-data-url?")) {
        if (path.includes(encodeURIComponent(audioPath))) throw audioFailure
        return { dataUrl: "data:text/markdown;base64,IyBCcmllZg==" }
      }
      throw new Error(`unexpected ${path}`)
    })
    const adapter = new HermesServerAdapter({ request, http })
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
    expect(adapter.publicError(unreadable)).toEqual({
      code: "not_found",
      status: 404,
    })
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
    expect(adapter.publicError(refused)).toEqual({
      code: "not_found",
      status: 404,
    })

    // A provider outage stays retryable: only a refusal of the file itself is
    // reported as the output being gone.
    audioFailure = new HermesHttpError(500)
    const outage = await adapter
      .artifact("researcher", "stored", mediaId.data.id)
      .then(() => undefined)
      .catch((error: unknown) => error)
    expect(outage).toBeInstanceOf(HermesContentUnavailableError)
    expect(adapter.publicError(outage)).toEqual({
      code: "temporarily_unavailable",
      status: 503,
    })
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

  it("reconciles interactions through a fresh resume that re-delivers what is still open", async () => {
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
    const http = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions/stored?"))
        return { id: "stored", profile: "researcher", title: "Owned" }
      throw new Error(`unexpected ${path}`)
    })
    const adapter = new HermesServerAdapter({ ...router, http })

    await adapter.pendingInteractions("researcher", "stored")
    const reconciled = await adapter.pendingInteractions("researcher", "stored")

    expect(router.calls("session.resume")).toHaveLength(2)
    expect(reconciled).toMatchObject({
      status: "waiting-for-input",
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "srq-00000000000c", reason: "question" }],
      },
    })
    expect(router.requests.refusal("srq-00000000000c")).toBeUndefined()
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

  it("projects the native derived read state per catalog row and omits it when absent", async () => {
    const adapter = new HermesServerAdapter({
      request: vi.fn(),
      http: vi.fn(async () => ({
        sessions: [
          { id: "stored/1", profile: "researcher", title: "One", unread: true },
          {
            id: "stored/2",
            profile: "researcher",
            title: "Two",
            unread: false,
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
    expect(Object.keys(page.sessions[2])).not.toContain("unread")
  })

  it("treats a non-boolean native read state as a malformed catalog payload", async () => {
    const adapter = new HermesServerAdapter({
      request: vi.fn(),
      http: vi.fn(async () => ({
        sessions: [
          { id: "stored/1", profile: "researcher", title: "One", unread: 1 },
        ],
        total: 1,
      })),
    })

    await expect(
      adapter.listSessions("researcher", 50, 0)
    ).rejects.toBeInstanceOf(HermesUnavailableError)
  })

  it("projects the native pin per catalog row and omits it when absent", async () => {
    const adapter = new HermesServerAdapter({
      request: vi.fn(),
      http: vi.fn(async () => ({
        sessions: [
          { id: "stored/1", profile: "researcher", title: "One", pinned: true },
          {
            id: "stored/2",
            profile: "researcher",
            title: "Two",
            pinned: false,
          },
          { id: "stored/3", profile: "researcher", title: "Three" },
        ],
        total: 3,
      })),
    })

    const page = await adapter.listSessions("researcher", 50, 0)

    expect(page.sessions.map((entry) => entry.pinned)).toEqual([
      true,
      false,
      undefined,
    ])
    expect(Object.keys(page.sessions[2])).not.toContain("pinned")
  })

  it("treats a non-boolean native pin as a malformed catalog payload", async () => {
    const adapter = new HermesServerAdapter({
      request: vi.fn(),
      http: vi.fn(async () => ({
        sessions: [
          { id: "stored/1", profile: "researcher", title: "One", pinned: 1 },
        ],
        total: 1,
      })),
    })

    await expect(
      adapter.listSessions("researcher", 50, 0)
    ).rejects.toBeInstanceOf(HermesUnavailableError)
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
        updatedAt: "1970-01-01T00:00:00.000Z",
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

  it("marks a Session read with the exact native profile-scoped patch body", async () => {
    const http = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions/stored%2F1?"))
        return { id: "stored/1", profile: "researcher", title: "One" }
      throw new Error(`unexpected ${path}`)
    })
    const adapter = new HermesServerAdapter({ request: vi.fn(), http })

    await adapter.mutateSession("researcher", "stored/1", "PATCH", {
      unread: false,
    })

    expect(http).toHaveBeenLastCalledWith(
      "/api/sessions/stored%2F1?profile=researcher",
      { method: "PATCH", body: { unread: false, profile: "researcher" } }
    )
  })

  it("pins a Session with the exact native profile-scoped patch body", async () => {
    const http = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sessions/stored%2F1?"))
        return { id: "stored/1", profile: "researcher", title: "One" }
      throw new Error(`unexpected ${path}`)
    })
    const adapter = new HermesServerAdapter({ request: vi.fn(), http })

    await adapter.mutateSession("researcher", "stored/1", "PATCH", {
      pinned: true,
    })

    expect(http).toHaveBeenLastCalledWith(
      "/api/sessions/stored%2F1?profile=researcher",
      { method: "PATCH", body: { pinned: true, profile: "researcher" } }
    )
  })

  it("declares the native pin available", async () => {
    const ready = new HermesServerAdapter({
      request: vi.fn(async () => ({ profiles: [profile()] })),
    })

    expect((await ready.runtimeInfo()).capabilities.sessionPin).toEqual({
      status: "available",
    })
  })

  it("declares native read state available and temporarily unavailable during an outage", async () => {
    const ready = new HermesServerAdapter({
      request: vi.fn(async () => ({ profiles: [profile()] })),
    })
    expect((await ready.runtimeInfo()).capabilities.sessionReadState).toEqual({
      status: "available",
    })

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
      onEvent: vi.fn((next: (event: unknown) => void) => {
        observers.add(next)
        return () => observers.delete(next)
      }),
    })

    const unsubscribe = await adapter.subscribeCatalogChanges(listener)
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
        "assistant-old",
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
      expect(history).toMatchObject({ nextOffset: 2, total: 3 })
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
          revision: "hermes-bots:7",
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
      revision: "hermes-bots:0",
    })

    const updated = await adapter.updateAgentVisibility(
      "default",
      "hidden",
      "hermes-bots:0"
    )

    expect(request.mock.calls[2]).toEqual([
      "profiles.configure",
      {
        name: "default",
        ui_meta: {
          "hermes-bots": { shape: "squircle", color: "#8b5cf6", hidden: true },
        },
        ui_meta_expected_revisions: { "hermes-bots": 0 },
      },
    ])
    expect(updated.agent).toMatchObject({
      visibility: "hidden",
      revision: "hermes-bots:1",
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

    const updated = await adapter.updateAgentVisibility(
      "researcher",
      "hidden",
      "hermes-bots:7"
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
      new HermesContentUnreadableError(),
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
      const http = vi.fn(async (path: string) => {
        if (path.startsWith("/api/sessions/stored?"))
          return { id: "stored", profile: "researcher", title: "Owned" }
        if (path.includes("/messages?"))
          return { session_id: "stored", messages: rows }
        throw new Error(`unexpected ${path}`)
      })
      return { adapter: new HermesServerAdapter({ request, http }), request }
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
        metadata: {
          custom: { aos: { runErrorCode: "AOS_PROVIDER_RETRYABLE_FAILURE" } },
        },
      })
      // This retained cause names a credential and an internal host, so the
      // detail is dropped whole and the headline stands alone.
      const serialized = JSON.stringify(history)
      expect(serialized).not.toContain("AWS Bedrock")
      expect(serialized).not.toContain("native-secret")
      expect(serialized).not.toContain("ValidationException")
    })

    it("carries the bounded native cause of a restored failed turn", async () => {
      const { adapter } = failedTurnAdapter(unansweredPrompt, {
        ...inflight,
        error:
          "An error occurred (ValidationException) when calling the InvokeModel operation",
      })

      const history = await adapter.history("researcher", "stored", 200, 0)

      expect(history.messages.at(-1)).toMatchObject({
        role: "assistant",
        status: {
          type: "incomplete",
          reason: "error",
          error:
            "Hermes' model provider returned an error for this turn. Retry, switch models with /model, or continue in a new Session.\nAn error occurred (ValidationException) when calling the InvokeModel operation",
        },
        metadata: {
          custom: { aos: { runErrorCode: "AOS_PROVIDER_RETRYABLE_FAILURE" } },
        },
      })
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

    it("truncates an oversized retained turn instead of failing the load", async () => {
      const { adapter } = failedTurnAdapter(unansweredPrompt, {
        ...inflight,
        // Inside the native byte bound, past the protocol's character bound.
        assistant: "a".repeat(1_048_000),
      })

      const history = await adapter.history("researcher", "stored", 200, 0)

      expect(history.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "a".repeat(1_000_000) }],
        status: { type: "incomplete", reason: "error" },
      })
    })

    it("restores nothing while Hermes is still streaming the retained turn", async () => {
      const { adapter } = failedTurnAdapter(unansweredPrompt, {
        ...inflight,
        streaming: true,
      })

      const history = await adapter.history("researcher", "stored", 200, 0)

      expect(history.messages.map(({ role }) => role)).toEqual(["user"])
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
        id: "assistant-1",
        role: "assistant",
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
      const http = vi.fn(async (path: string) => {
        if (path.startsWith("/api/sessions/stored?"))
          return { id: "stored", profile: "researcher", title: "Owned" }
        if (path.includes("/messages?"))
          return { session_id: "stored", messages: unansweredPrompt }
        throw new Error(`unexpected ${path}`)
      })
      const adapter = new HermesServerAdapter({
        request: vi.fn(async () => {
          throw new HermesHttpError(503)
        }),
        http,
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
      adapter.updateAgentVisibility("missing-agent", "hidden", "hermes-bots:7")
    ).rejects.toBeInstanceOf(HermesAgentNotFoundError)
  })
})
