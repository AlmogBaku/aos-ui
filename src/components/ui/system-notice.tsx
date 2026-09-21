import { CircleAlert, Info, TriangleAlert } from "lucide-react"
import { useId, type ReactNode } from "react"

import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import type { Locale } from "@/lib/i18n/config"

export type SystemNoticeTone = "error" | "warning" | "info"

/**
 * Tones reuse the workspace's own semantic roles: destructive for a failure,
 * the attention color for something the operator should notice, and neutral for
 * a plain limit. No tone introduces a color of its own.
 */
const TONES = {
  error: { Icon: CircleAlert, accent: "border-s-destructive text-destructive" },
  warning: { Icon: TriangleAlert, accent: "border-s-warning text-warning" },
  info: {
    Icon: Info,
    accent: "border-s-muted-foreground text-muted-foreground",
  },
} as const

/**
 * How AOS or a provider speaks to the operator about a failure or an
 * unavailable output. It is deliberately a system panel and not message prose:
 * the source label names AOS first, so nothing here reads as the Agent's words.
 * Actions that can still succeed belong in `children`.
 */
export function SystemNotice({
  tone,
  title,
  detail,
  locale,
  children,
  className = "",
}: {
  tone: SystemNoticeTone
  title: string
  detail?: string
  locale: Locale
  children?: ReactNode
  className?: string
}) {
  const sourceId = useId()
  const titleId = useId()
  const { Icon, accent } = TONES[tone]

  return (
    <div
      data-slot="system-notice"
      role={tone === "error" ? "alert" : "status"}
      aria-labelledby={`${sourceId} ${titleId}`}
      dir={locale === "he" ? "rtl" : "ltr"}
      className={`flex max-w-full items-start gap-2.5 rounded-lg border border-s-2 border-border bg-muted/40 px-3 py-2.5 text-start ${accent} ${className}`}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 text-foreground">
        <p
          id={sourceId}
          className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
        >
          {(locale === "he" ? he : en).productName}
        </p>
        <p id={titleId} className="mt-0.5 text-sm">
          {title}
        </p>
        {detail && (
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">
            {detail}
          </p>
        )}
        {children && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {children}
          </div>
        )}
      </div>
    </div>
  )
}
