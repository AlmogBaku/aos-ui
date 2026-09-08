"use client"

import {
  ThreadListPrimitive,
  type ThreadListRuntime,
} from "@assistant-ui/react"
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
  Ellipsis,
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
  SessionThreadListItem,
  SessionThreadListTitle,
  SessionThreadListTrigger,
} from "./session-thread-list-item"

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

export type MobileNavigationActivity = {
  unreadCount: number
  needsAttention: boolean
}

export type MobileAgentSessionCatalog = {
  agentId: string
  openSessions: readonly WorkspaceSession[]
  historySessions: readonly WorkspaceSession[]
  lastSelectedThreadId: string | null
}

export type MobileNavigatorCopy = {
  agents: string
  sessions: string
  backToAgents: string
  close: string
  searchAgents: string
  searchSessions: string
  openSessions: string
  history: string
  newAgent: string
  newSession: string
  manageAgents: string
  preferences: string
  agentDetails: string
  clearSearch: string
  noAgents: string
  noSessions: string
  noSearchResults: string
  openSession: string
  sessionActions: string
  removeOpenSession: string
  selected: string
  lastSelected: string
  status: {
    active: string
    idle: string
    running: string
    attention: string
    unknown: string
    waitingForInput: string
    failed: string
  }
  unread: (count: number) => string
  needsAttention: string
}

