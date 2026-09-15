import type { RunFinishedInterruptOutcome } from "@ag-ui/core"

import { OpenCodeMutationUncertainError } from "./client"

const MAX_PENDING = 64
const MAX_QUESTIONS = 32
const MAX_OPTIONS = 64
const MAX_TEXT_BYTES = 4_096
export type OpenCodeInteractionScope = {
  agentId: string
  sessionId: string
  threadId: string
  runId: string
}
export type OpenCodeInteractionTransport = {
  questions: {
    reply(
      sessionId: string,
      requestId: string,
      reply: { answers: string[][] }
    ): Promise<void>
    reject(sessionId: string, requestId: string): Promise<void>
  }
  permissions: {
    reply(
      sessionId: string,
      requestId: string,
      reply: "once" | "always" | "reject",
      message?: string
    ): Promise<void>
  }
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
      code === "AOS_INTERACTION_NOT_FOUND"
        ? "Interaction not found"
        : code === "AOS_MUTATION_UNCERTAIN"
          ? "The interaction response may have been accepted"
          : code === "AOS_PROVIDER_INVALID_RESPONSE"
            ? "OpenCode returned invalid interaction data"
            : "Invalid interaction response"
    )
    this.name = "OpenCodeInteractionPublicError"
  }
}
type Scope = Omit<OpenCodeInteractionScope, "runId">
type Question = {
  options: { publicValue: string; nativeLabel: string }[]
  multiple: boolean
  custom: boolean
}
type Pending = {
  id: string
  scope: Scope
  state: "pending" | "dispatching"
  kind: "question" | "permission"
  questions?: Question[]
}
const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
const text = (v: unknown, max = MAX_TEXT_BYTES) =>
  typeof v === "string" &&
  v.length > 0 &&
  new TextEncoder().encode(v).byteLength <= max
    ? v
    : undefined
const identity = (s: Scope) =>
  JSON.stringify([s.agentId, s.sessionId, s.threadId])
