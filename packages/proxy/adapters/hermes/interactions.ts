/**
 * Hermes asks the user through server→client JSON-RPC requests: the backend
 * writes one `clarify` / `approval` frame and parks the agent until the
 * renderer answers that very frame (`tui_gateway/server_requests.py`). AOS is
 * that renderer, so this module owns exactly one `onRequest` handler and one
 * `request.cancel` subscription, projects a recognized request into the AG-UI
 * interrupt the browser already renders, and answers through the request handle
 * the vendored channel hands it.
 *
 * A request whose method AOS cannot render is claimed and never answered: the
 * prompt belongs to whichever Hermes renderer raised it, and `-32601` would
 * cancel it — on every reconnect, because `open_requests` are re-delivered. Only
 * a request AOS can render but cannot use (no bound Session, an unusable
 * payload) is declined, which Hermes treats as "skipped" for a clarify and as
 * "unanswered" for a queue backed approval, so the agent proceeds instead of
 * waiting out its 300 s deadline. Native ids, commands, URLs and paths never
 * reach public output.
 */
import { INTERACTION_PROTOCOL } from "../../../protocol"
import type { RunInterruptOutcome } from "../../core/events"

import {
  JSON_RPC_METHOD_NOT_FOUND,
  type HermesLog,
  type ServerRequest,
} from "./gateway"
import {
  isRecord,
  nativeId,
  parseJson,
  publicReason,
  sessionKey,
  utf8BytesWithin,
} from "./native"

/**
 * The run scope an interaction belongs to. `threadId` travels with it for the
 * caller's benefit; interactions themselves are Session-scoped, because a
 * Hermes Session carries exactly one thread.
 */
export type HermesInteractionScope = {
  agentId: string
  sessionId: string
  threadId: string
}

/**
 * The gateway surface interactions own. Answering is synchronous on the socket
 * that carried the request, so liveness is part of the contract: a write onto a
 * dead socket is swallowed and would report an answer Hermes never received.
 */
export type HermesInteractionTransport = {
  onRequest(handler: (request: ServerRequest) => boolean | void): () => void
  onEvent(listener: (event: unknown) => void): () => void
  connected(): boolean
}

/**
 * The durable-to-live binding surface. `session_id` on a server request is a
 * volatile live Hermes Session id, so only the registry can say which durable
 * Session (and therefore which user) it belongs to.
 */
export type HermesInteractionAttachments = {
  ensure(
    scope: HermesInteractionScope,
    options?: { refresh?: boolean }
  ): Promise<{ liveSessionId: string; running: boolean }>
  retain(scope: HermesInteractionScope, reason: string): Promise<() => void>
  scopeFor(liveSessionId: string): HermesInteractionScope | undefined
}

// ---------------------------------------------------------------------------
// Upstream contract shapes
// ---------------------------------------------------------------------------

/*
 * The six shapes AOS answers, copied from `apps/shared/src/
 * gateway-contract.generated.ts` at pin
 * NousResearch/hermes-agent@47685348eaca9d673719003b9e03a71becfa6423. The
 * generated contract is 176 KB of unrelated methods and is deliberately not
 * vendored. Hermes owns the wire, so every field is validated before use; the
 * declarations only name the upstream field set.
 */

type ClarifyQuestion = {
  qid: string
  question: string
  choices?: string[] | null
  multi_select?: boolean
}

/** Single question: `question`/`choices`; batch: `questions`. `answers` rides only on a reconnect replay. */
type ClarifyRequestParams = {
  session_id: string
  question?: string | null
  choices?: string[] | null
  multi_select?: boolean | null
  questions?: ClarifyQuestion[] | null
  answers?: Record<string, string> | null
}

/** Single: `{answer}` ('' = skip). Batch: `{answers}`; neither member = cancel-all. */
type ClarifyResult = {
  answer?: string
  answers?: Record<string, string>
}

