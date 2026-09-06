import { describe, expect, it, vi } from "vitest"

import { ActivityStore } from "../../notifications/store"
import type { WorkspaceActivityEvent } from "../contracts"
import {
  AGENT_BUILDER_KICKOFF,
  AGENT_DRAFT_TITLE,
} from "../opencode/agent-draft"
import { getWorkspaceCapabilities } from "../workspace-state"
import { fixtureActivityScenarioNames } from "./fixture-activity"
import { FIXTURE_NOW, createFixtureWorkspace } from "./fixture-workspace"

describe("FixtureWorkspace", () => {
  it("publishes stable primary Agent identities with genuine icons", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })

    await expect(workspace.listAgents()).resolves.toMatchObject([
      {
        id: "agent-aster",
        name: "Aster",
        icon: { kind: "symbol", symbol: "spark" },
      },
      {
        id: "agent-mica",
        name: "Mica",
        icon: { kind: "symbol", symbol: "layers" },
      },
      {
        id: "agent-lumen",
        name: "Lumen",
        icon: { kind: "symbol", symbol: "compass" },
      },
      {
        id: "agent-vela",
        name: "Vela",
        icon: { kind: "symbol", symbol: "chart" },
      },
      {
        id: "agent-nori",
        name: "Nori",
        icon: { kind: "symbol", symbol: "pen" },
      },
    ])
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
      },
    ])
  })

  it("retains localized titles supplied by the locale-aware workspace", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })

    const created = await workspace.createSession("agent-lumen", {
      title: "שיחה חדשה",
    })
    expect(workspace.getSessionTitle(created.threadId)).toBe("שיחה חדשה")

    const draft = await workspace.openAgentBuilder({
      draftTitle: "סוכן חדש",
      draftDescription: "יוצרים את הסוכן שלכם",
      firstSessionTitle: "שיחה חדשה",
    })
    expect(
      (await workspace.listAgents()).find(({ id }) => id === draft.draftAgentId)
    ).toMatchObject({
      name: "סוכן חדש",
      description: "יוצרים את הסוכן שלכם",
    })
    expect(workspace.getSessionTitle(draft.threadId)).toBe("סוכן חדש")
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

  it("models Agent Builder completion as provider-owned catalog refresh", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const catalogChanged = vi.fn()
    const unsubscribe = workspace.subscribeAgentCatalog(catalogChanged)

    const draft = workspace.openAgentBuilder()
    await expect(draft).resolves.toEqual({
      threadId: "fixture-agent-draft-001",
      draftAgentId: "draft:fixture-agent-draft-001",
    })
    expect(catalogChanged).toHaveBeenCalledTimes(1)

    workspace.promoteAgentDraft((await draft).draftAgentId, {
      kind: "ready",
      id: "agent-sora",
      name: "Sora",
      description: "Customer insight",
      icon: { kind: "symbol", symbol: "spark", tone: "teal" },
    })

    expect(catalogChanged).toHaveBeenCalledTimes(2)
    expect((await workspace.refreshAgents()).at(-1)?.name).toBe("Sora")

    unsubscribe()
    await workspace.openAgentBuilder()
    expect(catalogChanged).toHaveBeenCalledTimes(2)
  })

  it("creates a distinct provisional Agent and one Builder Session for every launch", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })

    const first = await workspace.openAgentBuilder()
    const second = await workspace.openAgentBuilder()
    const agents = await workspace.listAgents()
    const sessions = workspace.listAllSessionMetadata()

    expect(second).not.toEqual(first)
    expect(
      agents
        .filter(({ kind }) => kind === "provisional")
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          icon: agent.icon,
        }))
    ).toEqual([
      {
        id: first.draftAgentId,
        name: AGENT_DRAFT_TITLE,
        icon: expect.objectContaining({
          kind: "symbol",
          symbol: "unassigned",
        }),
      },
      {
        id: second.draftAgentId,
        name: AGENT_DRAFT_TITLE,
        icon: expect.objectContaining({
          kind: "symbol",
          symbol: "unassigned",
        }),
      },
    ])
    expect(agents.some(({ id }) => id === "agent-builder")).toBe(false)
    expect(
      sessions.filter(({ agentId }) => agentId === first.draftAgentId)
    ).toEqual([
      expect.objectContaining({
        threadId: first.threadId,
        status: "waiting-for-input",
      }),
    ])
    expect(
      sessions.filter(({ agentId }) => agentId === second.draftAgentId)
    ).toEqual([
      expect.objectContaining({
        threadId: second.threadId,
        status: "waiting-for-input",
      }),
    ])
    expect(workspace.getBuilderKickoff(first.threadId)).toBe(
      AGENT_BUILDER_KICKOFF
    )
    expect(workspace.getBuilderKickoff(second.threadId)).toBe(
      AGENT_BUILDER_KICKOFF
    )
  })

  it("keeps an unfinished Agent draft in the Agent catalog after twelve hours", async () => {
    let now = FIXTURE_NOW
    const workspace = createFixtureWorkspace({ clock: () => now })
    const { draftAgentId } = await workspace.openAgentBuilder()

    now = new Date(FIXTURE_NOW.getTime() + 12 * 60 * 60 * 1_000)

    await expect(workspace.listAgents()).resolves.toContainEqual(
      expect.objectContaining({
        kind: "provisional",
        id: draftAgentId,
        phase: "interview",
      })
    )
  })

  it("does not create ordinary Sessions for a provisional Agent", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const { draftAgentId } = await workspace.openAgentBuilder()

    await expect(workspace.createSession(draftAgentId)).rejects.toThrow(
      "not ready"
    )
  })

  it("promotes a draft into a ready Agent with its first ordinary Session", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const lifecycle = vi.fn()
    workspace.subscribeAgentLifecycle(lifecycle)
    const { draftAgentId } = await workspace.openAgentBuilder()

    const promoted = workspace.promoteAgentDraft(draftAgentId, {
      kind: "ready",
      id: "agent-sora",
      name: "Sora",
      description: "Customer insight",
      icon: { kind: "symbol", symbol: "spark", tone: "teal" },
    })

    await expect(workspace.listAgents()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "ready",
          id: "agent-sora",
          name: "Sora",
        }),
      ])
    )
    expect(
      (await workspace.listAgents()).some(({ id }) => id === draftAgentId)
    ).toBe(false)
    expect(
      workspace
        .listAllSessionMetadata()
        .filter(({ agentId }) => agentId === "agent-sora")
    ).toEqual([
      expect.objectContaining({
        threadId: promoted.threadId,
        status: "idle",
      }),
    ])
    expect(lifecycle).toHaveBeenLastCalledWith({
      type: "draft-promoted",
      draftAgentId,
      agentId: "agent-sora",
      threadId: promoted.threadId,
      revision: 3,
    })
  })

  it("keeps activation failures actionable and promotes the draft on retry", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const lifecycle = vi.fn()
    workspace.subscribeAgentLifecycle(lifecycle)
    const { draftAgentId, threadId: builderThreadId } =
      await workspace.openAgentBuilder()
    const readyAgent = {
      kind: "ready" as const,
      id: "agent-sora",
      name: "Sora",
      description: "Customer insight",
      icon: {
        kind: "symbol" as const,
        symbol: "spark" as const,
        tone: "teal" as const,
      },
    }

    workspace.failAgentDraftActivation(
      draftAgentId,
      "OpenCode did not discover Sora",
      readyAgent
    )

    await expect(workspace.listAgents()).resolves.toContainEqual(
      expect.objectContaining({
        kind: "provisional",
        id: draftAgentId,
        phase: "activation-failed",
        lastError: "OpenCode did not discover Sora",
      })
    )
    await expect(
      workspace.getSessionMetadata([builderThreadId])
    ).resolves.toEqual([
      expect.objectContaining({
        threadId: builderThreadId,
        status: "failed",
      }),
    ])
    expect(lifecycle).toHaveBeenLastCalledWith({
      type: "draft-updated",
      draftAgentId,
      revision: 2,
    })

    await expect(workspace.deleteAgentDraft(draftAgentId)).rejects.toThrow(
      "can no longer be deleted"
    )

    await workspace.retryAgentDraft(draftAgentId)

    await expect(workspace.listAgents()).resolves.toContainEqual(
      expect.objectContaining({
        kind: "ready",
        id: "agent-sora",
        name: "Sora",
      })
    )
    expect(lifecycle).toHaveBeenLastCalledWith({
      type: "draft-promoted",
      draftAgentId,
      agentId: "agent-sora",
      threadId: "fixture-session-agent-sora-001",
      revision: 3,
    })
  })

  it("links actual Agent activation outcomes to their provider-owned target without private content", async () => {
    const workspace = createFixtureWorkspace({ clock: () => FIXTURE_NOW })
    const activity: WorkspaceActivityEvent[] = []
    workspace.subscribeActivity((event) => activity.push(event))

    const readyDraft = await workspace.openAgentBuilder()
    const promoted = workspace.promoteAgentDraft(readyDraft.draftAgentId, {
      kind: "ready",
      id: "agent-private-ready",
      name: "Private ready name",
      description: "Private ready description",
    })
    const failedDraft = await workspace.openAgentBuilder()
    workspace.failAgentDraftActivation(
      failedDraft.draftAgentId,
      "Private provider failure details",
      {
        kind: "ready",
        id: "agent-private-retry",
        name: "Private retry name",
        description: "Private retry description",
      }
    )

    expect(activity).toEqual([
      {
        id: "fixture:agent-ready:draft%3Afixture-agent-draft-001:3",
        agentId: "agent-private-ready",
        threadId: promoted.threadId,
        occurredAt: FIXTURE_NOW.toISOString(),
        type: "agent-ready",
      },
      {
        id: "fixture:agent-activation-failed:draft%3Afixture-agent-draft-002:2",
        agentId: failedDraft.draftAgentId,
        threadId: failedDraft.threadId,
        occurredAt: FIXTURE_NOW.toISOString(),
        type: "agent-activation-failed",
      },
    ])
    expect(JSON.stringify(activity)).not.toContain("Private")
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
    })
    workspace.subscribeActivity((event) =>
      store.ingest(event, {
        selection: null,
        pageVisible: false,
        pageFocused: false,
      })
    )

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
