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
import { useId, useLayoutEffect, useRef, useState } from "react"
import { ArrowLeft, Bell, SlidersHorizontal, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { attentionLabels, type AttentionLevel } from "@/lib/attention-level"
import type { Inbox, InboxRow } from "@/lib/notifications/inbox"
import { ActivityRow, rowCopy } from "./activity-row"
import { AttentionBadge } from "./attention-badge"
import styles from "./activity.module.css"

export type BrowserSettingsView = {
  status: BrowserPermission | "not-configured"
  coverage: "workspace" | "active-session" | "unavailable"
  preferences: BrowserPreferences
  /** True while the one-time ask is due on this device. */
  ask: boolean
  /** True while this device receives alerts through Web Push. */
  pushActive: boolean
  push: "available" | "insecure-context" | "not-configured" | "unsupported"
  installable: boolean
  iosInstallHint: boolean
  onEnabledChange: (enabled: boolean) => void
  onCategoryChange: (
    category: "completion" | "failure" | "input",
    enabled: boolean
  ) => void
  onSoundChange: (enabled: boolean) => void
  onAcceptAsk: () => void
  onDeclineAsk: () => void
  onInstall: () => void
}
export function ActivityBell({
  dictionary,
  attention,
  ring,
  open,
  onOpen,
}: {
  dictionary: Dictionary
  attention: AttentionLevel
  /** Each new value swings the bell once; the value it mounts with does not. */
  ring: number
  open: boolean
  onOpen: () => void
}) {
  const [mountedRing] = useState(ring)
  return (
    <Button
      className={styles.bell}
      variant="ghost"
      size="icon"
      type="button"
      aria-label={[
        dictionary.activity.title,
        ...attentionLabels(attention, dictionary.activity),
      ].join(", ")}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onOpen}
    >
      {/* A new key restarts the one-shot swing from the start. */}
      <Bell
        key={ring}
        className={ring === mountedRing ? undefined : styles.ringing}
      />
      {/* The bell counts and never runs, so it has no running dot. */}
      {attention.count ? (
        <AttentionBadge
          level={attention}
          runningLabel={dictionary.status.running}
        />
      ) : null}
    </Button>
  )
}

const emptyInbox: Inbox = { waiting: [], unread: [], muted: [] }

