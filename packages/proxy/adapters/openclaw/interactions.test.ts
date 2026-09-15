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
describe("OpenClaw interactions", () => {
  it("maps exact native batches to AG-UI and resolves complete answers once", async () => {
    const request = vi.fn(async () => ({}))
    const x = new OpenClawInteractions({ request })
    expect(
      x.acceptQuestion(scope, {
        id: "q",
        questions: [
          {
            questionId: "one",
            header: "Header",
            question: "Question",
            options: [{ label: "yes" }],
          },
        ],
      })
    ).toMatchObject({
      type: "interrupt",
      interrupts: [{ id: "q", reason: "question" }],
    })
    await expect(
      x.respond(scope, [
        {
          interruptId: "q",
          status: "resolved",
          payload: { answers: { one: ["yes"] } },
        },
      ])
    ).resolves.toEqual({ status: "resolved" })
    expect(request).toHaveBeenCalledWith("question.resolve", {
      id: "q",
      answers: { answers: { one: ["yes"] } },
    })
  })
  it("rejects incomplete answers without native dispatch", async () => {
    const request = vi.fn()
    const x = new OpenClawInteractions({ request })
    x.acceptQuestion(scope, {
      id: "q",
      questions: [
        { questionId: "one", header: "One", question: "One", options: [] },
        { questionId: "two", header: "Two", question: "Two", options: [] },
      ],
    })
    await expect(
      x.respond(scope, [
        {
          interruptId: "q",
          status: "resolved",
          payload: { answers: { one: ["yes"] } },
        },
      ])
    ).rejects.toBeInstanceOf(OpenClawInteractionPublicError)
    expect(request).not.toHaveBeenCalled()
  })
  it("uses native approval decisions and does not replay an uncertain mutation", async () => {
    const request = vi.fn(async () => {
      throw new Error("lost acknowledgement")
    })
    const x = new OpenClawInteractions({ request })
    x.acceptApproval(scope, {
      id: "a",
      expiresAtMs: 1_900_000_000_000,
      source: { agentId: "agent-a", sessionKey: "session-a" },
      presentation: {
        kind: "exec",
        allowedDecisions: ["deny", "allow-once"],
        commandText: "deploy",
      },
    })
    const answer = [
      { interruptId: "a", status: "resolved", payload: "allow-once" },
    ]
    await expect(x.respond(scope, answer)).resolves.toEqual({
      status: "uncertain",
    })
    await expect(x.respond(scope, answer)).resolves.toEqual({
      status: "uncertain",
    })
    expect(request).toHaveBeenCalledTimes(1)
  })
})
