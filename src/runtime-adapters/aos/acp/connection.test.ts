import {
  agent,
  methods,
  RequestError,
  type AgentApp,
  type AgentContext,
  type AnyWireMessage,
  type SessionConfigOption,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"
import type { WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { INTERACTION_PROTOCOL } from "@aos/protocol"
import {
  AOS_AUTH_METHOD_INVITE,
  AOS_JSONRPC_ERRORS,
  AOS_METHODS,
  AOS_META_KEY,
  AOS_STOP_REASONS,
  type AosSessionNewResponseMetaSchema,
} from "@aos/protocol/acp"

import { createAcpConnection } from "./connection"
import type { AcpPendingRequest } from "./types"

const SESSION_ID = "session-1"
const AGENT_ID = "agent-1"
const UPDATED_AT = "2026-09-19T10:00:00.000Z"
const CLIENT_INFO = { name: "aos-ui", version: "1.2.3" }

type AcpCapabilities = z.infer<
  typeof AosSessionNewResponseMetaSchema
>["capabilities"]

const unavailable = { status: "unavailable", reason: "not-supported" } as const

function capabilities(): AcpCapabilities {
  return {
    workspace: {
      slashCommands: {
        status: "available",
        scope: "attached-session",
        commands: [{ name: "help" }],
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
      todos: unavailable,
      activity: unavailable,
    },
    interactions: {
      steering: {
        status: "available",
        scope: "active-turn",
        semantics: "visible-user-message",
        input: "text",
        fallback: "provider-queue",
      },
      approvals: {
        status: "available",
        protocol: INTERACTION_PROTOCOL,
        scope: "turn",
        choices: [{ value: "once", scope: "request" }],
        maxPending: 8,
      },
      questions: {
        status: "available",
        protocol: INTERACTION_PROTOCOL,
        scope: "turn",
        answerModes: ["single", "multiple", "free-text"],
        cancellation: "native-empty-answer",
        maxQuestions: 8,
        maxChoicesPerQuestion: 8,
        maxAnswerValuesPerQuestion: 8,
        maxStringBytes: 4_096,
      },
      reactions: unavailable,
    },
    content: {
      attachments: unavailable,
      artifacts: unavailable,
      transcription: unavailable,
      speech: unavailable,
    },
  }
}

function sessionInfoMeta() {
  return { agentId: AGENT_ID, status: "idle", archived: false, unread: true }
}

function modelOption(currentValue: string): SessionConfigOption {
  return {
    configId: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: [
      { value: "sonnet", name: "Sonnet" },
      { value: "opus", name: "Opus" },
    ],
  }
}

function catalogEntry() {
  return {
    summary: { kind: "ready", id: AGENT_ID, name: "Research" },
    visibility: "visible",
    selectable: true,
    editable: true,
    revision: "revision-1",
  }
}

type AgentCall = { method: string; params: unknown }

/** An in-process proxy: the AOS agent side of the connection under test. */
function createProxyAgent(
  options: { resyncOnResume?: number; refuseLoginAfter?: number } = {}
) {
  const calls: AgentCall[] = []
  let peer: AgentContext | undefined
  let resumes = 0
  let logins = 0
  const record = (method: string, params: unknown) => {
    calls.push({ method, params })
  }
  const app = agent({ name: "fake-aos-proxy" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      record("initialize", params)
      return {
        protocolVersion: 2,
        info: { name: "aos-proxy", version: "9.9.9" },
        _meta: {
          [AOS_META_KEY]: {
            version: 1,
            lane: "operator",
            extensions: {
              steer: true,
              rewind: true,
              artifacts: true,
              composerPrefill: true,
              agents: true,
              invalidation: true,
              activity: true,
              readState: true,
              focus: true,
              guestProjection: false,
            },
          },
        },
      }
    })
    .onRequest(methods.agent.auth.login, ({ params }) => {
      record(methods.agent.auth.login, params)
      logins += 1
      if (
        options.refuseLoginAfter !== undefined &&
        logins > options.refuseLoginAfter
      )
        throw new RequestError(
          AOS_JSONRPC_ERRORS.authenticationRequired,
          "authentication_required"
        )
      return {}
    })
    .onRequest(methods.agent.session.new, ({ params }) => {
      record(methods.agent.session.new, params)
      return {
        sessionId: SESSION_ID,
        configOptions: [modelOption("sonnet")],
        _meta: {
          [AOS_META_KEY]: {
            session: sessionInfoMeta(),
            capabilities: capabilities(),
          },
        },
      }
    })
    .onRequest(methods.agent.session.list, ({ params }) => {
      record(methods.agent.session.list, params)
      return {
        sessions: [
          {
            sessionId: SESSION_ID,
            cwd: "/workspace",
            updatedAt: UPDATED_AT,
            _meta: { [AOS_META_KEY]: sessionInfoMeta() },
          },
        ],
        nextCursor: "cursor-2",
      }
    })
    .onRequest(methods.agent.session.resume, ({ params }) => {
      record(methods.agent.session.resume, params)
      resumes += 1
      return {
        configOptions: [modelOption("opus")],
        _meta: {
          [AOS_META_KEY]: {
            session: sessionInfoMeta(),
            execution: { status: "running", turnId: "run-1" },
            capabilities: capabilities(),
            ...(resumes === options.resyncOnResume ? { resync: true } : {}),
          },
        },
      }
    })
    .onRequest(methods.agent.session.prompt, ({ params }) => {
      record(methods.agent.session.prompt, params)
      return { _meta: { [AOS_META_KEY]: { messageId: "message-7" } } }
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      record(methods.agent.session.setConfigOption, params)
      return { configOptions: [modelOption("opus")] }
    })
    .onRequest(methods.agent.session.close, ({ params }) => {
      record(methods.agent.session.close, params)
      return {}
    })
    .onRequest(methods.agent.session.delete, ({ params }) => {
      record(methods.agent.session.delete, params)
      return {}
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      record(methods.agent.session.cancel, params)
    })
    .onRequest(AOS_METHODS.session.update, z.unknown(), ({ params }) => {
      record(AOS_METHODS.session.update, params)
      return {}
    })
    .onRequest(AOS_METHODS.session.steer, z.unknown(), ({ params }) => {
      record(AOS_METHODS.session.steer, params)
      return { status: "queued" }
    })
    .onRequest(
      AOS_METHODS.agents.list,
      z.unknown().optional(),
      ({ params }) => {
        record(AOS_METHODS.agents.list, params)
        return { revision: "revision-1", agents: [catalogEntry()] }
      }
    )
    .onRequest(AOS_METHODS.agents.setVisibility, z.unknown(), ({ params }) => {
      record(AOS_METHODS.agents.setVisibility, params)
      return { revision: "revision-2", agent: catalogEntry() }
    })
    .onNotification(AOS_METHODS.session.focus, z.unknown(), ({ params }) => {
      record(AOS_METHODS.session.focus, params)
    })
    .onConnect((connection) => {
      peer = connection.client
    })

  return {
    app,
    calls,
    callsOf: (method: string) =>
      calls.flatMap((call) => (call.method === method ? [call.params] : [])),
    paramsOf: (method: string) =>
      calls.find((call) => call.method === method)?.params,
    pushUpdate(update: SessionUpdate, meta?: Record<string, unknown>) {
      return peer?.notify(methods.client.session.update, {
        sessionId: SESSION_ID,
        update: {
          ...update,
          ...(meta ? { _meta: { [AOS_META_KEY]: meta } } : {}),
        },
      })
    },
    notify(method: string, params: unknown) {
      return peer?.notify(method, params)
    },
    askPermission() {
      return peer?.request(methods.client.session.requestPermission, {
        sessionId: SESSION_ID,
        title: "Run the tool?",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        _meta: {
          [AOS_META_KEY]: { requestId: "interrupt-1", message: "read file" },
        },
      })
    },
  }
}

/** A WebSocket-shaped pipe to an in-process agent app. */
function pipedSocketConstructor(app: AgentApp): WebSocketConstructor {
  return class PipedSocket extends EventTarget {
    readyState = 0
    readonly #inbound = new TransformStream<AnyWireMessage, AnyWireMessage>()
    readonly #writer: WritableStreamDefaultWriter<AnyWireMessage>

    constructor() {
      super()
      const outbound = new TransformStream<AnyWireMessage, AnyWireMessage>()
      app.connect({
        readable: this.#inbound.readable,
        writable: outbound.writable,
      })
      this.#writer = this.#inbound.writable.getWriter()
      void this.#pump(outbound.readable.getReader())
      queueMicrotask(() => {
        this.readyState = 1
        this.dispatchEvent(new Event("open"))
      })
    }

    async #pump(reader: ReadableStreamDefaultReader<AnyWireMessage>) {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(value) })
        )
      }
    }

    send(data: string) {
      void this.#writer.write(JSON.parse(data))
    }

    close() {
      this.readyState = 3
      this.dispatchEvent(new Event("close"))
    }
  }
}

