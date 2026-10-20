import {
  SILENT_LOGGER,
  type AcpWorkspaceClient,
  type Logger,
} from "@harness-gw/sdk"

import { getAgentCreator } from "@/runtime-adapters/agent-identity"
import type {
  AgentCatalogEntry,
  AgentSummary,
  WorkspaceActivityEvent,
} from "@/runtime-adapters/contracts"

/** What the creation reports take over; every other member passes through. */
type CreationClient = Pick<
  AcpWorkspaceClient,
  | "listAgents"
  | "refreshAgents"
  | "listAgentCatalog"
  | "subscribeActivity"
  | "dispose"
>

type ClientAgentSummary = Awaited<
  ReturnType<AcpWorkspaceClient["listAgents"]>
>[number]

type ActivityListener = (event: WorkspaceActivityEvent) => void

/**
 * A harness marks the creator, and each Agent the creator made, in the Agent's
 * own metadata, which the gateway passes through unread as `_meta.aos`; the
 * workspace reads only `role` and `creatorSessionId`.
 */
function summaryOf({ _meta, ...summary }: ClientAgentSummary): AgentSummary {
  const aos = _meta?.aos
  if (typeof aos !== "object" || aos === null || Array.isArray(aos))
    return summary
  if (aos.role === "creator") return { ...summary, role: "creator" }
  const { creatorSessionId } = aos
  return typeof creatorSessionId === "string" && creatorSessionId !== ""
    ? { ...summary, creatorSessionId }
    : summary
}

/**
 * New Agent belongs to aos-ui alone. The creator makes Agents with its
 * harness's own means and stamps each with its own Session's id, so creation is
 * observable only in the catalog: when a creator turn ends, every listed Agent
 * stamped with that Session and not yet reported is reported once. A visible
 * one is ready; a hidden one still needs its operator. Disposing this disposes
 * the client it wraps.
 */
export function withAgentCreation<Client extends CreationClient>(
  client: Client,
  {
    now = () => Date.now(),
    logger = SILENT_LOGGER,
  }: { now?: () => number; logger?: Logger } = {}
) {
  let creatorId: string | undefined
  /** The created Agents this tab has reported, so each is reported once. */
  const reported = new Set<string>()
  const listeners = new Set<ActivityListener>()

  function remember(summaries: AgentSummary[]) {
    creatorId = getAgentCreator(summaries)?.id
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

  function emit(event: WorkspaceActivityEvent) {
    for (const listener of [...listeners])
      try {
        listener(event)
      } catch (err) {
        logger.warn({ err }, "agent.created_listener_failed")
      }
  }

  async function reportCreatedAgents(sessionId: string) {
    // A catalog that cannot be read reports nothing; the caller logs why.
    for (const { summary, visibility } of await listAgentCatalog()) {
      if (summary.creatorSessionId !== sessionId || reported.has(summary.id))
        continue
      reported.add(summary.id)
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

  // A turn end replayed on connect happened while this tab was away, and an
  // Agent made then is no news: the roster already shows it.
  const stopWatching = client.subscribeActivity((event) => {
    if (
      (event.type === "turn-finished" || event.type === "turn-failed") &&
      !event.replayed &&
      creatorId !== undefined &&
      event.agentId === creatorId
    )
      reportCreatedAgents(event.sessionId).catch((err: unknown) =>
        logger.warn({ err }, "agent.report_created_failed")
      )
  })

  const creation = {
    listAgents: () => readAgents(client.listAgents()),
    refreshAgents: () => readAgents(client.refreshAgents()),
    listAgentCatalog,
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
