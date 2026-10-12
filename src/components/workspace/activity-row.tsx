import { Check } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { Locale } from "@/lib/i18n/config"
import type { Dictionary } from "@/lib/i18n/dictionary"
import type { InboxRow } from "@/lib/notifications/inbox"
import { relativeTime } from "@/lib/relative-time"

import styles from "./activity-row.module.css"
import { QuietDot, StatusDot, UnreadDot } from "./status-dots"
import { WorkspaceAgentTile } from "./workspace-agent-tile"

/** What a row says, before its time: its lead, its Session, and its state. */
export function rowCopy(row: InboxRow, dictionary: Dictionary) {
  const copy = dictionary.activity
  const [before = "", after = ""] =
    row.state === "ready" ? copy.agentIsReady.split("{name}") : []
  // A ready Agent has no Session yet; its description stands in, if any.
  const title =
    row.title ?? (row.state === "ready" ? undefined : copy.sessionFallback)
  const more = row.request?.more
    ? copy.requestMore.replace("{count}", () => String(row.request?.more))
    : undefined
  const asked = row.request
    ? `${copy.waitingForInput}: ${[row.request.text, more].filter(Boolean).join(" ")}`
    : copy.waitingForInput
  const state = {
    waiting: asked,
    failed: copy.turnFailed,
    unread: dictionary.status.unread,
    // "<name> is ready" already says it.
    ready: null,
  }[row.state]
  const summary = [`${before}${row.agent.name}${after}`, title, state]
  return {
    before,
    after,
    title,
    more,
    summary: summary.filter(Boolean).join(", "),
  }
}

export function ActivityRow({
  row,
  quiet,
  dictionary,
  locale,
  now,
  onOpen,
  onMarkRead,
}: {
  row: InboxRow
  /** A muted Agent's row, whose dot claims no status color. */
  quiet: boolean
  dictionary: Dictionary
  locale: Locale
  now: Date
  onOpen: () => void
  /** Receives Mark read itself, so focus can move on from where it was. */
  onMarkRead: (from: HTMLElement) => void
}) {
  const copy = dictionary.activity
  const { before, after, title, more, summary } = rowCopy(row, dictionary)
  return (
    <li className={styles.row}>
      <button
        className={styles.open}
        type="button"
        data-activity-row={row.key}
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
            {/* The navigation rows' one dot, decorative like theirs; a muted
                Agent's row keeps it neutral. */}
            {quiet ? (
              <QuietDot label={copy.mutedGroup} />
            ) : row.state === "waiting" || row.state === "failed" ? (
              <StatusDot
                status={
                  row.state === "waiting" ? "waiting-for-input" : "failed"
                }
                label={
                  row.state === "waiting"
                    ? copy.waitingForInput
                    : copy.turnFailed
                }
              />
            ) : (
              <UnreadDot label={dictionary.status.unread} />
            )}
          </span>
          {title ? (
            <span className={styles.rowTitle}>
              <bdi>{title}</bdi>
            </span>
          ) : null}
          {row.request ? (
            <span className={styles.rowRequest}>
              <bdi>{row.request.text}</bdi>
              {more ? ` ${more}` : null}
            </span>
          ) : null}
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
          aria-label={`${copy.markRead}: ${[row.agent.name, title].filter(Boolean).join(", ")}`}
          onClick={(event) => onMarkRead(event.currentTarget)}
        >
          <Check />
        </Button>
      )}
    </li>
  )
}
