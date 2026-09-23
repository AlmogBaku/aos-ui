"use client"

import { makeAssistantDataUI } from "@assistant-ui/react"
import { useState, type ReactNode } from "react"
import { z } from "zod"

import { useToolUiLocale } from "@/components/tool-ui/locale"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { SystemNotice } from "@/components/ui/system-notice"
import { en } from "@/lib/i18n/dictionaries/en"
import { he } from "@/lib/i18n/dictionaries/he"
import { collapsePanel, ShimmerLabel } from "@/lib/surfaces"
import { cn } from "@/lib/utils"
import { DisclosureChevron } from "./disclosure-chevron"

/** The data part a runtime emits while it compacts the Session's context. */
export const COMPACTION_DATA_PART_NAME = "aos-compaction"

const compactionSchema = z.object({
  compactionId: z.string(),
  status: z.enum(["started", "completed", "failed"]),
  summary: z.string().optional(),
  error: z.string().optional(),
})

export type AosCompaction = z.infer<typeof compactionSchema>

const DIVIDER =
  "my-3 flex w-full items-center gap-3 text-xs leading-4 text-muted-foreground"

function Divider({ children }: { children: ReactNode }) {
  return (
    <div className={DIVIDER}>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      {children}
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  )
}

/**
 * Compaction is the runtime tidying the Session, not the Agent's work, so it
 * reads as a quiet divider between the turns it separates, outside any fold.
 * Its summary stays one disclosure away; a failure is AOS speaking.
 */
export function CompactionDivider({ data }: { data: unknown }) {
  const { locale } = useToolUiLocale()
  const [open, setOpen] = useState(false)
  const labels = (locale === "he" ? he : en).compaction
  const parsed = compactionSchema.safeParse(data)
  if (!parsed.success) return null
  const { status, summary, error } = parsed.data

  if (status === "failed")
    return (
      <SystemNotice
        tone="warning"
        title={labels.failed}
        {...(error ? { detail: error } : {})}
        locale={locale}
        className="my-2"
      />
    )

  if (status === "started")
    return (
      <div role="status">
        <Divider>
          <ShimmerLabel>{labels.running}</ShimmerLabel>
        </Divider>
      </div>
    )

  if (!summary)
    return (
      <Divider>
        <span>{labels.completed}</span>
      </Divider>
    )

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <Divider>
        <CollapsibleTrigger className="group/trigger flex items-center gap-1 rounded-md transition-colors hover:text-foreground/90">
          <span>{labels.completed}</span>
          <DisclosureChevron className="opacity-60" />
        </CollapsibleTrigger>
      </Divider>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        <p
          dir="auto"
          className="mx-2 mb-3 text-sm whitespace-pre-wrap text-muted-foreground"
        >
          {summary}
        </p>
      </CollapsibleContent>
    </Collapsible>
  )
}

export const CompactionDataUI = makeAssistantDataUI<unknown>({
  name: COMPACTION_DATA_PART_NAME,
  render: CompactionDivider,
})
