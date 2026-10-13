import { useCallback, useEffect, useRef, useState } from "react"
import { sameData } from "@/lib/utils"
import type {
  AgentSummary,
  WorkspaceAdapter,
} from "@/runtime-adapters/contracts"

const noIds: readonly string[] = []

/**
 * Catalog observation is independent of streaming message subscriptions. A
 * runtime that stores avatars also reports which Agents it can store them for,
 * since that decides how their icons resolve, and likewise for mutes.
 */
export function useWorkspaceCatalog(
  workspace: WorkspaceAdapter,
  refreshKey: number
) {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [avatarEditableIds, setAvatarEditableIds] = useState(noIds)
  const [muteEditableIds, setMuteEditableIds] = useState(noIds)
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [agentError, setAgentError] = useState<Error | null>(null)
  const reload = useRef<() => Promise<readonly AgentSummary[] | undefined>>(
    async () => undefined
  )
  useEffect(() => {
    let active = true
    let generation = 0
    let dirty = false
    /** The loads under way: one, then one more for any refresh it missed. */
    let running: Promise<void> | undefined
    /** The roster the newest load read, or undefined once one failed. */
    let read: readonly AgentSummary[] | undefined
    const load = async (refresh: boolean) => {
      generation += 1
      const requestGeneration = generation
      // Outside `try`: React Compiler cannot compile a logical expression there.
      const isLatest = () => active && requestGeneration === generation
      try {
        const catalog = await readCatalog(workspace, refresh)
        const { agents: next, avatarEditableIds: editable } = catalog
        if (isLatest()) {
          read = next
          // Every catalog invalidation re-reads the roster, and most leave it
          // as it was: keeping the value spares the workspace a re-render.
          setAgents((previous) => (sameData(previous, next) ? previous : next))
          setAvatarEditableIds((previous) =>
            sameData(previous, editable) ? previous : editable
          )
          setMuteEditableIds((previous) =>
            sameData(previous, catalog.muteEditableIds)
              ? previous
              : catalog.muteEditableIds
          )
          setAgentError(null)
          setAgentsLoading(false)
        }
      } catch (reason) {
        if (isLatest()) {
          read = undefined
          setAgentError(toError(reason))
          setAgents((previous) =>
            previous.map((agent) =>
              agent.activity === undefined
                ? agent
                : { ...agent, activity: "unknown" }
            )
          )
          setAgentsLoading(false)
        }
      }
    }
    const loads = async (first: boolean) => {
      let refresh = first
      do {
        dirty = false
        await load(refresh)
        refresh = true
      } while (active && dirty)
      running = undefined
    }
    /** Settles once a load that began after the call has read the catalog. */
    const refreshCatalog = () => {
      if (!active) return Promise.resolve()
      if (running) {
        dirty = true
        return running
      }
      running = loads(true)
      return running
    }
    reload.current = async () => {
      await refreshCatalog()
      return read
    }
    const handleError = (error: Error) => {
      if (active) {
        setAgentError(error)
        setAgentsLoading(false)
      }
    }
    running = loads(false)
    // Outside `try`: React Compiler cannot compile optional chaining there.
    const subscribe = () =>
      workspace.subscribeAgentCatalog?.(() => {
        void refreshCatalog()
      }, handleError)
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = subscribe()
    } catch (reason) {
      // Bound outside the closure: React Compiler cannot capture a catch
      // parameter yet.
      const error = toError(reason)
      queueMicrotask(() => handleError(error))
    }
    return () => {
      active = false
      generation += 1
      reload.current = async () => undefined
      unsubscribe?.()
    }
  }, [refreshKey, workspace])
  /**
   * Re-reads the catalog through the same guarded, coalesced refresh, and
   * resolves with the roster it read, or undefined when that read failed: the
   * failure is the catalog's own error.
   */
  const reloadCatalog = useCallback(() => reload.current(), [])
  return {
    agents,
    setAgents,
    avatarEditableIds,
    muteEditableIds,
    reloadCatalog,
    agentsLoading,
    setAgentsLoading,
    agentError,
    setAgentError,
  }
}
/**
 * One read per load. A runtime with a management catalog answers both the
 * roster and which avatars it stores from that one read; any other runtime
 * lists its roster alone.
 */
async function readCatalog(
  workspace: WorkspaceAdapter,
  refresh: boolean
): Promise<{
  agents: AgentSummary[]
  avatarEditableIds: readonly string[]
  muteEditableIds: readonly string[]
}> {
  if (!workspace.listAgentCatalog)
    return {
      agents: await (refresh
        ? workspace.refreshAgents()
        : workspace.listAgents()),
      avatarEditableIds: noIds,
      muteEditableIds: noIds,
    }
  const entries = await workspace.listAgentCatalog()
  return {
    agents: entries.map(({ summary, visibility }) => ({
      ...summary,
      visibility,
    })),
    avatarEditableIds: entries.flatMap(({ summary, avatarEditable }) =>
      avatarEditable ? [summary.id] : []
    ),
    muteEditableIds: entries.flatMap(({ summary, muteEditable }) =>
      muteEditable ? [summary.id] : []
    ),
  }
}

function toError(reason: unknown) {
  return reason instanceof Error ? reason : new Error(String(reason))
}
