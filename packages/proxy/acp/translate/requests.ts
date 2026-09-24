import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  ElicitationSchema,
  PermissionOption,
} from "@agentclientprotocol/sdk/experimental/v2"

import {
  AOS_META_KEY,
  AOS_PERMISSION_KIND_SESSION,
  type AosQuestion,
} from "../../../protocol/acp"
import {
  PendingRequestKind,
  ReplyStatus,
  type PendingQuestion,
  type PendingRequest,
} from "../../core/events"
import type {
  AcpOutbound,
  PendingRequestToOutbound,
  ReplyFromElicitation,
  ReplyFromPermission,
} from "../types"
import { update } from "./updates"

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

/**
 * `Omit` over `CreateElicitationRequest` drops the whole mode union, so the
 * form fields are restored here before the value reaches `AcpOutbound`.
 */
type ElicitationForm = Omit<CreateElicitationRequest, "sessionId"> & {
  requestedSchema: ElicitationSchema
}

type RequestOutbound = Extract<
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

function permissionOptions(request: PendingRequest): PermissionOption[] {
  return enumValues(record(request.responseSchema)).flatMap((choice) => {
    const known = PERMISSION_KINDS.get(choice)
    return known
      ? [{ optionId: choice, name: known.name, kind: known.kind }]
      : []
  })
}

function permissionOutbound(request: PendingRequest): RequestOutbound {
  // The schema's `title` names the operation and the message explains it; a
  // request with only one of the two titles itself with it.
  const label = record(request.responseSchema)?.title
  const words = request.message
  const title =
    typeof label === "string" && label
      ? label
      : (words ?? "Permission required")
  return {
    kind: "request-permission",
    requestId: request.requestId,
    request: {
      title,
      ...(words && words !== title ? { description: words } : {}),
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
      options: permissionOptions(request),
      _meta: {
        [AOS_META_KEY]: {
          requestId: request.requestId,
          ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
          ...(request.message
            ? { message: request.message.slice(0, 4_096) }
            : {}),
        },
      },
    },
  }
}

/** A request that lists no questions asks one free-text question: its message. */
function pendingQuestionsOf(request: PendingRequest): PendingQuestion[] {
  return request.questions ?? [{ choices: [], multiple: false, custom: true }]
}

/**
 * A header is the provider's short label and only that: a provider without one
 * leaves it unset rather than have the proxy invent English copy the browser
 * would show a Hebrew reader, and the browser labels that question by its place.
 */
function questionsOf(request: PendingRequest): AosQuestion[] {
  return pendingQuestionsOf(request).map((question) => ({
    ...(question.label ? { header: question.label.slice(0, 256) } : {}),
    prompt: question.text ?? question.label ?? request.message ?? "Question",
    options: question.choices.map((label) => ({ label })),
    multiple: question.multiple,
    custom: question.custom,
  }))
}

/**
 * A single-choice question is a plain string field: its choices ride in
 * `_meta.aos.questions[].options`, and omitting the schema `enum` is what keeps
 * the free-text answer every question accepts valid against `requestedSchema`.
 * A multi-select must declare `items.enum`, which ACP requires of a reserved
 * `"string"` item type and the SDK rejects the whole elicitation without; the
 * response schema does not constrain values to it, so a free-text answer still
 * travels. A question with no choices stays a string field even when it takes
 * several values; `_meta.aos` keeps `multiple`.
 */
function propertyOf(question: AosQuestion): ElicitationPropertySchema {
  const values = question.options.map((option) => option.value ?? option.label)
  if (question.multiple && values.length > 0)
    return {
      type: "array",
      ...(question.header ? { title: question.header } : {}),
      description: question.prompt,
      items: { type: "string", enum: values },
    }
  return {
    type: "string",
    ...(question.header ? { title: question.header } : {}),
    description: question.prompt,
  }
}

function elicitationOutbound(request: PendingRequest): RequestOutbound {
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
        requestId: request.requestId,
        ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
        questions,
      },
    },
  }
  return { kind: "elicitation", requestId: request.requestId, request: form }
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

export const pendingRequestToOutbound = ((request) =>
  request.kind === PendingRequestKind.Permission
    ? permissionOutbound(request)
    : elicitationOutbound(request)) satisfies PendingRequestToOutbound

/** `optionId` is the adapter's own choice value, which is what the reply expects. */
export const replyFromPermission = ((request, response) => {
  const outcome = response.outcome
  const optionId =
    outcome.outcome === "selected" && typeof outcome.optionId === "string"
      ? outcome.optionId
      : undefined
  return optionId === undefined
    ? { requestId: request.requestId, status: ReplyStatus.Cancelled }
    : {
        requestId: request.requestId,
        status: ReplyStatus.Resolved,
        payload: optionId,
      }
}) satisfies ReplyFromPermission

/** Every member answers the choices as the runtime wrote them. */
export const replyFromElicitation = ((request, response) => {
  if (response.action !== "accept")
    return { requestId: request.requestId, status: ReplyStatus.Cancelled }
  const content = record(response.content)
  const answers = pendingQuestionsOf(request).map((_, index) =>
    answerValues(content?.[`q${index}`])
  )
  return {
    requestId: request.requestId,
    status: ReplyStatus.Resolved,
    payload: { answers },
  }
}) satisfies ReplyFromElicitation

/**
 * The values a member answered each question with, as it was shown them;
 * none for a question it declined.
 */
export function shownAnswers(
  request: PendingRequest,
  response: CreateElicitationResponse
): string[][] {
  const content =
    response.action === "accept" ? record(response.content) : undefined
  return pendingQuestionsOf(request).map((_, index) =>
    content ? answerValues(content[`q${index}`]) : []
  )
}

/**
 * The record an answered question leaves on the tool call that asked it, in the
 * `{ status, responses }` shape an answered call already carries in history: the
 * provider settles the call only in its own history, so without this the live
 * card keeps asking a question the operator has answered. One projection of an
 * answered question reaches the browser, which never re-derives the answer it
 * just sent. The update names no message, so the browser attaches it to the turn
 * that owns the call. A request that names no tool call leaves no record.
 */
export function answeredQuestionOutbound(
  request: PendingRequest,
  answers: readonly (readonly string[])[]
): AcpOutbound | undefined {
  const toolCallId = request.toolCallId
  if (toolCallId === undefined) return undefined
  const responses = questionsOf(request).map((question, index) => ({
    question: question.prompt,
    answers: [...(answers[index] ?? [])],
  }))
  return update({
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "completed",
    rawOutput: {
      status: responses.some(({ answers }) => answers.length)
        ? "answered"
        : "cancelled",
      responses,
    },
  })
}
