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
      sessionRun: unavailable,
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
  let updateFailure: Error | undefined

  const connection: AcpConnection = {
    status: "ready",
    // Already connected: nothing here owns a transport to open.
    start: () => {},
    // The workspace client never awaits the handshake; the runtime does.
    initialized: new Promise<never>(() => {}),
    subscribeStatus: () => () => {},
    onSessionReplay: () => () => {},
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
      if (updateFailure) throw updateFailure
    },
    async steer(request) {
      record("steer", request)
      return { status: "steered" }
    },
    focus: (sessionId, presence) => record("focus", sessionId, presence),
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

  it("reports the creator tool's receipt as an Agent creation event", async () => {
    const { client, emitUpdate } = createClient()
    const events: unknown[] = []
    client.subscribeActivity((event) => events.push(event))
    await client.attachSession(SESSION_ID)

    // Live runs title the call first and carry no title once it settles.
    emitUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      title: "create_agent",
      status: "in_progress",
    })
    emitUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      rawOutput: { ok: true, status: "ready", agentId: "agent-new" },
    })

    expect(events).toEqual([
      {
        id: `${SESSION_ID}:call-1`,
        type: "agent-ready",
        agentId: "agent-new",
        threadId: SESSION_ID,
        occurredAt: UPDATED_AT,
      },
    ])
  })

  it("reports a replayed receipt once", async () => {
    const { client, emitUpdate } = createClient()
    const events: unknown[] = []
    client.subscribeActivity((event) => events.push(event))
    await client.attachSession(SESSION_ID)

    // History replay carries the title, the status, and the output together.
    emitUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-2",
      title: "create_agent",
      status: "completed",
      rawOutput: '{"ok":true,"status":"ready","agentId":"agent-new"}',
    })

    expect(events).toEqual([
      {
        id: `${SESSION_ID}:call-2`,
        type: "agent-ready",
        agentId: "agent-new",
        threadId: SESSION_ID,
        occurredAt: UPDATED_AT,
      },
    ])
  })

  it("reports nothing for a native tool name an adapter renames", async () => {
    const { client, emitUpdate } = createClient()
    const events: unknown[] = []
    client.subscribeActivity((event) => events.push(event))
    await client.attachSession(SESSION_ID)

    emitUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-native",
      title: "aos_create_agent",
      status: "completed",
      rawOutput: { ok: true, status: "ready", agentId: "agent-new" },
    })

    expect(events).toEqual([])
  })

  it("reports a created Agent that still needs operator setup as a failure", async () => {
    const { client, emitUpdate } = createClient()
    const events: unknown[] = []
    client.subscribeActivity((event) => events.push(event))
    await client.attachSession(SESSION_ID)

    emitUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-3",
      title: "create_agent",
      status: "completed",
      rawOutput: {
        ok: false,
        status: "setup-needed",
        agentId: "agent-hidden",
        error: "credentials missing",
      },
    })

    expect(events).toEqual([
      {
        id: `${SESSION_ID}:call-3`,
        type: "agent-activation-failed",
        agentId: "agent-hidden",
        threadId: SESSION_ID,
        occurredAt: UPDATED_AT,
      },
    ])
  })

  it("reports nothing for another tool, an unsettled call, or output it cannot read", async () => {
    const { client, emitUpdate } = createClient()
    const events: unknown[] = []
    client.subscribeActivity((event) => events.push(event))
    await client.attachSession(SESSION_ID)
    const receipt = { ok: true, status: "ready", agentId: "agent-new" }

    emitUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "other-tool",
      title: "read_file",
      status: "completed",
      rawOutput: receipt,
    })
    // A settled call the workspace never saw titled stays anonymous.
    emitUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "untitled",
      status: "completed",
      rawOutput: receipt,
    })
    emitUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "running",
      title: "create_agent",
      status: "in_progress",
      rawOutput: receipt,
    })
    emitUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "failed-call",
      title: "create_agent",
      status: "failed",
      rawOutput: receipt,
    })
    emitUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "malformed",
      title: "create_agent",
      status: "completed",
      rawOutput: { ok: true, status: "ready" },
    })
    emitUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "not-json",
      title: "create_agent",
      status: "completed",
      rawOutput: "created the Agent",
    })

    expect(events).toEqual([])
  })

  it("forgets a settled creator call instead of reporting it twice", async () => {
    const { client, emitUpdate } = createClient()
    const events: unknown[] = []
    client.subscribeActivity((event) => events.push(event))
    await client.attachSession(SESSION_ID)
    const settled = {
      sessionUpdate: "tool_call_update" as const,
      toolCallId: "call-4",
      status: "completed" as const,
      rawOutput: { ok: true, status: "ready", agentId: "agent-new" },
    }

    emitUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-4",
      title: "create_agent",
      status: "in_progress",
    })
    emitUpdate(settled)
    emitUpdate(settled)

    expect(events).toHaveLength(1)
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
