"use client"

import { useToolUiLocale } from "@/components/tool-ui/locale"
import { SystemNotice } from "@/components/ui/system-notice"

/** A view that cannot show, with why when the host knows. */
export function AppUnavailable({ detail }: { detail?: string }) {
  const { labels, locale } = useToolUiLocale()
  return (
    <SystemNotice
      tone="warning"
      title={labels.mcpApp.unavailable}
      detail={detail}
      locale={locale}
    />
  )
}
