import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, render, waitFor } from "@testing-library/react"
import {
  AssistantRuntimeProvider,
  type AppendMessage,
  type ThreadUserMessagePart,
} from "@assistant-ui/react"
import { useHermesRuntimeBundle } from "./use-hermes-runtime-bundle"
import { useHermesComposerFeatures } from "./use-hermes-composer-features"

import {
  HermesNativeClient,
  encodeHermesThreadId,
  type HermesWebSocket,
  type HermesNativeClientOptions,
} from "./hermes-native-client"
import { createHermesWorkspace } from "./hermes-workspace"
import { agentStatusFromSessions } from "@/lib/workspace-view-model"

type Listener = (event: Event | MessageEvent) => void

class RpcFailure {
  constructor(readonly message: string) {}
}

class DeferredRpc {
  readonly promise: Promise<unknown>
  resolve!: (value: unknown) => void

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve
    })
  }
}

class FakeSocket implements HermesWebSocket {
  readyState = 0
  readonly requests: Array<Record<string, unknown>> = []
  readonly listeners = new Map<string, Set<Listener>>()

  constructor(
    readonly url: string,
    readonly protocols: string[],
    private readonly reply: (request: Record<string, unknown>) => unknown
  ) {
    queueMicrotask(() => {
      this.readyState = 1
      this.emit("open", new Event("open"))
    })
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback =
      typeof listener === "function"
        ? (listener as Listener)
        : (event: Event) => listener.handleEvent(event)
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(callback)
    this.listeners.set(type, listeners)
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject
  ) {
    this.listeners.get(type)?.delete(listener as Listener)
  }

  send(raw: string) {
    const request = JSON.parse(raw) as Record<string, unknown>
    this.requests.push(request)
    const result = this.reply(request)
    const respond = (value: unknown) =>
      this.message(
        value instanceof RpcFailure
          ? {
              jsonrpc: "2.0",
              id: request.id,
              error: { code: 5000, message: value.message },
            }
          : { jsonrpc: "2.0", id: request.id, result: value }
      )
    if (result instanceof DeferredRpc) void result.promise.then(respond)
    else queueMicrotask(() => respond(result))
  }

  close() {
    this.readyState = 3
  }

  message(frame: unknown) {
    this.emit(
      "message",
      new MessageEvent("message", { data: JSON.stringify(frame) })
    )
  }

  disconnect() {
    this.readyState = 3
    this.emit("close", new Event("close"))
  }

  private emit(type: string, event: Event | MessageEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function harness({
  autoContinue = false,
  duplicateSession = false,
  promptError = false,
  truncateReplay = false,
  wrongOwner = false,
  reconnectTicketFailures = 0,
  visibilityConflict = false,
  approvalDeferred,
  endedAt,
  liveStatus = "idle",
  activeReply,
  sameSessionIdAcrossProfiles = false,
  profileActivity = {},
  history,
  rpcReply,
}: {
  activeReply?: DeferredRpc | RpcFailure
  profileActivity?: Record<string, unknown>
  history?: unknown[]
  rpcReply?: (request: Record<string, unknown>) => unknown
  sameSessionIdAcrossProfiles?: boolean
  endedAt?: number
  liveStatus?: string
  autoContinue?: boolean | null | "inaccessible"
  duplicateSession?: boolean
  promptError?: boolean
  truncateReplay?: boolean
  wrongOwner?: boolean
  reconnectTicketFailures?: number
  visibilityConflict?: boolean
  approvalDeferred?: DeferredRpc
} = {}) {
  const sockets: FakeSocket[] = []
  let tickets = 0
  let historyFetches = 0
  let researchHidden = false
  let researchRevision = 3
  let activeStatus = liveStatus
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input), "http://aos.test")
    if (
      url.pathname === "/hermes/api/auth/ws-ticket" &&
      tickets > 0 &&
      reconnectTicketFailures-- > 0
    )
      return new Response(null, { status: 503 })
    if (url.pathname === "/hermes/api/auth/ws-ticket")
      return Response.json({ ticket: `ticket-${++tickets}`, ttl_seconds: 30 })
    if (url.pathname === "/hermes/api/config") {
      if (autoContinue === "inaccessible")
        return new Response(null, { status: 403 })
      return Response.json(
        autoContinue === null
          ? { desktop: {} }
          : { desktop: { auto_continue: { enabled: autoContinue } } }
      )
    }
    if (url.pathname === "/hermes/api/sessions")
      return Response.json({
        sessions:
          url.searchParams.get("profile") === "research" ||
          sameSessionIdAcrossProfiles
            ? Array.from({ length: duplicateSession ? 2 : 1 }, () => ({
                id: "stored-1",
                profile: wrongOwner
                  ? "creator"
                  : url.searchParams.get("profile"),
                title: "Native history",
                last_active: 1_788_000_000,
                ended_at: endedAt,
              }))
            : [],
        total:
          url.searchParams.get("profile") === "research" ||
          sameSessionIdAcrossProfiles
            ? duplicateSession
              ? 2
              : 1
            : 0,
        limit: 100,
        offset: 0,
      })
    if (url.pathname.endsWith("/messages")) {
      historyFetches++
      return Response.json({
        session_id: "stored-1",
        messages: history ?? [
          { id: "u1", role: "user", content: "Hello" },
          {
            id: "a1",
            role: "assistant",
            content: "Working",
            tool_calls: [
              {
                id: "t1",
                function: {
                  name: "present_plan",
                  arguments: '{"title":"Exact"}',
                },
              },
            ],
          },
          {
            id: "r1",
            role: "tool",
            tool_call_id: "t1",
            content: '{"ok":true}',
          },
        ],
        pagination: { returned: 3 },
      })
    }
    return new Response(null, { status: 404 })
  })
  const reply = (request: Record<string, unknown>) => {
    const override = rpcReply?.(request)
    if (override !== undefined) return override
    switch (request.method) {
      case "session.active_list":
        return (
          activeReply ?? {
            sessions: [
              { id: "live-1", session_key: "stored-1", status: activeStatus },
            ],
          }
        )
      case "profiles.list":
        return {
          profiles: [
            {
              name: "research",
              display_name: "Research",
              description: "Native profile",
              ...profileActivity,
              ui_meta: {
                "hermes-bots": { hidden: researchHidden, accent: "violet" },
                foreign: { preserved: true },
              },
              ui_meta_revisions: { "hermes-bots": researchRevision },
            },
            {
              name: "creator",
              display_name: "Creator",
              ui_meta: {
                "hermes-bots": { hidden: true },
                aos: { role: "creator" },
              },
            },
          ],
        }
      case "session.resume":
        return {
          session_id: "live-1",
          resumed: "stored-1",
          running: false,
          status: "idle",
          messages: [],
        }
      case "profiles.describe":
        return { name: "research", description: "Native profile" }
      case "profiles.configure": {
        if (visibilityConflict)
          return {
            ok: false,
            applied: {
              ui_meta: false,
              ui_meta_conflicts: {
                "hermes-bots": { expected: 3, actual: 4 },
              },
              ui_meta_revisions: { "hermes-bots": 4 },
            },
          }
        const params = request.params as {
          ui_meta: { "hermes-bots": { hidden: boolean } }
        }
        researchHidden = params.ui_meta["hermes-bots"].hidden
        researchRevision++
        return {
          ok: true,
          applied: {
            ui_meta: true,
            ui_meta_revisions: { "hermes-bots": researchRevision },
          },
        }
      }
      case "prompt.submit":
        return promptError
          ? new RpcFailure("provider outcome uncertain")
          : { status: "streaming" }
      case "session.events.since":
        return { events: [], truncated: truncateReplay, epoch: "epoch-1" }
      case "approval.respond":
        return approvalDeferred ?? { resolved: true }
      case "session.interrupt":
        return { status: "interrupted" }
      default:
        throw new Error(`Unexpected RPC: ${String(request.method)}`)
    }
  }
  const options: HermesNativeClientOptions = {
    baseUrl: "/hermes",
    fetcher,
    reconnectDelayMs: 0,
    socketFactory(url, protocols) {
      const socket = new FakeSocket(url, protocols, reply)
      sockets.push(socket)
      return socket
    },
  }
  const client = new HermesNativeClient(options)
  return {
    client,
    options,
    fetcher,
    sockets,
    setLiveStatus: (status: string) => {
      activeStatus = status
    },
    get historyFetches() {
      return historyFetches
    },
  }
}

