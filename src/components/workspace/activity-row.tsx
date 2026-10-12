import { Check } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import type { InboxRow } from "@/lib/notifications/inbox"
import { relativeTime } from "@/lib/relative-time"

import styles from "./activity-row.module.css"
import { WorkspaceAgentTile } from "./workspace-agent-tile"

/** What a row says, before its time: its lead, its Session, and its state. */
export function rowCopy(row: InboxRow, dictionary: Dictionary) {
  const copy = dictionary.activity
  const [before = "", after = ""] =
    row.state === "ready" ? copy.agentIsReady.split("{name}") : []
  const title = row.title ?? copy.sessionFallback
  const state = {
    waiting: copy.waitingForInput,
    failed: copy.turnFailed,
    unread: dictionary.status.unread,
    // "<name> is ready" already says it.
    ready: null,
  }[row.state]
  const summary = [`${before}${row.agent.name}${after}`, title, state]
  return { before, after, title, summary: summary.filter(Boolean).join(", ") }
}

export function ActivityRow({
  row,
  dictionary,
  locale,
  now,
  onOpen,
  onMarkRead,
}: {
  row: InboxRow
  dictionary: Dictionary
  locale: Locale
  now: Date
  onOpen: () => void
  /** Receives Mark read itself, so focus can move on from where it was. */
  onMarkRead: (from: HTMLElement) => void
}) {
  const copy = dictionary.activity
  const { before, after, title, summary } = rowCopy(row, dictionary)
  return (
    <li className={styles.row}>
      <button
        className={styles.open}
        type="button"
        data-activity-row={row.sessionId}
        aria-label={`${summary}, ${relativeTime(row.time, now, locale, "long")}`}
        onClick={onOpen}
      >
        <WorkspaceAgentTile agent={row.agent} size={32} />
        <span className={styles.rowText}>
          <span className={styles.rowLead}>
            <span className={styles.rowName}>
              {before}
              <bdi>{row.agent.name}</bdi>
              {after}
            </span>
            <time dateTime={row.time}>
              {relativeTime(row.time, now, locale)}
            </time>
          </span>
          <span className={styles.rowTitle}>
            <bdi>{title}</bdi>
          </span>
          {row.state === "failed" ? (
            <span className={styles.rowFailed}>{copy.turnFailed}</span>
          ) : null}
        </span>
      </button>
      {/* Reading a Session never answers it, so a waiting row has no Mark read. */}
      {row.state === "waiting" ? null : (
        <Button
          className={styles.markRead}
          variant="ghost"
          size="icon-sm"
          aria-label={`${copy.markRead}: ${row.agent.name}, ${title}`}
          onClick={(event) => onMarkRead(event.currentTarget)}
        >
          <Check />
        </Button>
      )}
    </li>
  )
}
