import type { RunFinishedInterruptOutcome } from "@ag-ui/core"

export type HermesInteractionScope = {
  agentId: string
  sessionId: string
  threadId: string
  runId: string
}

export type HermesInteractionTransport = {
  request(
    method: string,
    params: Readonly<Record<string, unknown>>
  ): Promise<unknown>
}

const APPROVAL_CHOICES = ["once", "session", "always", "deny"] as const
type ApprovalChoice = (typeof APPROVAL_CHOICES)[number]

export const HERMES_INTERACTION_LIMITS = Object.freeze({
  maxNativePayloadBytes: 65_536,
  maxDepth: 8,
  maxQuestions: 32,
  maxChoicesPerQuestion: 64,
  maxAnswerValuesPerQuestion: 64,
  maxStringBytes: 4_096,
  maxPending: 64,
  maxReactionBytes: 64,
  maxReactionTargets: 4_096,
})

export class HermesInteractionPublicError extends Error {
  constructor(
    readonly code:
      | "AOS_INVALID_INTERACTION"
      | "AOS_INTERACTION_NOT_FOUND"
      | "AOS_LIMIT_EXCEEDED"
      | "AOS_PROVIDER_INVALID_RESPONSE"
      | "AOS_PROVIDER_UNAVAILABLE"
      | "AOS_RECONCILIATION_STALE"
  ) {
    super(
      code === "AOS_PROVIDER_INVALID_RESPONSE"
        ? "Hermes returned invalid interaction data"
        : code === "AOS_RECONCILIATION_STALE"
          ? "Stale Hermes reconciliation result"
          : code === "AOS_PROVIDER_UNAVAILABLE"
            ? "Hermes is temporarily unavailable"
            : code === "AOS_INTERACTION_NOT_FOUND"
              ? "Interaction not found"
              : code === "AOS_LIMIT_EXCEEDED"
                ? "Interaction limit exceeded"
                : "Invalid interaction response"
    )
    this.name = "HermesInteractionPublicError"
  }
}

type Question = {
  id?: string
  question: string
  choices: string[] | null
  nativeChoices: string[] | null
  multiple: boolean
  locked?: string[]
  lockedNative?: string[]
}

type PendingInteraction = {
  scope: HermesInteractionScope
  liveSessionId: string
  id: string
  sequence: number
  outcome: RunFinishedInterruptOutcome
  state: "pending" | "dispatching"
  responseFingerprint?: string
} & (
  | { kind: "approval"; choices: ApprovalChoice[] }
  | { kind: "questions"; questions: Question[] }
)

type NewPendingInteraction =
  | Omit<
      Extract<PendingInteraction, { kind: "approval" }>,
      "sequence" | "state"
    >
  | Omit<
      Extract<PendingInteraction, { kind: "questions" }>,
      "sequence" | "state"
    >

export type HermesInteractionResult = {
  status:
    "resolved" | "expired" | "already-resolved" | "uncertain" | "in-progress"
}

export type HermesReactionResult =
  | {
      status: "resolved"
      messageId: string
      reactions: ReadonlyArray<{
        emoji: string
        author: "user" | "agent"
        at: number
      }>
    }
  | { status: "uncertain"; messageId: string }

