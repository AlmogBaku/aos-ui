import {
  Check,
  CircleAlert,
  Clock3,
  ExternalLink,
  LoaderCircle,
} from "lucide-react"
import { MessagePartPrimitive, MessagePrimitive } from "@assistant-ui/react"
import { z } from "zod"

import { cn } from "@/lib/utils"

import { normalizeRichToolState } from "./lifecycle"
import {
  useToolUiLocale,
  type ToolUiActivityKind,
  type ToolUiActivityStatus,
} from "./locale"
import { openSessionLinkInPlace, useToolUiSessionLink } from "./session-link"
import type { AosSubagent } from "./tool-artifact"
import { formatToolDuration } from "./tool-call-presentation"
import type { RichToolPart } from "./types"

const activityStatusSchema = z.enum([
  "running",
  "waiting",
  "completed",
  "failed",
])

/** The provider-neutral shape every delegated activity call arrives in. */
export const activityPayloadSchema = z
  .object({
    args: z
      .object({
        task: z.string().optional(),
        name: z.string().optional(),
        skill: z.string().optional(),
        description: z.string().optional(),
      })
      .refine(
        (args) =>
          Boolean(args.task ?? args.name ?? args.skill ?? args.description),
        "Activity requires a task, name, skill, or description"
      ),
    result: z
      .object({
        name: z.string().optional(),
        status: activityStatusSchema.optional(),
        summary: z.string().optional(),
        transcript: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export type ActivityPayload = z.infer<typeof activityPayloadSchema>
export type ActivityChildStatus = z.infer<typeof activityStatusSchema>

/**
 * The activity payload of a call known only by its subagent metadata: its
 * validated args and result when they fit, and the subagent's goal otherwise.
 */
export function subagentActivityPayload(
  part: RichToolPart,
  subagent: AosSubagent
): ActivityPayload {
  const parsed = activityPayloadSchema.safeParse({
    args: part.args,
    result: part.result,
  })
  return parsed.success
    ? parsed.data
    : { args: { task: subagent.goal ?? part.toolName } }
}

export function ActivityTool({
  part,
  payload,
  kind,
  subagent,
}: {
  part: RichToolPart
  payload: ActivityPayload
  kind: ToolUiActivityKind
  /** ACP subagent metadata; its goal, status, and counts lead when present. */
  subagent?: AosSubagent
}) {
  const state = normalizeRichToolState(part)
  const { direction, labels, locale } = useToolUiLocale()
  const sessionLink = useToolUiSessionLink(subagent?.childSessionId)
  const kindLabel = labels.activities[kind]
  const title =
    subagent?.goal ??
    payload.result?.name ??
    payload.args.name ??
    payload.args.skill ??
    payload.args.task ??
    payload.args.description ??
    kindLabel
  const summary = payload.result?.summary
  const childStatus =
    subagentStatus(subagent?.status) ?? getChildStatus(payload, state.phase)
  const headerFacts = subagent
    ? [
        subagent.model ? labels.subagent.model(subagent.model) : undefined,
        subagent.depth === undefined
          ? undefined
          : labels.subagent.depth(subagent.depth),
      ].filter((fact): fact is string => fact !== undefined)
    : []
  const footerFacts = subagent
    ? [
        subagent.tokens === undefined
          ? undefined
          : labels.subagent.tokens(
              new Intl.NumberFormat(locale, { notation: "compact" }).format(
                subagent.tokens
              )
            ),
        subagent.durationMs === undefined
          ? undefined
          : labels.subagent.duration(
              formatToolDuration(subagent.durationMs, labels.assistant.duration)
            ),
        subagent.filesRead?.length
          ? labels.subagent.filesRead(subagent.filesRead.length)
          : undefined,
        subagent.filesWritten?.length
          ? labels.subagent.filesWritten(subagent.filesWritten.length)
          : undefined,
      ].filter((fact): fact is string => fact !== undefined)
    : []
  const transcript = payload.result?.transcript
  const hasNestedMessages = Boolean(part.messages?.length)
  const transcriptIsLoading =
    !hasNestedMessages &&
    !transcript &&
    (childStatus === "running" || childStatus === "waiting")
  const showTranscript =
    hasNestedMessages || Boolean(transcript) || transcriptIsLoading

  return (
    <section
      className="mt-3 w-full max-w-2xl rounded-xl border border-border bg-card/35 px-3"
      data-slot="tool-activity"
      data-state={childStatus}
      dir={direction}
      lang={locale}
    >
      <header className="flex items-center gap-2 py-2 text-sm">
        <span className="text-xs font-medium text-muted-foreground">
          {kindLabel}
        </span>
        <bdi
          className="min-w-0 flex-1 truncate font-medium"
          dir="auto"
          title={title}
        >
          {title}
        </bdi>
        {headerFacts.map((fact) => (
          <bdi
            key={fact}
            dir="auto"
            className="shrink-0 text-xs text-muted-foreground"
          >
            {fact}
          </bdi>
        ))}
        <ActivityStatusLabel status={childStatus} />
      </header>
      {summary || showTranscript ? (
        <div className="flex flex-col gap-2 ps-6 pb-3">
          {summary ? (
            <p className="text-sm text-pretty" dir="auto">
              {summary}
            </p>
          ) : null}
          {showTranscript ? (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-muted-foreground">
                {labels.activityTranscript.title}
              </p>
              {hasNestedMessages ? (
                <NestedActivityMessages />
              ) : transcript ? (
                <p className="text-sm text-pretty" dir="auto">
                  {transcript}
                </p>
              ) : (
                <p
                  className="text-sm text-muted-foreground"
                  role="status"
                  aria-live="polite"
                >
                  {labels.activityTranscript.loading}
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {footerFacts.length > 0 || sessionLink ? (
        <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 py-2 text-xs text-muted-foreground">
          {footerFacts.map((fact) => (
            <span key={fact} className="tabular-nums">
              {fact}
            </span>
          ))}
          {sessionLink ? (
            <a
              href={sessionLink.href}
              onClick={(event) => openSessionLinkInPlace(event, sessionLink)}
              className="ms-auto inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"
            >
              {labels.subagent.openSession}
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          ) : null}
        </footer>
      ) : null}
    </section>
  )
}

/** A provider's free-form subagent status, when it names one AOS shows. */
function subagentStatus(
  status: string | undefined
): ActivityChildStatus | undefined {
  switch (status?.toLowerCase()) {
    case "running":
    case "in_progress":
    case "active":
      return "running"
    case "waiting":
    case "pending":
    case "queued":
      return "waiting"
    case "completed":
    case "complete":
    case "done":
    case "succeeded":
      return "completed"
    case "failed":
    case "error":
    case "cancelled":
    case "canceled":
      return "failed"
    default:
      return undefined
  }
}

function NestedActivityMessages() {
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border/70 bg-background/60 p-2"
      data-slot="nested-activity-transcript"
    >
      <MessagePartPrimitive.Messages>
        {({ message }) => (
          <MessagePrimitive.Root
            className={cn(
              "max-w-[90%] rounded-lg px-2.5 py-1.5 text-sm wrap-break-word",
              message.role === "user"
                ? "ms-auto bg-muted"
                : "me-auto border border-border/60 bg-card"
            )}
            data-role={message.role}
          >
            <div dir="auto">
              <MessagePrimitive.Parts />
            </div>
          </MessagePrimitive.Root>
        )}
      </MessagePartPrimitive.Messages>
    </div>
  )
}

const activityStatusIcons: Record<ToolUiActivityStatus, typeof LoaderCircle> = {
  running: LoaderCircle,
  waiting: Clock3,
  completed: Check,
  failed: CircleAlert,
}

function ActivityStatusLabel({ status }: { status: ToolUiActivityStatus }) {
  const { labels } = useToolUiLocale()
  const Icon = activityStatusIcons[status]

  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground",
        status === "failed" && "text-destructive",
        status === "completed" && "text-primary"
      )}
      role="status"
      aria-live="polite"
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5",
          status === "running" && "motion-safe:animate-spin"
        )}
      />
      {labels.activityStatuses[status]}
    </span>
  )
}

function getChildStatus(
  payload: ActivityPayload,
  parentPhase: ReturnType<typeof normalizeRichToolState>["phase"]
): ActivityChildStatus {
  if (payload.result?.status) return payload.result.status
  if (parentPhase === "running" || parentPhase === "submitting")
    return "running"
  if (parentPhase === "pending") return "waiting"
  if (
    parentPhase === "failed" ||
    parentPhase === "cancelled" ||
    parentPhase === "expired" ||
    parentPhase === "unavailable"
  ) {
    return "failed"
  }
  return "completed"
}
