import type { RunFinishedInterruptOutcome } from "@ag-ui/core"

import { OpenCodeMutationUncertainError } from "./client"

const MAX_PENDING = 64
const MAX_QUESTIONS = 32
const MAX_OPTIONS = 64
const MAX_TEXT_BYTES = 4_096
const MAX_RESOURCES = 64

export type OpenCodeInteractionScope = {
  agentId: string
  sessionId: string
  threadId: string
  runId: string
}

type QuestionsTransport = {
  reply(
    sessionId: string,
    requestId: string,
    reply: { answers: string[][] }
  ): Promise<void>
  reject(sessionId: string, requestId: string): Promise<void>
}

type PermissionsTransport = {
  reply(
    sessionId: string,
    requestId: string,
    reply: "once" | "always" | "reject",
    message?: string
  ): Promise<void>
}

export type OpenCodeInteractionTransport = {
  questions: QuestionsTransport
  permissions: PermissionsTransport
}

export class OpenCodeInteractionPublicError extends Error {
  constructor(
    readonly code:
      | "AOS_INVALID_INTERACTION"
      | "AOS_INTERACTION_NOT_FOUND"
      | "AOS_LIMIT_EXCEEDED"
      | "AOS_PROVIDER_INVALID_RESPONSE"
      | "AOS_PROVIDER_UNAVAILABLE"
      | "AOS_MUTATION_UNCERTAIN"
  ) {
    super(
      code === "AOS_PROVIDER_INVALID_RESPONSE"
        ? "OpenCode returned invalid interaction data"
        : code === "AOS_INTERACTION_NOT_FOUND"
          ? "Interaction not found"
          : code === "AOS_MUTATION_UNCERTAIN"
            ? "The interaction response may have been accepted"
            : code === "AOS_PROVIDER_UNAVAILABLE"
              ? "OpenCode interaction is temporarily unavailable"
              : code === "AOS_LIMIT_EXCEEDED"
                ? "Interaction limit exceeded"
                : "Invalid interaction response"
    )
    this.name = "OpenCodeInteractionPublicError"
  }
}

type Question = {
  header: string
  question: string
  options: string[]
  multiple: boolean
  custom: boolean
}

type Pending = {
  key: string
  scope: OpenCodeInteractionScope
  id: string
  state: "pending" | "dispatching"
  fingerprint?: string
  outcome: RunFinishedInterruptOutcome
} & (
  | { kind: "questions"; questions: Question[] }
  | { kind: "permission"; action: string; resources: string[] }
)

function bytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function bounded(value: unknown, maximum = MAX_TEXT_BYTES) {
  return typeof value === "string" &&
    value.length > 0 &&
    bytes(value) <= maximum
    ? value
    : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function sameScope(
  left: OpenCodeInteractionScope,
  right: OpenCodeInteractionScope
) {
  return (
    left.agentId === right.agentId &&
    left.sessionId === right.sessionId &&
    left.threadId === right.threadId &&
    left.runId === right.runId
  )
}

function key(scope: OpenCodeInteractionScope, id: string) {
  return JSON.stringify([
    scope.agentId,
    scope.sessionId,
    scope.threadId,
    scope.runId,
    id,
  ])
}

function publicText(value: string) {
  return value
    .replace(
      /(?:https?|wss?|file):\/\/[^\s"'<>]+/giu,
      "[provider location redacted]"
    )
    .replace(
      /(^|[\s("'=,:;\x5B])(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^\s"'<>]*/gu,
      "$1[provider path redacted]"
    )
    .replace(
      /\b(?:token|password|secret|api[-_]?key)\s*[=:]\s*[^\s,;]+/giu,
      "[credential redacted]"
    )
}

function validQuestion(value: unknown): Question | undefined {
  const question = record(value)
  const header = bounded(question?.header, 256)
  const text = bounded(question?.question)
  if (
    !header ||
    !text ||
    !Array.isArray(question?.options) ||
    question.options.length > MAX_OPTIONS
  )
    return undefined
  const options = question.options.map((option) => {
    const row = record(option)
    const label = bounded(row?.label, 256)
    const description = bounded(row?.description)
    return label && description ? label : undefined
  })
  if (
    options.some((option) => option === undefined) ||
    new Set(options).size !== options.length
  )
    return undefined
  if (
    question?.multiple !== undefined &&
    typeof question.multiple !== "boolean"
  )
    return undefined
  if (question?.custom !== undefined && typeof question.custom !== "boolean")
    return undefined
  return {
    header: publicText(header),
    question: publicText(text),
    options: options as string[],
    multiple: question?.multiple === true,
    custom: question?.custom === true,
  }
}

function result(
  interrupts: RunFinishedInterruptOutcome["interrupts"]
): RunFinishedInterruptOutcome {
  return { type: "interrupt", interrupts }
}

function parseResume(value: unknown) {
  if (!Array.isArray(value) || value.length !== 1)
    throw new OpenCodeInteractionPublicError("AOS_INVALID_INTERACTION")
  const entry = record(value[0])
  if (
    !entry ||
    !bounded(entry.interruptId, 512) ||
    (entry.status !== "resolved" && entry.status !== "cancelled") ||
    Object.keys(entry).some(
      (name) => !["interruptId", "status", "payload", "metadata"].includes(name)
    )
  )
    throw new OpenCodeInteractionPublicError("AOS_INVALID_INTERACTION")
  return {
    interruptId: entry.interruptId as string,
    status: entry.status,
    payload: entry.payload,
  }
}

export class OpenCodeInteractions {
  readonly #pending = new Map<string, Pending>()

  constructor(private readonly transport: OpenCodeInteractionTransport) {}

  acceptQuestion(
    scope: OpenCodeInteractionScope,
    native: unknown
  ): RunFinishedInterruptOutcome {
    const request = record(native)
    const id = bounded(request?.id, 512)
    if (
      !id ||
      request?.sessionID !== scope.sessionId ||
      !Array.isArray(request?.questions) ||
      request.questions.length === 0 ||
      request.questions.length > MAX_QUESTIONS
    )
      throw new OpenCodeInteractionPublicError("AOS_PROVIDER_INVALID_RESPONSE")
    const questions = request.questions.map(validQuestion)
    if (questions.some((question) => !question))
      throw new OpenCodeInteractionPublicError("AOS_PROVIDER_INVALID_RESPONSE")
    const interactionKey = key(scope, id)
    const existing = this.#pending.get(interactionKey)
    if (existing) return existing.outcome
    if (this.#pending.size >= MAX_PENDING)
      throw new OpenCodeInteractionPublicError("AOS_LIMIT_EXCEEDED")
    const parsed = questions as Question[]
    const outcome = result([
      {
        id,
        reason: "question",
        message: `${parsed.length} question${parsed.length === 1 ? "" : "s"} require answers`,
        responseSchema: {
          type: "array",
          minItems: parsed.length,
          maxItems: parsed.length,
          items: parsed.map((question) => ({
            type: "array",
            minItems: 0,
            maxItems: question.multiple ? question.options.length : 1,
            items: question.custom
              ? { type: "string", maxLength: MAX_TEXT_BYTES }
              : { type: "string", enum: question.options },
            ...(question.multiple ? { uniqueItems: true } : {}),
          })),
        },
        metadata: {
          "aos.kind": "questions",
          "aos.questionCount": parsed.length,
        },
      },
    ])
    this.#pending.set(interactionKey, {
      key: interactionKey,
      scope,
      id,
      state: "pending",
      kind: "questions",
      questions: parsed,
      outcome,
    })
    return outcome
  }

  acceptPermission(
    scope: OpenCodeInteractionScope,
    native: unknown
  ): RunFinishedInterruptOutcome {
    const request = record(native)
    const id = bounded(request?.id, 512)
    const action = bounded(request?.action)
    if (
      !id ||
      !action ||
      request?.sessionID !== scope.sessionId ||
      !Array.isArray(request?.resources) ||
      request.resources.length > MAX_RESOURCES
    )
      throw new OpenCodeInteractionPublicError("AOS_PROVIDER_INVALID_RESPONSE")
    const resources = request.resources.map((resource) => bounded(resource))
    if (resources.some((resource) => !resource))
      throw new OpenCodeInteractionPublicError("AOS_PROVIDER_INVALID_RESPONSE")
    const interactionKey = key(scope, id)
    const existing = this.#pending.get(interactionKey)
    if (existing) return existing.outcome
    if (this.#pending.size >= MAX_PENDING)
      throw new OpenCodeInteractionPublicError("AOS_LIMIT_EXCEEDED")
    const outcome = result([
      {
        id,
        reason: "approval",
        message: publicText(action),
        responseSchema: { type: "string", enum: ["once", "always", "reject"] },
        metadata: {
          "aos.kind": "permission",
          "aos.resourceCount": resources.length,
        },
      },
    ])
    this.#pending.set(interactionKey, {
      key: interactionKey,
      scope,
      id,
      state: "pending",
      kind: "permission",
      action: publicText(action),
      resources: (resources as string[]).map(publicText),
      outcome,
    })
    return outcome
  }

  async respond(
    scope: OpenCodeInteractionScope,
    resume: unknown
  ): Promise<{ status: "resolved" | "in-progress" }> {
    const entry = parseResume(resume)
    const interaction = this.#pending.get(key(scope, entry.interruptId))
    if (!interaction || !sameScope(interaction.scope, scope))
      throw new OpenCodeInteractionPublicError("AOS_INTERACTION_NOT_FOUND")
    if (interaction.state === "dispatching") return { status: "in-progress" }
    const fingerprint = JSON.stringify(entry)
    if (interaction.fingerprint && interaction.fingerprint !== fingerprint)
      throw new OpenCodeInteractionPublicError("AOS_INVALID_INTERACTION")
    interaction.fingerprint = fingerprint
    interaction.state = "dispatching"
    try {
      if (interaction.kind === "questions") {
        if (entry.status === "cancelled")
          await this.transport.questions.reject(scope.sessionId, interaction.id)
        else {
          const answers = this.#answers(interaction.questions, entry.payload)
          await this.transport.questions.reply(
            scope.sessionId,
            interaction.id,
            { answers }
          )
        }
      } else {
        const choice = entry.status === "cancelled" ? "reject" : entry.payload
        if (choice !== "once" && choice !== "always" && choice !== "reject")
          throw new OpenCodeInteractionPublicError("AOS_INVALID_INTERACTION")
        await this.transport.permissions.reply(
          scope.sessionId,
          interaction.id,
          choice
        )
      }
    } catch (error) {
      if (error instanceof OpenCodeInteractionPublicError) {
        interaction.state = "pending"
        throw error
      }
      if (error instanceof OpenCodeMutationUncertainError)
        throw new OpenCodeInteractionPublicError("AOS_MUTATION_UNCERTAIN")
      interaction.state = "pending"
      throw new OpenCodeInteractionPublicError("AOS_PROVIDER_UNAVAILABLE")
    }
    this.#pending.delete(interaction.key)
    return { status: "resolved" }
  }

  #answers(questions: readonly Question[], value: unknown) {
    if (!Array.isArray(value) || value.length !== questions.length)
      throw new OpenCodeInteractionPublicError("AOS_INVALID_INTERACTION")
    return value.map((answer, index) => {
      const question = questions[index]!
      if (
        !Array.isArray(answer) ||
        answer.length > (question.multiple ? question.options.length : 1) ||
        (!question.multiple && answer.length > 1)
      )
        throw new OpenCodeInteractionPublicError("AOS_INVALID_INTERACTION")
      const values = answer.map((item) => bounded(item))
      if (
        values.some((item) => !item) ||
        new Set(values).size !== values.length
      )
        throw new OpenCodeInteractionPublicError("AOS_INVALID_INTERACTION")
      const selected = values as string[]
      if (
        !question.custom &&
        selected.some((item) => !question.options.includes(item))
      )
        throw new OpenCodeInteractionPublicError("AOS_INVALID_INTERACTION")
      return selected
    })
  }
}
