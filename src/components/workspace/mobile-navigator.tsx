"use client"

import type { ThreadListRuntime } from "@assistant-ui/react"
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  ArrowLeft,
  Bot,
  ChevronRight,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { WorkspaceAgent, WorkspaceSession } from "./workspace-shell"
import styles from "./mobile-navigator.module.css"
import {
  AgentSessionHistory,
  type AgentSessionHistoryCopy,
} from "./agent-session-history"
import { RowIndicators, UnreadDot } from "./status-dots"

export type MobileNavigatorState =
  | { view: "closed" }
  | { view: "agents" }
  | { view: "sessions"; agentId: string }

export type MobileNavigatorEvent =
  | { type: "OPEN"; selectedAgentId: string | null }
  | { type: "BROWSE_AGENT"; agentId: string }
  | { type: "BACK_TO_AGENTS" }
  | { type: "DISMISS" }
  | { type: "ENTER_DESKTOP" }
  | { type: "BROWSED_AGENT_UNAVAILABLE" }

export function mobileNavigatorReducer(
  state: MobileNavigatorState,
  event: MobileNavigatorEvent
): MobileNavigatorState {
  switch (event.type) {
    case "OPEN":
      return event.selectedAgentId
        ? { view: "sessions", agentId: event.selectedAgentId }
        : { view: "agents" }
    case "BROWSE_AGENT":
      return { view: "sessions", agentId: event.agentId }
    case "BACK_TO_AGENTS":
    case "BROWSED_AGENT_UNAVAILABLE":
      return { view: "agents" }
    case "DISMISS":
    case "ENTER_DESKTOP":
      return { view: "closed" }
    default:
      return state
  }
}

export type MobileAgentSessionCatalog = {
  agentId: string
  openSessions: readonly WorkspaceSession[]
  historySessions: readonly WorkspaceSession[]
  lastSelectedThreadId: string | null
}

export type MobileNavigatorCopy = AgentSessionHistoryCopy & {
  agents: string
  sessions: string
  backToAgents: string
  close: string
  searchAgents: string
  newAgent: string
  manageAgents: string
  preferences: string
  agentDetails: string
  noAgents: string
  status: {
    active: string
    idle: string
    running: string
    attention: string
    unknown: string
    waitingForInput: string
    failed: string
  }
}

export type MobileNavigatorProps = {
  state: MobileNavigatorState
  agents: readonly WorkspaceAgent[]
  selectedAgentId: string | null
  activeThreadId: string | null
  sessionsByAgentId: readonly MobileAgentSessionCatalog[]
  threadListRuntime?: ThreadListRuntime
  /** True while any other roster Agent holds an unread Session. */
  otherAgentsUnread?: boolean
  locale: "en" | "he"
  copy: MobileNavigatorCopy
  onStateChange: (event: MobileNavigatorEvent) => void
  onOpenSession: (agentId: string, threadId: string) => void
  onCreateSession: (agentId: string) => void
  onRemoveOpenSession?: (agentId: string, threadId: string) => void
  onNewAgent?: () => void
  onManageAgents?: () => void
  onPreferences?: () => void
  preferences?: ReactNode
  onAgentDetails?: (agentId: string) => void
  renderAgentIcon?: (agent: WorkspaceAgent) => ReactNode
  className?: string
  onActionError?: (error: unknown) => void
}

type SessionSnapshot = {
  agentId: string
  openIds: string[]
  historyIds: string[]
}

function reconcileIds(
  previous: readonly string[],
  current: readonly WorkspaceSession[]
) {
  const currentIds = new Set(current.map(({ threadId }) => threadId))
  const stable = previous.filter((id) => currentIds.has(id))
  const known = new Set(stable)
  for (const { threadId } of current) {
    if (!known.has(threadId)) {
      stable.push(threadId)
      known.add(threadId)
    }
  }
  return stable
}

function orderSessions(
  ids: readonly string[],
  sessions: readonly WorkspaceSession[]
) {
  const byId = new Map(sessions.map((item) => [item.threadId, item]))
  return ids.flatMap((id) => {
    const item = byId.get(id)
    return item ? [item] : []
  })
}

