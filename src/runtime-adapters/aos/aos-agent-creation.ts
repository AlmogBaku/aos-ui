import {
  SILENT_LOGGER,
  type AcpWorkspaceClient,
  type Logger,
} from "@harness-gw/sdk"

import { getAgentCreator } from "@/runtime-adapters/agent-identity"
import type {
  AgentCatalogEntry,
  AgentSummary,
  SessionCreationOptions,
  WorkspaceActivityEvent,
} from "@/runtime-adapters/contracts"

/** What the creation reports take over; every other member passes through. */
type CreationClient = Pick<
  AcpWorkspaceClient,
  | "listAgents"
  | "refreshAgents"
  | "listAgentCatalog"
  | "createSession"
  | "subscribeSession"
  | "subscribeActivity"
  | "knownAgentIdOf"
  | "dispose"
>

type ClientAgentSummary = Awaited<
  ReturnType<AcpWorkspaceClient["listAgents"]>
>[number]

type ActivityListener = (event: WorkspaceActivityEvent) => void

/**
 * Hermes marks the creator in its profile's `ui_meta.aos`, which the gateway
 * passes through unread as `_meta.aos`; the workspace reads only `role`.
 */
function summaryOf({ _meta, ...summary }: ClientAgentSummary): AgentSummary {
  const aos = _meta?.aos
  const creator =
    typeof aos === "object" &&
    aos !== null &&
    !Array.isArray(aos) &&
    aos.role === "creator"
  return creator ? { ...summary, role: "creator" } : summary
}

/**
 * New Agent belongs to aos-ui alone. The creator makes Agents with its
 * harness's own means, so creation is observable only in the catalog: an Agent
 * that was not listed when the creator Session opened, and is listed once one
 * of its turns ends. A visible one is ready; a hidden one still needs its
 * operator. Disposing this disposes the client it wraps.
 */
export function withAgentCreation<Client extends CreationClient>(
  client: Client,
  {
    now = () => Date.now(),
    logger = SILENT_LOGGER,
  }: { now?: () => number; logger?: Logger } = {}
) {
  let creatorId: string | undefined
  let listedAgentIds: ReadonlySet<string> = new Set()
  /** The Agent ids each creator Session's catalog held when it opened. */
  const baselines = new Map<string, Set<string>>()
  const listeners = new Set<ActivityListener>()

  function remember(summaries: AgentSummary[]) {
    creatorId = getAgentCreator(summaries)?.id
    listedAgentIds = new Set(summaries.map(({ id }) => id))
    return summaries
  }

  const readAgents = async (read: Promise<ClientAgentSummary[]>) =>
    remember((await read).map(summaryOf))

  async function listAgentCatalog(): Promise<AgentCatalogEntry[]> {
    const entries = (await client.listAgentCatalog()).map((entry) => ({
      ...entry,
      summary: summaryOf(entry.summary),
    }))
    remember(entries.map(({ summary }) => summary))
    return entries
  }

  function watchCreator(sessionId: string, agentId: string | undefined) {
    if (
      agentId !== undefined &&
      agentId === creatorId &&
      !baselines.has(sessionId)
    )
      baselines.set(sessionId, new Set(listedAgentIds))
  }

  function emit(event: WorkspaceActivityEvent) {
    for (const listener of [...listeners])
      try {
        listener(event)
      } catch (err) {
        logger.warn({ err }, "agent.created_listener_failed")
      }
  }

  async function reportCreatedAgents(sessionId: string) {
    const baseline = baselines.get(sessionId)
    if (!baseline) return
    // A catalog that cannot be read reports nothing; the caller logs why.
    for (const { summary, visibility } of await listAgentCatalog()) {
      if (baseline.has(summary.id)) continue
      baseline.add(summary.id)
      emit({
        id: `${sessionId}:${summary.id}`,
        type:
          visibility === "hidden" ? "agent-activation-failed" : "agent-ready",
        agentId: summary.id,
        sessionId,
        occurredAt: new Date(now()).toISOString(),
      })
    }
  }

  const stopWatching = client.subscribeActivity((event) => {
    if (event.type === "turn-finished" || event.type === "turn-failed")
      reportCreatedAgents(event.sessionId).catch((err: unknown) =>
        logger.warn({ err }, "agent.report_created_failed")
      )
  })

  const creation = {
    listAgents: () => readAgents(client.listAgents()),
    refreshAgents: () => readAgents(client.refreshAgents()),
    listAgentCatalog,
    async createSession(agentId: string, options?: SessionCreationOptions) {
      const created = await client.createSession(agentId, options)
      watchCreator(created.sessionId, agentId)
      return created
    },
    subscribeSession(sessionId: string) {
      const release = client.subscribeSession(sessionId)
      watchCreator(sessionId, client.knownAgentIdOf(sessionId))
      return release
    },
    /** The client's own activity, and the Agents its creator Sessions made. */
    subscribeActivity(listener: ActivityListener) {
      const leave = client.subscribeActivity(listener)
      listeners.add(listener)
      return () => {
        leave()
        listeners.delete(listener)
      }
    },
    dispose() {
      stopWatching()
      listeners.clear()
      client.dispose()
    },
  }
  const workspace: Omit<Client, keyof typeof creation> & typeof creation = {
    ...client,
    ...creation,
  }
  return workspace
}
