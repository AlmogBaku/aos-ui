import { useEffect, useEffectEvent, useRef } from "react"

import {
  planAvatarSaves,
  type AgentAvatarInput,
} from "@/components/agent-icons/allocation"
import {
  AgentUpdateError,
  type WorkspaceAdapter,
} from "@/runtime-adapters/contracts"

type AllocationPass = {
  attempted: Set<string>
  running: boolean
  stopped: boolean
}

/**
 * Saves the icon each visible Agent already shows, so every browser draws the
 * same one. Saves run one at a time in resolution order, and each Agent is
 * tried at most once while this workspace is loaded: a failed save keeps the
 * computed icon on screen and raises nothing. A conflict re-reads the catalog
 * and ends the pass; an unsupported runtime ends every pass.
 */
export function useAvatarAllocation({
  workspace,
  agents,
  ready,
  onConflict,
}: {
  workspace: Pick<WorkspaceAdapter, "updateAgent">
  /** The visible roster, exactly as its icons are resolved. */
  agents: readonly AgentAvatarInput[]
  /** False while the catalog is loading or errored. */
  ready: boolean
  onConflict: () => void
}) {
  const pass = useRef<AllocationPass | null>(null)
  const latest = useRef<readonly AgentAvatarInput[] | null>(null)

  useEffect(() => {
    const current = {
      attempted: new Set<string>(),
      running: false,
      stopped: false,
    }
    pass.current = current
    return () => {
      current.stopped = true
    }
  }, [workspace])

  const run = useEffectEvent(async () => {
    const current = pass.current
    const update = workspace.updateAgent
    if (!current || !update || current.running || current.stopped) return
    current.running = true
    try {
      // Each step plans from the newest catalog, so saves that land while the
      // pass runs are already counted.
      while (!current.stopped && latest.current) {
        const [next] = planAvatarSaves(latest.current, current.attempted)
        if (!next) return
        current.attempted.add(next.agentId)
        try {
          await update(next.agentId, { avatar: next.avatar })
        } catch (reason) {
          if (!(reason instanceof AgentUpdateError)) continue
          if (reason.code === "unsupported") current.stopped = true
          else onConflict()
          return
        }
      }
    } finally {
      current.running = false
    }
  })

  useEffect(() => {
    latest.current = ready ? agents : null
    if (ready) void run()
  }, [agents, ready])
}
