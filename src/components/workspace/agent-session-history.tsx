"use client"

import {
  ThreadListPrimitive,
  type ThreadListRuntime,
} from "@assistant-ui/react"
import { ChevronDown, Pin, Plus, Search } from "lucide-react"
import { useEffect, useEffectEvent, useState } from "react"

import { Button } from "@/components/ui/button"
import type { Locale } from "@/lib/i18n/config"
import { cn } from "@/lib/utils"
import type {
  SessionActionCapabilities,
  SessionPlatform,
  SessionSearchResult,
} from "@/runtime-adapters/contracts"

import {
  SessionHistoryLoadMore,
  type SessionHistoryLoadMoreCopy,
} from "./session-history-load-more"
import {
  SessionRowContextMenu,
  SessionRowMenuButton,
  type SessionRowMenuCopy,
  type SessionRowMenuHandlers,
} from "./session-row-menu"
import {
  SessionThreadListItem,
  SessionThreadListTitle,
  SessionThreadListTrigger,
} from "./session-thread-list-item"
import type { WorkspaceSession } from "./workspace-shell"
import type { AgentSessionNavigation } from "./workspace-navigation-catalog"
import { SessionPlatformIcon } from "./session-platform-icon"
import { RowIndicators } from "./status-dots"
import styles from "./agent-session-history.module.css"

export type AgentSessionHistoryCopy = SessionHistoryLoadMoreCopy & {
  searchSessions: string
  /** Announced while the provider search for the typed query runs. */
  searchingSessions: string
  newSession: string
  openSessions: string
  history: string
  clearSearch: string
  noSessions: string
  noSearchResults: string
  openSession: string
  sessionActions: string
  removeOpenSession: string
  selected: string
  lastSelected: string
  statusLabel: string
  status: {
    idle: string
    running: string
    unknown: string
    waitingForInput: string
    failed: string
  }
  unread: string
  /** Heading of the collapsed disclosure holding archived Sessions. */
  archivedSessions: string
  noArchivedSessions: string
  /** Row state appended to an accessible name. */
  pinned: string
  archived: string
  /** "From {platform}" labels keyed by platform id. */
  platform: Record<SessionPlatform, string>
  sessionMenu: SessionRowMenuCopy
}

export type AgentSessionHistoryProps = {
  navigation: AgentSessionNavigation
  activeThreadId: string | null
  locale: Locale
  copy: AgentSessionHistoryCopy
  query: string
  onQueryChange: (query: string) => void
  onOpenSession: (agentId: string, sessionId: string) => void | Promise<unknown>
  onCreateSession?: (agentId: string) => void | Promise<unknown>
  onRemoveOpenSession?: (
    agentId: string,
    sessionId: string
  ) => void | Promise<unknown>
  /** Runtime-declared Session actions, or `null` until the runtime answers. */
  availability?: SessionActionCapabilities | null
  sessionMenu?: SessionRowMenuHandlers
  threadListRuntime?: ThreadListRuntime
  /**
   * The Agent whose catalog the thread list pages, when the runtime pages one
   * Agent at a time. Only that Agent's History offers "Load more": a further
   * page lists none of another Agent's Sessions, so a sentinel under another
   * Agent's list would stay in view and read page after page. Absent, the
   * thread list spans every Agent and any History may read on.
   */
  pagedAgentId?: string
  onActionError?: (error: unknown) => void
  /**
   * The provider's Session search. Without it the search box filters the
   * loaded titles alone; with it, a pause in typing also adds the Sessions the
   * provider matched, including ones History has not loaded yet.
   */
  onSearch?: (
    query: string,
    agentId: string
  ) => Promise<readonly SessionSearchResult[]>
}

/** How long typing pauses before the provider is searched. */
export const SESSION_SEARCH_DEBOUNCE_MS = 300

type ProviderMatches = {
  agentId: string
  query: string
  results: readonly SessionSearchResult[]
}

/**
 * Searches the provider once typing pauses. Matches belong to the query and
 * Agent they answered, so an answer for an older query never stands for the
 * current one, and the search is pending until the current one is answered.
 */