type ApprovalRequestParams = {
  session_id: string
  request_id: string
  command?: string
  description?: string
  choices?: ApprovalChoice[]
  allow_permanent?: boolean | null
  allow_session?: boolean | null
  smart_denied?: boolean | null
  tool_name?: string | null
}

type ApprovalResult = { choice: ApprovalChoice; all?: boolean }

type RequestCancelPayload = { id: string; method: string; reason: string }

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

const APPROVAL_CHOICES = ["once", "session", "always", "deny"] as const
type ApprovalChoice = (typeof APPROVAL_CHOICES)[number]

/** Choices whose answer applies past this one request (`ApprovalResult.all`). */
const BROAD_APPROVAL_CHOICES = new Set<ApprovalChoice>(["session", "always"])

/** The server→client requests AOS renders; everything else is held unanswered. */
const ANSWERED_METHODS = ["clarify", "approval"] as const
type AnsweredMethod = (typeof ANSWERED_METHODS)[number]

export const HERMES_INTERACTION_LIMITS = Object.freeze({
  maxNativePayloadBytes: 65_536,
  maxDepth: 8,
  maxQuestions: 32,
  maxChoicesPerQuestion: 64,
  maxAnswerValuesPerQuestion: 64,
  maxStringBytes: 4_096,
  maxPending: 64,
})

/** Bound for the per-method log: Hermes chooses both method and volume. */
const MAX_LOGGED_METHODS = 32
const MAX_LOGGED_METHOD_CHARS = 64

export class HermesInteractionPublicError extends Error {
  constructor(
    readonly code:
      | "AOS_INVALID_INTERACTION"
      | "AOS_INTERACTION_NOT_FOUND"
      | "AOS_LIMIT_EXCEEDED"
      | "AOS_PROVIDER_INVALID_RESPONSE"
      | "AOS_PROVIDER_UNAVAILABLE"
  ) {
    super(
      code === "AOS_PROVIDER_INVALID_RESPONSE"
        ? "Hermes returned invalid interaction data"
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
  /** Public projection of an answer Hermes already locked, for the schema default. */
  locked?: string[]
  /** The exact native values behind `locked`; a redaction must never be answered. */
  lockedNative?: string[]
}

type PendingInteraction = {
  scope: HermesInteractionScope
  liveSessionId: string
  id: string
  sequence: number
  outcome: RunInterruptOutcome
  /** The live handle Hermes waits on; a re-delivery replaces it. */
  request: ServerRequest
  /** The reconciliation Hermes last confirmed this request was open in. */
  confirmed: number
} & (
  | { kind: "approval"; choices: ApprovalChoice[] }
  | { kind: "questions"; questions: Question[] }
)

/** A projected request, before it is bound to a live Session and remembered. */
type ProjectedInteraction =
  | {
      kind: "approval"
      choices: ApprovalChoice[]
      outcome: RunInterruptOutcome
    }
  | {
      kind: "questions"
      questions: Question[]
      outcome: RunInterruptOutcome
    }

export type HermesInteractionResult = {
  status: "resolved" | "expired" | "already-resolved" | "uncertain"
}

export type HermesInteractionResumeSnapshot = {
  running: boolean
  status: "waiting-for-input" | "running" | "idle"
  outcome?: RunInterruptOutcome
}

export type HermesInterruptListener = (
  outcome: RunInterruptOutcome
) => void

// ---------------------------------------------------------------------------
// Native validation and public projection
// ---------------------------------------------------------------------------

function validString(
  value: unknown,
  max: number = HERMES_INTERACTION_LIMITS.maxStringBytes
) {
  return typeof value === "string" &&
    value.trim() &&
    utf8BytesWithin(value, max) !== undefined
    ? value.trim()
    : undefined
}

function nativeText(
  value: unknown,
  max: number = HERMES_INTERACTION_LIMITS.maxStringBytes,
  allowEmpty = false
) {
  return typeof value === "string" &&
    utf8BytesWithin(value, max) !== undefined &&
    (allowEmpty || value.length > 0)
    ? value
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
      return (
        utf8BytesWithin(
          item,
          HERMES_INTERACTION_LIMITS.maxNativePayloadBytes
        ) !== undefined
      )
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
      utf8BytesWithin(
        JSON.stringify(value),
        HERMES_INTERACTION_LIMITS.maxNativePayloadBytes
      ) !== undefined
    )
  } catch {
    return false
  }
}