type ReactionRecord = {
  scope: HermesInteractionScope
  fingerprint: string
  result?: HermesReactionResult
  promise?: Promise<HermesReactionResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function validString(
  value: unknown,
  max: number = HERMES_INTERACTION_LIMITS.maxStringBytes
) {
  return typeof value === "string" && value.trim() && utf8Bytes(value) <= max
    ? value.trim()
    : undefined
}

const credentialText =
  /(?:\bauthorization\s*[:=]\s*(?:(?:basic|bearer)\s+)?[^\s,;]+|\b(?:access[-_]?token|api[-_]?key|credential|password|secret|token)\s*[=:]\s*[^\s,;]+|\b(?:basic|bearer)\s+\S+|\b(?:gh[opsur]_|sk-|xox[baprs]-)[\w-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+)/giu
const providerLocationText = /\b(?:https?|wss?|file):\/\/[^\s"'<>]+/giu
const providerPathText =
  /(^|[\s("'=,:;\x5b])(?:(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^\s"'<>]*)/gu

function publicText(value: string) {
  return value
    .replace(credentialText, "[credential redacted]")
    .replace(providerLocationText, "[provider location redacted]")
    .replace(providerPathText, "$1[provider path redacted]")
}

function publicChoices(nativeChoices: string[] | null) {
  if (!nativeChoices) return null
  const projected = nativeChoices.map(publicText)
  return projected.map((choice, index) => {
    return projected.filter((candidate) => candidate === choice).length > 1
      ? `${choice} (option ${index + 1})`
      : choice
  })
}

function boundedJson(value: unknown) {
  const seen = new Set<object>()
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > HERMES_INTERACTION_LIMITS.maxDepth) return false
    if (
      item === null ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      return true
    if (typeof item === "string")
      return utf8Bytes(item) <= HERMES_INTERACTION_LIMITS.maxNativePayloadBytes
    if (typeof item !== "object" || seen.has(item)) return false
    seen.add(item)
    const values = Array.isArray(item) ? item : Object.values(item)
    const valid = values.every((entry) => visit(entry, depth + 1))
    seen.delete(item)
    return valid
  }
  if (!visit(value, 0)) return false
  try {
    return (
      utf8Bytes(JSON.stringify(value)) <=
      HERMES_INTERACTION_LIMITS.maxNativePayloadBytes
    )
  } catch {
    return false
  }
}

function invalidNative(): never {
  throw new HermesInteractionPublicError("AOS_PROVIDER_INVALID_RESPONSE")
}

function parseChoices(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return null
  if (
    !Array.isArray(value) ||
    value.length > HERMES_INTERACTION_LIMITS.maxChoicesPerQuestion
  )
    return undefined
  const choices = value.map((choice) => validString(choice))
  if (choices.some((choice) => choice === undefined)) return undefined
  const normalized = choices as string[]
  return new Set(normalized).size === normalized.length ? normalized : undefined
}

function parseClarification(payload: Record<string, unknown>) {
  const requestId = validString(payload.request_id, 256)
  if (!requestId) invalidNative()
  let questions: Question[]
  if (Array.isArray(payload.questions)) {
    if (
      payload.questions.length === 0 ||
      payload.questions.length > HERMES_INTERACTION_LIMITS.maxQuestions
    )
      invalidNative()
    questions = payload.questions.map((candidate) => {
      if (!isRecord(candidate)) invalidNative()
      const id = validString(candidate.qid, 256)
      const question = validString(candidate.question)
      const nativeChoices = parseChoices(candidate.choices)
      if (
        !id ||
        !question ||
        nativeChoices === undefined ||
        typeof candidate.multi_select !== "boolean"
      )
        invalidNative()
      return {
        id,
        question: publicText(question),
        choices: publicChoices(nativeChoices),
        nativeChoices,
        multiple: candidate.multi_select,
      }
    })
    if (new Set(questions.map(({ id }) => id)).size !== questions.length)
      invalidNative()
  } else {
    const question = validString(payload.question)
    const nativeChoices = parseChoices(payload.choices)
    if (!question || nativeChoices === undefined) invalidNative()
    questions = [
      {
        question: publicText(question),
        choices: publicChoices(nativeChoices),
        nativeChoices,
        multiple: payload.multi_select === true,
      },
    ]
  }
  if (payload.answers !== undefined) {
    if (!isRecord(payload.answers) || !Array.isArray(payload.questions))
      invalidNative()
    for (const [questionId, encoded] of Object.entries(payload.answers)) {
      const question = questions.find(({ id }) => id === questionId)
      if (
        !question ||
        typeof encoded !== "string" ||
        utf8Bytes(encoded) > HERMES_INTERACTION_LIMITS.maxStringBytes
      )
        invalidNative()
      let nativeAnswers: string[]
      if (question.multiple) {
        try {
          const parsed: unknown = JSON.parse(encoded)
          if (
            !Array.isArray(parsed) ||
            parsed.some((answer) => !validString(answer))
          )
            invalidNative()
          nativeAnswers = parsed.map(String)
        } catch (error) {
          if (error instanceof HermesInteractionPublicError) throw error
          invalidNative()
        }
      } else {
        nativeAnswers = encoded ? [encoded] : []
      }
      if (
        nativeAnswers.length >
          (question.multiple
            ? (question.nativeChoices?.length ??
              HERMES_INTERACTION_LIMITS.maxAnswerValuesPerQuestion)
            : 1) ||
        new Set(nativeAnswers).size !== nativeAnswers.length ||
        (question.nativeChoices &&
          nativeAnswers.some(
            (answer) => !question.nativeChoices!.includes(answer)
          ))
      )
        invalidNative()
      question.lockedNative = nativeAnswers
      question.locked = nativeAnswers.map((answer) => {
        if (!question.nativeChoices || !question.choices)
          return publicText(answer)
        return question.choices[question.nativeChoices.indexOf(answer)]!
      })
    }
  }
  return { requestId, questions }
}

function questionSchema(question: Question) {
  return {
    type: "array",
    title: question.question,
    items: question.choices
      ? { type: "string", enum: question.choices }
      : { type: "string", maxLength: HERMES_INTERACTION_LIMITS.maxStringBytes },
    minItems: 0,
    maxItems: question.multiple
      ? (question.choices?.length ??
        HERMES_INTERACTION_LIMITS.maxAnswerValuesPerQuestion)
      : 1,
    ...(question.multiple ? { uniqueItems: true } : {}),
    ...(question.locked ? { default: question.locked } : {}),
  }
}

function sameScope(
  left: HermesInteractionScope,
  right: HermesInteractionScope
) {
  return (
    left.agentId === right.agentId &&
    left.sessionId === right.sessionId &&
    left.threadId === right.threadId &&
    left.runId === right.runId
  )
}

function interactionKey(scope: HermesInteractionScope, id: string) {
  return JSON.stringify([
    scope.agentId,
    scope.sessionId,
    scope.threadId,
    scope.runId,
    id,
  ])
}

function sessionKey(scope: HermesInteractionScope) {
  return JSON.stringify([
    scope.agentId,
    scope.sessionId,
    scope.threadId,
    scope.runId,
  ])
}

function strictResume(value: unknown) {
  if (!isRecord(value))
    throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
  const allowed = new Set(["interruptId", "status", "payload"])
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
  const interruptId = validString(value.interruptId, 256)
  if (
    !interruptId ||
    (value.status !== "resolved" && value.status !== "cancelled")
  )
    throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
  if (!boundedJson(value))
    throw new HermesInteractionPublicError("AOS_LIMIT_EXCEEDED")
  return { interruptId, status: value.status, payload: value.payload }
}

function answerSets(value: unknown, questions: Question[]) {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "answers"))
    throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
  if (
    !Array.isArray(value.answers) ||
    value.answers.length !== questions.length
  )
    throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
  return value.answers.map((candidate, index) => {
    const question = questions[index]!
    if (
      !Array.isArray(candidate) ||
      candidate.length >
        (question.multiple
          ? (question.choices?.length ??
            HERMES_INTERACTION_LIMITS.maxAnswerValuesPerQuestion)
          : 1)
    )
      throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
    const answers = candidate.map((answer) => validString(answer))
    if (
      answers.some((answer) => answer === undefined) ||
      new Set(answers).size !== answers.length ||
      (question.choices &&
        answers.some((answer) => !question.choices!.includes(answer!)))
    )
      throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
    const publicAnswers = answers as string[]
    return {
      values: publicAnswers.map((answer) => {
        if (!question.choices || !question.nativeChoices) return answer
        return question.nativeChoices[question.choices.indexOf(answer)]!
      }),
      lockedUnchanged:
        question.locked !== undefined &&
        JSON.stringify(question.locked) === JSON.stringify(publicAnswers),
    }
  })
}

function validApprovalResult(value: unknown) {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.resolved) &&
    (value.resolved as number) >= 0
  )
}

function validClarifyResult(value: unknown) {
  return (
    isRecord(value) &&
    (value.status === "ok" || value.status === "expired") &&
    (value.remaining === undefined ||
      (Array.isArray(value.remaining) &&
        value.remaining.length <= HERMES_INTERACTION_LIMITS.maxQuestions &&
        new Set(value.remaining).size === value.remaining.length &&
        value.remaining.every((id) => validString(id, 256))))
  )
}

function approvalChoices(payload: Record<string, unknown>): ApprovalChoice[] {
  const native: ApprovalChoice[] = Array.isArray(payload.choices)
    ? payload.choices.filter((choice): choice is ApprovalChoice =>
        APPROVAL_CHOICES.includes(choice as ApprovalChoice)
      )
    : payload.smart_denied === true
      ? (["once", "deny"] as ApprovalChoice[])
      : [...APPROVAL_CHOICES]
  return native.filter(
    (choice, index) =>
      (choice !== "always" || payload.allow_permanent !== false) &&
      native.indexOf(choice) === index
  )
}

export class HermesInteractions {
  readonly #pending = new Map<string, PendingInteraction>()
  readonly #completed = new Map<
    string,
    { fingerprint?: string; result: HermesInteractionResult }
  >()
  readonly #live = new Map<
    string,
    { scope: HermesInteractionScope; liveSessionId: string }
  >()
  readonly #reactions = new Map<string, ReactionRecord>()
  readonly #reactionTargets = new Map<string, ReadonlySet<string>>()
  readonly #resumeGenerations = new Map<string, number>()
  #sequence = 0

  constructor(readonly transport: HermesInteractionTransport) {}

  #remember(interaction: NewPendingInteraction) {
    const key = interactionKey(interaction.scope, interaction.id)
    const existing = this.#pending.get(key)
    if (existing) {
      if (
        existing.kind !== interaction.kind ||
        existing.liveSessionId !== interaction.liveSessionId ||
        JSON.stringify(existing.outcome) !== JSON.stringify(interaction.outcome)
      )
        invalidNative()
      return existing.outcome
    }
    if (this.#completed.has(key)) return undefined
    if (this.#pending.size >= HERMES_INTERACTION_LIMITS.maxPending)
      throw new HermesInteractionPublicError("AOS_LIMIT_EXCEEDED")
    this.#completed.delete(key)
    const pending = {
      ...interaction,
      sequence: ++this.#sequence,
      state: "pending" as const,
    } as PendingInteraction
    this.#pending.set(key, pending)
    return pending.outcome
  }

  acceptNative(
    scope: HermesInteractionScope,
    liveSessionId: string,
    event: unknown
  ): RunFinishedInterruptOutcome | HermesInteractionResult | undefined {
    if (!isRecord(event)) return undefined
    if (
      event.type !== "approval.request" &&
      event.type !== "clarify.request" &&
      event.type !== "clarify.expire"
    )
      return undefined
    if (!boundedJson(event)) invalidNative()
    if (event.session_id !== liveSessionId) return undefined
    const established = this.#live.get(sessionKey(scope))
    if (established && established.liveSessionId !== liveSessionId)
      return undefined
    if (!isRecord(event.payload)) invalidNative()
    if (event.type === "clarify.expire") {
      const requestId = validString(event.payload.request_id, 256)
      if (!requestId) invalidNative()
      const key = interactionKey(scope, requestId)
      const interaction = this.#pending.get(key)
      if (
        !interaction ||
        interaction.kind !== "questions" ||
        interaction.liveSessionId !== liveSessionId
      )
        return undefined
      this.#pending.delete(key)
      const result: HermesInteractionResult = { status: "expired" }
      this.#complete(key, result)
      return result
    }
    if (event.type === "clarify.request") {
      const { requestId, questions } = parseClarification(event.payload)
      const outcome: RunFinishedInterruptOutcome = {
        type: "interrupt",
        interrupts: [
          {
            id: requestId,
            reason: "question",
            message:
              questions.length === 1
                ? questions[0]!.question
                : `${questions.length} questions require answers`,
            responseSchema: {
              type: "object",
              properties: {
                answers: {
                  type: "array",
                  prefixItems: questions.map(questionSchema),
                  minItems: questions.length,
                  maxItems: questions.length,
                },
              },
              required: ["answers"],
              additionalProperties: false,
            },
            metadata: {
              "aos.kind": "questions",
              "aos.scope": "run",
              "aos.questionCount": questions.length,
              ...(questions.some(({ locked }) => locked)
                ? {
                    "aos.lockedAnswerIndexes": questions.flatMap(
                      ({ locked }, index) => (locked ? [index] : [])
                    ),
                  }
                : {}),
            },
          },
        ],
      }
      const remembered = this.#remember({
        kind: "questions",
        scope,
        liveSessionId,
        id: requestId,
        questions,
        outcome,
      })
      this.#live.set(sessionKey(scope), { scope: { ...scope }, liveSessionId })
      return remembered
    }
    const id = validString(event.payload.request_id, 256)
    const message = validString(
      event.payload.message ??
        event.payload.command ??
        event.payload.description
    )
    if (!id || !message) invalidNative()
    const choices = approvalChoices(event.payload)
    if (choices.length === 0) invalidNative()
    const choiceScopes = Object.fromEntries(
      choices.map((choice) => [
        choice,
        choice === "session"
          ? "session"
          : choice === "always"
            ? "agent"
            : "request",
      ])
    )
    const outcome: RunFinishedInterruptOutcome = {
      type: "interrupt",
      interrupts: [
        {
          id,
          reason: "approval",
          message: publicText(message),
          responseSchema: { type: "string", enum: choices },
          metadata: {
            "aos.kind": "approval",
            "aos.scope": "run",
            "aos.choiceScopes": choiceScopes,
          },
        },
      ],
    }
    const remembered = this.#remember({
      kind: "approval",
      scope,
      liveSessionId,
      id,
      choices,
      outcome,
    })
    this.#live.set(sessionKey(scope), { scope: { ...scope }, liveSessionId })
    return remembered
  }

  pending(scope: HermesInteractionScope) {
    return [...this.#pending.values()]
      .filter((interaction) => sameScope(interaction.scope, scope))
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ outcome }) => outcome)
  }

  async respond(
    scope: HermesInteractionScope,
    candidate: unknown
  ): Promise<HermesInteractionResult> {
    const resume = strictResume(candidate)
    const key = interactionKey(scope, resume.interruptId)
    const completed = this.#completed.get(key)
    const responseFingerprint = JSON.stringify([
      resume.status,
      resume.payload ?? null,
    ])
    if (completed) {
      if (
        completed.fingerprint !== undefined &&
        completed.fingerprint !== responseFingerprint
      )
        throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
      return completed.result
    }
    const interaction = this.#pending.get(key)
    if (!interaction || !sameScope(interaction.scope, scope))
      throw new HermesInteractionPublicError("AOS_INTERACTION_NOT_FOUND")
    if (interaction.state === "dispatching") return { status: "in-progress" }

    let calls: ReadonlyArray<{
      method: string
      params: Readonly<Record<string, unknown>>
    }>
    if (interaction.kind === "approval") {
      const choice = resume.status === "cancelled" ? "deny" : resume.payload
      if (
        typeof choice !== "string" ||
        !interaction.choices.includes(choice as ApprovalChoice)
      )
        throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
      calls = [
        {
          method: "approval.respond",
          params: {
            session_id: interaction.liveSessionId,
            request_id: interaction.id,
            choice,
          },
        },
      ]
    } else if (resume.status === "cancelled") {
      calls = [
        {
          method: "clarify.respond",
          params: {
            session_id: interaction.liveSessionId,
            request_id: interaction.id,
            answer: "",
          },
        },
      ]
    } else {
      const answers = answerSets(resume.payload, interaction.questions)
      calls = interaction.questions.flatMap((question, index) => {
        if (answers[index]?.lockedUnchanged) return []
        return [
          {
            method: "clarify.respond",
            params: {
              session_id: interaction.liveSessionId,
              request_id: interaction.id,
              ...(question.id ? { question_id: question.id } : {}),
              answer: question.multiple
                ? JSON.stringify(answers[index]?.values)
                : (answers[index]?.values[0] ?? ""),
            },
          },
        ]
      })
    }

    interaction.state = "dispatching"
    interaction.responseFingerprint = responseFingerprint
    try {
      let expired = false
      for (const call of calls) {
        const result = await this.transport.request(call.method, call.params)
        if (!boundedJson(result)) throw new Error("invalid response")
        if (interaction.kind === "approval") {
          if (!validApprovalResult(result)) throw new Error("invalid response")
          expired = (result as { resolved: number }).resolved === 0
        } else {
          if (!validClarifyResult(result)) throw new Error("invalid response")
          expired ||= (result as { status: string }).status === "expired"
          if (expired) break
        }
      }
      const outcome: HermesInteractionResult = {
        status: expired ? "expired" : "resolved",
      }
      this.#pending.delete(key)
      this.#complete(key, outcome, responseFingerprint)
      return outcome
    } catch {
      const outcome: HermesInteractionResult = { status: "uncertain" }
      this.#pending.delete(key)
      this.#complete(key, outcome, responseFingerprint)
      return outcome
    }
  }

  async resume(scope: HermesInteractionScope) {
    const reconciliationKey = sessionKey(scope)
    const generation = (this.#resumeGenerations.get(reconciliationKey) ?? 0) + 1
    this.#resumeGenerations.set(reconciliationKey, generation)
    let result: unknown
    try {
      result = await this.transport.request("session.resume", {
        session_id: scope.sessionId,
        profile: scope.agentId,
        omit_messages: true,
      })
    } catch {
      throw new HermesInteractionPublicError("AOS_PROVIDER_UNAVAILABLE")
    }
    if (this.#resumeGenerations.get(reconciliationKey) !== generation)
      throw new HermesInteractionPublicError("AOS_RECONCILIATION_STALE")
    if (!boundedJson(result) || !isRecord(result)) invalidNative()
    const liveSessionId = validString(result.session_id, 512)
    if (
      !liveSessionId ||
      typeof result.running !== "boolean" ||
      (result.status !== undefined && typeof result.status !== "string") ||
      (result.pending_approval !== undefined &&
        result.pending_approval !== null &&
        !isRecord(result.pending_approval)) ||
      (result.pending_clarify !== undefined &&
        result.pending_clarify !== null &&
        !isRecord(result.pending_clarify))
    )
      invalidNative()

    const pendingSnapshot = new Map(this.#pending)
    const completedSnapshot = new Map(this.#completed)
    const liveSnapshot = new Map(this.#live)
    const reactionsSnapshot = new Map(this.#reactions)
    const reactionTargetsSnapshot = new Map(this.#reactionTargets)
    const interrupts = []
    try {
      for (const [key, interaction] of this.#pending) {
        if (sameScope(interaction.scope, scope)) this.#pending.delete(key)
      }
      const existingLive = this.#live.get(sessionKey(scope))
      if (existingLive && existingLive.liveSessionId !== liveSessionId)
        this.#clearReactionState(scope)
      this.#live.set(sessionKey(scope), { scope: { ...scope }, liveSessionId })
      if (isRecord(result.pending_approval)) {
        const requestId = validString(result.pending_approval.request_id, 256)
        if (requestId) this.#completed.delete(interactionKey(scope, requestId))
        const outcome = this.acceptNative(scope, liveSessionId, {
          type: "approval.request",
          session_id: liveSessionId,
          payload: result.pending_approval,
        })
        if (outcome && "interrupts" in outcome)
          interrupts.push(...outcome.interrupts)
      }
      if (isRecord(result.pending_clarify)) {
        const requestId = validString(result.pending_clarify.request_id, 256)
        if (requestId) this.#completed.delete(interactionKey(scope, requestId))
        const outcome = this.acceptNative(scope, liveSessionId, {
          type: "clarify.request",
          session_id: liveSessionId,
          payload: result.pending_clarify,
        })
        if (outcome && "interrupts" in outcome)
          interrupts.push(...outcome.interrupts)
      }
    } catch (error) {
      this.#pending.clear()
      for (const entry of pendingSnapshot) this.#pending.set(...entry)
      this.#completed.clear()
      for (const entry of completedSnapshot) this.#completed.set(...entry)
      this.#live.clear()
      for (const entry of liveSnapshot) this.#live.set(...entry)
      this.#reactions.clear()
      for (const entry of reactionsSnapshot) this.#reactions.set(...entry)
      this.#reactionTargets.clear()
      for (const entry of reactionTargetsSnapshot)
        this.#reactionTargets.set(...entry)
      throw error
    }
    return {
      running: result.running,
      status: interrupts.length
        ? ("waiting-for-input" as const)
        : result.running
          ? ("running" as const)
          : result.status === "idle"
            ? ("idle" as const)
            : ("unknown" as const),
      ...(interrupts.length
        ? {
            outcome: {
              type: "interrupt" as const,
              interrupts,
            },
          }
        : {}),
    }
  }

  async react(
    scope: HermesInteractionScope,
    candidate: unknown
  ): Promise<HermesReactionResult> {
    if (!isRecord(candidate) || !boundedJson(candidate))
      throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
    const allowed = new Set(["operationId", "messageId", "emoji"])
    if (Object.keys(candidate).some((key) => !allowed.has(key)))
      throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
    const operationId = validString(candidate.operationId, 256)
    const messageId = validString(candidate.messageId, 256)
    const match = messageId?.match(/^hermes-row-([1-9]\d*)$/u)
    const rowId = match ? Number(match[1]) : Number.NaN
    const emoji =
      candidate.emoji === null
        ? null
        : validString(
            candidate.emoji,
            HERMES_INTERACTION_LIMITS.maxReactionBytes
          )
    if (
      !operationId ||
      !messageId ||
      !Number.isSafeInteger(rowId) ||
      rowId <= 0 ||
      emoji === undefined
    )
      throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
    const binding = this.#live.get(sessionKey(scope))
    if (!binding || !sameScope(binding.scope, scope))
      throw new HermesInteractionPublicError("AOS_INTERACTION_NOT_FOUND")
    if (!this.#reactionTargets.get(sessionKey(scope))?.has(messageId))
      throw new HermesInteractionPublicError("AOS_INTERACTION_NOT_FOUND")

    const key = interactionKey(scope, `reaction:${operationId}`)
    const fingerprint = JSON.stringify([messageId, emoji])
    const existing = this.#reactions.get(key)
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
      if (existing.result) return existing.result
      if (existing.promise) return existing.promise
    }
    const record: ReactionRecord = { scope: { ...scope }, fingerprint }
    const operation = (async (): Promise<HermesReactionResult> => {
      try {
        const native = await this.transport.request("message.react", {
          session_id: binding.liveSessionId,
          row_id: rowId,
          emoji,
          author: "user",
        })
        if (
          !boundedJson(native) ||
          !isRecord(native) ||
          native.row_id !== rowId ||
          !Array.isArray(native.reactions) ||
          native.reactions.length > 2
        )
          throw new Error("invalid response")
        const reactions = native.reactions.map((reaction) => {
          if (!isRecord(reaction)) throw new Error("invalid response")
          const projectedEmoji = validString(
            reaction.emoji,
            HERMES_INTERACTION_LIMITS.maxReactionBytes
          )
          if (
            !projectedEmoji ||
            (reaction.author !== "user" && reaction.author !== "agent") ||
            typeof reaction.at !== "number" ||
            !Number.isFinite(reaction.at) ||
            reaction.at < 0
          )
            throw new Error("invalid response")
          return {
            emoji: projectedEmoji,
            author: reaction.author as "user" | "agent",
            at: reaction.at,
          }
        })
        reactions.sort(
          (left, right) =>
            left.at - right.at ||
            (left.author === right.author
              ? left.emoji.localeCompare(right.emoji)
              : left.author === "user"
                ? -1
                : 1)
        )
        return { status: "resolved", messageId, reactions }
      } catch {
        return { status: "uncertain", messageId }
      }
    })()
    record.promise = operation
    this.#reactions.set(key, record)
    const projected = await operation
    record.result = projected
    delete record.promise
    while (this.#reactions.size > HERMES_INTERACTION_LIMITS.maxPending * 2) {
      const oldest = this.#reactions.keys().next().value
      if (oldest === undefined) break
      this.#reactions.delete(oldest)
    }
    return projected
  }

  capabilities() {
    return {
      approvals: {
        status: "available" as const,
        protocol: "ag-ui-interrupt" as const,
        scope: "run" as const,
        choices: [
          { value: "once" as const, scope: "request" as const },
          { value: "session" as const, scope: "session" as const },
          { value: "always" as const, scope: "agent" as const },
          { value: "deny" as const, scope: "request" as const },
        ],
        maxPending: HERMES_INTERACTION_LIMITS.maxPending,
      },
      questions: {
        status: "available" as const,
        protocol: "ag-ui-interrupt" as const,
        scope: "run" as const,
        answerModes: ["single", "multiple", "free-text"] as const,
        cancellation: "native-empty-answer" as const,
        maxQuestions: HERMES_INTERACTION_LIMITS.maxQuestions,
        maxChoicesPerQuestion: HERMES_INTERACTION_LIMITS.maxChoicesPerQuestion,
        maxAnswerValuesPerQuestion:
          HERMES_INTERACTION_LIMITS.maxAnswerValuesPerQuestion,
        maxStringBytes: HERMES_INTERACTION_LIMITS.maxStringBytes,
      },
      reactions: {
        status: "available" as const,
        scope: "persisted-message" as const,
        semantics: "one-per-author-toggle" as const,
        author: "user" as const,
        choices: ["❤️", "👍", "👎", "😂", "‼️", "❓"] as const,
        custom: true as const,
        maxEmojiBytes: HERMES_INTERACTION_LIMITS.maxReactionBytes,
        maxAuthorizedTargets: HERMES_INTERACTION_LIMITS.maxReactionTargets,
        targetAuthorization: "trusted-history-projection" as const,
        idempotency: {
          status: "limited" as const,
          scope: "proxy-process" as const,
          reason: "native-toggle-has-no-idempotency-key" as const,
        },
        liveMessage: {
          status: "unavailable" as const,
          reason: "stable-message-id-required" as const,
        },
      },
    }
  }

  authorizeReactionTargets(
    scope: HermesInteractionScope,
    messageIds: readonly string[]
  ) {
    if (
      !Array.isArray(messageIds) ||
      messageIds.length > HERMES_INTERACTION_LIMITS.maxReactionTargets
    )
      throw new HermesInteractionPublicError("AOS_LIMIT_EXCEEDED")
    const targets = new Set<string>()
    for (const candidate of messageIds) {
      const messageId = validString(candidate, 256)
      const match = messageId?.match(/^hermes-row-([1-9]\d*)$/u)
      if (
        !messageId ||
        !match ||
        !Number.isSafeInteger(Number(match[1])) ||
        targets.has(messageId)
      )
        throw new HermesInteractionPublicError("AOS_PROVIDER_INVALID_RESPONSE")
      targets.add(messageId)
    }
    this.#reactionTargets.set(sessionKey(scope), targets)
  }

  #clearReactionState(scope: HermesInteractionScope) {
    this.#reactionTargets.delete(sessionKey(scope))
    for (const [key, record] of this.#reactions) {
      if (sameScope(record.scope, scope)) this.#reactions.delete(key)
    }
  }

  #complete(
    key: string,
    result: HermesInteractionResult,
    fingerprint?: string
  ) {
    this.#completed.set(key, {
      fingerprint,
      result:
        result.status === "resolved" ? { status: "already-resolved" } : result,
    })
    while (this.#completed.size > HERMES_INTERACTION_LIMITS.maxPending * 2) {
      const oldest = this.#completed.keys().next().value
      if (oldest === undefined) break
      this.#completed.delete(oldest)
    }
  }
}
