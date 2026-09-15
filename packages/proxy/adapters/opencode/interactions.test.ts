import { describe, expect, it, vi } from "vitest"

import { OpenCodeInteractions } from "./interactions"

const scope = {
  agentId: "research",
  sessionId: "native-session-1",
  threadId: "session-public-1",
  runId: "run-1",
}

describe("OpenCodeInteractions", () => {
  it("validates a complete native question batch and maps its ordered response once", async () => {
    const reply = vi.fn(async () => undefined)
    const interactions = new OpenCodeInteractions({
      questions: { reply, reject: vi.fn(async () => undefined) },
      permissions: { reply: vi.fn(async () => undefined) },
    })

    const interrupt = interactions.acceptQuestion(scope, {
      id: "native-question-id",
      sessionID: "native-session-1",
      questions: [
        {
          header: "Region",
          question: "Where should this run?",
          options: [
            { label: "Europe", description: "EU" },
            { label: "US", description: "United States" },
          ],
        },
        {
          header: "Checks",
          question: "Which checks?",
          options: [{ label: "Lint", description: "Static checks" }],
          multiple: true,
        },
      ],
    })

    expect(interrupt).toMatchObject({
      type: "interrupt",
      interrupts: [
        {
          id: "native-question-id",
          reason: "question",
          message: "2 questions require answers",
        },
      ],
    })
    await expect(
      interactions.respond(scope, [
        {
          interruptId: "native-question-id",
          status: "resolved",
          payload: [["Europe"], ["Lint"]],
        },
      ])
    ).resolves.toEqual({ status: "resolved" })
    expect(reply).toHaveBeenCalledWith(
      "native-session-1",
      "native-question-id",
      {
        answers: [["Europe"], ["Lint"]],
      }
    )
  })

  it("rejects incomplete or choice-substituted responses before native dispatch", async () => {
    const reply = vi.fn(async () => undefined)
    const interactions = new OpenCodeInteractions({
      questions: { reply, reject: vi.fn(async () => undefined) },
      permissions: { reply: vi.fn(async () => undefined) },
    })
    interactions.acceptQuestion(scope, {
      id: "native-question-id",
      sessionID: "native-session-1",
      questions: [
        {
          header: "Region",
          question: "Where?",
          options: [{ label: "Europe", description: "EU" }],
        },
        {
          header: "Check",
          question: "Which?",
          options: [{ label: "Lint", description: "Static" }],
        },
      ],
    })

    await expect(
      interactions.respond(scope, [
        {
          interruptId: "native-question-id",
          status: "resolved",
          payload: [["Europe"]],
        },
      ])
    ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })
    await expect(
      interactions.respond(scope, [
        {
          interruptId: "native-question-id",
          status: "resolved",
          payload: [["Outside"], ["Lint"]],
        },
      ])
    ).rejects.toMatchObject({ code: "AOS_INVALID_INTERACTION" })
    expect(reply).not.toHaveBeenCalled()
  })
})
