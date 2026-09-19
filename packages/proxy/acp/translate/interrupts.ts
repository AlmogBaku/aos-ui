import type {
  CreateElicitationRequest,
  ElicitationPropertySchema,
  ElicitationSchema,
  PermissionOption,
} from "@agentclientprotocol/sdk/experimental/v2"

import {
  AOS_META_KEY,
  AOS_PERMISSION_KIND_SESSION,
  type AosQuestion,
} from "../../../protocol/acp"
import type { PendingRequest } from "../../core/events"
import type {
  AcpOutbound,
  Lane,
  PendingRequestToOutbound,
  ReplyFromElicitation,
  ReplyFromPermission,
} from "../types"

/** All three adapters say `approval`; the browser also accepted `confirmation`. */
const APPROVAL_REASONS = new Set(["approval", "confirmation"])

/** The approval choices the adapters normalize to, as ACP option kinds. */
const PERMISSION_KINDS = new Map([
  ["once", { kind: "allow_once", name: "Allow once" }],
  ["always", { kind: "allow_always", name: "Allow always" }],
  [
    "session",
    { kind: AOS_PERMISSION_KIND_SESSION, name: "Allow for this session" },
  ],
  ["deny", { kind: "reject_once", name: "Deny" }],
])

/** A guest may not widen permission past the request in front of them. */
const GUEST_DENIED_CHOICES = new Set(["always", "session"])

/**
 * `Omit` over `CreateElicitationRequest` drops the whole mode union, so the
 * form fields are restored here before the value reaches `AcpOutbound`.
 */
type ElicitationForm = Omit<CreateElicitationRequest, "sessionId"> & {
  requestedSchema: ElicitationSchema
}

type InterruptOutbound = Extract<
  AcpOutbound,
  { kind: "request-permission" | "elicitation" }
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(value: unknown) {
  return isRecord(value) ? value : undefined
}

function enumValues(schema: Record<string, unknown> | undefined): string[] {
  const values = schema?.enum
  if (!Array.isArray(values)) return []
  return values.flatMap((value: unknown) =>
    typeof value === "string" && value.trim() ? [value] : []
  )
}

function permissionOptions(
  request: PendingRequest,
  lane: Lane
): PermissionOption[] {
  return enumValues(record(request.responseSchema)).flatMap((choice) => {
    if (lane === "guest" && GUEST_DENIED_CHOICES.has(choice)) return []
    const known = PERMISSION_KINDS.get(choice)
    return known
      ? [{ optionId: choice, name: known.name, kind: known.kind }]
      : []
  })
}

function permissionOutbound(
  request: PendingRequest,
  lane: Lane
): InterruptOutbound {
  const title = request.message ?? "Permission required"
  return {
    kind: "request-permission",
    interruptId: request.id,
    request: {
      title,
      ...(request.toolCallId
        ? {
            subject: {
              type: "tool_call",
              toolCall: {
                toolCallId: request.toolCallId,
                title,
                status: "pending",
              },
            },
          }
        : {}),
      options: permissionOptions(request, lane),
      _meta: {
        [AOS_META_KEY]: {
          interruptId: request.id,
          ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
          ...(request.message
            ? { message: request.message.slice(0, 4_096) }
            : {}),
        },
      },
    },
  }
}

function optionsOf(schema: Record<string, unknown> | undefined) {
  return enumValues(schema).map((label) => ({ label }))
}

/**
 * Ports `createAgUiInterruptRequest` in `src/components/runtime-interactions`.
 * Every question is `custom`: a clarify answer may be free text that is none of
 * the offered choices (`MAX_CHOICES` in Hermes' `tools/clarify_tool.py`: "the UI
 * always appends an Other (type your answer) row"), so the browser must always
 * offer that row.
 */
function questionsOf(request: PendingRequest): AosQuestion[] {
  const schema = record(request.responseSchema)
  const answers = record(record(schema?.properties)?.answers)
  const prefixItems = Array.isArray(answers?.prefixItems)
    ? answers.prefixItems
    : undefined
  if (prefixItems?.length)
    return prefixItems.map((item: unknown, index) => {
      const question = record(item)
      const title =
        typeof question?.title === "string" ? question.title : undefined
      const options = optionsOf(record(question?.items))
      return {
        header: (title ?? `Question ${index + 1}`).slice(0, 256),
        prompt: title ?? request.message ?? "Question",
        options,
        multiple: question?.maxItems !== 1,
        custom: true,
      }
    })
  const options = optionsOf(schema)
  return [
    {
      header: "Question",
      prompt: request.message ?? "Question",
      options,
      multiple: false,
      custom: true,
    },
  ]
}

/**
 * The choices ride only in `_meta.aos.questions[].options`, never as a schema
 * `enum`: an `enum` would make the free-text answer every question accepts
 * invalid against `requestedSchema`. A foreign ACP client therefore loses the
 * enum hint and gains the ability to answer freely, which is the native
 * contract. A question with no choices stays a string field even when it takes
 * several values; `_meta.aos` keeps `multiple`.
 */
function propertyOf(question: AosQuestion): ElicitationPropertySchema {
  const values = question.options.map((option) => option.value ?? option.label)
  if (question.multiple && values.length > 0)
    return {
      type: "array",
      title: question.header,
      description: question.prompt,
      items: { type: "string" },
    }
  return {
    type: "string",
    title: question.header,
    description: question.prompt,
  }
}

function elicitationOutbound(request: PendingRequest): InterruptOutbound {
  const questions = questionsOf(request)
  const form: ElicitationForm = {
    mode: "form",
    message: request.message ?? "Input required",
    requestedSchema: {
      type: "object",
      properties: Object.fromEntries(
        questions.map((question, index) => [`q${index}`, propertyOf(question)])
      ),
      required: questions.map((_, index) => `q${index}`),
    },
    _meta: {
      [AOS_META_KEY]: {
        interruptId: request.id,
        ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
        questions,
      },
    },
  }
  return { kind: "elicitation", interruptId: request.id, request: form }
}

function answerValues(value: unknown): string[] {
  if (Array.isArray(value))
    return value.flatMap((item: unknown) =>
      typeof item === "string" ? [item] : []
    )
  if (typeof value === "string") return value ? [value] : []
  if (typeof value === "number" || typeof value === "boolean")
    return [String(value)]
  return []
}

export const pendingRequestToOutbound = ((request, lane) =>
  APPROVAL_REASONS.has(request.reason)
    ? permissionOutbound(request, lane)
    : elicitationOutbound(request)) satisfies PendingRequestToOutbound

/** `optionId` is the adapter's own choice value, which is what resume expects. */
export const replyFromPermission = ((request, response) => {
  const outcome = response.outcome
  const optionId =
    outcome.outcome === "selected" && typeof outcome.optionId === "string"
      ? outcome.optionId
      : undefined
  return optionId === undefined
    ? { interruptId: request.id, status: "cancelled" }
    : { interruptId: request.id, status: "resolved", payload: optionId }
}) satisfies ReplyFromPermission

export const replyFromElicitation = ((request, response) => {
  if (response.action !== "accept")
    return { interruptId: request.id, status: "cancelled" }
  const content = record(response.content)
  const answers = questionsOf(request).map((_, index) =>
    answerValues(content?.[`q${index}`])
  )
  return { interruptId: request.id, status: "resolved", payload: { answers } }
}) satisfies ReplyFromElicitation
