import type { ReactNode } from "react"

import type { Locale } from "@/lib/i18n/config"

const statusCopy = {
  en: {
    reconnecting: "Reconnecting to AOS…",
    reconnected: "Reconnected",
    capacity: "The AOS server is full. Reconnecting shortly.",
    sessionUnavailable: "This Session is no longer available.",
  },
  he: {
    reconnecting: "מתחברים מחדש ל-AOS…",
    reconnected: "החיבור חזר",
    capacity: "שרת AOS מלא כרגע. מתחברים מחדש בקרוב.",
    sessionUnavailable: "השיחה הזו כבר אינה זמינה.",
  },
} satisfies Record<Locale, Record<string, string>>

/**
 * The snackbar over a conversation: the connection's outage, or its recovery
 * for a moment, which outranks the selected Session's own status. The
 * conversation stays mounted beneath it.
 */
export function WorkspaceStatusNotice({
  locale,
  connectionStatus,
  sessionStatus,
  children,
}: {
  locale: Locale
  connectionStatus?: "reconnecting" | "capacity" | "reconnected"
  sessionStatus?: "unavailable"
  children: ReactNode
}) {
  const copy = statusCopy[locale]
  const text = connectionStatus
    ? copy[connectionStatus]
    : sessionStatus === "unavailable"
      ? copy.sessionUnavailable
      : null
  return (
    <div className="relative h-full min-h-0">
      {/* Mounted empty so the text is announced when it appears. */}
      <p
        className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4"
        role="status"
      >
        {text ? (
          <span className="rounded-full border border-border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md">
            {text}
          </span>
        ) : null}
      </p>
      {children}
    </div>
  )
}
