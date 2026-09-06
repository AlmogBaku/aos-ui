import type {
  GlobalSession,
  OpencodeClient,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
} from "@assistant-ui/react-opencode"
import { describe, expect, it, vi } from "vitest"

import type { SessionMetadata, WorkspaceActivityEvent } from "../contracts"
import { getWorkspaceCapabilities } from "../workspace-state"
import {
  createOpenCodeWorkspace,
  type OpenCodeEventSubscription,
} from "./opencode-workspace"
import {
  AGENT_BUILDER_KICKOFF,
  createAgentDraftMetadata,
  readAgentDraftMetadata,
} from "./agent-draft"
import type { OpenCodeWorkspaceEvent } from "./agent-activation"
import { OpenCodeSessionOwnership } from "./opencode-session-ownership"
import { runWorkspaceAdapterContract } from "./workspace-adapter.contract"

const agent = {
  name: "build",
  description: "Builds and reviews changes",
  mode: "primary",
  native: false,
  permission: [],
  options: {},
}

const nativePlanAgent = {
  name: "plan",
  description: "OpenCode planning mode",
  mode: "primary",
  native: true,
  permission: [],
  options: {},
}

const builderAgent = {
  name: "agent-builder",
  description: "Creates and configures OpenCode Agents",
  mode: "primary",
  hidden: true,
  native: false,
  permission: [],
  options: {},
}

const session = {
  id: "session-build",
  slug: "calm-otter",
  projectID: "project-1",
  directory: "/workspace",
  title: "Adapter contract",
  agent: "build",
  version: "1",
  time: { created: 1_760_000_000_000, updated: 1_760_000_100_000 },
  project: null,
} satisfies GlobalSession

function createdSession(agentId = "build") {
  return {
    ...session,
    id: "session-created",
    slug: "new-session",
    title: "New session",
    agent: agentId.endsWith("-mismatch") ? "review" : agentId,
    time: { created: 1_760_000_200_000, updated: 1_760_000_200_000 },
  } satisfies Session
}

function createdAgentEvent({
  threadId,
  callId = "call-create-1",
  agentId = "research-agent",
  name = "Research Agent",
  description = "Finds and synthesizes primary sources",
}: {
  threadId: string
  callId?: string
  agentId?: string
  name?: string
  description?: string
}) {
  return {
    id: `event-${callId}`,
    type: "message.part.updated",
    properties: {
      sessionID: threadId,
      time: 1_760_000_300_000,
      part: {
        id: `part-${callId}`,
        sessionID: threadId,
        messageID: "message-create",
        type: "tool",
        callID: callId,
        tool: "create_agent",
        state: {
          status: "completed",
          input: {},
          output: `Created ${agentId}`,
          title: `Created ${agentId}`,
          metadata: {
            aos_ui: {
              version: 1,
              kind: "agent-created",
              draftThreadId: threadId,
              agentId,
              name,
              description,
            },
          },
          time: { start: 1_760_000_299_000, end: 1_760_000_300_000 },
        },
      },
    },
  } as const
}

function sessionIdleEvent(threadId: string) {
  return {
    id: `event-idle-${threadId}`,
    type: "session.idle",
    properties: { sessionID: threadId },
  } as const
}

function sessionStatusEvent(threadId: string, status: SessionStatus) {
  return {
    id: `event-status-${threadId}-${status.type}`,
    type: "session.status",
    properties: { sessionID: threadId, status },
  } as const
}

function sessionUpdatedEvent(info: GlobalSession) {
  return {
    id: `event-updated-${info.id}`,
    type: "session.updated",
    properties: { info },
  } as const
}

function sessionDeletedEvent(info: GlobalSession) {
  return {
    id: `event-deleted-${info.id}`,
    type: "session.deleted",
    properties: { info },
  } as const
}

class FakeOpenCodeEvents implements OpenCodeEventSubscription {
  readonly #listeners = new Set<(event: OpenCodeWorkspaceEvent) => void>()
  subscribeCalls = 0

  get listenerCount() {
    return this.#listeners.size
  }