/** A request field AOS cannot use: the caller declines the whole request. */
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
  const choices = value.map((choice) =>
    nativeText(choice, HERMES_INTERACTION_LIMITS.maxStringBytes, true)
  )
  if (choices.some((choice) => choice === undefined)) return undefined
  const normalized = choices as string[]
  return new Set(normalized).size === normalized.length ? normalized : undefined
}

/** Validate `ClarifyRequestParams` into the ordered questions AOS renders. */
function parseQuestions(params: ClarifyRequestParams) {
  let questions: Question[]
  if (Array.isArray(params.questions)) {
    if (
      params.questions.length === 0 ||
      params.questions.length > HERMES_INTERACTION_LIMITS.maxQuestions
    )
      invalidNative()
    questions = params.questions.map((candidate) => {
      if (!isRecord(candidate)) invalidNative()
      const id = validString(candidate.qid, 256)
      const question = nativeText(candidate.question)
      const nativeChoices = parseChoices(candidate.choices)
      if (
        !id ||
        !question ||
        nativeChoices === undefined ||
        (candidate.multi_select !== undefined &&
          typeof candidate.multi_select !== "boolean")
      )
        invalidNative()
      return {
        id,
        question: publicText(question),
        choices: publicChoices(nativeChoices),
        nativeChoices,
        multiple: candidate.multi_select === true,
      }
    })
    if (new Set(questions.map(({ id }) => id)).size !== questions.length)
      invalidNative()
  } else {
    const question = nativeText(params.question)
    const nativeChoices = parseChoices(params.choices)
    if (!question || nativeChoices === undefined) invalidNative()
    questions = [
      {
        question: publicText(question),
        choices: publicChoices(nativeChoices),
        nativeChoices,
        multiple: params.multi_select === true,
      },
    ]
  }
  if (params.answers !== undefined && params.answers !== null)
    lockAnswers(params.answers, questions)
  return questions
}

/**
 * `answers` carries the batch answers Hermes locked before this delivery (only
 * a reconnect replay has them). They become the schema defaults, and their
 * exact native values are kept so a redacted default is never answered back.
 */
