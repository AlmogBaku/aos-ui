"use client"

import type { Dictionary } from "@/lib/i18n/dictionary"
import type { Locale } from "@/lib/i18n/config"
import type {
  BrowserPreferences,
  BrowserPermission,
} from "@/lib/notifications/policy"
import type {
  ActivityNoticeState,
  ActivityView,
} from "./use-activity-coordinator"
import { useId, useState } from "react"
import { Bell, BellDot, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  needsAttention,
  type ActivityRecord,
} from "@/lib/notifications/activity"
import styles from "./activity.module.css"

export type BrowserSettingsView = {
  status: BrowserPermission | "not-configured"
  coverage: "workspace" | "active-session" | "unavailable"
  preferences: BrowserPreferences
  onEnabledChange: (enabled: boolean) => void
  onCategoryChange: (
    category: "completion" | "failure" | "input",
    enabled: boolean
  ) => void
}
export function ActivityBell({
  dictionary,
  unread,
  open,
  onOpen,
}: {
  dictionary: Dictionary
  unread: number
  open: boolean
  onOpen: () => void
}) {
  return (
    <Button
      className={styles.bell}
      variant="ghost"
      size="icon"
      type="button"
      aria-label={`${dictionary.activity.title}, ${unread} ${dictionary.activity.unread}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onOpen}
    >
      <Bell />
      {unread > 0 ? (
        <span className={styles.count} aria-hidden="true">
          {unread > 9 ? "9+" : unread}
        </span>
      ) : null}
    </Button>
  )
}

export function activityLabel(record: ActivityRecord, dictionary: Dictionary) {
  const copy = dictionary.activity
  switch (record.type) {
    case "run-finished":
      return copy.runFinished
    case "run-failed":
      return copy.runFailed
    case "attention-requested":
      return copy.inputRequested
    case "agent-ready":
      return copy.agentReady
    case "agent-activation-failed":
      return copy.activationFailed
  }
}

export function AttentionDot({ label }: { label: string }) {
  return (
    <span
      className={styles.attentionDot}
      title={label}
      aria-hidden="true"
    />
  )
}

export function ActivityMarker({
  unread,
  attention,
  dictionary,
}: {
  unread: number
  attention: boolean
  dictionary: Dictionary
}) {
  if (!unread && !attention) return null
  return (
    <span className={styles.marker}>
      {attention ? (
        <AttentionDot label={dictionary.activity.needsAttention} />
      ) : (
        <BellDot aria-hidden="true" />
      )}
      <span className="sr-only">
        {attention
          ? dictionary.activity.needsAttention
          : `${unread} ${dictionary.activity.unread}`}
      </span>
    </span>
  )
}

export function ActivityPanel({
  activity,
  locale,
  dictionary,
  onOpened,
  settings,
}: {
  activity?: ActivityView
  locale: Locale
  dictionary: Dictionary
  onOpened: () => void
  settings?: BrowserSettingsView
}) {
  const copy = dictionary.activity
  const prefix = useId()
  const [opening, setOpening] = useState<string | null>(null)
  const items = activity?.items ?? []
  const sections = [
    {
      title: copy.needsAttention,
      empty: copy.emptyAttention,
      items: items.filter((item) => item.available && needsAttention(item)),
    },
    {
      title: copy.earlier,
      empty: copy.emptyEarlier,
      items: items.filter((item) => !item.available || !needsAttention(item)),
    },
  ]
  const formatter = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
  return (
    <div className={styles.panel}>
      <div className={styles.heading}>
        <h2>{copy.title}</h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={!items.some((item) => !item.read)}
          onClick={() => activity?.markAllRead()}
        >
          {copy.markAllRead}
        </Button>
      </div>
      {activity?.error ? (
        <p role="status" className={styles.explanation}>
          {copy.connectionError}
        </p>
      ) : null}
      {activity && !activity.supported ? (
        <p className={styles.explanation}>{copy.activityUnavailable}</p>
      ) : null}
      {sections.map((section, index) => (
        <section
          className={styles.section}
          key={section.title}
          aria-labelledby={`${prefix}-${index}`}
        >
          <h3 id={`${prefix}-${index}`}>{section.title}</h3>
          {section.items.length ? (
            <ul className={styles.list}>
              {section.items.map((item) => {
                const agent = item.agentName ?? copy.agentFallback
                const session = item.sessionTitle ?? copy.sessionFallback
                return (
                  <li key={item.id} className={styles.item}>
                    <div className={styles.itemHeading}>
                      <p>{activityLabel(item, dictionary)}</p>
                      <ActivityMarker
                        unread={item.read ? 0 : 1}
                        attention={item.available && needsAttention(item)}
                        dictionary={dictionary}
                      />
                    </div>
                    <p className={styles.target}>
                      <bdi>{agent}</bdi>
                      <span aria-hidden="true"> / </span>
                      <bdi>{session}</bdi>
                    </p>
                    {!item.available ? (
                      <p className={styles.explanation}>{copy.unavailable}</p>
                    ) : item.resolved ? (
                      <p className={styles.explanation}>{copy.resolved}</p>
                    ) : null}
                    <div className={styles.itemFooter}>
                      <time dateTime={item.occurredAt}>
                        {formatter.format(new Date(item.occurredAt))}
                      </time>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={opening !== null}
                        aria-label={`${copy.open}: ${agent}, ${session}`}
                        onClick={async () => {
                          setOpening(item.id)
                          try {
                            if (await activity?.openActivity(item.id))
                              onOpened()
                          } finally {
                            setOpening(null)
                          }
                        }}
                      >
                        {copy.open}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className={styles.explanation}>{section.empty}</p>
          )}
        </section>
      ))}
      <details className={styles.settings}>
        <summary>{copy.settings}</summary>
        <ActivitySettings dictionary={dictionary} settings={settings} />
      </details>
    </div>
  )
}

export function ActivityNotice({
  notice,
  dictionary,
  onDismiss,
}: {
  notice: ActivityNoticeState | null
  dictionary: Dictionary
  onDismiss: () => void
}) {
  if (!notice) return null
  return (
    <div className={styles.notice} data-activity-notice="true">
      <p role={notice.urgent ? "alert" : "status"} aria-atomic="true">
        {notice.urgent
          ? dictionary.activity.urgentNotice
          : dictionary.activity.routineNotice}{" "}
        <span className={styles.noticeCount}>({notice.count})</span>
      </p>
      <Button
        variant="ghost"
        size="icon"
        aria-label={dictionary.activity.dismiss}
        onClick={onDismiss}
      >
        <X />
      </Button>
    </div>
  )
}

export function ActivitySettings({
  dictionary,
  settings,
}: {
  dictionary: Dictionary
  settings?: BrowserSettingsView
}) {
  const copy = dictionary.activity
  const status = settings?.status ?? "not-configured"
  const disabled =
    status === "not-configured" ||
    status === "unsupported" ||
    status === "denied" ||
    settings?.coverage === "unavailable"
  const explanation = {
    "not-configured": copy.notConfigured,
    unsupported: copy.unsupported,
    denied: copy.permissionDenied,
    default: copy.permissionDefault,
    granted: copy.permissionGranted,
  }[status]
  return (
    <div className={styles.settingsBody}>
      <p className={styles.explanation}>{copy.liveTab}</p>
      <label className={styles.setting}>
        <input
          type="checkbox"
          checked={settings?.preferences.enabled ?? false}
          disabled={disabled}
          onChange={(event) => settings?.onEnabledChange(event.target.checked)}
        />
        {copy.browserNotifications}
      </label>
      <p className={styles.explanation}>{explanation}</p>
      {settings?.coverage === "active-session" ? (
        <p className={styles.explanation}>{copy.activeSessionOnly}</p>
      ) : null}
      {(["completion", "failure", "input"] as const).map((category) => (
        <label className={styles.setting} key={category}>
          <input
            type="checkbox"
            checked={settings?.preferences[category] ?? true}
            disabled={disabled}
            onChange={(event) =>
              settings?.onCategoryChange(category, event.target.checked)
            }
          />
          {copy[category]}
        </label>
      ))}
    </div>
  )
}