function useStableSessionSections(
  state: MobileNavigatorState,
  catalog: MobileAgentSessionCatalog | undefined
) {
  const [snapshot, updateSnapshot] = useReducer(
    (
      previous: SessionSnapshot | null,
      next: {
        state: MobileNavigatorState
        catalog: MobileAgentSessionCatalog | undefined
      }
    ): SessionSnapshot | null => {
      if (next.state.view !== "sessions" || !next.catalog) return null
      const enteringAgent = !previous || previous.agentId !== next.state.agentId
      return {
        agentId: next.state.agentId,
        openIds: enteringAgent
          ? next.catalog.openSessions.map(({ threadId }) => threadId)
          : reconcileIds(previous.openIds, next.catalog.openSessions),
        historyIds: enteringAgent
          ? next.catalog.historySessions.map(({ threadId }) => threadId)
          : reconcileIds(previous.historyIds, next.catalog.historySessions),
      }
    },
    { state, catalog },
    ({ state: initialState, catalog: initialCatalog }) =>
      initialState.view === "sessions" && initialCatalog
        ? {
            agentId: initialState.agentId,
            openIds: initialCatalog.openSessions.map(
              ({ threadId }) => threadId
            ),
            historyIds: initialCatalog.historySessions.map(
              ({ threadId }) => threadId
            ),
          }
        : null
  )

  useEffect(() => {
    updateSnapshot({ state, catalog })
  }, [catalog, state])

  if (state.view !== "sessions" || !catalog) {
    return { openSessions: [], historySessions: [] }
  }

  const effectiveSnapshot =
    snapshot?.agentId === state.agentId
      ? snapshot
      : {
          agentId: state.agentId,
          openIds: catalog.openSessions.map(({ threadId }) => threadId),
          historyIds: catalog.historySessions.map(({ threadId }) => threadId),
        }

  return {
    openSessions: orderSessions(
      effectiveSnapshot.openIds,
      catalog.openSessions
    ),
    historySessions: orderSessions(
      effectiveSnapshot.historyIds,
      catalog.historySessions
    ),
  }
}

function normalizeSearch(value: string, locale: "en" | "he") {
  return value.trim().toLocaleLowerCase(locale)
}

function statusLabel(
  status: WorkspaceAgent["status"] | WorkspaceSession["status"],
  copy: MobileNavigatorCopy
) {
  if (status === "active") return copy.status.active
  if (status === "waiting-for-input") return copy.status.waitingForInput
  if (status === "failed") return copy.status.failed
  if (status === "running") return copy.status.running
  if (status === "attention") return copy.status.attention
  if (status === "unknown") return copy.status.unknown
  return copy.status.idle
}