  subscribe(listener: (event: OpenCodeWorkspaceEvent) => void) {
    this.subscribeCalls += 1
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  emit(event: OpenCodeWorkspaceEvent) {
    for (const listener of this.#listeners) listener(event)
  }

  queue(event: OpenCodeWorkspaceEvent) {
    const queuedListeners = [...this.#listeners]
    return () => {
      for (const listener of queuedListeners) listener(event)
    }
  }
}

type TodoResponse = {
  data: Array<{ content: string; status: string; priority: string }>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createHarness() {
  const creationTimeline: string[] = []
  let createdCount = 0
  const sessions: GlobalSession[] = [session]
  const agents = [agent, nativePlanAgent, builderAgent]
  const status: Record<string, SessionStatus> = {
    [session.id]: { type: "busy" },
  }
  const todos = new Map<
    string,
    Array<{ content: string; status: string; priority: string }>
  >([
    [
      session.id,
      [{ content: "Inspect types", status: "in_progress", priority: "high" }],
    ],
  ])
  const events = new FakeOpenCodeEvents()
  const pendingPermissions: PermissionRequest[] = []
  const pendingQuestions: QuestionRequest[] = []
  const messages = new Map<string, unknown[]>()
  const ownership = new OpenCodeSessionOwnership()
  const client = {
    app: {
      agents: vi.fn(async () => {
        creationTimeline.push("agents:list")
        return { data: agents }
      }),
    },
    experimental: {
      session: {
        list: vi.fn(async () => ({ data: sessions })),
      },
    },
    session: {
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({
        data: sessions.find(({ id }) => id === sessionID),
      })),
      status: vi.fn(async () => ({ data: status })),
      create: vi.fn(
        async ({
          agent: agentId,
          title,
          metadata,
        }: {
          agent?: string
          title?: string
          metadata?: Record<string, unknown>
        }) => {
          createdCount += 1
          creationTimeline.push(`creating:${agentId}`)
          const created = {
            ...createdSession(agentId),
            id:
              createdCount === 1
                ? "session-created"
                : `session-created-${createdCount}`,
            ...(title ? { title } : {}),
            ...(metadata ? { metadata } : {}),
          }
          sessions.push(created)
          status[created.id] = { type: "idle" }
          creationTimeline.push(`created:${created.id}`)
          return { data: created }
        }
      ),
      promptAsync: vi.fn(async () => ({ data: undefined })),
      messages: vi.fn(async ({ sessionID }: { sessionID: string }) => ({
        data: messages.get(sessionID) ?? [],
      })),
      update: vi.fn(
        async ({
          sessionID,
          metadata,
        }: {
          sessionID: string
          metadata?: Record<string, unknown>
        }) => {
          const index = sessions.findIndex(({ id }) => id === sessionID)
          if (index < 0) throw new Error("Session not found")
          sessions[index] = {
            ...sessions[index]!,
            ...(metadata ? { metadata } : {}),
          }
          const phase = readAgentDraftMetadata(metadata)?.phase
          if (phase) creationTimeline.push(`draft:${phase}`)
          return { data: sessions[index] }
        }
      ),
      delete: vi.fn(async ({ sessionID }: { sessionID: string }) => {
        const index = sessions.findIndex(({ id }) => id === sessionID)
        if (index >= 0) sessions.splice(index, 1)
        return { data: true }
      }),
      todo: vi.fn(async ({ sessionID }: { sessionID: string }) => ({
        data: todos.get(sessionID) ?? [],
      })),
    },
    permission: {
      list: vi.fn(async () => ({ data: pendingPermissions })),
    },
    question: {
      list: vi.fn(async () => ({ data: pendingQuestions })),
    },
    instance: {
      dispose: vi.fn(async () => {
        creationTimeline.push("instance:dispose")
        return { data: true }
      }),
    },
  } as unknown as OpencodeClient

  return {
    workspace: createOpenCodeWorkspace({ client, events, ownership }),
    events,
    client,
    agents,
    status,
    sessions,
    messages,
    ownership,
    pendingPermissions,
    pendingQuestions,
    creationTimeline,
    expectedAgent: {
      kind: "ready" as const,
      id: "build",
      name: "build",
      description: "Builds and reviews changes",
    },
    expectedSession: {
      threadId: "session-build",
      agentId: "build",
      status: "running" as const,
      updatedAt: new Date(1_760_000_100_000).toISOString(),
    },
    createdSession: {
      threadId: "session-created",
      agentId: "build",
      status: "idle" as const,
      updatedAt: new Date(1_760_000_200_000).toISOString(),
    },
  }
}

runWorkspaceAdapterContract("OpenCode", createHarness)

describe("OpenCode capability and event mapping", () => {
  it("silently hides unmanaged Agent Builder Sessions", async () => {
    const { workspace, sessions } = createHarness()
    const threadId = "session-legacy-builder"
    sessions.push({
      ...session,
      id: threadId,
      slug: "legacy-builder",
      title: "Agent Builder status update",
      agent: "agent-builder",
    })
    const onError = vi.fn()
    const unsubscribe = workspace.subscribeAgentCatalog?.(vi.fn(), onError)

    await expect(workspace.listAgents()).resolves.not.toContainEqual(
      expect.objectContaining({ builderThreadId: threadId })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onError).not.toHaveBeenCalled()
    unsubscribe?.()
  })

  it.each([
    {
      invalidField: "version",
      aos_ui: {
        version: 2,
        kind: "agent-draft",
        phase: "interview",
        revision: 1,
      },
      reason: "unsupported AOS metadata version",
    },
    {
      invalidField: "kind",
      aos_ui: {
        version: 1,
        kind: "other-record",
        phase: "interview",
        revision: 1,
      },
      reason: "unsupported AOS metadata kind",
    },
    {
      invalidField: "phase",
      aos_ui: {
        version: 1,
        kind: "agent-draft",
        phase: "future-phase",
        revision: 1,
      },
      reason: "unsupported Agent draft phase",
    },
  ])(
    "hides Builder Sessions with an invalid $invalidField and reports the diagnostic",
    async ({ invalidField, aos_ui, reason }) => {
      const { workspace, sessions } = createHarness()
      const threadId = `session-invalid-${invalidField}`
      sessions.push({
        ...session,
        id: threadId,
        slug: `invalid-${invalidField}`,
        title: "Invalid Agent draft",
        agent: "agent-builder",
        metadata: { aos_ui },
      })
      const onError = vi.fn()
      const unsubscribe = workspace.subscribeAgentCatalog?.(vi.fn(), onError)

      await expect(workspace.listAgents()).resolves.not.toContainEqual(
        expect.objectContaining({ builderThreadId: threadId })
      )
      expect(onError).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
      expect(onError).toHaveBeenCalledWith(
        new Error(`OpenCode hid Agent Builder Session ${threadId}: ${reason}`)
      )
      unsubscribe?.()
    }
  )

  it("opens the provider-owned Agent Builder conversation", async () => {
    const { workspace, client } = createHarness()

    expect(getWorkspaceCapabilities(workspace)).toEqual({
      agentCatalog: true,
      agentVisibilityUpdates: false,
      agentUpdates: false,
      todos: true,
      builderChat: true,
      agentDraftDeletion: true,
      agentDraftRetry: true,
      agentLifecycle: true,
      activityEvents: true,
    })

    await expect(workspace.openAgentBuilder!()).resolves.toEqual({
      threadId: "session-created",
      draftAgentId: "draft:session-created",
    })
    await expect(
      workspace.getSessionMetadata(["session-created"])
    ).resolves.toMatchObject([{ agentId: "draft:session-created" }])
    await expect(workspace.listAgents()).resolves.not.toContainEqual(
      expect.objectContaining({ id: "agent-builder" })
    )
    await expect(workspace.listAgents()).resolves.not.toContainEqual(
      expect.objectContaining({ id: "plan" })
    )
    await expect(workspace.listAgents()).resolves.toContainEqual(
      expect.objectContaining({
        kind: "provisional",
        id: "draft:session-created",
        builderThreadId: "session-created",
        phase: "interview",
      })
    )
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      {
        sessionID: "session-created",
        agent: "agent-builder",
        parts: [{ type: "text", text: "Hey, let's build a new agent." }],
      },
      { throwOnError: true }
    )
  })

  it("persists localized Builder labels at the provider boundary", async () => {
    const { workspace, client } = createHarness()
    const labels = {
      draftTitle: "סוכן חדש",
      draftDescription: "יוצרים את הסוכן שלכם",
      firstSessionTitle: "שיחה חדשה",
    }

    await workspace.openAgentBuilder!(labels)

    expect(client.session.create).toHaveBeenCalledWith(
      {
        agent: "agent-builder",
        title: labels.draftTitle,
        metadata: {
          aos_ui: expect.objectContaining({ labels }),
        },
      },
      { throwOnError: true }
    )
    await expect(workspace.listAgents()).resolves.toContainEqual(
      expect.objectContaining({
        name: labels.draftTitle,
        description: labels.draftDescription,
      })
    )
  })

  it("creates a distinct Agent Builder draft and kickoff every time", async () => {
    const { workspace, client } = createHarness()

    const first = await workspace.openAgentBuilder!()
    const second = await workspace.openAgentBuilder!()

    expect(second).not.toEqual(first)
    expect(client.session.create).toHaveBeenCalledTimes(2)
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2)
  })

  it("persists activation, waits for every observed Session to become idle, then promotes exactly once", async () => {
    const {
      workspace,
      events,
      client,
      agents,
      status,
      sessions,
      creationTimeline,
    } = createHarness()
    const draft = await workspace.openAgentBuilder!({
      draftTitle: "סוכן חדש",
      draftDescription: "יוצרים את הסוכן שלכם",
      firstSessionTitle: "שיחה חדשה",
    })
    status[session.id] = { type: "busy" }
    status[draft.threadId] = { type: "idle" }
    agents.push({
      name: "research-agent",
      description: "Finds and synthesizes primary sources",
      mode: "primary",
      native: false,
      permission: [],
      options: { aos_ui_name: "Research Agent" },
    })
    creationTimeline.splice(0)
    const lifecycle = vi.fn()
    const onError = vi.fn()
    const unsubscribe = workspace.subscribeAgentLifecycle?.(lifecycle, onError)
    const receipt = createdAgentEvent({ threadId: draft.threadId })

    events.emit(receipt)
    events.emit(receipt)
    await vi.waitFor(() =>
      expect(
        readAgentDraftMetadata(
          sessions.find(({ id }) => id === draft.threadId)?.metadata
        )
      ).toMatchObject({ phase: "activating", revision: 2 })
    )
    expect(client.instance.dispose).not.toHaveBeenCalled()
    expect(client.session.create).toHaveBeenCalledTimes(1)

    status[session.id] = { type: "idle" }
    events.emit(sessionIdleEvent(session.id))
    await vi.waitFor(() =>
      expect(lifecycle).toHaveBeenCalledWith({
        type: "draft-promoted",
        draftAgentId: draft.draftAgentId,
        agentId: "research-agent",
        threadId: "session-created-2",
        revision: 3,
      })
    )

    expect(creationTimeline).toEqual([
      "draft:activating",
      "instance:dispose",
      "agents:list",
      "creating:research-agent",
      "created:session-created-2",
      "draft:promoted",
    ])
    expect(client.session.create).toHaveBeenCalledTimes(2)
    expect(
      sessions.find(({ id }) => id === "session-created-2")?.metadata
    ).toEqual({
      aos_ui: {
        version: 1,
        kind: "agent-first-session",
        draftThreadId: draft.threadId,
      },
    })
    expect(sessions.find(({ id }) => id === "session-created-2")?.title).toBe(
      "שיחה חדשה"
    )
    expect(onError).not.toHaveBeenCalled()

    events.emit(receipt)
    events.emit({
      id: "event-reconnected",
      type: "stream.reconnected",
      properties: {},
    })
    await Promise.resolve()
    expect(client.session.create).toHaveBeenCalledTimes(2)
    expect(client.instance.dispose).toHaveBeenCalledTimes(1)
    unsubscribe?.()
  })

  it("ignores malformed and cross-Session create_agent receipts without mutating the draft", async () => {
    const { workspace, events, client, sessions } = createHarness()
    const draft = await workspace.openAgentBuilder!()
    const unsubscribe = workspace.subscribeAgentLifecycle?.(vi.fn())
    const valid = createdAgentEvent({ threadId: draft.threadId })
    if (valid.type !== "message.part.updated") {
      throw new Error("Expected a message part fixture")
    }
    events.emit({
      ...valid,
      properties: {
        ...valid.properties,
        part: { ...valid.properties.part, sessionID: "another-session" },
      },
    })
    events.emit({
      ...valid,
      properties: {
        ...valid.properties,
        metadata: valid.properties.part.state,
        part: {
          ...valid.properties.part,
          state: { ...valid.properties.part.state, metadata: {} },
        },
      },
    })
    await Promise.resolve()

    expect(
      readAgentDraftMetadata(
        sessions.find(({ id }) => id === draft.threadId)?.metadata
      )
    ).toMatchObject({ phase: "interview", revision: 1 })
    expect(client.session.update).not.toHaveBeenCalled()
    expect(client.instance.dispose).not.toHaveBeenCalled()
    unsubscribe?.()
  })

  it("keeps activation failure explicit until retry and reuses a provenance-marked first Session", async () => {
    const { workspace, events, client, agents, status, sessions } =
      createHarness()
    const draft = await workspace.openAgentBuilder!()
    status[session.id] = { type: "idle" }
    status[draft.threadId] = { type: "idle" }
    const lifecycle = vi.fn()
    const onError = vi.fn()
    const unsubscribe = workspace.subscribeAgentLifecycle?.(lifecycle, onError)
    const receipt = createdAgentEvent({ threadId: draft.threadId })

    events.emit(receipt)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(
      readAgentDraftMetadata(
        sessions.find(({ id }) => id === draft.threadId)?.metadata
      )
    ).toMatchObject({
      phase: "activation-failed",
      revision: 3,
      lastError: "OpenCode did not discover Agent research-agent",
    })

    events.emit(receipt)
    await Promise.resolve()
    expect(client.instance.dispose).toHaveBeenCalledTimes(1)

    agents.push({
      name: "research-agent",
      description: "Finds and synthesizes primary sources",
      mode: "primary",
      native: false,
      permission: [],
      options: { aos_ui_name: "Research Agent" },
    })
    sessions.push({
      ...session,
      id: "session-existing-first",
      slug: "existing-first",
      agent: "research-agent",
      metadata: {
        aos_ui: {
          version: 1,
          kind: "agent-first-session",
          draftThreadId: draft.threadId,
        },
      },
    })
    status["session-existing-first"] = { type: "idle" }

    await workspace.retryAgentDraft!(draft.draftAgentId)
    await vi.waitFor(() =>
      expect(lifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "draft-promoted",
          draftAgentId: draft.draftAgentId,
          agentId: "research-agent",
          threadId: "session-existing-first",
          revision: 5,
        })
      )
    )
    expect(client.session.create).toHaveBeenCalledTimes(1)
    expect(client.instance.dispose).toHaveBeenCalledTimes(2)
    unsubscribe?.()
  })

