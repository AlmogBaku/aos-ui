"use client"

import { useAuiState, type AssistantState } from "@assistant-ui/react"
import { LoaderCircle } from "lucide-react"
import { useMemo, useState } from "react"

import { DisclosureChevron } from "@/components/assistant-ui/elements/disclosure-chevron"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { readAosToolArtifact } from "@/lib/tool-artifact"
import { collapsePanel } from "@/lib/surfaces"

import { ActivityTool, subagentActivityPayload } from "./activity"
import { useToolUiLocale, type ToolUiActivityStatus } from "./locale"
import { SubagentCounts, SubagentList, subagentCounts } from "./subagent-group"
import {
  callStatusIn,
  childStatusOf,
  findEntry,
  isActiveStatus,
} from "./subagent-status"
import type { RichToolPart } from "./types"

type StripEntry = { readonly id: string; readonly status: ToolUiActivityStatus }

/**
 * The subagents of every turn with a child still at work or waiting, as ids
 * and states only, so the strip re-renders when one of those changes and not
 * on every streamed word.
 */
function createStripSelector() {
  let previous: readonly StripEntry[] = []
  return (state: AssistantState) => {
    const next = state.thread.messages.flatMap((message) => {
      const entries = message.content.flatMap((part) => {
        if (part.type !== "tool-call") return []
        const subagent = readAosToolArtifact(part.artifact)?.subagent
        if (!subagent) return []
        const status = childStatusOf({
          ...part,
          status: callStatusIn(message, part),
        })
        return [{ id: part.toolCallId, status }]
      })
      return entries.some(({ status }) => isActiveStatus(status)) ? entries : []
    })
    const same =
      next.length === previous.length &&
      next.every(
        (entry, index) =>
          entry.id === previous[index]?.id &&
          entry.status === previous[index]?.status
      )
    if (!same) previous = next
    return previous
  }
}

const NOOP = () => {}

/** A running subagent's row, read from the thread, with no request to answer. */
function StripRow({ toolCallId }: { toolCallId: string }) {
  const entry = useAuiState((state) =>
    findEntry(state.thread.messages, toolCallId)
  )
  const subagent = readAosToolArtifact(entry?.artifact)?.subagent
  if (!entry || !subagent) return null
  const part: RichToolPart = {
    ...entry,
    status: { type: "running" },
    addResult: NOOP,
    resume: NOOP,
    respondToApproval: async () => {},
  }
  return (
    <ActivityTool
      part={part}
      payload={subagentActivityPayload(entry, subagent)}
      kind="subagent"
      subagent={subagent}
      requests={false}
    />
  )
}

/**
 * One line above the composer while a subagent runs or waits, its turn ended
 * or not, counting the children of the turns still at work. Opened, it lists
 * the running rows, each opening its transcript in the side panel.
 */
export function SubagentStrip() {
  const select = useMemo(() => createStripSelector(), [])
  const entries = useAuiState(select)
  const { direction, labels, locale } = useToolUiLocale()
  const [open, setOpen] = useState(false)
  const active = entries.filter(({ status }) => isActiveStatus(status))
  if (active.length === 0) return null
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="overflow-hidden rounded-2xl border border-border bg-card @min-[64rem]/workspace:mx-auto @min-[64rem]/workspace:w-full @min-[64rem]/workspace:max-w-(--thread-content-max-width)"
      role="region"
      aria-label={labels.subagentGroup.running}
      dir={direction}
      lang={locale}
    >
      <CollapsibleTrigger className="group/trigger flex min-h-9 w-full items-center gap-2 px-3.5 py-2 text-start text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11">
        <LoaderCircle
          aria-hidden="true"
          className="size-3.5 shrink-0 motion-safe:animate-spin"
        />
        {/* Alone above the composer, the line names what it counts. */}
        <span className="font-medium whitespace-nowrap text-foreground">
          {labels.subagentGroup.title(entries.length)}
        </span>
        <span aria-hidden="true">·</span>
        <SubagentCounts
          counts={subagentCounts(
            entries.map(({ status }) => status),
            labels
          )}
        />
        <DisclosureChevron className="ms-auto" />
      </CollapsibleTrigger>
      <CollapsibleContent className={collapsePanel}>
        <SubagentList className="rounded-none border-0 border-t">
          {active.map(({ id }) => (
            <li key={id}>
              <StripRow toolCallId={id} />
            </li>
          ))}
        </SubagentList>
      </CollapsibleContent>
    </Collapsible>
  )
}
