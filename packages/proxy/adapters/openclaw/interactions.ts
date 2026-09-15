import {
  ResumeEntrySchema,
  type ResumeEntry,
  type RunFinishedInterruptOutcome,
} from "@ag-ui/core"
import {
  SessionApprovalReplaySchema,
  validateApprovalGetResult,
  validateApprovalResolveResult,
  validateQuestionResolveParams,
} from "@openclaw/gateway-protocol"
import { Check } from "typebox/value"
import { OpenClawClientRequestError } from "./client"

export type OpenClawInteractionScope = Readonly<{
  agentId: string
  sessionId: string
  threadId: string
  runId: string
}>
export type OpenClawResumeScope = Pick<
  OpenClawInteractionScope,
  "agentId" | "sessionId" | "threadId"
>
export type OpenClawInteractionDiscoveryScope = OpenClawResumeScope &
  Readonly<{ nativeRunId: string }>
export type OpenClawInteractionTransport = Readonly<{
  request(
    method:
      | "question.get"
      | "question.list"
      | "question.resolve"
      | "approval.get"
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
type Done = {
  pending: Pending
  fingerprint?: string
  result: OpenClawInteractionResult
}
type Binding = {
  scope: OpenClawInteractionScope
  fingerprint: string
  state: "ready" | "dispatching"
}
export const OPENCLAW_MAX_PENDING_INTERACTIONS = 64
const MAX_DONE_INTERACTIONS = 256
const encoder = new TextEncoder(),
  text = (v: unknown, max = 4096) =>
    typeof v === "string" && v.trim() && encoder.encode(v).byteLength <= max
      ? v.trim()
      : undefined,
  id = (v: unknown) => {
    const x = text(v, 256)
    return x && !/[\\/\0\r\n]/u.test(x) ? x : undefined
  },
  scopeKey = (s: OpenClawInteractionScope) =>
    `${s.agentId}\0${s.sessionId}\0${s.threadId}\0${s.runId}`,
  resumeScopeKey = (s: OpenClawResumeScope) =>
    `${s.agentId}\0${s.sessionId}\0${s.threadId}`,
  key = (s: OpenClawInteractionScope, i: string) => `${scopeKey(s)}\0${i}`,
  bindingKey = (s: OpenClawResumeScope, i: string) =>
    `${resumeScopeKey(s)}\0${i}`
function invalid(): never {
  throw new OpenClawInteractionPublicError("AOS_INVALID_INTERACTION")
}
function bad(): never {
  throw new OpenClawInteractionPublicError("AOS_PROVIDER_INVALID_RESPONSE")
}
function record(
  scope: OpenClawInteractionScope,
  raw: unknown,
  pendingOnly = true
) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad()
  const r = raw as Record<string, unknown>,
    requestId = id(r.id)
  if (
    !requestId ||
    r.agentId !== scope.agentId ||
    r.sessionKey !== scope.sessionId ||
    r.runId !== scope.runId ||
    !["pending", "answered", "cancelled", "expired"].includes(
      r.status as string
    ) ||
    (pendingOnly && r.status !== "pending") ||
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
  return {
    id: requestId,
    questions,
    expiresAtMs: r.expiresAtMs as number,
    status: r.status as "pending" | "answered" | "cancelled" | "expired",
  }
}
function jsonFingerprint(value: unknown) {
  const seen = new WeakSet<object>()
  function normalize(input: unknown): unknown {
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean"
    )
      return input
    if (typeof input === "number" && Number.isFinite(input)) return input
    if (Array.isArray(input)) return input.map(normalize)
    if (input === null || typeof input !== "object") invalid()
    if (seen.has(input)) invalid()
    seen.add(input)
    const normalized: Record<string, unknown> = {}
    for (const name of Object.keys(input).sort())
      normalized[name] = normalize((input as Record<string, unknown>)[name])
    seen.delete(input)
    return normalized
  }
  return JSON.stringify(normalize(value))
}
function resume(raw: unknown): { entry: ResumeEntry; fingerprint: string } {
  if (
    !Array.isArray(raw) ||
    raw.length !== 1 ||
    !raw[0] ||
    typeof raw[0] !== "object"
  )
    invalid()
  const value = (raw as unknown[])[0] as Record<string, unknown>
  if (
    Object.keys(value).some(
      (name) =>
        name !== "interruptId" &&
        name !== "status" &&
        name !== "payload" &&
        name !== "metadata"
    )
  )
    invalid()
  const parsed = ResumeEntrySchema.safeParse(value)
  if (!parsed.success) invalid()
  const entry = parsed.data
  if (!entry || !id(entry.interruptId)) invalid()
  return { entry, fingerprint: jsonFingerprint(entry) }
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
  readonly #done = new Map<string, Done>()
  readonly #bindings = new Map<string, Binding>()
  constructor(private readonly transport: OpenClawInteractionTransport) {}
  async discover(
    scope: OpenClawInteractionDiscoveryScope,
    approvalReplay: unknown
  ): Promise<{ outcome: RunFinishedInterruptOutcome } | undefined> {
    if (
      !Check(SessionApprovalReplaySchema, approvalReplay) ||
      approvalReplay.sessionKey !== scope.sessionId ||
      approvalReplay.truncated
    )
      return undefined
    const fullScope: OpenClawInteractionScope = {
        agentId: scope.agentId,
        sessionId: scope.sessionId,
        threadId: scope.threadId,
        runId: scope.nativeRunId,
      },
      listed = await this.transport.request("question.list", {})
    if (
      !listed ||
      typeof listed !== "object" ||
      !Array.isArray((listed as Record<string, unknown>).questions)
    )
      bad()
    const candidates: Array<
      | { kind: "question"; value: unknown }
      | { kind: "approval"; value: unknown }
    > = []
    for (const value of (listed as { questions: unknown[] }).questions) {
      if (!value || typeof value !== "object" || Array.isArray(value)) bad()
      const row = value as Record<string, unknown>
      if (
        row.agentId !== scope.agentId ||
        row.sessionKey !== scope.sessionId ||
        row.runId !== scope.nativeRunId
      )
        continue
      record(fullScope, row)
      candidates.push({ kind: "question", value })
    }
    for (const value of approvalReplay.approvals)
      if (
        value.sourceSessionKey === scope.sessionId &&
        value.presentation.agentId === scope.agentId
      )
        candidates.push({ kind: "approval", value })
    if (candidates.length !== 1) return undefined
    const candidate = candidates[0]!
    return {
      outcome:
        candidate.kind === "question"
          ? this.acceptQuestion(fullScope, candidate.value)
          : this.acceptApproval(fullScope, candidate.value),
    }
  }
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
    const qs = await this.transport.request("question.list", {})
    if (
      !qs ||
      typeof qs !== "object" ||
      !Array.isArray((qs as Record<string, unknown>).questions)
    )
      bad()
    const outcomes: RunFinishedInterruptOutcome[] = []
    for (const q of (qs as { questions: unknown[] }).questions) {
      if (!q || typeof q !== "object" || Array.isArray(q)) bad()
      const row = q as Record<string, unknown>
      if (
        row.agentId !== scope.agentId ||
        row.sessionKey !== scope.sessionId ||
        row.runId !== scope.runId
      )
        continue
      outcomes.push(this.acceptQuestion(scope, row))
    }
    for (const [k, pending] of this.#pending)
      if (
        pending.kind === "approval" &&
        scopeKey(pending.scope) === scopeKey(scope)
      ) {
        const current = await this.current(pending)
        if (current) this.complete(k, pending, undefined, current)
      }
    return outcomes
  }
  async validate(
    scope: OpenClawResumeScope,
    raw: readonly ResumeEntry[]
  ): Promise<{ runId: string }> {
    const { entry, fingerprint } = resume(raw),
      boundKey = bindingKey(scope, entry.interruptId),
      bound = this.#bindings.get(boundKey)
    if (bound) {
      if (bound.fingerprint !== fingerprint) invalid()
      return { runId: bound.scope.runId }
    }
    const match = this.find(scope, entry.interruptId)
    this.resolution(match.pending, entry)
    if (match.done?.fingerprint && match.done.fingerprint !== fingerprint)
      invalid()
    if (!match.done) {
      const current = await this.current(match.pending)
      if (current) this.complete(match.key, match.pending, fingerprint, current)
      const confirmed = this.find(scope, entry.interruptId)
      if (confirmed.key !== match.key)
        throw new OpenClawInteractionPublicError("AOS_INTERACTION_NOT_FOUND")
    } else if (!match.done.fingerprint) match.done.fingerprint = fingerprint
    this.#bindings.set(boundKey, {
      scope: match.pending.scope,
      fingerprint,
      state: "ready",
    })
    return { runId: match.pending.scope.runId }
  }
  async dispatch(
    scope: OpenClawResumeScope,
    raw: readonly ResumeEntry[]
  ): Promise<OpenClawInteractionResult> {
    const { entry, fingerprint } = resume(raw),
      boundKey = bindingKey(scope, entry.interruptId),
      bound = this.#bindings.get(boundKey)
    if (!bound)
      throw new OpenClawInteractionPublicError("AOS_INTERACTION_NOT_FOUND")
    if (bound.fingerprint !== fingerprint) invalid()
    if (bound.state === "dispatching") return { status: "in-progress" }
    bound.state = "dispatching"
    try {
      return await this.respond(bound.scope, raw)
    } finally {
      if (this.#bindings.get(boundKey) === bound)
        this.#bindings.delete(boundKey)
    }
  }
  async respond(
    scope: OpenClawInteractionScope,
    raw: unknown
  ): Promise<OpenClawInteractionResult> {
    const { entry: r, fingerprint } = resume(raw),
      k = key(scope, r.interruptId),
      done = this.#done.get(k)
    if (done) {
      if (done.fingerprint !== undefined && done.fingerprint !== fingerprint)
        invalid()
      return done.result
    }
    const p = this.#pending.get(k)
    if (!p)
      throw new OpenClawInteractionPublicError("AOS_INTERACTION_NOT_FOUND")
    const resolution = this.resolution(p, r)
    const current = await this.current(p)
    if (current) return this.complete(k, p, fingerprint, current)
    try {
      const value = await this.transport.request(
          resolution.method,
          resolution.params
        ),
        result =
          p.kind === "question"
            ? this.questionResult(value, resolution.expected)
            : this.approvalResult(value, p, {
                decision: resolution.decision!,
              })
      return this.complete(k, p, fingerprint, result)
    } catch (e) {
      if (e instanceof OpenClawInteractionPublicError) throw e
      if (e instanceof OpenClawClientRequestError && !e.uncertain) bad()
      return this.complete(k, p, fingerprint, { status: "uncertain" })
    }
  }
  private find(scope: OpenClawResumeScope, interruptId: string) {
    const candidates: Array<{
      key: string
      pending: Pending
      done?: Done
    }> = []
    for (const [candidateKey, pending] of this.#pending)
      if (
        resumeScopeKey(pending.scope) === resumeScopeKey(scope) &&
        pending.id === interruptId
      )
        candidates.push({ key: candidateKey, pending })
    for (const [candidateKey, done] of this.#done)
      if (
        resumeScopeKey(done.pending.scope) === resumeScopeKey(scope) &&
        done.pending.id === interruptId
      )
        candidates.push({ key: candidateKey, pending: done.pending, done })
    if (candidates.length !== 1)
      throw new OpenClawInteractionPublicError("AOS_INTERACTION_NOT_FOUND")
    return candidates[0]!
  }
  private resolution(p: Pending, r: ResumeEntry) {
    if (p.kind === "question") {
      const expected =
          r.status === "cancelled"
            ? undefined
            : answerMap(r.payload, p.questions),
        params =
          r.status === "cancelled"
            ? { id: p.id, cancel: true }
            : { id: p.id, answers: { answers: expected } }
      if (!validateQuestionResolveParams(params)) invalid()
      return { method: "question.resolve" as const, params, expected }
    }
    const decision = r.status === "cancelled" ? "deny" : r.payload
    if (typeof decision !== "string" || !p.decisions.includes(decision))
      invalid()
    return {
      method: "approval.resolve" as const,
      params: { id: p.id, kind: p.nativeKind, decision },
      decision,
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
    if (p.kind === "question") {
      const authoritative = record(p.scope, item, false)
      return authoritative.status === "pending"
        ? undefined
        : authoritative.status === "expired"
          ? { status: "expired" }
          : { status: "already-resolved" }
    }
    const approval = item!
    if (!validateApprovalGetResult({ approval })) bad()
    const source = approval.source as Record<string, unknown> | undefined
    const presentation = approval.presentation as
      Record<string, unknown> | undefined
    if (
      approval.sourceSessionKey !== p.scope.sessionId &&
      source?.sessionKey !== p.scope.sessionId
    )
      bad()
    if (presentation?.agentId !== p.scope.agentId) bad()
    const established = approval
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
    if (!validateApprovalResolveResult(value)) bad()
    if (!value || typeof value !== "object" || Array.isArray(value)) bad()
    const r = value as {
      applied?: unknown
      approval?: { id?: unknown; decision?: unknown; status?: unknown }
    }
    if (!r.approval || r.approval.id !== p.id) bad()
    const approval = r.approval!
    if (approval.status === "expired") return { status: "expired" }
    if (
      r.applied === true &&
      (approval.status === "allowed" || approval.status === "denied") &&
      approval.decision === params.decision
    )
      return { status: "resolved" }
    if (
      r.applied === false &&
      (approval.status === "allowed" ||
        approval.status === "denied" ||
        approval.status === "cancelled")
    )
      return { status: "already-resolved" }
    return bad()
  }
  private complete(
    k: string,
    pending: Pending,
    fingerprint: string | undefined,
    result: OpenClawInteractionResult
  ) {
    this.#pending.delete(k)
    this.#done.set(k, { pending, fingerprint, result })
    while (this.#done.size > MAX_DONE_INTERACTIONS) {
      const oldest = this.#done.keys().next().value as string | undefined
      if (!oldest) break
      const evicted = this.#done.get(oldest)
      this.#done.delete(oldest)
      if (evicted) {
        const boundKey = bindingKey(evicted.pending.scope, evicted.pending.id),
          bound = this.#bindings.get(boundKey)
        if (bound && scopeKey(bound.scope) === scopeKey(evicted.pending.scope))
          this.#bindings.delete(boundKey)
      }
    }
    return result
  }
  private remember(p: Pending) {
    const k = key(p.scope, p.id),
      old = this.#pending.get(k)
    if (old) return old.outcome
    let scopedPending = 0
    for (const pending of this.#pending.values())
      if (scopeKey(pending.scope) === scopeKey(p.scope)) scopedPending++
    if (scopedPending >= OPENCLAW_MAX_PENDING_INTERACTIONS) bad()
    this.#pending.set(k, p)
    return p.outcome
  }
}