function lockAnswers(answers: unknown, questions: Question[]) {
  if (!isRecord(answers) || !questions.every(({ id }) => id)) invalidNative()
  for (const [questionId, encoded] of Object.entries(answers)) {
    const question = questions.find(({ id }) => id === questionId)
    if (
      !question ||
      typeof encoded !== "string" ||
      utf8BytesWithin(encoded, HERMES_INTERACTION_LIMITS.maxStringBytes) ===
        undefined
    )
      invalidNative()
    let nativeAnswers: string[]
    if (question.multiple) {
      // A native answer list that is not JSON parses to `undefined`, which the
      // array check below rejects like any other invalid shape.
      const parsed = parseJson(encoded)
      if (
        !Array.isArray(parsed) ||
        parsed.some(
          (answer) =>
            nativeText(
              answer,
              HERMES_INTERACTION_LIMITS.maxStringBytes,
              true
            ) === undefined
        )
      )
        invalidNative()
      nativeAnswers = parsed as string[]
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

/** Project a validated `clarify` request as the existing question interrupt. */
function clarifyInteraction(
  id: string,
  params: ClarifyRequestParams
): ProjectedInteraction {
  const questions = parseQuestions(params)
  return {
    kind: "questions",
    questions,
    outcome: {
      type: "interrupt",
      interrupts: [
        {
          id,
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
    },
  }
}

function approvalChoices(params: ApprovalRequestParams): ApprovalChoice[] {
  const native: ApprovalChoice[] = Array.isArray(params.choices)
    ? params.choices.filter((choice): choice is ApprovalChoice =>
        APPROVAL_CHOICES.includes(choice as ApprovalChoice)
      )
    : params.smart_denied === true
      ? (["once", "deny"] as ApprovalChoice[])
      : [...APPROVAL_CHOICES]
  return native.filter(
    (choice, index) =>
      (choice !== "always" || params.allow_permanent !== false) &&
      native.indexOf(choice) === index
  )
}

/** Project a validated `approval` request as the existing approval interrupt. */
function approvalInteraction(
  id: string,
  params: ApprovalRequestParams
): ProjectedInteraction {
  const message =
    validString(params.command ?? params.description) ??
    "Hermes is requesting permission to continue."
  const choices = approvalChoices(params)
  if (choices.length === 0) invalidNative()
  return {
    kind: "approval",
    choices,
    outcome: {
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
            "aos.choiceScopes": Object.fromEntries(
              choices.map((choice) => [
                choice,
                choice === "session"
                  ? "session"
                  : choice === "always"
                    ? "agent"
                    : "request",
              ])
            ),
          },
        },
      ],
    },
  }
}

function cancellation(event: Record<string, unknown>) {
  const payload = event.payload
  if (!isRecord(payload)) return undefined
  const id = nativeId(payload.id, 256)
  const method = validString(payload.method, 64)
  if (!id || !method) return undefined
  return { id, method, reason: validString(payload.reason, 256) ?? "" }
}

// ---------------------------------------------------------------------------
// Public response validation
// ---------------------------------------------------------------------------

/**
 * A Hermes Session carries exactly one thread, so every interaction key is the
 * Session key retainers, listeners and resumes already use: keying a pending
 * request by `threadId` as well would let one of the two release the other's
 * binding.
 */
function sameSession(
  left: HermesInteractionScope,
  right: HermesInteractionScope
) {
  return sessionKey(left) === sessionKey(right)
}

function interactionKey(scope: HermesInteractionScope, id: string) {
  return `${sessionKey(scope)}\u0000${id}`
}

function strictResume(value: unknown) {
  if (!isRecord(value))
    throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
  const allowed = new Set(["interruptId", "status", "payload", "metadata"])
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
  if (value.metadata !== undefined && !isRecord(value.metadata))
    throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
  return {
    interruptId,
    status: value.status as "resolved" | "cancelled",
    payload: value.payload,
  }
}

/** The native values one ordered public answer set stands for. */
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
    const answers = candidate.map((answer) =>
      nativeText(answer, HERMES_INTERACTION_LIMITS.maxStringBytes, true)
    )
    if (
      answers.some((answer) => answer === undefined) ||
      new Set(answers).size !== answers.length ||
      (question.choices &&
        answers.some((answer) => !question.choices!.includes(answer!)))
    )
      throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
    const publicAnswers = answers as string[]
    // An unchanged locked answer is answered with the value Hermes locked: its
    // public form may be a redaction of a credential or a path.
    if (
      question.lockedNative &&
      question.locked &&
      JSON.stringify(question.locked) === JSON.stringify(publicAnswers)
    )
      return question.lockedNative
    return publicAnswers.map((answer) => {
      if (!question.choices || !question.nativeChoices) return answer
      return question.nativeChoices[question.choices.indexOf(answer)]!
    })
  })
}

/**
 * One question's answer in wire form. A multi-select answer is a JSON array
 * wherever it rides: Hermes parses the single and the batch answer through the
 * same `_parse_multi_select_response` (`tools/clarify_tool.py`), so dropping
 * the encoding on one path would answer with a single value and discard the
 * rest of the selection.
 */
function encodedAnswer(question: Question, values: string[] | undefined) {
  return question.multiple ? JSON.stringify(values ?? []) : (values?.[0] ?? "")
}

