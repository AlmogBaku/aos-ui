import {
  agent,
  methods,
  RequestError,
  type AgentContext,
  type SessionConfigOption,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { z } from "zod"

import {
  AOS_AUTH_METHOD_INVITE,
  AOS_JSONRPC_ERRORS,
  AOS_METHODS,
  AOS_META_KEY,
  AOS_REPLAY_BEFORE,
  AOS_STOP_REASONS,
  AosReplayBeforeSchema,
  type AosHistoryCursor,
} from "@aos/protocol/acp"

import { AgentUpdateError } from "@/runtime-adapters/contracts"

import { useFakeClock } from "../../../../test/support/fake-clock"
import { captureLogs } from "../../../../test/support/log-capture"

import { createAcpConnection } from "./connection"
import { PART_GRACE_MS } from "./limits"
import { pipedSockets } from "./test-socket"
import type { AcpPendingRequest } from "./types"

const SESSION_ID = "session-1"
const AGENT_ID = "agent-1"
const UPDATED_AT = "2026-09-19T10:00:00.000Z"
const CLIENT_INFO = { name: "aos-ui", version: "1.2.3" }

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

/** The folder the catalog names for the Agent, the one `cwd` it takes. */
const FOLDER = "/srv/research"

function catalogEntry() {
  return {
    summary: { kind: "ready", id: AGENT_ID, name: "Research" },
    visibility: "visible",
    selectable: true,
    editable: true,
    avatarEditable: true,
    folder: FOLDER,
    revision: "revision-1",
  }
}

type AgentCall = { method: string; params: unknown }

/** Recorded once the fake has answered a plain resume, for ordering checks. */
const RESUME_REPLIED = "session/resume:replied"

/** An in-process proxy: the AOS agent side of the connection under test. */
function createProxyAgent(
  options: {
    resyncOnResume?: number
    refuseLoginAfter?: number
    /** `_meta.aos.history` on every resume that replays from the start. */
    history?: AosHistoryCursor
    /** What a `_aos/before` page read streams, and the cursor it replies with. */
    page?: {
      updates: readonly (readonly [SessionUpdate, Record<string, unknown>])[]
      history?: AosHistoryCursor
    }
    /** Holds each plain resume open briefly, as a real rejoin takes time. */
    slowResume?: boolean
    /** The build id the proxy answers `initialize` with. */
    buildId?: string
    /** The JSON-RPC code an Agent update is refused with. */
    refuseAgentUpdate?: number
  } = {}
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
        info: { name: "aos-proxy", version: options.buildId ?? "9.9.9" },
        _meta: {
          [AOS_META_KEY]: {
            version: 1,
            role: "operator",
            extensions: {
              steer: true,
              rewind: true,
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
        throw RequestError.authRequired()
      return {}
    })
    .onRequest(methods.agent.session.new, ({ params }) => {
      record(methods.agent.session.new, params)
      return { sessionId: SESSION_ID }
    })
    .onRequest(methods.agent.session.list, ({ params }) => {
      record(methods.agent.session.list, params)
      return {
        sessions: [
          {
            sessionId: SESSION_ID,
            cwd: FOLDER,
            updatedAt: UPDATED_AT,
            _meta: { [AOS_META_KEY]: sessionInfoMeta() },
          },
        ],
        nextCursor: "cursor-2",
      }
    })
    .onRequest(methods.agent.session.resume, async ({ params }) => {
      record(methods.agent.session.resume, params)
      const replayFrom = params.replayFrom
      if (replayFrom?.type === AOS_REPLAY_BEFORE) {
        const { cursor } = AosReplayBeforeSchema.parse(replayFrom)
        for (const [update, meta] of options.page?.updates ?? [])
          await peer?.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              ...update,
              _meta: {
                [AOS_META_KEY]: { ...meta, historyPage: { cursor } },
              },
            },
          })
        const history = options.page?.history
        return {
          _meta: { [AOS_META_KEY]: history === undefined ? {} : { history } },
        }
      }
      resumes += 1
      if (options.slowResume)
        await new Promise((resolve) => setTimeout(resolve, 20))
      record(RESUME_REPLIED, params)
      const replayed = replayFrom?.type === "start"
      return {
        _meta: {
          [AOS_META_KEY]: {
            ...(resumes === options.resyncOnResume ? { resync: true } : {}),
            ...(replayed && options.history
              ? { history: options.history }
              : {}),
          },
        },
      }
    })
    .onRequest(methods.agent.session.prompt, ({ params }) => {
      record(methods.agent.session.prompt, params)
      return { messageId: "message-7" }
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
    .onRequest(AOS_METHODS.agents.update, z.unknown(), ({ params }) => {
      record(AOS_METHODS.agents.update, params)
      if (options.refuseAgentUpdate !== undefined)
        throw new RequestError(options.refuseAgentUpdate, "refused")
      return { revision: "revision-2", agent: catalogEntry() }
    })
    .onRequest(AOS_METHODS.session.focus, z.unknown(), ({ params }) => {
      record(AOS_METHODS.session.focus, params)
      return {}
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
    /** Aborting `withdrawal` withdraws the request with `$/cancel_request`. */
    askPermission(withdrawal?: AbortSignal) {
      return peer?.request(
        methods.client.session.requestPermission,
        {
          sessionId: SESSION_ID,
          title: "Run the tool?",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          _meta: {
            [AOS_META_KEY]: { requestId: "interrupt-1", message: "read file" },
          },
        },
        withdrawal ? { cancellationSignal: withdrawal } : undefined
      )
    },
    /** Aborting `withdrawal` withdraws the question with `$/cancel_request`. */
    askQuestion(withdrawal?: AbortSignal) {
      return peer?.request(
        methods.client.elicitation.create,
        {
          sessionId: SESSION_ID,
          mode: "form",
          message: "Which one?",
          requestedSchema: { type: "object", properties: {} },
          _meta: { [AOS_META_KEY]: { requestId: "interrupt-2" } },
        },
        withdrawal ? { cancellationSignal: withdrawal } : undefined
      )
    },
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
    const pipe = pipedSockets(() => proxy.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://proxy.test/api/aos/v1/acp",
      socketConstructor: pipe.WebSocket,
    })

    expect(pipe.sockets).toHaveLength(0)

    connection.start()
    connection.start()
    await connection.initialized

    expect(pipe.sockets).toHaveLength(1)
    connection.close()
    connection.close()
    expect(connection.status).toBe("closed")
  })

  it("stays closed when a connection is closed before it starts", async () => {
    const proxy = createProxyAgent()
    const pipe = pipedSockets(() => proxy.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://proxy.test/api/aos/v1/acp",
      socketConstructor: pipe.WebSocket,
    })

    connection.close()
    connection.start()

    expect(pipe.sockets).toHaveLength(0)
    expect(connection.status).toBe("closed")
    await expect(connection.initialized).rejects.toThrow()
  })

  it("holds a first request until the debug inspector settles, and runs without one that cannot load", async () => {
    vi.doMock("@statelyai/inspect", () => {
      throw new Error("The inspector is unavailable")
    })
    globalThis.history.replaceState(null, "", "?debug=acp")
    onTestFinished(() => {
      vi.doUnmock("@statelyai/inspect")
      globalThis.history.replaceState(null, "", "/")
      globalThis.sessionStorage.clear()
    })
    const connection = connectInProcess(createProxyAgent())

    await expect(connection.listAgents()).resolves.toBeDefined()
    connection.close()
  })

  it("initializes with the negotiated AOS extension metadata", async () => {
    const proxy = createProxyAgent()
    const connection = connectInProcess(proxy)

    await expect(connection.initialized).resolves.toEqual({
      version: 1,
      role: "operator",
      extensions: expect.objectContaining({ readState: true, focus: true }),
    })
    expect(proxy.paramsOf("initialize")).toMatchObject({
      protocolVersion: 2,
      info: CLIENT_INFO,
      // The question composer answers form elicitations.
      capabilities: { elicitation: { form: {} } },
    })
    await vi.waitFor(() => expect(connection.status).toBe("ready"))
    connection.close()
    expect(connection.status).toBe("closed")
  })

  it("redeems an invitation with the AOS login metadata, never logging it", async () => {
    const proxy = createProxyAgent()
    const logs = captureLogs()
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://guest.test/api/guest/v1/acp",
      socketConstructor: pipedSockets(() => proxy.app).WebSocket,
      logger: logs.logger,
    })
    connection.start()

    await connection.login("invitation-token")

    expect(proxy.paramsOf(methods.agent.auth.login)).toEqual({
      methodId: AOS_AUTH_METHOD_INVITE,
      _meta: { [AOS_META_KEY]: { token: "invitation-token" } },
    })
    expect(logs.records()).toContainEqual(
      expect.objectContaining({
        message: "acp.frame",
        fields: expect.objectContaining({
          method: methods.agent.auth.login,
          requestId: expect.anything(),
        }),
      })
    )
    expect(JSON.stringify(logs.records())).not.toContain("invitation-token")
    connection.close()
  })

  it("creates, lists, resumes, and prompts Sessions with AOS metadata", async () => {
    const proxy = createProxyAgent()
    const connection = connectInProcess(proxy)

    const created = await connection.newSession({
      agentId: AGENT_ID,
      title: "Weekly report",
    })
    expect(created).toEqual({ sessionId: SESSION_ID })
    expect(proxy.paramsOf(methods.agent.session.new)).toMatchObject({
      cwd: FOLDER,
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

    // `session/new` joined the Session, so opening it resumes nothing; the
    // Agent it was created in travels on every later resume.
    connection.subscribe(SESSION_ID, {})
    await connection.replay(SESSION_ID)
    expect(proxy.callsOf(methods.agent.session.resume)).toHaveLength(1)
    expect(proxy.paramsOf(methods.agent.session.resume)).toMatchObject({
      sessionId: SESSION_ID,
      replayFrom: { type: "start" },
      _meta: { [AOS_META_KEY]: { agentId: AGENT_ID } },
    })

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
    connection.subscribe(SESSION_ID, {
      agentId: AGENT_ID,
      replay: dropTranscript,
    })

    // The opening join is the replay asked for, not a second one.
    const replayed = connection.replay(SESSION_ID)
    expect(replaySettled).not.toHaveBeenCalled()
    await replayed
    expect(replaySettled).toHaveBeenCalledTimes(1)

    expect(proxy.callsOf(methods.agent.session.resume)).toHaveLength(1)
    expect(proxy.paramsOf(methods.agent.session.resume)).toMatchObject({
      replayFrom: { type: "start" },
      _meta: { [AOS_META_KEY]: { agentId: AGENT_ID } },
    })
    // The whole Session is on its way, so whoever projects it is told to drop
    // what this replay resends.
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
    const updated = await connection.updateAgent({
      agentId: AGENT_ID,
      visibility: "hidden",
      avatar: null,
      revision: "revision-1",
    })
    expect(updated.revision).toBe("revision-2")
    expect(proxy.paramsOf(AOS_METHODS.agents.update)).toEqual({
      agentId: AGENT_ID,
      visibility: "hidden",
      avatar: null,
      revision: "revision-1",
    })
    connection.close()
  })

  it.each([
    [AOS_JSONRPC_ERRORS.unsupported, "unsupported"],
    [AOS_JSONRPC_ERRORS.revisionConflict, "conflict"],
  ] as const)(
    "names an Agent update refused with code %i as %s",
    async (refusal, code) => {
      const proxy = createProxyAgent({ refuseAgentUpdate: refusal })
      const connection = connectInProcess(proxy)
      await connection.initialized

      const failure = await connection
        .updateAgent({ agentId: AGENT_ID, avatar: "ring/blue", revision: "r" })
        .catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(AgentUpdateError)
      expect(failure).toMatchObject({ code })
      connection.close()
    }
  )

  it("leaves any other Agent update failure as it came", async () => {
    const proxy = createProxyAgent({
      refuseAgentUpdate: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
    })
    const connection = connectInProcess(proxy)
    await connection.initialized

    const failure = await connection
      .updateAgent({ agentId: AGENT_ID, avatar: "ring/blue", revision: "r" })
      .catch((error: unknown) => error)

    expect(failure).not.toBeInstanceOf(AgentUpdateError)
    expect(failure).toMatchObject({
      code: AOS_JSONRPC_ERRORS.temporarilyUnavailable,
    })
    connection.close()
  })

  it("sends cancel as a notification and focus as a request", async () => {
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

  it("dispatches Session updates with their AOS metadata to the Session's listeners", async () => {
    const proxy = createProxyAgent()
    const connection = connectInProcess(proxy)
    await connection.initialized
    const seen: { update: SessionUpdate; meta?: Record<string, unknown> }[] = []
    const unsubscribe = connection.subscribe(SESSION_ID, {
      update: (update, meta) => seen.push({ update, meta }),
    })

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

    unsubscribe()
    const stayed = vi.fn()
    connection.subscribe(SESSION_ID, { update: stayed })
    await proxy.pushUpdate(
      { sessionUpdate: "state_update", state: "running" },
      { sequence: 8, turnId: "run-1" }
    )
    await vi.waitFor(() => expect(stayed).toHaveBeenCalledTimes(1))
    expect(seen).toHaveLength(1)
    connection.close()
  })

  it("keeps a Session joined while any subscription of a listener stays", async () => {
    const clock = useFakeClock()
    const proxy = createProxyAgent()
    const connection = connectInProcess(proxy)
    const listener = { agentId: AGENT_ID }
    const leave = connection.subscribe(SESSION_ID, listener)
    connection.subscribe(SESSION_ID, listener)
    await connection.joined(SESSION_ID)

    leave()
    await clock.advance(PART_GRACE_MS)
    expect(proxy.callsOf(methods.agent.session.close)).toHaveLength(0)
    connection.close()
  })

  it("dispatches AOS extension notifications by method", async () => {
    const proxy = createProxyAgent()
    const connection = connectInProcess(proxy)
    await connection.initialized
    const activity: unknown[] = []
    let catalogInvalidations = 0
    connection.subscribeNotification(AOS_METHODS.notify.activity, (params) =>
      activity.push(params)
    )
    connection.subscribeNotification(
      AOS_METHODS.notify.catalogInvalidated,
      () => {
        catalogInvalidations += 1
      }
    )

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
    connection.subscribePendingRequests((request) => pending.push(request))

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

  it.each(["askPermission", "askQuestion"] as const)(
    "releases a request the proxy withdraws as cancelled (%s)",
    async (ask) => {
      const proxy = createProxyAgent()
      const connection = connectInProcess(proxy)
      await connection.initialized
      const pending: AcpPendingRequest[] = []
      connection.subscribePendingRequests((request) => pending.push(request))
      const withdrawal = new AbortController()

      const answered = proxy[ask](withdrawal.signal)
      await vi.waitFor(() => expect(pending).toHaveLength(1))
      withdrawal.abort()

      await expect(answered).rejects.toMatchObject({ code: -32800 })
      expect(pending[0]?.signal.aborted).toBe(true)
      connection.close()
    }
  )

  it("keeps a pending request answerable when one consumer cannot show it", async () => {
    const proxy = createProxyAgent()
    const connection = connectInProcess(proxy)
    await connection.initialized
    const pending: AcpPendingRequest[] = []
    connection.subscribePendingRequests(() => {
      throw new Error("this consumer cannot project the request")
    })
    connection.subscribePendingRequests((request) => pending.push(request))

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

  describe("older history pages", () => {
    const olderPage = {
      updates: [
        [
          {
            sessionUpdate: "user_message",
            messageId: "u0",
            content: [{ type: "text", text: "Earlier question" }],
          },
          { sequence: 1, turnId: "run-0" },
        ],
        [
          {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
          },
          { sequence: 2, turnId: "run-0" },
        ],
      ] as const satisfies readonly (readonly [
        SessionUpdate,
        Record<string, unknown>,
      ])[],
      history: { nextCursor: "cursor-older" },
    }

    it("keeps the latest history a resume reports, and a rejoin without one leaves it", async () => {
      const clock = useFakeClock()
      const proxy = createProxyAgent({ history: { nextCursor: "cursor-1" } })
      const pipe = pipedSockets(() => proxy.app)
      const connection = createAcpConnection({
        clientInfo: CLIENT_INFO,
        url: "ws://proxy.test/api/aos/v1/acp",
        socketConstructor: pipe.WebSocket,
      })
      connection.start()

      expect(connection.history(SESSION_ID)).toBeUndefined()
      connection.subscribe(SESSION_ID, {})
      await connection.joined(SESSION_ID)
      expect(connection.history(SESSION_ID)).toEqual({ nextCursor: "cursor-1" })

      // A rejoin replays nothing and reports no history: the cursor stands.
      pipe.sockets[0]?.drop()
      await clock.advance(250)
      expect(proxy.callsOf(methods.agent.session.resume)).toHaveLength(2)
      expect(connection.history(SESSION_ID)).toEqual({ nextCursor: "cursor-1" })
      connection.close()
    })

    it("reads a page as tagged updates that reach no live listener or position", async () => {
      const proxy = createProxyAgent({ page: olderPage })
      const connection = connectInProcess(proxy)
      await connection.initialized
      const live: SessionUpdate[] = []
      connection.subscribe(SESSION_ID, {
        agentId: AGENT_ID,
        update: (update) => live.push(update),
      })
      await connection.joined(SESSION_ID)
      await proxy.pushUpdate(
        { sessionUpdate: "state_update", state: "running" },
        { sequence: 4, turnId: "run-1" }
      )
      await vi.waitFor(() => expect(live).toHaveLength(1))

      const page = await connection.resumePage(SESSION_ID, "cursor-1")

      expect(proxy.callsOf(methods.agent.session.resume).at(-1)).toEqual({
        sessionId: SESSION_ID,
        cwd: FOLDER,
        replayFrom: { type: AOS_REPLAY_BEFORE, cursor: "cursor-1" },
      })
      expect(page.history).toEqual({ nextCursor: "cursor-older" })
      expect(page.updates.map(({ update }) => update.sessionUpdate)).toEqual([
        "user_message",
        "state_update",
      ])
      expect(page.updates[1]?.meta).toMatchObject({
        sequence: 2,
        turnId: "run-0",
      })
      // The page's idle marker belongs to an old turn: the running turn's
      // listeners never see it.
      expect(live).toHaveLength(1)
      // A page read is not a resume, so the resume cursor is untouched.
      expect(connection.history(SESSION_ID)).toBeUndefined()

      // The live stream is unaffected once the page is in.
      await proxy.pushUpdate(
        { sessionUpdate: "state_update", state: "idle" },
        { sequence: 5, turnId: "run-1" }
      )
      await vi.waitFor(() => expect(live).toHaveLength(2))
      connection.close()
    })

    it("fails a page whose reply carries no history", async () => {
      const proxy = createProxyAgent({ page: { updates: olderPage.updates } })
      const connection = connectInProcess(proxy)

      await expect(
        connection.resumePage(SESSION_ID, "cursor-1")
      ).rejects.toThrow()
      connection.close()
    })

    it("waits for a recovering transport to rejoin before reading a page", async () => {
      const clock = useFakeClock()
      const proxy = createProxyAgent({ page: olderPage, slowResume: true })
      const pipe = pipedSockets(() => proxy.app)
      const connection = createAcpConnection({
        clientInfo: CLIENT_INFO,
        url: "ws://proxy.test/api/aos/v1/acp",
        socketConstructor: pipe.WebSocket,
      })
      connection.start()
      await connection.initialized
      connection.subscribe(SESSION_ID, {})
      const joined = connection.joined(SESSION_ID)
      await clock.advance(20)
      await joined

      const recovering = new Promise<void>((resolve) =>
        connection.subscribeStatus((status) => {
          if (status === "reconnecting") resolve()
        })
      )
      pipe.sockets[0]?.drop()
      await recovering
      const page = connection.resumePage(SESSION_ID, "cursor-1")
      await clock.advance(300)
      await page

      const order = proxy.calls.flatMap(({ method, params }) =>
        method === RESUME_REPLIED
          ? ["rejoined"]
          : method === methods.agent.session.resume &&
              z.object({ replayFrom: AosReplayBeforeSchema }).safeParse(params)
                .success
            ? ["page"]
            : []
      )
      expect(order).toEqual(["rejoined", "rejoined", "page"])
      connection.close()
    })
  })

  it("delivers no request over a half-open transport", async () => {
    const clock = useFakeClock()
    const proxy = createProxyAgent()
    const pipe = pipedSockets(() => proxy.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://proxy.test/api/aos/v1/acp",
      socketConstructor: pipe.WebSocket,
    })
    connection.start()
    await connection.initialized

    pipe.sockets[0]?.halfOpen()
    void connection.listAgents().catch(() => {})
    await clock.advance(1_000)

    expect(proxy.callsOf(AOS_METHODS.agents.list)).toEqual([])
    connection.close()
  })

  it("reconnects a dropped transport and rejoins every resumed Session", async () => {
    const clock = useFakeClock()
    const proxy = createProxyAgent({ resyncOnResume: 2 })
    const pipe = pipedSockets(() => proxy.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://proxy.test/api/aos/v1/acp",
      socketConstructor: pipe.WebSocket,
    })
    connection.start()
    await connection.initialized
    const seen = vi.fn()
    connection.subscribe(SESSION_ID, { agentId: AGENT_ID, update: seen })
    await connection.joined(SESSION_ID)
    connection.focus(SESSION_ID, { foreground: true, idle: true })
    await proxy.pushUpdate(
      { sessionUpdate: "state_update", state: "running" },
      { sequence: 4, turnId: "run-1" }
    )
    // A drop loses whatever is still in flight, so the first report lands first.
    await clock.advance(0)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(proxy.callsOf(AOS_METHODS.session.focus)).toHaveLength(1)

    pipe.sockets[0]?.drop()
    await clock.advance(250)

    expect(proxy.callsOf(methods.agent.session.resume)).toHaveLength(3)
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
    expect(connection.status).toBe("ready")
    expect(pipe.sockets).toHaveLength(2)
    connection.close()
  })

  it("reports the outage from a drop until the resumed Session has rejoined", async () => {
    const clock = useFakeClock()
    const proxy = createProxyAgent({ slowResume: true })
    const pipe = pipedSockets(() => proxy.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://proxy.test/api/aos/v1/acp",
      socketConstructor: pipe.WebSocket,
    })
    connection.start()
    connection.subscribe(SESSION_ID, {})
    const joined = connection.joined(SESSION_ID)
    await clock.advance(20)
    await joined
    expect(connection.outage).toBeUndefined()

    pipe.sockets[0]?.drop()
    await clock.advance(0)
    expect(connection.outage).toBe("reconnecting")
    while (connection.status !== "ready") await clock.advance(1)
    // The transport is back, but the Session is still rejoining.
    expect(connection.sessionState(SESSION_ID)).toBe("joining")
    expect(connection.outage).toBe("reconnecting")

    await clock.advance(20)
    expect(connection.sessionState(SESSION_ID)).toBe("joined")
    expect(connection.outage).toBeUndefined()
    connection.close()
  })

  it("redeems the invitation again before replaying a recovered transport", async () => {
    const clock = useFakeClock()
    const proxy = createProxyAgent()
    const pipe = pipedSockets(() => proxy.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://guest.test/api/guest/v1/acp",
      socketConstructor: pipe.WebSocket,
    })
    connection.start()
    await connection.initialized
    await connection.login("invitation-token")
    connection.subscribe(SESSION_ID, {})
    await connection.joined(SESSION_ID)

    pipe.sockets[0]?.drop()
    await clock.advance(250)

    expect(proxy.callsOf(methods.agent.session.resume)).toHaveLength(2)
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
    const clock = useFakeClock()
    const proxy = createProxyAgent({ refuseLoginAfter: 1 })
    const pipe = pipedSockets(() => proxy.app)
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      url: "ws://guest.test/api/guest/v1/acp",
      socketConstructor: pipe.WebSocket,
    })
    connection.start()
    await connection.initialized
    await connection.login("invitation-token")
    connection.subscribe(SESSION_ID, {})
    await connection.joined(SESSION_ID)

    pipe.sockets[0]?.drop()
    await clock.advance(250)

    expect(connection.status).toBe("closed")
    // A refused invitation stops the reconnect loop instead of replaying.
    expect(proxy.callsOf(methods.agent.auth.login)).toHaveLength(2)
    expect(proxy.callsOf(methods.agent.session.resume)).toHaveLength(1)
    expect(pipe.sockets).toHaveLength(2)
  })
})

