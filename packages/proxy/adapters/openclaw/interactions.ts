import type { ResumeEntry, RunFinishedInterruptOutcome } from "@ag-ui/core"
import {
  validateApprovalResolveParams,
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
    method: "question.resolve" | "approval.resolve",
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
      | "AOS_INTERACTION_EXPIRED"
      | "AOS_PROVIDER_INVALID_RESPONSE"
  ) {
    super(
      code === "AOS_INTERACTION_NOT_FOUND"
        ? "Interaction not found"
        : code === "AOS_INTERACTION_EXPIRED"
          ? "Interaction has expired"
          : code === "AOS_PROVIDER_INVALID_RESPONSE"
            ? "OpenClaw returned invalid interaction data"
            : "Invalid interaction response"
    )
    this.name = "OpenClawInteractionPublicError"
  }
}
type Question = Readonly<{
  questionId: string
  header: string
  question: string
  options: readonly Readonly<{ label: string; description?: string }>[]
  multiSelect?: boolean
}>
type Pending = Readonly<{
  scope: OpenClawInteractionScope
  id: string
  expiresAtMs?: number
  outcome: RunFinishedInterruptOutcome
}> &
  (
    | { kind: "question"; questions: readonly Question[] }
    | {
        kind: "approval"
        nativeKind: "plugin" | "system-agent" | "exec"
        decisions: readonly ("deny" | "allow-once" | "allow-always")[]
      }
  )
const encoder = new TextEncoder()
const safe = (v: unknown, max = 4096) =>
  typeof v === "string" && v.trim() && encoder.encode(v).byteLength <= max
    ? v.trim()
    : undefined
const safeId = (v: unknown) => {
  const x = safe(v, 256)
  return x && !/[\\/\0\r\n]/u.test(x) ? x : undefined
}
const key = (s: OpenClawInteractionScope, id: string) =>
  `${s.agentId}\0${s.sessionId}\0${s.runId}\0${id}`
const same = (a: OpenClawInteractionScope, b: OpenClawInteractionScope) =>
  a.agentId === b.agentId &&
  a.sessionId === b.sessionId &&
  a.threadId === b.threadId &&
  a.runId === b.runId
const invalid = (): never => {
  throw new OpenClawInteractionPublicError("AOS_INVALID_INTERACTION")
}
function resume(v: unknown): ResumeEntry {
  if (
    !Array.isArray(v) ||
    v.length !== 1 ||
    !v[0] ||
    typeof v[0] !== "object" ||
    Array.isArray(v[0])
  )
    invalid()
  const r = (v as unknown[])[0] as Record<string, unknown>
  if (
    !Object.keys(r).every((k) =>
      ["interruptId", "status", "payload", "metadata"].includes(k)
    ) ||
    !safeId(r.interruptId) ||
    (r.status !== "resolved" && r.status !== "cancelled")
  )
    invalid()
  return r as ResumeEntry
}
function answerMap(v: unknown, qs: readonly Question[]) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    !(v as Record<string, unknown>).answers ||
    typeof (v as Record<string, unknown>).answers !== "object"
  )
    invalid()
  const raw = (v as { answers: Record<string, unknown> }).answers
  if (
    Object.keys(raw).length !== qs.length ||
    !qs.every((q) => Object.hasOwn(raw, q.questionId))
  )
    invalid()
  const answers: Record<string, string[]> = {}
  for (const q of qs) {
    const got = raw[q.questionId]
    if (
      !Array.isArray(got) ||
      !got.length ||
      (!q.multiSelect && got.length !== 1) ||
      got.some(
        (a) =>
          !safe(a) || !q.options.some((o: { label: string }) => o.label === a)
      )
    )
      invalid()
    answers[q.questionId] = [...(got as unknown[])] as string[]
  }
  return answers
}