/** The `clarify` response for one validated public answer, in wire form. */
function clarifyResult(
  interaction: Extract<PendingInteraction, { kind: "questions" }>,
  resume: { status: "resolved" | "cancelled"; payload: unknown }
): ClarifyResult {
  const batch = interaction.questions.every(({ id }) => id !== undefined)
  // Hermes' own cancellation: an empty answer skips a single question, and a
  // batch response without `answers` cancels every question in it.
  if (resume.status === "cancelled") return batch ? {} : { answer: "" }
  const answers = answerSets(resume.payload, interaction.questions)
  if (!batch)
    return { answer: encodedAnswer(interaction.questions[0]!, answers[0]) }
  return {
    answers: Object.fromEntries(
      interaction.questions.map((question, index) => [
        question.id!,
        encodedAnswer(question, answers[index]),
      ])
    ),
  }
}

/** The `approval` response for one validated public choice, in wire form. */
function approvalResult(
  interaction: Extract<PendingInteraction, { kind: "approval" }>,
  resume: { status: "resolved" | "cancelled"; payload: unknown }
): ApprovalResult {
  const choice = resume.status === "cancelled" ? "deny" : resume.payload
  if (
    typeof choice !== "string" ||
    !interaction.choices.includes(choice as ApprovalChoice)
  )
    throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
  const selected = choice as ApprovalChoice
  return {
    choice: selected,
    // `session` and `always` are answers about more than this one request.
    ...(BROAD_APPROVAL_CHOICES.has(selected) ? { all: true } : {}),
  }
}

// ---------------------------------------------------------------------------
// HermesInteractions
// ---------------------------------------------------------------------------

export class HermesInteractions {
  readonly #pending = new Map<string, PendingInteraction>()
  readonly #completed = new Map<
    string,
    { fingerprint?: string; result: HermesInteractionResult }
  >()
  readonly #listeners = new Map<string, Set<HermesInterruptListener>>()
  /**
   * Requests whose live Session id was not bound yet. `open_requests` are
   * re-delivered before the `session.resume` that carried them resolves, so the
   * registry has not learned the id at delivery time; each is settled as soon
   * as it can be, and refused if it never can.
   */
  readonly #deferred = new Map<
    string,
    { request: ServerRequest; timer: ReturnType<typeof setTimeout> }
  >()
  /**
   * One attachment retainer per Session with something pending: Hermes may not
   * have the live Session closed under a request that is still waiting.
   */
  readonly #retainers = new Map<string, Promise<() => void>>()
  /**
   * Sessions with a `resume()` in flight, by depth. Its own re-deliveries ride
   * the snapshot it returns to the caller, so they raise no interrupt; every
   * other re-delivery (a heal, a catch-up) is the first the run hears of that
   * request and must be notified.
   */
  readonly #resuming = new Map<string, number>()
  readonly #loggedMethods = new Set<string>()
  /** Reconciliation counter: what a pending request's `confirmed` is stamped with. */
  #reconciliation = 0
  readonly #stopRequests: () => void
  readonly #stopEvents: () => void
  readonly #log: HermesLog | undefined
  #sequence = 0