function connectInProcess(proxy: ReturnType<typeof createProxyAgent>) {
  const connection = createAcpConnection({
    clientInfo: CLIENT_INFO,
    connectAgent: proxy.app,
  })
  connection.start()
  return connection
}

describe("ACP connection", () => {
  it("constructs no transport until it is started, and only one", async () => {
    const proxy = createProxyAgent()
    const sockets: unknown[] = []
    const socketConstructor = pipedSocketConstructor(proxy.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://proxy.test/api/aos/v1/acp",
      socketConstructor: class extends socketConstructor {
        constructor(url: string) {
          super(url)
          sockets.push(this)
        }
      },
    })

    expect(sockets).toHaveLength(0)

    connection.start()
    connection.start()
    await connection.initialized

    expect(sockets).toHaveLength(1)
    connection.close()
    connection.close()
    expect(connection.status).toBe("closed")
  })

  it("stays closed when a connection is closed before it starts", async () => {
    const proxy = createProxyAgent()
    const sockets: unknown[] = []
    const socketConstructor = pipedSocketConstructor(proxy.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://proxy.test/api/aos/v1/acp",
      socketConstructor: class extends socketConstructor {
        constructor(url: string) {
          super(url)
          sockets.push(this)
        }
      },
    })

    connection.close()
    connection.start()

    expect(sockets).toHaveLength(0)
    expect(connection.status).toBe("closed")
    await expect(connection.initialized).rejects.toThrow()
  })

  it("initializes with the negotiated AOS extension metadata", async () => {
    const proxy = createProxyAgent()
    const connection = connectInProcess(proxy)

    await expect(connection.initialized).resolves.toEqual({
      version: 1,
      lane: "operator",
      extensions: expect.objectContaining({ readState: true, focus: true }),
    })
    expect(proxy.paramsOf("initialize")).toMatchObject({
      protocolVersion: 2,
      info: CLIENT_INFO,
    })
    await vi.waitFor(() => expect(connection.status).toBe("ready"))
    connection.close()
    expect(connection.status).toBe("closed")
  })

  it("redeems an invitation with the AOS login metadata", async () => {
    const proxy = createProxyAgent()
    const connection = connectInProcess(proxy)
    await connection.initialized

    await connection.login("invitation-token")

    expect(proxy.paramsOf(methods.agent.auth.login)).toEqual({
      methodId: AOS_AUTH_METHOD_INVITE,
      _meta: { [AOS_META_KEY]: { token: "invitation-token" } },
    })
    connection.close()
  })

  it("creates, lists, resumes, and prompts Sessions with AOS metadata", async () => {
    const proxy = createProxyAgent()
    const connection = connectInProcess(proxy)

    const created = await connection.newSession({
      agentId: AGENT_ID,
      title: "Weekly report",
    })
    expect(created.sessionId).toBe(SESSION_ID)
    expect(created.configOptions).toHaveLength(1)
    expect(created.meta.session).toMatchObject({ agentId: AGENT_ID })
    expect(proxy.paramsOf(methods.agent.session.new)).toMatchObject({
      cwd: "/",
      _meta: { [AOS_META_KEY]: { agentId: AGENT_ID, title: "Weekly report" } },
    })

    const listed = await connection.listSessions(
      { agentId: AGENT_ID },
      "cursor-1"
    )
    expect(listed.sessions[0]?.sessionId).toBe(SESSION_ID)
    expect(listed.nextCursor).toBe("cursor-2")
    expect(proxy.paramsOf(methods.agent.session.list)).toMatchObject({
      cursor: "cursor-1",
      _meta: { [AOS_META_KEY]: { agentId: AGENT_ID } },
    })

    const resumed = await connection.resumeSession(SESSION_ID, {
      replayFromStart: false,
      after: 12,
      turnId: "run-1",
    })
    expect(resumed.meta.execution).toEqual({
      status: "running",
      turnId: "run-1",
    })
    // The owner reported by `session/new` travels on every later resume.
    expect(proxy.paramsOf(methods.agent.session.resume)).toMatchObject({
      sessionId: SESSION_ID,
      _meta: {
        [AOS_META_KEY]: { agentId: AGENT_ID, after: 12, turnId: "run-1" },
      },
    })
    expect(proxy.paramsOf(methods.agent.session.resume)).not.toHaveProperty(
      "replayFrom"
    )

    await expect(
      connection.prompt(SESSION_ID, [{ type: "text", text: "Hello" }], {
        attachmentStageId: "stage-1",
      })
    ).resolves.toEqual({ messageId: "message-7" })
    expect(proxy.paramsOf(methods.agent.session.prompt)).toMatchObject({
      sessionId: SESSION_ID,
      prompt: [{ type: "text", text: "Hello" }],
      _meta: { [AOS_META_KEY]: { attachmentStageId: "stage-1" } },
    })
    connection.close()
  })

  it("replays a Session from the start when asked", async () => {
    const proxy = createProxyAgent()
    const connection = connectInProcess(proxy)
    const replaySettled = vi.fn()
    const dropTranscript = vi.fn(() => replaySettled)
    connection.onSessionReplay(SESSION_ID, dropTranscript)

    const resumed = connection.resumeSession(SESSION_ID, {
      replayFromStart: true,
      agentId: AGENT_ID,
    })
    expect(replaySettled).not.toHaveBeenCalled()
    await resumed
    expect(replaySettled).toHaveBeenCalledTimes(1)

    expect(proxy.paramsOf(methods.agent.session.resume)).toMatchObject({
      replayFrom: { type: "start" },
      _meta: { [AOS_META_KEY]: { agentId: AGENT_ID } },
    })
    // The whole Session is on its way, so whoever projects it is told to drop
    // what this replay resends.
    expect(dropTranscript).toHaveBeenCalledTimes(1)

    await connection.resumeSession(SESSION_ID, { replayFromStart: false })
    // An incremental resume replaces nothing already projected.
    expect(dropTranscript).toHaveBeenCalledTimes(1)
    connection.close()
  })

  it("writes Session config, lifecycle, and AOS extension requests", async () => {
    const proxy = createProxyAgent()
    const connection = connectInProcess(proxy)

    const options = await connection.setConfigOption(
      SESSION_ID,
      "model",
      "opus"
    )
    expect(options[0]).toMatchObject({ currentValue: "opus" })
    expect(proxy.paramsOf(methods.agent.session.setConfigOption)).toMatchObject(
      {
        sessionId: SESSION_ID,
        configId: "model",
        type: "id",
        value: "opus",
      }
    )

    await connection.closeSession(SESSION_ID)
    await connection.deleteSession(SESSION_ID)
    await connection.updateSession({ sessionId: SESSION_ID, unread: false })
    expect(proxy.paramsOf(AOS_METHODS.session.update)).toEqual({
      sessionId: SESSION_ID,
      unread: false,
    })

    await expect(
      connection.steer({
        sessionId: SESSION_ID,
        requestId: "request-1",
        text: "focus on tests",
      })
    ).resolves.toEqual({ status: "queued" })

    const catalog = await connection.listAgents()
    expect(catalog.agents[0]?.summary.id).toBe(AGENT_ID)
    const visibility = await connection.setVisibility({
      agentId: AGENT_ID,
      visibility: "hidden",
      revision: "revision-1",
    })
    expect(visibility.revision).toBe("revision-2")
    expect(proxy.paramsOf(AOS_METHODS.agents.setVisibility)).toEqual({
      agentId: AGENT_ID,
      visibility: "hidden",
      revision: "revision-1",
    })
    connection.close()
  })

  it("sends cancel and focus as notifications", async () => {
    const proxy = createProxyAgent()
    const connection = connectInProcess(proxy)
    await connection.initialized

    connection.cancel(SESSION_ID)
    connection.focus(null, { foreground: true, idle: false })

    await vi.waitFor(() => {
      expect(proxy.paramsOf(methods.agent.session.cancel)).toEqual({
        sessionId: SESSION_ID,
      })
      expect(proxy.paramsOf(AOS_METHODS.session.focus)).toEqual({
        sessionId: null,
        foreground: true,
        idle: false,
      })
    })
    connection.close()
  })

  it("dispatches Session updates with their AOS metadata and tracks the run position", async () => {
    const proxy = createProxyAgent()
    const connection = connectInProcess(proxy)
    await connection.initialized
    const seen: { update: SessionUpdate; meta?: Record<string, unknown> }[] = []
    const unsubscribe = connection.onSessionUpdate(SESSION_ID, (update, meta) =>
      seen.push({ update, meta })
    )

    await proxy.pushUpdate(
      {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: AOS_STOP_REASONS.error,
      },
      { sequence: 7, turnId: "run-1", code: "AOS_SEND_FAILED" }
    )

    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]?.update).toMatchObject({ sessionUpdate: "state_update" })
    expect(seen[0]?.meta).toMatchObject({ sequence: 7, turnId: "run-1" })
    expect(connection.lastSequence(SESSION_ID)).toEqual({
      turnId: "run-1",
      after: 7,
    })

    unsubscribe()
    await proxy.pushUpdate(
      { sessionUpdate: "state_update", state: "running" },
      { sequence: 8, turnId: "run-1" }
    )
    await vi.waitFor(() =>
      expect(connection.lastSequence(SESSION_ID)).toEqual({
        turnId: "run-1",
        after: 8,
      })
    )
    expect(seen).toHaveLength(1)
    connection.close()
  })

  it("dispatches AOS extension notifications by method", async () => {
    const proxy = createProxyAgent()
    const connection = connectInProcess(proxy)
    await connection.initialized
    const activity: unknown[] = []
    let catalogInvalidations = 0
    connection.onNotification(AOS_METHODS.notify.activity, (params) =>
      activity.push(params)
    )
    connection.onNotification(AOS_METHODS.notify.catalogInvalidated, () => {
      catalogInvalidations += 1
    })

    await proxy.notify(AOS_METHODS.notify.activity, {
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      occurredAt: UPDATED_AT,
      type: "turn-started",
      turnId: "lifecycle-1",
    })
    await proxy.notify(AOS_METHODS.notify.catalogInvalidated, undefined)

    await vi.waitFor(() => {
      expect(activity).toHaveLength(1)
      expect(catalogInvalidations).toBe(1)
    })
    expect(activity[0]).toMatchObject({ type: "turn-started" })
    connection.close()
  })

  it("answers a pending permission request with the operator's response", async () => {
    const proxy = createProxyAgent()
    const connection = connectInProcess(proxy)
    await connection.initialized
    const pending: AcpPendingRequest[] = []
    connection.onPendingRequest((request) => pending.push(request))

    const answered = proxy.askPermission()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    const request = pending[0]
    expect(request?.kind).toBe("permission")
    expect(request?.sessionId).toBe(SESSION_ID)
    if (request?.kind !== "permission") throw new Error("expected permission")
    expect(request.request.title).toBe("Run the tool?")
    request.respond({ outcome: { outcome: "selected", optionId: "allow" } })

    await expect(answered).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "allow" },
    })
    connection.close()
  })

  it("keeps a pending request answerable when one consumer cannot show it", async () => {
    const proxy = createProxyAgent()
    const connection = connectInProcess(proxy)
    await connection.initialized
    const pending: AcpPendingRequest[] = []
    connection.onPendingRequest(() => {
      throw new Error("this consumer cannot project the request")
    })
    connection.onPendingRequest((request) => pending.push(request))

    const answered = proxy.askPermission()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    const request = pending[0]
    if (request?.kind !== "permission") throw new Error("expected permission")
    request.respond({ outcome: { outcome: "selected", optionId: "allow" } })

    await expect(answered).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "allow" },
    })
    connection.close()
  })

  it("reconnects a dropped transport and resumes every attached Session", async () => {
    const proxy = createProxyAgent({ resyncOnResume: 2 })
    const sockets: { close: () => void }[] = []
    const socketConstructor = pipedSocketConstructor(proxy.app)
    const delays: number[] = []
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://proxy.test/api/aos/v1/acp",
      socketConstructor: class extends socketConstructor {
        constructor(url: string) {
          super(url)
          sockets.push(this)
        }
      },
      schedule: (delayMs, task) => {
        delays.push(delayMs)
        task()
      },
    })
    connection.start()
    await connection.initialized
    connection.onSessionUpdate(SESSION_ID, () => {})
    await connection.resumeSession(SESSION_ID, {
      replayFromStart: false,
      agentId: AGENT_ID,
    })
    connection.focus(SESSION_ID, { foreground: true, idle: true })
    await proxy.pushUpdate(
      { sessionUpdate: "state_update", state: "running" },
      { sequence: 4, turnId: "run-1" }
    )
    await vi.waitFor(() =>
      expect(connection.lastSequence(SESSION_ID)).toBeDefined()
    )

    sockets[0]?.close()

    await vi.waitFor(() =>
      expect(proxy.callsOf(methods.agent.session.resume)).toHaveLength(3)
    )
    expect(delays).toEqual([250])
    expect(proxy.callsOf(methods.agent.session.resume)[1]).toMatchObject({
      _meta: {
        [AOS_META_KEY]: { agentId: AGENT_ID, after: 4, turnId: "run-1" },
      },
    })
    expect(proxy.callsOf(methods.agent.session.resume)[2]).toMatchObject({
      replayFrom: { type: "start" },
    })
    // The proxy forgot this connection's presence when the transport dropped, so
    // the report arrives again before the replay it would otherwise contradict.
    const reports = proxy.calls.flatMap((call, index) =>
      call.method === AOS_METHODS.session.focus ? [{ ...call, index }] : []
    )
    expect(reports).toHaveLength(2)
    expect(reports[1]?.params).toEqual({
      sessionId: SESSION_ID,
      foreground: true,
      idle: true,
    })
    const replays = proxy.calls.flatMap((call, index) =>
      call.method === methods.agent.session.resume ? [index] : []
    )
    expect(reports[1]!.index).toBeLessThan(replays[1]!)
    await vi.waitFor(() => expect(connection.status).toBe("ready"))
    expect(sockets).toHaveLength(2)
    connection.close()
  })

  it("redeems the invitation again before replaying a recovered transport", async () => {
    const proxy = createProxyAgent()
    const sockets: { close: () => void }[] = []
    const socketConstructor = pipedSocketConstructor(proxy.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://guest.test/api/guest/v1/acp",
      socketConstructor: class extends socketConstructor {
        constructor(url: string) {
          super(url)
          sockets.push(this)
        }
      },
      schedule: (_delayMs, task) => task(),
    })
    connection.start()
    await connection.initialized
    await connection.login("invitation-token")
    connection.onSessionUpdate(SESSION_ID, () => {})
    await connection.resumeSession(SESSION_ID, { replayFromStart: true })

    sockets[0]?.close()

    await vi.waitFor(() =>
      expect(proxy.callsOf(methods.agent.session.resume)).toHaveLength(2)
    )
    expect(
      proxy.calls
        .map(({ method }) => method)
        .filter(
          (method) =>
            method === methods.agent.auth.login ||
            method === methods.agent.session.resume
        )
    ).toEqual([
      methods.agent.auth.login,
      methods.agent.session.resume,
      methods.agent.auth.login,
      methods.agent.session.resume,
    ])
    connection.close()
  })

  it("ends the connection when the invitation can no longer be redeemed", async () => {
    const proxy = createProxyAgent({ refuseLoginAfter: 1 })
    const sockets: { close: () => void }[] = []
    const socketConstructor = pipedSocketConstructor(proxy.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://guest.test/api/guest/v1/acp",
      socketConstructor: class extends socketConstructor {
        constructor(url: string) {
          super(url)
          sockets.push(this)
        }
      },
      schedule: (_delayMs, task) => task(),
    })
    connection.start()
    await connection.initialized
    await connection.login("invitation-token")
    connection.onSessionUpdate(SESSION_ID, () => {})
    await connection.resumeSession(SESSION_ID, { replayFromStart: true })

    sockets[0]?.close()

    await vi.waitFor(() => expect(connection.status).toBe("closed"))
    // A refused invitation stops the reconnect loop instead of replaying.
    expect(proxy.callsOf(methods.agent.auth.login)).toHaveLength(2)
    expect(proxy.callsOf(methods.agent.session.resume)).toHaveLength(1)
    expect(sockets).toHaveLength(2)
  })
})
