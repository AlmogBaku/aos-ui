import {
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  LoaderCircle,
} from "lucide-react"
import { MessagePartPrimitive, MessagePrimitive } from "@assistant-ui/react"
import { z } from "zod"

import { cn } from "@/lib/utils"

import { safeJsonStringify } from "./common"
import { normalizeRichToolState } from "./lifecycle"
import {
  useToolUiLocale,
  type ToolUiActivityKind,
  type ToolUiActivityStatus,
} from "./locale"
import type { RichToolPart } from "./types"

const activityStatusSchema = z.enum([
  "running",
  "waiting",
  "completed",
  "failed",
])

const fixtureActivityPayloadSchema = z
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

const openCodeTaskPayloadSchema = z
  .object({
    args: z.object({
      description: z.string().min(1),
    }),
    result: z.unknown().optional(),
  })
  .transform(({ args, result }) => ({
    args: {
      task: undefined as string | undefined,
      name: undefined as string | undefined,
      skill: undefined as string | undefined,
      description: args.description,
    },
    result:
      typeof result === "string" && result.trim()
        ? {
            name: undefined as string | undefined,
            status: undefined as ActivityChildStatus | undefined,
            summary: result,
            transcript: undefined as string | undefined,
          }
        : undefined,
  }))

/** OpenCode's native task tool reports its child work as a string result. */
export const activityPayloadSchema = z.union([
  fixtureActivityPayloadSchema,
  openCodeTaskPayloadSchema,
])

export type ActivityPayload = z.infer<typeof activityPayloadSchema>
export type ActivityChildStatus = z.infer<typeof activityStatusSchema>

export function ActivityTool({
  part,
  payload,
  kind,
}: {
  part: RichToolPart
  payload: ActivityPayload
  kind: ToolUiActivityKind
}) {
  const state = normalizeRichToolState(part)
  const { direction, labels, locale } = useToolUiLocale()
  const kindLabel = labels.activities[kind]
  const title =
    payload.result?.name ??
    payload.args.name ??
    payload.args.skill ??
    payload.args.task ??
    payload.args.description ??
    kindLabel
  const summary = payload.result?.summary
  const childStatus = getChildStatus(payload, state.phase)
  const transcript = payload.result?.transcript
  const hasNestedMessages = Boolean(part.messages?.length)
  const transcriptIsLoading =
    !hasNestedMessages &&
    !transcript &&
    (childStatus === "running" || childStatus === "waiting")

  return (
    <details
      className="group mt-3 w-full max-w-2xl rounded-xl border border-border bg-card/35 px-3"
      data-slot="tool-activity"
      data-state={childStatus}
      dir={direction}
      lang={locale}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-4 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="text-xs font-medium text-muted-foreground">
          {kindLabel}
        </span>
        <bdi className="min-w-0 flex-1 truncate font-medium" dir="auto">
          {title}
        </bdi>
        <ActivityStatusLabel status={childStatus} />
      </summary>
      <div className="flex flex-col gap-2 ps-6 pb-3">
        {summary ? (
          <p className="text-sm text-pretty" dir="auto">
            {summary}
          </p>
        ) : null}
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
              role={transcriptIsLoading ? "status" : undefined}
              aria-live={transcriptIsLoading ? "polite" : undefined}
            >
              {transcriptIsLoading
                ? labels.activityTranscript.loading
                : labels.activityTranscript.unavailable}
            </p>
          )}
        </div>
        <pre
          className="max-h-48 overflow-auto font-mono text-xs break-all whitespace-pre-wrap text-muted-foreground"
          dir="ltr"
        >
          {safeJsonStringify({ args: payload.args, result: payload.result })}
        </pre>
      </div>
    </details>
  )
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