  it("holds the scoped send barrier only while disposing and re-listing Agents", async () => {
    const { workspace, events, client, agents, status, ownership } =
      createHarness()
    const draft = await workspace.openAgentBuilder!()
    status[session.id] = { type: "idle" }
    status[draft.threadId] = { type: "idle" }
    agents.push({
      name: "research-agent",
      description: "Finds and synthesizes primary sources",
      mode: "primary",
      native: false,
      permission: [],
      options: { aos_ui_name: "Research Agent" },
    })
    const disposal = deferred<{ data: true }>()
    vi.mocked(client.instance.dispose).mockImplementationOnce(
      () => disposal.promise as never
    )
    const lifecycle = vi.fn()
    const unsubscribe = workspace.subscribeAgentLifecycle?.(lifecycle)

    events.emit(createdAgentEvent({ threadId: draft.threadId }))
    await vi.waitFor(() => expect(client.instance.dispose).toHaveBeenCalled())
    expect(() => ownership.assertSendAvailable()).toThrow(
      "reloading Agent configuration"
    )

    disposal.resolve({ data: true })
    await vi.waitFor(() =>
      expect(lifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ type: "draft-promoted" })
      )
    )
    expect(() => ownership.assertSendAvailable()).not.toThrow()
    unsubscribe?.()
  })

  it("recovers an ambiguous first-Session response without creating a duplicate", async () => {
    const { workspace, events, client, agents, status, sessions } =
      createHarness()
    const draft = await workspace.openAgentBuilder!()
    status[session.id] = { type: "idle" }
    status[draft.threadId] = { type: "idle" }
    agents.push({
      name: "research-agent",
      description: "Finds and synthesizes primary sources",
      mode: "primary",
      native: false,
      permission: [],
      options: { aos_ui_name: "Research Agent" },
    })
    vi.mocked(client.session.create).mockRejectedValueOnce(
      new Error("first Session response was lost") as never
    )
    const onError = vi.fn()
    const lifecycle = vi.fn()
    const unsubscribe = workspace.subscribeAgentLifecycle?.(lifecycle, onError)

    events.emit(createdAgentEvent({ threadId: draft.threadId }))
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(
      readAgentDraftMetadata(
        sessions.find(({ id }) => id === draft.threadId)?.metadata
      )
    ).toMatchObject({ phase: "activation-failed" })

    sessions.push({
      ...session,
      id: "session-created-despite-lost-response",
      slug: "created-despite-lost-response",
      agent: "research-agent",
      metadata: {
        aos_ui: {
          version: 1,
          kind: "agent-first-session",
          draftThreadId: draft.threadId,
        },
      },
    })
    status["session-created-despite-lost-response"] = { type: "idle" }
    await workspace.retryAgentDraft!(draft.draftAgentId)

    await vi.waitFor(() =>
      expect(lifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "draft-promoted",
          threadId: "session-created-despite-lost-response",
        })
      )
    )
    // One Builder Session request plus the one ambiguous first-Session request;
    // retry discovers provenance instead of issuing a third create.
    expect(client.session.create).toHaveBeenCalledTimes(2)
    unsubscribe?.()
  })

  it("recovers an interrupted activating draft from a strict persisted tool receipt", async () => {
    const { workspace, client, agents, sessions, messages, status } =
      createHarness()
    const threadId = "session-recovering-draft"
    sessions.push({
      ...session,
      id: threadId,
      slug: "recovering-draft",
      agent: "agent-builder",
      metadata: {
        aos_ui: {
          ...createAgentDraftMetadata(),
          phase: "activating",
          revision: 2,
        },
      },
    })
    status[session.id] = { type: "idle" }
    status[threadId] = { type: "idle" }
    agents.push({
      name: "research-agent",
      description: "Finds and synthesizes primary sources",
      mode: "primary",
      native: false,
      permission: [],
      options: { aos_ui_name: "Research Agent" },
    })
    const receipt = createdAgentEvent({ threadId })
    if (receipt.type !== "message.part.updated") {
      throw new Error("Expected a message part fixture")
    }
    messages.set(threadId, [{ parts: [receipt.properties.part] }])
    const lifecycle = vi.fn()
    const unsubscribe = workspace.subscribeAgentLifecycle?.(lifecycle)

    await expect(workspace.listAgents()).resolves.toContainEqual(
      expect.objectContaining({ id: `draft:${threadId}`, phase: "activating" })
    )
    await vi.waitFor(() =>
      expect(lifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "draft-promoted",
          draftAgentId: `draft:${threadId}`,
          agentId: "research-agent",
        })
      )
    )
    expect(client.session.messages).toHaveBeenCalledWith(
      { sessionID: threadId, limit: 100 },
      { throwOnError: true }
    )
    expect(client.session.create).toHaveBeenCalledTimes(1)
    unsubscribe?.()
  })

  it("recovers a completed receipt on catalog refresh after the first activation write fails", async () => {
    const {
      workspace,
      events,
      client,
      agents,
      sessions,
      messages,
      status,
      ownership,
    } = createHarness()
    const draft = await workspace.openAgentBuilder!()
    status[draft.threadId] = { type: "idle" }
    agents.push({
      name: "research-agent",
      description: "Finds and synthesizes primary sources",
      mode: "primary",
      native: false,
      permission: [],
      options: { aos_ui_name: "Research Agent" },
    })
    const receipt = createdAgentEvent({ threadId: draft.threadId })
    if (receipt.type !== "message.part.updated") {
      throw new Error("Expected a message part fixture")
    }
    messages.set(draft.threadId, [{ parts: [receipt.properties.part] }])
    vi.mocked(client.session.update).mockRejectedValueOnce(
      new Error("activation metadata unavailable") as never
    )
    const firstError = vi.fn()
    const stopFirstWorkspace = workspace.subscribeAgentLifecycle?.(
      vi.fn(),
      firstError
    )

    events.emit(receipt)
    await vi.waitFor(() => expect(firstError).toHaveBeenCalledTimes(1))
    expect(
      readAgentDraftMetadata(
        sessions.find(({ id }) => id === draft.threadId)?.metadata
      )
    ).toMatchObject({ phase: "interview", revision: 1 })
    stopFirstWorkspace?.()

    const restartedEvents = new FakeOpenCodeEvents()
    const restarted = createOpenCodeWorkspace({
      client,
      events: restartedEvents,
      ownership,
    })
    const lifecycle = vi.fn()
    const stopRestartedWorkspace =
      restarted.subscribeAgentLifecycle?.(lifecycle)

    await restarted.refreshAgents()
    await vi.waitFor(() =>
      expect(
        readAgentDraftMetadata(
          sessions.find(({ id }) => id === draft.threadId)?.metadata
        )
      ).toMatchObject({
        phase: "activating",
        revision: 2,
        candidate: { agentId: "research-agent", callId: "call-create-1" },
      })
    )
    expect(client.session.create).toHaveBeenCalledTimes(1)

    status[session.id] = { type: "idle" }
    restartedEvents.emit(sessionIdleEvent(session.id))
    await vi.waitFor(() =>
      expect(lifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "draft-promoted",
          draftAgentId: draft.draftAgentId,
          agentId: "research-agent",
        })
      )
    )
    await restarted.refreshAgents()
    expect(client.session.create).toHaveBeenCalledTimes(2)
    stopRestartedWorkspace?.()
  })

  it("recovers a completed receipt before deletion and resumes activation", async () => {
    const {
      workspace,
      events,
      client,
      agents,
      sessions,
      messages,
      status,
      ownership,
    } = createHarness()
    const draft = await workspace.openAgentBuilder!()
    status[session.id] = { type: "idle" }
    status[draft.threadId] = { type: "idle" }
    agents.push({
      name: "research-agent",
      description: "Finds and synthesizes primary sources",
      mode: "primary",
      native: false,
      permission: [],
      options: { aos_ui_name: "Research Agent" },
    })
    const receipt = createdAgentEvent({ threadId: draft.threadId })
    if (receipt.type !== "message.part.updated") {
      throw new Error("Expected a message part fixture")
    }
    messages.set(draft.threadId, [{ parts: [receipt.properties.part] }])
    vi.mocked(client.session.update).mockRejectedValueOnce(
      new Error("activation metadata unavailable") as never
    )
    const firstError = vi.fn()
    const stopFirstWorkspace = workspace.subscribeAgentLifecycle?.(
      vi.fn(),
      firstError
    )

    events.emit(receipt)
    await vi.waitFor(() => expect(firstError).toHaveBeenCalledTimes(1))
    stopFirstWorkspace?.()

    const disposal = deferred<{ data: true }>()
    vi.mocked(client.instance.dispose).mockImplementationOnce(
      () => disposal.promise as never
    )
    const restarted = createOpenCodeWorkspace({
      client,
      events: new FakeOpenCodeEvents(),
      ownership,
    })
    const lifecycle = vi.fn()
    const stopRestartedWorkspace =
      restarted.subscribeAgentLifecycle?.(lifecycle)

    await expect(
      restarted.deleteAgentDraft!(draft.draftAgentId)
    ).rejects.toThrow("can no longer be deleted")
    await vi.waitFor(() => expect(client.instance.dispose).toHaveBeenCalled())
    expect(client.session.delete).not.toHaveBeenCalled()
    expect(
      readAgentDraftMetadata(
        sessions.find(({ id }) => id === draft.threadId)?.metadata
      )
    ).toMatchObject({
      phase: "activating",
      revision: 2,
      candidate: { agentId: "research-agent", callId: "call-create-1" },
    })

    disposal.resolve({ data: true })
    await vi.waitFor(() =>
      expect(lifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "draft-promoted",
          draftAgentId: draft.draftAgentId,
        })
      )
    )
    expect(client.session.create).toHaveBeenCalledTimes(2)
    stopRestartedWorkspace?.()
  })

  it("retries a failed kickoff at most once and deletes only an eligible draft", async () => {
    const { workspace, client, sessions, messages } = createHarness()
    vi.mocked(client.session.promptAsync).mockRejectedValueOnce(
      new Error("provider unavailable") as never
    )
    const lifecycle = vi.fn()
    const unsubscribe = workspace.subscribeAgentLifecycle?.(lifecycle)
    const draft = await workspace.openAgentBuilder!()
    expect(
      readAgentDraftMetadata(
        sessions.find(({ id }) => id === draft.threadId)?.metadata
      )
    ).toMatchObject({ phase: "start-failed", revision: 2 })

    messages.set(draft.threadId, [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: AGENT_BUILDER_KICKOFF }],
      },
    ])
    await workspace.retryAgentDraft!(draft.draftAgentId)
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
    expect(
      readAgentDraftMetadata(
        sessions.find(({ id }) => id === draft.threadId)?.metadata
      )
    ).toMatchObject({ phase: "interview", revision: 3 })

    await workspace.deleteAgentDraft!(draft.draftAgentId)
    expect(sessions).not.toContainEqual(
      expect.objectContaining({ id: draft.threadId })
    )
    expect(lifecycle).toHaveBeenCalledWith({
      type: "draft-deleted",
      draftAgentId: draft.draftAgentId,
      revision: 4,
    })
    await expect(
      workspace.deleteAgentDraft!(draft.draftAgentId)
    ).rejects.toThrow("not found")
    unsubscribe?.()
  })

  it("resends a failed kickoff when history confirms it was not delivered", async () => {
    const { workspace, client, sessions } = createHarness()
    vi.mocked(client.session.promptAsync).mockRejectedValueOnce(
      new Error("provider unavailable") as never
    )
    const draft = await workspace.openAgentBuilder!()

    await workspace.retryAgentDraft!(draft.draftAgentId)
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2)
    expect(client.session.promptAsync).toHaveBeenLastCalledWith(
      {
        sessionID: draft.threadId,
        agent: "agent-builder",
        parts: [{ type: "text", text: AGENT_BUILDER_KICKOFF }],
      },
      { throwOnError: true }
    )
    expect(
      readAgentDraftMetadata(
        sessions.find(({ id }) => id === draft.threadId)?.metadata
      )
    ).toMatchObject({ phase: "interview", revision: 3 })
    await expect(
      workspace.retryAgentDraft!(draft.draftAgentId)
    ).rejects.toThrow("not waiting for a retry")
  })

  it("refuses deletion after the typed creation receipt starts activation", async () => {
    const { workspace, events, status } = createHarness()
    const draft = await workspace.openAgentBuilder!()
    status[session.id] = { type: "busy" }
    status[draft.threadId] = { type: "idle" }
    const unsubscribe = workspace.subscribeAgentLifecycle?.(vi.fn())

    events.emit(createdAgentEvent({ threadId: draft.threadId }))
    await vi.waitFor(() =>
      expect(workspace.listAgents()).resolves.toContainEqual(
        expect.objectContaining({
          id: draft.draftAgentId,
          phase: "activating",
        })
      )
    )
    await expect(
      workspace.deleteAgentDraft!(draft.draftAgentId)
    ).rejects.toThrow("can no longer be deleted")
    unsubscribe?.()
  })

  it("keeps a newly created Session status provider-authoritative while discovery catches up", async () => {
    const { workspace, status, sessions } = createHarness()
    await workspace.createSession("build", { title: "שיחה חדשה" })
    status["session-created"] = { type: "busy" }

    expect(sessions.find(({ id }) => id === "session-created")?.title).toBe(
      "שיחה חדשה"
    )

    await expect(
      workspace.getSessionMetadata(["session-created"])
    ).resolves.toMatchObject([{ status: "running" }])
  })

  it("publishes provider busy and idle status transitions", async () => {
    const { workspace, events, status } = createHarness()
    status["session-build"] = { type: "idle" }
    const listener = vi.fn()
    const unsubscribe = workspace.subscribeSessionMetadata?.(
      ["session-build"],
      listener
    )

    status["session-build"] = { type: "busy" }
    events.emit(sessionStatusEvent("session-build", { type: "busy" }))
    await vi.waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith([
        expect.objectContaining({
          threadId: "session-build",
          status: "running",
        }),
      ])
    )

    status["session-build"] = { type: "idle" }
    events.emit(sessionIdleEvent("session-build"))
    await vi.waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith([
        expect.objectContaining({
          threadId: "session-build",
          status: "idle",
        }),
      ])
    )

    unsubscribe?.()
  })

  it("publishes an updated Session timestamp from session.updated", async () => {
    const { workspace, events, sessions } = createHarness()
    const listener = vi.fn()
    const unsubscribe = workspace.subscribeSessionMetadata?.(
      ["session-build"],
      listener
    )
    const updatedAt = 1_760_043_400_000
    const updatedSession = {
      ...sessions[0]!,
      time: { ...sessions[0]!.time, updated: updatedAt },
    }
    sessions[0] = updatedSession

    events.emit(sessionUpdatedEvent(updatedSession))

    await vi.waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith([
        expect.objectContaining({
          threadId: "session-build",
          updatedAt: new Date(updatedAt).toISOString(),
        }),
      ])
    )
    unsubscribe?.()
  })

  it("removes deleted Session metadata on session.deleted", async () => {
    const { workspace, events, sessions } = createHarness()
    const listener = vi.fn()
    const unsubscribe = workspace.subscribeSessionMetadata?.(
      ["session-build"],
      listener
    )
    const deletedSession = sessions[0]!
    sessions.splice(0, 1)

    events.emit(sessionDeletedEvent(deletedSession))

    await vi.waitFor(() => expect(listener).toHaveBeenLastCalledWith([]))
    unsubscribe?.()
  })

  it("reports a Session as waiting when OpenCode has a pending question", async () => {
    const { workspace, pendingQuestions } = createHarness()
    pendingQuestions.push({
      id: "question-1",
      sessionID: "session-build",
      questions: [
        {
          header: "Scope",
          question: "Which scope should I use?",
          options: [{ label: "Current file", description: "Stay focused" }],
        },
      ],
    })

    await expect(
      workspace.getSessionMetadata(["session-build"])
    ).resolves.toMatchObject([{ status: "waiting-for-input" }])
  })

  it("reports a Session as waiting when OpenCode has a pending permission", async () => {
    const { workspace, pendingPermissions } = createHarness()
    pendingPermissions.push({
      id: "permission-1",
      sessionID: "session-build",
      permission: "bash",
      patterns: ["git status"],
      metadata: {},
      always: [],
    })

    await expect(
      workspace.getSessionMetadata(["session-build"])
    ).resolves.toMatchObject([{ status: "waiting-for-input" }])
  })

  it("does not apply pending interactions from another Session", async () => {
    const { workspace, pendingQuestions } = createHarness()
    pendingQuestions.push({
      id: "question-other",
      sessionID: "session-other",
      questions: [],
    })

    await expect(
      workspace.getSessionMetadata(["session-build"])
    ).resolves.toMatchObject([{ status: "running" }])
  })

  it("publishes pending and resolved question metadata for an old Session", async () => {
    const { workspace, events, sessions, status, pendingQuestions } =
      createHarness()
    sessions.push({
      ...session,
      id: "session-old",
      slug: "old-session",
      title: "Old session",
      time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 },
    })
    status["session-old"] = { type: "idle" }
    const listener = vi.fn()
    const unsubscribe = workspace.subscribeSessionMetadata?.(
      ["session-old"],
      listener
    )

    pendingQuestions.push({
      id: "question-old",
      sessionID: "session-old",
      questions: [],
    })
    events.emit({
      id: "event-question-old",
      type: "question.asked",
      properties: {
        id: "question-old",
        sessionID: "session-old",
        questions: [],
      },
    })
    await vi.waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith([
        expect.objectContaining({
          threadId: "session-old",
          status: "waiting-for-input",
        }),
      ])
    )

    pendingQuestions.splice(0)
    events.emit({
      id: "event-question-resolved",
      type: "question.replied",
      properties: {
        sessionID: "session-old",
        requestID: "question-old",
        answers: [],
      },
    })
    await vi.waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith([
        expect.objectContaining({
          threadId: "session-old",
          status: "idle",
        }),
      ])
    )

    unsubscribe?.()
  })

  it("publishes pending and resolved permission metadata", async () => {
    const { workspace, events, pendingPermissions } = createHarness()
    const listener = vi.fn()
    const unsubscribe = workspace.subscribeSessionMetadata?.(
      ["session-build"],
      listener
    )

    pendingPermissions.push({
      id: "permission-build",
      sessionID: "session-build",
      permission: "bash",
      patterns: ["git status"],
      metadata: {},
      always: [],
    })
    events.emit({
      id: "event-permission-build",
      type: "permission.asked",
      properties: pendingPermissions[0]!,
    })
    await vi.waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith([
        expect.objectContaining({ status: "waiting-for-input" }),
      ])
    )

    pendingPermissions.splice(0)
    events.emit({
      id: "event-permission-resolved",
      type: "permission.replied",
      properties: {
        sessionID: "session-build",
        requestID: "permission-build",
        reply: "once",
      },
    })
    await vi.waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith([
        expect.objectContaining({ status: "running" }),
      ])
    )

    unsubscribe?.()
  })

  it("isolates metadata signals by Session and event subscription generation", async () => {
    const { workspace, events, pendingQuestions } = createHarness()
    const original = vi.fn()
    const stopOriginal = workspace.subscribeSessionMetadata?.(
      ["session-build"],
      original
    )
    const deliverRetiredEvent = events.queue({
      id: "event-retired-question",
      type: "question.asked",
      properties: {
        id: "question-retired",
        sessionID: "session-build",
        questions: [],
      },
    })
    stopOriginal?.()

    const replacement = vi.fn()
    const stopReplacement = workspace.subscribeSessionMetadata?.(
      ["session-build"],
      replacement
    )
    deliverRetiredEvent()
    await Promise.resolve()
    expect(replacement).not.toHaveBeenCalled()

    pendingQuestions.push({
      id: "question-other",
      sessionID: "session-other",
      questions: [],
    })
    events.emit({
      id: "event-other-question",
      type: "question.asked",
      properties: {
        id: "question-other",
        sessionID: "session-other",
        questions: [],
      },
    })
    await Promise.resolve()
    expect(replacement).not.toHaveBeenCalled()

    stopReplacement?.()
  })

  it("suppresses an older metadata refresh after a newer interaction event", async () => {
    const { workspace, events, expectedSession } = createHarness()
    const askedRefresh = deferred<SessionMetadata[]>()
    const resolvedRefresh = deferred<SessionMetadata[]>()
    vi.spyOn(workspace, "getSessionMetadata")
      .mockImplementationOnce(() => askedRefresh.promise)
      .mockImplementationOnce(() => resolvedRefresh.promise)
    const listener = vi.fn()
    const unsubscribe = workspace.subscribeSessionMetadata?.(
      ["session-build"],
      listener
    )

    events.emit({
      id: "event-question-pending",
      type: "question.asked",
      properties: {
        id: "question-race",
        sessionID: "session-build",
        questions: [],
      },
    })
    events.emit({
      id: "event-question-complete",
      type: "question.replied",
      properties: {
        sessionID: "session-build",
        requestID: "question-race",
        answers: [],
      },
    })

    resolvedRefresh.resolve([{ ...expectedSession, status: "running" }])
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith([
        expect.objectContaining({ status: "running" }),
      ])
    )
    askedRefresh.resolve([{ ...expectedSession, status: "waiting-for-input" }])
    await Promise.resolve()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).not.toHaveBeenCalledWith([
      expect.objectContaining({ status: "waiting-for-input" }),
    ])
    unsubscribe?.()
  })

  it("isolates delayed Todo events to their originating Session", async () => {
    const { workspace, events } = createHarness()
    const current = vi.fn()
    const stale = vi.fn()
    const stopCurrent = workspace.subscribeTodos?.("session-build", current)
    const stopStale = workspace.subscribeTodos?.("session-stale", stale)

    await vi.waitFor(() => expect(current).toHaveBeenCalledTimes(1))
    current.mockClear()
    stale.mockClear()

    events.emit({
      id: "event-stale",
      type: "todo.updated",
      properties: {
        sessionID: "session-stale",
        todos: [{ content: "Old work", status: "completed", priority: "low" }],
      },
    })

    expect(current).not.toHaveBeenCalled()
    expect(stale).toHaveBeenCalledWith([
      {
        id: "session-stale:todo:0",
        label: "Old work",
        status: "completed",
      },
    ])

    stopCurrent?.()
    stopStale?.()
  })

  it("does not let an initial Todo fetch overwrite a newer provider event", async () => {
    let finishLoad:
      | ((value: {
          data: Array<{ content: string; status: string; priority: string }>
        }) => void)
      | undefined
    const { workspace, events, client } = createHarness()
    vi.mocked(client.session.todo).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve as (value: {
            data: Array<{ content: string; status: string; priority: string }>
          }) => void
        }) as never
    )
    const listener = vi.fn()

    workspace.subscribeTodos?.("session-build", listener)
    events.emit({
      id: "event-current",
      type: "todo.updated",
      properties: {
        sessionID: "session-build",
        todos: [{ content: "Fresh", status: "in_progress", priority: "high" }],
      },
    })
    finishLoad?.({
      data: [{ content: "Stale", status: "pending", priority: "low" }],
    })
    await Promise.resolve()

    expect(listener).toHaveBeenLastCalledWith([
      { id: "session-build:todo:0", label: "Fresh", status: "active" },
    ])
  })

  it("reports an initial Todo rejection through the subscriber error boundary", async () => {
    const failure = new Error("Todo endpoint unavailable")
    const { workspace, client } = createHarness()
    vi.mocked(client.session.todo).mockImplementation(
      () => Promise.reject(failure) as never
    )
    const listener = vi.fn()
    const onError = vi.fn()

    const unsubscribe = workspace.subscribeTodos?.(
      "session-build",
      listener,
      onError
    )

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure))
    expect(listener).not.toHaveBeenCalled()
    unsubscribe?.()
  })

  it("suppresses a delayed initial Todo callback after unsubscribe", async () => {
    const pending = deferred<TodoResponse>()
    const { workspace, client } = createHarness()
    vi.mocked(client.session.todo).mockImplementation(
      () => pending.promise as never
    )
    const listener = vi.fn()
    const onError = vi.fn()

    const unsubscribe = workspace.subscribeTodos?.(
      "session-build",
      listener,
      onError
    )
    unsubscribe?.()
    pending.resolve({
      data: [{ content: "Too late", status: "pending", priority: "low" }],
    })
    await pending.promise
    await Promise.resolve()

    expect(listener).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it("suppresses a delayed initial Todo error after unsubscribe", async () => {
    const pending = deferred<TodoResponse>()
    const observedRejection = pending.promise.catch(() => undefined)
    const { workspace, client } = createHarness()
    vi.mocked(client.session.todo).mockImplementation(
      () => pending.promise as never
    )
    const onError = vi.fn()

    const unsubscribe = workspace.subscribeTodos?.(
      "session-build",
      vi.fn(),
      onError
    )
    unsubscribe?.()
    pending.reject(new Error("Delayed failure"))
    await observedRejection
    await Promise.resolve()

    expect(onError).not.toHaveBeenCalled()
  })

  it("ignores a queued event from a retired subscription generation", async () => {
    const { workspace, events } = createHarness()
    const original = vi.fn()
    const stopOriginal = workspace.subscribeTodos?.("session-build", original)
    await vi.waitFor(() => expect(original).toHaveBeenCalledTimes(1))
    original.mockClear()

    const deliverRetiredEvent = events.queue({
      id: "event-retired",
      type: "todo.updated",
      properties: {
        sessionID: "session-build",
        todos: [
          { content: "Retired work", status: "completed", priority: "low" },
        ],
      },
    })
    stopOriginal?.()

    const replacement = vi.fn()
    const stopReplacement = workspace.subscribeTodos?.(
      "session-build",
      replacement
    )
    await vi.waitFor(() => expect(replacement).toHaveBeenCalledTimes(1))
    replacement.mockClear()

    deliverRetiredEvent()

    expect(replacement).not.toHaveBeenCalled()
    stopReplacement?.()
  })
})

