import type { ResumeEntry, RunFinishedInterruptOutcome } from "@ag-ui/core"
import {
  validateApprovalGetResult,
  validateApprovalResolveResult,
  validateQuestionResolveParams,
} from "@openclaw/gateway-protocol"

export type OpenClawInteractionScope = Readonly<{
  agentId: string
  sessionId: string
  threadId: string
  runId: string
}>
export type OpenClawInteractionTransport = Readonly<{
  request(
    method:
      | "question.get"
      | "question.list"
      | "question.resolve"
      | "approval.get"
      | "approval.list"
      | "approval.resolve",
    params: unknown
  ): Promise<unknown>
}>
export type OpenClawInteractionResult = Readonly<{
  status:
    "resolved" | "expired" | "already-resolved" | "uncertain" | "in-progress"
}>
export class OpenClawInteractionPublicError extends Error {
  constructor(
    readonly code:
      | "AOS_INVALID_INTERACTION"
      | "AOS_INTERACTION_NOT_FOUND"
      | "AOS_PROVIDER_INVALID_RESPONSE"
  ) {
    super(
      code === "AOS_INTERACTION_NOT_FOUND"
        ? "Interaction not found"
        : code === "AOS_PROVIDER_INVALID_RESPONSE"
          ? "OpenClaw returned invalid interaction data"
          : "Invalid interaction response"
    )
    this.name = "OpenClawInteractionPublicError"
  }
}
type Question = {
  questionId: string
  question: string
  options: string[]
  multi?: boolean
  other?: boolean
  secret?: boolean
}
type Pending = {
  scope: OpenClawInteractionScope
  id: string
  expiresAtMs: number
  outcome: RunFinishedInterruptOutcome
} & (
  | { kind: "question"; questions: Question[] }
  | {
      kind: "approval"
      nativeKind: "plugin" | "system-agent" | "exec"
      decisions: string[]
    }
)
const encoder = new TextEncoder(),
  text = (v: unknown, max = 4096) =>
    typeof v === "string" && v.trim() && encoder.encode(v).byteLength <= max
      ? v.trim()
      : undefined,
  id = (v: unknown) => {
    const x = text(v, 256)
    return x && !/[\\/\0\r\n]/u.test(x) ? x : undefined
  },
  key = (s: OpenClawInteractionScope, i: string) =>
    `${s.agentId}\0${s.sessionId}\0${s.runId}\0${i}`,
  invalid = (): never => {
    throw new OpenClawInteractionPublicError("AOS_INVALID_INTERACTION")
  },
  bad = (): never => {
    throw new OpenClawInteractionPublicError("AOS_PROVIDER_INVALID_RESPONSE")
  }
