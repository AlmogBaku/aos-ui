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
describe("OpenClaw interactions", () => {
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
