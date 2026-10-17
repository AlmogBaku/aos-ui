import {
  Check,
  CircleAlert,
  CircleHelp,
  CircleStop,
  Clock3,
  LoaderCircle,
  PanelRightOpen,
} from "lucide-react"
import type { ThreadMessage } from "@assistant-ui/react"
import { lazy, Suspense, useCallback, useSyncExternalStore } from "react"
import { z } from "zod"

import { useMcpAppHost } from "@/components/mcp-apps/mcp-app-host"
import { useRuntimeInteractions } from "@/components/runtime-interactions/pending-interaction-context"
import { Button } from "@/components/ui/button"
import { RuntimeQuestionComposer } from "@/components/runtime-interactions/question-composer"
import type { ChildSessionControls } from "@/runtime-adapters/child-sessions"
import type { RuntimeInteractionAdapter } from "@/runtime-adapters/contracts"
import {
  permissionProviderMetadata,
  readAosToolArtifact,
  type AosSubagent,
  type AosSubagentApproval,
} from "@/lib/tool-artifact"
import { ShimmerLabel } from "@/lib/surfaces"
import { cn } from "@/lib/utils"

import { useChildSessionControls } from "./child-session-controls"
import { LazyVisualBoundary } from "./lazy-boundary"
import {
  useToolUiLocale,
  type ToolUiActivityKind,
  type ToolUiActivityStatus,
} from "./locale"
import {
  childStatusOf,
  isActiveStatus,
  subagentLiveLine,
  subagentSpan,
} from "./subagent-status"
import { formatToolDuration } from "./tool-call-presentation"
import { useToolElapsedMs } from "./tool-row-meta"
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

type PayloadPart = Pick<RichToolPart, "args" | "result" | "toolName">

/** The call's args and result as an activity payload, when they fit one. */
export function readActivityPayload(
  part: PayloadPart
): ActivityPayload | undefined {
  const parsed = activityPayloadSchema.safeParse({
    args: part.args,
    result: part.result,
  })
  return parsed.success ? parsed.data : undefined
}

/**
 * The activity payload of a call known only by its subagent metadata: its
 * validated args and result when they fit, and the subagent's goal otherwise.
 */
export function subagentActivityPayload(
  part: PayloadPart,
  subagent: AosSubagent
): ActivityPayload {
  return (
    readActivityPayload(part) ?? {
      args: { task: subagent.goal ?? part.toolName },
    }
  )
}

/** What the subagent was set to do, by the most specific name it has. */
export const activityTitle = (
  payload: ActivityPayload | undefined,
  subagent: AosSubagent | undefined
) =>
  subagent?.goal ??
  payload?.result?.name ??
  payload?.args.name ??
  payload?.args.skill ??
  payload?.args.task ??
  payload?.args.description

/** Why the child's turn failed, as its own transcript reports it. */
function failureOf(messages: readonly ThreadMessage[] | undefined) {
  const status = messages?.findLast(
    (message) => message.role === "assistant"
  )?.status
  const error = status?.type === "incomplete" ? status.error : undefined
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : undefined
}

/**
 * One subagent as a row: its status, its goal on one line, how long it has
 * worked, and a second line saying what it does now, what it found, or why it
 * failed. What its child Session asks the operator opens under the row.
 */
export function ActivityTool({
  part,
  payload,
  kind,
  subagent,
  requests = true,
}: {
  part: RichToolPart
  payload: ActivityPayload
  kind: ToolUiActivityKind
  /** ACP subagent metadata; its goal, status, and summary lead when present. */
  subagent?: AosSubagent
  /** Whether the child's requests open under the row to be answered. */
  requests?: boolean
}) {
  const { direction, labels, locale } = useToolUiLocale()
  const controls = useChildSessionControls()
  const title = activityTitle(payload, subagent) ?? labels.activities[kind]
  const summary = subagent?.summary ?? payload.result?.summary
  const status = childStatusOf(part)
  const active = isActiveStatus(status)
  const elapsedMs = useToolElapsedMs(
    subagentSpan(part, subagent, active),
    active
  )
  const failed = status === "failed"
  const childSessionId = subagent?.childSessionId
  const asking =
    useAsksOperator(childSessionId, subagent?.approvals, part.messages) &&
    status === "waiting"
  const line = asking
    ? labels.subagent.needsAnswer
    : active
      ? subagentLiveLine(part.messages, labels)
      : failed
        ? (summary ?? failureOf(part.messages))
        : summary
  const readable = Boolean(
    childSessionId || part.messages?.length || payload.result?.transcript
  )

  return (
    <div
      data-slot="tool-activity"
      data-state={status}
      dir={direction}
      lang={locale}
    >
      <div className="flex flex-col gap-0.5 px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <ActivityStatusIcon status={status} />
          <bdi
            className="min-w-0 flex-1 truncate text-sm font-medium"
            dir="auto"
            title={title}
          >
            {title}
          </bdi>
          {elapsedMs === undefined ? null : (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {formatToolDuration(elapsedMs, labels.assistant.duration)}
            </span>
          )}
          {readable ? <TranscriptMark toolCallId={part.toolCallId} /> : null}
        </div>
        {line ? (
          <p
            className={cn(
              "line-clamp-2 ps-6.5 text-xs text-muted-foreground",
              failed && "text-destructive",
              asking && "font-medium text-warning"
            )}
          >
            {failed ? (
              <span aria-hidden="true">
                {labels.activityStatuses.failed} ·{" "}
              </span>
            ) : null}
            {/* The child's own words keep their direction in either locale. */}
            {asking ? (
              line
            ) : active ? (
              <ShimmerLabel aria-live="off">
                <bdi>{line}</bdi>
              </ShimmerLabel>
            ) : (
              <bdi>{line}</bdi>
            )}
          </p>
        ) : null}
      </div>
      {requests && childSessionId ? (
        <div className="ps-10 pe-3.5">
          <ChildRequests
            part={part}
            childSessionId={childSessionId}
            unhosted={subagent?.approvals}
            controls={controls}
          />
        </div>
      ) : null}
    </div>
  )
}