/**
 * The Sessions that need the operator, one row each, waiting ones first. The
 * notification settings take the drawer's body in its place, behind Back.
 */
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
  const [opening, setOpening] = useState(false)
  // Each step in or out moves focus, as the phone drawer's levels do: to the
  // settings heading, then back to the button that opened them.
  const [view, setView] = useState({ settings: false, moved: false })
  const settingsButton = useRef<HTMLButtonElement>(null)
  const settingsHeading = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => {
    if (view.moved)
      (view.settings ? settingsHeading : settingsButton).current?.focus()
  }, [view])
  const inbox = activity?.inbox ?? emptyInbox
  // The inbox's times are relative to the clock that comes with it; with no
  // activity there are no rows to date.
  const now = activity?.readNow()
  // A row already waiting when the drawer opened is not news; each one that
  // arrives while it is open is announced, once. Adjusting state from the
  // previous render keeps the rows already announced.
  const [announced, setAnnounced] = useState(() => ({
    seen: new Set(inbox.waiting.map(({ key }) => key)),
    text: "",
  }))
  const arrivals = inbox.waiting.filter(({ key }) => !announced.seen.has(key))
  if (arrivals.length)
    setAnnounced({
      seen: new Set([...announced.seen, ...arrivals.map(({ key }) => key)]),
      text: arrivals.map((row) => rowCopy(row, dictionary).summary).join(". "),
    })
  const groups = [
    { title: copy.waitingGroup, rows: inbox.waiting, quiet: false },
    { title: copy.unreadGroup, rows: inbox.unread, quiet: false },
    { title: copy.mutedGroup, rows: inbox.muted, quiet: true },
  ].filter(({ rows }) => rows.length)
  // Only answering clears a waiting Session, muted or not.
  const markable =
    inbox.unread.length > 0 ||
    inbox.muted.some(({ state }) => state !== "waiting")

  const open = (row: InboxRow) => {
    if (opening) return
    setOpening(true)
    void Promise.resolve(activity?.openRow(row))
      .then((opened) => {
        if (opened) onOpened()
      })
      .finally(() => setOpening(false))
  }
  /** The row leaves once the provider says so; focus moves on before it does. */
  const markRead = (row: InboxRow, from: HTMLElement) => {
    const panel = from.closest<HTMLElement>("[data-activity-panel]")
    const rows = [
      ...(panel?.querySelectorAll<HTMLElement>("[data-activity-row]") ?? []),
    ]
    const index = rows.findIndex(
      (element) => element.dataset.activityRow === row.key
    )
    ;(
      rows[index + 1] ??
      rows[index - 1] ??
      panel?.querySelector<HTMLElement>("h2")
    )?.focus()
    activity?.markRowRead(row)
  }

  return (
    <div className={styles.panel} data-activity-panel>
      {view.settings ? (
        <div className={styles.heading}>
          <Button
            className={styles.back}
            variant="ghost"
            size="icon-sm"
            aria-label={copy.backToActivity}
            onClick={() => setView({ settings: false, moved: true })}
          >
            <ArrowLeft />
          </Button>
          <h2 ref={settingsHeading} tabIndex={-1}>
            {copy.settings}
          </h2>
        </div>
      ) : (
        <div className={styles.heading}>
          <h2 tabIndex={-1}>{copy.title}</h2>
          {/* Only answering clears a waiting Session, so only unread rows enable it. */}
          <Button
            variant="ghost"
            size="sm"
            disabled={!markable}
            onClick={() => activity?.markAllRead()}
          >
            {copy.markAllRead}
          </Button>
          <Button
            ref={settingsButton}
            variant="ghost"
            size="icon-sm"
            aria-label={copy.settings}
            onClick={() => setView({ settings: true, moved: true })}
          >
            <SlidersHorizontal />
          </Button>
        </div>
      )}
      <div className={styles.body}>
        {/* Mounted empty, so the arrival is what gets announced. */}
        <p role="status" className="sr-only">
          {announced.text}
        </p>
        {view.settings ? (
          <div className={styles.settings}>
            <ActivitySettings dictionary={dictionary} settings={settings} />
          </div>
        ) : (
          <>
            {activity?.error ? (
              <p role="status" className={styles.explanation}>
                {copy.connectionError}
              </p>
            ) : null}
            {activity && !activity.supported ? (
              <p className={styles.explanation}>{copy.activityUnavailable}</p>
            ) : null}
            {now && groups.length ? (
              groups.map((group, index) => (
                <section
                  className={styles.group}
                  key={group.title}
                  aria-labelledby={`${prefix}-${index}`}
                >
                  <h3 id={`${prefix}-${index}`}>
                    {group.title}{" "}
                    <span className={styles.groupCount}>
                      {group.rows.length}
                    </span>
                  </h3>
                  <ul className={styles.rows}>
                    {group.rows.map((row) => (
                      <ActivityRow
                        key={row.key}
                        row={row}
                        quiet={group.quiet}
                        dictionary={dictionary}
                        locale={locale}
                        now={now}
                        onOpen={() => open(row)}
                        onMarkRead={(from) => markRead(row, from)}
                      />
                    ))}
                  </ul>
                </section>
              ))
            ) : (
              <div className={styles.empty}>
                <p>{copy.emptyTitle}</p>
                <p className={styles.explanation}>{copy.emptyDetail}</p>
              </div>
            )}
          </>
        )}
      </div>
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

/** The one-time offer to turn OS alerts on, banner-style above the conversation. */
export function ActivityAsk({
  dictionary,
  settings,
}: {
  dictionary: Dictionary
  settings?: BrowserSettingsView
}) {
  const copy = dictionary.activity
  const headingId = useId()
  if (!settings?.ask) return null
  // iOS only exposes notifications to an installed app, so there is nothing
  // this browser could be asked for yet.
  const installFirst = settings.iosInstallHint && !("Notification" in window)
  return (
    <section className={styles.ask} aria-labelledby={headingId}>
      <div className={styles.askText}>
        <h2 id={headingId} className={styles.askTitle}>
          {copy.askTitle}
        </h2>
        {installFirst ? (
          <p className={styles.explanation}>{copy.pushIosHint}</p>
        ) : settings.push === "available" ? (
          <p className={styles.explanation}>{copy.askClosed}</p>
        ) : null}
      </div>
      {/* Nothing can be turned on before the install, but the ask must still be
          answerable or it would never leave. */}
      <div className={styles.askActions}>
        {installFirst ? null : (
          <Button size="sm" onClick={settings.onAcceptAsk}>
            {copy.askAccept}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={settings.onDeclineAsk}>
          {copy.askDecline}
        </Button>
      </div>
    </section>
  )
}

/**
 * What alerts while AOS is closed actually are for *this* device: what the
 * deployment offers is only one of the conditions, and a line that claims more
 * than the browser will do is worse than no line at all.
 */
function closedAppState(
  copy: Dictionary["activity"],
  settings?: BrowserSettingsView
) {
  if (settings?.iosInstallHint) return copy.pushIosHint
  // A blocked site is shown no notification at all, pushed or not. The master
  // status line above already says how to unblock, so this one only states it.
  if (settings?.status === "denied") return copy.pushBlocked
  switch (settings?.push ?? "not-configured") {
    case "insecure-context":
      return copy.pushInsecure
    case "unsupported":
      return copy.pushUnsupported
    case "not-configured":
      return copy.pushNotConfigured
    case "available":
      return settings?.pushActive ? copy.pushOn : copy.pushNotYet
  }
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
  const unavailable = settings?.coverage === "unavailable"
  const disabled =
    status === "not-configured" ||
    status === "unsupported" ||
    status === "denied" ||
    unavailable
  const explanation = {
    "not-configured": copy.notConfigured,
    unsupported: copy.unsupported,
    denied: copy.permissionDenied,
    granted: copy.permissionGranted,
    // A device that has not been asked yet is described by the ask itself.
    default: undefined,
  }[status]
  const whenClosed = closedAppState(copy, settings)
  return (
    <div className={styles.settingsBody}>
      <label className={styles.setting}>
        <input
          type="checkbox"
          checked={settings?.preferences.enabled ?? false}
          disabled={disabled}
          onChange={(event) => settings?.onEnabledChange(event.target.checked)}
        />
        {copy.browserNotifications}
      </label>
      {explanation ? <p className={styles.explanation}>{explanation}</p> : null}
      {settings?.coverage === "active-session" ? (
        <p className={styles.explanation}>{copy.activeSessionOnly}</p>
      ) : null}
      <p role="status" className={styles.explanation}>
        {copy.whenClosed}: {whenClosed}
      </p>
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
      <label className={styles.setting}>
        <input
          type="checkbox"
          checked={settings?.preferences.sound ?? true}
          disabled={unavailable}
          onChange={(event) => settings?.onSoundChange(event.target.checked)}
        />
        {copy.sound}
      </label>
      {/* The Home Screen hint is already the line above, so only an installable
          browser adds anything here. */}
      {settings?.installable ? (
        <Button
          className={styles.install}
          variant="outline"
          size="sm"
          onClick={settings.onInstall}
        >
          {copy.install}
        </Button>
      ) : null}
    </div>
  )
}
