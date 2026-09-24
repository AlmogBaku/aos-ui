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
  type AosSessionNewResponseMetaSchema,
} from "@aos/protocol/acp"

import type { SessionMetadata } from "../../contracts"
import { createAcpWorkspaceClient } from "./acp-workspace-client"
import type {
  AcpConnection,
  AcpSessionReplayListener,
  AcpSessionUpdateListener,
} from "./types"

const SESSION_ID = "session-1"
const AGENT_ID = "agent-1"
const UPDATED_AT = "2026-09-19T10:00:00.000Z"
/** A Session no catalog page this fake answers with has described. */
const UNLISTED_SESSION_ID = "session-2"

type AcpCapabilities = z.infer<
  typeof AosSessionNewResponseMetaSchema
>["capabilities"]

const unavailable = { status: "unavailable", reason: "not-supported" } as const
const available = { status: "available" } as const

function capabilities(): AcpCapabilities {
  return {
    workspace: {
      slashCommands: unavailable,
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
    summary: { kind: "ready" as const, id: AGENT_ID, name: "Research" },
    visibility: "visible" as const,
    selectable: true,
    editable: true,
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
  const record = (method: string, ...args: unknown[]) => {
    calls.push({ method, args })
  }
  let model = "sonnet"
  let effort = "low"
  let listed = listEntry()
  let agents: AgentCatalogEntry[] = [catalogEntry()]
  let updateFailure: Error | undefined

  const connection: AcpConnection = {
    status: "ready",
    // Already connected: nothing here owns a transport to open.
    start: () => {},
    // The workspace client never awaits the handshake; the runtime does.
    initialized: new Promise<never>(() => {}),
    subscribeStatus: () => () => {},
    onSessionReplay(sessionId, listener) {
      const listeners = replays.get(sessionId) ?? new Set()
      listeners.add(listener)
      replays.set(sessionId, listeners)
      return () => listeners.delete(listener)
    },
    async login(token) {
      record("login", token)
    },
    async newSession(meta) {
      record("newSession", meta)
      return {
        sessionId: SESSION_ID,
        configOptions: configOptions(model, effort),
        meta: {
          session: { ...sessionInfoMeta(), agentId: meta.agentId },
          capabilities: capabilities(),
        },
      }
    },
    async listSessions(meta, cursor) {
      record("listSessions", meta, cursor)
      return { sessions: [listed], nextCursor: "cursor-2" }
    },
    async resumeSession(sessionId, resume) {
      record("resumeSession", sessionId, resume)
      return {
        configOptions: configOptions(model, effort),
        meta: {
          session: sessionInfoMeta(),
          execution: { status: "running", turnId: "run-1" },
          capabilities: capabilities(),
        },
      }
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
    async closeSession(sessionId) {
      record("closeSession", sessionId)
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
    async setVisibility(request) {
      record("setVisibility", request)
      return {
        revision: "revision-2",
        agent: { ...catalogEntry(), revision: "revision-3" },
      }
    },
    onSessionUpdate(sessionId, listener) {
      const listeners = updates.get(sessionId) ?? new Set()
      listeners.add(listener)
      updates.set(sessionId, listeners)
      return () => listeners.delete(listener)
    },
    onNotification(method, listener) {
      const listeners = notifications.get(method) ?? new Set()
      listeners.add(listener)
      notifications.set(method, listeners)
      return () => listeners.delete(listener)
    },
    onPendingRequest: () => () => {},
    lastSequence: () => ({ turnId: "run-1", after: 9 }),
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
    emitUpdate(
      update: SessionUpdate,
      meta?: Record<string, unknown>,
      sessionId = SESSION_ID
    ) {
      for (const listener of updates.get(sessionId) ?? [])
        listener(update, meta)
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
        for (const settle of settles) settle?.()
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
  return { client, rest, ...proxy }
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
        threadId: SESSION_ID,
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
    vi.useFakeTimers()
    try {
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
      await vi.advanceTimersByTimeAsync(300)
      answer()
      await reads

      expect(mostInFlight).toBe(1)
      expect(connection.listSessions).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("answers for Sessions of a page the thread list read without reading it again", async () => {
    const { client, calls } = createClient()

    await client.readSessionPage({ agentId: AGENT_ID }, "cursor-2")
    const metadata = await client.getSessionMetadata([SESSION_ID])

    expect(metadata.map(({ threadId }) => threadId)).toEqual([SESSION_ID])
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
    const { client, emitUpdate } = createClient()
    await client.getSessionMetadata([SESSION_ID])
    const published: SessionMetadata[][] = []
    client.subscribeSessionMetadata([SESSION_ID], (metadata) =>
      published.push(metadata)
    )
    await settle()
    await client.attachSession(SESSION_ID)

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
    const { client } = createClient()
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

    await client.attachSession(UNLISTED_SESSION_ID)

    expect(published.at(-1)?.map(({ threadId }) => threadId)).toEqual([
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
    const { client, emitUpdate } = createClient()
    await client.getSessionMetadata([SESSION_ID])
    const published: SessionMetadata[][] = []
    client.subscribeSessionMetadata([SESSION_ID], (metadata) =>
      published.push(metadata)
    )
    await settle()
    await client.attachSession(SESSION_ID)
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
    const { client, emitUpdate } = createClient()
    await client.attachSession(SESSION_ID)
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
    const { client, emitUpdate, startReplay } = createClient()
    await client.getSessionMetadata([SESSION_ID])
    await client.attachSession(SESSION_ID)
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
    const { client, emitUpdate } = createClient()
    await client.attachSession(SESSION_ID)
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
        threadId: SESSION_ID,
        occurredAt: UPDATED_AT,
        type: "attention-requested",
        requestId: "request-1",
        attentionKind: "permission",
      },
    ])
  })

  it("reports an Agent the catalog gained once a creator run stops", async () => {
    const { client, emitUpdate, setAgents } = createClient()
    const events: unknown[] = []
    client.subscribeActivity((event) => events.push(event))
    setAgents([creatorEntry()])
    await client.listAgents()
    const { threadId } = await client.createSession(CREATOR_ID)

    emitUpdate({ sessionUpdate: "state_update", state: "running" })
    setAgents([creatorEntry(), catalogEntry()])
    emitUpdate({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "end_turn",
    })
    await vi.waitFor(() => expect(events).toHaveLength(1))

    expect(events).toEqual([
      {
        id: `${threadId}:${AGENT_ID}`,
        type: "agent-ready",
        agentId: AGENT_ID,
        threadId,
        occurredAt: UPDATED_AT,
      },
    ])
  })

  it("reports nothing when a creator run stops without a new Agent", async () => {
    const { client, emitUpdate, setAgents, calls } = createClient()
    const events: unknown[] = []
    client.subscribeActivity((event) => events.push(event))
    setAgents([creatorEntry(), catalogEntry()])
    await client.listAgents()
    await client.createSession(CREATOR_ID)

    emitUpdate({ sessionUpdate: "state_update", state: "running" })
    emitUpdate({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "end_turn",
    })
    await vi.waitFor(() =>
      expect(
        calls.filter(({ method }) => method === "listAgents")
      ).toHaveLength(2)
    )
    await settle()

    expect(events).toEqual([])
  })

  it("projects models and writes one config option per half", async () => {
    const { client, argsOf, calls } = createClient()
    await client.attachSession(SESSION_ID)

    await expect(client.models(SESSION_ID)).resolves.toEqual({
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

    const models = await client.models(SESSION_ID)
    expect(models.options[1]).toEqual({
      id: "opus",
      label: "Opus",
      group: "Anthropic",
      efforts: [
        { id: "low", name: "Low" },
        { id: "high", name: "High" },
      ],
    })
  })

  it("resumes an attached Session by owner and last sequence", async () => {
    const { client, argsOf } = createClient()
    await client.getSessionMetadata([SESSION_ID])

    await client.attachSession(SESSION_ID)

    expect(argsOf("resumeSession")).toEqual([
      SESSION_ID,
      {
        replayFromStart: false,
        agentId: AGENT_ID,
        turnId: "run-1",
        after: 9,
      },
    ])
  })

  it("reads capabilities, commands, and context from the attached Session", async () => {
    const { client, emitUpdate } = createClient()
    await client.attachSession(SESSION_ID)

    await expect(
      client.workspaceCapabilities(SESSION_ID)
    ).resolves.toMatchObject({
      workspace: { slashCommands: { status: "unavailable" } },
    })
    expect(client.context(SESSION_ID)).toBeUndefined()

    emitUpdate({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "plan", description: "Plan the work" }],
    })
    emitUpdate({ sessionUpdate: "usage_update", used: 120, size: 1_000 })

    await expect(
      client.workspaceCapabilities(SESSION_ID)
    ).resolves.toMatchObject({
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
    const { client, emitUpdate } = createClient()
    await client.attachSession(SESSION_ID)
    const announced: ReturnType<typeof client.context>[] = []
    client.subscribeContext(SESSION_ID, () =>
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
    const { client, emitUpdate } = createClient()
    await client.attachSession(SESSION_ID)

    emitUpdate({ sessionUpdate: "usage_update", used: 0, size: 0 })

    expect(client.context(SESSION_ID)).toBeUndefined()
  })

  it("creates Sessions, reports focus, steers, and tracks catalog revisions", async () => {
    const { client, argsOf } = createClient()

    await expect(
      client.createSession(AGENT_ID, { title: "Weekly report" })
    ).resolves.toEqual({ threadId: SESSION_ID })
    expect(argsOf("newSession")).toEqual([
      { agentId: AGENT_ID, title: "Weekly report" },
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
      client.updateAgentVisibility(AGENT_ID, "hidden")
    ).rejects.toThrow(/revision/)
    await client.listAgentCatalog()
    await client.updateAgentVisibility(AGENT_ID, "hidden")
    expect(argsOf("setVisibility")).toEqual([
      { agentId: AGENT_ID, visibility: "hidden", revision: "revision-1" },
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
    vi.useFakeTimers()
    try {
      const { client, calls, emitNotification, setListed } = createClient()
      await client.getSessionMetadata([SESSION_ID])
      const published: SessionMetadata[][] = []
      client.subscribeSessionMetadata([SESSION_ID], (metadata) =>
        published.push(metadata)
      )
      await vi.advanceTimersByTimeAsync(0)
      await client.markSessionRead(SESSION_ID)
      published.length = 0

      setListed(listEntry(true, "Renamed by the provider"))
      emitNotification(AOS_METHODS.notify.catalogInvalidated, undefined)
      emitNotification(AOS_METHODS.notify.catalogInvalidated, undefined)
      emitNotification(AOS_METHODS.notify.catalogInvalidated, undefined)
      await vi.advanceTimersByTimeAsync(300)

      expect(
        calls.filter((call) => call.method === "listSessions")
      ).toHaveLength(2)
      expect(published.at(-1)).toEqual([
        {
          threadId: SESSION_ID,
          agentId: AGENT_ID,
          updatedAt: UPDATED_AT,
          status: "idle",
          archived: false,
          unread: true,
        },
      ])
      expect(client.sessionTitle(SESSION_ID)).toBe("Renamed by the provider")
    } finally {
      vi.useRealTimers()
    }
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
})
