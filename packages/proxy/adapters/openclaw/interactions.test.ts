import { describe, expect, it, vi } from "vitest"
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
    allowedDecisions: ["allow-once", "deny"],
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
const resumeScope = {
  agentId: scope.agentId,
  sessionId: scope.sessionId,
  threadId: scope.threadId,
}
const resolvedQuestion = [
  {
    interruptId: "q",
    status: "resolved" as const,
    payload: { answers: { choice: ["other"], secret: ["secret-value"] } },
  },
]
describe("OpenClaw interactions", () => {
  it("rediscovers and binds one exact pending question after restart", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "question.list") return { questions: [question] }
      if (method === "question.get") return { question }
      return {
        status: "answered",
        answers: resolvedQuestion[0].payload,
      }
    })
    const interactions = new OpenClawInteractions({ request })

    await expect(
      interactions.discover(
        { ...resumeScope, nativeRunId: "run-a" },
        { ...approvalReplay, approvals: [] }
      )
    ).resolves.toMatchObject({
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "q", reason: "question" }],
      },
    })
    await expect(
      interactions.validate(resumeScope, resolvedQuestion)
    ).resolves.toEqual({ runId: "run-a" })
    await expect(
      interactions.dispatch(resumeScope, resolvedQuestion)
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
    ["truncated", { ...approvalReplay, truncated: true }],
  ])(
    "keeps exact question discovery eligible when approval replay is %s",
    async (_label, replay) => {
      const request = vi.fn(async (method: string) =>
        method === "question.list" ? { questions: [question] } : { question }
      )
      const interactions = new OpenClawInteractions({ request })

      await expect(
        interactions.discover({ ...resumeScope, nativeRunId: "run-a" }, replay)
      ).resolves.toMatchObject({
        outcome: {
          type: "interrupt",
          interrupts: [{ id: "q", reason: "question" }],
        },
      })
      await expect(
        interactions.validate(resumeScope, resolvedQuestion)
      ).resolves.toEqual({ runId: "run-a" })
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
        interruptId: "approval-a",
        status: "resolved" as const,
        payload: "allow-once",
      },
    ]

    await expect(
      interactions.discover(
        { ...resumeScope, nativeRunId: "native-recovered" },
        approvalReplay
      )
    ).resolves.toMatchObject({
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "approval-a", reason: "approval" }],
      },
    })
    await expect(interactions.validate(resumeScope, response)).resolves.toEqual(
      { runId: "native-recovered" }
    )
    await expect(interactions.dispatch(resumeScope, response)).resolves.toEqual(
      { status: "resolved" }
    )
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "question.list",
      "approval.get",
      "approval.get",
      "approval.resolve",
    ])
  })

  it.each([
    [
      "a truncated replay",
      { ...approvalReplay, truncated: true },
      [] as unknown[],
      1,
    ],
    [
      "a foreign replay",
      { ...approvalReplay, sessionKey: "foreign" },
      [] as unknown[],
      1,
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
        interactions.discover({ ...resumeScope, nativeRunId: "run-a" }, replay)
      ).resolves.toBeUndefined()
      await expect(
        interactions.validate(resumeScope, resolvedQuestion)
      ).rejects.toMatchObject({ code: "AOS_INTERACTION_NOT_FOUND" })
      expect(request).toHaveBeenCalledTimes(reads)
    }
  )

  it("binds a Session resume to its original native run before dispatch", async () => {
    const request = vi.fn(async (method: string) =>
      method === "question.get"
        ? { question }
        : {
            status: "answered",
            answers: resolvedQuestion[0].payload,
          }
    )
    const interactions = new OpenClawInteractions({ request })
    interactions.acceptQuestion(scope, question)

    await expect(
      interactions.validate(resumeScope, resolvedQuestion)
    ).resolves.toEqual({ runId: "run-a" })
    await expect(
      interactions.dispatch(resumeScope, resolvedQuestion)
    ).resolves.toEqual({ status: "resolved" })

    expect(request).toHaveBeenCalledTimes(3)
    expect(request).toHaveBeenLastCalledWith("question.resolve", {
      id: "q",
      answers: resolvedQuestion[0].payload,
    })
  })

  it("rejects missing, foreign, ambiguous, and malformed bound resumes before native access", async () => {
    const request = vi.fn()
    const interactions = new OpenClawInteractions({ request })
    interactions.acceptQuestion(scope, question)

    await expect(interactions.validate(resumeScope, [])).rejects.toMatchObject({
      code: "AOS_INVALID_INTERACTION",
    })
    await expect(
      interactions.validate(
        { ...resumeScope, threadId: "foreign" },
        resolvedQuestion
      )
    ).rejects.toMatchObject({ code: "AOS_INTERACTION_NOT_FOUND" })
    await expect(
      interactions.validate(resumeScope, [
        ...resolvedQuestion,
        { interruptId: "other", status: "cancelled" },
      ])
    ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })
    await expect(
      interactions.validate(resumeScope, [
        { ...resolvedQuestion[0], extra: "not-part-of-resume" },
      ])
    ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })

    const otherRun = { ...scope, runId: "run-b" }
    interactions.acceptQuestion(otherRun, { ...question, runId: "run-b" })
    await expect(
      interactions.validate(resumeScope, resolvedQuestion)
    ).rejects.toMatchObject({ code: "AOS_INTERACTION_NOT_FOUND" })
    expect(request).not.toHaveBeenCalled()
  })

  it("rejects a response changed after validation before native mutation", async () => {
    const request = vi.fn(async () => ({ approval }))
    const interactions = new OpenClawInteractions({ request })
    interactions.acceptApproval(scope, approval)
    const allowed = [
      {
        interruptId: "approval-a",
        status: "resolved" as const,
        payload: "allow-once",
      },
    ]

    await interactions.validate(resumeScope, allowed)
    await expect(
      interactions.dispatch(resumeScope, [{ ...allowed[0], payload: "deny" }])
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
        interactions.validate(resumeScope, resolvedQuestion)
      ).resolves.toEqual({ runId: "run-a" })
      await expect(
        interactions.dispatch(resumeScope, resolvedQuestion)
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

    await interactions.validate(resumeScope, resolvedQuestion)
    await expect(
      interactions.dispatch(resumeScope, resolvedQuestion)
    ).resolves.toEqual({ status: "uncertain" })
    await expect(
      interactions.validate(resumeScope, resolvedQuestion)
    ).resolves.toEqual({ runId: "run-a" })
    await expect(
      interactions.dispatch(resumeScope, resolvedQuestion)
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
      return { status: "answered", answers: resolvedQuestion[0].payload }
    })
    const interactions = new OpenClawInteractions({ request })
    interactions.acceptQuestion(scope, question)
    await interactions.validate(resumeScope, resolvedQuestion)

    const first = interactions.dispatch(resumeScope, resolvedQuestion)
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "question.resolve")
      ).toHaveLength(1)
    )
    await expect(
      interactions.dispatch(resumeScope, resolvedQuestion)
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
      const interruptId = `question-${index}`
      interactions.acceptQuestion(scope, { ...question, id: interruptId })
      await interactions.respond(scope, [
        { ...resolvedQuestion[0], interruptId },
      ])
    }

    await expect(
      interactions.respond(scope, [
        { ...resolvedQuestion[0], interruptId: "question-0" },
      ])
    ).rejects.toMatchObject({ code: "AOS_INTERACTION_NOT_FOUND" })
  })

  it("accepts exact native limits and free-form, empty-option and secret answers", async () => {
    const request = vi.fn(async (method: string) =>
      method === "question.get"
        ? { question }
        : {
            status: "answered",
            answers: {
              answers: { choice: ["other"], secret: ["secret-value"] },
            },
          }
    )
    const x = new OpenClawInteractions({ request })
    expect(x.acceptQuestion(scope, question)).toMatchObject({
      type: "interrupt",
    })
    await expect(
      x.respond(scope, [
        {
          interruptId: "q",
          status: "resolved",
          payload: { answers: { choice: ["other"], secret: ["secret-value"] } },
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
  it("reconciles a terminal native record before resume and never dispatches it", async () => {
    const request = vi.fn(async () => ({
      question: { ...question, status: "expired" },
    }))
    const x = new OpenClawInteractions({ request })
    x.acceptQuestion(scope, question)
    await expect(
      x.respond(scope, [{ interruptId: "q", status: "cancelled" }])
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
            interruptId: "approval-a",
            status: "resolved",
            payload: "allow-once",
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
          interruptId: "q",
          status: "resolved",
          payload: { answers: { choice: ["other"], secret: ["secret-value"] } },
        },
      ])
    ).rejects.toBeInstanceOf(OpenClawInteractionPublicError)
  })
})
