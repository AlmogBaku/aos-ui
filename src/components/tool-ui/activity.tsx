import {
  Check,
  CircleAlert,
  CircleHelp,
  Clock3,
  LoaderCircle,
  PanelRightOpen,
  Square,
} from "lucide-react"
import {
  MessagePartPrimitive,
  MessagePrimitive,
  useAuiState,
  type ReasoningMessagePartComponent,
  type TextMessagePartComponent,
  type ThreadMessage,
} from "@assistant-ui/react"
import {
  lazy,
  Suspense,
  useCallback,
  useState,
  useSyncExternalStore,
} from "react"
import { z } from "zod"

import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text"
import { useRuntimeInteractions } from "@/components/runtime-interactions/pending-interaction-context"
import { RuntimeQuestionComposer } from "@/components/runtime-interactions/question-composer"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { ChildSessionControls } from "@/runtime-adapters/child-sessions"
import type { RuntimeInteractionAdapter } from "@/runtime-adapters/contracts"
import {
  permissionProviderMetadata,
  readAosToolArtifact,
  type AosSubagent,
  type AosSubagentApproval,
} from "@/lib/tool-artifact"
import { cn } from "@/lib/utils"

import { AosToolFallback } from "./aos-tool-fallback"
import { useChildSessionControls } from "./child-session-controls"
import { LazyVisualBoundary } from "./lazy-boundary"
import { normalizeRichToolState } from "./lifecycle"
import {
  useToolUiLocale,
  type ToolUiActivityKind,
  type ToolUiActivityStatus,
} from "./locale"
import { formatToolDuration } from "./tool-call-presentation"
import type { RichToolPart } from "./types"

// The permission card is an optional display, loaded as the registry loads it.
const PermissionTool = lazy(() =>
  import("./permission").then((module) => ({ default: module.PermissionTool }))
)

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
      .loose()
      .optional(),
  })
  .loose()

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
  const controls = useChildSessionControls()
  const [viewOpen, setViewOpen] = useState(false)
  const kindLabel = labels.activities[kind]
  const title =
    subagent?.goal ??
    payload.result?.name ??
    payload.args.name ??
    payload.args.skill ??
    payload.args.task ??
    payload.args.description ??
    kindLabel
  const summary = subagent?.summary ?? payload.result?.summary
  const childStatus =
    subagentStatus(subagent?.status) ?? getChildStatus(payload, state.phase)
  const childSessionId = subagent?.childSessionId
  // A child stops alone only where it says so; the card cannot stop it twice.
  const stop =
    controls &&
    childSessionId &&
    subagent?.cancellable &&
    (childStatus === "running" || childStatus === "waiting")
      ? () => controls.cancel(childSessionId)
      : undefined
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
        {stop ? (
          <Button type="button" size="xs" variant="ghost" onClick={stop}>
            <Square data-icon="inline-start" aria-hidden="true" />
            {labels.subagent.stop}
          </Button>
        ) : null}
        <ActivityStatusLabel status={childStatus} />
      </header>
      {childSessionId ? (
        <ChildRequests
          part={part}
          childSessionId={childSessionId}
          unhosted={subagent?.approvals}
          controls={controls}
        />
      ) : null}
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
      {footerFacts.length > 0 || childSessionId ? (
        <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 py-2 text-xs text-muted-foreground">
          {footerFacts.map((fact) => (
            <span key={fact} className="tabular-nums">
              {fact}
            </span>
          ))}
          {childSessionId ? (
            <button
              type="button"
              onClick={() => setViewOpen(true)}
              className="ms-auto inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"
            >
              {labels.subagent.openSession}
              <PanelRightOpen aria-hidden="true" className="size-3.5" />
            </button>
          ) : null}
        </footer>
      ) : null}
      {childSessionId ? (
        <ChildSessionView
          title={title}
          open={viewOpen}
          onOpenChange={setViewOpen}
        />
      ) : null}
    </section>
  )
}

type NestedToolCall = Extract<
  ThreadMessage["content"][number],
  { type: "tool-call" }
>

/** A permission request, with the child Session that asked it. */
type ChildApprovalRequest = { sessionId: string; call: NestedToolCall }

const UNHOSTED_APPROVAL_PREFIX = "aos-permission-"