/** Validates official native interaction batches before mapping them to AG-UI. */
export class OpenClawInteractions {
  readonly #pending = new Map<string, Pending>()
  readonly #done = new Map<
    string,
    { fingerprint: string; result: OpenClawInteractionResult }
  >()
  readonly #dispatching = new Set<string>()
  constructor(private readonly transport: OpenClawInteractionTransport) {}
  acceptQuestion(
    scope: OpenClawInteractionScope,
    raw: Readonly<{
      id: string
      questions: readonly Question[]
      expiresAtMs?: number
      agentId?: string
      sessionKey?: string
      runId?: string
    }>
  ) {
    const id = safeId(raw.id),
      expiresAtMs = raw.expiresAtMs
    if (
      !id ||
      !Array.isArray(raw.questions) ||
      !raw.questions.length ||
      raw.questions.length > 32 ||
      (raw.agentId !== undefined && raw.agentId !== scope.agentId) ||
      (raw.sessionKey !== undefined && raw.sessionKey !== scope.sessionId) ||
      (raw.runId !== undefined && raw.runId !== scope.runId) ||
      (expiresAtMs !== undefined &&
        (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 1))
    )
      throw new OpenClawInteractionPublicError("AOS_PROVIDER_INVALID_RESPONSE")
    for (const q of raw.questions)
      if (
        !safeId(q.questionId) ||
        !safe(q.header) ||
        !safe(q.question) ||
        !Array.isArray(q.options) ||
        q.options.length > 64 ||
        q.options.some(
          (o: { label: string; description?: string }) =>
            !safe(o.label) ||
            (o.description !== undefined && !safe(o.description))
        )
      )
        throw new OpenClawInteractionPublicError(
          "AOS_PROVIDER_INVALID_RESPONSE"
        )
    if (
      new Set(raw.questions.map((q) => q.questionId)).size !==
      raw.questions.length
    )
      throw new OpenClawInteractionPublicError("AOS_PROVIDER_INVALID_RESPONSE")
    const outcome: RunFinishedInterruptOutcome = {
      type: "interrupt",
      interrupts: [
        {
          id,
          reason: "question",
          message:
            raw.questions.length === 1
              ? raw.questions[0]!.question
              : `${raw.questions.length} questions require answers`,
          responseSchema: {
            type: "object",
            properties: { answers: { type: "object" } },
            required: ["answers"],
            additionalProperties: false,
          },
          ...(expiresAtMs
            ? { expiresAt: new Date(expiresAtMs).toISOString() }
            : {}),
          metadata: { "aos.kind": "openclaw-question", "aos.scope": "run" },
        },
      ],
    }
    return this.remember({
      kind: "question",
      scope,
      id,
      questions: raw.questions,
      expiresAtMs,
      outcome,
    })
  }
  acceptApproval(
    scope: OpenClawInteractionScope,
    raw: Readonly<{
      id: string
      expiresAtMs: number
      source: { agentId?: string; sessionKey?: string }
      presentation: {
        kind: "plugin" | "system-agent" | "exec"
        allowedDecisions: readonly ("deny" | "allow-once" | "allow-always")[]
        commandText?: string
        title?: string
        description?: string
      }
    }>
  ) {
    const id = safeId(raw.id),
      decisions = raw.presentation?.allowedDecisions
    if (
      !id ||
      !Number.isSafeInteger(raw.expiresAtMs) ||
      raw.expiresAtMs < 1 ||
      raw.source?.agentId !== scope.agentId ||
      raw.source?.sessionKey !== scope.sessionId ||
      !["plugin", "system-agent", "exec"].includes(raw.presentation?.kind) ||
      !Array.isArray(decisions) ||
      !decisions.length ||
      new Set(decisions).size !== decisions.length ||
      decisions.some((d) => !["deny", "allow-once", "allow-always"].includes(d))
    )
      throw new OpenClawInteractionPublicError("AOS_PROVIDER_INVALID_RESPONSE")
    const message =
      safe(
        raw.presentation.commandText ??
          raw.presentation.title ??
          raw.presentation.description
      ) ?? "OpenClaw requires approval to continue."
    const outcome: RunFinishedInterruptOutcome = {
      type: "interrupt",
      interrupts: [
        {
          id,
          reason: "approval",
          message,
          responseSchema: { type: "string", enum: decisions },
          expiresAt: new Date(raw.expiresAtMs).toISOString(),
          metadata: {
            "aos.kind": "openclaw-approval",
            "aos.scope": "run",
            "aos.allowedDecisions": [...decisions],
          },
        },
      ],
    }
    return this.remember({
      kind: "approval",
      nativeKind: raw.presentation.kind,
      scope,
      id,
      decisions,
      expiresAtMs: raw.expiresAtMs,
      outcome,
    })
  }
  pending(scope: OpenClawInteractionScope) {
    return [...this.#pending.values()]
      .filter((p) => same(p.scope, scope))
      .map((p) => p.outcome)
  }
  async respond(
    scope: OpenClawInteractionScope,
    candidate: unknown
  ): Promise<OpenClawInteractionResult> {
    const r = resume(candidate),
      k = key(scope, r.interruptId),
      fingerprint = JSON.stringify(r),
      prior = this.#done.get(k)
    if (prior) {
      if (prior.fingerprint !== fingerprint) invalid()
      return prior.result
    }
    const p = this.#pending.get(k)
    if (!p || !same(p.scope, scope))
      throw new OpenClawInteractionPublicError("AOS_INTERACTION_NOT_FOUND")
    if (p.expiresAtMs !== undefined && p.expiresAtMs <= Date.now()) {
      const result = { status: "expired" as const }
      this.#pending.delete(k)
      this.#done.set(k, { fingerprint, result })
      return result
    }
    if (this.#dispatching.has(k)) return { status: "in-progress" }
    const [method, params] =
      p.kind === "question"
        ? [
            "question.resolve" as const,
            r.status === "cancelled"
              ? { id: p.id, cancel: true }
              : {
                  id: p.id,
                  answers: { answers: answerMap(r.payload, p.questions) },
                },
          ]
        : [
            "approval.resolve" as const,
            {
              id: p.id,
              kind: p.nativeKind,
              decision: r.status === "cancelled" ? "deny" : r.payload,
            },
          ]
    if (
      (method === "question.resolve" &&
        !validateQuestionResolveParams(params)) ||
      (method === "approval.resolve" && !validateApprovalResolveParams(params))
    )
      invalid()
    this.#dispatching.add(k)
    try {
      await this.transport.request(method, params)
      const result = { status: "resolved" as const }
      this.#pending.delete(k)
      this.#done.set(k, { fingerprint, result })
      return result
    } catch {
      const result = { status: "uncertain" as const }
      this.#pending.delete(k)
      this.#done.set(k, { fingerprint, result })
      return result
    } finally {
      this.#dispatching.delete(k)
    }
  }
  private remember(p: Pending) {
    const k = key(p.scope, p.id),
      old = this.#pending.get(k)
    if (old) {
      if (JSON.stringify(old.outcome) !== JSON.stringify(p.outcome))
        throw new OpenClawInteractionPublicError(
          "AOS_PROVIDER_INVALID_RESPONSE"
        )
      return old.outcome
    }
    this.#pending.set(k, p)
    return p.outcome
  }
}