function activityProviderEvent({
  id,
  type,
  threadId,
  sequence,
  agentId,
  properties = {},
}: {
  id: string
  type: string
  threadId: string
  sequence: number
  agentId?: string
  properties?: Record<string, unknown>
}): OpenCodeWorkspaceEvent {
  const eventProperties = { sessionID: threadId, ...properties }
  return {
    type,
    sessionId: threadId,
    ...(agentId ? { agentId } : {}),
    properties: eventProperties,
    raw: {
      payload: {
        id,
        type,
        properties: eventProperties,
        durable: { aggregateID: threadId, seq: sequence, version: sequence },
      },
    },
  }
}

describe("OpenCode activity publishing", () => {
  it("advertises activity and shares one provider connection until every listener unsubscribes", async () => {
    const { workspace, events } = createHarness()

    expect(getWorkspaceCapabilities(workspace).activityEvents).toBe(true)

    const stopActivity = workspace.subscribeActivity?.(vi.fn())
    const stopTodos = workspace.subscribeTodos?.("session-build", vi.fn())
    expect(events.subscribeCalls).toBe(1)
    expect(events.listenerCount).toBe(1)

    stopActivity?.()
    expect(events.listenerCount).toBe(1)
    stopTodos?.()
    expect(events.listenerCount).toBe(0)
  })

  it("does not carry an asynchronously resolved lifecycle into a later observation", async () => {
    const { workspace, events, client } = createHarness()
    const lookup = deferred<{
      data: Session
      request: Request
      response: Response
    }>()
    vi.mocked(client.session.get).mockImplementationOnce(() => lookup.promise)
    const oldActivity = vi.fn<(event: WorkspaceActivityEvent) => void>()
    const stopOld = workspace.subscribeActivity?.(oldActivity)

    events.emit(
      activityProviderEvent({
        id: "stale-run",
        type: "session.status",
        threadId: "session-delayed",
        sequence: 1,
        properties: { status: { type: "busy" } },
      })
    )
    await vi.waitFor(() => expect(client.session.get).toHaveBeenCalledOnce())

    stopOld?.()
    const newActivity = vi.fn<(event: WorkspaceActivityEvent) => void>()
    const stopNew = workspace.subscribeActivity?.(newActivity)
    lookup.resolve({
      data: { ...session, id: "session-delayed", agent: "review" },
      request: new Request("http://opencode.test/session/session-delayed"),
      response: new Response(),
    })
    events.emit(
      activityProviderEvent({
        id: "stale-idle",
        type: "session.idle",
        threadId: "session-delayed",
        sequence: 2,
      })
    )
    events.emit(
      activityProviderEvent({
        id: "observation-sentinel",
        type: "question.asked",
        threadId: "session-delayed",
        sequence: 3,
        properties: { id: "observation-sentinel", questions: [] },
      })
    )

    await vi.waitFor(() => expect(newActivity).toHaveBeenCalledTimes(1))
    expect(oldActivity).not.toHaveBeenCalled()
    expect(newActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "attention-requested",
        requestId: "observation-sentinel",
      })
    )
    stopNew?.()
  })

  it("isolates throwing error observers and continues processing provider events", async () => {
    const { workspace, events, client } = createHarness()
    await workspace.getSessionMetadata([session.id])
    vi.mocked(client.session.get).mockRejectedValueOnce(
      new Error("lookup unavailable")
    )
    const throwingError = vi.fn(() => {
      throw new Error("observer failed")
    })
    const observedError = vi.fn<(error: Error) => void>()
    const activity = vi.fn<(event: WorkspaceActivityEvent) => void>()
    const stopThrowing = workspace.subscribeActivity?.(vi.fn(), throwingError)
    const stopObserved = workspace.subscribeActivity?.(activity, observedError)

    events.emit(
      activityProviderEvent({
        id: "failed-lookup",
        type: "session.status",
        threadId: "session-unavailable",
        sequence: 1,
        properties: { status: { type: "busy" } },
      })
    )
    events.emit(
      activityProviderEvent({
        id: "after-failed-observer",
        type: "question.asked",
        threadId: session.id,
        sequence: 2,
        properties: { id: "after-failed-observer", questions: [] },
      })
    )

    await vi.waitFor(() => expect(observedError).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(activity).toHaveBeenCalledOnce())
    expect(throwingError).toHaveBeenCalledOnce()
    expect(observedError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "lookup unavailable" })
    )
    expect(activity).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "after-failed-observer" })
    )
    stopThrowing?.()
    stopObserved?.()
  })

  it("ignores a run start without a stable provider event ID", async () => {
    const { workspace, events } = createHarness()
    await workspace.getSessionMetadata([session.id])
    const activity = vi.fn<(event: WorkspaceActivityEvent) => void>()
    const stop = workspace.subscribeActivity?.(activity)

    events.emit({
      type: "session.status",
      sessionId: session.id,
      properties: {
        sessionID: session.id,
        status: { type: "busy" },
      },
      durable: { aggregateID: session.id, seq: 1, version: 1 },
    })
    events.emit(
      activityProviderEvent({
        id: "idle-after-missing-id",
        type: "session.idle",
        threadId: session.id,
        sequence: 2,
      })
    )
    events.emit(
      activityProviderEvent({
        id: "missing-id-sentinel",
        type: "question.asked",
        threadId: session.id,
        sequence: 3,
        properties: { id: "missing-id-sentinel", questions: [] },
      })
    )

    await vi.waitFor(() => expect(activity).toHaveBeenCalledTimes(1))
    expect(activity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "attention-requested",
        requestId: "missing-id-sentinel",
      })
    )
    stop?.()
  })

  it("publishes one observed run lifecycle across busy, retry, idle, and duplicate terminal events", async () => {
    const { workspace, events, status } = createHarness()
    status[session.id] = { type: "busy" }

    await workspace.getSessionMetadata([session.id])
    const activity = vi.fn<(event: WorkspaceActivityEvent) => void>()
    const stop = workspace.subscribeActivity?.(activity)

    expect(activity).not.toHaveBeenCalled()

    events.emit(
      activityProviderEvent({
        id: "run-1",
        type: "session.status",
        threadId: session.id,
        sequence: 1,
        properties: { status: { type: "busy" } },
      })
    )
    events.emit(
      activityProviderEvent({
        id: "run-retry-1",
        type: "session.status",
        threadId: session.id,
        sequence: 2,
        properties: {
          status: {
            type: "retry",
            attempt: 1,
            message: "private provider failure",
            next: 1_760_000_400_000,
          },
        },
      })
    )
    events.emit(
      activityProviderEvent({
        id: "run-idle-1",
        type: "session.idle",
        threadId: session.id,
        sequence: 3,
      })
    )
    events.emit(
      activityProviderEvent({
        id: "run-idle-duplicate",
        type: "session.status",
        threadId: session.id,
        sequence: 4,
        properties: { status: { type: "idle" } },
      })
    )
    events.emit(
      activityProviderEvent({
        id: "run-error-duplicate",
        type: "session.error",
        threadId: session.id,
        sequence: 5,
        properties: {
          error: { name: "UnknownError", data: { message: "private error" } },
        },
      })
    )
    events.emit(
      activityProviderEvent({
        id: "run-retry-too-late",
        type: "session.status",
        threadId: session.id,
        sequence: 2,
        properties: {
          status: {
            type: "retry",
            attempt: 1,
            message: "late private retry",
            next: 1_760_000_500_000,
          },
        },
      })
    )

    await vi.waitFor(() => expect(activity).toHaveBeenCalledTimes(2))
    expect(activity.mock.calls.map(([event]) => event)).toEqual([
      {
        id: "opencode:run:session-build:run-1:started",
        agentId: "build",
        threadId: "session-build",
        occurredAt: expect.any(String),
        type: "run-started",
        lifecycleId: "opencode:run:session-build:run-1",
      },
      {
        id: "opencode:run:session-build:run-1:finished",
        agentId: "build",
        threadId: "session-build",
        occurredAt: expect.any(String),
        type: "run-finished",
        lifecycleId: "opencode:run:session-build:run-1",
      },
    ])
    stop?.()
  })

  it("clears run sequence state when a Session is deleted", async () => {
    const { workspace, events } = createHarness()
    await workspace.getSessionMetadata([session.id])
    const activity = vi.fn<(event: WorkspaceActivityEvent) => void>()
    const stop = workspace.subscribeActivity?.(activity)

    events.emit(
      activityProviderEvent({
        id: "before-delete",
        type: "session.status",
        threadId: session.id,
        sequence: 10,
        properties: { status: { type: "busy" } },
      })
    )
    await vi.waitFor(() => expect(activity).toHaveBeenCalledOnce())

    events.emit(sessionDeletedEvent(session))
    events.emit(sessionUpdatedEvent(session))
    events.emit(
      activityProviderEvent({
        id: "after-delete",
        type: "session.status",
        threadId: session.id,
        sequence: 1,
        properties: { status: { type: "busy" } },
      })
    )

    await vi.waitFor(() => expect(activity).toHaveBeenCalledTimes(2))
    expect(
      activity.mock.calls.map(([event]) =>
        "lifecycleId" in event ? event.lifecycleId : undefined
      )
    ).toEqual([
      "opencode:run:session-build:before-delete",
      "opencode:run:session-build:after-delete",
    ])
    stop?.()
  })

  it("does not synthesize completion from initial status hydration", async () => {
    const { workspace, events, status } = createHarness()
    status[session.id] = { type: "busy" }
    await workspace.getSessionMetadata([session.id])
    const activity = vi.fn<(event: WorkspaceActivityEvent) => void>()
    const stop = workspace.subscribeActivity?.(activity)

    events.emit(
      activityProviderEvent({
        id: "idle-after-hydration",
        type: "session.idle",
        threadId: session.id,
        sequence: 1,
      })
    )
    events.emit(
      activityProviderEvent({
        id: "question-after-hydration",
        type: "question.asked",
        threadId: session.id,
        sequence: 2,
        properties: { id: "question-after-hydration", questions: [] },
      })
    )

    await vi.waitFor(() => expect(activity).toHaveBeenCalledTimes(1))
    expect(activity).toHaveBeenCalledWith(
      expect.objectContaining({ type: "attention-requested" })
    )
    stop?.()
  })

  it("publishes a terminal failure only for an observed active lifecycle and suppresses cancellation", async () => {
    const { workspace, events } = createHarness()
    await workspace.getSessionMetadata([session.id])
    const activity = vi.fn<(event: WorkspaceActivityEvent) => void>()
    const stop = workspace.subscribeActivity?.(activity)

    events.emit(
      activityProviderEvent({
        id: "run-2",
        type: "session.status",
        threadId: session.id,
        sequence: 1,
        properties: { status: { type: "busy" } },
      })
    )
    events.emit(
      activityProviderEvent({
        id: "run-malformed-error-2",
        type: "session.error",
        threadId: session.id,
        sequence: 2,
      })
    )
    await vi.waitFor(() => expect(activity).toHaveBeenCalledTimes(1))
    events.emit(
      activityProviderEvent({
        id: "run-error-2",
        type: "session.error",
        threadId: session.id,
        sequence: 3,
        properties: {
          error: {
            name: "APIError",
            data: { message: "secret provider error", isRetryable: false },
          },
        },
      })
    )
    events.emit(
      activityProviderEvent({
        id: "run-3",
        type: "session.status",
        threadId: session.id,
        sequence: 4,
        properties: { status: { type: "busy" } },
      })
    )
    events.emit(
      activityProviderEvent({
        id: "run-cancelled-3",
        type: "session.error",
        threadId: session.id,
        sequence: 5,
        properties: {
          error: {
            name: "MessageAbortedError",
            data: { message: "user cancelled" },
          },
        },
      })
    )
    events.emit(
      activityProviderEvent({
        id: "question-after-cancel",
        type: "question.asked",
        threadId: session.id,
        sequence: 6,
        properties: { id: "question-after-cancel", questions: [] },
      })
    )

    await vi.waitFor(() => expect(activity).toHaveBeenCalledTimes(4))
    expect(activity.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        type: "run-started",
        lifecycleId: "opencode:run:session-build:run-2",
      }),
      {
        id: "opencode:run:session-build:run-2:failed",
        agentId: "build",
        threadId: "session-build",
        occurredAt: expect.any(String),
        type: "run-failed",
        lifecycleId: "opencode:run:session-build:run-2",
      },
      expect.objectContaining({
        type: "run-started",
        lifecycleId: "opencode:run:session-build:run-3",
      }),
      expect.objectContaining({
        type: "attention-requested",
        requestId: "question-after-cancel",
      }),
    ])
    stop?.()
  })

  it("maps legacy and v2 questions and permissions with stable correlation and no content", async () => {
    const { workspace, events } = createHarness()
    await workspace.getSessionMetadata([session.id])
    const received: WorkspaceActivityEvent[] = []
    const stop = workspace.subscribeActivity?.((event) => received.push(event))
    const fixtures = [
      {
        askedType: "question.asked",
        resolvedType: "question.replied",
        requestId: "question-legacy",
        kind: "question" as const,
        askedContent: {
          questions: [{ question: "private question", options: [] }],
        },
        resolvedContent: { answers: [["private answer"]] },
      },
      {
        askedType: "question.v2.asked",
        resolvedType: "question.v2.rejected",
        requestId: "question-v2",
        kind: "question" as const,
        askedContent: {
          questions: [{ question: "private v2 question", options: [] }],
        },
        resolvedContent: {},
      },
      {
        askedType: "permission.asked",
        resolvedType: "permission.rejected",
        requestId: "permission-legacy",
        kind: "permission" as const,
        askedContent: {
          permission: "bash",
          patterns: ["private command"],
        },
        resolvedContent: { response: "reject" },
      },
      {
        askedType: "permission.v2.asked",
        resolvedType: "permission.v2.replied",
        requestId: "permission-v2",
        kind: "permission" as const,
        askedContent: {
          action: "read",
          resources: ["private resource"],
        },
        resolvedContent: { reply: "reject" },
      },
    ]

    fixtures.forEach((fixture, index) => {
      const sequence = index * 2 + 1
      events.emit(
        activityProviderEvent({
          id: `attention-asked-${index}`,
          type: fixture.askedType,
          threadId: session.id,
          sequence,
          properties: {
            id: fixture.requestId,
            ...fixture.askedContent,
          },
        })
      )
      events.emit(
        activityProviderEvent({
          id: `attention-resolved-${index}`,
          type: fixture.resolvedType,
          threadId: session.id,
          sequence: sequence + 1,
          properties: {
            requestID: fixture.requestId,
            ...fixture.resolvedContent,
          },
        })
      )
    })

    await vi.waitFor(() => expect(received).toHaveLength(8))
    for (const [index, fixture] of fixtures.entries()) {
      expect(received[index * 2]).toEqual({
        id: `opencode:attention:session-build:${fixture.kind}:${fixture.requestId}:requested`,
        agentId: "build",
        threadId: "session-build",
        occurredAt: expect.any(String),
        type: "attention-requested",
        attentionKind: fixture.kind,
        requestId: fixture.requestId,
      })
      expect(received[index * 2 + 1]).toEqual({
        id: `opencode:attention:session-build:${fixture.requestId}:resolved`,
        agentId: "build",
        threadId: "session-build",
        occurredAt: expect.any(String),
        type: "attention-resolved",
        requestId: fixture.requestId,
      })
    }
    stop?.()
  })

  it("deduplicates attention events without dropping a distinct lower-sequence request", async () => {
    const { workspace, events } = createHarness()
    await workspace.getSessionMetadata([session.id])
    const activity = vi.fn<(event: WorkspaceActivityEvent) => void>()
    const stop = workspace.subscribeActivity?.(activity)
    const asked = activityProviderEvent({
      id: "question-new",
      type: "question.asked",
      threadId: session.id,
      sequence: 20,
      properties: { id: "question-order", questions: [] },
    })

    events.emit(asked)
    events.emit(asked)
    events.emit(
      activityProviderEvent({
        id: "question-resolved",
        type: "question.replied",
        threadId: session.id,
        sequence: 22,
        properties: { requestID: "question-order", answers: [] },
      })
    )
    events.emit(
      activityProviderEvent({
        id: "question-late",
        type: "question.v2.asked",
        threadId: session.id,
        sequence: 21,
        properties: { id: "question-late", questions: [] },
      })
    )

    await vi.waitFor(() => expect(activity).toHaveBeenCalledTimes(3))
    expect(
      activity.mock.calls.map(([event]) => [
        event.type,
        "requestId" in event ? event.requestId : undefined,
      ])
    ).toEqual([
      ["attention-requested", "question-order"],
      ["attention-resolved", "question-order"],
      ["attention-requested", "question-late"],
    ])
    stop?.()
  })

  it("publishes delayed events under their authoritative owner and ignores unknown or cross-Agent origins", async () => {
    const { workspace, events, client, sessions, status } = createHarness()
    sessions.push({
      ...session,
      id: "session-review",
      slug: "review-session",
      agent: "review",
    })
    status["session-review"] = { type: "idle" }
    await workspace.getSessionMetadata([session.id, "session-review"])
    const activity = vi.fn<(event: WorkspaceActivityEvent) => void>()
    const stop = workspace.subscribeActivity?.(activity)

    events.emit(
      activityProviderEvent({
        id: "review-run",
        type: "session.status",
        threadId: "session-review",
        sequence: 1,
        properties: { status: { type: "busy" } },
      })
    )
    events.emit(
      activityProviderEvent({
        id: "cross-agent-run",
        type: "session.status",
        threadId: session.id,
        sequence: 1,
        agentId: "review",
        properties: { status: { type: "busy" } },
      })
    )
    events.emit(
      activityProviderEvent({
        id: "unknown-run",
        type: "session.status",
        threadId: "session-unknown",
        sequence: 1,
        properties: { status: { type: "busy" } },
      })
    )

    await vi.waitFor(() => expect(activity).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(client.session.get).toHaveBeenCalledWith(
        { sessionID: "session-unknown" },
        { throwOnError: true }
      )
    )
    expect(activity).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "review",
        threadId: "session-review",
        type: "run-started",
      })
    )
    stop?.()
  })

  it("publishes successful promotion as Agent ready with only allowlisted fields", async () => {
    const { workspace, events, agents, status } = createHarness()
    const draft = await workspace.openAgentBuilder!()
    status[session.id] = { type: "idle" }
    status[draft.threadId] = { type: "idle" }
    agents.push({
      name: "research-agent",
      description: "Finds and synthesizes primary sources",
      mode: "primary",
      native: false,
      permission: [],
      options: { aos_ui_name: "Research Agent" },
    })
    const activity = vi.fn<(event: WorkspaceActivityEvent) => void>()
    const stop = workspace.subscribeActivity?.(activity)

    events.emit(createdAgentEvent({ threadId: draft.threadId }))

    await vi.waitFor(() =>
      expect(activity).toHaveBeenCalledWith({
        id: "opencode:agent-ready:draft%3Asession-created:3",
        agentId: "research-agent",
        threadId: "session-created-2",
        occurredAt: expect.any(String),
        type: "agent-ready",
      })
    )
    stop?.()
  })

  it("publishes terminal activation failure without leaking the error or Agent content", async () => {
    const { workspace, events, status } = createHarness()
    const draft = await workspace.openAgentBuilder!()
    status[session.id] = { type: "idle" }
    status[draft.threadId] = { type: "idle" }
    const activity = vi.fn<(event: WorkspaceActivityEvent) => void>()
    const stop = workspace.subscribeActivity?.(activity)

    events.emit(
      createdAgentEvent({
        threadId: draft.threadId,
        name: "Private Agent Name",
        description: "Private Agent Description",
      })
    )

    await vi.waitFor(() =>
      expect(activity).toHaveBeenCalledWith({
        id: "opencode:agent-activation-failed:draft%3Asession-created:3",
        agentId: "draft:session-created",
        threadId: "session-created",
        occurredAt: expect.any(String),
        type: "agent-activation-failed",
      })
    )
    stop?.()
  })
})
