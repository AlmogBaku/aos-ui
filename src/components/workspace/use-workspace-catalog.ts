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
  const reload = useRef(() => {})
  useEffect(() => {
    let active = true
    let generation = 0
    let refreshing = true
    let dirty = false
    const load = async (refresh: boolean) => {
      const requestGeneration = ++generation
      try {
        const { agents: next, avatarEditableIds: editable } = await readCatalog(
          workspace,
          refresh
        )
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
    reload.current = () => void refreshCatalog()
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
      reload.current = () => {}
      unsubscribe?.()
    }
  }, [refreshKey, workspace])
  /** Re-reads the catalog through the same guarded, coalesced refresh. */
  const reloadCatalog = useCallback(() => reload.current(), [])
  return {
    agents,
    setAgents,
    avatarEditableIds,
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
): Promise<{ agents: AgentSummary[]; avatarEditableIds: readonly string[] }> {
  if (!workspace.listAgentCatalog)
    return {
      agents: await (refresh
        ? workspace.refreshAgents()
        : workspace.listAgents()),
      avatarEditableIds: noIds,
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
  }
}

function toError(reason: unknown) {
  return reason instanceof Error ? reason : new Error(String(reason))
}