  constructor(
    private readonly transport: HermesInteractionTransport,
    private readonly attachments: HermesInteractionAttachments,
    options: { log?: HermesLog } = {}
  ) {
    this.#log = options.log
    this.#stopRequests = transport.onRequest((request) =>
      this.#deliver(request)
    )
    this.#stopEvents = transport.onEvent((event) => this.#observe(event))
  }

  /** Release both gateway subscriptions, every parked request and retainer. */
  close() {
    this.#stopRequests()
    this.#stopEvents()
    for (const { timer } of this.#deferred.values()) clearTimeout(timer)
    this.#deferred.clear()
    this.#listeners.clear()
    for (const held of [...this.#retainers.values()])
      void held.then((release) => release())
    this.#retainers.clear()
  }

  /** Every interrupt still waiting for this Session, oldest first. */
  pending(scope: HermesInteractionScope) {
    return [...this.#pending.values()]
      .filter((interaction) => sameSession(interaction.scope, scope))
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ outcome }) => outcome)
  }

  /** Notify the run observing this Session of every live interrupt. */
  onInterrupt(
    scope: HermesInteractionScope,
    listener: HermesInterruptListener
  ) {
    const key = sessionKey(scope)
    const listeners = this.#listeners.get(key) ?? new Set()
    this.#listeners.set(key, listeners)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#listeners.delete(key)
    }
  }

  async respond(
    scope: HermesInteractionScope,
    candidate: unknown
  ): Promise<HermesInteractionResult> {
    const resume = strictResume(candidate)
    const key = interactionKey(scope, resume.interruptId)
    const fingerprint = JSON.stringify([resume.status, resume.payload ?? null])
    const completed = this.#completed.get(key)
    if (completed) {
      if (
        completed.fingerprint !== undefined &&
        completed.fingerprint !== fingerprint
      )
        throw new HermesInteractionPublicError("AOS_INVALID_INTERACTION")
      return completed.result
    }
    const interaction = this.#pending.get(key)
    if (!interaction)
      throw new HermesInteractionPublicError("AOS_INTERACTION_NOT_FOUND")
    const result: ClarifyResult | ApprovalResult =
      interaction.kind === "approval"
        ? approvalResult(interaction, resume)
        : clarifyResult(interaction, resume)
    // The handle writes synchronously and swallows a dead socket, so an answer
    // written now would be lost silently. Keep the card: a reconnect
    // re-delivers the request and the user can answer it again.
    if (!this.transport.connected()) return { status: "uncertain" }
    interaction.request.respond(result)
    this.#pending.delete(key)
    this.#complete(key, { status: "resolved" }, fingerprint)
    this.#release(interaction.scope)
    return { status: "resolved" }
  }

  /**
   * Reconcile this Session against Hermes and report what is waiting on it. The
   * refreshed binding is the registry's single-flight `session.resume`, whose
   * `open_requests` are re-delivered to the request handler before it resolves:
   * Hermes lists exactly what is still open, so a request it no longer lists is
   * expired here.
   */
  async resume(
    scope: HermesInteractionScope
  ): Promise<HermesInteractionResumeSnapshot> {
    const reconciliation = ++this.#reconciliation
    const key = sessionKey(scope)
    this.#resuming.set(key, (this.#resuming.get(key) ?? 0) + 1)
    try {
      let attachment: { liveSessionId: string; running: boolean }
      try {
        attachment = await this.attachments.ensure(scope, { refresh: true })
      } catch {
        throw new HermesInteractionPublicError("AOS_PROVIDER_UNAVAILABLE")
      }
      this.#settleDeferred()
      this.#expireUnconfirmed(scope, reconciliation)
      const interrupts = this.pending(scope).flatMap(
        ({ interrupts: pending }) => pending
      )
      return {
        running: attachment.running,
        status: interrupts.length
          ? ("waiting-for-input" as const)
          : attachment.running
            ? ("running" as const)
            : ("idle" as const),
        ...(interrupts.length
          ? { outcome: { type: "interrupt" as const, interrupts } }
          : {}),
      }
    } finally {
      const depth = (this.#resuming.get(key) ?? 1) - 1
      if (depth > 0) this.#resuming.set(key, depth)
      else this.#resuming.delete(key)
    }
  }

  capabilities() {
    return {
      approvals: {
        status: "available" as const,
        protocol: INTERACTION_PROTOCOL,
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
        protocol: INTERACTION_PROTOCOL,
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
        status: "unavailable" as const,
        reason: "native-reaction-operation-unavailable" as const,
      },
    }
  }

  // -------------------------------------------------------------------------
  // Server requests
  // -------------------------------------------------------------------------

  /**
   * The one `onRequest` handler. Returning `false` declines: the vendored
   * channel answers `-32601`, which Hermes reads as a skipped question rather
   * than a client that will answer later. A method AOS cannot render is
   * therefore claimed instead: whichever renderer raised that prompt is still
   * waiting on it, and AOS may not cancel it on that user's behalf.
   */
  #deliver(request: ServerRequest): boolean {
    const method = ANSWERED_METHODS.find(
      (candidate) => candidate === request.method
    )
    if (!method) return this.#hold(request.method)
    const liveSessionId = nativeId(request.params.session_id, 256)
    if (!liveSessionId) return this.#decline(request.method)
    const scope = this.attachments.scopeFor(liveSessionId)
    if (!scope)
      return request.replayed
        ? this.#defer(request)
        : this.#decline(request.method)
    return this.#present(scope, liveSessionId, method, request)
  }

  /** Remember one recognized request and raise its interrupt exactly once. */
  #present(
    scope: HermesInteractionScope,
    liveSessionId: string,
    method: AnsweredMethod,
    request: ServerRequest
  ): boolean {
    const key = interactionKey(scope, request.id)
    const existing = this.#pending.get(key)
    if (existing) {
      // A re-delivery after a heal answers on the current socket; the card is
      // already up, so the run is not notified again.
      existing.request = request
      existing.liveSessionId = liveSessionId
      existing.confirmed = this.#reconciliation
      return true
    }
    // An answered request is never re-opened by a duplicate live frame; a
    // reconnect that still lists it means the answer never reached Hermes.
    if (this.#completed.has(key)) {
      if (!request.replayed) return true
      this.#completed.delete(key)
    }
    // AOS being full is AOS' own limit, never a reason to cancel a prompt a
    // shared Session's other renderer may still answer; the next resume
    // re-delivers what is still open, so a claimed request can be presented
    // once this Session has room again.
    if (this.#pending.size >= HERMES_INTERACTION_LIMITS.maxPending)
      return this.#hold(method)
    if (!boundedJson(request.params)) return this.#decline(method)
    let projected: ProjectedInteraction
    try {
      projected =
        method === "clarify"
          ? clarifyInteraction(
              request.id,
              request.params as ClarifyRequestParams
            )
          : approvalInteraction(
              request.id,
              request.params as unknown as ApprovalRequestParams
            )
    } catch {
      return this.#decline(method)
    }
    this.#pending.set(key, {
      ...projected,
      scope,
      liveSessionId,
      id: request.id,
      sequence: ++this.#sequence,
      request,
      confirmed: this.#reconciliation,
    })
    this.#retain(scope)
    // A request written while the socket was down reaches AOS only as a
    // re-delivery, so a first delivery raises the interrupt however it arrived.
    // Only this Session's own `resume()` stays quiet: it hands the same
    // interrupt straight back to its caller.
    if (!this.#resuming.has(sessionKey(scope)))
      this.#notify(scope, projected.outcome)
    return true
  }

  /** Park a re-delivered request until the registry has bound its live id. */
  #defer(request: ServerRequest): boolean {
    if (this.#deferred.size >= HERMES_INTERACTION_LIMITS.maxPending)
      return this.#decline(request.method)
    // A macrotask lands after the resume promise chain that carried this
    // request; `resume()` settles it earlier when it is the caller.
    const timer = setTimeout(() => this.#settleDeferred(request.id), 0)
    this.#deferred.set(request.id, { request, timer })
    return true
  }

  #settleDeferred(id?: string) {
    for (const key of id === undefined ? [...this.#deferred.keys()] : [id]) {
      const parked = this.#deferred.get(key)
      if (!parked) continue
      clearTimeout(parked.timer)
      this.#deferred.delete(key)
      const { request } = parked
      const method = ANSWERED_METHODS.find(
        (candidate) => candidate === request.method
      )
      const liveSessionId = nativeId(request.params.session_id, 256)
      const scope = liveSessionId
        ? this.attachments.scopeFor(liveSessionId)
        : undefined
      if (
        method &&
        liveSessionId &&
        scope &&
        this.#present(scope, liveSessionId, method, request)
      )
        continue
      this.#decline(request.method)
      request.fail(
        JSON_RPC_METHOD_NOT_FOUND,
        "AOS has no Session bound to this Hermes request"
      )
    }
  }

  /** One `request.cancel` withdraws the request Hermes stopped waiting on. */
  #observe(event: unknown) {
    if (!isRecord(event) || event.type !== "request.cancel") return
    const liveSessionId = nativeId(event.session_id, 256)
    const cancelled: RequestCancelPayload | undefined = cancellation(event)
    if (!liveSessionId || !cancelled) return
    const parked = this.#deferred.get(cancelled.id)
    if (parked) {
      clearTimeout(parked.timer)
      this.#deferred.delete(cancelled.id)
      return
    }
    const scope = this.attachments.scopeFor(liveSessionId)
    if (!scope) return
    const key = interactionKey(scope, cancelled.id)
    const interaction = this.#pending.get(key)
    if (!interaction || interaction.liveSessionId !== liveSessionId) return
    this.#pending.delete(key)
    this.#complete(key, { status: "expired" })
    this.#release(scope)
  }

  /**
   * Whatever this reconciliation did not re-deliver is no longer open: Hermes
   * answered it elsewhere, cancelled it, or minted a new live Session for which
   * it never existed.
   */
  #expireUnconfirmed(scope: HermesInteractionScope, reconciliation: number) {
    for (const [key, interaction] of [...this.#pending])
      if (
        sameSession(interaction.scope, scope) &&
        interaction.confirmed < reconciliation
      ) {
        this.#pending.delete(key)
        this.#complete(key, { status: "expired" })
      }
    this.#release(scope)
  }

  /** Hold the binding of a Session with a pending request open. */
  #retain(scope: HermesInteractionScope) {
    const key = sessionKey(scope)
    if (this.#retainers.has(key)) return
    this.#retainers.set(
      key,
      this.attachments.retain(scope, "interaction").catch(() => () => undefined)
    )
  }

  /** Release it once nothing waits on that Session any more. */
  #release(scope: HermesInteractionScope) {
    const key = sessionKey(scope)
    const held = this.#retainers.get(key)
    if (
      !held ||
      [...this.#pending.values()].some((interaction) =>
        sameSession(interaction.scope, scope)
      )
    )
      return
    this.#retainers.delete(key)
    void held.then((release) => release())
  }

  #notify(scope: HermesInteractionScope, outcome: RunInterruptOutcome) {
    for (const listener of [...(this.#listeners.get(sessionKey(scope)) ?? [])])
      try {
        listener(outcome)
      } catch (error) {
        this.#log?.warn("hermes.interactions.listener_failed", {
          reason: publicReason(error),
        })
      }
  }

  /** Decline: the vendored channel answers `-32601` on AOS' behalf. */
  #decline(method: string): false {
    this.#logMethod("hermes.interactions.request_declined", method)
    return false
  }

  /**
   * Claim a request AOS cannot render and never answer it. The Session may be
   * shared with Hermes' own renderer, which is still waiting on that prompt.
   */
  #hold(method: string): true {
    this.#logMethod("hermes.interactions.request_unanswered", method)
    return true
  }

  /**
   * Log one line per distinct method and outcome, truncated and bounded: the
   * same method can be declined for one Session and claimed for another, and
   * one line must not hide the other.
   */
  #logMethod(event: string, method: string) {
    const name = method.slice(0, MAX_LOGGED_METHOD_CHARS)
    const key = `${event}\u0000${name}`
    if (
      this.#loggedMethods.has(key) ||
      this.#loggedMethods.size >= MAX_LOGGED_METHODS
    )
      return
    this.#loggedMethods.add(key)
    this.#log?.warn(event, { method: name })
  }

  #complete(
    key: string,
    result: HermesInteractionResult,
    fingerprint?: string
  ) {
    this.#completed.set(key, {
      ...(fingerprint === undefined ? {} : { fingerprint }),
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
