import { useEffect, useState } from "react"
import { sameData } from "@/lib/utils"
import type {
  AgentSummary,
  WorkspaceAdapter,
} from "@/runtime-adapters/contracts"

const noIds: readonly string[] = []

/**
 * Catalog observation is independent of streaming message subscriptions. A
 * runtime that stores avatars also reports which Agents it can store them for,
 * since that decides how their icons resolve.
 */
export function useWorkspaceCatalog(
  workspace: WorkspaceAdapter,
  refreshKey: number
) {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [avatarEditableIds, setAvatarEditableIds] = useState(noIds)
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [agentError, setAgentError] = useState<Error | null>(null)
  useEffect(() => {
    let active = true
    let generation = 0
    let refreshing = true
    let dirty = false
    const load = async (refresh: boolean) => {
      const requestGeneration = ++generation
      try {
        const [next, entries] = await Promise.all([
          refresh ? workspace.refreshAgents() : workspace.listAgents(),
          workspace.updateAgent ? workspace.listAgentCatalog?.() : undefined,
        ])
        const editable =
          entries?.flatMap((entry) =>
            entry.avatarEditable ? [entry.summary.id] : []
          ) ?? noIds
        if (active && requestGeneration === generation) {
          // Every catalog invalidation re-reads the roster, and most leave it
          // as it was: keeping the value spares the workspace a re-render.
          setAgents((previous) => (sameData(previous, next) ? previous : next))
          setAvatarEditableIds((previous) =>
            sameData(previous, editable) ? previous : editable
          )
          setAgentError(null)
          setAgentsLoading(false)
        }
      } catch (reason) {
        if (active && requestGeneration === generation) {
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
    const refreshCatalog = async () => {
      if (!active) return
      if (refreshing) {
        dirty = true
        return
      }
      refreshing = true
      do {
        dirty = false
        await load(true)
      } while (active && dirty)
      refreshing = false
    }
    const handleError = (error: Error) => {
      if (active) {
        setAgentError(error)
        setAgentsLoading(false)
      }
    }
    void load(false).finally(() => {
      refreshing = false
      if (active && dirty) void refreshCatalog()
    })
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = workspace.subscribeAgentCatalog?.(() => {
        void refreshCatalog()
      }, handleError)
    } catch (reason) {
      queueMicrotask(() => handleError(toError(reason)))
    }
    return () => {
      active = false
      generation++
      unsubscribe?.()
    }
  }, [refreshKey, workspace])
  return {
    agents,
    setAgents,
    avatarEditableIds,
    agentsLoading,
    setAgentsLoading,
    agentError,
    setAgentError,
  }
}
function toError(reason: unknown) {
  return reason instanceof Error ? reason : new Error(String(reason))
}
