import type {
  AcpWorkspaceClient,
  WorkspaceActivityEvent as ClientActivityEvent,
} from "@harness-gw/sdk"
import { describe, expect, it } from "vitest"

import type { WorkspaceActivityEvent } from "@/runtime-adapters/contracts"

import { useFakeClock } from "../../../test/support/fake-clock"
import { withAgentCreation } from "./aos-agent-creation"

type CatalogEntry = Awaited<
  ReturnType<AcpWorkspaceClient["listAgentCatalog"]>
>[number]

const NOW = Date.parse("2026-10-17T09:00:00.000Z")
const CREATOR_ID = "agent-creator"
const RESEARCH_ID = "agent-research"
const INTERVIEW = "session-interview"

function entry(
  id: string,
  name: string,
  {
    visibility = "visible",
    meta,
  }: {
    visibility?: CatalogEntry["visibility"]
    meta?: CatalogEntry["summary"]["_meta"]
  } = {}
): CatalogEntry {
  return {
    summary: { kind: "ready", id, name, ...(meta ? { _meta: meta } : {}) },
    visibility,
    selectable: true,
    editable: true,
    avatarEditable: true,
    muteEditable: true,
  }
}

const creator = entry(CREATOR_ID, "Agent Creator", {
  visibility: "hidden",
  meta: { aos: { role: "creator" } },
})
const research = entry(RESEARCH_ID, "Research", {
  meta: { aos: { avatar: "ring/blue" } },
})
const sora = entry("agent-sora", "Sora")

/** The SDK client's catalog, Session owners, and activity feed, as plain values. */
function fakeClient(agents: CatalogEntry[]) {
  const catalog = [...agents]
  const owners = new Map<string, string>()
  const activity = new Set<(event: ClientActivityEvent) => void>()
  const state = { disposed: false }
  const summaries = async () => catalog.map(({ summary }) => summary)
  const client = {
    listAgents: summaries,
    refreshAgents: summaries,
    listAgentCatalog: async () => [...catalog],
    async createSession(agentId: string) {
      owners.set(INTERVIEW, agentId)
      return { sessionId: INTERVIEW }
    },
    subscribeSession: () => () => undefined,
    knownAgentIdOf: (sessionId: string) => owners.get(sessionId),
    subscribeActivity(listener: (event: ClientActivityEvent) => void) {
      activity.add(listener)
      return () => activity.delete(listener)
    },
    dispose() {
      state.disposed = true
    },
  }
  return { client, catalog, owners, activity, state }
}

describe("withAgentCreation", () => {
  it("marks the Agent whose harness metadata names the creator, and hands on no metadata", async () => {
    const workspace = withAgentCreation(fakeClient([creator, research]).client)
    const summaries = [
      { kind: "ready", id: CREATOR_ID, name: "Agent Creator", role: "creator" },
      { kind: "ready", id: RESEARCH_ID, name: "Research" },
    ]

    await expect(workspace.listAgents()).resolves.toStrictEqual(summaries)
    await expect(workspace.refreshAgents()).resolves.toStrictEqual(summaries)
    expect(
      (await workspace.listAgentCatalog()).map(({ summary }) => summary)
    ).toStrictEqual(summaries)
  })

  it.each([
    {
      case: "a new visible Agent as ready",
      owner: CREATOR_ID,
      opens: "create",
      ends: "turn-finished",
      created: sora,
      reported: "agent-ready",
    },
    {
      case: "a new hidden Agent as needing its operator",
      owner: CREATOR_ID,
      opens: "create",
      ends: "turn-finished",
      created: { ...sora, visibility: "hidden" },
      reported: "agent-activation-failed",
    },
    {
      case: "an Agent a failed turn still wrote",
      owner: CREATOR_ID,
      opens: "create",
      ends: "turn-failed",
      created: sora,
      reported: "agent-ready",
    },
    {
      case: "an Agent from a creator Session it reopens",
      owner: CREATOR_ID,
      opens: "subscribe",
      ends: "turn-finished",
      created: sora,
      reported: "agent-ready",
    },
    {
      case: "nothing when no Agent is new",
      owner: CREATOR_ID,
      opens: "create",
      ends: "turn-finished",
      created: undefined,
      reported: undefined,
    },
    {
      case: "nothing for a Session the creator does not own",
      owner: RESEARCH_ID,
      opens: "create",
      ends: "turn-finished",
      created: sora,
      reported: undefined,
    },
  ] as const)(
    "reports $case, once",
    async ({ owner, opens, ends, created, reported }) => {
      const clock = useFakeClock()
      const fake = fakeClient([creator, research])
      const workspace = withAgentCreation(fake.client, { now: () => NOW })
      const events: WorkspaceActivityEvent[] = []
      workspace.subscribeActivity((event) => events.push(event))
      await workspace.listAgents()
      if (opens === "create") await workspace.createSession(owner)
      else {
        fake.owners.set(INTERVIEW, owner)
        workspace.subscribeSession(INTERVIEW)
      }
      const turnEnd: ClientActivityEvent = {
        id: `${INTERVIEW}:turn-1:${ends}`,
        type: ends,
        turnId: "turn-1",
        agentId: owner,
        sessionId: INTERVIEW,
        occurredAt: new Date(NOW).toISOString(),
      }
      const endTurn = async () => {
        for (const listener of fake.activity) listener(turnEnd)
        await clock.advance(0)
      }

      if (created) fake.catalog.push(created)
      await endTurn()
      await endTurn()

      expect(events).toEqual([
        turnEnd,
        ...(reported
          ? [
              {
                id: `${INTERVIEW}:agent-sora`,
                type: reported,
                agentId: "agent-sora",
                sessionId: INTERVIEW,
                occurredAt: new Date(NOW).toISOString(),
              },
            ]
          : []),
        turnEnd,
      ])
    }
  )

  it("releases its activity subscription and the client when disposed", () => {
    const fake = fakeClient([creator])
    const workspace = withAgentCreation(fake.client)
    expect(fake.activity.size).toBe(1)

    workspace.dispose()

    expect(fake.activity.size).toBe(0)
    expect(fake.state.disposed).toBe(true)
  })
})
