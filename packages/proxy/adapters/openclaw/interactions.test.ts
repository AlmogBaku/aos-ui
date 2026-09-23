import { describe, expect, it, vi } from "vitest"
import { PendingRequestKind } from "../../core/events"
import * as GatewayProtocol from "@openclaw/gateway-protocol"
import {
  OpenClawInteractions,
  OpenClawInteractionPublicError,
} from "./interactions"
const scope = {
  agentId: "agent-a",
  sessionId: "session-a",
  threadId: "thread-a",
  runId: "run-a",
}
const question = {
  id: "q",
  agentId: "agent-a",
  sessionKey: "session-a",
  runId: "run-a",
  createdAtMs: 1,
  expiresAtMs: 1_900_000_000_000,
  status: "pending",
  questions: [
    {
      questionId: "choice",
      header: "Choice",
      question: "Choose",
      options: [{ label: "yes" }],
      isOther: true,
    },
    {
      questionId: "secret",
      header: "Secret",
      question: "Secret",
      options: [],
      isSecret: true,
    },
  ],
}
function withoutCreatedAt(value: typeof question) {
  const incomplete: Partial<typeof question> = { ...value }
  delete incomplete.createdAtMs
  return incomplete
}
const approvalRecord = {
  id: "approval-a",
  urlPath: "/approvals/approval-a",
  createdAtMs: 1,
  expiresAtMs: 1_900_000_000_000,
  presentation: {
    kind: "plugin",
    title: "External action",
    description: "Allow the plugin action",
    severity: "warning",
    agentId: "agent-a",
    allowedDecisions: ["allow-once", "allow-always", "deny"],
  },
}
const approval = {
  ...approvalRecord,
  status: "pending",
  sourceSessionKey: "session-a",
}
const approvalReplay = {
  sessionKey: "session-a",
  updatedAtMs: 1,
  approvals: [approval],
  truncated: false,
}
const repliesScope = {
  agentId: scope.agentId,
  sessionId: scope.sessionId,
  threadId: scope.threadId,
}
const resolvedQuestion = [
  {
    requestId: "q",
    status: "resolved" as const,
    payload: { answers: [["other"], ["secret-value"]] },
  },
]
/** The same answers keyed by native question id, as `question.resolve` takes them. */
const nativeAnswers = {
  answers: { choice: ["other"], secret: ["secret-value"] },
}
describe("OpenClaw interactions", () => {
  it.each([
    ["missing creation time", withoutCreatedAt],
    [
      "negative creation time",
      (value: typeof question) => ({ ...value, createdAtMs: -1 }),
    ],
    [
      "negative expiry",
      (value: typeof question) => ({ ...value, expiresAtMs: -1 }),
    ],
  ])("rejects an impossible question record with %s", (_label, alter) => {
    const interactions = new OpenClawInteractions({ request: vi.fn() })

    expect(() =>
      interactions.acceptQuestion(scope, alter(question))
    ).toThrowError(
      expect.objectContaining({ code: "AOS_PROVIDER_INVALID_RESPONSE" })
    )
  })

  it("validates the complete question list before applying scope filters", async () => {
    const impossible = withoutCreatedAt(question)
    const interactions = new OpenClawInteractions({
      request: vi.fn(async () => ({
        questions: [{ ...impossible, agentId: "foreign" }],
      })),
    })

    await expect(
      interactions.discover(
        { ...repliesScope, nativeRunId: "run-a" },
        approvalReplay
      )
    ).rejects.toMatchObject({ code: "AOS_PROVIDER_INVALID_RESPONSE" })
  })

  it("rejects a malformed authoritative question get result before resolve", async () => {
    const request = vi.fn(async () => ({
      question: { ...question, impossible: true },
    }))
    const interactions = new OpenClawInteractions({ request })
    interactions.acceptQuestion(scope, question)

    await expect(
      interactions.respond(scope, resolvedQuestion)
    ).rejects.toMatchObject({ code: "AOS_PROVIDER_INVALID_RESPONSE" })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("rejects a malformed question resolve acknowledgement", async () => {
    const request = vi.fn(async (method: string) =>
      method === "question.get"
        ? { question }
        : {
            status: "answered",
            answers: nativeAnswers,
            impossible: true,
          }
    )
    const interactions = new OpenClawInteractions({ request })
    interactions.acceptQuestion(scope, question)

    await expect(
      interactions.respond(scope, resolvedQuestion)
    ).rejects.toMatchObject({ code: "AOS_PROVIDER_INVALID_RESPONSE" })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it("normalizes approval choices without exposing native decisions", () => {
    const interactions = new OpenClawInteractions({ request: vi.fn() })

    const request = interactions.acceptApproval(scope, approval)

    expect(request).toMatchObject({
      kind: PendingRequestKind.Permission,
      responseSchema: {
        type: "string",
        enum: ["once", "always", "deny"],
      },
    })
    expect(JSON.stringify(request)).not.toContain("allow-once")
    expect(JSON.stringify(request)).not.toContain("allow-always")
  })

  it("keeps the choices of a multi-choice question and answers every one", async () => {
    const multi = {
      ...question,
      questions: [
        {
          questionId: "checks",
          header: "Checks",
          question: "Which checks?",
          options: [{ label: "smoke" }, { label: "e2e" }, { label: "unit" }],
          multiSelect: true,
        },
      ],
    }
    const request = vi.fn(async (method: string) =>
      method === "question.get"
        ? { question: multi }
        : {
            status: "answered",
            answers: { answers: { checks: ["smoke", "unit"] } },
          }
    )
    const interactions = new OpenClawInteractions({ request })

    expect(interactions.acceptQuestion(scope, multi).questions).toEqual([
      {
        label: "Checks",
        text: "Which checks?",
        choices: ["smoke", "e2e", "unit"],
        multiple: true,
        custom: false,
      },
    ])
    await expect(
      interactions.respond(scope, [
        {
          requestId: "q",
          status: "resolved",
          payload: { answers: [["smoke", "unit"]] },
        },
      ])
    ).resolves.toEqual({ status: "resolved" })
    expect(request).toHaveBeenLastCalledWith("question.resolve", {
      id: "q",
      answers: { answers: { checks: ["smoke", "unit"] } },
    })
  })

  it("rediscovers and binds one exact pending question after restart", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "question.list") return { questions: [question] }
      if (method === "question.get") return { question }
      return {
        status: "answered",
        answers: nativeAnswers,
      }
    })
    const interactions = new OpenClawInteractions({ request })

    await expect(
      interactions.discover(
        { ...repliesScope, nativeRunId: "run-a" },
        { ...approvalReplay, approvals: [] }
      )
    ).resolves.toMatchObject({
      requests: [{ requestId: "q", kind: PendingRequestKind.Elicitation }],
    })
    await expect(
      interactions.validate(repliesScope, resolvedQuestion)
    ).resolves.toEqual({ runId: "run-a" })
    await expect(
      interactions.dispatch(repliesScope, resolvedQuestion)
    ).resolves.toEqual({ status: "resolved" })
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "question.list",
      "question.get",
      "question.get",
      "question.resolve",
    ])
  })

  it.each([
    ["absent", undefined],
    ["invalid", {}],
    ["foreign", { ...approvalReplay, sessionKey: "foreign" }],
    ["truncated", { ...approvalReplay, truncated: true }],
  ])(
    "requires a complete approval replay before question discovery when replay is %s",
    async (_label, replay) => {
      const request = vi.fn(async () => ({ questions: [question] }))
      const interactions = new OpenClawInteractions({ request })

      await expect(
        interactions.discover({ ...repliesScope, nativeRunId: "run-a" }, replay)
      ).resolves.toBeUndefined()
      await expect(
        interactions.validate(repliesScope, resolvedQuestion)
      ).rejects.toMatchObject({ code: "AOS_INTERACTION_NOT_FOUND" })
      expect(request).not.toHaveBeenCalled()
    }
  )

  it("rediscovers a matching replay approval on the proven native run", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "question.list") return { questions: [] }
      if (method === "approval.get") return { approval }
      return {
        applied: true,
        approval: {
          ...approvalRecord,
          status: "allowed",
          decision: "allow-once",
          resolvedAtMs: 2,
          reason: "user",
          resolver: { kind: "device", id: "reviewer-a" },
        },
      }
    })
    const interactions = new OpenClawInteractions({ request })
    const response = [
      {
        requestId: "approval-a",
        status: "resolved" as const,
        payload: "once",
      },
    ]

    await expect(
      interactions.discover(
        { ...repliesScope, nativeRunId: "native-recovered" },
        approvalReplay
      )
    ).resolves.toMatchObject({
      requests: [
        { requestId: "approval-a", kind: PendingRequestKind.Permission },
      ],
    })
    await expect(
      interactions.validate(repliesScope, response)
    ).resolves.toEqual({ runId: "native-recovered" })
    await expect(
      interactions.dispatch(repliesScope, response)
    ).resolves.toEqual({ status: "resolved" })
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "question.list",
      "approval.get",
      "approval.get",
      "approval.resolve",
    ])
    expect(request).toHaveBeenLastCalledWith("approval.resolve", {
      id: "approval-a",
      kind: "plugin",
      decision: "allow-once",
    })
  })

  it.each(["allow-once", "allow-always"])(
    "rejects native approval decision %s as a normalized request reply",
    async (nativeDecision) => {
      const request = vi.fn()
      const interactions = new OpenClawInteractions({ request })
      interactions.acceptApproval(scope, approval)

      await expect(
        interactions.respond(scope, [
          {
            requestId: "approval-a",
            status: "resolved",
            payload: nativeDecision,
          },
        ])
      ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })
      expect(request).not.toHaveBeenCalled()
    }
  )

  it.each([
    ["once", "allow-once", "allowed"],
    ["always", "allow-always", "allowed"],
    ["deny", "deny", "denied"],
  ] as const)(
    "maps normalized %s to native %s only at resolve dispatch",
    async (normalized, native, status) => {
      const request = vi.fn(async (method: string) =>
        method === "approval.get"
          ? { approval }
          : {
              applied: true,
              approval: {
                ...approvalRecord,
                status,
                decision: native,
                resolvedAtMs: 2,
                reason: "user",
                resolver: { kind: "device", id: "reviewer-a" },
              },
            }
      )
      const interactions = new OpenClawInteractions({ request })
      interactions.acceptApproval(scope, approval)

      await expect(
        interactions.respond(scope, [
          {
            requestId: "approval-a",
            status: "resolved",
            payload: normalized,
          },
        ])
      ).resolves.toEqual({ status: "resolved" })
      expect(request).toHaveBeenLastCalledWith("approval.resolve", {
        id: "approval-a",
        kind: "plugin",
        decision: native,
      })
      expect(
        GatewayProtocol.validateApprovalResolveParams(
          request.mock.calls.at(-1)?.[1]
        )
      ).toBe(true)
    }
  )

  it("fails closed on an unsupported native approval decision", () => {
    const interactions = new OpenClawInteractions({ request: vi.fn() })

    expect(() =>
      interactions.acceptApproval(scope, {
        ...approval,
        presentation: {
          ...approval.presentation,
          allowedDecisions: ["allow-session"],
        },
      })
    ).toThrowError(
      expect.objectContaining({ code: "AOS_PROVIDER_INVALID_RESPONSE" })
    )
  })

  it.each([
    [
      "a truncated replay",
      { ...approvalReplay, truncated: true },
      [] as unknown[],
      0,
    ],
    [
      "a foreign replay",
      { ...approvalReplay, sessionKey: "foreign" },
      [] as unknown[],
      0,
    ],
    [
      "a foreign approval source",
      {
        ...approvalReplay,
        approvals: [{ ...approval, sourceSessionKey: "foreign" }],
      },
      [] as unknown[],
      1,
    ],
    [
      "a foreign approval agent",
      {
        ...approvalReplay,
        approvals: [
          {
            ...approval,
            presentation: { ...approval.presentation, agentId: "foreign" },
          },
        ],
      },
      [] as unknown[],
      1,
    ],
    [
      "a foreign question",
      { ...approvalReplay, approvals: [] },
      [{ ...question, runId: "foreign" }],
      1,
    ],
    ["ambiguous exact interactions", approvalReplay, [question], 1],
  ])(
    "fails closed during restart discovery with %s",
    async (_label, replay, questions, reads) => {
      const request = vi.fn(async () => ({ questions }))
      const interactions = new OpenClawInteractions({ request })

      await expect(
        interactions.discover({ ...repliesScope, nativeRunId: "run-a" }, replay)
      ).resolves.toBeUndefined()
      await expect(
        interactions.validate(repliesScope, resolvedQuestion)
      ).rejects.toMatchObject({ code: "AOS_INTERACTION_NOT_FOUND" })
      expect(request).toHaveBeenCalledTimes(reads)
    }
  )

  it("binds a Session reply to its original native run before dispatch", async () => {
    const request = vi.fn(async (method: string) =>
      method === "question.get"
        ? { question }
        : {
            status: "answered",
            answers: nativeAnswers,
          }
    )
    const interactions = new OpenClawInteractions({ request })
    interactions.acceptQuestion(scope, question)

    await expect(
      interactions.validate(repliesScope, resolvedQuestion)
    ).resolves.toEqual({ runId: "run-a" })
    await expect(
      interactions.dispatch(repliesScope, resolvedQuestion)
    ).resolves.toEqual({ status: "resolved" })

    expect(request).toHaveBeenCalledTimes(3)
    expect(request).toHaveBeenLastCalledWith("question.resolve", {
      id: "q",
      answers: nativeAnswers,
    })
  })

  it("rejects missing, foreign, ambiguous, and malformed bound replies before native access", async () => {
    const request = vi.fn()
    const interactions = new OpenClawInteractions({ request })
    interactions.acceptQuestion(scope, question)

    await expect(interactions.validate(repliesScope, [])).rejects.toMatchObject(
      {
        code: "AOS_INVALID_INTERACTION",
      }
    )
    await expect(
      interactions.validate(
        { ...repliesScope, threadId: "foreign" },
        resolvedQuestion
      )
    ).rejects.toMatchObject({ code: "AOS_INTERACTION_NOT_FOUND" })
    await expect(
      interactions.validate(repliesScope, [
        ...resolvedQuestion,
        { requestId: "other", status: "cancelled" },
      ])
    ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })
    await expect(
      interactions.validate(repliesScope, [
        { ...resolvedQuestion[0], extra: "not-part-of-reply" },
      ])
    ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })

    const otherRun = { ...scope, runId: "run-b" }
    interactions.acceptQuestion(otherRun, { ...question, runId: "run-b" })
    await expect(
      interactions.validate(repliesScope, resolvedQuestion)
    ).rejects.toMatchObject({ code: "AOS_INTERACTION_NOT_FOUND" })
    expect(request).not.toHaveBeenCalled()
  })

  it("rejects a response changed after validation before native mutation", async () => {
    const request = vi.fn(async () => ({ approval }))
    const interactions = new OpenClawInteractions({ request })
    interactions.acceptApproval(scope, approval)
    const allowed = [
      {
        requestId: "approval-a",
        status: "resolved" as const,
        payload: "once",
      },
    ]

    await interactions.validate(repliesScope, allowed)
    await expect(
      interactions.dispatch(repliesScope, [{ ...allowed[0], payload: "deny" }])
    ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith("approval.get", { id: "approval-a" })
  })

  it.each([
    ["expired", "expired"],
    ["answered", "already-resolved"],
  ] as const)(
    "binds authoritative %s state without dispatching a native resolve",
    async (nativeStatus, expectedStatus) => {
      const request = vi.fn(async () => ({
        question: { ...question, status: nativeStatus },
      }))
      const interactions = new OpenClawInteractions({ request })
      interactions.acceptQuestion(scope, question)

      await expect(
        interactions.validate(repliesScope, resolvedQuestion)
      ).resolves.toEqual({ runId: "run-a" })
      await expect(
        interactions.dispatch(repliesScope, resolvedQuestion)
      ).resolves.toEqual({ status: expectedStatus })
      expect(request).toHaveBeenCalledTimes(1)
    }
  )

  it("preserves an uncertain tombstone for idempotent bound retries", async () => {
    const { OpenClawClientRequestError } = await import("./client")
    const request = vi.fn(async (method: string) => {
      if (method === "question.get") return { question }
      throw new OpenClawClientRequestError("timeout", true, false)
    })
    const interactions = new OpenClawInteractions({ request })
    interactions.acceptQuestion(scope, question)

    await interactions.validate(repliesScope, resolvedQuestion)
    await expect(
      interactions.dispatch(repliesScope, resolvedQuestion)
    ).resolves.toEqual({ status: "uncertain" })
    await expect(
      interactions.validate(repliesScope, resolvedQuestion)
    ).resolves.toEqual({ runId: "run-a" })
    await expect(
      interactions.dispatch(repliesScope, resolvedQuestion)
    ).resolves.toEqual({ status: "uncertain" })
    expect(
      request.mock.calls.filter(([method]) => method === "question.resolve")
    ).toHaveLength(1)
  })

  it("reports a concurrent duplicate dispatch as in progress without replay", async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const request = vi.fn(async (method: string) => {
      if (method === "question.get") return { question }
      await gate
      return { status: "answered", answers: nativeAnswers }
    })
    const interactions = new OpenClawInteractions({ request })
    interactions.acceptQuestion(scope, question)
    await interactions.validate(repliesScope, resolvedQuestion)

    const first = interactions.dispatch(repliesScope, resolvedQuestion)
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "question.resolve")
      ).toHaveLength(1)
    )
    await expect(
      interactions.dispatch(repliesScope, resolvedQuestion)
    ).resolves.toEqual({ status: "in-progress" })
    release()
    await expect(first).resolves.toEqual({ status: "resolved" })
    expect(
      request.mock.calls.filter(([method]) => method === "question.resolve")
    ).toHaveLength(1)
  })

  it("enforces the advertised per-run pending cap before native access", () => {
    const request = vi.fn()
    const interactions = new OpenClawInteractions({ request })
    for (let index = 0; index < 64; index++)
      interactions.acceptQuestion(scope, {
        ...question,
        id: `question-${index}`,
      })

    expect(() =>
      interactions.acceptQuestion(scope, { ...question, id: "question-64" })
    ).toThrowError(
      expect.objectContaining({ code: "AOS_PROVIDER_INVALID_RESPONSE" })
    )
    expect(request).not.toHaveBeenCalled()
  })

  it("bounds completed interaction tombstones independently", async () => {
    const request = vi.fn(async (method: string, raw: unknown) => {
      const params = raw as {
        id: string
        answers?: { answers: Record<string, string[]> }
      }
      return method === "question.get"
        ? { question: { ...question, id: params.id } }
        : { status: "answered", answers: params.answers }
    })
    const interactions = new OpenClawInteractions({ request })
    for (let index = 0; index <= 256; index++) {
      const requestId = `question-${index}`
      interactions.acceptQuestion(scope, { ...question, id: requestId })
      await interactions.respond(scope, [{ ...resolvedQuestion[0], requestId }])
    }

    await expect(
      interactions.respond(scope, [
        { ...resolvedQuestion[0], requestId: "question-0" },
      ])
    ).rejects.toMatchObject({ code: "AOS_INTERACTION_NOT_FOUND" })
  })

  it("accepts exact native limits and free-form, empty-option and secret answers", async () => {
    const request = vi.fn(async (method: string) =>
      method === "question.get"
        ? { question }
        : {
            status: "answered",
            answers: nativeAnswers,
          }
    )
    const x = new OpenClawInteractions({ request })
    expect(x.acceptQuestion(scope, question)).toMatchObject({
      requestId: "q",
      kind: PendingRequestKind.Elicitation,
    })
    await expect(
      x.respond(scope, [
        {
          requestId: "q",
          status: "resolved",
          payload: { answers: [["other"], ["secret-value"]] },
        },
      ])
    ).resolves.toEqual({ status: "resolved" })
  })
  it("requires authoritative source identities and rejects over-limit batches", () => {
    const x = new OpenClawInteractions({ request: vi.fn() })
    expect(() =>
      x.acceptQuestion(scope, { ...question, sessionKey: "foreign" })
    ).toThrow(OpenClawInteractionPublicError)
    expect(() =>
      x.acceptQuestion(scope, {
        ...question,
        questions: [
          ...question.questions,
          question.questions[0]!,
          question.questions[0]!,
        ],
      })
    ).toThrow(OpenClawInteractionPublicError)
  })
  it("reconciles a terminal native record before a reply and never dispatches it", async () => {
    const request = vi.fn(async () => ({
      question: { ...question, status: "expired" },
    }))
    const x = new OpenClawInteractions({ request })
    x.acceptQuestion(scope, question)
    await expect(
      x.respond(scope, [{ requestId: "q", status: "cancelled" }])
    ).resolves.toEqual({ status: "expired" })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it("reconciles a known approval through an equivalent scope value", async () => {
    const request = vi.fn(async (method: string) =>
      method === "question.list"
        ? { questions: [] }
        : method === "approval.get"
          ? { approval }
          : undefined
    )
    const x = new OpenClawInteractions({ request })
    x.acceptApproval(scope, approval)

    await x.reconcile({ ...scope })

    expect(request).toHaveBeenNthCalledWith(1, "question.list", {})
    expect(request).toHaveBeenNthCalledWith(2, "approval.get", {
      id: "approval-a",
    })
  })
  it.each([
    [
      "expired",
      {
        ...approvalRecord,
        status: "expired",
        resolvedAtMs: 2,
        source: { agentId: "agent-a", sessionKey: "session-a" },
        resolver: { kind: "system" },
        reason: "timeout",
      },
      "expired",
    ],
    [
      "already resolved",
      {
        ...approvalRecord,
        status: "allowed",
        resolvedAtMs: 2,
        source: { agentId: "agent-a", sessionKey: "session-a" },
        resolver: { kind: "device", id: "reviewer-a" },
        decision: "allow-once",
        reason: "user",
      },
      "already-resolved",
    ],
  ])(
    "consumes an authoritative %s approval during reconciliation",
    async (_label, terminalApproval, expectedStatus) => {
      const request = vi.fn(async (method: string) => {
        if (method === "question.list") return { questions: [] }
        if (method === "approval.get") return { approval: terminalApproval }
        throw new Error(`unexpected native mutation: ${method}`)
      })
      const x = new OpenClawInteractions({ request })
      x.acceptApproval(scope, approval)

      await x.reconcile({ ...scope })

      await expect(
        x.respond(scope, [
          {
            requestId: "approval-a",
            status: "resolved",
            payload: "once",
          },
        ])
      ).resolves.toEqual({ status: expectedStatus })
      expect(request).toHaveBeenCalledTimes(2)
    }
  )
  it("does not report malformed or mismatched acknowledgements as resolved", async () => {
    const request = vi.fn(async (method: string) =>
      method === "question.get"
        ? { question }
        : {
            status: "answered",
            answers: { answers: { choice: ["wrong"], secret: [] } },
          }
    )
    const x = new OpenClawInteractions({ request })
    x.acceptQuestion(scope, question)
    await expect(
      x.respond(scope, [
        {
          requestId: "q",
          status: "resolved",
          payload: { answers: [["other"], ["secret-value"]] },
        },
      ])
    ).rejects.toBeInstanceOf(OpenClawInteractionPublicError)
  })
})