function record(scope: OpenClawInteractionScope, raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad()
  const r = raw as Record<string, unknown>,
    requestId = id(r.id)
  if (
    !requestId ||
    r.agentId !== scope.agentId ||
    r.sessionKey !== scope.sessionId ||
    r.runId !== scope.runId ||
    r.status !== "pending" ||
    !Number.isSafeInteger(r.expiresAtMs) ||
    !Array.isArray(r.questions) ||
    r.questions.length < 1 ||
    r.questions.length > 3
  )
    bad()
  const nativeQuestions = r.questions as unknown[]
  const questions = nativeQuestions.map((x): Question => {
    if (!x || typeof x !== "object" || Array.isArray(x)) bad()
    const q = x as Record<string, unknown>,
      questionId =
        typeof q.questionId === "string" &&
        /^[a-z][a-z0-9_]*$/u.test(q.questionId)
          ? q.questionId
          : undefined
    if (
      !questionId ||
      !text(q.header, 12) ||
      !text(q.question) ||
      !Array.isArray(q.options) ||
      q.options.length > 4 ||
      (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean") ||
      (q.isOther !== undefined && typeof q.isOther !== "boolean") ||
      (q.isSecret !== undefined && typeof q.isSecret !== "boolean")
    )
      bad()
    const nativeOptions = q.options as unknown[]
    const options = nativeOptions.map((o) => {
      if (
        !o ||
        typeof o !== "object" ||
        !text((o as Record<string, unknown>).label)
      )
        bad()
      return (o as { label: string }).label
    })
    return {
      questionId: questionId!,
      question: q.question as string,
      options,
      ...(q.multiSelect ? { multi: true } : {}),
      ...(q.isOther ? { other: true } : {}),
      ...(q.isSecret ? { secret: true } : {}),
    }
  })
  if (new Set(questions.map((q) => q.questionId)).size !== questions.length)
    bad()
  return { id: requestId, questions, expiresAtMs: r.expiresAtMs as number }
}
function resume(raw: unknown) {
  if (
    !Array.isArray(raw) ||
    raw.length !== 1 ||
    !raw[0] ||
    typeof raw[0] !== "object"
  )
    invalid()
  const r = (raw as unknown[])[0] as Record<string, unknown>
  if (
    !id(r.interruptId) ||
    (r.status !== "resolved" && r.status !== "cancelled")
  )
    invalid()
  return r as ResumeEntry
}
function answerMap(value: unknown, questions: Question[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !(value as Record<string, unknown>).answers ||
    typeof (value as Record<string, unknown>).answers !== "object"
  )
    invalid()
  const raw = (value as { answers: Record<string, unknown> }).answers
  if (Object.keys(raw).length !== questions.length) invalid()
  const answers: Record<string, string[]> = {}
  for (const q of questions) {
    const values = raw[q.questionId]
    if (
      !Array.isArray(values) ||
      (!q.multi && values.length > 1) ||
      values.some((v) => !text(v)) ||
      (!q.other &&
        !q.secret &&
        q.options.length > 0 &&
        values.some((v) => !q.options.includes(v as string)))
    )
      invalid()
    answers[q.questionId] = values as string[]
  }
  return answers
}

/** Maps exact pinned V4 records; pending interactions are rediscovered before resume. */
export class OpenClawInteractions {
  readonly #pending = new Map<string, Pending>()
  readonly #done = new Map<
    string,
    { fingerprint: string; result: OpenClawInteractionResult }
  >()
  constructor(private readonly transport: OpenClawInteractionTransport) {}
  acceptQuestion(scope: OpenClawInteractionScope, raw: unknown) {
    const r = record(scope, raw),
      outcome: RunFinishedInterruptOutcome = {
        type: "interrupt",
        interrupts: [
          {
            id: r.id!,
            reason: "question",
            message:
              r.questions.length === 1
                ? r.questions[0]!.question
                : `${r.questions.length} questions require answers`,
            expiresAt: new Date(r.expiresAtMs).toISOString(),
            responseSchema: {
              type: "object",
              properties: { answers: { type: "object" } },
              required: ["answers"],
            },
            metadata: {
              "aos.kind": "openclaw-question",
              "aos.scope": "run",
              "aos.answerModes": r.questions.map((q) =>
                q.secret
                  ? "secret"
                  : q.other || !q.options.length
                    ? "free-text"
                    : q.multi
                      ? "multiple"
                      : "single"
              ),
            },
          },
        ],
      }
    return this.remember({
      kind: "question",
      scope,
      id: r.id!,
      questions: r.questions,
      expiresAtMs: r.expiresAtMs,
      outcome,
    })
  }
  acceptApproval(scope: OpenClawInteractionScope, raw: unknown) {
    if (!validateApprovalGetResult({ approval: raw })) bad()
    const r = raw as {
      id: string
      status: string
      sourceSessionKey?: string
      expiresAtMs: number
      presentation: {
        kind: "plugin" | "system-agent" | "exec"
        agentId?: string | null
        allowedDecisions: string[]
        commandText?: string
        title?: string
        description?: string
      }
    }
    if (
      r.status !== "pending" ||
      r.sourceSessionKey !== scope.sessionId ||
      r.presentation.agentId !== scope.agentId ||
      !Number.isSafeInteger(r.expiresAtMs)
    )
      bad()
    const outcome: RunFinishedInterruptOutcome = {
      type: "interrupt",
      interrupts: [
        {
          id: r.id,
          reason: "approval",
          message:
            text(
              r.presentation.commandText ??
                r.presentation.title ??
                r.presentation.description
            ) ?? "OpenClaw requires approval to continue.",
          expiresAt: new Date(r.expiresAtMs).toISOString(),
          responseSchema: {
            type: "string",
            enum: r.presentation.allowedDecisions,
          },
          metadata: {
            "aos.kind": "openclaw-approval",
            "aos.scope": "run",
            "aos.allowedDecisions": r.presentation.allowedDecisions,
          },
        },
      ],
    }
    return this.remember({
      kind: "approval",
      scope,
      id: r.id!,
      nativeKind: r.presentation.kind,
      decisions: r.presentation.allowedDecisions,
      expiresAtMs: r.expiresAtMs,
      outcome,
    })
  }
  async reconcile(scope: OpenClawInteractionScope) {
    const [qs, as] = await Promise.all([
      this.transport.request("question.list", {}),
      this.transport.request("approval.list", {}),
    ])
    if (
      !qs ||
      typeof qs !== "object" ||
      !Array.isArray((qs as Record<string, unknown>).questions) ||
      !as ||
      typeof as !== "object" ||
      !Array.isArray((as as Record<string, unknown>).approvals)
    )
      bad()
    const outcomes: RunFinishedInterruptOutcome[] = []
    for (const q of (qs as { questions: unknown[] }).questions) {
      try {
        outcomes.push(this.acceptQuestion(scope, q))
      } catch (e) {
        if (
          !(e instanceof OpenClawInteractionPublicError) ||
          e.code !== "AOS_PROVIDER_INVALID_RESPONSE"
        )
          throw e
      }
    }
    for (const a of (as as { approvals: unknown[] }).approvals) {
      try {
        outcomes.push(this.acceptApproval(scope, a))
      } catch (e) {
        if (
          !(e instanceof OpenClawInteractionPublicError) ||
          e.code !== "AOS_PROVIDER_INVALID_RESPONSE"
        )
          throw e
      }
    }
    return outcomes
  }
  async respond(
    scope: OpenClawInteractionScope,
    raw: unknown
  ): Promise<OpenClawInteractionResult> {
    const r = resume(raw),
      k = key(scope, r.interruptId),
      fingerprint = JSON.stringify(r),
      done = this.#done.get(k)
    if (done) {
      if (done.fingerprint !== fingerprint) invalid()
      return done.result
    }
    const p = this.#pending.get(k)
    if (!p)
      throw new OpenClawInteractionPublicError("AOS_INTERACTION_NOT_FOUND")
    const current = await this.current(p)
    if (current) return this.complete(k, fingerprint, current)
    let method: "question.resolve" | "approval.resolve",
      params: unknown,
      expected: Record<string, string[]> | undefined
    if (p.kind === "question") {
      expected =
        r.status === "cancelled" ? undefined : answerMap(r.payload, p.questions)
      method = "question.resolve"
      params =
        r.status === "cancelled"
          ? { id: p.id, cancel: true }
          : { id: p.id, answers: { answers: expected } }
      if (!validateQuestionResolveParams(params)) invalid()
    } else {
      const decision = r.status === "cancelled" ? "deny" : r.payload
      if (typeof decision !== "string" || !p.decisions.includes(decision))
        invalid()
      method = "approval.resolve"
      params = { id: p.id, kind: p.nativeKind, decision }
    }
    try {
      const value = await this.transport.request(method, params),
        result =
          p.kind === "question"
            ? this.questionResult(value, expected)
            : this.approvalResult(value, p, params as { decision: string })
      return this.complete(k, fingerprint, result)
    } catch (e) {
      if (e instanceof OpenClawInteractionPublicError) throw e
      return this.complete(k, fingerprint, { status: "uncertain" })
    }
  }
  private async current(
    p: Pending
  ): Promise<OpenClawInteractionResult | undefined> {
    const value = await this.transport.request(
      p.kind === "question" ? "question.get" : "approval.get",
      { id: p.id }
    )
    if (!value || typeof value !== "object") bad()
    const item = (value as Record<string, unknown>)[
      p.kind === "question" ? "question" : "approval"
    ] as Record<string, unknown> | undefined
    if (!item || item.id !== p.id) bad()
    const established = item!
    return established.status === "pending"
      ? undefined
      : established.status === "expired"
        ? { status: "expired" }
        : { status: "already-resolved" }
  }
  private questionResult(
    value: unknown,
    expected?: Record<string, string[]>
  ): OpenClawInteractionResult {
    if (!value || typeof value !== "object") bad()
    const r = value as Record<string, unknown>
    if (r.status === "cancelled" && expected === undefined)
      return { status: "resolved" }
    if (
      r.status === "answered" &&
      expected &&
      JSON.stringify((r.answers as { answers?: unknown })?.answers) ===
        JSON.stringify(expected)
    )
      return { status: "resolved" }
    return bad()
  }
  private approvalResult(
    value: unknown,
    p: Extract<Pending, { kind: "approval" }>,
    params: { decision: string }
  ): OpenClawInteractionResult {
    if (validateApprovalResolveResult(value)) {
      const r = value as {
        applied: boolean
        approval: { id: string; decision: string; status: string }
      }
      if (r.approval.id !== p.id || r.approval.decision !== params.decision)
        bad()
      return r.applied && r.approval.status === "allowed"
        ? { status: "resolved" }
        : { status: "already-resolved" }
    }
    if (
      value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).status === "expired"
    )
      return { status: "expired" }
    return bad()
  }
  private complete(
    k: string,
    fingerprint: string,
    result: OpenClawInteractionResult
  ) {
    this.#pending.delete(k)
    this.#done.set(k, { fingerprint, result })
    return result
  }
  private remember(p: Pending) {
    const k = key(p.scope, p.id),
      old = this.#pending.get(k)
    if (old) return old.outcome
    this.#pending.set(k, p)
    return p.outcome
  }
}
