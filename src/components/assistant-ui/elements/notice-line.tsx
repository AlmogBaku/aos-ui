"use client"

import { makeAssistantDataUI } from "@assistant-ui/react"
import { HeartPulse, Info, Repeat, Target, Terminal } from "lucide-react"

import { useToolUiLocale } from "@/components/tool-ui/locale"
import { SystemNotice } from "@/components/ui/system-notice"
import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import { NOTICE_DATA_PART_NAME, noticeSchema } from "@/lib/message-parts"

const KIND_ICONS = {
  goal: Target,
  loop: Repeat,
  heartbeat: HeartPulse,
  process: Terminal,
  status: Info,
} as const

type NoticeKind = keyof typeof KIND_ICONS

function noticeKind(kind: string | undefined): NoticeKind {
  return kind && kind in KIND_ICONS ? (kind as NoticeKind) : "status"
}

/**
 * A status the runtime announces while a turn runs, such as a heartbeat or a
 * loop wakeup. It is the runtime speaking, not the Agent, so an ordinary one
 * reads as one muted line in the trace; a warning or error is a System Notice.
 */
export function NoticeLine({ data }: { data: unknown }) {
  const { locale } = useToolUiLocale()
  const parsed = noticeSchema.safeParse(data)
  if (!parsed.success) return null
  const { severity, title, description } = parsed.data

  if (severity !== "info")
    return (
      <SystemNotice
        tone={severity}
        title={title}
        {...(description ? { detail: description } : {})}
        locale={locale}
        className="my-2"
      />
    )

  const kind = noticeKind(parsed.data.kind)
  const Icon = KIND_ICONS[kind]
  const label = (locale === "he" ? he : en).notice.kinds[kind]
  return (
    <div
      role="status"
      className="my-1.5 flex items-start gap-2 px-2 text-xs leading-5 text-muted-foreground"
    >
      <Icon
        role="img"
        aria-label={label}
        className="mt-0.5 size-3.5 shrink-0"
      />
      <p dir="auto" className="min-w-0">
        {title}
        {description && <span className="block">{description}</span>}
      </p>
    </div>
  )
}

export const NoticeDataUI = makeAssistantDataUI<unknown>({
  name: NOTICE_DATA_PART_NAME,
  render: NoticeLine,
})