/**
 * A request no turn of the child's transcript could hold, as the permission
 * call the card answers it on.
 */
const unhostedCall = (approval: AosSubagentApproval): NestedToolCall => ({
  type: "tool-call",
  toolCallId: `${UNHOSTED_APPROVAL_PREFIX}${approval.id}`,
  toolName: "request_permission",
  args: { action: approval.action },
  argsText: "",
  approval: {
    id: approval.id,
    prompt: approval.prompt,
    options: approval.options,
    ...(approval.optionId === undefined ? {} : { optionId: approval.optionId }),
    ...(approval.approved === undefined ? {} : { approved: approval.approved }),
    ...(approval.resolution === undefined
      ? {}
      : { resolution: approval.resolution }),
  },
  providerMetadata: permissionProviderMetadata(approval.action),
})

/**
 * The permission requests the child Session, or a child of its own, asked:
 * on its own calls wherever its transcript nests them, and those no turn of
 * it could hold, each with the Session that asked it.
 */
function childApprovals(
  sessionId: string,
  unhosted: readonly AosSubagentApproval[] | undefined,
  messages: readonly ThreadMessage[] | undefined
): ChildApprovalRequest[] {
  return [
    ...(unhosted ?? []).map((approval) => ({
      sessionId,
      call: unhostedCall(approval),
    })),
    ...(messages ?? []).flatMap((message) =>
      message.content.flatMap((part) => {
        if (part.type !== "tool-call") return []
        const nested = readAosToolArtifact(part.artifact)?.subagent
        return [
          ...(part.approval ? [{ sessionId, call: part }] : []),
          ...(nested?.childSessionId
            ? childApprovals(
                nested.childSessionId,
                nested.approvals,
                part.messages
              )
            : []),
        ]
      })
    ),
  ]
}

/** The child Session ids below this card: its own, then its children's. */
function childSessionIds(
  childSessionId: string,
  messages: readonly ThreadMessage[] | undefined
): string[] {
  return [
    childSessionId,
    ...(messages ?? []).flatMap((message) =>
      message.content.flatMap((part) => {
        if (part.type !== "tool-call") return []
        const nested = readAosToolArtifact(part.artifact)?.subagent
        return nested?.childSessionId
          ? childSessionIds(nested.childSessionId, part.messages)
          : []
      })
    ),
  ]
}

/**
 * What the child Session asks the operator, answered on its card: its
 * permission requests, through the runtime's child controls, and its
 * questions, through the runtime's interactions, each under the child's own
 * id. A runtime without either shows the card without them.
 */
function ChildRequests({
  part,
  childSessionId,
  unhosted,
  controls,
}: {
  part: RichToolPart
  childSessionId: string
  /** The child's requests no turn of its transcript holds. */
  unhosted: readonly AosSubagentApproval[] | undefined
  controls: ChildSessionControls | undefined
}) {
  const interactions = useRuntimeInteractions()
  const approvals = controls
    ? childApprovals(childSessionId, unhosted, part.messages)
    : []
  const sessions = interactions
    ? childSessionIds(childSessionId, part.messages)
    : []
  if (approvals.length === 0 && sessions.length === 0) return null
  return (
    <div className="flex flex-col gap-2 pb-2 empty:hidden">
      {controls
        ? approvals.map(({ sessionId, call }) => (
            <ChildApproval
              key={`${sessionId}:${call.toolCallId}`}
              sessionId={sessionId}
              call={call}
              controls={controls}
            />
          ))
        : null}
      {interactions
        ? sessions.map((sessionId) => (
            <ChildQuestion
              key={sessionId}
              sessionId={sessionId}
              interactions={interactions}
            />
          ))
        : null}
    </div>
  )
}