export function MobileNavigator({
  state,
  agents,
  selectedAgentId,
  activeThreadId,
  sessionsByAgentId,
  threadListRuntime,
  otherAgentsUnread = false,
  locale,
  copy,
  onStateChange,
  onOpenSession,
  onCreateSession,
  onRemoveOpenSession,
  onNewAgent,
  onManageAgents,
  onPreferences,
  preferences,
  onAgentDetails,
  renderAgentIcon,
  className,
  onActionError,
}: MobileNavigatorProps) {
  const navigatorRef = useRef<HTMLDivElement>(null)
  const [agentQuery, setAgentQuery] = useState("")
  const [sessionQueries, setSessionQueries] = useState<Record<string, string>>(
    {}
  )

  const catalog =
    state.view === "sessions"
      ? sessionsByAgentId.find(({ agentId }) => agentId === state.agentId)
      : undefined
  const browsedAgent =
    state.view === "sessions"
      ? agents.find(({ id }) => id === state.agentId)
      : undefined
  const stableSections = useStableSessionSections(state, catalog)
  const browsedAgentUnavailable =
    state.view === "sessions" && (!browsedAgent || !catalog)

  useEffect(() => {
    if (browsedAgentUnavailable) {
      onStateChange({ type: "BROWSED_AGENT_UNAVAILABLE" })
    }
  }, [browsedAgentUnavailable, onStateChange])

  useLayoutEffect(() => {
    if (state.view === "closed") return
    navigatorRef.current
      ?.querySelector<HTMLElement>("[data-mobile-navigator-heading]")
      ?.focus()
  }, [state])

  const normalizedAgentQuery = normalizeSearch(agentQuery, locale)
  const visibleAgents = useMemo(
    () =>
      agents.filter((agent) => {
        if (!normalizedAgentQuery) return true
        return normalizeSearch(
          `${agent.name} ${agent.description ?? ""}`,
          locale
        ).includes(normalizedAgentQuery)
      }),
    [agents, locale, normalizedAgentQuery]
  )

  if (state.view === "closed") return null

  if (browsedAgentUnavailable) return null

  const direction = locale === "he" ? "rtl" : "ltr"

  return (
    <div
      ref={navigatorRef}
      className={cn(styles.navigator, className)}
      dir={direction}
      data-mobile-navigator
    >
      {state.view === "agents" ? (
        <>
          <header className={styles.header}>
            <h2 tabIndex={-1} data-mobile-navigator-heading>
              {copy.agents}
            </h2>
            <Button
              variant="ghost"
              className={styles.iconButton}
              type="button"
              aria-label={copy.close}
              onClick={() => onStateChange({ type: "DISMISS" })}
            >
              <X />
            </Button>
          </header>
          <label className={styles.searchField}>
            <Search aria-hidden="true" />
            <span className={styles.srOnly}>{copy.searchAgents}</span>
            <input
              type="search"
              aria-label={copy.searchAgents}
              placeholder={copy.searchAgents}
              value={agentQuery}
              onChange={(event) => setAgentQuery(event.currentTarget.value)}
            />
          </label>
          <nav className={styles.list} aria-label={copy.agents}>
            {visibleAgents.length ? (
              visibleAgents.map((agent) => {
                const label = [
                  agent.name,
                  agent.status && agent.status !== "idle"
                    ? statusLabel(agent.status, copy)
                    : null,
                  agent.id === selectedAgentId ? copy.selected : null,
                  agent.unread ? copy.unread : null,
                ]
                  .filter(Boolean)
                  .join(", ")
                return (
                  <button
                    key={agent.id}
                    type="button"
                    className={styles.navigationRow}
                    aria-label={label}
                    aria-current={
                      agent.id === selectedAgentId ? "true" : undefined
                    }
                    onClick={() =>
                      onStateChange({
                        type: "BROWSE_AGENT",
                        agentId: agent.id,
                      })
                    }
                  >
                    <span className={styles.agentIcon}>
                      {renderAgentIcon?.(agent) ?? <Bot aria-hidden="true" />}
                    </span>
                    <span className={styles.rowText}>
                      <bdi className={styles.rowTitle}>{agent.name}</bdi>
                      {agent.description ? (
                        <bdi className={styles.rowDescription}>
                          {agent.description}
                        </bdi>
                      ) : null}
                    </span>
                    <RowIndicators
                      status={agent.status}
                      statusLabel={statusLabel(agent.status, copy)}
                      unread={agent.unread}
                      unreadLabel={copy.unread}
                    />
                    <ChevronRight
                      className={styles.chevron}
                      aria-hidden="true"
                    />
                  </button>
                )
              })
            ) : (
              <p className={styles.empty}>{copy.noAgents}</p>
            )}
          </nav>
          <footer className={styles.footer}>
            {onNewAgent ? (
              <Button variant="ghost" onClick={onNewAgent}>
                <Plus data-icon="inline-start" />
                {copy.newAgent}
              </Button>
            ) : null}
            {onManageAgents ? (
              <Button variant="ghost" onClick={onManageAgents}>
                <Settings2 data-icon="inline-start" />
                {copy.manageAgents}
              </Button>
            ) : null}
            {onPreferences ? (
              <Button variant="ghost" onClick={onPreferences}>
                <SlidersHorizontal data-icon="inline-start" />
                {copy.preferences}
              </Button>
            ) : null}
            {preferences}
          </footer>
        </>
      ) : (
        <SessionsView
          agent={browsedAgent!}
          threadListRuntime={threadListRuntime}
          activeThreadId={activeThreadId}
          lastSelectedThreadId={catalog!.lastSelectedThreadId}
          openSessions={stableSections.openSessions}
          historySessions={stableSections.historySessions}
          otherAgentsUnread={otherAgentsUnread}
          query={sessionQueries[state.agentId] ?? ""}
          locale={locale}
          copy={copy}
          renderAgentIcon={renderAgentIcon}
          onQueryChange={(query) =>
            setSessionQueries((current) => ({
              ...current,
              [state.agentId]: query,
            }))
          }
          onBack={() => onStateChange({ type: "BACK_TO_AGENTS" })}
          onDismiss={() => onStateChange({ type: "DISMISS" })}
          onOpenSession={(threadId) => {
            onStateChange({ type: "DISMISS" })
            if (threadId !== activeThreadId) {
              onOpenSession(state.agentId, threadId)
            }
          }}
          onCreateSession={() => {
            onStateChange({ type: "DISMISS" })
            onCreateSession(state.agentId)
          }}
          onRemoveOpenSession={
            onRemoveOpenSession
              ? (threadId) => {
                  onStateChange({ type: "DISMISS" })
                  onRemoveOpenSession(state.agentId, threadId)
                }
              : undefined
          }
          onAgentDetails={
            onAgentDetails ? () => onAgentDetails(state.agentId) : undefined
          }
          onActionError={onActionError}
        />
      )}
    </div>
  )
}