/**
 * Opens the row's transcript in the side panel, where the runtime has one;
 * the panel hands the focus back to it once it closes.
 */
function TranscriptMark({ toolCallId }: { toolCallId: string }) {
  const host = useMcpAppHost()
  const { labels } = useToolUiLocale()
  if (!host) return null
  const { agentId, sessionId, showInPip } = host
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="-my-1 shrink-0 text-muted-foreground [@media(pointer:coarse)]:size-11"
      aria-label={labels.subagent.viewTranscript}
      title={labels.subagent.viewTranscript}
      data-artifact-open-id={`transcript:${toolCallId}`}
      onClick={(event) =>
        showInPip({
          kind: "transcript",
          target: { agentId, sessionId, toolCallId },
          opener: event.currentTarget,
        })
      }
    >
      <PanelRightOpen aria-hidden="true" className="rtl:-scale-x-100" />
    </Button>
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

/** A permission request no one has answered yet. */
const unanswered = ({ call: { approval } }: ChildApprovalRequest) =>
  approval !== undefined &&
  approval.optionId === undefined &&
  approval.approved === undefined &&
  approval.resolution === undefined

/** Joins Session ids into one stable dependency, and splits them back. */
const SESSION_IDS = "\n"

/**
 * Whether the child Session, or a child of its own, waits on the operator: a
 * permission request no one has answered, or a question still open.
 */
function useAsksOperator(
  childSessionId: string | undefined,
  unhosted: readonly AosSubagentApproval[] | undefined,
  messages: readonly ThreadMessage[] | undefined
) {
  const interactions = useRuntimeInteractions()
  const asked =
    childSessionId !== undefined &&
    childApprovals(childSessionId, unhosted, messages).some(unanswered)
  const sessions =
    childSessionId !== undefined && interactions
      ? childSessionIds(childSessionId, messages).join(SESSION_IDS)
      : ""
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!interactions || !sessions) return () => {}
      const stops = sessions
        .split(SESSION_IDS)
        .map((id) => interactions.subscribe(id, listener))
      return () => {
        for (const stop of stops) stop()
      }
    },
    [interactions, sessions]
  )
  const getSnapshot = useCallback(
    () =>
      Boolean(interactions && sessions) &&
      sessions.split(SESSION_IDS).some((id) => {
        const request = interactions?.getPending(id)
        return request?.sessionId === id && request.status !== "expired"
      }),
    [interactions, sessions]
  )
  const questioned = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return asked || questioned
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

const activityStatusIcons: Record<ToolUiActivityStatus, typeof LoaderCircle> = {
  running: LoaderCircle,
  waiting: Clock3,
  completed: Check,
  failed: CircleAlert,
  stopped: CircleStop,
  unknown: CircleHelp,
}

/** The row's status as an icon, read aloud by its label. */
function ActivityStatusIcon({ status }: { status: ToolUiActivityStatus }) {
  const { labels } = useToolUiLocale()
  const Icon = activityStatusIcons[status]
  return (
    <span className="flex shrink-0" role="status">
      <Icon
        aria-hidden="true"
        className={cn(
          "size-4",
          status === "running" &&
            "text-muted-foreground motion-safe:animate-spin",
          status === "waiting" && "text-warning",
          status === "completed" && "text-success",
          status === "failed" && "text-destructive",
          (status === "stopped" || status === "unknown") &&
            "text-muted-foreground"
        )}
      />
      <span className="sr-only">{labels.activityStatuses[status]}</span>
    </span>
  )
}