/** A child's permission request, answered on the child it was asked in. */
function ChildApproval({
  sessionId,
  call,
  controls,
}: {
  sessionId: string
  call: NestedToolCall
  controls: ChildSessionControls
}) {
  const approval = call.approval!
  const answerable: RichToolPart = {
    ...call,
    status: { type: "requires-action", reason: "tool-calls" },
    addResult: () => {},
    resume: () => {},
    respondToApproval: (response) => {
      const optionId = "optionId" in response ? response.optionId : undefined
      const option = approval.options?.find(({ id }) => id === optionId)
      if (optionId === undefined || option === undefined)
        throw new Error("A permission answer must choose one of its options")
      const approved =
        "approved" in response
          ? response.approved
          : !option.kind.startsWith("reject")
      return controls.respondToApproval(
        sessionId,
        approval.id,
        optionId,
        approved
      )
    },
  }
  const { labels } = useToolUiLocale()
  return (
    <LazyVisualBoundary
      fallbackLabel={labels.common.displayUnavailable}
      resetKey={approval.id}
    >
      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground" role="status">
            {labels.common.displayLoading}
          </p>
        }
      >
        <PermissionTool
          part={answerable}
          payload={{
            args: { action: approval.prompt ?? call.toolName },
            result: call.result,
          }}
        />
      </Suspense>
    </LazyVisualBoundary>
  )
}

/** The question a child Session is putting to the operator, if it is. */
function ChildQuestion({
  sessionId,
  interactions,
}: {
  sessionId: string
  interactions: RuntimeInteractionAdapter
}) {
  const { locale } = useToolUiLocale()
  const subscribe = useCallback(
    (listener: () => void) => interactions.subscribe(sessionId, listener),
    [interactions, sessionId]
  )
  const getSnapshot = useCallback(
    () => interactions.getPending(sessionId),
    [interactions, sessionId]
  )
  const request = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (!request || request.sessionId !== sessionId) return null
  return (
    <RuntimeQuestionComposer
      key={request.requestId}
      locale={locale}
      request={request}
      interactions={interactions}
      expired={request.status === "expired"}
      recovered={request.status === "recovered"}
      onDismissExpired={() => interactions.dismiss?.(request)}
      onResponsePending={() => {}}
      onResolved={() => {}}
    />
  )
}

/**
 * The child Session's own transcript, opened to read: its turns as its parent
 * projected them, with no composer, no Edit or Retry, and nothing that would
 * load the child as a Session of its own.
 */
function ChildSessionView({
  title,
  open,
  onOpenChange,
}: {
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { direction, labels, locale } = useToolUiLocale()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
        closeLabel={labels.subagent.closeSession}
        dir={direction}
        lang={locale}
      >
        <DialogHeader>
          <DialogTitle dir="auto">{title}</DialogTitle>
          <DialogDescription>{labels.subagent.readOnly}</DialogDescription>
        </DialogHeader>
        <ChildSessionTranscript />
      </DialogContent>
    </Dialog>
  )
}

/** The child's text as it stands, with no reveal to wait out while reading. */
const ChildText: TextMessagePartComponent = () => (
  <MarkdownText smooth={false} />
)

const ChildReasoning: ReasoningMessagePartComponent = () => (
  <div className="text-muted-foreground">
    <MarkdownText smooth={false} />
  </div>
)

const CHILD_SESSION_PARTS = {
  Text: ChildText,
  Reasoning: ChildReasoning,
  tools: { Fallback: AosToolFallback },
}

function ChildSessionTranscript() {
  const { labels } = useToolUiLocale()
  const empty = useAuiState(
    (state) => state.part.type !== "tool-call" || !state.part.messages?.length
  )
  if (empty)
    return (
      <p className="text-sm text-muted-foreground">
        {labels.activityTranscript.unavailable}
      </p>
    )
  return (
    <div className="flex flex-col gap-4">
      <MessagePartPrimitive.Messages>
        {({ message }) => (
          <MessagePrimitive.Root
            className={cn(
              "flex flex-col gap-2 wrap-break-word",
              message.role === "user" &&
                "ms-auto max-w-[85%] rounded-xl bg-muted px-4 py-2"
            )}
            data-role={message.role}
          >
            <div dir="auto">
              <MessagePrimitive.Parts components={CHILD_SESSION_PARTS} />
            </div>
          </MessagePrimitive.Root>
        )}
      </MessagePartPrimitive.Messages>
    </div>
  )
}

/** A provider's free-form subagent status, when it names one AOS shows. */
function subagentStatus(
  status: string | undefined
): ToolUiActivityStatus | undefined {
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
    // A child nothing follows any longer may still run, or be done.
    case "unknown":
      return "unknown"
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
  unknown: CircleHelp,
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
