import type { SessionMetadata } from "@/runtime-adapters/contracts"
import { buildAgentSessionView } from "@/lib/workspace-view-model"
import type { WorkspaceSession } from "./workspace-shell"

export type AgentSessionNavigation = {
  agentId: string
  openSessions: readonly WorkspaceSession[]
  historySessions: readonly WorkspaceSession[]
  lastSelectedThreadId: string | null
}

export function buildWorkspaceNavigationCatalog({
  agentIds,
  sessions,
  manuallyOpened,
  dismissedTabs,
  lastSelected,
  titles,
  now,
  untitledLabel,
  visibleThreadId,
}: {
  agentIds: readonly string[]
  sessions: readonly SessionMetadata[]
  manuallyOpened: Readonly<Record<string, readonly string[]>>
  dismissedTabs: Readonly<Record<string, readonly string[]>>
  lastSelected: ReadonlyMap<string, string | null>
  titles: ReadonlyMap<string, string>
  now: Date
  untitledLabel: string
  visibleThreadId: string | null
}) {
  return new Map<string, AgentSessionNavigation>(
    agentIds.map((agentId) => {
      const dismissed = new Set(dismissedTabs[agentId] ?? [])
      const manual = new Set(manuallyOpened[agentId] ?? [])
      if (visibleThreadId) {
        const visible = sessions.find(
          (session) =>
            session.threadId === visibleThreadId && session.agentId === agentId
        )
        if (visible) {
          manual.add(visibleThreadId)
          dismissed.delete(visibleThreadId)
        }
      }
      const view = buildAgentSessionView({
        agentId,
        sessions,
        manuallyOpenedThreadIds: manual,
        titles,
        now,
        untitledLabel,
      })
      const openSessions = view.openSessions
        .filter((session) => !dismissed.has(session.threadId))
        .map((session) => ({ ...session, canClose: true }))
      const openIds = new Set(openSessions.map((session) => session.threadId))
      return [
        agentId,
        {
          agentId,
          openSessions,
          historySessions: view.allSessions.filter(
            (session) => !openIds.has(session.threadId)
          ),
          lastSelectedThreadId: lastSelected.get(agentId) ?? null,
        },
      ]
    })
  )
}
