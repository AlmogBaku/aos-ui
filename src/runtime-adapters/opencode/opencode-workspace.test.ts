import type {
  GlobalSession,
  OpencodeClient,
  SessionStatus,
} from "@assistant-ui/react-opencode"
import { describe, expect, it, vi } from "vitest"

import { runWorkspaceAdapterContract } from "../workspace-adapter.contract"
import { OpenCodeSessionOwnership } from "./opencode-session-ownership"
import {
  createOpenCodeWorkspace,
  type OpenCodeEventSubscription,
} from "./opencode-workspace"
import type { OpenCodeWorkspaceEvent } from "./opencode-event"

const agent = {
  name: "build",
  description: "Builds and reviews changes",
  mode: "primary",
  native: false,
  permission: [],
  options: {},
}
const creator = {
  name: "workspace-creator",
  description: "Creates Agents",
  mode: "primary",
  hidden: true,
  native: false,
  permission: [],
  options: { aos_ui_role: "creator" },
}
const hiddenAgent = {
  name: "quiet-reviewer",
  description: "Reviews only when selected explicitly",
  mode: "primary",
  hidden: true,
  native: false,
  permission: [],
  options: { aos_ui_name: "Quiet Reviewer" },
}
const nativeAgent = {
  name: "plan",
  mode: "primary",
  native: true,
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

class FakeEvents implements OpenCodeEventSubscription {
  readonly listeners = new Set<(event: OpenCodeWorkspaceEvent) => void>()
  subscribe(listener: (event: OpenCodeWorkspaceEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(event: OpenCodeWorkspaceEvent) {
    for (const listener of this.listeners) listener(event)
  }
}

function createHarness() {
  const creationTimeline: string[] = []
  const sessions: GlobalSession[] = [session]
  const statuses: Record<string, SessionStatus> = {
    [session.id]: { type: "busy" },
  }
  const questions: Array<{ id: string; sessionID: string }> = []
  const permissions: Array<{ id: string; sessionID: string }> = []
  const events = new FakeEvents()
  const reloadThreads = vi.fn(async () => undefined)
  const client = {
    app: {
      agents: vi.fn(async () => ({
        data: [agent, creator, hiddenAgent, nativeAgent],
      })),
    },
    experimental: {
      session: { list: vi.fn(async () => ({ data: sessions })) },
    },
    session: {
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({
        data: sessions.find(({ id }) => id === sessionID),
      })),
      status: vi.fn(async () => ({ data: statuses })),
      create: vi.fn(async ({ agent: agentId }: { agent: string }) => {
        creationTimeline.push(`creating:${agentId}`)
        const created = {
          ...session,
          id: "session-created",
          title: "New session",
          agent: agentId.endsWith("-mismatch") ? "review" : agentId,
          time: { created: 1_760_000_200_000, updated: 1_760_000_200_000 },
        }
        sessions.push(created)
        statuses[created.id] = { type: "idle" }
        creationTimeline.push(`created:${created.id}`)
        return { data: created }
      }),
      todo: vi.fn(async () => ({ data: [] })),
    },
    permission: { list: vi.fn(async () => ({ data: permissions })) },
    question: { list: vi.fn(async () => ({ data: questions })) },
  } as unknown as OpencodeClient
  const ownership = new OpenCodeSessionOwnership()
  const workspace = createOpenCodeWorkspace({
    client,
    events,
    ownership,
    reloadThreads,
  })
  return {
    workspace,
    client,
    ownership,
    events,
    sessions,
    statuses,
    questions,
    permissions,
    reloadThreads,
    creationTimeline,
    expectedAgent: {
      kind: "ready" as const,
      id: "build",
      name: "build",
      description: "Builds and reviews changes",
      visibility: "visible" as const,
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

describe("OpenCode native workspace mapping", () => {
  it("derives creator role and visibility from native metadata without manufacturing an identity", async () => {
    const { workspace } = createHarness()

    await expect(workspace.listAgents()).resolves.toEqual([
      expect.objectContaining({ id: "build", visibility: "visible" }),
      expect.objectContaining({
        id: "workspace-creator",
        role: "creator",
        visibility: "hidden",
      }),
      expect.objectContaining({
        id: "quiet-reviewer",
        visibility: "hidden",
      }),
    ])
    await expect(workspace.listAgentCatalog()).resolves.toEqual([
      expect.objectContaining({
        summary: expect.objectContaining({ id: "build" }),
        editable: false,
        selectable: true,
        visibility: "visible",
      }),
      expect.objectContaining({
        summary: expect.objectContaining({ id: "quiet-reviewer" }),
        editable: false,
        selectable: false,
        visibility: "hidden",
      }),
    ])
  })

  it.each(["question", "permission"])(
    "reports exact Session ownership while a native %s waits",
    async (kind) => {
      const harness = createHarness()
      harness[kind === "question" ? "questions" : "permissions"].push({
        id: `${kind}-1`,
        sessionID: session.id,
      })

      await expect(
        harness.workspace.getSessionMetadata([session.id])
      ).resolves.toEqual([
        expect.objectContaining({
          threadId: session.id,
          agentId: "build",
          status: "waiting-for-input",
        }),
      ])
    }
  )

  it("publishes Session-scoped Todos without cross-Session leakage", async () => {
    const { workspace, events } = createHarness()
    const buildListener = vi.fn()
    const otherListener = vi.fn()
    const stopBuild = workspace.subscribeTodos?.("session-build", buildListener)
    const stopOther = workspace.subscribeTodos?.("session-other", otherListener)
    await Promise.resolve()
    buildListener.mockClear()
    otherListener.mockClear()

    events.emit({
      type: "todo.updated",
      properties: {
        sessionID: "session-build",
        todos: [
          { content: "Inspect types", status: "in_progress", priority: "high" },
        ],
      },
    })

    expect(buildListener).toHaveBeenCalledWith([
      { id: "session-build:todo:0", label: "Inspect types", status: "active" },
    ])
    expect(otherListener).not.toHaveBeenCalled()
    stopBuild?.()
    stopOther?.()
  })

  it("coalesces native Session events into one thread reload", async () => {
    const { workspace, events, reloadThreads } = createHarness()
    const stop = workspace.subscribeAgentCatalog?.(vi.fn())

    events.emit({ type: "session.created", properties: { info: session } })
    events.emit({ type: "session.updated", properties: { info: session } })
    await vi.waitFor(() => expect(reloadThreads).toHaveBeenCalledTimes(1))
    stop?.()
  })

  it("refreshes authoritative ownership before reloading after reconnect", async () => {
    const { workspace, events, ownership, sessions, reloadThreads, client } =
      createHarness()
    sessions.splice(0, sessions.length, {
      ...session,
      id: "session-inbound",
      agent: "agent-builder",
    })
    const stop = workspace.subscribeAgentCatalog?.(vi.fn())

    events.emit({ type: "stream.reconnected", properties: {} })
    await vi.waitFor(() => expect(reloadThreads).toHaveBeenCalledOnce())

    await expect(ownership.find(client, "session-inbound")).resolves.toBe(
      "agent-builder"
    )
    stop?.()
  })

  it("runs a trailing ownership refresh when reconnect arrives during a reload", async () => {
    const { workspace, events, ownership, sessions, reloadThreads, client } =
      createHarness()
    let finishFirstReload!: () => void
    reloadThreads.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishFirstReload = () => resolve(undefined)
        })
    )
    const stop = workspace.subscribeAgentCatalog?.(vi.fn())

    events.emit({ type: "session.created", properties: { info: session } })
    await vi.waitFor(() => expect(reloadThreads).toHaveBeenCalledOnce())

    sessions.splice(0, sessions.length, {
      ...session,
      id: "session-during-reload",
      agent: "agent-builder",
    })
    events.emit({ type: "stream.reconnected", properties: {} })
    finishFirstReload()

    await vi.waitFor(() => expect(reloadThreads).toHaveBeenCalledTimes(2))
    expect(client.experimental.session.list).toHaveBeenCalledOnce()
    await expect(ownership.find(client, "session-during-reload")).resolves.toBe(
      "agent-builder"
    )
    stop?.()
  })
})
