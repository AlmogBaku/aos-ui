"use client"

import {
  ThreadListPrimitive,
  type ThreadListRuntime,
} from "@assistant-ui/react"
import { ChevronDown, Pin, Plus, Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { Locale } from "@/lib/i18n/config"
import { cn } from "@/lib/utils"
import type { SessionActionCapabilities } from "@/runtime-adapters/contracts"

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
import { RowIndicators } from "./status-dots"
import styles from "./agent-session-history.module.css"

export type AgentSessionHistoryCopy = {
  searchSessions: string
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
  sessionMenu: SessionRowMenuCopy
}

export type AgentSessionHistoryProps = {
  navigation: AgentSessionNavigation
  activeThreadId: string | null
  locale: Locale
  copy: AgentSessionHistoryCopy
  query: string
  onQueryChange: (query: string) => void
  onOpenSession: (agentId: string, threadId: string) => void | Promise<unknown>
  onCreateSession?: (agentId: string) => void | Promise<unknown>
  onRemoveOpenSession?: (
    agentId: string,
    threadId: string
  ) => void | Promise<unknown>
  /** Runtime-declared Session actions, or `null` until the runtime answers. */
  availability?: SessionActionCapabilities | null
  sessionMenu?: SessionRowMenuHandlers
  threadListRuntime?: ThreadListRuntime
  onActionError?: (error: unknown) => void
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
  const isActive = session.threadId === activeThreadId
  const isLastSelected = session.threadId === navigation.lastSelectedThreadId
  const label = [
    `${copy.openSession}: ${session.title}`,
    session.status !== "idle"
      ? `${copy.statusLabel}: ${sessionStatusLabel(session.status, copy)}`
      : null,
    isActive ? copy.selected : null,
    !isActive && isLastSelected ? copy.lastSelected : null,
    session.unread ? copy.unread : null,
    session.pinned ? copy.pinned : null,
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
        className={styles.iconButton}
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
          threadId={session.threadId}
          onSwitch={() => onOpenSession(navigation.agentId, session.threadId)}
          onActionError={onActionError}
          className={styles.sessionRow}
          data-session-id={session.threadId}
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
        <div className={styles.sessionRow} data-session-id={session.threadId}>
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
  ...row
}: SessionSectionProps & {
  heading: string
  sessions: readonly WorkspaceSession[]
}) {
  const dateFormatter = sessionDateFormatter(row.locale)

  return (
    <section className={cn(styles.section, "mt-2")} aria-label={heading}>
      <h3 className="px-2 pt-1 pb-1.5 text-sm">{heading}</h3>
      <div className={styles.list}>
        {sessions.map((session) => (
          <SessionRow
            {...row}
            key={session.threadId}
            session={session}
            dateFormatter={dateFormatter}
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
                key={session.threadId}
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

function sessionDateFormatter(locale: Locale) {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
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
  onActionError,
}: AgentSessionHistoryProps) {
  const normalizedQuery = normalizeSearch(query, locale)
  const openIds = new Set(
    navigation.openSessions.map((session) => session.threadId)
  )
  const filter = (session: WorkspaceSession) =>
    !normalizedQuery ||
    normalizeSearch(session.title, locale).includes(normalizedQuery)
  const historySessions = navigation.historySessions.filter(
    (session) => !openIds.has(session.threadId)
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
    visibleOpen.length + visibleHistory.length + visibleArchived.length > 0
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
            () => onRemoveOpenSession(navigation.agentId, session.threadId),
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
        <label
          className={cn(styles.searchField, "min-h-11 gap-2.5 px-3 text-sm")}
        >
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
        {visibleHistory.length ? (
          <SessionSection
            {...sharedRow}
            heading={copy.history}
            sessions={visibleHistory}
            openable
            handlers={sessionMenu ?? {}}
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