describe("Hermes native browser client", () => {
  it.each(["send", "reconnect"])(
    "composer retains partial staging cleanup after detach fails and retries on %s before the next image send",
    async (retry) => {
      const staged = new Set<string>()
      const consumed: string[][] = []
      let images = 0
      let detaches = 0
      const state = harness({
        rpcReply: ({ method, params }) => {
          if (method === "image.attach_bytes") {
            const path = `/images/${++images}.png`
            staged.add(path)
            return { attached: true, path, count: staged.size }
          }
          if (method === "file.attach")
            return new RpcFailure("native file rejected")
          if (method === "image.detach") {
            if (++detaches === 1) return new RpcFailure("detach unavailable")
            const { path } = params as { path: string }
            staged.delete(path)
            return { detached: true, count: staged.size }
          }
          if (method === "prompt.submit") {
            consumed.push([...staged])
            staged.clear()
            return { status: "streaming" }
          }
        },
      })
      const { client, sockets } = state
      const recovered = vi.fn()
      const message: AppendMessage = {
        role: "user",
        content: [
          { type: "image", image: "data:image/png;base64,YQ==" },
          { type: "file", data: "aGk=", mimeType: "text/plain" },
        ],
        sourceId: null,
        parentId: null,
        attachments: [],
        metadata: { custom: {} },
        runConfig: {},
        createdAt: new Date(),
      }
      try {
        await client.start()
        client.subscribeRecovery(recovered)
        const threadId = encodeHermesThreadId("research", "stored-1")
        const failure = await client
          .submit(threadId, message)
          .catch((reason: unknown) => reason)
        expect(failure).toBeInstanceOf(Error)
        expect(consumed).toEqual([])
        expect(staged).toEqual(new Set(["/images/1.png"]))
        if (retry === "reconnect") {
          sockets[0].disconnect()
          await vi.waitFor(() => expect(recovered).toHaveBeenCalledTimes(1))
        }
        await client.submit(threadId, {
          ...message,
          content: [{ type: "image", image: "data:image/png;base64,Yg==" }],
        })
        expect(consumed).toEqual([["/images/2.png"]])
        expect(
          sockets
            .flatMap(({ requests }) => requests)
            .filter(
              ({ method }) =>
                typeof method === "string" &&
                (method.startsWith("image.") ||
                  method === "file.attach" ||
                  method === "prompt.submit")
            )
            .map(({ method }) => method)
        ).toEqual([
          "image.attach_bytes",
          "file.attach",
          "image.detach",
          "image.detach",
          "image.attach_bytes",
          "prompt.submit",
        ])
        expect(failure).toMatchObject({
          message: expect.stringContaining("native file rejected"),
        })
        expect(failure).toMatchObject({
          message: expect.stringContaining("detach unavailable"),
        })
        expect(state.historyFetches).toBe(0)
      } finally {
        client.stop()
      }
    }
  )

  it("composer reconciles durable history and sends again while optional native usage keeps failing", async () => {
    let unavailable = false
    const state = harness({
      history: [{ id: 1, role: "user", content: "First" }],
      rpcReply: ({ method }) =>
        method === "session.usage"
          ? unavailable
            ? new RpcFailure("usage unavailable")
            : {
                context_used: 10,
                context_max: 100,
                context_source: "provider_usage",
                context_estimated: false,
              }
          : undefined,
    })
    const { client, sockets } = state
    const onError = vi.fn()
    client.subscribeCatalog(() => undefined, onError)
    const message: AppendMessage = {
      role: "user",
      content: [{ type: "text", text: "First" }],
      sourceId: null,
      parentId: null,
      attachments: [],
      metadata: { custom: {} },
      runConfig: {},
      createdAt: new Date(),
    }
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.attach(threadId)
      await client.refreshComposer(threadId, {
        modelSelectorEnabled: false,
        contextEnabled: true,
      })
      await client.submit(threadId, message)
      unavailable = true
      sockets[0].message({
        method: "event",
        params: {
          type: "message.complete",
          session_id: "live-1",
          seq: 1,
          payload: { status: "complete" },
        },
      })
      await vi.waitFor(() =>
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({ message: "usage unavailable" })
        )
      )
      expect(client.session(threadId)?.composer?.context).toBeUndefined()
      expect(client.session(threadId)?.messages[0].id).toBe("hermes-row-1")
      await expect(
        client.submit(threadId, {
          ...message,
          content: [{ type: "text", text: "Next" }],
        })
      ).resolves.toBeUndefined()
      expect(state.historyFetches).toBe(1)
      expect(
        sockets[0].requests.filter(({ method }) => method === "prompt.submit")
      ).toHaveLength(2)
    } finally {
      client.stop()
    }
  })

  it("composer deduplicates idle confirmations and ignores a late result for a retired turn", async () => {
    const confirmed = new DeferredRpc()
    const state = harness({
      history: [],
      rpcReply: ({ method }) => {
        if (method === "session.active_list") return confirmed
        if (method === "image.attach_bytes")
          return { attached: true, path: "/images/pending.png", count: 1 }
        if (method === "image.detach") return { detached: true, count: 0 }
      },
    })
    const { client, sockets } = state
    const message: AppendMessage = {
      role: "user",
      content: [
        { type: "text", text: "Caption" },
        { type: "image", image: "data:image/png;base64,YQ==" },
      ],
      sourceId: null,
      parentId: null,
      attachments: [],
      metadata: { custom: {} },
      runConfig: {},
      createdAt: new Date(),
    }
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.submit(threadId, message)
      for (const seq of [1, 2])
        sockets[0].message({
          method: "event",
          params: {
            type: "session.info",
            session_id: "live-1",
            seq,
            payload: { running: false },
          },
        })
      expect(
        sockets[0].requests.filter(
          ({ method }) => method === "session.active_list"
        )
      ).toHaveLength(1)
      sockets[0].message({
        method: "event",
        params: {
          type: "message.complete",
          session_id: "live-1",
          seq: 3,
          payload: { status: "complete" },
        },
      })
      const next = client.submit(threadId, message)
      void next.catch(() => undefined)
      await vi.waitFor(() =>
        expect(
          sockets[0].requests.filter(({ method }) => method === "prompt.submit")
        ).toHaveLength(2)
      )
      await next
      const historyReads = state.historyFetches
      await act(async () =>
        confirmed.resolve({
          sessions: [{ id: "live-1", session_key: "stored-1", status: "idle" }],
        })
      )
      expect(
        sockets[0].requests.filter(({ method }) => method === "image.detach")
      ).toHaveLength(0)
      expect(state.historyFetches).toBe(historyReads)
      expect(client.session(threadId)?.running).toBe(true)
      expect(client.session(threadId)?.messages).toHaveLength(1)
    } finally {
      confirmed.resolve({ sessions: [] })
      client.stop()
    }
  })

  it("composer confirms trailing old idle events cannot detach a newer active image turn", async () => {
    const state = harness({
      history: [],
      rpcReply: ({ method }) => {
        if (method === "image.attach_bytes")
          return { attached: true, path: "/images/pending.png", count: 1 }
        if (method === "image.detach") return { detached: true, count: 0 }
      },
    })
    const { client, sockets } = state
    const message: AppendMessage = {
      role: "user",
      content: [
        { type: "text", text: "Caption" },
        { type: "image", image: "data:image/png;base64,YQ==" },
      ],
      sourceId: null,
      parentId: null,
      attachments: [],
      metadata: { custom: {} },
      runConfig: {},
      createdAt: new Date(),
    }
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.submit(threadId, message)
      sockets[0].message({
        method: "event",
        params: {
          type: "message.complete",
          session_id: "live-1",
          seq: 1,
          payload: { status: "complete" },
        },
      })
      await client.submit(threadId, message)
      state.setLiveStatus("working")
      const historyReads = state.historyFetches
      sockets[0].message({
        method: "event",
        params: {
          type: "session.info",
          session_id: "live-1",
          seq: 2,
          payload: { running: false },
        },
      })
      await vi.waitFor(() =>
        expect(
          sockets[0].requests.filter(
            ({ method }) => method === "session.active_list"
          )
        ).toHaveLength(1)
      )
      expect(
        sockets[0].requests.filter(({ method }) => method === "image.detach")
      ).toHaveLength(0)
      expect(state.historyFetches).toBe(historyReads)
      expect(client.session(threadId)?.running).toBe(true)
      expect(client.session(threadId)?.messages).toHaveLength(1)
      expect(
        sockets[0].requests.filter(({ method }) => method === "prompt.submit")
      ).toHaveLength(2)
    } finally {
      client.stop()
    }
  })

  it("composer does not let a late idle resume reconcile a newer staged turn", async () => {
    const resumed = new DeferredRpc()
    let resumes = 0
    const { client, sockets } = harness({
      history: [],
      rpcReply: ({ method }) => {
        if (method === "session.resume" && ++resumes === 2) return resumed
        if (method === "image.attach_bytes")
          return { attached: true, path: "/images/pending.png", count: 1 }
        if (method === "image.detach") return { detached: true, count: 0 }
      },
    })
    const message: AppendMessage = {
      role: "user",
      content: [
        { type: "text", text: "Caption" },
        { type: "image", image: "data:image/png;base64,YQ==" },
      ],
      sourceId: null,
      parentId: null,
      attachments: [],
      metadata: { custom: {} },
      runConfig: {},
      createdAt: new Date(),
    }
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.submit(threadId, message)
      const pendingResume = client.attach(threadId)
      sockets[0].message({
        method: "event",
        params: {
          type: "message.complete",
          session_id: "live-1",
          seq: 1,
          payload: { status: "complete" },
        },
      })
      await client.submit(threadId, message)
      resumed.resolve({
        session_id: "live-1",
        resumed: "stored-1",
        running: false,
        status: "idle",
      })
      await pendingResume
      expect(
        sockets[0].requests.filter(({ method }) => method === "image.detach")
      ).toHaveLength(0)
      expect(client.session(threadId)?.running).toBe(true)
      expect(client.session(threadId)?.messages).toHaveLength(1)
      expect(
        sockets[0].requests.filter(({ method }) => method === "prompt.submit")
      ).toHaveLength(2)
    } finally {
      resumed.resolve({ session_id: "live-1", running: false, status: "idle" })
      client.stop()
    }
  })

  it.each(["event", "replay"])(
    "composer waits for dropped-terminal idle session.info recovery from %s",
    async (source) => {
      const detached = new DeferredRpc()
      const idle = {
        type: "session.info",
        session_id: "live-1",
        seq: 2,
        payload: { running: false },
      }
      const { client, sockets } = harness({
        history: [],
        rpcReply: ({ method }) => {
          if (method === "image.attach_bytes")
            return { attached: true, path: "/images/pending.png", count: 1 }
          if (method === "image.detach") return detached
          if (method === "session.events.since")
            return { events: [idle], epoch: "epoch-1" }
        },
      })
      const message: AppendMessage = {
        role: "user",
        content: [
          { type: "text", text: "Lost terminal" },
          { type: "image", image: "data:image/png;base64,YQ==" },
        ],
        sourceId: null,
        parentId: null,
        attachments: [],
        metadata: { custom: {} },
        runConfig: {},
        createdAt: new Date(),
      }
      try {
        await client.start()
        const threadId = encodeHermesThreadId("research", "stored-1")
        await client.submit(threadId, message)
        sockets[0].message({
          method: "event",
          params: {
            type: "message.start",
            session_id: "live-1",
            seq: 1,
            payload: {},
          },
        })
        if (source === "event")
          sockets[0].message({ method: "event", params: idle })
        else sockets[0].disconnect()
        await vi.waitFor(() =>
          expect(
            sockets
              .flatMap(({ requests }) => requests)
              .some(({ method }) => method === "image.detach")
          ).toBe(true)
        )
        const next = client.submit(threadId, message)
        void next.catch(() => undefined)
        expect(
          sockets
            .flatMap(({ requests }) => requests)
            .filter(({ method }) => method === "image.attach_bytes")
        ).toHaveLength(1)
        detached.resolve({ detached: true, count: 0 })
        await next
        expect(
          sockets
            .flatMap(({ requests }) => requests)
            .filter(({ method }) => method === "prompt.submit")
        ).toHaveLength(2)
        expect(client.session(threadId)?.messages).toHaveLength(1)
      } finally {
        detached.resolve({ detached: true, count: 0 })
        client.stop()
      }
    }
  )

  it.each([
    { failure: "detach", terminal: "error", retry: "send" },
    { failure: "history", terminal: "error", retry: "send" },
    { failure: "context", terminal: "error", retry: "send" },
    { failure: "history", terminal: "complete", retry: "send" },
    { failure: "detach", terminal: "error", retry: "reconnect" },
    { failure: "history", terminal: "error", retry: "reconnect" },
    { failure: "context", terminal: "error", retry: "reconnect" },
    { failure: "history", terminal: "complete", retry: "reconnect" },
  ])(
    "composer handles $failure failure after terminal $terminal on $retry without resubmission",
    async ({ failure, terminal, retry }) => {
      let detachAttempts = 0
      let usageAttempts = 0
      const { client, sockets, fetcher } = harness({
        history: [],
        rpcReply: ({ method }) => {
          if (method === "image.attach_bytes")
            return { attached: true, path: "/images/pending.png", count: 1 }
          if (method === "image.detach") {
            if (++detachAttempts === 1 && failure === "detach")
              return new RpcFailure("detach unavailable")
            return { detached: true, count: 0 }
          }
          if (method === "session.usage") {
            if (++usageAttempts === 2 && failure === "context")
              return new RpcFailure("usage unavailable")
            return {
              context_used: 10,
              context_max: 100,
              context_source: "provider_usage",
              context_estimated: false,
            }
          }
        },
      })
      const onError = vi.fn()
      const recovered = vi.fn()
      client.subscribeCatalog(() => undefined, onError)
      const message: AppendMessage = {
        role: "user",
        content: [
          { type: "text", text: "Accepted" },
          { type: "image", image: "data:image/png;base64,YQ==" },
        ],
        sourceId: null,
        parentId: null,
        attachments: [],
        metadata: { custom: {} },
        runConfig: {},
        createdAt: new Date(),
      }
      try {
        await client.start()
        client.subscribeRecovery(recovered)
        const threadId = encodeHermesThreadId("research", "stored-1")
        await client.attach(threadId)
        if (failure === "context")
          await client.refreshComposer(threadId, {
            modelSelectorEnabled: false,
            contextEnabled: true,
          })
        await client.submit(threadId, message)
        if (failure === "history")
          fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }))
        sockets[0].message({
          method: "event",
          params: {
            type: "message.complete",
            session_id: "live-1",
            seq: 10,
            payload: { status: terminal },
          },
        })
        await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
        if (retry === "reconnect") {
          sockets[0].disconnect()
          await vi.waitFor(() => expect(recovered).toHaveBeenCalledTimes(1))
        }
        await client.submit(threadId, {
          ...message,
          content: [{ type: "text", text: "Next" }],
        })
        expect(detachAttempts).toBe(
          terminal === "complete" ? 0 : failure === "detach" ? 2 : 1
        )
        expect(client.session(threadId)?.messages).toHaveLength(1)
        expect(client.session(threadId)?.messages[0].content).toBe("Next")
        expect(
          sockets
            .flatMap(({ requests }) => requests)
            .filter(({ method }) => method === "prompt.submit")
        ).toHaveLength(2)
        expect(onError).toHaveBeenCalledTimes(1)
      } finally {
        client.stop()
      }
    }
  )

  it.each([false, true])(
    "composer recovers a dropped terminal on idle resume before the next send (image=%s)",
    async (image) => {
      const state = harness({
        history: [],
        rpcReply: ({ method }) => {
          if (method === "image.attach_bytes")
            return { attached: true, path: "/images/pending.png", count: 1 }
          if (method === "image.detach") return { detached: true, count: 0 }
        },
      })
      const { client, sockets } = state
      const message: AppendMessage = {
        role: "user",
        content: [
          { type: "text", text: "Lost terminal" },
          ...(image
            ? [{ type: "image" as const, image: "data:image/png;base64,YQ==" }]
            : []),
        ],
        sourceId: null,
        parentId: null,
        attachments: [],
        metadata: { custom: {} },
        runConfig: {},
        createdAt: new Date(),
      }
      try {
        await client.start()
        const threadId = encodeHermesThreadId("research", "stored-1")
        await client.submit(threadId, message)
        sockets[0].disconnect()
        await vi.waitFor(() => expect(sockets).toHaveLength(2))
        await vi.waitFor(() => expect(state.historyFetches).toBeGreaterThan(0))
        await vi.waitFor(() =>
          expect(client.session(threadId)?.messages).toEqual([])
        )
        await client.submit(threadId, {
          ...message,
          content: [{ type: "text", text: "Next" }],
        })
        const requests = sockets.flatMap(({ requests }) => requests)
        expect(
          requests.filter(({ method }) => method === "image.detach")
        ).toEqual(
          image
            ? [
                expect.objectContaining({
                  params: { session_id: "live-1", path: "/images/pending.png" },
                }),
              ]
            : []
        )
        expect(
          requests.filter(({ method }) => method === "prompt.submit")
        ).toHaveLength(2)
        expect(client.session(threadId)?.messages).toHaveLength(1)
        expect(client.session(threadId)?.storedSessionId).toBe("stored-1")
      } finally {
        client.stop()
      }
    }
  )

  it("composer waits for old terminal cleanup before staging a new turn and ignores its replay", async () => {
    const detached = new DeferredRpc()
    const { client, sockets } = harness({
      history: [
        {
          id: 52,
          role: "user",
          content: "Original\n@image:/images/original.png",
        },
      ],
      rpcReply: ({ method }) => {
        if (method === "image.attach" || method === "image.attach_bytes")
          return { attached: true, path: "/images/original.png", count: 1 }
        if (method === "image.detach") return detached
      },
    })
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.loadHistory(threadId)
      await client.edit(threadId, {
        role: "user",
        content: [{ type: "text", text: "Revised" }],
        sourceId: "hermes-row-52",
        parentId: null,
        attachments: [],
        metadata: { custom: {} },
        runConfig: {},
        createdAt: new Date(),
      })
      const terminal = {
        method: "event",
        params: {
          type: "error",
          session_id: "live-1",
          seq: 10,
          payload: { message: "agent initialization failed" },
        },
      }
      sockets[0].message(terminal)
      const second = client.submit(threadId, {
        role: "user",
        content: [
          { type: "text", text: "Next" },
          { type: "image", image: "data:image/png;base64,Yg==" },
        ],
        sourceId: null,
        parentId: null,
        attachments: [],
        metadata: { custom: {} },
        runConfig: {},
        createdAt: new Date(),
      })
      void second.catch(() => undefined)
      await vi.waitFor(() =>
        expect(
          sockets[0].requests.some(({ method }) => method === "image.detach")
        ).toBe(true)
      )
      expect(
        sockets[0].requests.filter(
          ({ method }) => method === "image.attach_bytes"
        )
      ).toHaveLength(0)
      detached.resolve({ detached: true, count: 0 })
      await second
      sockets[0].message(terminal)
      expect(client.session(threadId)?.messages.at(-1)).toMatchObject({
        content: [
          { type: "text", text: "Next" },
          { type: "image", image: "data:image/png;base64,Yg==" },
        ],
      })
      expect(client.session(threadId)?.running).toBe(true)
      sockets[0].message({
        method: "event",
        params: {
          type: "message.complete",
          session_id: "live-1",
          seq: 11,
          payload: { status: "complete", text: "Done" },
        },
      })
      await vi.waitFor(() =>
        expect(client.session(threadId)?.loading).toBe(false)
      )
      expect(
        sockets[0].requests.filter(({ method }) => method === "image.detach")
      ).toHaveLength(1)
      expect(
        sockets[0].requests.filter(({ method }) => method === "prompt.submit")
      ).toHaveLength(2)
    } finally {
      detached.resolve({ detached: true, count: 0 })
      client.stop()
    }
  })

  it.each([
    {
      type: "message.complete",
      payload: {
        status: "error",
        error: "agent initialization failed",
        text: "Error: agent initialization failed",
      },
    },
    {
      type: "error",
      payload: {
        message: "Session no longer running before the agent was ready",
      },
    },
  ])(
    "composer accepted edit reconciles history and detaches images on native terminal $type",
    async ({ type, payload }) => {
      const history: unknown[] = [
        {
          id: 52,
          role: "user",
          content: [
            { type: "text", text: "Original\n@image:/images/original.png" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,YQ==" },
            },
          ],
        },
      ]
      const { client, sockets } = harness({
        history,
        rpcReply: ({ method }) => {
          if (method === "image.attach")
            return { attached: true, path: "/images/original.png", count: 1 }
          if (method === "image.detach") return { detached: true, count: 0 }
          if (method === "prompt.submit") {
            // Native truncation is durable before the deferred agent build.
            history.length = 0
            return { status: "streaming" }
          }
        },
      })
      try {
        await client.start()
        const threadId = encodeHermesThreadId("research", "stored-1")
        await client.loadHistory(threadId)
        await client.edit(threadId, {
          role: "user",
          content: [{ type: "text", text: "Revised" }],
          sourceId: "hermes-row-52",
          parentId: null,
          attachments: [],
          metadata: { custom: {} },
          runConfig: {},
          createdAt: new Date(),
        })
        sockets[0].message({
          method: "event",
          params: { type, session_id: "live-1", seq: 10, payload },
        })
        await vi.waitFor(() =>
          expect(sockets[0].requests).toContainEqual(
            expect.objectContaining({
              method: "image.detach",
              params: { session_id: "live-1", path: "/images/original.png" },
            })
          )
        )
        await vi.waitFor(() =>
          expect(client.session(threadId)?.messages).toEqual([])
        )
        expect(client.session(threadId)?.status).toBe("failed")
        expect(
          sockets[0].requests.filter(({ method }) => method === "prompt.submit")
        ).toHaveLength(1)
      } finally {
        client.stop()
      }
    }
  )

  it("composer native-vision edit restages the original path once when history also has image bytes", async () => {
    const history: unknown[] = [
      {
        id: 52,
        role: "user",
        content: [
          {
            type: "text",
            text: "Original\n@image:`/images/original photo.png`",
          },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,YQ==" },
          },
        ],
      },
    ]
    const { client, sockets } = harness({
      history,
      rpcReply: ({ method, params }) => {
        if (method === "image.attach")
          return {
            attached: true,
            path: "/images/original photo.png",
            count: 1,
          }
        if (method === "prompt.submit") {
          // Pinned Hermes appends one @image directive for each staged path.
          const caption = (params as { text: string }).text
          history.splice(0, history.length, {
            id: 53,
            role: "user",
            content: [
              {
                type: "text",
                text: `${caption}\n@image:\`/images/original photo.png\``,
              },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,YQ==" },
              },
            ],
          })
          return { status: "streaming" }
        }
      },
    })
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.loadHistory(threadId)
      await client.edit(threadId, {
        role: "user",
        content: [{ type: "text", text: "Revised" }],
        sourceId: "hermes-row-52",
        parentId: null,
        attachments: [],
        metadata: { custom: {} },
        runConfig: {},
        createdAt: new Date(),
      })
      expect(
        sockets[0].requests
          .filter(({ method }) =>
            ["image.attach", "image.attach_bytes", "prompt.submit"].includes(
              String(method)
            )
          )
          .map(({ method, params }) => ({ method, params }))
      ).toEqual([
        {
          method: "image.attach",
          params: { session_id: "live-1", path: "/images/original photo.png" },
        },
        {
          method: "prompt.submit",
          params: {
            session_id: "live-1",
            text: "Revised",
            truncate_before_row_id: 52,
            confirm_truncate: true,
            confirm_empty_truncate: true,
          },
        },
      ])
      expect(client.session(threadId)?.messages).toEqual([
        expect.objectContaining({
          role: "user",
          content: [
            {
              type: "text",
              text: "Revised\n@image:`/images/original photo.png`",
            },
            { type: "image", image: "data:image/png;base64,YQ==" },
          ],
        }),
      ])
      await client.loadHistory(threadId)
      expect(client.session(threadId)?.messages).toEqual([
        expect.objectContaining({
          id: "hermes-row-53",
          content: [
            {
              type: "text",
              text: "Revised\n@image:`/images/original photo.png`",
            },
            { type: "image", image: "data:image/png;base64,YQ==" },
          ],
        }),
      ])
    } finally {
      client.stop()
    }
  })

  it("composer edit rejection reconciles native history and detaches staged images without retrying", async () => {
    const state = harness({
      promptError: true,
      history: [
        {
          id: 52,
          role: "user",
          content: [
            { type: "text", text: "Original" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,YQ==" },
            },
          ],
        },
      ],
      rpcReply: ({ method }) => {
        if (method === "image.attach_bytes")
          return { attached: true, path: "/images/preserved.png" }
        if (method === "image.detach") return { detached: true }
      },
    })
    const { client, sockets } = state
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.loadHistory(threadId)
      await expect(
        client.edit(threadId, {
          role: "user",
          content: [{ type: "text", text: "Revised" }],
          sourceId: "hermes-row-52",
          parentId: null,
          attachments: [],
          metadata: { custom: {} },
          runConfig: {},
          createdAt: new Date(),
        })
      ).rejects.toThrow("provider outcome uncertain")
      expect(client.session(threadId)?.messages[0]).toMatchObject({
        id: "hermes-row-52",
        content: [
          { type: "text", text: "Original" },
          { type: "image", image: "data:image/png;base64,YQ==" },
        ],
      })
      expect(sockets[0].requests).toContainEqual(
        expect.objectContaining({
          method: "image.detach",
          params: { session_id: "live-1", path: "/images/preserved.png" },
        })
      )
      expect(
        sockets[0].requests.filter(({ method }) => method === "prompt.submit")
      ).toHaveLength(1)
    } finally {
      client.stop()
    }
  })

  it("composer isolates delayed model failures and native context across Session selection", async () => {
    const delayed = new DeferredRpc()
    const state = harness({
      sameSessionIdAcrossProfiles: true,
      rpcReply: ({ method, params }) => {
        const fields = params as Record<string, unknown>
        if (method === "session.resume")
          return {
            session_id: `live-${String(fields.profile)}`,
            running: false,
            status: "idle",
          }
        if (method === "model.options")
          return {
            provider: "native",
            model: "small",
            providers: [{ slug: "native", models: ["small", "large"] }],
          }
        if (method === "session.usage")
          return {
            context_used: fields.session_id === "live-research" ? 10 : 50,
            context_max: 100,
            context_source: "provider_usage",
            context_estimated: false,
          }
        if (method === "config.set") return delayed
      },
    })
    const onError = vi.fn()
    let bundle: ReturnType<typeof useHermesRuntimeBundle> | undefined
    let features: ReturnType<typeof useHermesComposerFeatures> | undefined
    const Harness = () => {
      bundle = useHermesRuntimeBundle(state.options)
      features = useHermesComposerFeatures(
        bundle.client,
        bundle.assistantRuntime,
        { modelSelectorEnabled: true, contextEnabled: true },
        onError
      )
      return createElement(
        AssistantRuntimeProvider,
        { runtime: bundle.assistantRuntime },
        null
      )
    }
    const view = render(createElement(Harness))
    try {
      await act(() =>
        bundle!.assistantRuntime.threads.switchToThread(
          encodeHermesThreadId("research", "stored-1")
        )
      )
      await waitFor(() => expect(features?.model?.options).toHaveLength(2))
      const change = features!.model!.select('["native","large"]')
      await vi.waitFor(() =>
        expect(
          state.sockets[0].requests.some(
            ({ method }) => method === "config.set"
          )
        ).toBe(true)
      )
      await act(() =>
        bundle!.assistantRuntime.threads.switchToThread(
          encodeHermesThreadId("creator", "stored-1")
        )
      )
      await waitFor(() => expect(features?.context?.usedTokens).toBe(50))
      delayed.resolve(new RpcFailure("Original Session failed"))
      await act(() => change)
      expect(onError).not.toHaveBeenCalled()
      expect(features?.model?.selectedId).toBe('["native","small"]')
      expect(features?.context).toEqual({ usedTokens: 50, maxTokens: 100 })
      expect(
        state.sockets[0].requests.filter(
          ({ method }) => method === "config.set"
        )
      ).toEqual([
        expect.objectContaining({
          params: {
            session_id: "live-research",
            key: "model",
            value: "large --provider native --session",
          },
        }),
      ])
    } finally {
      delayed.resolve(new RpcFailure("finished"))
      view.unmount()
      bundle?.client.stop()
      state.client.stop()
    }
  })

  it("composer respects the selected Session model reported by resume over the active-agent catalog", async () => {
    const { client } = harness({
      rpcReply: ({ method }) => {
        if (method === "session.resume")
          return {
            session_id: "live-1",
            status: "idle",
            running: false,
            info: { provider: "native", model: "large" },
          }
        if (method === "model.options")
          return {
            provider: "native",
            model: "small",
            providers: [{ slug: "native", models: ["small", "large"] }],
          }
      },
    })
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.attach(threadId)
      await client.refreshComposer(threadId, {
        modelSelectorEnabled: true,
        contextEnabled: false,
      })
      expect(client.session(threadId)?.composer?.model?.selectedId).toBe(
        '["native","large"]'
      )
    } finally {
      client.stop()
    }
  })

  it("composer omits stale context when refreshing native usage fails", async () => {
    let failed = false
    const { client } = harness({
      rpcReply: ({ method }) =>
        method === "session.usage"
          ? failed
            ? new RpcFailure("usage unavailable")
            : {
                context_used: 10,
                context_max: 100,
                context_source: "provider_usage",
                context_estimated: false,
              }
          : undefined,
    })
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.attach(threadId)
      const config = { modelSelectorEnabled: false, contextEnabled: true }
      await client.refreshComposer(threadId, config)
      failed = true
      await expect(client.refreshComposer(threadId, config)).rejects.toThrow(
        "usage unavailable"
      )
      expect(client.session(threadId)?.composer?.context).toBeUndefined()
    } finally {
      client.stop()
    }
  })

  it("composer rejects overlapping edits before attachments or the replacement can be duplicated", async () => {
    const firstSend = new DeferredRpc()
    const { client, sockets } = harness({
      rpcReply: ({ method }) =>
        method === "prompt.submit" ? firstSend : undefined,
    })
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.loadHistory(threadId)
      await client.attach(threadId)
      const message = {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Revised" }],
        sourceId: "u1",
        parentId: null,
        attachments: [],
        metadata: { custom: {} },
        runConfig: {},
        createdAt: new Date(),
      }
      const first = client.edit(threadId, message)
      void first.catch(() => undefined)
      const second = client.edit(threadId, message)
      void second.catch(() => undefined)
      await vi.waitFor(() =>
        expect(
          sockets[0].requests.filter(({ method }) => method === "prompt.submit")
            .length
        ).toBeGreaterThan(0)
      )
      expect(
        sockets[0].requests.filter(({ method }) => method === "prompt.submit")
      ).toHaveLength(1)
      firstSend.resolve({ status: "streaming" })
      await first
      await expect(second).rejects.toThrow(/editing|pending/iu)
      expect(
        sockets[0].requests.filter(({ method }) => method === "prompt.submit")
      ).toHaveLength(1)
    } finally {
      firstSend.resolve({ status: "streaming" })
      client.stop()
    }
  })

  it("composer keeps context available when the independent native model catalog fails", async () => {
    const { client } = harness({
      rpcReply: ({ method }) => {
        if (method === "model.options")
          return new RpcFailure("catalog unavailable")
        if (method === "session.usage")
          return {
            context_used: 10,
            context_max: 100,
            context_source: "provider_usage",
            context_estimated: false,
          }
      },
    })
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.attach(threadId)
      await expect(
        client.refreshComposer(threadId, {
          modelSelectorEnabled: true,
          contextEnabled: true,
        })
      ).rejects.toThrow("catalog unavailable")
      expect(client.session(threadId)?.composer?.context).toEqual({
        usedTokens: 10,
        maxTokens: 100,
      })
    } finally {
      client.stop()
    }
  })

  it("composer keeps a newer native context event when an older usage read arrives", async () => {
    const old = new DeferredRpc()
    const { client, sockets } = harness({
      rpcReply: ({ method }) => (method === "session.usage" ? old : undefined),
    })
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.attach(threadId)
      const read = client.refreshComposer(threadId, {
        modelSelectorEnabled: false,
        contextEnabled: true,
      })
      sockets[0].message({
        method: "event",
        params: {
          type: "session.usage",
          session_id: "live-1",
          payload: {
            usage: {
              context_used: 30,
              context_max: 100,
              context_source: "provider_usage",
              context_estimated: false,
            },
          },
        },
      })
      old.resolve({
        context_used: 10,
        context_max: 100,
        context_source: "provider_usage",
        context_estimated: false,
      })
      await read
      expect(client.session(threadId)?.composer?.context).toEqual({
        usedTokens: 30,
        maxTokens: 100,
      })
    } finally {
      client.stop()
    }
  })

  it("composer refreshes native context after history and model changes", async () => {
    let used = 10
    let max = 100
    const state = harness({
      rpcReply: ({ method }) => {
        if (method === "session.usage")
          return {
            context_used: used,
            context_max: max,
            context_source: "provider_usage",
            context_estimated: false,
          }
        if (method === "model.options")
          return {
            provider: "native",
            model: "small",
            providers: [{ slug: "native", models: ["small", "large"] }],
          }
        if (method === "config.set") {
          max = 200
          return { key: "model", value: "large", scope: "session" }
        }
      },
    })
    const { client } = state
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.attach(threadId)
      await client.refreshComposer(threadId, {
        modelSelectorEnabled: true,
        contextEnabled: true,
      })
      used = 20
      await client.loadHistory(threadId)
      await vi.waitFor(() =>
        expect(client.session(threadId)?.composer?.context).toEqual({
          usedTokens: 20,
          maxTokens: 100,
        })
      )
      await client.selectModel(threadId, '["native","large"]')
      expect(client.session(threadId)?.composer?.context).toEqual({
        usedTokens: 20,
        maxTokens: 200,
      })
      state.sockets[0].message({
        method: "event",
        params: {
          type: "session.usage",
          session_id: "live-1",
          payload: {
            usage: {
              context_used: 30,
              context_max: 200,
              context_source: "provider_usage",
              context_estimated: false,
            },
          },
        },
      })
      expect(client.session(threadId)?.composer?.context).toEqual({
        usedTokens: 30,
        maxTokens: 200,
      })
    } finally {
      client.stop()
    }
  })

  it("composer view model handles model failures through onError without rejecting", async () => {
    const state = harness({
      rpcReply: ({ method }) => {
        if (method === "model.options")
          return {
            provider: "native",
            model: "small",
            providers: [{ slug: "native", models: ["small", "large"] }],
          }
        if (method === "config.set")
          return new RpcFailure("Native model failed")
      },
    })
    const onError = vi.fn()
    let bundle: ReturnType<typeof useHermesRuntimeBundle> | undefined
    let features: ReturnType<typeof useHermesComposerFeatures> | undefined
    const Harness = () => {
      bundle = useHermesRuntimeBundle(state.options)
      features = useHermesComposerFeatures(
        bundle.client,
        bundle.assistantRuntime,
        { modelSelectorEnabled: true, contextEnabled: false },
        onError
      )
      return createElement(
        AssistantRuntimeProvider,
        { runtime: bundle.assistantRuntime },
        null
      )
    }
    const view = render(createElement(Harness))
    try {
      await act(() =>
        bundle!.assistantRuntime.threads.switchToThread(
          encodeHermesThreadId("research", "stored-1")
        )
      )
      await waitFor(() => expect(features?.model?.options).toHaveLength(2))
      expect(features?.context).toBeUndefined()
      await act(() =>
        expect(
          features!.model!.select('["native","large"]')
        ).resolves.toBeUndefined()
      )
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Native model failed" })
      )
      expect(features?.model?.selectedId).toBe('["native","small"]')
    } finally {
      view.unmount()
      bundle?.client.stop()
      state.client.stop()
    }
  })

  it("composer runtime exposes native attachments and same-Session text edits", async () => {
    const state = harness({
      rpcReply: ({ method }) =>
        method === "file.attach"
          ? { attached: true, ref_text: "@file:notes.txt" }
          : undefined,
    })
    let bundle: ReturnType<typeof useHermesRuntimeBundle> | undefined
    const Harness = () => {
      bundle = useHermesRuntimeBundle(state.options)
      return createElement(
        AssistantRuntimeProvider,
        { runtime: bundle.assistantRuntime },
        null
      )
    }
    const view = render(createElement(Harness))
    try {
      const threadId = encodeHermesThreadId("research", "stored-1")
      await act(() => bundle!.assistantRuntime.threads.switchToThread(threadId))
      await waitFor(() =>
        expect(bundle!.client.session(threadId)?.liveSessionId).toBe("live-1")
      )
      const runtime = bundle!.assistantRuntime.thread
      expect(runtime.getState().capabilities).toMatchObject({
        attachments: true,
        edit: true,
      })
      await act(() =>
        runtime.composer.addAttachment(
          new File(["hi"], "notes.txt", { type: "text/plain" })
        )
      )
      expect(runtime.composer.getState().attachments).toHaveLength(1)
      await act(() => runtime.composer.send())
      await waitFor(() =>
        expect(state.sockets[0].requests).toContainEqual(
          expect.objectContaining({
            method: "prompt.submit",
            params: { session_id: "live-1", text: "@file:notes.txt" },
          })
        )
      )
    } finally {
      view.unmount()
      bundle?.client.stop()
      state.client.stop()
    }
  })

  it.each([
    {},
    { context_used: 10 },
    { context_max: 100 },
    {
      context_used: "10",
      context_max: 100,
      context_source: "provider_usage",
      context_estimated: false,
    },
    {
      context_used: -1,
      context_max: 100,
      context_source: "provider_usage",
      context_estimated: false,
    },
    {
      context_used: 10,
      context_max: 0,
      context_source: "provider_usage",
      context_estimated: false,
    },
    {
      context_used: 10,
      context_max: 100,
      context_source: "local_estimate",
      context_estimated: false,
    },
    {
      context_used: 10,
      context_max: 100,
      context_source: "provider_usage",
      context_estimated: true,
    },
  ])(
    "composer drops context when a native update lacks an authoritative valid reading: %j",
    async (usage) => {
      const { client, sockets } = harness({
        rpcReply: ({ method }) =>
          method === "session.usage"
            ? {
                context_used: 4321,
                context_max: 100000,
                context_source: "provider_usage",
                context_estimated: false,
              }
            : undefined,
      })
      try {
        await client.start()
        const threadId = encodeHermesThreadId("research", "stored-1")
        await client.attach(threadId)
        await client.refreshComposer(threadId, {
          modelSelectorEnabled: false,
          contextEnabled: true,
        })
        sockets[0].message({
          method: "event",
          params: {
            type: "session.info",
            session_id: "live-1",
            payload: { running: false, usage },
          },
        })
        expect(client.session(threadId)?.composer?.context).toBeUndefined()
      } finally {
        client.stop()
      }
    }
  )

  it("composer reads authoritative context independently of the model catalog", async () => {
    const { client, sockets } = harness({
      rpcReply: ({ method }) =>
        method === "session.usage"
          ? {
              context_used: 4321,
              context_max: 100000,
              context_source: "provider_usage",
              context_estimated: false,
            }
          : undefined,
    })
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.attach(threadId)
      await client.refreshComposer(threadId, {
        modelSelectorEnabled: false,
        contextEnabled: true,
      })
      expect(client.session(threadId)?.composer?.context).toEqual({
        usedTokens: 4321,
        maxTokens: 100000,
      })
      expect(
        sockets[0].requests.some(({ method }) => method === "model.options")
      ).toBe(false)
    } finally {
      client.stop()
    }
  })

  it("composer serializes rapid model picks and ignores a stale catalog response", async () => {
    const change = new DeferredRpc()
    const stale = new DeferredRpc()
    let catalogReads = 0
    let changes = 0
    const { client, sockets } = harness({
      rpcReply: ({ method }) => {
        if (method === "model.options")
          return ++catalogReads === 1
            ? {
                provider: "native",
                model: "small",
                providers: [{ slug: "native", models: ["small", "large"] }],
              }
            : stale
        if (method === "config.set")
          return ++changes === 1
            ? change
            : { key: "model", value: "small", scope: "session" }
      },
    })
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.attach(threadId)
      const config = { modelSelectorEnabled: true, contextEnabled: false }
      await client.refreshComposer(threadId, config)
      const oldRefresh = client.refreshComposer(threadId, config)
      const first = client.selectModel(threadId, '["native","large"]')
      const second = client.selectModel(threadId, '["native","small"]')
      await vi.waitFor(() => expect(changes).toBe(1))
      expect(
        sockets[0].requests.filter(({ method }) => method === "config.set")
      ).toHaveLength(1)
      change.resolve({ key: "model", value: "large", scope: "session" })
      await Promise.all([first, second])
      stale.resolve({
        provider: "native",
        model: "large",
        providers: [{ slug: "native", models: ["small", "large"] }],
      })
      await oldRefresh
      expect(client.session(threadId)?.composer?.model?.selectedId).toBe(
        '["native","small"]'
      )
      expect(changes).toBe(2)
    } finally {
      client.stop()
    }
  })

  it("composer reads the native Session model catalog and changes only that Session", async () => {
    const { client, sockets } = harness({
      rpcReply: ({ method }) => {
        if (method === "model.options")
          return {
            provider: "native",
            model: "small",
            providers: [
              { slug: "native", name: "Native", models: ["small", "large"] },
            ],
          }
        if (method === "config.set")
          return {
            key: "model",
            value: "large",
            scope: "session",
            confirm_required: false,
          }
      },
    })
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.attach(threadId)
      await client.refreshComposer(threadId, {
        modelSelectorEnabled: true,
        contextEnabled: false,
      })
      expect(client.session(threadId)?.composer?.model).toMatchObject({
        selectedId: '["native","small"]',
        options: [
          { id: '["native","small"]', label: "small", group: "Native" },
          { id: '["native","large"]', label: "large", group: "Native" },
        ],
      })
      await client.selectModel(threadId, '["native","large"]')
      expect(sockets[0].requests).toContainEqual(
        expect.objectContaining({
          method: "config.set",
          params: {
            session_id: "live-1",
            key: "model",
            value: "large --provider native --session",
          },
        })
      )
      expect(client.session(threadId)?.composer?.model?.selectedId).toBe(
        '["native","large"]'
      )
    } finally {
      client.stop()
    }
  })

  it("composer projects native image history and preserves those images when editing text", async () => {
    const { client, sockets } = harness({
      history: [
        {
          id: 52,
          role: "user",
          content: [
            { type: "text", text: "Original" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,YQ==" },
            },
          ],
        },
      ],
      rpcReply: ({ method }) =>
        method === "image.attach_bytes"
          ? { attached: true, path: "/images/preserved.png" }
          : undefined,
    })
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.loadHistory(threadId)
      expect(client.session(threadId)?.messages[0]).toMatchObject({
        content: [
          { type: "text", text: "Original" },
          { type: "image", image: "data:image/png;base64,YQ==" },
        ],
      })
      await client.edit(threadId, {
        role: "user",
        content: [{ type: "text", text: "Revised" }],
        sourceId: "hermes-row-52",
        parentId: null,
        attachments: [],
        metadata: { custom: {} },
        runConfig: {},
        createdAt: new Date(),
      })
      expect(sockets[0].requests).toContainEqual(
        expect.objectContaining({
          method: "image.attach_bytes",
          params: {
            session_id: "live-1",
            content_base64: "data:image/png;base64,YQ==",
            filename: "image.png",
          },
        })
      )
      expect(client.session(threadId)?.messages[0]).toMatchObject({
        content: [
          { type: "text", text: "Revised" },
          { type: "image", image: "data:image/png;base64,YQ==" },
        ],
      })
    } finally {
      client.stop()
    }
  })

  it.each([
    { type: "image", image: "https://external.test/a.png" },
    { type: "file", data: "%%%", mimeType: "text/plain" },
  ] satisfies ThreadUserMessagePart[])(
    "composer refuses unsupported attachment bytes before native staging: $type",
    async (part) => {
      const { client, sockets } = harness()
      try {
        await client.start()
        await expect(
          client.submit(encodeHermesThreadId("research", "stored-1"), {
            role: "user",
            content: [{ type: "text", text: "Inspect" }, part],
            sourceId: null,
            parentId: null,
            attachments: [],
            metadata: { custom: {} },
            runConfig: {},
            createdAt: new Date(),
          })
        ).rejects.toThrow(/attachment/iu)
        expect(
          sockets[0].requests.some(({ method }) =>
            ["image.attach_bytes", "file.attach", "prompt.submit"].includes(
              String(method)
            )
          )
        ).toBe(false)
      } finally {
        client.stop()
      }
    }
  )

  it("composer removes its staged image when a later native attachment fails", async () => {
    const { client, sockets } = harness({
      rpcReply: ({ method }) => {
        if (method === "image.attach_bytes")
          return { attached: true, path: "/images/a.png" }
        if (method === "file.attach")
          return new RpcFailure("native file rejected")
        if (method === "image.detach") return { detached: true }
      },
    })
    try {
      await client.start()
      await expect(
        client.submit(encodeHermesThreadId("research", "stored-1"), {
          role: "user",
          content: [
            { type: "image", image: "data:image/png;base64,YQ==" },
            { type: "file", data: "aGk=", mimeType: "text/plain" },
          ],
          sourceId: null,
          parentId: null,
          attachments: [],
          metadata: { custom: {} },
          runConfig: {},
          createdAt: new Date(),
        })
      ).rejects.toThrow("native file rejected")
      expect(sockets[0].requests).toContainEqual(
        expect.objectContaining({
          method: "image.detach",
          params: { session_id: "live-1", path: "/images/a.png" },
        })
      )
      expect(
        sockets[0].requests.some(({ method }) => method === "prompt.submit")
      ).toBe(false)
    } finally {
      client.stop()
    }
  })

  it("composer attachments stage image bytes and native file references before one submit", async () => {
    const { client, sockets } = harness({
      rpcReply: ({ method }) => {
        if (method === "image.attach_bytes")
          return { attached: true, path: "/images/a.png" }
        if (method === "file.attach")
          return {
            attached: true,
            ref_text: "@file:notes.txt",
            path: "/attachments/notes.txt",
            name: "notes.txt",
          }
      },
    })
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.submit(threadId, {
        role: "user",
        content: [
          { type: "text", text: "Inspect" },
          {
            type: "image",
            image: "data:image/png;base64,YQ==",
            filename: "a.png",
          },
          {
            type: "file",
            data: "aGk=",
            mimeType: "text/plain",
            filename: "notes.txt",
          },
        ],
        sourceId: null,
        parentId: null,
        attachments: [],
        metadata: { custom: {} },
        runConfig: {},
        createdAt: new Date(),
      })
      expect(
        sockets[0].requests
          .filter(({ method }) =>
            ["image.attach_bytes", "file.attach", "prompt.submit"].includes(
              String(method)
            )
          )
          .map(({ method, params }) => ({ method, params }))
      ).toEqual([
        {
          method: "image.attach_bytes",
          params: {
            session_id: "live-1",
            content_base64: "data:image/png;base64,YQ==",
            filename: "a.png",
          },
        },
        {
          method: "file.attach",
          params: {
            session_id: "live-1",
            data_url: "data:text/plain;base64,aGk=",
            name: "notes.txt",
          },
        },
        {
          method: "prompt.submit",
          params: { session_id: "live-1", text: "Inspect\n@file:notes.txt" },
        },
      ])
      expect(client.session(threadId)?.messages.at(-1)).toMatchObject({
        content: [
          { type: "text", text: "Inspect\n@file:notes.txt" },
          { type: "image", image: "data:image/png;base64,YQ==" },
        ],
      })
    } finally {
      client.stop()
    }
  })

  it("composer edit keeps native attachment references and durable row identity", async () => {
    const { client, sockets } = harness({
      rpcReply: ({ method }) =>
        method === "image.attach"
          ? { attached: true, path: "/images/photo.png", count: 1 }
          : undefined,
      history: [
        {
          id: 42,
          role: "user",
          content: "Original\n@file:`report a.pdf`\n@image:/images/photo.png",
        },
        { id: 43, role: "assistant", content: "Answer" },
      ],
    })
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.loadHistory(threadId)
      await client.edit(threadId, {
        role: "user",
        content: [{ type: "text", text: "Revised\n@file:changed.pdf" }],
        sourceId: "hermes-row-42",
        parentId: null,
        attachments: [],
        metadata: { custom: {} },
        runConfig: {},
        createdAt: new Date(),
      })
      expect(
        sockets[0].requests.filter(({ method }) => method === "prompt.submit")
      ).toEqual([
        expect.objectContaining({
          params: {
            session_id: "live-1",
            text: "Revised\n@file:`report a.pdf`",
            truncate_before_row_id: 42,
            confirm_truncate: true,
            confirm_empty_truncate: true,
          },
        }),
      ])
    } finally {
      client.stop()
    }
  })

  it("composer edit replaces a sent turn once in the same native Session", async () => {
    const { client, sockets } = harness()
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.loadHistory(threadId)
      await client.attach(threadId)
      await client.edit(threadId, {
        role: "user",
        content: [{ type: "text", text: "Corrected" }],
        sourceId: "u1",
        parentId: null,
        attachments: [],
        metadata: { custom: {} },
        runConfig: {},
        createdAt: new Date(),
      })
      expect(
        sockets[0].requests.filter(({ method }) => method === "prompt.submit")
      ).toEqual([
        expect.objectContaining({
          params: {
            session_id: "live-1",
            text: "Corrected",
            truncate_before_message_id: "u1",
            confirm_truncate: true,
            confirm_empty_truncate: true,
          },
        }),
      ])
      expect(client.session(threadId)).toMatchObject({
        threadId,
        storedSessionId: "stored-1",
        liveSessionId: "live-1",
        messages: [{ role: "user", content: "Corrected" }],
      })
    } finally {
      client.stop()
    }
  })

  it("invalidates activity on catalog failure and restores it on recovery", async () => {
    const { client, fetcher } = harness()
    try {
      await client.start()
      const changed = vi.fn()
      const unsubscribe = client.subscribeCatalog(changed)
      fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }))
      await expect(client.refreshCatalog()).rejects.toThrow("503")
      expect(client.getSnapshot().agents[0].activity).toBe("unknown")
      expect(changed).toHaveBeenCalledTimes(1)
      await client.refreshCatalog()
      expect(client.getSnapshot().agents[0].activity).toBe("idle")
      expect(changed).toHaveBeenCalledTimes(2)
      unsubscribe()
    } finally {
      client.stop()
    }
  })

  it("invalidates Agent activity when the native connection closes", async () => {
    const { client, sockets } = harness()
    try {
      await client.start()
      sockets[0].disconnect()
      expect(client.getSnapshot().agents[0].activity).toBe("unknown")
    } finally {
      client.stop()
    }
  })

  it("marks an attached Session unknown when native status reading fails", async () => {
    const { client } = harness({
      activeReply: new RpcFailure("status unavailable"),
    })
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.attach(threadId)
      await client.refreshCatalog()
      expect(client.session(threadId)?.status).toBe("unknown")
      expect(
        agentStatusFromSessions(
          client.getSnapshot().agents[0],
          client.getSnapshot().sessions
        )
      ).toBe("unknown")
      expect(client.getSnapshot().agents).toHaveLength(2)
    } finally {
      client.stop()
    }
  })
  it("keeps live statuses scoped by verified attachment, not bare stored IDs", async () => {
    const { client } = harness({
      sameSessionIdAcrossProfiles: true,
      liveStatus: "working",
    })
    try {
      await client.start()
      await client.attach(encodeHermesThreadId("research", "stored-1"))
      await client.refreshCatalog()
      expect(
        client.session(encodeHermesThreadId("research", "stored-1"))?.status
      ).toBe("running")
      expect(
        client.session(encodeHermesThreadId("creator", "stored-1"))?.status
      ).toBe("unknown")
    } finally {
      client.stop()
    }
  })

  it("does not overwrite a live event with an older status poll", async () => {
    const activeReply = new DeferredRpc()
    const { client, sockets } = harness({ activeReply })
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.attach(threadId)
      const refreshing = client.refreshCatalog()
      await vi.waitFor(() =>
        expect(
          sockets[0].requests.some(
            ({ method }) => method === "session.active_list"
          )
        ).toBe(true)
      )
      sockets[0].message({
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "message.start",
          session_id: "live-1",
          payload: {},
        },
      })
      activeReply.resolve({ sessions: [{ id: "live-1", status: "idle" }] })
      await refreshing
      expect(client.session(threadId)?.status).toBe("running")
    } finally {
      client.stop()
    }
  })

  it("shows native Agent activity despite unknown historical Session execution", async () => {
    const { client, sockets } = harness()
    try {
      await client.start()
      const { agents, sessions } = client.getSnapshot()
      expect(sessions[0].status).toBe("unknown")
      expect(
        agentStatusFromSessions(agents[0], [
          ...sessions,
          { ...sessions[0], threadId: "attached", status: "idle" },
        ])
      ).toBe("idle")
      expect(
        sockets[0].requests.find(({ method }) => method === "profiles.list")
          ?.params
      ).toEqual({ include_sessions: true })
      expect(
        sockets[0].requests.some(({ method }) => method === "session.resume")
      ).toBe(false)
    } finally {
      client.stop()
    }
  })

  it.each([
    ["last_session", 89, "active"],
    ["canonical_session", 89, "active"],
    ["worker_session", 149, "active"],
    ["last_session", 90, "idle"],
    ["worker_session", 150, "idle"],
    ["last_session", -1000, "idle"],
  ])(
    "projects %s activity at age %s without declaring a Session running",
    async (field, age, expected) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-09-08T12:00:00Z"))
      const { client } = harness({
        profileActivity: {
          [field]: { last_active: Date.now() / 1000 - Number(age) },
        },
      })
      try {
        await client.start()
        expect(
          agentStatusFromSessions(
            client.getSnapshot().agents[0],
            client.getSnapshot().sessions
          )
        ).toBe(expected)
        expect(client.getSnapshot().sessions[0].status).toBe("unknown")
        expect(client.getSnapshot().sessions[0].running).toBe(false)
        await vi.advanceTimersByTimeAsync(151_000)
        await client.refreshCatalog()
        expect(
          agentStatusFromSessions(
            client.getSnapshot().agents[0],
            client.getSnapshot().sessions
          )
        ).toBe("idle")
      } finally {
        client.stop()
        vi.useRealTimers()
      }
    }
  )

  it("derives Agent idle after native attachment instead of pinning it to unknown", async () => {
    const { client } = harness()
    try {
      await client.start()
      await client.attach(encodeHermesThreadId("research", "stored-1"))
      expect(
        agentStatusFromSessions(
          client.getSnapshot().agents[0],
          client.getSnapshot().sessions
        )
      ).toBe("idle")
    } finally {
      client.stop()
    }
  })

  it("recognizes native-ended Sessions without attachment", async () => {
    const { client, sockets } = harness({ endedAt: 1_788_000_100 })
    try {
      await client.start()
      expect(client.getSnapshot().sessions[0].status).toBe("idle")
      expect(
        sockets[0].requests.some(({ method }) => method === "session.resume")
      ).toBe(false)
    } finally {
      client.stop()
    }
  })

  it("refreshes live status without reattaching or changing catalog metadata", async () => {
    const { client, sockets, setLiveStatus } = harness()
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      // An unscoped native live row is not evidence of profile ownership.
      expect(client.session(threadId)?.status).toBe("unknown")
      await client.attach(threadId)
      for (const [native, expected] of [
        ["working", "running"],
        ["waiting", "waiting-for-input"],
        ["idle", "idle"],
        ["future-status", "unknown"],
      ]) {
        setLiveStatus(native)
        await client.refreshCatalog()
        expect(client.session(threadId)?.status).toBe(expected)
      }
      expect(
        sockets[0].requests.filter(({ method }) => method === "session.resume")
      ).toHaveLength(1)
      expect(
        sockets[0].requests.some(({ method }) => method === "prompt.submit")
      ).toBe(false)
    } finally {
      client.stop()
    }
  })

  it("reports recovery after startup and reconnect, and releases the listener", async () => {
    const { client, sockets } = harness()
    const recovered = vi.fn()
    const unsubscribe = client.subscribeRecovery(recovered)
    try {
      await client.start()
      expect(recovered).toHaveBeenCalledTimes(1)
      sockets[0].disconnect()
      await vi.waitFor(() => expect(recovered).toHaveBeenCalledTimes(2))
      unsubscribe()
      sockets[1].disconnect()
      await vi.waitFor(() => expect(sockets).toHaveLength(3))
      expect(recovered).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribe()
      client.stop()
    }
  })

  it("submits and receives messages when randomUUID is unavailable over HTTP", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: globalThis.crypto.getRandomValues.bind(
        globalThis.crypto
      ),
    })
    const { client, sockets } = harness()
    try {
      await client.start()
      const threadId = encodeHermesThreadId("research", "stored-1")
      await client.submit(threadId, {
        role: "user",
        content: [{ type: "text", text: "Hello over HTTP" }],
      } as never)
      sockets[0].message({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "message.start", session_id: "live-1", payload: {} },
      })
      const messages = client.session(threadId)!.messages
      expect(messages.map(({ role }) => role)).toEqual(["user", "assistant"])
      expect(messages[0].id).toMatch(/^hermes-user-/)
      expect(messages[1].id).toMatch(/^hermes-assistant-/)
      expect(messages[0].id).not.toBe(messages[1].id)
    } finally {
      client.stop()
      vi.unstubAllGlobals()
    }
  })

  it("authenticates one native JSON-RPC socket and maps provider-owned identities", async () => {
    const { client, sockets } = harness()
    await client.start()
    expect(sockets).toHaveLength(1)
    expect(sockets[0].url).toBe("ws://localhost:3000/hermes/api/ws")
    expect(sockets[0].protocols).toEqual([
      "hermes-gateway-v1",
      "hermes-gateway-ticket.ticket-1",
    ])
    expect(client.getSnapshot().agents).toEqual([
      expect.objectContaining({
        id: "research",
        name: "Research",
        visibility: "visible",
      }),
      expect.objectContaining({
        id: "creator",
        visibility: "hidden",
        role: "creator",
      }),
    ])
    expect(client.getSnapshot().sessions[0]).toMatchObject({
      threadId: encodeHermesThreadId("research", "stored-1"),
      agentId: "research",
      status: "unknown",
    })
    client.stop()
  })

  it("coalesces catalog feedback and does not notify for unchanged discovery", async () => {
    const { client, sockets } = harness()
    const listener = vi.fn(() => void client.refreshCatalog())
    client.subscribeCatalog(listener)
    await client.start()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(
      sockets[0].requests.filter(({ method }) => method === "profiles.list")
    ).toHaveLength(1)
    await client.refreshCatalog()
    expect(listener).toHaveBeenCalledTimes(1)
    client.stop()
  })

  it("keeps one discovery coordinator across a retain/release remount", async () => {
    vi.useFakeTimers()
    try {
      const { client, sockets } = harness()
      const releaseFirst = client.retain()
      await Promise.all([client.start(), client.start()])
      releaseFirst()
      const releaseSecond = client.retain()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(sockets).toHaveLength(1)
      expect(
        sockets[0].requests.filter(({ method }) => method === "profiles.list")
      ).toHaveLength(2)
      releaseSecond()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(
        sockets[0].requests.filter(({ method }) => method === "profiles.list")
      ).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("updates visibility through revision-checked native profile configuration", async () => {
    const { client, sockets } = harness()
    await client.start()
    await client.updateProfileVisibility("research", "hidden")
    expect(
      sockets[0].requests.find(({ method }) => method === "profiles.configure")
    ).toMatchObject({
      params: {
        name: "research",
        ui_meta: {
          "hermes-bots": { hidden: true, accent: "violet" },
        },
        ui_meta_expected_revisions: { "hermes-bots": 3 },
      },
    })
    expect(client.getSnapshot().agents[0].visibility).toBe("hidden")
    client.stop()
  })

  it("surfaces profile visibility revision conflicts and excludes creator mutation", async () => {
    const { client } = harness({ visibilityConflict: true })
    await client.start()
    await expect(
      client.updateProfileVisibility("research", "hidden")
    ).rejects.toMatchObject({ code: "pending-reload" })
    await expect(
      client.updateProfileVisibility("creator", "visible")
    ).rejects.toThrow("creator profile cannot be managed")
    client.stop()
  })

  it("exposes editable normal profiles while excluding the creator catalog entry", async () => {
    const { client } = harness()
    const workspace = createHermesWorkspace(client)
    await expect(workspace.listAgentCatalog?.()).resolves.toEqual([
      expect.objectContaining({
        summary: expect.objectContaining({ id: "research" }),
        editable: true,
      }),
    ])
    client.stop()
  })

  it("hydrates rich native history and resumes without submitting", async () => {
    const { client, sockets } = harness()
    await client.start()
    const threadId = encodeHermesThreadId("research", "stored-1")
    await client.loadHistory(threadId)
    await client.attach(threadId)
    const methods = sockets[0].requests.map(({ method }) => method)
    expect(methods).toContain("session.resume")
    expect(methods).not.toContain("prompt.submit")
    expect(
      sockets[0].requests.find(({ method }) => method === "session.resume")
    ).toMatchObject({
      params: {
        session_id: "stored-1",
        profile: "research",
        omit_messages: true,
      },
    })
    expect(client.session(threadId)?.messages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "Working" },
        {
          type: "tool-call",
          toolCallId: "t1",
          toolName: "present_plan",
          args: { title: "Exact" },
          result: { ok: true },
        },
      ],
    })
    client.stop()
  })

  it("does not resubmit an accepted prompt during reconnect or cleanup", async () => {
    const { client, sockets } = harness()
    await client.start()
    const threadId = encodeHermesThreadId("research", "stored-1")
    await client.attach(threadId)
    await client.submit(threadId, {
      role: "user",
      content: [{ type: "text", text: "Exactly once" }],
    } as never)
    expect(
      sockets
        .flatMap(({ requests }) => requests)
        .filter(({ method }) => method === "prompt.submit")
    ).toHaveLength(1)
    sockets[0].disconnect()
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    await vi.waitFor(() =>
      expect(
        sockets
          .flatMap(({ requests }) => requests)
          .filter(({ method }) => method === "session.resume")
      ).toHaveLength(2)
    )
    expect(
      sockets
        .flatMap(({ requests }) => requests)
        .filter(({ method }) => method === "prompt.submit")
    ).toHaveLength(1)
    client.stop()
    expect(
      sockets
        .flatMap(({ requests }) => requests)
        .some(
          ({ method }) =>
            method === "session.interrupt" || method === "session.close"
        )
    ).toBe(false)
  })

  it("keeps reconnecting after a transient ticket failure", async () => {
    const state = harness({ reconnectTicketFailures: 1 })
    await state.client.start()
    state.sockets[0].disconnect()
    await vi.waitFor(() => expect(state.sockets).toHaveLength(2))
    expect(
      state.fetcher.mock.calls.filter(([input]) =>
        String(input).includes("/api/auth/ws-ticket")
      )
    ).toHaveLength(3)
    state.client.stop()
  })

  it.each([true, false, null, "inaccessible"] as const)(
    "leaves recovery policy to Hermes when auto-continue configuration is %s",
    async (autoContinue) => {
      const { client, sockets, fetcher } = harness({ autoContinue })
      await client.start()
      try {
        await expect(
          client.attach(encodeHermesThreadId("research", "stored-1"))
        ).resolves.toBe("live-1")
        const methods = sockets[0].requests.map(({ method }) => method)
        expect(methods).toContain("session.resume")
        expect(methods).not.toContain("prompt.submit")
        expect(
          fetcher.mock.calls.some(([input]) =>
            String(input).includes("/api/config")
          )
        ).toBe(false)
      } finally {
        client.stop()
      }
    }
  )

  it("rejects duplicate provider Session identities", async () => {
    const { client } = harness({ duplicateSession: true })
    await expect(client.start()).rejects.toThrow("duplicate Session id")
    client.stop()
  })

  it("rejects a Session returned under the wrong owner profile", async () => {
    const { client } = harness({ wrongOwner: true })
    await expect(client.start()).rejects.toThrow("ownership mismatch")
    client.stop()
  })

  it("rejects a stale approval without answering a newer native request", async () => {
    const { client, sockets } = harness()
    await client.start()
    const threadId = encodeHermesThreadId("research", "stored-1")
    await client.attach(threadId)
    const approval = (requestId: string) =>
      sockets[0].message({
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "approval.request",
          session_id: "live-1",
          payload: { request_id: requestId, message: "Allow command?" },
        },
      })
    approval("old-request")
    approval("new-request")
    await expect(
      client.answerApproval(threadId, "old-request", "once")
    ).rejects.toThrow("no longer current")
    expect(
      sockets[0].requests.some(({ method }) => method === "approval.respond")
    ).toBe(false)
    client.stop()
  })

  it("does not clear a replacement approval that reuses an in-flight request id", async () => {
    const approvalDeferred = new DeferredRpc()
    const { client, sockets } = harness({ approvalDeferred })
    await client.start()
    const threadId = encodeHermesThreadId("research", "stored-1")
    await client.attach(threadId)
    const approval = (message: string) =>
      sockets[0].message({
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "approval.request",
          session_id: "live-1",
          payload: { request_id: "reused-request", message },
        },
      })
    approval("Original approval")
    const response = client.answerApproval(threadId, "reused-request", "once")
    approval("Replacement approval")
    approvalDeferred.resolve({ resolved: true })
    await response

    expect(client.session(threadId)?.approval).toMatchObject({
      requestId: "reused-request",
      message: "Replacement approval",
    })
    client.stop()
  })

  it("does not republish metadata or Todos for text-only stream changes", async () => {
    const { client, sockets } = harness()
    const workspace = createHermesWorkspace(client)
    await client.start()
    const threadId = encodeHermesThreadId("research", "stored-1")
    await client.attach(threadId)
    sockets[0].message({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "message.start",
        session_id: "live-1",
        seq: 1,
        payload: {},
      },
    })
    const metadata = vi.fn()
    const todos = vi.fn()
    const unsubscribeMetadata = workspace.subscribeSessionMetadata?.(
      [threadId],
      metadata
    )
    const unsubscribeTodos = workspace.subscribeTodos?.(threadId, todos)
    sockets[0].message({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "message.delta",
        session_id: "live-1",
        seq: 2,
        payload: { text: "token" },
      },
    })
    expect(metadata).toHaveBeenCalledTimes(1)
    expect(todos).toHaveBeenCalledTimes(1)
    unsubscribeMetadata?.()
    unsubscribeTodos?.()
    client.stop()
  })

  it("does not retry a prompt whose native outcome is uncertain", async () => {
    const { client, sockets } = harness({ promptError: true })
    await client.start()
    const threadId = encodeHermesThreadId("research", "stored-1")
    await client.attach(threadId)
    await expect(
      client.submit(threadId, {
        role: "user",
        content: [{ type: "text", text: "Once only" }],
      } as never)
    ).rejects.toThrow("provider outcome uncertain")
    expect(
      sockets[0].requests.filter(({ method }) => method === "prompt.submit")
    ).toHaveLength(1)
    client.stop()
  })

  it("refetches authoritative history when reconnect replay is truncated", async () => {
    const state = harness({ truncateReplay: true })
    await state.client.start()
    const threadId = encodeHermesThreadId("research", "stored-1")
    await state.client.attach(threadId)
    state.sockets[0].message({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "message.start",
        session_id: "live-1",
        seq: 7,
        payload: {},
      },
    })
    state.sockets[0].disconnect()
    await vi.waitFor(() => expect(state.sockets).toHaveLength(2))
    await vi.waitFor(() => expect(state.historyFetches).toBeGreaterThan(0))
    state.client.stop()
  })

  it("clears replay state and refetches attached history on an epoch change", async () => {
    const state = harness()
    await state.client.start()
    const threadId = encodeHermesThreadId("research", "stored-1")
    await state.client.attach(threadId)
    const ready = (epoch: string) =>
      state.sockets[0].message({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "gateway.ready", payload: { replay_epoch: epoch } },
      })
    ready("epoch-1")
    ready("epoch-2")
    await vi.waitFor(() => expect(state.historyFetches).toBeGreaterThan(0))
    state.client.stop()
  })
})