export type MobileNavigatorProps = {
  state: MobileNavigatorState
  agents: readonly WorkspaceAgent[]
  selectedAgentId: string | null
  activeThreadId: string | null
  sessionsByAgentId: readonly MobileAgentSessionCatalog[]
  threadListRuntime?: ThreadListRuntime
  agentActivity?: Readonly<Record<string, MobileNavigationActivity | undefined>>
  otherAgentsActivity?: MobileNavigationActivity
  sessionActivity?: Readonly<
    Record<string, MobileNavigationActivity | undefined>
  >
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

function ActivityMarker({
  activity,
  copy,
}: {
  activity: MobileNavigationActivity | undefined
  copy: MobileNavigatorCopy
}) {
  if (!activity || (!activity.unreadCount && !activity.needsAttention)) {
    return null
  }

  return (
    <span className={styles.activity} aria-hidden="true">
      {activity.needsAttention ? (
        <span className={styles.attentionDot} title={copy.needsAttention} />
      ) : null}
      {activity.unreadCount > 0 ? (
        <span className={styles.unreadCount}>{activity.unreadCount}</span>
      ) : null}
    </span>
  )
}

function activityLabel(
  activity: MobileNavigationActivity | undefined,
  copy: MobileNavigatorCopy
) {
  if (!activity) return []
  return [
    activity.unreadCount > 0 ? copy.unread(activity.unreadCount) : null,
    activity.needsAttention ? copy.needsAttention : null,
  ].filter(Boolean)
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

function StatusDot({
  status,
  copy,
}: {
  status: WorkspaceAgent["status"] | WorkspaceSession["status"]
  copy: MobileNavigatorCopy
}) {
  if (!status || status === "idle") return null
  return (
    <span
      className={styles.statusDot}
      data-status={status}
      title={statusLabel(status, copy)}
      aria-hidden="true"
    />
  )
}

export function MobileNavigator({
  state,
  agents,
  selectedAgentId,
  activeThreadId,
  sessionsByAgentId,
  threadListRuntime,
  agentActivity = {},
  otherAgentsActivity,
  sessionActivity = {},
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
  const [actionThreadId, setActionThreadId] = useState<string | null>(null)

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
                const activity = agentActivity[agent.id]
                const label = [
                  agent.name,
                  agent.status && agent.status !== "idle"
                    ? statusLabel(agent.status, copy)
                    : null,
                  agent.id === selectedAgentId ? copy.selected : null,
                  ...activityLabel(activity, copy),
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
                    data-needs-attention={
                      activity?.needsAttention ? "true" : undefined
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
                    <StatusDot status={agent.status} copy={copy} />
                    <ActivityMarker activity={activity} copy={copy} />
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
          sessionActivity={sessionActivity}
          otherAgentsActivity={otherAgentsActivity}
          query={sessionQueries[state.agentId] ?? ""}
          locale={locale}
          copy={copy}
          actionThreadId={actionThreadId}
          renderAgentIcon={renderAgentIcon}
          onQueryChange={(query) =>
            setSessionQueries((current) => ({
              ...current,
              [state.agentId]: query,
            }))
          }
          onActionThreadChange={setActionThreadId}
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
  sessionActivity: Readonly<
    Record<string, MobileNavigationActivity | undefined>
  >
  otherAgentsActivity?: MobileNavigationActivity
  query: string
  locale: "en" | "he"
  copy: MobileNavigatorCopy
  actionThreadId: string | null
  renderAgentIcon?: (agent: WorkspaceAgent) => ReactNode
  onQueryChange: (query: string) => void
  onActionThreadChange: (threadId: string | null) => void
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
  sessionActivity,
  otherAgentsActivity,
  query,
  locale,
  copy,
  actionThreadId,
  renderAgentIcon,
  onQueryChange,
  onActionThreadChange,
  onBack,
  onDismiss,
  onOpenSession,
  onCreateSession,
  onRemoveOpenSession,
  onAgentDetails,
  onActionError,
}: SessionsViewProps) {
  const normalizedQuery = normalizeSearch(query, locale)
  const filter = (session: WorkspaceSession) =>
    !normalizedQuery ||
    normalizeSearch(session.title, locale).includes(normalizedQuery)
  const visibleOpen = openSessions.filter(filter)
  const visibleHistory = historySessions.filter(filter)
  const hasSessions = openSessions.length + historySessions.length > 0
  const hasResults = visibleOpen.length + visibleHistory.length > 0

  return (
    <>
      <header className={styles.header}>
        <Button
          variant="ghost"
          className={styles.backButton}
          type="button"
          aria-label={[
            copy.backToAgents,
            ...activityLabel(otherAgentsActivity, copy),
          ].join(", ")}
          onClick={onBack}
        >
          <ArrowLeft aria-hidden="true" />
          <span>{copy.agents}</span>
          <ActivityMarker activity={otherAgentsActivity} copy={copy} />
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

      <label className={styles.searchField}>
        <Search aria-hidden="true" />
        <span className={styles.srOnly}>{copy.searchSessions}</span>
        <input
          type="search"
          aria-label={copy.searchSessions}
          placeholder={copy.searchSessions}
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
        />
      </label>

      <ThreadListPrimitive.Root className={styles.sessionScroller}>
        {visibleOpen.length ? (
          <SessionSection
            heading={copy.openSessions}
            sessions={visibleOpen}
            activeThreadId={activeThreadId}
            lastSelectedThreadId={lastSelectedThreadId}
            sessionActivity={sessionActivity}
            copy={copy}
            locale={locale}
            actionThreadId={actionThreadId}
            onActionThreadChange={onActionThreadChange}
            onOpenSession={onOpenSession}
            onRemoveOpenSession={onRemoveOpenSession}
            threadListRuntime={threadListRuntime}
            onActionError={onActionError}
          />
        ) : null}
        {visibleHistory.length ? (
          <SessionSection
            heading={copy.history}
            sessions={visibleHistory}
            activeThreadId={activeThreadId}
            lastSelectedThreadId={lastSelectedThreadId}
            sessionActivity={sessionActivity}
            copy={copy}
            locale={locale}
            actionThreadId={actionThreadId}
            onActionThreadChange={onActionThreadChange}
            onOpenSession={onOpenSession}
            threadListRuntime={threadListRuntime}
            onActionError={onActionError}
          />
        ) : null}
        {!hasResults ? (
          <div className={styles.empty}>
            <p>{hasSessions ? copy.noSearchResults : copy.noSessions}</p>
            {normalizedQuery ? (
              <Button variant="ghost" onClick={() => onQueryChange("")}>
                {copy.clearSearch}
              </Button>
            ) : null}
          </div>
        ) : null}
      </ThreadListPrimitive.Root>
    </>
  )
}

type SessionSectionProps = {
  heading: string
  sessions: readonly WorkspaceSession[]
  activeThreadId: string | null
  lastSelectedThreadId: string | null
  sessionActivity: Readonly<
    Record<string, MobileNavigationActivity | undefined>
  >
  copy: MobileNavigatorCopy
  locale: "en" | "he"
  actionThreadId: string | null
  onActionThreadChange: (threadId: string | null) => void
  onOpenSession: (threadId: string) => void
  onRemoveOpenSession?: (threadId: string) => void
  threadListRuntime?: ThreadListRuntime
  onActionError?: (error: unknown) => void
}

function SessionSection({
  heading,
  sessions,
  activeThreadId,
  lastSelectedThreadId,
  sessionActivity,
  copy,
  locale,
  actionThreadId,
  onActionThreadChange,
  onOpenSession,
  onRemoveOpenSession,
  threadListRuntime,
  onActionError,
}: SessionSectionProps) {
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })

  return (
    <section className={styles.section} aria-label={heading}>
      <h3>{heading}</h3>
      <div className={styles.list}>
        {sessions.map((session) => {
          const activity = sessionActivity[session.threadId]
          const parsedDate = new Date(session.updatedAt)
          const isActive = session.threadId === activeThreadId
          const isLastSelected = session.threadId === lastSelectedThreadId
          const label = [
            `${copy.openSession}: ${session.title}`,
            session.status !== "idle"
              ? statusLabel(session.status, copy)
              : null,
            isActive ? copy.selected : null,
            !isActive && isLastSelected ? copy.lastSelected : null,
            ...activityLabel(activity, copy),
          ]
            .filter(Boolean)
            .join(", ")

          return (
            <SessionThreadListItem
              runtime={threadListRuntime}
              threadId={session.threadId}
              onSwitch={() => onOpenSession(session.threadId)}
              onActionError={onActionError}
              className={styles.sessionRow}
              data-testid={`mobile-session-${session.threadId}`}
              key={session.threadId}
            >
              <SessionThreadListTrigger
                type="button"
                className={styles.sessionNavigation}
                aria-label={label}
                aria-current={isActive ? "true" : undefined}
                data-needs-attention={
                  activity?.needsAttention ? "true" : undefined
                }
              >
                <span className={styles.rowText}>
                  <span className={styles.sessionTitleLine}>
                    <StatusDot status={session.status} copy={copy} />
                    <bdi className={styles.rowTitle}>
                      <SessionThreadListTitle fallback={session.title} />
                    </bdi>
                    <ActivityMarker activity={activity} copy={copy} />
                  </span>
                  {Number.isFinite(parsedDate.getTime()) ? (
                    <time dateTime={session.updatedAt}>
                      {dateFormatter.format(parsedDate)}
                    </time>
                  ) : null}
                </span>
              </SessionThreadListTrigger>
              {onRemoveOpenSession ? (
                <div className={styles.actionSlot}>
                  <Button
                    variant="ghost"
                    className={styles.iconButton}
                    aria-label={`${copy.sessionActions}: ${session.title}`}
                    aria-haspopup="menu"
                    aria-expanded={actionThreadId === session.threadId}
                    onClick={() =>
                      onActionThreadChange(
                        actionThreadId === session.threadId
                          ? null
                          : session.threadId
                      )
                    }
                  >
                    <Ellipsis />
                  </Button>
                  {actionThreadId === session.threadId ? (
                    <div className={styles.actionMenu} role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          onActionThreadChange(null)
                          onRemoveOpenSession(session.threadId)
                        }}
                      >
                        <X aria-hidden="true" />
                        {copy.removeOpenSession}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </SessionThreadListItem>
          )
        })}
      </div>
    </section>
  )
}