const key = (s: Scope, id: string) => `${identity(s)}:${id}`
function parseQuestions(native: unknown, sessionId: string): Question[] {
  const request = record(native)
  if (
    request?.sessionID !== sessionId ||
    !Array.isArray(request.questions) ||
    !request.questions.length ||
    request.questions.length > MAX_QUESTIONS
  )
    throw new OpenCodeInteractionPublicError("AOS_PROVIDER_INVALID_RESPONSE")
  return request.questions.map((raw) => {
    const row = record(raw)
    if (
      !text(row?.header, 256) ||
      !text(row?.question) ||
      !Array.isArray(row?.options) ||
      row.options.length > MAX_OPTIONS ||
      (row.multiple !== undefined && typeof row.multiple !== "boolean") ||
      (row.custom !== undefined && typeof row.custom !== "boolean")
    )
      throw new OpenCodeInteractionPublicError("AOS_PROVIDER_INVALID_RESPONSE")
    const options = row.options.map((option, index) => {
      const value = record(option)
      const label = text(value?.label, 256)
      if (!label || !text(value?.description))
        throw new OpenCodeInteractionPublicError(
          "AOS_PROVIDER_INVALID_RESPONSE"
        )
      return { publicValue: `option-${index + 1}`, nativeLabel: label }
    })
    return {
      options,
      multiple: row.multiple === true,
      custom: row.custom === true,
    }
  })
}
export class OpenCodeInteractions {
  readonly #pending = new Map<string, Pending>()
  constructor(private readonly transport: OpenCodeInteractionTransport) {}
  acceptQuestion(
    scope: OpenCodeInteractionScope,
    native: unknown
  ): RunFinishedInterruptOutcome {
    const id = text(record(native)?.id, 512)
    if (!id)
      throw new OpenCodeInteractionPublicError("AOS_PROVIDER_INVALID_RESPONSE")
    const s: Scope = {
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      threadId: scope.threadId,
    }
    if (!this.#pending.has(key(s, id)) && this.#pending.size >= MAX_PENDING)
      throw new OpenCodeInteractionPublicError("AOS_LIMIT_EXCEEDED")
    const existing = this.#pending.get(key(s, id))
    if (existing && existing.kind !== "question")
      throw new OpenCodeInteractionPublicError("AOS_PROVIDER_INVALID_RESPONSE")
    this.#pending.set(key(s, id), {
      id,
      scope: s,
      state: "pending",
      kind: "question",
      questions: parseQuestions(native, scope.sessionId),
    })
    return this.snapshot(scope)!
  }
  acceptPermission(
    scope: OpenCodeInteractionScope,
    native: unknown
  ): RunFinishedInterruptOutcome {
    const row = record(native)
    const id = text(row?.id, 512)
    if (
      !id ||
      row?.sessionID !== scope.sessionId ||
      !text(row.action) ||
      !Array.isArray(row.resources) ||
      row.resources.length > 64 ||
      row.resources.some((x) => !text(x))
    )
      throw new OpenCodeInteractionPublicError("AOS_PROVIDER_INVALID_RESPONSE")
    const s: Scope = {
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      threadId: scope.threadId,
    }
    const existing = this.#pending.get(key(s, id))
    if (
      (!existing && this.#pending.size >= MAX_PENDING) ||
      (existing && existing.kind !== "permission")
    )
      throw new OpenCodeInteractionPublicError(
        existing ? "AOS_PROVIDER_INVALID_RESPONSE" : "AOS_LIMIT_EXCEEDED"
      )
    this.#pending.set(key(s, id), {
      id,
      scope: s,
      state: "pending",
      kind: "permission",
    })
    return this.snapshot(scope)!
  }
  reconcile(
    scope: OpenCodeInteractionScope,
    native: { questions: unknown; permissions: unknown }
  ) {
    const s: Scope = {
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      threadId: scope.threadId,
    }
    const qs = Array.isArray(native.questions)
      ? native.questions
      : record(native.questions)?.data
    const ps = Array.isArray(native.permissions)
      ? native.permissions
      : record(native.permissions)?.data
    if (!Array.isArray(qs) || !Array.isArray(ps))
      throw new OpenCodeInteractionPublicError("AOS_PROVIDER_INVALID_RESPONSE")
    for (const [k, v] of this.#pending)
      if (identity(v.scope) === identity(s)) this.#pending.delete(k)
    for (const q of qs) this.acceptQuestion(scope, q)
    for (const p of ps) this.acceptPermission(scope, p)
    return this.snapshot(scope)
  }
  snapshot(
    scope: OpenCodeInteractionScope
  ): RunFinishedInterruptOutcome | undefined {
    const s: Scope = {
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      threadId: scope.threadId,
    }
    const pending = [...this.#pending.values()].filter(
      (p) => identity(p.scope) === identity(s)
    )
    if (!pending.length) return
    return {
      type: "interrupt",
      interrupts: pending.map((p) => {
        if (p.kind === "permission")
          return {
            id: p.id,
            reason: "approval",
            responseSchema: {
              type: "string",
              enum: ["once", "always", "deny"],
            },
          }
        return {
          id: p.id,
          reason: "question",
          message: `${p.questions!.length} questions require answers`,
          responseSchema: {
            type: "array",
            minItems: p.questions!.length,
            maxItems: p.questions!.length,
            items: p.questions!.map((q) => ({
              type: "array",
              minItems: 0,
              maxItems: q.multiple ? q.options.length : 1,
              items: q.custom
                ? { type: "string", maxLength: MAX_TEXT_BYTES }
                : { type: "string", enum: q.options.map((o) => o.publicValue) },
            })),
          },
        }
      }),
    }
  }
  async respond(
    scope: OpenCodeInteractionScope,
    resume: unknown
  ): Promise<{ status: "resolved" | "in-progress" }> {
    const s: Scope = {
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      threadId: scope.threadId,
    }
    const pending = [...this.#pending.values()].filter(
      (p) => identity(p.scope) === identity(s)
    )
    if (
      !pending.length ||
      !Array.isArray(resume) ||
      resume.length !== pending.length
    )
      throw new OpenCodeInteractionPublicError("AOS_INTERACTION_NOT_FOUND")
    const entries = resume.map((raw) => {
      const e = record(raw)
      if (
        !e ||
        !text(e.interruptId, 512) ||
        (e.status !== "resolved" && e.status !== "cancelled")
      )
        throw new OpenCodeInteractionPublicError("AOS_INVALID_INTERACTION")
      const p = pending.find((x) => x.id === e.interruptId)
      if (!p)
        throw new OpenCodeInteractionPublicError("AOS_INVALID_INTERACTION")
      return {
        p,
        status: e.status,
        payload: e.payload,
        answers:
          p.kind === "question" && e.status === "resolved"
            ? this.#answers(p.questions!, e.payload)
            : undefined,
      }
    })
    if (new Set(entries.map((e) => e.p.id)).size !== entries.length)
      throw new OpenCodeInteractionPublicError("AOS_INVALID_INTERACTION")
    if (entries.some((e) => e.p.state === "dispatching"))
      return { status: "in-progress" }
    for (const e of entries) e.p.state = "dispatching"
    try {
      for (const e of entries) {
        if (e.p.kind === "question") {
          if (e.status === "cancelled")
            await this.transport.questions.reject(scope.sessionId, e.p.id)
          else
            await this.transport.questions.reply(scope.sessionId, e.p.id, {
              answers: e.answers!,
            })
        } else {
          const choice = e.status === "cancelled" ? "deny" : e.payload
          if (choice !== "once" && choice !== "always" && choice !== "deny")
            throw new OpenCodeInteractionPublicError("AOS_INVALID_INTERACTION")
          await this.transport.permissions.reply(
            scope.sessionId,
            e.p.id,
            choice === "deny" ? "reject" : choice
          )
        }
        this.#pending.delete(key(s, e.p.id))
      }
    } catch (error) {
      if (error instanceof OpenCodeMutationUncertainError)
        throw new OpenCodeInteractionPublicError("AOS_MUTATION_UNCERTAIN")
      for (const e of entries)
        if (e.p.state === "dispatching") e.p.state = "pending"
      if (error instanceof OpenCodeInteractionPublicError) throw error
      throw new OpenCodeInteractionPublicError("AOS_PROVIDER_UNAVAILABLE")
    }
    for (const e of entries) this.#pending.delete(key(s, e.p.id))
    return { status: "resolved" }
  }
  #answers(questions: Question[], input: unknown) {
    if (!Array.isArray(input) || input.length !== questions.length)
      throw new OpenCodeInteractionPublicError("AOS_INVALID_INTERACTION")
    return input.map((answer, index) => {
      const q = questions[index]!
      if (
        !Array.isArray(answer) ||
        answer.length > (q.multiple ? q.options.length : 1)
      )
        throw new OpenCodeInteractionPublicError("AOS_INVALID_INTERACTION")
      const selected = answer.map((raw) => {
        const value = text(raw, 256)
        const option = q.options.find((x) => x.publicValue === value)
        if (option) return option.nativeLabel
        if (value && q.custom) return value
        throw new OpenCodeInteractionPublicError("AOS_INVALID_INTERACTION")
      })
      if (new Set(selected).size !== selected.length)
        throw new OpenCodeInteractionPublicError("AOS_INVALID_INTERACTION")
      return selected
    })
  }
}