type SessionsViewProps = {
  agent: WorkspaceAgent
  threadListRuntime?: ThreadListRuntime
  activeThreadId: string | null
  lastSelectedThreadId: string | null
  openSessions: readonly WorkspaceSession[]
  historySessions: readonly WorkspaceSession[]
  otherAgentsUnread: boolean
  query: string
  locale: "en" | "he"
  copy: MobileNavigatorCopy
  renderAgentIcon?: (agent: WorkspaceAgent) => ReactNode
  onQueryChange: (query: string) => void
  onBack: () => void
  onDismiss: () => void
  onOpenSession: (threadId: string) => void
  onCreateSession: () => void
  onRemoveOpenSession?: (threadId: string) => void
  onAgentDetails?: () => void
  onActionError?: (error: unknown) => void
}

function SessionsView({
  agent,
  threadListRuntime,
  activeThreadId,
  lastSelectedThreadId,
  openSessions,
  historySessions,
  otherAgentsUnread,
  query,
  locale,
  copy,
  renderAgentIcon,
  onQueryChange,
  onBack,
  onDismiss,
  onOpenSession,
  onCreateSession,
  onRemoveOpenSession,
  onAgentDetails,
  onActionError,
}: SessionsViewProps) {
  return (
    <>
      <header className={styles.header}>
        <Button
          variant="ghost"
          className={styles.backButton}
          type="button"
          aria-label={[
            copy.backToAgents,
            otherAgentsUnread ? copy.unread : null,
          ]
            .filter(Boolean)
            .join(", ")}
          onClick={onBack}
        >
          <ArrowLeft aria-hidden="true" />
          {otherAgentsUnread ? <UnreadDot label={copy.unread} /> : null}
          <span>{copy.agents}</span>
        </Button>
        <Button
          variant="ghost"
          className={styles.iconButton}
          type="button"
          aria-label={copy.close}
          onClick={onDismiss}
        >
          <X />
        </Button>
      </header>

      <div className={styles.agentIdentity}>
        <span className={styles.agentIcon}>
          {renderAgentIcon?.(agent) ?? <Bot aria-hidden="true" />}
        </span>
        <span className={styles.rowText}>
          <h2 tabIndex={-1} data-mobile-navigator-heading>
            <bdi>{agent.name}</bdi>
          </h2>
          {agent.description ? <bdi>{agent.description}</bdi> : null}
        </span>
        {onAgentDetails ? (
          <Button
            variant="ghost"
            className={styles.iconButton}
            aria-label={copy.agentDetails}
            onClick={onAgentDetails}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      <Button className={styles.createButton} onClick={onCreateSession}>
        <Plus data-icon="inline-start" />
        {copy.newSession}
      </Button>

      <AgentSessionHistory
        navigation={{
          agentId: agent.id,
          openSessions,
          historySessions,
          archivedSessions: [],
          lastSelectedThreadId,
        }}
        activeThreadId={activeThreadId}
        locale={locale}
        copy={copy}
        query={query}
        onQueryChange={onQueryChange}
        onOpenSession={(_agentId, threadId) => onOpenSession(threadId)}
        onRemoveOpenSession={
          onRemoveOpenSession
            ? (_agentId, threadId) => onRemoveOpenSession(threadId)
            : undefined
        }
        threadListRuntime={threadListRuntime}
        onActionError={onActionError}
      />
    </>
  )
}
