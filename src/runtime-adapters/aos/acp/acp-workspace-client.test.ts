import type {
  SessionConfigOption,
  SessionInfo,
  SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it, vi } from "vitest"
import type { z } from "zod"

import {
  INTERACTION_PROTOCOL,
  type AgentCatalogEntry,
  type RuntimeInfo,
} from "@aos/protocol"
import {
  AOS_METHODS,
  AOS_META_KEY,
  AOS_PLAN_ID,
  AOS_STOP_REASONS,
  type AosAvailableCommandsMetaSchema,
} from "@aos/protocol/acp"

import { useFakeClock } from "../../../../test/support/fake-clock"

import type { SessionMetadata } from "../../contracts"
import { createAcpWorkspaceClient } from "./acp-workspace-client"
import type {
  AcpConnection,
  AcpConnectionStatus,
  AcpSessionReplayListener,
  AcpSessionUpdateListener,
} from "./types"

const SESSION_ID = "session-1"
const AGENT_ID = "agent-1"
const UPDATED_AT = "2026-09-19T10:00:00.000Z"
/** A Session no catalog page this fake answers with has described. */
const UNLISTED_SESSION_ID = "session-2"

type AcpCapabilities = z.infer<
  typeof AosAvailableCommandsMetaSchema
>["capabilities"]

const unavailable = { status: "unavailable", reason: "not-supported" } as const
const available = { status: "available" } as const

