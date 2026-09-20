import type {
  SessionConfigOption,
  SessionInfo,
  SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2"
import { describe, expect, it, vi } from "vitest"
import type { z } from "zod"

import { INTERACTION_PROTOCOL, type RuntimeInfo } from "@aos/protocol"
import {
  AOS_METHODS,
  AOS_META_KEY,
  AOS_PLAN_ID,
  AOS_STOP_REASONS,
  type AosSessionNewResponseMetaSchema,
} from "@aos/protocol/acp"

import type { SessionMetadata, WorkspaceAdapter } from "../../contracts"
import { createAcpWorkspaceClient } from "./acp-workspace-client"
import type { AcpConnection, AcpSessionUpdateListener } from "./types"

const SESSION_ID = "session-1"
const AGENT_ID = "agent-1"
const UPDATED_AT = "2026-09-19T10:00:00.000Z"
/** A Session no catalog page this fake answers with has described. */
const UNLISTED_SESSION_ID = "session-2"

type AcpCapabilities = z.infer<
  typeof AosSessionNewResponseMetaSchema
>["capabilities"]

const unavailable = { status: "unavailable", reason: "not-supported" } as const

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
        scope: "active-run",
        semantics: "visible-user-message",
        input: "text",
        fallback: "provider-queue",
      },
      approvals: {
        status: "available",
        protocol: INTERACTION_PROTOCOL,
        scope: "run",
        choices: [{ value: "once", scope: "request" }],
        maxPending: 8,
      },
      questions: {
        status: "available",
        protocol: INTERACTION_PROTOCOL,
        scope: "run",
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

function runtimeInfo(): RuntimeInfo {
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
      sessionDeletion: unavailable,
      sessionRun: unavailable,
      sessionStop: unavailable,
      sessionSteer: unavailable,
      sessionReadState: unavailable,
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

type ConnectionCall = { method: string; args: unknown[] }

function createFakeConnection() {
  const calls: ConnectionCall[] = []
  const updates = new Map<string, Set<AcpSessionUpdateListener>>()
  const notifications = new Map<string, Set<(params: unknown) => void>>()
  const record = (method: string, ...args: unknown[]) => {
    calls.push({ method, args })
  }
  let model = "sonnet"
  let effort = "low"
  let listed = listEntry()

  const connection: AcpConnection = {
    status: "ready",
    // Already connected: nothing here owns a transport to open.
    start: () => {},
    // The workspace client never awaits the handshake; the runtime does.
    initialized: new Promise<never>(() => {}),
    subscribeStatus: () => () => {},
    async login(token) {
      record("login", token)
    },
    async newSession(meta) {
      record("newSession", meta)
      return {
        sessionId: SESSION_ID,
        configOptions: configOptions(model, effort),
        meta: { session: sessionInfoMeta(), capabilities: capabilities() },
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
          execution: { status: "running", runId: "run-1" },
          capabilities: capabilities(),
        },
      }
    },
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
    },
    async steer(request) {
      record("steer", request)
      return { status: "steered" }
    },
    focus: (sessionId) => record("focus", sessionId),
    async listAgents() {
      record("listAgents")
      return { revision: "revision-1", agents: [catalogEntry()] }
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
    lastSequence: () => ({ runId: "run-1", after: 9 }),
    close: () => record("close"),
  }

  return {
    connection,
    calls,
    /** What the next `session/list` page reports for the Session. */
    setListed: (entry: SessionInfo) => {
      listed = entry
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
  it("is a workspace adapter", () => {
    const { client } = createClient()
    const adapter: WorkspaceAdapter = client
    expect(adapter.listAgents).toBeTypeOf("function")
  })

  it("caches Session rows from the list and keeps provider read state", async () => {
    const { client, argsOf, calls } = createClient()

    const metadata = await client.getSessionMetadata([SESSION_ID])

    expect(metadata).toEqual([
      {
        threadId: SESSION_ID,
        agentId: AGENT_ID,
        updatedAt: UPDATED_AT,
        status: "idle",
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
        runId: "run-1",
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
          efforts: ["low", "high"],
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
      efforts: ["low", "high"],
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
        runId: "run-1",
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

    client.reportFocus(SESSION_ID)
    expect(argsOf("focus")).toEqual([SESSION_ID])

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