function useProviderSessionSearch(
  onSearch: AgentSessionHistoryProps["onSearch"],
  query: string,
  agentId: string
) {
  const search = useEffectEvent((query: string, agentId: string) =>
    onSearch ? onSearch(query, agentId) : Promise.resolve([])
  )
  const enabled = Boolean(onSearch)
  const [matches, setMatches] = useState<ProviderMatches | null>(null)

  useEffect(() => {
    if (!enabled || !query) return
    let current = true
    const settle = (results: readonly SessionSearchResult[]) => {
      if (current) setMatches({ agentId, query, results })
    }
    const timer = setTimeout(() => {
      search(query, agentId).then(
        settle,
        // A failed search leaves the loaded titles to answer alone.
        () => settle([])
      )
    }, SESSION_SEARCH_DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [agentId, enabled, query])

  const answered =
    matches && matches.agentId === agentId && matches.query === query
      ? matches.results
      : null
  return {
    matches: answered,
    searching: enabled && Boolean(query) && !answered,
  }
}

function normalizeSearch(value: string, locale: Locale) {
  return value.trim().toLocaleLowerCase(locale)
}

function sessionStatusLabel(
  status: WorkspaceSession["status"],
  copy: AgentSessionHistoryCopy
) {
  if (status === "waiting-for-input") return copy.status.waitingForInput
  if (status === "failed") return copy.status.failed
  if (status === "running") return copy.status.running
  if (status === "unknown") return copy.status.unknown
  return copy.status.idle
}

function runAction(
  action: () => void | Promise<unknown>,
  onActionError?: (error: unknown) => void
) {
  try {
    void Promise.resolve(action()).catch(onActionError)
  } catch (error) {
    onActionError?.(error)
  }
}

type SessionRowProps = {
  session: WorkspaceSession
  navigation: AgentSessionNavigation
  activeThreadId: string | null
  locale: Locale
  copy: AgentSessionHistoryCopy
  dateFormatter: Intl.DateTimeFormat
  /** Archived rows list their Session without switching to it. */
  openable: boolean
  availability?: SessionActionCapabilities | null
  handlers: SessionRowMenuHandlers
  onOpenSession: AgentSessionHistoryProps["onOpenSession"]
  threadListRuntime?: ThreadListRuntime
  onActionError?: (error: unknown) => void
}

function SessionRow({
  session,
  navigation,
  activeThreadId,
  locale,
  copy,
  dateFormatter,
  openable,
  availability,
  handlers,
  onOpenSession,
  threadListRuntime,
  onActionError,
}: SessionRowProps) {
  const parsedDate = new Date(session.updatedAt)
  const isActive = session.sessionId === activeThreadId
  const isLastSelected = session.sessionId === navigation.lastSelectedThreadId
  const label = [
    `${copy.openSession}: ${session.title}`,
    session.status !== "idle"
      ? `${copy.statusLabel}: ${sessionStatusLabel(session.status, copy)}`
      : null,
    isActive ? copy.selected : null,
    !isActive && isLastSelected ? copy.lastSelected : null,
    session.unread ? copy.unread : null,
    session.pinned ? copy.pinned : null,
    session.platform ? copy.platform[session.platform] : null,
    session.archived ? copy.archived : null,
  ]
    .filter(Boolean)
    .join(", ")

  const rowText = (
    <span className={cn(styles.rowText, "gap-0.5")}>
      <span className={cn(styles.sessionTitleLine, "gap-1.5")}>
        <RowIndicators
          status={session.status}
          statusLabel={sessionStatusLabel(session.status, copy)}
          unread={session.unread}
          unreadLabel={copy.unread}
        />
        {session.pinned ? (
          <Pin className={styles.pinGlyph} aria-hidden="true" />
        ) : null}
        {session.platform ? (
          <SessionPlatformIcon
            platform={session.platform}
            className={styles.pinGlyph}
          />
        ) : null}
        <bdi className={cn(styles.rowTitle, "text-sm")}>
          {openable ? (
            <SessionThreadListTitle fallback={session.title} />
          ) : (
            session.title
          )}
        </bdi>
      </span>
      {Number.isFinite(parsedDate.getTime()) ? (
        <time className="text-xs" dateTime={session.updatedAt}>
          {dateFormatter.format(parsedDate)}
        </time>
      ) : null}
    </span>
  )

  const menuButton = (
    <div className={styles.actionSlot}>
      <SessionRowMenuButton
        session={session}
        copy={copy.sessionMenu}
        locale={locale}
        availability={availability}
        handlers={handlers}
        size="icon"
      />
    </div>
  )

  return (
    <SessionRowContextMenu
      session={session}
      copy={copy.sessionMenu}
      locale={locale}
      availability={availability}
      handlers={handlers}
    >
      {openable ? (
        <SessionThreadListItem
          runtime={threadListRuntime}
          sessionId={session.sessionId}
          onSwitch={() => onOpenSession(navigation.agentId, session.sessionId)}
          onActionError={onActionError}
          className={styles.sessionRow}
          data-session-id={session.sessionId}
        >
          <SessionThreadListTrigger
            type="button"
            className={cn(styles.sessionNavigation, "min-h-12 gap-2 p-2 pe-1")}
            aria-label={label}
            aria-current={isActive ? "true" : undefined}
          >
            {rowText}
          </SessionThreadListTrigger>
          {menuButton}
        </SessionThreadListItem>
      ) : (
        <div className={styles.sessionRow} data-session-id={session.sessionId}>
          <span className={cn(styles.sessionStatic, "min-h-12 gap-2 p-2 pe-1")}>
            {rowText}
          </span>
          {menuButton}
        </div>
      )}
    </SessionRowContextMenu>
  )
}

type SessionSectionProps = Omit<SessionRowProps, "session" | "dateFormatter">

function SessionSection({
  heading,
  sessions,
  searchOnly = [],
  ...row
}: SessionSectionProps & {
  heading: string
  sessions: readonly WorkspaceSession[]
  /** Provider matches not yet in the thread list, listed after `sessions`. */
  searchOnly?: readonly WorkspaceSession[]
}) {
  const dateFormatter = sessionDateFormatter(row.locale)

  return (
    <section className={cn(styles.section, "mt-2")} aria-label={heading}>
      <h3 className="px-2 pt-1 pb-1.5 text-sm">{heading}</h3>
      <div className={styles.list}>
        {sessions.map((session) => (
          <SessionRow
            {...row}
            key={session.sessionId}
            session={session}
            dateFormatter={dateFormatter}
          />
        ))}
        {searchOnly.map((session) => (
          // Opened through its Agent; its menu arrives once it is loaded.
          <SessionRow
            {...row}
            key={session.sessionId}
            session={session}
            dateFormatter={dateFormatter}
            threadListRuntime={undefined}
            handlers={{}}
          />
        ))}
      </div>
    </section>
  )
}

/**
 * Archived Sessions stay out of the way behind a stateless disclosure: the
 * section only appears for an Agent that has them, and the search box narrows
 * it like every other section.
 */
function ArchivedSection({
  sessions,
  ...row
}: SessionSectionProps & { sessions: readonly WorkspaceSession[] }) {
  const dateFormatter = sessionDateFormatter(row.locale)

  return (
    <section
      className={cn(styles.section, "mt-2")}
      aria-label={row.copy.archivedSessions}
    >
      <details className={styles.archived}>
        <summary className={cn(styles.archivedSummary, "min-h-11 gap-1.5 p-2")}>
          <ChevronDown className={styles.archivedChevron} aria-hidden="true" />
          <h3 className="text-sm">{row.copy.archivedSessions}</h3>
        </summary>
        <div className={styles.list}>
          {sessions.length ? (
            sessions.map((session) => (
              <SessionRow
                {...row}
                key={session.sessionId}
                session={session}
                dateFormatter={dateFormatter}
              />
            ))
          ) : (
            <p className={cn(styles.archivedEmpty, "text-sm")}>
              {row.copy.noArchivedSessions}
            </p>
          )}
        </div>
      </details>
    </section>
  )
}

const sessionDateFormatters = new Map<Locale, Intl.DateTimeFormat>()

/**
 * The provider's matches History has not loaded yet, as rows of their own,
 * newest first: a page not yet loaded would otherwise hide every older match.
 */
function unloadedMatches(
  matches: readonly SessionSearchResult[],
  navigation: AgentSessionNavigation
): WorkspaceSession[] {
  const loaded = new Set(
    [
      ...navigation.openSessions,
      ...navigation.historySessions,
      ...navigation.archivedSessions,
    ].map((session) => session.sessionId)
  )
  return matches
    .filter(
      (match) =>
        match.agentId === navigation.agentId && !loaded.has(match.sessionId)
    )
    .map(({ sessionId, title, updatedAt }) => ({
      sessionId,
      title,
      updatedAt,
      status: "idle" as const,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** One formatter per locale: building an `Intl.DateTimeFormat` is costly. */
function sessionDateFormatter(locale: Locale) {
  let formatter = sessionDateFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
    sessionDateFormatters.set(locale, formatter)
  }
  return formatter
}

export function AgentSessionHistory({
  navigation,
  activeThreadId,
  locale,
  copy,
  query,
  onQueryChange,
  onOpenSession,
  onCreateSession,
  onRemoveOpenSession,
  availability,
  sessionMenu,
  threadListRuntime,
  pagedAgentId,
  onActionError,
  onSearch,
}: AgentSessionHistoryProps) {
  const pagesThisAgent =
    pagedAgentId === undefined || pagedAgentId === navigation.agentId
  const normalizedQuery = normalizeSearch(query, locale)
  const { matches, searching } = useProviderSessionSearch(
    onSearch,
    query.trim(),
    navigation.agentId
  )
  const matchedIds = new Set(matches?.map((match) => match.sessionId))
  const searchOnly = matches ? unloadedMatches(matches, navigation) : []
  const openIds = new Set(
    navigation.openSessions.map((session) => session.sessionId)
  )
  const filter = (session: WorkspaceSession) =>
    !normalizedQuery ||
    normalizeSearch(session.title, locale).includes(normalizedQuery) ||
    matchedIds.has(session.sessionId)
  const historySessions = navigation.historySessions.filter(
    (session) => !openIds.has(session.sessionId)
  )
  const visibleOpen = navigation.openSessions.filter(filter)
  const visibleHistory = historySessions.filter(filter)
  const visibleArchived = navigation.archivedSessions.filter(filter)
  const hasSessions =
    navigation.openSessions.length +
      historySessions.length +
      navigation.archivedSessions.length >
    0
  const hasResults =
    visibleOpen.length +
      visibleHistory.length +
      searchOnly.length +
      visibleArchived.length >
    0
  const sharedRow = {
    navigation,
    activeThreadId,
    locale,
    copy,
    availability,
    onOpenSession,
    threadListRuntime,
    onActionError,
  }
  const openHandlers: SessionRowMenuHandlers = {
    ...sessionMenu,
    onRemoveOpenSession: onRemoveOpenSession
      ? (session) =>
          runAction(
            () => onRemoveOpenSession(navigation.agentId, session.sessionId),
            onActionError
          )
      : undefined,
  }

  return (
    <div className={styles.history}>
      <div
        className={styles.historyControls}
        role="group"
        aria-label={copy.sessionActions}
      >
        <label className={cn(styles.searchField, "h-8 gap-2 px-2.5 text-sm")}>
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
        {onCreateSession ? (
          <Button
            className={styles.createSessionButton}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={copy.newSession}
            title={copy.newSession}
            onClick={() =>
              runAction(
                () => onCreateSession(navigation.agentId),
                onActionError
              )
            }
          >
            <Plus aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <ThreadListPrimitive.Root className={styles.sessionScroller}>
        {visibleOpen.length ? (
          <SessionSection
            {...sharedRow}
            heading={copy.openSessions}
            sessions={visibleOpen}
            openable
            handlers={openHandlers}
          />
        ) : null}
        {visibleHistory.length || searchOnly.length ? (
          <SessionSection
            {...sharedRow}
            heading={copy.history}
            sessions={visibleHistory}
            searchOnly={searchOnly}
            openable
            handlers={sessionMenu ?? {}}
          />
        ) : null}
        {searching ? (
          <div className={styles.empty} role="status" aria-busy="true">
            <p>{copy.searchingSessions}</p>
          </div>
        ) : !hasResults ? (
          <div className={styles.empty}>
            <p>{hasSessions ? copy.noSearchResults : copy.noSessions}</p>
            {normalizedQuery ? (
              <Button variant="ghost" onClick={() => onQueryChange("")}>
                {copy.clearSearch}
              </Button>
            ) : null}
          </div>
        ) : null}
        {threadListRuntime && pagesThisAgent ? (
          <SessionHistoryLoadMore copy={copy} />
        ) : null}
        {navigation.archivedSessions.length ? (
          <ArchivedSection
            {...sharedRow}
            sessions={visibleArchived}
            openable={false}
            handlers={sessionMenu ?? {}}
          />
        ) : null}
      </ThreadListPrimitive.Root>
    </div>
  )
}