describe("build id handshake", () => {
  /** One tab's storage, which outlives the reloads it triggers. */
  function tabStorage() {
    const stored = new Map<string, string>()
    return {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    }
  }

  async function handshake(options: {
    buildId: string | null
    proxyBuildId: string
    reload: () => void
    storage: ReturnType<typeof tabStorage>
  }) {
    const connection = createAcpConnection({
      clientInfo: CLIENT_INFO,
      connectAgent: createProxyAgent({ buildId: options.proxyBuildId }).app,
      buildId: options.buildId,
      reload: options.reload,
      storage: options.storage,
    })
    connection.start()
    await connection.initialized
    connection.close()
  }

  it("reloads once for each proxy build that differs from the tab's", async () => {
    const reload = vi.fn()
    const storage = tabStorage()
    const tab = { buildId: "build-a", reload, storage }

    await handshake({ ...tab, proxyBuildId: "build-b" })
    // The reload still loaded the old bundle: no second reload, so no loop.
    await handshake({ ...tab, proxyBuildId: "build-b" })
    expect(reload).toHaveBeenCalledTimes(1)

    // A later deployment reloads the same long-lived tab again.
    await handshake({ ...tab, proxyBuildId: "build-c" })
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it("skips the check when the browser has no build id", async () => {
    const reload = vi.fn()

    await handshake({
      buildId: null,
      proxyBuildId: "build-b",
      reload,
      storage: tabStorage(),
    })

    expect(reload).not.toHaveBeenCalled()
  })
})
