import { describe, expect, it, vi } from "vitest"

import {
  HermesNativeClient,
  encodeHermesThreadId,
  type HermesWebSocket,
} from "./hermes-native-client"
import { createHermesWorkspace } from "./hermes-workspace"

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
}: {
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
          url.searchParams.get("profile") === "research"
            ? Array.from({ length: duplicateSession ? 2 : 1 }, () => ({
                id: "stored-1",
                profile: wrongOwner ? "creator" : "research",
                title: "Native history",
                last_active: 1_788_000_000,
              }))
            : [],
        total:
          url.searchParams.get("profile") === "research"
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
        messages: [
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
    switch (request.method) {
      case "profiles.list":
        return {
          profiles: [
            {
              name: "research",
              display_name: "Research",
              description: "Native profile",
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
  const client = new HermesNativeClient({
    baseUrl: "/hermes",
    fetcher,
    reconnectDelayMs: 0,
    socketFactory(url, protocols) {
      const socket = new FakeSocket(url, protocols, reply)
      sockets.push(socket)
      return socket
    },
  })
  return {
    client,
    fetcher,
    sockets,
    get historyFetches() {
      return historyFetches
    },
  }
}

describe("Hermes native browser client", () => {
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
