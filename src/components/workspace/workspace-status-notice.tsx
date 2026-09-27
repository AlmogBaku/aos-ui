import type { ReactNode } from "react"

import type { Locale } from "@/lib/i18n/config"

const statusCopy = {
  en: {
    reconnecting: "Reconnecting to AOS…",
    capacity: "The AOS server is full. Reconnecting shortly.",
    sessionUnavailable: "This Session is no longer available.",
  },
  he: {
    reconnecting: "מתחברים מחדש ל-AOS…",
    capacity: "שרת AOS מלא כרגע. מתחברים מחדש בקרוב.",
    sessionUnavailable: "השיחה הזו כבר אינה זמינה.",
  },
} satisfies Record<Locale, Record<string, string>>

/**
 * The status line over a conversation: the connection's outage, which
 * outranks the selected Session's own status.
 */
export function WorkspaceStatusNotice({
  locale,
  connectionStatus,
  sessionStatus,
  children,
}: {
  locale: Locale
  connectionStatus?: "reconnecting" | "capacity"
  sessionStatus?: "unavailable"
  children: ReactNode
}) {
  const copy = statusCopy[locale]
  return (
    <div className="relative h-full min-h-0">
      {/* Mounted empty so the text is announced when it appears. */}
      <p
        className="pointer-events-none absolute inset-x-0 top-2 z-10 px-4 text-center text-sm text-muted-foreground"
        role="status"
      >
        {connectionStatus
          ? copy[connectionStatus]
          : sessionStatus === "unavailable"
            ? copy.sessionUnavailable
            : null}
      </p>
      {children}
    </div>
  )
}
