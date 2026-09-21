import { describe, expect, it, vi } from "vitest"

import { ActivityStore } from "../../lib/notifications/store"
import type { SessionMetadata, WorkspaceActivityEvent } from "../contracts"
import { getWorkspaceCapabilities } from "../workspace-state"
import { fixtureActivityScenarioNames } from "./fixture-activity"
import { FIXTURE_NOW, createFixtureWorkspace } from "./fixture-workspace"

describe("FixtureWorkspace", () => {
  it("publishes visible Agents with unique IDs, names, and supported icons", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const agents = await workspace.listAgents()
    const roster = agents.filter(
      ({ role, visibility }) => role !== "creator" && visibility !== "hidden"
    )

    expect(roster.length).toBeGreaterThan(0)
    expect(new Set(roster.map(({ id }) => id)).size).toBe(roster.length)
    expect(roster.every(({ name }) => name.trim().length > 0)).toBe(true)
    expect(roster.every(({ icon }) => icon?.kind === "symbol")).toBe(true)
    expect(
      roster.every(
        ({ visibility, role }) => visibility === "visible" && role !== "creator"
      )
    ).toBe(true)
    expect(agents.find(({ role }) => role === "creator")).toMatchObject({
      visibility: "hidden",
    })
  })

  it("shows meaningful progress in the market briefing Session", () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const listener = vi.fn()

    workspace.subscribeTodos("thread-aster-market", listener)

    expect(listener).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ status: "completed" }),
        expect.objectContaining({ status: "active" }),
        expect.objectContaining({ status: "pending" }),
      ])
    )
  })

  it("returns only requested authoritative Session metadata", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const metadata = await workspace.getSessionMetadata([
      "thread-aster-market",
      "thread-mica-quarterly",
      "missing",
    ])

    expect(
      metadata.map(({ threadId, agentId }) => [threadId, agentId])
    ).toEqual([
      ["thread-aster-market", "agent-aster"],
      ["thread-mica-quarterly", "agent-mica"],
    ])
  })

  it("binds a new Session to its provider Agent before returning it", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })

    await expect(workspace.createSession("agent-lumen")).resolves.toEqual({
      threadId: "fixture-session-001",
    })
    await expect(
      workspace.getSessionMetadata(["fixture-session-001"])
    ).resolves.toEqual([
      {
        threadId: "fixture-session-001",
        agentId: "agent-lumen",
        status: "idle",
        updatedAt: FIXTURE_NOW.toISOString(),
        unread: false,
      },
    ])
  })

  it("acknowledges an unread Session once and republishes its metadata", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const published: SessionMetadata[][] = []
    const stop = workspace.subscribeSessionMetadata(
      ["thread-lumen-roadmap", "thread-nori-copy"],
      (metadata) => published.push(metadata)
    )

    expect(getWorkspaceCapabilities(workspace).sessionReadState).toBe(true)
    await expect(
      workspace.getSessionMetadata(["thread-lumen-roadmap"])
    ).resolves.toEqual([
      expect.objectContaining({
        threadId: "thread-lumen-roadmap",
        unread: true,
      }),
    ])

    await workspace.markSessionRead("thread-lumen-roadmap")
    await expect(
      workspace.getSessionMetadata(["thread-lumen-roadmap"])
    ).resolves.toEqual([expect.objectContaining({ unread: false })])
    expect(published).toEqual([
      await workspace.getSessionMetadata([
        "thread-lumen-roadmap",
        "thread-nori-copy",
      ]),
    ])

    await workspace.markSessionRead("thread-lumen-roadmap")
    await workspace.markSessionRead("missing")
    expect(published).toHaveLength(1)
    stop()
    await workspace.markSessionRead("thread-nori-copy")
    expect(published).toHaveLength(1)
  })

  it("keeps the seeded pin and archival authoritative", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })

    await expect(
      workspace.getSessionMetadata([
        "thread-vela-metrics",
        "thread-vela-retrospective",
      ])
    ).resolves.toEqual([
      expect.objectContaining({
        threadId: "thread-vela-metrics",
        pinned: true,
      }),
      expect.objectContaining({
        threadId: "thread-vela-retrospective",
        archived: true,
      }),
    ])
  })

  it("round-trips the operator's pin and republishes the Session once", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const published: SessionMetadata[][] = []
    workspace.subscribeSessionMetadata(["thread-aster-launch"], (metadata) =>
      published.push(metadata)
    )

    await workspace.setSessionPinned("thread-aster-launch", true)
    expect(published.at(-1)?.[0]).toMatchObject({ pinned: true })
    await expect(
      workspace.getSessionMetadata(["thread-aster-launch"])
    ).resolves.toEqual([expect.objectContaining({ pinned: true })])

    await workspace.setSessionPinned("thread-aster-launch", false)
    expect(published.at(-1)?.[0]).toMatchObject({ pinned: false })
    await workspace.setSessionPinned("thread-aster-launch", false)
    expect(published).toHaveLength(2)

    await expect(workspace.setSessionPinned("missing", true)).rejects.toThrow(
      "Session not found"
    )
  })

  it("performs every Session action the workspace offers", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })

    expect(
      getWorkspaceCapabilities(
        workspace,
        [],
        await workspace.sessionActionCapabilities()
      )
    ).toMatchObject({
      sessionRename: true,
      sessionArchival: true,
      sessionDeletion: true,
      sessionPin: true,
    })
  })

  it("retains localized titles supplied by the locale-aware workspace", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })

    const created = await workspace.createSession("agent-lumen", {
      title: "שיחה חדשה",
    })
    expect(workspace.getSessionTitle(created.threadId)).toBe("שיחה חדשה")

    const creatorSession = await workspace.createSession(
      workspace.agentCreator!.id,
      { title: "סוכן חדש" }
    )
    expect(workspace.getSessionTitle(creatorSession.threadId)).toBe("סוכן חדש")
  })

  it("rejects Session creation for an unknown Agent", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    await expect(workspace.createSession("missing")).rejects.toThrow(
      "Unknown Agent"
    )
  })

  it("publishes Todos only through explicit provider events", () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const listener = vi.fn()
    const unsubscribe = workspace.subscribeTodos(
      "thread-aster-market",
      listener
    )

    expect(listener).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "todo-scope" })])
    )

    workspace.emitTodos("thread-aster-market", [
      { id: "todo-new", label: "Review result", status: "active" },
    ])
    expect(listener).toHaveBeenLastCalledWith([
      { id: "todo-new", label: "Review result", status: "active" },
    ])

    unsubscribe()
    workspace.emitTodos("thread-aster-market", [])
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("discovers a created Agent without changing creator ownership or starting a Session", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const changed = vi.fn()
    const unsubscribe = workspace.subscribeAgentCatalog(changed)
    const session = await workspace.createSession(workspace.agentCreator!.id)
    const before = workspace.listAllSessionMetadata()
    workspace.completeAgentCreation(session.threadId, {
      kind: "ready",
      id: "agent-sora",
      name: "Sora",
    })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(await workspace.refreshAgents()).toContainEqual(
      expect.objectContaining({ id: "agent-sora" })
    )
    expect(workspace.listAllSessionMetadata()).toEqual(before)
    unsubscribe()
  })

  it("rejects creation results from a non-creator Session and conflicting identities", async () => {
    const workspace = createFixtureWorkspace()
    expect(() =>
      workspace.completeAgentCreation("thread-aster-market", {
        kind: "ready",
        id: "new",
        name: "New",
      })
    ).toThrow()
    const creator = await workspace.createSession(workspace.agentCreator!.id)
    expect(() =>
      workspace.completeAgentCreation(creator.threadId, {
        kind: "ready",
        id: "agent-aster",
        name: "Replacement",
      })
    ).toThrow()
    expect(
      (await workspace.listAgents()).some(({ id }) => id === "agent-aster")
    ).toBe(true)
  })

  it("publishes every deterministic activity scenario with allowlisted payloads", () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const received: WorkspaceActivityEvent[] = []
    const stop = workspace.subscribeActivity?.((event) => received.push(event))

    expect(getWorkspaceCapabilities(workspace).activityEvents).toBe(true)
    for (const scenario of fixtureActivityScenarioNames) {
      workspace.publishActivityScenario(scenario)
    }

    expect(received).toEqual([
      {
        id: "fixture:run:aster-market:completed:started",
        agentId: "agent-aster",
        threadId: "thread-aster-market",
        occurredAt: "2026-09-03T12:01:00.000Z",
        type: "run-started",
        lifecycleId: "fixture:run:aster-market:completed",
      },
      {
        id: "fixture:run:aster-market:completed:finished",
        agentId: "agent-aster",
        threadId: "thread-aster-market",
        occurredAt: "2026-09-03T12:02:00.000Z",
        type: "run-finished",
        lifecycleId: "fixture:run:aster-market:completed",
      },
      expect.objectContaining({
        id: "fixture:run:nori-copy:failed:started",
        agentId: "agent-nori",
        threadId: "thread-nori-copy",
        type: "run-started",
      }),
      expect.objectContaining({
        id: "fixture:run:nori-copy:failed:terminal",
        agentId: "agent-nori",
        threadId: "thread-nori-copy",
        type: "run-failed",
      }),
      expect.objectContaining({
        id: "fixture:attention:lumen-roadmap:question:requested",
        agentId: "agent-lumen",
        threadId: "thread-lumen-roadmap",
        type: "attention-requested",
        attentionKind: "question",
        requestId: "fixture-question-roadmap",
      }),
      expect.objectContaining({
        id: "fixture:attention:aster-launch:permission:requested",
        agentId: "agent-aster",
        threadId: "thread-aster-launch",
        type: "attention-requested",
        attentionKind: "permission",
        requestId: "fixture-permission-launch",
      }),
      expect.objectContaining({
        id: "fixture:attention:lumen-roadmap:question:resolved",
        type: "attention-resolved",
        requestId: "fixture-question-roadmap",
      }),
      expect.objectContaining({
        id: "fixture:agent:mica:ready",
        agentId: "agent-mica",
        threadId: "thread-mica-quarterly",
        type: "agent-ready",
      }),
      expect.objectContaining({
        id: "fixture:agent:nori:activation-failed",
        agentId: "agent-nori",
        threadId: "thread-nori-copy",
        type: "agent-activation-failed",
      }),
      expect.objectContaining({ id: "fixture:duplicate:started" }),
      expect.objectContaining({ id: "fixture:duplicate:finished" }),
      expect.objectContaining({ id: "fixture:duplicate:finished" }),
      expect.objectContaining({ id: "fixture:stale-target:started" }),
      expect.objectContaining({
        id: "fixture:stale-target:finished",
        agentId: "agent-deleted",
        threadId: "thread-deleted",
        type: "run-finished",
      }),
      expect.objectContaining({
        id: "fixture:delayed:mica-quarterly:started",
        agentId: "agent-mica",
        threadId: "thread-mica-quarterly",
        type: "run-started",
      }),
      expect.objectContaining({
        id: "fixture:delayed:mica-quarterly:finished",
        agentId: "agent-mica",
        threadId: "thread-mica-quarterly",
        type: "run-finished",
      }),
    ])

    for (const event of received) {
      expect(Object.keys(event).sort()).toEqual(
        event.type === "attention-requested"
          ? [
              "agentId",
              "attentionKind",
              "id",
              "occurredAt",
              "requestId",
              "threadId",
              "type",
            ]
          : event.type === "attention-resolved"
            ? ["agentId", "id", "occurredAt", "requestId", "threadId", "type"]
            : event.type === "run-started" ||
                event.type === "run-finished" ||
                event.type === "run-failed"
              ? [
                  "agentId",
                  "id",
                  "lifecycleId",
                  "occurredAt",
                  "threadId",
                  "type",
                ]
              : ["agentId", "id", "occurredAt", "threadId", "type"]
      )
    }
    stop?.()
  })

  it("makes duplicate and stale-target scenarios observable through ActivityStore", () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const owners = new Map(
      workspace
        .listAllSessionMetadata()
        .map(({ threadId, agentId }) => [threadId, agentId])
    )
    owners.set("thread-deleted", "agent-deleted")
    const store = new ActivityStore({
      now: () => FIXTURE_NOW.getTime(),
      getThreadOwner: (threadId) => owners.get(threadId),
      getSessions: () => workspace.listAllSessionMetadata(),
    })
    workspace.subscribeActivity((event) => store.ingest(event))

    workspace.publishActivityScenario("duplicates")
    workspace.publishActivityScenario("stale-target")
    owners.delete("thread-deleted")
    store.markUnavailable("fixture:stale-target:finished")

    expect(store.records()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "fixture:duplicate:finished",
          type: "run-finished",
        }),
        expect.objectContaining({
          id: "fixture:stale-target:finished",
          type: "run-finished",
          resolved: true,
        }),
      ])
    )
  })

  it("clones activity payloads and isolates throwing listeners until cleanup", () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const observed: WorkspaceActivityEvent[] = []
    const observerError = vi.fn()
    const stopThrowing = workspace.subscribeActivity?.((event) => {
      event.agentId = "mutated-owner"
      throw new Error("listener failed")
    }, observerError)
    const stopObserved = workspace.subscribeActivity?.((event) =>
      observed.push(event)
    )

    workspace.publishActivityScenario("run-completed")

    expect(observerError).toHaveBeenCalledTimes(2)
    expect(observed.map(({ agentId }) => agentId)).toEqual([
      "agent-aster",
      "agent-aster",
    ])

    stopThrowing?.()
    stopObserved?.()
    workspace.publishActivityScenario("question")
    expect(observed).toHaveLength(2)
  })
})
