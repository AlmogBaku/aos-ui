"use client"

import {
  ThreadListPrimitive,
  type ThreadListRuntime,
} from "@assistant-ui/react"
import { Ellipsis, Search, X } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import type { Locale } from "@/lib/i18n/config"
import { cn } from "@/lib/utils"

import type { NavigationActivitySummary } from "./navigation-activity"
import {
  SessionThreadListItem,
  SessionThreadListTitle,
  SessionThreadListTrigger,
} from "./session-thread-list-item"
import type { WorkspaceSession } from "./workspace-shell"
import type { AgentSessionNavigation } from "./workspace-navigation-catalog"
import styles from "./agent-session-history.module.css"

export type AgentSessionHistoryCopy = {
  searchSessions: string
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
  unread: (count: number) => string
  needsAttention: string
}

export type AgentSessionHistoryProps = {
  navigation: AgentSessionNavigation
  activeThreadId: string | null
  sessionActivity?: Readonly<
    Record<string, NavigationActivitySummary | undefined>
  >
  locale: Locale
  copy: AgentSessionHistoryCopy
  query: string
  onQueryChange: (query: string) => void
  onOpenSession: (agentId: string, threadId: string) => void | Promise<unknown>
  onRemoveOpenSession?: (
    agentId: string,
    threadId: string
  ) => void | Promise<unknown>
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

function ActivityMarker({
  activity,
  copy,
}: {
  activity: NavigationActivitySummary | undefined
  copy: AgentSessionHistoryCopy
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

function SessionSection({
  heading,
  sessions,
  navigation,
  activeThreadId,
  sessionActivity,
  locale,
  copy,
  removable,
  actionThreadId,
  onActionThreadChange,
  onOpenSession,
  onRemoveOpenSession,
  threadListRuntime,
  onActionError,
}: {
  heading: string
  sessions: readonly WorkspaceSession[]
  navigation: AgentSessionNavigation
  activeThreadId: string | null
  sessionActivity: Readonly<
    Record<string, NavigationActivitySummary | undefined>
  >
  locale: Locale
  copy: AgentSessionHistoryCopy
  removable: boolean
  actionThreadId: string | null
  onActionThreadChange: (threadId: string | null) => void
  onOpenSession: AgentSessionHistoryProps["onOpenSession"]
  onRemoveOpenSession?: AgentSessionHistoryProps["onRemoveOpenSession"]
  threadListRuntime?: ThreadListRuntime
  onActionError?: (error: unknown) => void
}) {
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })

  return (
    <section className={cn(styles.section, "mt-2")} aria-label={heading}>
      <h3 className="px-2 pt-1 pb-1.5 text-sm">{heading}</h3>
      <div className={styles.list}>
        {sessions.map((session) => {
          const activity = sessionActivity[session.threadId]
          const parsedDate = new Date(session.updatedAt)
          const isActive = session.threadId === activeThreadId
          const isLastSelected =
            session.threadId === navigation.lastSelectedThreadId
          const label = [
            `${copy.openSession}: ${session.title}`,
            session.status !== "idle"
              ? `${copy.statusLabel}: ${sessionStatusLabel(session.status, copy)}`
              : null,
            isActive ? copy.selected : null,
            !isActive && isLastSelected ? copy.lastSelected : null,
            activity?.unreadCount ? copy.unread(activity.unreadCount) : null,
            activity?.needsAttention ? copy.needsAttention : null,
          ]
            .filter(Boolean)
            .join(", ")

          return (
            <SessionThreadListItem
              runtime={threadListRuntime}
              threadId={session.threadId}
              onSwitch={() =>
                onOpenSession(navigation.agentId, session.threadId)
              }
              onActionError={onActionError}
              className={styles.sessionRow}
              data-session-id={session.threadId}
              key={session.threadId}
            >
              <SessionThreadListTrigger
                type="button"
                className={cn(
                  styles.sessionNavigation,
                  "min-h-12 gap-2 p-2 pe-1"
                )}
                aria-label={label}
                aria-current={isActive ? "true" : undefined}
                data-needs-attention={
                  activity?.needsAttention ? "true" : undefined
                }
              >
                <span className={cn(styles.rowText, "gap-0.5")}>
                  <span className={cn(styles.sessionTitleLine, "gap-1.5")}>
                    {session.status !== "idle" ? (
                      <span
                        className={styles.statusDot}
                        data-status={session.status}
                        title={sessionStatusLabel(session.status, copy)}
                        aria-hidden="true"
                      />
                    ) : null}
                    <bdi className={cn(styles.rowTitle, "text-sm")}>
                      <SessionThreadListTitle fallback={session.title} />
                    </bdi>
                    <ActivityMarker activity={activity} copy={copy} />
                  </span>
                  {Number.isFinite(parsedDate.getTime()) ? (
                    <time className="text-xs" dateTime={session.updatedAt}>
                      {dateFormatter.format(parsedDate)}
                    </time>
                  ) : null}
                </span>
              </SessionThreadListTrigger>
              {removable && onRemoveOpenSession ? (
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
                          runAction(
                            () =>
                              onRemoveOpenSession(
                                navigation.agentId,
                                session.threadId
                              ),
                            onActionError
                          )
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

export function AgentSessionHistory({
  navigation,
  activeThreadId,
  sessionActivity = {},
  locale,
  copy,
  query,
  onQueryChange,
  onOpenSession,
  onRemoveOpenSession,
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
  const visibleOpen = navigation.openSessions.filter(filter)
  const visibleHistory = navigation.historySessions.filter(
    (session) => !openIds.has(session.threadId) && filter(session)
  )
  const hasSessions =
    navigation.openSessions.length +
      navigation.historySessions.filter(
        (session) => !openIds.has(session.threadId)
      ).length >
    0
  const hasResults = visibleOpen.length + visibleHistory.length > 0
  const [actionThreadId, setActionThreadId] = useState<string | null>(null)

  return (
    <div className={styles.history}>
      <label
        className={cn(styles.searchField, "m-2 min-h-11 gap-2.5 px-3 text-sm")}
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
      <ThreadListPrimitive.Root className={styles.sessionScroller}>
        {visibleOpen.length ? (
          <SessionSection
            heading={copy.openSessions}
            sessions={visibleOpen}
            navigation={navigation}
            activeThreadId={activeThreadId}
            sessionActivity={sessionActivity}
            locale={locale}
            copy={copy}
            removable
            actionThreadId={actionThreadId}
            onActionThreadChange={setActionThreadId}
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
            navigation={navigation}
            activeThreadId={activeThreadId}
            sessionActivity={sessionActivity}
            locale={locale}
            copy={copy}
            removable={false}
            actionThreadId={actionThreadId}
            onActionThreadChange={setActionThreadId}
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
    </div>
  )
}
