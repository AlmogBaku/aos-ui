"use client"

import { lazy, Suspense, type ComponentType, type ReactNode } from "react"
import type { z } from "zod"

import {
  ActivityTool,
  activityPayloadSchema,
  type ActivityPayload,
} from "./activity"
import { GenericJsonTool } from "./generic-json"
import { LazyVisualBoundary } from "./lazy-boundary"
import {
  permissionPayloadSchema,
  type PermissionPayload,
} from "./payloads/permission"
import {
  questionPayloadSchema,
  type QuestionPayload,
} from "./payloads/question-flow"
import { useToolUiLocale, type ToolUiToolName } from "./locale"
import type { RichToolPart, RichToolRendererComponent } from "./types"

const QuestionFlowTool = lazy(() =>
  import("./question-flow").then((module) => ({
    default: module.QuestionFlowTool,
  }))
)
const PermissionTool = lazy(() =>
  import("./permission").then((module) => ({ default: module.PermissionTool }))
)

function ToolDisplayFallback({
  part,
  failed = false,
}: {
  part: RichToolPart
  failed?: boolean
}) {
  const { direction, labels, locale } = useToolUiLocale()
  return (
    <div className="flex min-w-0 flex-col gap-2" dir={direction} lang={locale}>
      <p
        className="text-sm text-muted-foreground"
        role={failed ? "alert" : "status"}
      >
        {failed
          ? labels.common.displayUnavailable
          : labels.common.displayLoading}
      </p>
      <GenericJsonTool part={part} />
    </div>
  )
}

function OptionalToolDisplay({
  part,
  children,
}: {
  part: RichToolPart
  children: ReactNode
}) {
  const { labels } = useToolUiLocale()
  return (
    <LazyVisualBoundary
      key={part.toolCallId}
      fallbackLabel={labels.common.displayUnavailable}
      fallback={<ToolDisplayFallback part={part} failed />}
    >
      <Suspense fallback={<ToolDisplayFallback part={part} />}>
        {children}
      </Suspense>
    </LazyVisualBoundary>
  )
}

export type RichToolValidation =
  { valid: true; payload: unknown } | { valid: false }

export type RichToolRegistration = {
  displayNameKey: ToolUiToolName
  validate: (part: RichToolPart) => RichToolValidation
  render: (part: RichToolPart, payload: unknown) => ReactNode
}

export type RichToolRegistry = Readonly<Record<string, RichToolRegistration>>

type RegisteredRendererProps<T> = {
  part: RichToolPart
  payload: T
}

function defineToolRenderer<T>({
  displayNameKey,
  schema,
  Renderer,
  acceptsPart = () => true,
  optional = false,
}: {
  displayNameKey: ToolUiToolName
  schema: z.ZodType<T>
  Renderer: ComponentType<RegisteredRendererProps<T>>
  acceptsPart?: (part: RichToolPart) => boolean
  optional?: boolean
}): RichToolRegistration {
  return {
    displayNameKey,
    validate(part) {
      if (!acceptsPart(part)) return { valid: false }
      const parsed = schema.safeParse({ args: part.args, result: part.result })
      return parsed.success
        ? { valid: true, payload: parsed.data }
        : { valid: false }
    },
    render(part, payload) {
      const display = <Renderer part={part} payload={payload as T} />
      return optional ? (
        <OptionalToolDisplay part={part}>{display}</OptionalToolDisplay>
      ) : (
        display
      )
    },
  }
}

const question = defineToolRenderer<QuestionPayload>({
  displayNameKey: "question",
  schema: questionPayloadSchema,
  Renderer: QuestionFlowTool,
  optional: true,
})

const permission = defineToolRenderer<PermissionPayload>({
  displayNameKey: "permission",
  schema: permissionPayloadSchema,
  Renderer: PermissionTool,
  optional: true,
  acceptsPart: (part) => part.approval !== undefined,
})

function SubagentActivity(props: RegisteredRendererProps<ActivityPayload>) {
  return <ActivityTool {...props} kind="subagent" />
}

const subagentActivity = defineToolRenderer<ActivityPayload>({
  displayNameKey: "subagentActivity",
  schema: activityPayloadSchema,
  Renderer: SubagentActivity,
})

/**
 * The rich-tool dispatch table holds provider-native semantic controls. Charts,
 * maps and stats are MCP App views their own server draws; ordinary execution,
 * skill, and generic activity calls stay out so the native timeline groups
 * them.
 */
export const richToolRegistry: RichToolRegistry = Object.freeze({
  ask_user_question: question,
  question,
  request_permission: permission,
  request_approval: permission,
  delegate_subagent: subagentActivity,
  run_subagent: subagentActivity,
})

/** Direct `MessagePrimitive.Parts` tool-call renderer. */
export const RichToolRenderer: RichToolRendererComponent = (part) => {
  const { labels } = useToolUiLocale()
  const registration = richToolRegistry[part.toolName]

  // A batched question that does not satisfy the single-question schema is
  // answered beside the composer by the pending-interaction flow, so nothing is
  // rendered here. A single question remains a normal semantic message.
  if (
    part.toolName === "question" &&
    richToolRegistry.question.validate(part).valid === false
  )
    return null

  // Provider-native approvals stay attached to the tool they guard (for
  // example `bash` or `edit`) rather than arriving as a permission tool.
  // Questions remain on their dedicated free-text/option flow.
  if (part.approval && registration !== question) {
    const parsed = permissionPayloadSchema.safeParse({
      args: part.args,
      result: part.result,
    })
    const payload: PermissionPayload = parsed.success
      ? parsed.data
      : {
          args: {
            action:
              part.approval.prompt?.trim() ||
              labels.permission.defaultAction(part.toolName),
          },
          result: part.result,
        }

    return permission.render(part, payload)
  }

  if (!registration) return <GenericJsonTool part={part} />

  const validation = registration.validate(part)
  if (!validation.valid) {
    return (
      <GenericJsonTool
        part={part}
        invalidDisplayName={labels.toolNames[registration.displayNameKey]}
      />
    )
  }

  return registration.render(part, validation.payload)
}