function capabilities(): AcpCapabilities {
  return {
    workspace: {
      slashCommands: unavailable,
      models: {
        status: "available",
        scope: "session",
        selection: "native-session",
        choices: "provider-reported",
      },
      context: {
        status: "available",
        scope: "session",
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
      mcpApps: unavailable,
      transcription: unavailable,
      speech: unavailable,
    },
  }
}

function runtimeInfo(
  capabilities: Partial<RuntimeInfo["capabilities"]> = {}
): RuntimeInfo {
  return {
    runtime: { id: "hermes", name: "Hermes" },
    status: "ready",
    capabilities: {
      agentCatalog: unavailable,
      agentVisibility: unavailable,
      sessionCatalog: unavailable,
      sessionHistory: unavailable,
      sessionDetail: unavailable,
      sessionCreation: unavailable,
      sessionTitle: unavailable,
      sessionArchival: unavailable,
      sessionPin: unavailable,
      sessionDeletion: unavailable,
      sessionTurn: unavailable,
      sessionStop: unavailable,
      sessionSteer: unavailable,
      sessionReadState: unavailable,
      ...capabilities,
    },
  }
}

function sessionInfoMeta(unread?: boolean) {
  return {
    agentId: AGENT_ID,
    status: "idle" as const,
    archived: false,
    ...(unread === undefined ? {} : { unread }),
  }
}

function listEntry(unread = true, title?: string): SessionInfo {
  return {
    sessionId: SESSION_ID,
    cwd: "/workspace",
    updatedAt: UPDATED_AT,
    ...(title === undefined ? {} : { title }),
    _meta: { [AOS_META_KEY]: sessionInfoMeta(unread) },
  }
}

function configOptions(
  selected: string,
  effort: string
): SessionConfigOption[] {
  return [
    {
      configId: "session-model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: selected,
      options: [
        {
          groupId: "anthropic",
          name: "Anthropic",
          options: [
            { value: "sonnet", name: "Sonnet" },
            { value: "opus", name: "Opus" },
          ],
        },
      ],
    },
    {
      configId: "session-effort",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: effort,
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ]
}

function catalogEntry() {
  return {
    summary: {
      kind: "ready" as const,
      id: AGENT_ID,
      name: "Research",
      avatar: "ring/blue",
    },
    visibility: "visible" as const,
    selectable: true,
    editable: true,
    avatarEditable: true,
    revision: "revision-1",
  }
}

const CREATOR_ID = "agent-creator"

function creatorEntry() {
  return {
    ...catalogEntry(),
    summary: {
      kind: "ready" as const,
      id: CREATOR_ID,
      name: "Agent Creator",
      role: "creator" as const,
    },
    visibility: "hidden" as const,
  }
}

type ConnectionCall = { method: string; args: unknown[] }

function createFakeConnection() {
  const calls: ConnectionCall[] = []
  const updates = new Map<string, Set<AcpSessionUpdateListener>>()
  const notifications = new Map<string, Set<(params: unknown) => void>>()
  const replays = new Map<string, Set<AcpSessionReplayListener>>()
  const statusListeners = new Set<(status: AcpConnectionStatus) => void>()
  const record = (method: string, ...args: unknown[]) => {
    calls.push({ method, args })
  }
  function listen<Listener>(
    keyed: Map<string, Set<Listener>>,
    sessionId: string,
    listener: Listener
  ) {
    const listeners = keyed.get(sessionId) ?? new Set()
    listeners.add(listener)
    keyed.set(sessionId, listeners)
    return () => listeners.delete(listener)
  }
  let model = "sonnet"
  let effort = "low"
  let listed = listEntry()
  let agents: AgentCatalogEntry[] = [catalogEntry()]
  let updateFailure: Error | undefined
  let listSessionsFailure: Error | undefined
  const emit = (
    sessionId: string,
    update: SessionUpdate,
    meta?: Record<string, unknown>
  ) => {
    for (const listener of updates.get(sessionId) ?? []) listener(update, meta)
  }
  /** What the proxy sends right behind its `session/new` or `session/resume` answer. */
  const follow = (
    sessionId: string,
    agentId: string,
    status: "idle" | "running"
  ) =>
    queueMicrotask(() => {
      if (status === "running")
        emit(sessionId, { sessionUpdate: "state_update", state: "running" })
      emit(sessionId, {
        sessionUpdate: "config_option_update",
        configOptions: configOptions(model, effort),
      })
      emit(
        sessionId,
        { sessionUpdate: "available_commands_update", availableCommands: [] },
        { capabilities: capabilities() }
      )
      emit(
        sessionId,
        { sessionUpdate: "session_info_update" },
        { ...sessionInfoMeta(), agentId, status }
      )
    })

  const connection: AcpConnection = {
    status: "ready",
    // Already connected: nothing here owns a transport to open.
    start: () => {},
    // The workspace client never awaits the handshake; the runtime does.
    initialized: new Promise<never>(() => {}),
    subscribeStatus(listener) {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    outage: undefined,
    subscribeOutage: () => () => {},
    subscribe(sessionId, listener) {
      record("subscribe", sessionId, listener.agentId)
      const offs = [
        listener.update && listen(updates, sessionId, listener.update),
        listener.replay && listen(replays, sessionId, listener.replay),
      ]
      return () => {
        for (const off of offs) off?.()
      }
    },
    joined: () => Promise.resolve(),
    async replay(sessionId) {
      record("replay", sessionId)
      follow(sessionId, AGENT_ID, "running")
    },
    sessionState: () => "joined",
    async login(token) {
      record("login", token)
    },
    async newSession(meta) {
      record("newSession", meta)
      // Its updates follow the answer that names the Session.
      queueMicrotask(() => follow(SESSION_ID, meta.agentId, "idle"))
      return { sessionId: SESSION_ID }
    },
    async listSessions(meta, cursor) {
      record("listSessions", meta, cursor)
      if (listSessionsFailure) {
        const err = listSessionsFailure
        listSessionsFailure = undefined
        throw err
      }
      return { sessions: [listed], nextCursor: "cursor-2" }
    },
    // Older pages belong to the thread's runtime, never the workspace client.
    resumePage: () => Promise.reject(new Error("unused")),
    history: () => undefined,
    async prompt(sessionId) {
      record("prompt", sessionId)
      return { messageId: "message-1" }
    },
    cancel: (sessionId) => record("cancel", sessionId),
    async setConfigOption(sessionId, configId, value) {
      record("setConfigOption", sessionId, configId, value)
      if (configId === "session-model") model = value
      else effort = value
      return configOptions(model, effort)
    },
    async deleteSession(sessionId) {
      record("deleteSession", sessionId)
    },
    async updateSession(request) {
      record("updateSession", request)
      if (updateFailure) throw updateFailure
    },
    async steer(request) {
      record("steer", request)
      return { status: "steered" }
    },
    focus: (sessionId, presence) => record("focus", sessionId, presence),
    async listAgents() {
      record("listAgents")
      return { revision: "revision-1", agents }
    },
    async updateAgent(request) {
      record("updateAgent", request)
      return {
        revision: "revision-2",
        agent: { ...catalogEntry(), revision: "revision-3" },
      }
    },
    subscribeNotification(method, listener) {
      const listeners = notifications.get(method) ?? new Set()
      listeners.add(listener)
      notifications.set(method, listeners)
      return () => listeners.delete(listener)
    },
    subscribePendingRequests: () => () => {},
    close: () => record("close"),
  }

  return {
    connection,
    calls,
    /** What the next `session/list` page reports for the Session. */
    setListed: (entry: SessionInfo) => {
      listed = entry
    },
    /** What the next `_aos/agents/list` reports. */
    setAgents: (next: AgentCatalogEntry[]) => {
      agents = next
    },
    /** What every later `_aos/session/update` write rejects with. */
    failUpdates: (reason: Error) => {
      updateFailure = reason
    },
    argsOf: (method: string) =>
      calls.find((call) => call.method === method)?.args,
    /** Simulates the connection becoming ready (or re-ready after reconnect). */
    emitStatus(status: AcpConnectionStatus) {
      for (const listener of statusListeners) listener(status)
    },
    /** Makes the next listSessions call throw, then clear. */
    failListOnce(reason = new Error("list failed")) {
      listSessionsFailure = reason
    },
    clearListFailure() {
      listSessionsFailure = undefined
    },
    emitUpdate(
      update: SessionUpdate,
      meta?: Record<string, unknown>,
      sessionId = SESSION_ID
    ) {
      emit(sessionId, update, meta)
    },
    emitNotification(method: string, params: unknown) {
      for (const listener of notifications.get(method) ?? []) listener(params)
    },
    /** Starts a from-start replay; the returned callback settles it. */
    startReplay(sessionId = SESSION_ID) {
      const settles = [...(replays.get(sessionId) ?? [])].map((listener) =>
        listener()
      )
      return () => {
        for (const settle of settles) settle?.(true)
      }
    },
  }
}

function createFakeRest() {
  return {
    adoptSessionOwnership: vi.fn(),
    readArtifact: vi.fn(async () => new Blob(["artifact"])),
    runtimeInfo: vi.fn(async () => runtimeInfo()),
    speak: vi.fn(async () => new Blob(["speech"])),
    speakForAgent: vi.fn(async () => new Blob(["speech"])),
    stageAttachments: vi.fn(async () => ({
      stageId: "stage-1",
      attachments: [],
    })),
    transcribe: vi.fn(async () => "hello"),
    transcribeForAgent: vi.fn(async () => "hello"),
  }
}

function createClient() {
  const proxy = createFakeConnection()
  const rest = createFakeRest()
  const client = createAcpWorkspaceClient({
    connection: proxy.connection,
    rest,
    now: () => Date.parse(UPDATED_AT),
  })
  /** Holds the Session as a bound thread does, then replays it as its runtime does. */
  const join = async (sessionId = SESSION_ID) => {
    const release = client.subscribeSession(sessionId)
    await proxy.connection.replay(sessionId)
    return release
  }
  return { client, rest, join, ...proxy }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

describe("ACP workspace client", () => {
  it("caches Session rows from the list and keeps provider read state", async () => {
    const { client, argsOf, calls } = createClient()

    const metadata = await client.getSessionMetadata([SESSION_ID])

    expect(metadata).toEqual([
      {
        sessionId: SESSION_ID,
        agentId: AGENT_ID,
        updatedAt: UPDATED_AT,
        status: "idle",
        archived: false,
        unread: true,
      },
    ])
    expect(argsOf("listSessions")).toEqual([{}, undefined])

    await client.getSessionMetadata([SESSION_ID])

    // A Session the cache already knows costs no second read.
    expect(calls.filter((call) => call.method === "listSessions")).toHaveLength(
      1
    )
  })

  it("shares one in-flight read of a page across a refresh storm", async () => {
    const clock = useFakeClock()
    const { client, connection, emitNotification } = createClient()
    let inFlight = 0
    let mostInFlight = 0
    let answer = () => {}
    connection.listSessions = vi.fn(async () => {
      inFlight += 1
      mostInFlight = Math.max(mostInFlight, inFlight)
      await new Promise<void>((resolve) => {
        answer = resolve
      })
      inFlight -= 1
      return { sessions: [listEntry()] }
    })

    const reads = Promise.all([
      client.readSessionPage({}),
      client.readSessionPage({}),
      client.getSessionMetadata([SESSION_ID]),
      client.getSessionMetadata([UNLISTED_SESSION_ID]),
    ])
    emitNotification(AOS_METHODS.notify.catalogInvalidated, undefined)
    emitNotification(AOS_METHODS.notify.catalogInvalidated, undefined)
    await clock.advance(300)
    answer()
    await reads

    expect(mostInFlight).toBe(1)
    expect(connection.listSessions).toHaveBeenCalledTimes(1)
  })

  it("answers for Sessions of a page the thread list read without reading it again", async () => {
    const { client, calls } = createClient()

    await client.readSessionPage({ agentId: AGENT_ID }, "cursor-2")
    const metadata = await client.getSessionMetadata([SESSION_ID])

    expect(metadata.map(({ sessionId }) => sessionId)).toEqual([SESSION_ID])
    expect(calls.filter((call) => call.method === "listSessions")).toEqual([
      { method: "listSessions", args: [{ agentId: AGENT_ID }, "cursor-2"] },
    ])
  })

  it("looks for an unlisted Session on page one only", async () => {
    const { client, calls } = createClient()

    await expect(
      client.getSessionMetadata([UNLISTED_SESSION_ID])
    ).resolves.toEqual([])

    expect(calls.filter((call) => call.method === "listSessions")).toEqual([
      { method: "listSessions", args: [{}, undefined] },
    ])
  })

  it("publishes row changes and never clobbers unread with an update that omits it", async () => {
    const { client, join, emitUpdate } = createClient()
    await client.getSessionMetadata([SESSION_ID])
    const published: SessionMetadata[][] = []
    client.subscribeSessionMetadata([SESSION_ID], (metadata) =>
      published.push(metadata)
    )
    await settle()
    await join()

    emitUpdate(
      { sessionUpdate: "session_info_update", title: "Renamed" },
      {
        agentId: AGENT_ID,
        status: "waiting-for-input",
        archived: false,
      }
    )

    const latest = published.at(-1)?.[0]
    expect(latest?.unread).toBe(true)
    expect(latest?.status).toBe("waiting-for-input")
  })

  it("publishes no snapshot until every named Session has a row", async () => {
    const { client, join } = createClient()
    await client.getSessionMetadata([SESSION_ID])
    const published: SessionMetadata[][] = []
    client.subscribeSessionMetadata(
      [SESSION_ID, UNLISTED_SESSION_ID],
      (metadata) => published.push(metadata)
    )
    await settle()

    // The catalog has not reached the second Session yet. A snapshot naming
    // only the first would report the second as one the workspace does not
    // have, which is how a reloaded deep link loses its Session.
    expect(published).toEqual([])

    await join(UNLISTED_SESSION_ID)

    expect(published.at(-1)?.map(({ sessionId }) => sessionId)).toEqual([
      SESSION_ID,
      UNLISTED_SESSION_ID,
    ])
  })

  it("acks read state optimistically before the provider write", async () => {
    const { client, argsOf, emitNotification } = createClient()
    await client.getSessionMetadata([SESSION_ID])
    const published: SessionMetadata[][] = []
    client.subscribeSessionMetadata([SESSION_ID], (metadata) =>
      published.push(metadata)
    )
    await settle()

    const acked = client.markSessionRead(SESSION_ID)
    expect(published.at(-1)?.[0]?.unread).toBe(false)
    await acked
    expect(argsOf("updateSession")).toEqual([
      { sessionId: SESSION_ID, unread: false },
    ])

    emitNotification(AOS_METHODS.notify.activity, {
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      occurredAt: UPDATED_AT,
      type: "unread-changed",
      unread: true,
    })
    expect(published.at(-1)?.[0]?.unread).toBe(true)
  })

  it("pins a Session optimistically before the provider write", async () => {
    const { client, argsOf } = createClient()
    await client.getSessionMetadata([SESSION_ID])
    const published: SessionMetadata[][] = []
    client.subscribeSessionMetadata([SESSION_ID], (metadata) =>
      published.push(metadata)
    )
    await settle()

    const pinning = client.setSessionPinned(SESSION_ID, true)
    expect(published.at(-1)?.[0]?.pinned).toBe(true)
    await pinning
    expect(argsOf("updateSession")).toEqual([
      { sessionId: SESSION_ID, pinned: true },
    ])
  })

  it("takes the pin back when the provider refuses the write", async () => {
    const { client, failUpdates } = createClient()
    await client.getSessionMetadata([SESSION_ID])
    const published: SessionMetadata[][] = []
    client.subscribeSessionMetadata([SESSION_ID], (metadata) =>
      published.push(metadata)
    )
    await settle()
    failUpdates(new Error("Upstream request failed"))

    await expect(client.setSessionPinned(SESSION_ID, true)).rejects.toThrow(
      "Upstream request failed"
    )
    // The list never reported a pin, so the row owes one back.
    expect(published.at(-1)?.[0]?.pinned).toBeUndefined()
  })

  it("publishes a row whose pin or archival the provider changed", async () => {
    const { client, join, emitUpdate } = createClient()
    await client.getSessionMetadata([SESSION_ID])
    const published: SessionMetadata[][] = []
    client.subscribeSessionMetadata([SESSION_ID], (metadata) =>
      published.push(metadata)
    )
    await settle()
    await join()
    const before = published.length

    emitUpdate(
      { sessionUpdate: "session_info_update", title: "Renamed" },
      { agentId: AGENT_ID, status: "running", archived: false, pinned: true }
    )
    emitUpdate(
      { sessionUpdate: "session_info_update", title: "Renamed" },
      { agentId: AGENT_ID, status: "running", archived: true, pinned: true }
    )

    // Nothing but the pin, then nothing but the archival, changed.
    expect(published).toHaveLength(before + 2)
    expect(published.at(-1)?.[0]).toMatchObject({
      archived: true,
      pinned: true,
    })
  })

  it("keeps a Session's known creation time when a later read omits it", async () => {
    const { client, join, emitUpdate } = createClient()
    await client.getSessionMetadata([SESSION_ID])
    const published: SessionMetadata[][] = []
    client.subscribeSessionMetadata([SESSION_ID], (metadata) =>
      published.push(metadata)
    )
    await settle()
    await join()

    emitUpdate(
      { sessionUpdate: "session_info_update", title: "Renamed" },
      {
        agentId: AGENT_ID,
        status: "running",
        archived: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      }
    )
    expect(published.at(-1)?.[0]?.createdAt).toBe("2026-01-01T00:00:00.000Z")
    const before = published.length

    emitUpdate(
      { sessionUpdate: "session_info_update", title: "Renamed" },
      { agentId: AGENT_ID, status: "running", archived: false }
    )

    // A read that does not know the creation time changes nothing.
    expect(published).toHaveLength(before)
    expect(published.at(-1)?.[0]?.createdAt).toBe("2026-01-01T00:00:00.000Z")
  })

  it("reads the runtime's Session actions once and retries a failed read", async () => {
    const { client, rest } = createClient()
    rest.runtimeInfo.mockRejectedValueOnce(new Error("Upstream request failed"))

    await expect(client.sessionActionCapabilities()).rejects.toThrow(
      "Upstream request failed"
    )

    rest.runtimeInfo.mockResolvedValue(
      runtimeInfo({
        sessionTitle: available,
        sessionArchival: available,
        sessionDeletion: available,
      })
    )
    await expect(client.sessionActionCapabilities()).resolves.toEqual({
      rename: true,
      archive: true,
      delete: true,
      pin: false,
    })
    await client.sessionActionCapabilities()

    expect(rest.runtimeInfo).toHaveBeenCalledTimes(2)
  })

  it("derives Session status from the run stream", async () => {
    const { client, join, emitUpdate } = createClient()
    await join()
    expect(client.sessionStatus(SESSION_ID)).toBe("running")

    emitUpdate({ sessionUpdate: "state_update", state: "requires_action" })
    expect(client.sessionStatus(SESSION_ID)).toBe("waiting-for-input")

    emitUpdate({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: AOS_STOP_REASONS.uncertain,
    })
    expect(client.sessionStatus(SESSION_ID)).toBe("failed")

    emitUpdate({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "end_turn",
    })
    expect(client.sessionStatus(SESSION_ID)).toBe("idle")
  })

  it("publishes only the status a replay ends on", async () => {
    const { client, join, emitUpdate, startReplay } = createClient()
    await client.getSessionMetadata([SESSION_ID])
    await join()
    const statuses: (string | undefined)[] = []
    client.subscribeSessionMetadata([SESSION_ID], (metadata) =>
      statuses.push(metadata[0]?.status)
    )
    await settle()
    statuses.length = 0

    const settleReplay = startReplay()
    for (let turn = 0; turn < 3; turn += 1) {
      emitUpdate({ sessionUpdate: "state_update", state: "running" })
      emitUpdate({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      })
    }
    expect(statuses).toEqual([])

    settleReplay()
    expect(statuses).toEqual(["idle"])

    emitUpdate({ sessionUpdate: "state_update", state: "running" })
    expect(statuses).toEqual(["idle", "running"])
  })

  it("publishes Session Todos from the plan update", async () => {
    const { client, join, emitUpdate } = createClient()
    await join()
    const seen: unknown[] = []
    client.subscribeTodos(SESSION_ID, (todos) => seen.push(todos))
    await settle()
    expect(seen).toEqual([[]])

    emitUpdate(
      {
        sessionUpdate: "plan_update",
        plan: { type: "items", planId: AOS_PLAN_ID, entries: [] },
      },
      {
        sequence: 3,
        turnId: "run-1",
        todos: [{ id: "todo-1", label: "Draft", status: "active" }],
      }
    )

    expect(seen.at(-1)).toEqual([
      { id: "todo-1", label: "Draft", status: "active" },
    ])
  })

  it("maps workspace activity and ignores read-state events", async () => {
    const { client, emitNotification } = createClient()
    const events: unknown[] = []
    client.subscribeActivity((event) => events.push(event))

    emitNotification(AOS_METHODS.notify.activity, {
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      occurredAt: UPDATED_AT,
      type: "attention-requested",
      requestId: "request-1",
      attentionKind: "permission",
    })
    emitNotification(AOS_METHODS.notify.activity, {
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      occurredAt: UPDATED_AT,
      type: "unread-changed",
      unread: true,
    })

    expect(events).toEqual([
      {
        id: `${SESSION_ID}:request-1:attention-requested`,
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        occurredAt: UPDATED_AT,
        type: "attention-requested",
        requestId: "request-1",
        attentionKind: "permission",
      },
    ])
  })

  it("reports an Agent the catalog gained once a creator run stops", async () => {
    const clock = useFakeClock()
    const { client, join, emitUpdate, setAgents } = createClient()
    const events: unknown[] = []
    client.subscribeActivity((event) => events.push(event))
    setAgents([creatorEntry()])
    await client.listAgents()
    const { sessionId } = await client.createSession(CREATOR_ID)
    // The thread binds the new Session and replays it.
    await join(sessionId)

    emitUpdate({ sessionUpdate: "state_update", state: "running" })
    setAgents([creatorEntry(), catalogEntry()])
    emitUpdate({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "end_turn",
    })
    await clock.advance(0)

    expect(events).toEqual([
      {
        id: `${sessionId}:${AGENT_ID}`,
        type: "agent-ready",
        agentId: AGENT_ID,
        sessionId,
        occurredAt: UPDATED_AT,
      },
    ])
  })

  it("reads the post-write catalog on a refresh while an older read is still open", async () => {
    const { client, connection } = createClient()
    const catalogWith = (avatar: string) => ({
      revision: "revision-1",
      agents: [
        { ...catalogEntry(), summary: { ...catalogEntry().summary, avatar } },
      ],
    })
    let releaseOlder = () => {}
    const answers = [
      async () => catalogWith("ring/blue"),
      () =>
        new Promise<ReturnType<typeof catalogWith>>((resolve) => {
          releaseOlder = () => resolve(catalogWith("ring/blue"))
        }),
      async () => catalogWith("disc/rose"),
    ]
    connection.listAgents = vi.fn(() => answers.shift()!())

    await client.listAgents()
    const older = client.listAgents()
    await client.updateAgent(AGENT_ID, { avatar: "disc/rose" })
    const refreshed = client.refreshAgents()
    releaseOlder()

    await expect(refreshed).resolves.toEqual([
      expect.objectContaining({ id: AGENT_ID, avatar: "disc/rose" }),
    ])
    await older
  })

  it("reports nothing when a creator run stops without a new Agent", async () => {
    const clock = useFakeClock()
    const { client, join, emitUpdate, setAgents, calls } = createClient()
    const events: unknown[] = []
    client.subscribeActivity((event) => events.push(event))
    setAgents([creatorEntry(), catalogEntry()])
    await client.listAgents()
    const { sessionId } = await client.createSession(CREATOR_ID)
    // The thread binds the new Session and replays it.
    await join(sessionId)

    emitUpdate({ sessionUpdate: "state_update", state: "running" })
    emitUpdate({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "end_turn",
    })
    await clock.advance(0)

    expect(calls.filter(({ method }) => method === "listAgents")).toHaveLength(
      2
    )
    expect(events).toEqual([])
  })

  it("projects models and writes one config option per half", async () => {
    const { client, join, argsOf, calls } = createClient()
    await join()

    expect(client.models(SESSION_ID)).toEqual({
      selectedId: "sonnet",
      effortId: "low",
      options: [
        {
          id: "sonnet",
          label: "Sonnet",
          group: "Anthropic",
          efforts: [
            { id: "low", name: "Low" },
            { id: "high", name: "High" },
          ],
        },
        { id: "opus", label: "Opus", group: "Anthropic" },
      ],
    })

    await expect(
      client.updateModel(SESSION_ID, { selectedId: "opus", effortId: "high" })
    ).resolves.toEqual({ selectedId: "opus", effortId: "high" })
    expect(argsOf("setConfigOption")).toEqual([
      SESSION_ID,
      "session-model",
      "opus",
    ])
    expect(
      calls.filter((call) => call.method === "setConfigOption").at(-1)?.args
    ).toEqual([SESSION_ID, "session-effort", "high"])

    expect(client.models(SESSION_ID)?.options[1]).toEqual({
      id: "opus",
      label: "Opus",
      group: "Anthropic",
      efforts: [
        { id: "low", name: "Low" },
        { id: "high", name: "High" },
      ],
    })
  })

  it("holds a Session under its owner", async () => {
    const { client, argsOf } = createClient()
    await client.getSessionMetadata([SESSION_ID])

    client.subscribeSession(SESSION_ID)

    expect(argsOf("subscribe")).toEqual([SESSION_ID, AGENT_ID])
  })

  it("reads capabilities, commands, and context from the resumed Session's updates", async () => {
    const { client, join, emitUpdate } = createClient()
    await join()

    expect(client.workspaceCapabilities(SESSION_ID)).toMatchObject({
      workspace: { models: { status: "available" } },
    })
    expect(client.context(SESSION_ID)).toBeUndefined()

    emitUpdate(
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "plan", description: "Plan the work" }],
      },
      { capabilities: capabilities() }
    )
    emitUpdate({ sessionUpdate: "usage_update", used: 120, size: 1_000 })

    expect(client.workspaceCapabilities(SESSION_ID)).toMatchObject({
      workspace: {
        slashCommands: {
          status: "available",
          commands: [{ name: "plan", description: "Plan the work" }],
        },
      },
    })
    expect(client.context(SESSION_ID)).toEqual({
      usedTokens: 120,
      maxTokens: 1_000,
      source: "provider-usage",
    })
  })

  it("keeps the provider's own attribution and provenance on a usage reading", async () => {
    const { client, join, emitUpdate } = createClient()
    await join()
    const announced: ReturnType<typeof client.context>[] = []
    client.subscribeComposer(SESSION_ID, () =>
      announced.push(client.context(SESSION_ID))
    )

    emitUpdate(
      { sessionUpdate: "usage_update", used: 4_200, size: 200_000 },
      {
        source: "provider-usage-plus-estimate",
        estimated: true,
        breakdown: {
          systemTokens: 900,
          toolTokens: 1_100,
          messageTokens: 2_200,
        },
      }
    )

    expect(client.context(SESSION_ID)).toEqual({
      usedTokens: 4_200,
      maxTokens: 200_000,
      source: "provider-usage-plus-estimate",
      estimated: true,
      breakdown: { systemTokens: 900, toolTokens: 1_100, messageTokens: 2_200 },
    })
    // Every reading is announced, so the composer never shows a stale window.
    expect(announced).toHaveLength(1)

    // A reading this build cannot read the meta of still reports its counts.
    emitUpdate(
      { sessionUpdate: "usage_update", used: 5_000, size: 200_000 },
      { source: "from-a-newer-proxy" }
    )

    expect(client.context(SESSION_ID)).toEqual({
      usedTokens: 5_000,
      maxTokens: 200_000,
      source: "provider-usage",
    })
    expect(announced).toHaveLength(2)
  })

  it("ignores a usage reading that names no window", async () => {
    const { client, join, emitUpdate } = createClient()
    await join()

    emitUpdate({ sessionUpdate: "usage_update", used: 0, size: 0 })

    expect(client.context(SESSION_ID)).toBeUndefined()
  })

  it("creates Sessions, reports focus, steers, and tracks catalog revisions", async () => {
    const { client, argsOf, calls } = createClient()

    await expect(
      client.createSession(AGENT_ID, { title: "Weekly report" })
    ).resolves.toEqual({ sessionId: SESSION_ID })
    expect(argsOf("newSession")).toEqual([
      expect.objectContaining({ agentId: AGENT_ID, title: "Weekly report" }),
    ])

    client.reportFocus(SESSION_ID, { foreground: true, idle: false })
    expect(argsOf("focus")).toEqual([
      SESSION_ID,
      { foreground: true, idle: false },
    ])

    await expect(
      client.steerRun(SESSION_ID, { requestId: "request-1", text: "stop" })
    ).resolves.toEqual({ status: "steered" })
    expect(argsOf("steer")).toEqual([
      { sessionId: SESSION_ID, requestId: "request-1", text: "stop" },
    ])

    await expect(
      client.updateAgent(AGENT_ID, { visibility: "hidden", avatar: null })
    ).rejects.toThrow(/revision/)
    await expect(client.listAgentCatalog()).resolves.toEqual([
      {
        summary: expect.objectContaining({ avatar: "ring/blue" }) as unknown,
        visibility: "visible",
        selectable: true,
        editable: true,
        avatarEditable: true,
      },
    ])
    await client.updateAgent(AGENT_ID, { visibility: "hidden", avatar: null })
    await client.updateAgent(AGENT_ID, { visibility: "visible" })
    expect(
      calls
        .filter((call) => call.method === "updateAgent")
        .map((call) => call.args[0])
    ).toEqual([
      {
        agentId: AGENT_ID,
        visibility: "hidden",
        avatar: null,
        revision: "revision-1",
      },
      { agentId: AGENT_ID, visibility: "visible", revision: "revision-3" },
    ])
  })

  it("invalidates a Session and the Agent catalog from proxy notifications", async () => {
    const { client, emitNotification } = createClient()
    let sessionInvalidations = 0
    let catalogInvalidations = 0
    client.subscribeSessionInvalidation(SESSION_ID, () => {
      sessionInvalidations += 1
    })
    client.subscribeAgentCatalog(() => {
      catalogInvalidations += 1
    })

    emitNotification(AOS_METHODS.notify.sessionInvalidated, {
      sessionId: SESSION_ID,
    })
    emitNotification(AOS_METHODS.notify.catalogInvalidated, undefined)

    expect(sessionInvalidations).toBe(1)
    expect(catalogInvalidations).toBe(1)
  })

  it("re-lists Session rows once for a burst of catalog invalidations", async () => {
    const clock = useFakeClock()
    const { client, calls, emitNotification, setListed } = createClient()
    await client.getSessionMetadata([SESSION_ID])
    const published: SessionMetadata[][] = []
    client.subscribeSessionMetadata([SESSION_ID], (metadata) =>
      published.push(metadata)
    )
    const heard: (readonly string[])[] = []
    client.subscribeSessionCatalog((sessionIds) => heard.push(sessionIds))
    await clock.advance(0)
    await client.markSessionRead(SESSION_ID)
    published.length = 0

    setListed(listEntry(true, "Renamed by the provider"))
    emitNotification(AOS_METHODS.notify.catalogInvalidated, undefined)
    emitNotification(AOS_METHODS.notify.catalogInvalidated, undefined)
    emitNotification(AOS_METHODS.notify.catalogInvalidated, undefined)
    await clock.advance(300)

    expect(calls.filter((call) => call.method === "listSessions")).toHaveLength(
      2
    )
    expect(heard).toEqual([[SESSION_ID]])
    expect(published.at(-1)).toEqual([
      {
        sessionId: SESSION_ID,
        agentId: AGENT_ID,
        updatedAt: UPDATED_AT,
        status: "idle",
        archived: false,
        unread: true,
      },
    ])
    expect(client.sessionTitle(SESSION_ID)).toBe("Renamed by the provider")
  })

  it("delegates byte and runtime reads to the REST client", async () => {
    const { client, rest } = createClient()
    await client.getSessionMetadata([SESSION_ID])

    expect(rest.adoptSessionOwnership).toHaveBeenCalledWith(
      SESSION_ID,
      AGENT_ID
    )
    await expect(
      client.readArtifact(SESSION_ID, "artifact-1")
    ).resolves.toBeInstanceOf(Blob)
    await expect(client.transcribe(SESSION_ID, new Blob())).resolves.toBe(
      "hello"
    )
    await expect(client.speak(SESSION_ID, "hello")).resolves.toBeInstanceOf(
      Blob
    )
    await expect(
      client.stageAttachments(SESSION_ID, [])
    ).resolves.toMatchObject({ stageId: "stage-1" })
    await expect(client.runtimeInfo()).resolves.toMatchObject({
      runtime: { id: "hermes" },
    })
    expect(rest.readArtifact).toHaveBeenCalledWith(SESSION_ID, "artifact-1")
  })

  describe("session list refresh", () => {
    it("never overwrites a newer row with a stale list entry", async () => {
      // Half a second after the stale entry below, which is written without
      // milliseconds and so sorts after this one as a string.
      const newerAt = "2026-09-19T10:00:00.500Z"
      const { client, setListed } = createClient()

      // First list with the newer updatedAt — the row cache now holds newerAt.
      setListed({
        ...listEntry(),
        updatedAt: newerAt,
      } as import("@agentclientprotocol/sdk/experimental/v2").SessionInfo)
      const [first] = await client.getSessionMetadata([SESSION_ID])
      expect(first?.updatedAt).toBe(newerAt)

      // A second list with an older timestamp must not overwrite.
      setListed({
        ...listEntry(),
        updatedAt: "2026-09-19T10:00:00Z",
      } as import("@agentclientprotocol/sdk/experimental/v2").SessionInfo)
      await client.listSessions()

      const [after] = await client.getSessionMetadata([SESSION_ID])
      expect(after?.updatedAt).toBe(newerAt)
    })

    it("retries a failed first load until it succeeds", async () => {
      const clock = useFakeClock()
      const { client, calls, failListOnce } = createClient()
      failListOnce()
      const load = client.getSessionMetadata([SESSION_ID])
      // The failure auto-clears after one use; advance past the backoff.
      await clock.advance(5_000)
      await load
      expect(calls.filter((c) => c.method === "listSessions").length).toBe(2)
    })

    it("re-reads page one after a reconnect and retries on failure", async () => {
      const clock = useFakeClock()
      const { client, calls, emitStatus, failListOnce } = createClient()
      await client.getSessionMetadata([SESSION_ID])
      const readsBefore = calls.filter(
        (c) => c.method === "listSessions"
      ).length

      // The connection was already ready when the client was made, so the
      // first interruption is a reconnect.
      emitStatus("reconnecting")
      // Mark the next list attempt to fail so we can test retry.
      failListOnce()
      emitStatus("ready")
      // Advance past the debounce; the first (failing) attempt fires.
      await clock.advance(300)

      // Allow the failure to happen; it auto-clears after one use.
      // Advance past the backoff; the retry attempt fires.
      await clock.advance(5_000)

      const readsAfter = calls.filter((c) => c.method === "listSessions").length
      // Two new reads: one failed attempt + one retry.
      expect(readsAfter).toBe(readsBefore + 2)
    })

    it("stops relisting and folding Session updates once disposed", async () => {
      const clock = useFakeClock()
      const {
        client,
        calls,
        emitNotification,
        emitStatus,
        emitUpdate,
        failListOnce,
      } = createClient()
      await client.getSessionMetadata([SESSION_ID])
      client.subscribeSession(SESSION_ID)
      const reads = () =>
        calls.filter(({ method }) => method === "listSessions").length

      // One read fails and waits out its backoff while a burst debounces.
      failListOnce()
      emitNotification(AOS_METHODS.notify.catalogInvalidated, undefined)
      await clock.advance(300)
      emitNotification(AOS_METHODS.notify.catalogInvalidated, undefined)
      const readsBefore = reads()
      client.dispose()

      emitNotification(AOS_METHODS.notify.catalogInvalidated, undefined)
      emitStatus("reconnecting")
      emitStatus("ready")
      emitUpdate({ sessionUpdate: "state_update", state: "running" })
      await clock.advance(10_000)

      expect(reads()).toBe(readsBefore)
      expect(client.sessionStatus(SESSION_ID)).toBe("idle")
    })
  })
})
